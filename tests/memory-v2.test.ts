import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentModel } from "../src/agent/core/types.js";
import {
  LocalMemory,
  MemoryRevisionConflictError,
  type MemoryEntryInput
} from "../src/agent/context/LocalMemory.js";
import { MemoryEmbeddingService } from "../src/agent/context/MemoryEmbeddingService.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import type { LocalEmbeddingManager } from "../src/llm/embedding/LocalEmbeddingRuntime.js";

async function main(): Promise<void> {
  await testSingleStoreCasOriginAndEdit();
  await testSharedLibraryAndLexicalFallbackBoundary();
  await testBoundedIndexConcurrentCasAndUsageProjection();
  await testCandidateOriginEligibilityAndExactContent();
  await testSingleRootSafetyBoundary();
  await testListEntriesPagination();
  await testReadPathsDoNotRepair();
  await testEmbeddingStatusDoesNotCreateIndex();
  console.log("memory v3 tests passed");
}

/** 分页：offset/limit 切片 + total 为分页前计数，页间不重复不遗漏。 */
async function testListEntriesPagination(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const storage = new MemoryStorage(workspaceRoot);
    let revision = 0;
    for (let index = 0; index < 7; index += 1) {
      revision = (await storage.writeEntry(projectEntry(
        `分页条目 ${String(index)}`,
        `分页测试内容 ${String(index)}，用于验证 offset 与 limit 切片正确且 total 准确。`
      ), { expectedRevision: revision })).revision;
    }
    const page0 = await storage.listEntries({ origins: ["all"], offset: 0, limit: 3 });
    assert.equal(page0.entries.length, 3);
    assert.equal(page0.total, 7);
    const page1 = await storage.listEntries({ origins: ["all"], offset: 3, limit: 3 });
    assert.equal(page1.entries.length, 3);
    assert.equal(page1.total, 7);
    const page2 = await storage.listEntries({ origins: ["all"], offset: 6, limit: 3 });
    assert.equal(page2.entries.length, 1);
    assert.equal(page2.total, 7);
    // 三页并集 = 全集，无重复。
    const ids = new Set([...page0.entries, ...page1.entries, ...page2.entries].map((entry) => entry.id));
    assert.equal(ids.size, 7, "分页必须覆盖全部条目且无重复");
    // offset 超出范围返回空页但 total 仍准确。
    const beyond = await storage.listEntries({ origins: ["all"], offset: 100, limit: 3 });
    assert.equal(beyond.entries.length, 0);
    assert.equal(beyond.total, 7);
  });
}

