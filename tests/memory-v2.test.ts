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
  type MemoryEntry,
  type MemoryEntryInput
} from "../src/agent/context/LocalMemory.js";
import { MemoryEmbeddingService } from "../src/agent/context/MemoryEmbeddingService.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import { MemoryStorage, memoryDatabaseFileName } from "../src/agent/context/memoryStorage.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import type { LocalEmbeddingManager } from "../src/llm/embedding/LocalEmbeddingRuntime.js";
import type { EmbeddingModelDescriptor, EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

async function main(): Promise<void> {
  await testSingleStoreCasOriginAndEdit();
  await testSharedLibraryAndLexicalFallbackBoundary();
  await testBoundedIndexConcurrentCasAndUsageProjection();
  await testExactDuplicateNormalization();
  await testAutomaticSemanticDedup();
  await testSemanticDeleteAndTemporaryCleanup();
  await testPersonMemoryRouting();
  await testSummarizationUsesToolModelAndRequiresCompleteTurn();
  await testAutomaticSummarySkipsWithoutSemanticEmbedding();
  await testDirectExtractionAndOriginBoundaries();
  await testSingleRootSafetyBoundary();
  await testListEntriesPagination();
  await testReadPathsDoNotRepair();
  await testArchiveAndRestore();
  await testLegacyArchiveSchemaMigration();
  await testTemporaryMemoryExpiry();
  await testSleepExactDedupAcrossOrigins();
  await testSleepSimilarityBoundaries();
  await testSleepSynthesisArchivesCluster();
  await testSleepInvalidDeleteIsSafe();
  await testSleepRunRecord();
  await testEmbeddingStatusDoesNotCreateIndex();
  await testSemanticSearchTreatsUnbuiltIndexAsEmptyCandidates();
  await testFactsAndVectorsShareDatabase();
  await testInitialEmbeddingGeneration();
  await testVectorRebuildLockAndRecovery();
  await testLocalMemoryMutationKeepsIndexInSync();
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

    const database = new DatabaseSync(path.join(agentRoot, "memory", memoryDatabaseFileName), { readOnly: true });
    try {
      const rows = database.prepare("SELECT content, metadata FROM memories").all() as Array<{ content: string; metadata: string }>;
      assert.equal(rows.length, 2);
      assert.equal(rows.some((row) => row.content.includes("concise progress updates")), true);
      assert.equal(rows.some((row) => row.metadata.includes("\"kind\":\"user\"") === false), true);
      assert.equal(rows.every((row) => row.metadata.includes(path.resolve(workspaceRoot)) === false), true, "origin must not persist an absolute workspace path");
    } finally {
      database.close();
    }
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
    const database = new DatabaseSync(path.join(agentRoot, "memory", memoryDatabaseFileName), { readOnly: true });
    try {
      const row = database.prepare("SELECT metadata FROM memories WHERE id = ?").get(entry.id) as { metadata?: string } | undefined;
      assert.equal(row?.metadata?.includes("recallCount"), false, "usage is stored in columns, not fact metadata");
      assert.equal(row?.metadata?.includes("lastRecalledAt"), false, "usage is stored in columns, not fact metadata");
    } finally {
      database.close();
    }

    await storage.deleteEntry(entry.id, { expectedRevision: (await storage.getOverview()).storeRevision });
    const pruned = (await storage.listEntries({ origins: ["current_workspace"] })).entries.filter(({ id }) => id === entry.id);
    assert.equal(pruned.length, 0, "deleted entry must be removed");
  });
}

async function testExactDuplicateNormalization(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const storage = new MemoryStorage(workspaceRoot);
    const first = await storage.writeEntry({
      ...projectEntry("Cafe\u0301   rule", "Keep the cafe\u0301 rule.\n\nIt must be checked before release."),
      decisions: ["  Check it before release.  "],
      paths: ["src/ cafe.ts"],
      keywords: ["Cafe\u0301"]
    }, { expectedRevision: 0 });
    assert.equal(first.written, true);
    const duplicate = await storage.writeEntry({
      ...projectEntry("A different title", "Keep the café rule. It must be checked before release."),
      decisions: ["A different metadata value"],
      paths: ["src/other.ts"],
      keywords: ["other-keyword"]
    }, { expectedRevision: first.revision });
    assert.equal(duplicate.written, false, "only NFC and whitespace-normalized content determines an exact duplicate");
    assert.equal(duplicate.entry?.id, first.entry?.id);
    assert.equal((await storage.getOverview()).entryCount, 1);
  });
}

async function testAutomaticSemanticDedup(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const model = jsonMemoryModel((prompt) => prompt.includes("deduplication decisions")
      ? JSON.stringify({ isDuplicate: true, reason: "same core fact", duplicateOf: 1 })
      : "{}");
    const seed = new LocalMemory(workspaceRoot, unusedModel);
    const first = await seed.writeEntry(projectEntry(
      "Release verification",
      "The release workflow requires running the complete test suite before publishing the package."
    ), { expectedRevision: 0 });
    assert.ok(first.entry);
    const memory = new LocalMemory(
      workspaceRoot,
      () => model,
      undefined,
      3,
      undefined,
      undefined,
      undefined,
      async () => [first.entry!]
    );
    const result = await memory.writeAutoEntry({
      ...projectEntry(
        "A shorter release rule",
        "Run the complete test suite before publishing the package as part of the release workflow."
      ),
      lineage: { source: "completed_task", externalContext: false }
    }, { expectedRevision: first.revision });
    assert.equal(result.written, false);
    assert.equal(result.entry?.id, first.entry.id);
    assert.equal((await memory.getOverview()).entryCount, 1);
  });
}

async function testSemanticDeleteAndTemporaryCleanup(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const seed = new LocalMemory(workspaceRoot, unusedModel);
    const obsolete = await seed.writeEntry(projectEntry(
      "Old release rule",
      "The old release process requires publishing directly without running the complete test suite first."
    ), { expectedRevision: 0 });
    const temporary = await seed.writeEntry({
      ...projectEntry(
        "Temporary branch note",
        "The temporary branch note is only relevant to the previous release investigation and can expire."
      ),
      durability: "temporary",
      expiresAt: "2026-08-20T00:00:00.000Z"
    }, { expectedRevision: obsolete.revision });
    assert.ok(obsolete.entry);
    assert.ok(temporary.entry);
    const model = jsonMemoryModel((prompt) => {
      if (prompt.includes("update durable memory")) return JSON.stringify({ add: [], delete: ["the old release rule"] });
      if (prompt.includes("map a deletion description")) return "[1]";
      if (prompt.includes("clean up temporary memories")) return JSON.stringify([temporary.entry!.id]);
      return "[]";
    });
    const memory = new LocalMemory(
      workspaceRoot,
      () => model,
      undefined,
      3,
      undefined,
      undefined,
      undefined,
      async (_query, options) => options.minimumSimilarity === 0
        ? [obsolete.entry!]
        : [temporary.entry!]
    );
    const result = await memory.summarizeAndStoreMemories([
      { role: "user", content: "The old release rule is no longer valid; the temporary note is no longer relevant." },
      { role: "assistant", content: "I will remove the obsolete temporary context." }
    ], {
      sessionId: "semantic-delete-session",
      turnId: "semantic-delete-turn",
      runId: "semantic-delete-run",
      externalContext: false,
      excludeExternalContext: false,
      now: new Date("2026-08-21T00:00:00.000Z")
    });
    assert.equal(result.deleted, 2);
    assert.equal((await memory.getOverview()).entryCount, 0);
  });
}

async function testPersonMemoryRouting(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const result = await memory.writeAutoEntry({
      ...projectEntry(
        "Person profile",
        "PERSON: Alice: Alice prefers concise written updates and clear next steps."
      ),
      lineage: { source: "completed_task", externalContext: false }
    }, { expectedRevision: 0 });
    assert.equal(result.written, false);
    assert.equal((await memory.getOverview()).entryCount, 0);
    const profile = await fs.readFile(path.join(agentRoot, "people", "Alice.md"), "utf8");
    assert.match(profile, /prefers concise written updates/u);
  });
}

async function testSummarizationUsesToolModelAndRequiresCompleteTurn(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    let extractionCalls = 0;
    let toolCalls = 0;
    const extractionModel = jsonMemoryModel(() => {
      extractionCalls += 1;
      return JSON.stringify({ add: [], delete: [] });
    });
    const toolModel = jsonMemoryModel(() => {
      toolCalls += 1;
      return JSON.stringify({
        add: [{
          audience: "workspace",
          kind: "fact",
          topic: "tool-model",
          title: "Tool model memory",
          content: "The memory summarizer must use the configured tool model for completed turns."
        }],
        delete: []
      });
    });
    const memory = new LocalMemory(
      workspaceRoot,
      () => extractionModel,
      undefined,
      3,
      undefined,
      undefined,
      undefined,
      async () => [],
      () => toolModel
    );

    const incomplete = await memory.summarizeAndStoreMemories(
      [{ role: "user", content: "A single message is not enough to summarize." }],
      {
        sessionId: "tool-model-session",
        turnId: "tool-model-incomplete",
        runId: "tool-model-run-1",
        externalContext: false,
        excludeExternalContext: false
      }
    );
    assert.deepEqual(incomplete, { added: 0, deleted: 0 });
    assert.equal(toolCalls, 0);
    assert.equal(extractionCalls, 0);

    const complete = await memory.summarizeAndStoreMemories(
      [
        { role: "user", content: "Use the configured tool model for this durable memory rule." },
        { role: "assistant", content: "I will store the stable rule after the completed turn." }
      ],
      {
        sessionId: "tool-model-session",
        turnId: "tool-model-complete",
        runId: "tool-model-run-2",
        externalContext: false,
        excludeExternalContext: false
      }
    );
    assert.equal(complete.added, 1);
    assert.equal(toolCalls, 1);
    assert.equal(extractionCalls, 0);
  });
}