async function testSingleStoreCasOriginAndEdit(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const overview = await memory.getOverview();
    assert.equal(overview.storeRevision, 0);
    assert.deepEqual(overview.origins, { user: 0, currentWorkspace: 0, otherWorkspaces: 0 });

    const universal = await memory.writeEntry({
      audience: "universal",
      kind: "working_style",
      topic: "working-style",
      title: "Concise updates",
      summary: "The user explicitly prefers concise progress updates during long coding tasks.",
      importance: 5,
      lineage: {
        source: "explicit",
        externalContext: false,
        userEvidence: "Please keep progress updates concise."
      }
    }, { expectedRevision: 0, now: new Date("2026-08-01T00:00:00.000Z") });
    assert.equal(universal.entry?.origin.kind, "user");
    assert.equal(universal.revision, 1);

    const workspace = await memory.writeEntry(projectEntry(
      "Weather source",
      "Use src/weather.ts for deterministic weather requests."
    ), { expectedRevision: 1, now: new Date("2026-08-01T01:00:00.000Z") });
    assert.equal(workspace.entry?.origin.kind, "workspace");
    assert.equal(workspace.revision, 2, "user and workspace writes must share one revision");

    await assert.rejects(memory.writeEntry(projectEntry(
      "Stale write",
      "This stale single-store CAS write must not overwrite newer entries."
    ), { expectedRevision: 1 }), MemoryRevisionConflictError);

    await assert.rejects(memory.writeEntry({
      audience: "universal",
      kind: "decision",
      topic: "decisions",
      title: "Repository decision",
      summary: "Use src/weather.ts as this repository's weather entry point.",
      paths: ["src/weather.ts"],
      lineage: { source: "explicit", externalContext: false, userEvidence: "Use src/weather.ts." }
    }, { expectedRevision: 2 }), /Universal memory|Project paths and decisions|Global memory/u);

    const created = workspace.entry;
    assert.ok(created);
    const updated = await memory.updateEntry(created.id, {
      title: "Deterministic weather source",
      summary: "Use src/weather.ts as the deterministic weather request entry point.",
      importance: 4
    }, { expectedRevision: 2, now: new Date("2026-08-02T00:00:00.000Z") });
    assert.equal(updated.entry?.id, created.id);
    assert.equal(updated.entry?.createdAt, created.createdAt);
    assert.deepEqual(updated.entry?.origin, created.origin);
    assert.equal(updated.entry?.lineage.at(-1)?.source, "explicit_edit");
    assert.equal(updated.revision, 3);

    const entriesDirectory = path.join(agentRoot, "memory", "entries");
    const files = (await fs.readdir(entriesDirectory)).filter((file) => file.endsWith(".md"));
    assert.equal(files.length, 2);
    const contents = await Promise.all(files.map(async (file) => await fs.readFile(path.join(entriesDirectory, file), "utf8")));
    assert.equal(contents.every((content) => /^---\nversion: 3\n/u.test(content)), true);
    assert.equal(contents.some((content) => /origin:\n {2}kind: user/u.test(content)), true);
    assert.equal(contents.some((content) => /workspaceId: [a-f0-9]{24}/u.test(content)), true);
    assert.equal(contents.some((content) => content.includes(path.resolve(workspaceRoot))), false, "origin must not persist an absolute workspace path");
  });
}

async function testSharedLibraryAndLexicalFallbackBoundary(): Promise<void> {
  await withSharedAgent(async (agentRoot) => {
    const firstWorkspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-first-"));
    const secondWorkspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-second-"));
    try {
      const first = new LocalMemory(firstWorkspace, unusedModel);
      await first.writeEntry({
        ...projectEntry("Release workflow", "Run pnpm test before publishing the first workspace."),
        topic: "release",
        keywords: ["release", "publish"]
      }, { expectedRevision: 0 });

      const second = new LocalMemory(secondWorkspace, unusedModel);
      const overview = await second.getOverview();
      assert.equal(overview.entryCount, 1);
      assert.deepEqual(overview.origins, { user: 0, currentWorkspace: 0, otherWorkspaces: 1 });
      assert.equal((await second.listMemoryEntries({ origins: ["other_workspaces"] })).entries.length, 1);
      assert.equal((await second.search("release publish", [], { origins: ["all"] })).matches.length, 1, "manual all-origin search can inspect shared memory");
      assert.equal((await second.search("release publish", [], { origins: ["user", "current_workspace"] })).matches.length, 0, "lexical fallback must not auto-inject another workspace");

      const own = await second.writeEntry({
        ...projectEntry("Second release", "Run typecheck before publishing the second workspace."),
        topic: "release",
        keywords: ["release", "publish"]
      }, { expectedRevision: overview.storeRevision });
      assert.equal(own.revision, 2);
      const filtered = await second.search("release publish", [], { origins: ["user", "current_workspace"] });
      assert.equal(filtered.matches.length, 1);
      assert.equal(filtered.matches[0]?.entry.origin.kind, "workspace");
      assert.equal((filtered.matches[0]?.entry.origin as { workspaceName?: string }).workspaceName, path.basename(secondWorkspace));
      assert.equal(await fs.realpath(path.join(agentRoot, "memory")), path.join(await fs.realpath(agentRoot), "memory"));
    } finally {
      await rm(firstWorkspace, { recursive: true, force: true });
      await rm(secondWorkspace, { recursive: true, force: true });
    }
  });
}