async function testAutomaticSummarySkipsWithoutSemanticEmbedding(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const model = jsonMemoryModel(() => JSON.stringify({
      add: [{
        audience: "workspace",
        kind: "fact",
        topic: "semantic-gate",
        title: "Semantic write gate",
        content: "Automatic memory writes require a semantic embedding before they enter the durable store."
      }],
      delete: []
    }));
    const memory = new LocalMemory(
      workspaceRoot,
      () => model,
      undefined,
      3,
      undefined,
      undefined,
      undefined,
      async () => undefined
    );
    const result = await memory.summarizeAndStoreMemories([
      { role: "user", content: "Only store this automatic fact when semantic deduplication is available." },
      { role: "assistant", content: "I will apply the semantic write gate." }
    ], {
      sessionId: "semantic-gate-session",
      turnId: "semantic-gate-turn",
      runId: "semantic-gate-run",
      externalContext: false,
      excludeExternalContext: false
    });
    assert.equal(result.added, 0);
    assert.equal((await memory.getOverview()).entryCount, 0);
  });
}


async function testDirectExtractionAndOriginBoundaries(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(
      workspaceRoot,
      () => jsonMemoryModel(() => JSON.stringify({
        add: [
          {
            audience: "workspace",
            kind: "workflow",
            topic: "release",
            title: "Durable release workflow",
            content: "Completed root turn established a durable release workflow for this workspace.",
            decisions: [],
            paths: [],
            keywords: ["release", "workflow"]
          },
          {
            audience: "universal",
            kind: "working_style",
            topic: "working-style",
            title: "Actionable summaries",
            content: "The user prefers durable summaries to remain concise and directly actionable.",
            decisions: [],
            paths: [],
            keywords: ["concise", "actionable"],
            userEvidence: "The user explicitly prefers durable summaries to remain concise and directly actionable."
          }
        ],
        delete: []
      })),
      undefined,
      3,
      undefined,
      undefined,
      undefined,
      async () => []
    );
    const result = await memory.summarizeAndStoreMemories(
      [
        { role: "user", content: "Remember the durable release workflow and my preference for concise actionable summaries." },
        { role: "assistant", content: "I will retain those durable memory rules." }
      ],
      {
        sessionId: "session-1",
        turnId: "turn-1",
        runId: "run-1",
        externalContext: false,
        excludeExternalContext: true,
        now: new Date("2026-08-10T00:00:00.000Z")
      }
    );
    assert.equal(result.added, 2);
    const entries = (await memory.listMemoryEntries({ origins: ["all"] })).entries;
    assert.equal(entries.length, 2);
    assert.equal(entries.some((entry) => entry.origin.kind === "workspace"), true);
    assert.equal(entries.some((entry) => entry.origin.kind === "user"), true);
    assert.equal(entries.every((entry) => entry.lineage[0]?.source === "completed_task"), true);

    // 同一响应再次到达时由事实库做 exact dedup，不产生第二份记忆。
    const duplicate = await memory.summarizeAndStoreMemories(
      [
        { role: "user", content: "The same durable workflow and preference still apply." },
        { role: "assistant", content: "The existing durable entries still apply." }
      ],
      {
        sessionId: "session-1",
        turnId: "turn-2",
        runId: "run-2",
        externalContext: false,
        excludeExternalContext: true,
        now: new Date("2026-08-10T00:00:00.000Z")
      }
    );
    assert.equal(duplicate.added, 0);
    assert.equal((await memory.getOverview()).entryCount, 2);

    // 配置为排除外部上下文时，完成回合不会调用模型，也不会写入事实库。
    const excluded = await memory.summarizeAndStoreMemories(
      [{ role: "user", content: "This came from an external attachment." }],
      {
        sessionId: "session-2",
        turnId: "turn-3",
        runId: "run-3",
        externalContext: true,
        excludeExternalContext: true
      }
    );
    assert.deepEqual(excluded, { added: 0, deleted: 0 });
  });
}

async function testSleepRunRecord(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    await memory.writeEntry(projectEntry(
      "A durable task summary",
      "A completed task summary with enough durable content for sleep processing."
    ), { expectedRevision: 0, now: new Date("2026-08-01T00:00:00.000Z") });
    const result = await memory.runMemoryMaintenance({ now: new Date("2026-08-02T00:00:00.000Z"), useLlm: false });
    assert.equal(result.failed, 0);
    const status = await memory.loadMaintenanceStatus();
    assert.equal(status.lastRun?.trigger, "scheduled");
    assert.equal(status.lastRun?.examined, 1);
    assert.equal(typeof status.lastRun?.id, "string");
  });
}

async function testArchiveAndRestore(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const storage = new MemoryStorage(workspaceRoot);
    const created = await storage.writeEntry(projectEntry(
      "Archiveable memory",
      "This memory remains available after archival and can be restored without losing its SQLite fact."
    ), { expectedRevision: 0 });
    assert.ok(created.entry);
    const archived = await storage.archiveEntry(created.entry!.id, true, { expectedRevision: created.revision, now: new Date("2026-08-20T00:00:00.000Z") });
    assert.equal(archived.archived, true);
    assert.equal(archived.entry?.archivedReason, "manual");
    assert.notEqual(archived.entry?.id, created.entry!.id);
    assert.equal(archived.entry?.originalId, created.entry!.id);
    assert.equal(archived.entry?.archivedBy, "manual");
    assert.equal((await storage.listEntries({ origins: ["all"] })).entries.length, 0);
    assert.equal((await storage.listEntries({ origins: ["all"], includeArchived: true })).entries.length, 1);
    const restored = await storage.archiveEntry(archived.entry!.id, false, { expectedRevision: archived.revision, now: new Date("2026-08-21T00:00:00.000Z") });
    assert.equal(restored.archived, false);
    assert.equal(restored.entry?.archivedAt, undefined);
    assert.notEqual(restored.entry?.id, created.entry!.id);
    assert.equal(restored.entry?.originalId, undefined);
    assert.equal((await storage.listEntries({ origins: ["all"] })).entries.length, 1);
  });
}

async function testLegacyArchiveSchemaMigration(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const memoryRoot = path.join(agentRoot, "memory");
    await fs.mkdir(memoryRoot, { recursive: true });
    const databasePath = path.join(memoryRoot, memoryDatabaseFileName);
    const legacyId = "legacy-archive-entry-0001";
    const metadata = JSON.stringify({
      kind: "fact",
      topic: "project",
      title: "Legacy archive",
      decisions: [],
      paths: [],
      keywords: [],
      importance: 3,
      durability: "permanent",
      lineage: [{ source: "explicit", externalContext: false }]
    });
    const database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE memory_archive (" +
      "original_id TEXT PRIMARY KEY NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL, " +
      "origin_kind TEXT NOT NULL, workspace_id TEXT, workspace_name TEXT, created_at TEXT NOT NULL, " +
      "updated_at TEXT NOT NULL, revision INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 0, " +
      "last_recalled_at TEXT, archived_at TEXT NOT NULL, archived_reason TEXT, merged_into TEXT); " +
      "PRAGMA user_version = 2;"
    );
    database.prepare(
      "INSERT INTO memory_archive " +
      "(original_id, content, metadata, origin_kind, workspace_id, workspace_name, created_at, updated_at, " +
      "revision, access_count, last_recalled_at, archived_at, archived_reason, merged_into) " +
      "VALUES (?, ?, ?, 'user', NULL, NULL, ?, ?, 1, 0, NULL, ?, 'similarity', NULL)"
    ).run(
      legacyId,
      "A legacy archive row must survive the archive schema upgrade without losing its original fact.",
      metadata,
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z"
    );
    database.close();

    const storage = new MemoryStorage(workspaceRoot);
    const archived = (await storage.listEntries({ origins: ["all"], includeArchived: true })).entries;
    assert.equal(archived.length, 1);
    assert.equal(archived[0]?.id, legacyId);
    assert.equal(archived[0]?.originalId, legacyId);
    assert.equal(archived[0]?.archivedBy, "manual");
    assert.equal(archived[0]?.archivedReason, "similarity");
  });
}