async function testBoundedIndexConcurrentCasAndUsageProjection(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const storage = new MemoryStorage(workspaceRoot);
    let revision = 0;
    for (let index = 0; index < 18; index += 1) {
      revision = (await storage.writeEntry(projectEntry(
        `Long indexed title ${String(index)} ${"x".repeat(70)}`,
        `Durable indexed summary ${String(index)} ${"content ".repeat(20)}`
      ), { expectedRevision: revision })).revision;
    }
    const overview = await storage.getOverview();
    assert.equal(overview.entryCount, 18);

    const concurrent = await Promise.allSettled([
      storage.writeEntry(projectEntry("Concurrent A", "Concurrent A must win or conflict without overwriting another writer."), { expectedRevision: revision }),
      storage.writeEntry(projectEntry("Concurrent B", "Concurrent B must win or conflict without overwriting another writer."), { expectedRevision: revision })
    ]);
    assert.equal(concurrent.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(concurrent.some((result) => result.status === "rejected" && result.reason instanceof MemoryRevisionConflictError), true);

    const entry = (await storage.listEntries({ origins: ["current_workspace"] })).entries[0];
    assert.ok(entry);
    const beforeRevision = (await storage.getOverview()).storeRevision;
    await storage.recordRecallUsage([entry.id, entry.id], { now: new Date("2026-08-03T00:00:00.000Z") });
    const recalled = (await storage.listEntries({ origins: ["current_workspace"] })).entries.find(({ id }) => id === entry.id);
    assert.equal(recalled?.recallCount, 1, "one citation call counts an id once");
    assert.equal(recalled?.lastRecalledAt, "2026-08-03T00:00:00.000Z");
    assert.equal((await storage.getOverview()).storeRevision, beforeRevision, "derived usage must not advance content revision");
    const entryFiles = (await fs.readdir(path.join(agentRoot, "memory", "entries"))).filter((file) => file.endsWith(".md"));
    for (const file of entryFiles) {
      const content = await fs.readFile(path.join(agentRoot, "memory", "entries", file), "utf8");
      assert.doesNotMatch(content, /recallCount|lastRecalledAt/u);
    }

    await storage.deleteEntry(entry.id, { expectedRevision: (await storage.getOverview()).storeRevision });
    const pruned = (await storage.listEntries({ origins: ["current_workspace"] })).entries.filter(({ id }) => id === entry.id);
    assert.equal(pruned.length, 0, "deleted entry must be removed");
  });
}


async function testCandidateOriginEligibilityAndExactContent(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const queued = await memory.enqueueCandidate({
      summary: "Completed root turn established a durable workflow. apiKey=sk-candidate-secret-value",
      completed: true,
      lineage: { source: "completed_task", sessionId: "session-1", turnId: "turn-1", runId: "run-1", externalContext: false },
      audienceHint: "workspace",
      kindHint: "workflow"
    }, { expectedRevision: 0, excludeExternalContext: true, now: new Date("2026-08-10T00:00:00.000Z") });
    assert.equal(queued.queued, true);
    assert.equal(queued.candidate?.origin.kind, "workspace");
    assert.equal(queued.candidate?.summary.includes("sk-candidate-secret-value"), true);
    assert.equal((await memory.listEligibleCandidates({ now: new Date("2026-08-10T05:59:59.999Z") })).candidates.length, 0);
    assert.equal((await memory.listEligibleCandidates({ now: new Date("2026-08-10T06:00:00.000Z") })).candidates.length, 1);
  });
}