async function testTemporaryMemoryExpiry(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const now = new Date("2026-08-31T00:00:00.000Z");
    let revision = 0;
    const write = async (title: string, createdAt: string, extras: Partial<MemoryEntryInput> = {}): Promise<MemoryEntry> => {
      const result = await memory.writeEntry({
        ...projectEntry(title, `${title} contains a temporary fact used to verify expiration semantics.`),
        durability: "temporary",
        ...extras
      }, { expectedRevision: revision, now: new Date(createdAt) });
      revision = result.revision;
      assert.ok(result.entry);
      return result.entry;
    };

    const ttlBoundary = await write("TTL boundary", "2026-08-01T00:00:00.000Z");
    const ttlExpired = await write("TTL expired", "2026-07-31T00:00:00.000Z");
    const futureExpiry = await write("Future expiry", "2026-07-31T00:00:00.000Z", { expiresAt: "2026-09-01T00:00:00.000Z" });
    const recalled = await write("Recalled temporary", "2026-07-31T00:00:00.000Z");
    const pastExpiry = await write("Past expiry", "2026-08-30T00:00:00.000Z", { expiresAt: "2026-08-30T23:59:59.000Z" });
    const equalExpiry = await write("Equal expiry", "2026-08-30T00:00:00.000Z", { expiresAt: now.toISOString() });
    await memory.recordRecallUsage([recalled.id], { now: new Date("2026-08-30T12:00:00.000Z") });

    const result = await memory.runMemoryMaintenance({
      now,
      temporaryTtl: 30,
      useLlm: false
    });
    assert.equal(result.failed, 0);
    const active = (await memory.listMemoryEntries({ origins: ["current_workspace"] })).entries;
    assert.deepEqual(new Set(active.map((entry) => entry.id)), new Set([ttlBoundary.id, recalled.id, equalExpiry.id]));
    const archived = (await memory.listArchivedEntries()).entries;
    assert.deepEqual(new Set(archived.map((entry) => entry.originalId)), new Set([ttlExpired.id, futureExpiry.id, pastExpiry.id]));
  });
}

async function testSleepExactDedupAcrossOrigins(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const summary = "The user prefers deterministic release checks before publishing changes.";
    const workspace = await memory.writeEntry({
      ...projectEntry("Release preference", summary)
    }, { expectedRevision: 0 });
    const universal = await memory.writeEntry({
      ...projectEntry("Release preference", summary),
      audience: "universal",
      kind: "preference",
      lineage: {
        source: "explicit",
        externalContext: false,
        userEvidence: "I prefer deterministic release checks before publishing."
      }
    }, { expectedRevision: workspace.revision });
    assert.ok(workspace.entry && universal.entry);

    const result = await memory.runMemoryMaintenance({ useLlm: false });
    assert.equal(result.failed, 0);
    assert.equal((await memory.listMemoryEntries({ origins: ["all"] })).entries.length, 1);
    const archived = (await memory.listArchivedEntries()).entries;
    assert.equal(archived.length, 1);
    assert.equal(archived[0]?.origin.kind, "workspace");
    assert.equal(archived[0]?.mergedInto, universal.entry.id);
  });
}

async function testSleepSimilarityBoundaries(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const prompts: string[] = [];
    const model = jsonMemoryModel((prompt) => {
      const ids = memoryClusterIds(prompt);
      return ids.length === 3
        ? JSON.stringify({ delete: [], synthesize: [] })
        : JSON.stringify({ delete: [ids[0]], synthesize: [] });
    }, prompts);
    const memory = new LocalMemory(workspaceRoot, () => model);
    let revision = 0;
    const write = async (title: string, summary: string, extras: Partial<MemoryEntryInput> = {}): Promise<MemoryEntry> => {
      const result = await memory.writeEntry({ ...projectEntry(title, summary), ...extras }, { expectedRevision: revision });
      revision = result.revision;
      assert.ok(result.entry);
      return result.entry;
    };

    const permanent = await write("Permanent rule", "The permanent rule is the durable source for this similar fact.", { importance: 1 });
    const temporary = await write("Temporary rule", "The temporary rule repeats the durable source with extra detail.", { durability: "temporary", importance: 5 });
    const chainA = await write("Chain A", "The first chain memory describes the same release operation.");
    const chainB = await write("Chain B", "The middle chain memory describes the same release operation.");
    const chainC = await write("Chain C", "The last chain memory describes the same release operation.");
    const pairA = await write("Pair A", "The first pair memory describes a repeated deployment operation.");
    const pairB = await write("Pair B", "The second pair memory describes a repeated deployment operation.");

    const result = await memory.runMemoryMaintenance({ now: new Date("2026-08-31T00:00:00.000Z") }, {
      indexEntry: async () => undefined,
      requestRebuild: () => undefined,
      findSimilarPairs: async () => [
        { leftId: permanent.id, rightId: temporary.id, similarity: 0.95 },
        { leftId: chainA.id, rightId: chainB.id, similarity: 0.8 },
        { leftId: chainB.id, rightId: chainC.id, similarity: 0.8 },
        { leftId: pairA.id, rightId: pairB.id, similarity: 0.8 }
      ]
    });
    assert.equal(result.failed, 0);
    assert.equal(prompts.length, 2, "0.95 must be deterministic; the chain must reach one LLM cluster");
    const active = (await memory.listMemoryEntries({ origins: ["current_workspace"] })).entries;
    assert.equal(active.some((entry) => entry.id === permanent.id), true, "permanent memory wins survivor selection");
    assert.equal(active.some((entry) => entry.id === temporary.id), false);
    assert.equal(active.filter((entry) => [chainA.id, chainB.id, chainC.id].includes(entry.id)).length, 3);
    const activePair = active.find((entry) => [pairA.id, pairB.id].includes(entry.id));
    assert.ok(activePair);
    const archived = (await memory.listArchivedEntries()).entries;
    const similarityArchived = archived.find((entry) => entry.originalId === temporary.id);
    assert.equal(similarityArchived?.archivedReason, "similarity_merge");
    assert.ok(similarityArchived?.archivedBy?.startsWith(result.startedAt + "-"));
    assert.equal(similarityArchived?.mergedInto, permanent.id);
    const llmArchived = archived.find((entry) => [pairA.id, pairB.id].includes(entry.originalId ?? ""));
    assert.equal(llmArchived?.archivedReason, "llm_merge");
    assert.equal(llmArchived?.mergedInto, activePair.id);
  });
}

async function testSleepSynthesisArchivesCluster(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const model = jsonMemoryModel(() => JSON.stringify({
      delete: [],
      synthesize: [{
        content: "The synthesized memory preserves both source facts and is now the single active representation.",
        durability: "permanent"
      }]
    }));
    const memory = new LocalMemory(workspaceRoot, () => model);
    let revision = 0;
    const first = await memory.writeEntry(projectEntry("Synthesis A", "The first source fact is part of the synthesized memory cluster."), { expectedRevision: revision });
    revision = first.revision;
    const second = await memory.writeEntry(projectEntry("Synthesis B", "The second source fact is part of the synthesized memory cluster."), { expectedRevision: revision });
    revision = second.revision;
    assert.ok(first.entry && second.entry);
    await memory.runMemoryMaintenance({}, {
      indexEntry: async () => undefined,
      requestRebuild: () => undefined,
      findSimilarPairs: async () => [{ leftId: first.entry!.id, rightId: second.entry!.id, similarity: 0.8 }]
    });

    const active = (await memory.listMemoryEntries({ origins: ["current_workspace"] })).entries;
    assert.equal(active.length, 3);
    const synthesis = active.find((entry) => entry.lineage.at(-1)?.source === "sleep");
    assert.ok(synthesis);
    assert.deepEqual(new Set(synthesis.lineage.at(-1)?.sourceEntryIds), new Set([first.entry!.id, second.entry!.id]));
    const archived = (await memory.listArchivedEntries()).entries;
    assert.equal(archived.length, 0, "synthesis without delete keeps the old cluster active");
    const database = new DatabaseSync(path.join(agentRoot, "memory", memoryDatabaseFileName), { readOnly: true });
    try {
      const row = database.prepare("SELECT metadata FROM memories WHERE id = ?").get(synthesis.id) as { metadata?: string } | undefined;
      assert.match(row?.metadata ?? "", /"source":"sleep"/u);
    } finally {
      database.close();
    }
  });
}

async function testSleepInvalidDeleteIsSafe(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const model = jsonMemoryModel((prompt) => {
      const ids = memoryClusterIds(prompt);
      return JSON.stringify({ delete: ["not-a-cluster-entry", ids[0]], synthesize: [] });
    });
    const memory = new LocalMemory(workspaceRoot, () => model);
    const first = await memory.writeEntry(projectEntry("Invalid delete A", "The first source fact must remain after an invalid model response."), { expectedRevision: 0 });
    const second = await memory.writeEntry(projectEntry("Invalid delete B", "The second source fact must remain after an invalid model response."), { expectedRevision: first.revision });
    assert.ok(first.entry && second.entry);
    const result = await memory.runMemoryMaintenance({}, {
      indexEntry: async () => undefined,
      requestRebuild: () => undefined,
      findSimilarPairs: async () => [{ leftId: first.entry!.id, rightId: second.entry!.id, similarity: 0.8 }]
    });
    assert.equal(result.failed, 0);
    assert.equal((await memory.listMemoryEntries({ origins: ["current_workspace"] })).entries.length, 1);
    assert.equal((await memory.listArchivedEntries()).entries.length, 1);
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
    const databasePath = path.join(memoryRoot, memoryDatabaseFileName);
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

async function testSemanticSearchTreatsUnbuiltIndexAsEmptyCandidates(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const created = await memory.writeEntry(projectEntry(
      "Unbuilt semantic memory",
      "An existing fact may temporarily have no vector while the semantic index is being built."
    ), { expectedRevision: 0 });
    assert.ok(created.entry);
    const ref = { kind: "provider", provider: "test", model: "embedding" } as const;
    const descriptor: EmbeddingModelDescriptor = {
      ref,
      fingerprint: "sha256:unbuilt-index-test",
      displayName: "Unbuilt index test",
      dimensions: 3,
      recommendedThresholds: { currentWorkspace: 0.8, crossWorkspace: 0.86 },
      source: "provider"
    };
    let embeddingCalls = 0;
    const runtime: EmbeddingModelRuntime = {
      descriptor,
      fingerprint: descriptor.fingerprint,
      embed: async ({ texts }) => {
        embeddingCalls += texts.length;
        return {
          embeddings: texts.map(() => new Float32Array([1, 0, 0])),
          dimensions: 3,
          fingerprint: descriptor.fingerprint,
          model: ref
        };
      }
    };
    const service = new MemoryEmbeddingService({
      localMemory: memory,
      localManager: { list: async () => [] } as unknown as LocalEmbeddingManager,
      getVectorIndex: () => { throw new Error("an unbuilt read must not create a writable index"); },
      getReadOnlyVectorIndex: () => undefined,
      getActiveModel: () => ref,
      getProviderModels: () => [descriptor],
      getRuntime: async () => runtime
    });
    const candidates = await service.findSimilarEntries(
      "find the existing semantic memory",
      [created.entry],
      5,
      0.3
    );
    assert.deepEqual(candidates, []);
    assert.equal(embeddingCalls, 1, "the query still needs a semantic embedding before treating the index as empty");
  });
}