async function testSingleRootSafetyBoundary(): Promise<void> {
  const agentRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-agent-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-workspace-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-outside-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = agentRoot;
  try {
    await fs.symlink(outside, path.join(agentRoot, "memory"), "dir");
    await assert.rejects(new LocalMemory(workspaceRoot, unusedModel).writeEntry(projectEntry(
      "Unsafe root",
      "This entry must never be written through a symbolic memory root."
    ), { expectedRevision: 0 }), /real directory, not a symbolic link/u);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    restoreAgentRoot(previous);
    await rm(agentRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

async function testReadPathsDoNotRepair(): Promise<void> {
  await withSharedAgent(async (agentRoot) => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-read-"));
    const memoryRoot = path.join(agentRoot, "memory");
    await fs.mkdir(memoryRoot, { recursive: true, mode: 0o755 });
    await fs.chmod(agentRoot, 0o755);
    await fs.chmod(memoryRoot, 0o755);
    try {
      await new MemoryStorage(workspaceRoot).getOverview();
      assert.equal((await fs.stat(agentRoot)).mode & 0o777, 0o755, "普通记忆读取不能偷偷修复目录权限");
      assert.equal((await fs.stat(memoryRoot)).mode & 0o777, 0o755, "普通记忆读取不能偷偷修复目录权限");

      const index = new MemoryVectorIndex(memoryRoot);
      const database = new DatabaseSync(index.databasePath);
      try {
        const fingerprint = "sha256:test";
        const input = { entryId: "entry-1", contentHash: "a".repeat(64) };
        const count = (): number => Number((database.prepare(
          "SELECT COUNT(*) AS count FROM memory_vector_entry_states"
        ).get() as { count?: unknown } | undefined)?.count ?? 0);
        assert.equal(count(), 0);
        assert.equal(index.entryStates(fingerprint, [input])[0]?.status, "pending");
        assert.equal(count(), 0, "读取索引状态不能写入 pending 修复记录");
        index.entryStates(fingerprint, [input]);
        assert.equal(count(), 0, "重复读取索引状态仍不能写入 pending 修复记录");
      } finally {
        database.close();
        index.close();
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
}

async function testEmbeddingStatusDoesNotCreateIndex(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const memoryRoot = path.join(agentRoot, "memory");
    const databasePath = path.join(memoryRoot, ".memory-index.sqlite");
    const service = new MemoryEmbeddingService({
      localMemory: new LocalMemory(workspaceRoot, unusedModel),
      localManager: { list: async () => [] } as unknown as LocalEmbeddingManager,
      getVectorIndex: () => { throw new Error("status must not open a writable vector index"); },
      getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(memoryRoot),
      getActiveModel: () => undefined,
      getProviderModels: () => [],
      getRuntime: async () => undefined
    });
    const status = await service.status();
    assert.equal(status.index.active, undefined);
    assert.equal(status.pendingEntries, 0);
    await assert.rejects(fs.access(databasePath), /ENOENT/u, "读取状态不能创建空向量索引");
  });
}

function projectEntry(title: string, summary: string): MemoryEntryInput {
  return {
    audience: "workspace",
    kind: "fact",
    topic: "project",
    title,
    summary,
    decisions: [],
    paths: [],
    keywords: [],
    importance: 3,
    lineage: { source: "explicit", externalContext: false }
  };
}


function unusedModel(): AgentModel {
  return {
    provider: "test",
    modelId: "unused",
    async stream() {
      return (async function* () { /* storage-only tests do not call the model */ })();
    }
  };
}

async function withIsolatedMemory(run: (workspaceRoot: string, agentRoot: string) => Promise<void>): Promise<void> {
  await withSharedAgent(async (agentRoot) => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-workspace-"));
    try {
      await run(workspaceRoot, agentRoot);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
}

async function withSharedAgent(run: (agentRoot: string) => Promise<void>): Promise<void> {
  const agentRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-agent-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = agentRoot;
  try {
    await run(agentRoot);
  } finally {
    restoreAgentRoot(previous);
    await rm(agentRoot, { recursive: true, force: true });
  }
}

function restoreAgentRoot(previous: string | undefined): void {
  if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previous;
}

await main();