async function testFactsAndVectorsShareDatabase(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const storage = new MemoryStorage(workspaceRoot);
    const written = await storage.writeEntry(projectEntry(
      "Shared memory database",
      "Facts and their embedding projection must live in the same memory SQLite database."
    ), { expectedRevision: 0 });
    assert.ok(written.entry);

    const memoryRoot = path.join(agentRoot, "memory");
    const databasePath = path.join(memoryRoot, memoryDatabaseFileName);
    assert.equal(
      MemoryVectorIndex.openReadOnly(memoryRoot),
      undefined,
      "事实库已存在但向量表尚未初始化时，只读索引应按未建立处理"
    );
    const index = new MemoryVectorIndex(memoryRoot);
    assert.equal(index.databasePath, databasePath);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const tables = new Set((database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
      ).all() as Array<{ name?: unknown }>).map((row) => row.name));
      assert.equal(tables.has("memories"), true);
      assert.equal(tables.has("memory_archive"), true);
      assert.equal(tables.has("memory_vectors"), true);
      assert.equal(tables.has("memory_vector_generations"), true);
      assert.equal(tables.has("memory_vector_entry_states"), true);
      assert.equal(
        (database.prepare("SELECT COUNT(*) AS count FROM memories").get() as { count?: unknown }).count,
        1
      );
    } finally {
      database.close();
      index.close();
    }
    await assert.rejects(
      fs.access(path.join(memoryRoot, ".memory-index.sqlite")),
      /ENOENT/u,
      "不应再创建独立的向量 SQLite 文件"
    );
  });
}

async function testInitialEmbeddingGeneration(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const created = await memory.writeEntry(projectEntry(
      "Initial vector memory",
      "The first memory must be searchable immediately after its embedding is written."
    ), { expectedRevision: 0 });
    assert.ok(created.entry);

    const ref = { kind: "provider", provider: "test", model: "embedding" } as const;
    const descriptor: EmbeddingModelDescriptor = {
      ref,
      fingerprint: "sha256:initial-generation-test",
      displayName: "Initial generation test",
      dimensions: 3,
      recommendedThresholds: { currentWorkspace: 0.8, crossWorkspace: 0.86 },
      source: "provider"
    };
    const runtime: EmbeddingModelRuntime = {
      descriptor,
      fingerprint: descriptor.fingerprint,
      embed: async ({ texts }) => ({
        embeddings: texts.map(() => new Float32Array([1, 0, 0])),
        dimensions: 3,
        fingerprint: descriptor.fingerprint,
        model: ref
      })
    };
    const service = new MemoryEmbeddingService({
      localMemory: memory,
      localManager: { list: async () => [] } as unknown as LocalEmbeddingManager,
      getVectorIndex: () => new MemoryVectorIndex(path.join(agentRoot, "memory")),
      getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(path.join(agentRoot, "memory")),
      getActiveModel: () => ref,
      getProviderModels: () => [descriptor],
      getRuntime: async () => runtime
    });

    await service.indexEntry(created.entry);
    const status = await service.status();
    assert.equal(status.index.active?.modelFingerprint, descriptor.fingerprint);
    assert.equal(status.indexedEntries, 1);
    assert.equal(status.pendingEntries, 0);
    assert.equal(status.failedEntries, 0);
  });
}

async function testVectorRebuildLockAndRecovery(): Promise<void> {
  await withSharedAgent(async (agentRoot) => {
    const memoryRoot = path.join(agentRoot, "memory");
    const first = new MemoryVectorIndex(memoryRoot);
    const second = new MemoryVectorIndex(memoryRoot);
    const release = first.acquireRebuildLock();
    try {
      assert.throws(() => second.acquireRebuildLock(), /already running/u);
    } finally {
      release();
    }

    second.beginGeneration("sha256:orphan-generation", 2, "orphan-generation");
    first.close();
    second.close();

    const recovered = new MemoryVectorIndex(memoryRoot);
    try {
      const status = recovered.status();
      assert.equal(status.building, 0, "重启后不能留下永远 building 的 generation");
      assert.equal(status.failed, 1, "没有活跃重建进程时应把遗留 generation 标为 failed");
    } finally {
      recovered.close();
    }
  });
}

async function testLocalMemoryMutationKeepsIndexInSync(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const indexed: string[] = [];
    const removed: string[] = [];
    const memory = new LocalMemory(
      workspaceRoot,
      unusedModel,
      undefined,
      3,
      undefined,
      undefined,
      {
        indexEntry: async (entry) => { indexed.push(entry.id); },
        removeEntries: (entryIds) => { removed.push(...entryIds); }
      }
    );
    const created = await memory.writeEntry(projectEntry(
      "Mutation index sync",
      "Every public memory mutation must keep its derived vector index synchronized."
    ), { expectedRevision: 0 });
    assert.ok(created.entry);
    assert.deepEqual(indexed, [created.entry.id]);

    const updated = await memory.updateEntry(created.entry.id, { title: "Updated mutation index sync" }, {
      expectedRevision: created.revision
    });
    assert.equal(updated.written, true);
    assert.deepEqual(indexed, [created.entry.id, created.entry.id]);

    const archived = await memory.archiveEntry(created.entry.id, true, { expectedRevision: updated.revision });
    assert.equal(archived.archived, true);
    assert.deepEqual(removed, [created.entry.id]);

    const archivedUpdate = await memory.updateEntry(archived.entry!.id, { title: "Edited archived mutation index sync" }, {
      expectedRevision: archived.revision
    });
    assert.equal(archivedUpdate.written, true);
    assert.deepEqual(indexed, [created.entry.id, created.entry.id]);
    assert.deepEqual(removed, [created.entry.id, created.entry.id], "编辑归档条目不能重新建立活动向量");

    const restored = await memory.archiveEntry(archivedUpdate.entry!.id, false, { expectedRevision: archivedUpdate.revision });
    assert.equal(restored.archived, false);
    assert.ok(restored.entry);
    assert.deepEqual(indexed, [created.entry.id, created.entry.id, restored.entry.id]);

    const deleted = await memory.deleteEntryById(restored.entry.id, { expectedRevision: restored.revision });
    assert.equal(deleted.deleted, true);
    assert.deepEqual(removed, [created.entry.id, created.entry.id, restored.entry.id]);

    const second = await memory.writeEntry(projectEntry(
      "Clear mutation index sync",
      "Clearing the memory library must remove every selected entry from the derived vector index too."
    ), { expectedRevision: deleted.revision });
    assert.ok(second.entry);
    assert.deepEqual(indexed, [created.entry.id, created.entry.id, restored.entry.id, second.entry.id]);
    const archivedSecond = await memory.archiveEntry(second.entry.id, true, { expectedRevision: second.revision });
    assert.equal(archivedSecond.archived, true);
    assert.deepEqual(removed, [created.entry.id, created.entry.id, restored.entry.id, second.entry.id]);
    const cleared = await memory.clearEntries("all", { expectedRevision: archivedSecond.revision });
    assert.equal(cleared.deletedEntries, 1);
    assert.deepEqual(removed, [created.entry.id, created.entry.id, restored.entry.id, second.entry.id, second.entry.id]);
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

function jsonMemoryModel(response: (prompt: string) => string, prompts: string[] = []): AgentModel {
  return {
    provider: "test",
    modelId: "memory-sleep-test",
    async stream(context, options) {
      const prompt = context.messages.flatMap((message) => (
        typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((content) => content.type === "text" ? [content.text] : [])
      )).join("\n");
      prompts.push(prompt);
      const text = response(prompt);
      return (async function* () {
        options?.signal?.throwIfAborted();
        yield { type: "text-delta" as const, text };
        yield { type: "finish" as const, reason: "stop" as const };
      })();
    }
  };
}

function memoryClusterIds(prompt: string): string[] {
  return [...prompt.matchAll(/"id":"([^"]+)"/gu)].map((match) => match[1]!).filter(Boolean);
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
