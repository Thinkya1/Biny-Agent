import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage, AgentModel, ModelStreamContext, ModelStreamEvent } from "../src/agent/core/types.js";
import {
  LocalMemory,
  MemoryRevisionConflictError,
  type MemoryEntryInput
} from "../src/agent/context/LocalMemory.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { BINY_AGENT_DIR_ENV, projectMemoryDir } from "../src/config/paths.js";

async function main(): Promise<void> {
  const globalRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v2-global-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = globalRoot;
  try {
    await testScopedCasAndGlobalBoundary();
    await testEntryRankingAndBudgetReport();
    await testBoundedIndexAndConcurrentCas();
    await testLosslessV1Migration();
    await testCandidateQueueEligibilityAndRedaction();
    await testCandidateMaintenanceAndConsolidation();
    console.log("memory v2 tests passed");
  } finally {
    if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previous;
    await rm(globalRoot, { recursive: true, force: true });
  }
}

async function testScopedCasAndGlobalBoundary(): Promise<void> {
  await withWorkspace(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const overview = await memory.getOverview();
    assert.deepEqual(overview.revision, { global: 0, project: 0 });

    const global = await memory.writeScoped({
      scope: "global",
      kind: "working_style",
      topic: "working-style",
      title: "Concise updates",
      summary: "The user explicitly prefers concise progress updates during long coding tasks.",
      importance: 5,
      lineage: {
        source: "explicit",
        externalContext: false,
        sessionId: "session-global",
        turnId: "turn-global",
        runId: "run-global",
        userEvidence: "Please keep progress updates concise."
      }
    }, { expectedRevision: overview.scopes.global.revision });
    assert.equal(global.written, true);
    assert.equal(global.revision, 1);
    assert.equal(global.entry?.scope, "global");
    assert.equal(global.entry?.revision, 1);

    const project = await memory.writeScoped(projectEntry("Weather source", "Use src/weather.ts for deterministic weather requests."), {
      expectedRevision: overview.scopes.project.revision
    });
    assert.equal(project.revision, 1);

    await assert.rejects(memory.writeScoped({
      scope: "global",
      kind: "decision",
      topic: "decisions",
      title: "Repository decision",
      summary: "Use src/weather.ts as this repository's weather entry point.",
      paths: ["src/weather.ts"],
      lineage: {
        source: "explicit",
        externalContext: false,
        userEvidence: "Use src/weather.ts."
      }
    }, { expectedRevision: 1 }), /Global memory only accepts|Project paths and decisions/u);

    await assert.rejects(memory.writeScoped(projectEntry("Stale", "This stale CAS write must never overwrite a newer entry."), {
      expectedRevision: 0
    }), MemoryRevisionConflictError);

    const listed = await memory.listStoredEntries();
    assert.equal(listed.entries.length, 2);
    assert.deepEqual(listed.revision, { global: 1, project: 1 });
    assert.equal(new Set(listed.entries.map(({ id }) => id)).size, 2);
    assert.equal(listed.entries.every(({ lineage }) => lineage.length > 0), true);

    const projectDirectory = projectMemoryDir(await fs.realpath(workspaceRoot));
    const entriesDirectory = path.join(projectDirectory, "entries");
    const projectFiles = (await fs.readdir(entriesDirectory)).filter((file) => file.endsWith(".md"));
    assert.equal(projectFiles.length, 1, "one durable entry must occupy exactly one Markdown file");
    const content = await fs.readFile(path.join(entriesDirectory, projectFiles[0]!), "utf8");
    assert.match(content, /^---\nversion: 2\n/u);
    assert.match(content, /lineage:/u);
  });
}

async function testEntryRankingAndBudgetReport(): Promise<void> {
  await withWorkspace(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel, undefined, 2);
    let revision = 0;
    revision = (await memory.writeScoped({
      ...projectEntry("天气重试", "天气请求失败时最多重试三次，并保留明确的错误信息。"),
      topic: "天气工作流",
      keywords: ["天气", "重试"],
      paths: ["src/weather.ts"],
      importance: 5
    }, { expectedRevision: revision, now: new Date("2026-08-01T00:00:00.000Z") })).revision;
    revision = (await memory.writeScoped({
      ...projectEntry("Weather fallback", "Weather lookups may use a cached fallback when the network is unavailable."),
      keywords: ["weather", "fallback"],
      paths: ["src/cache.ts"],
      importance: 2
    }, { expectedRevision: revision, now: new Date("2026-08-09T00:00:00.000Z") })).revision;
    assert.equal(revision, 2);

    const result = await memory.searchScoped("天气 weather", ["src/weather.ts"], {
      limit: 1,
      now: new Date("2026-08-10T00:00:00.000Z")
    });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]?.entry.title, "天气重试");
    assert.equal(result.matches[0]?.entry.topic, "天气工作流");
    assert.equal(result.report.included.project, 1);
    assert.equal(result.report.trimmed.project, 1);
    assert.equal(result.report.omitted.some(({ reason }) => reason === "entry_limit"), true);

    const budgeted = await memory.searchScoped("天气", ["src/weather.ts"], {
      limit: 2,
      maxChars: 1,
      now: new Date("2026-08-10T00:00:00.000Z")
    });
    assert.equal(budgeted.matches.length, 0);
    assert.equal(budgeted.report.omitted.some(({ reason }) => reason === "budget"), true);
    assert.equal(budgeted.report.budgetOmission?.maxChars, 1);
  });
}

async function testBoundedIndexAndConcurrentCas(): Promise<void> {
  await withWorkspace(async (workspaceRoot) => {
    const storage = new MemoryStorage(workspaceRoot, { maxIndexChars: 1_024 });
    let revision = 0;
    for (let index = 0; index < 18; index += 1) {
      revision = (await storage.writeScoped(projectEntry(
        `Long indexed title ${String(index)} ${"x".repeat(70)}`,
        `Durable indexed summary ${String(index)} ${"content ".repeat(20)}`
      ), { expectedRevision: revision })).revision;
    }
    const index = await storage.readIndex("project");
    assert.ok(index);
    assert.ok(index.length <= 1_024);
    assert.match(index, /omitted from this bounded index/u);
    assert.equal((await storage.listStoredEntries({ scopes: ["project"] })).entries.length, 18);

    const sameRevision = revision;
    const concurrent = await Promise.allSettled([
      storage.writeScoped(projectEntry("Concurrent A", "Concurrent A must win or conflict without overwriting another writer."), {
        expectedRevision: sameRevision
      }),
      storage.writeScoped(projectEntry("Concurrent B", "Concurrent B must win or conflict without overwriting another writer."), {
        expectedRevision: sameRevision
      })
    ]);
    assert.equal(concurrent.filter(({ status }) => status === "fulfilled").length, 1);
    const rejected = concurrent.find(({ status }) => status === "rejected");
    assert.ok(rejected?.status === "rejected" && rejected.reason instanceof MemoryRevisionConflictError);
    assert.equal((await storage.getOverview()).scopes.project.revision, sameRevision + 1);
  });
}

async function testLosslessV1Migration(): Promise<void> {
  await withWorkspace(async (workspaceRoot) => {
    const memoryDirectory = projectMemoryDir(await fs.realpath(workspaceRoot));
    await fs.mkdir(memoryDirectory, { recursive: true });
    const legacyTopic = [
      "Legacy preamble that must survive in the exact backup.",
      "",
      "## First workflow",
      "",
      "- Date: 2026-07-01T00:00:00.000Z",
      "- Summary: First durable migrated workflow with enough detail.",
      "- Paths: src/first.ts",
      "- Tags: first, workflow",
      "",
      "## 第二条",
      "",
      "- Summary: 第二条长期记忆也必须无损迁移并能检索。",
      ""
    ].join("\n");
    const legacyIndex = "# Biny Project Memory\n\n- [project.md](project.md) | tags: legacy\n";
    await fs.writeFile(path.join(memoryDirectory, "project.md"), legacyTopic, "utf8");
    await fs.writeFile(path.join(memoryDirectory, "MEMORY.md"), legacyIndex, "utf8");

    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const first = await memory.listStoredEntries({ scopes: ["project"] });
    assert.equal(first.entries.length, 3, "preamble and both sections must remain represented");
    assert.equal(first.entries.every(({ lineage }) => lineage.some(({ source }) => source === "migration")), true);
    assert.equal(await fs.readFile(path.join(memoryDirectory, ".legacy-v1", "project.md"), "utf8"), legacyTopic);
    assert.equal(await fs.readFile(path.join(memoryDirectory, ".legacy-v1", "MEMORY.md"), "utf8"), legacyIndex);
    assert.equal((await fs.readdir(memoryDirectory)).includes("project.md"), false);

    const second = await memory.listStoredEntries({ scopes: ["project"] });
    assert.equal(second.entries.length, first.entries.length, "migration must be one-time and idempotent");
    assert.equal(second.revision.project, first.revision.project);
    assert.equal((await memory.searchScoped("无损迁移", [], { scopes: ["project"], limit: 3 })).matches.length > 0, true);
  });
}

async function testCandidateQueueEligibilityAndRedaction(): Promise<void> {
  await withWorkspace(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const createdAt = new Date("2026-08-10T00:00:00.000Z");
    const queued = await memory.enqueueCandidate({
      summary: "Completed root turn established a durable workflow. apiKey=sk-candidate-secret-value",
      completed: true,
      lineage: {
        source: "completed_task",
        sessionId: "session-1",
        turnId: "turn-1",
        runId: "run-1",
        externalContext: false
      },
      scopeHint: "project",
      kindHint: "workflow"
    }, { expectedRevision: 0, excludeExternalContext: true, now: createdAt });
    assert.equal(queued.queued, true);
    assert.equal(queued.candidate?.summary.includes("sk-candidate-secret-value"), false);
    assert.match(queued.candidate?.summary ?? "", /\[redacted\]/u);
    assert.equal((await memory.scanEligibleCandidates({ now: new Date("2026-08-10T05:59:59.999Z") })).candidates.length, 0);
    assert.equal((await memory.scanEligibleCandidates({ now: new Date("2026-08-10T06:00:00.000Z") })).candidates.length, 1);

    const excluded = await memory.enqueueCandidate({
      summary: "This completed task summary came entirely from external browsing context.",
      completed: true,
      lineage: {
        source: "completed_task",
        sessionId: "session-2",
        turnId: "turn-2",
        runId: "run-2",
        externalContext: true
      }
    }, { expectedRevision: queued.revision, excludeExternalContext: true, now: createdAt });
    assert.equal(excluded.queued, false);
    assert.equal(excluded.reason, "external_context_excluded");
    assert.equal(excluded.revision, queued.revision);
  });
}

async function testCandidateMaintenanceAndConsolidation(): Promise<void> {
  await withWorkspace(async (workspaceRoot) => {
    const extractionModel = jsonModel(() => ({
      memory: {
        scope: "global",
        kind: "working_style",
        topic: "working-style",
        title: "Short progress updates",
        summary: "The user explicitly prefers short progress updates while long tasks are running.",
        decisions: [],
        paths: [],
        keywords: ["progress", "concise"],
        importance: 5,
        explicitUserEvidence: "Please keep long-task progress updates short."
      }
    }));
    const consolidationModel = jsonModel((messages) => {
      const text = messageText(messages.at(-1));
      const ids = [...text.matchAll(/"id":"([^"]+)"/gu)].map((match) => match[1]!).filter(Boolean);
      return {
        entries: [{
          sourceEntryIds: ids,
          kind: "workflow",
          topic: "workflow",
          title: "Unified release workflow",
          summary: "Run tests and typecheck before releasing from the main branch.",
          decisions: [],
          paths: [],
          keywords: ["release", "test", "typecheck"],
          importance: 4
        }]
      };
    });
    const memory = new LocalMemory(workspaceRoot, () => extractionModel, undefined, 3, undefined, undefined, () => consolidationModel);
    const createdAt = new Date("2026-08-01T00:00:00.000Z");
    await memory.enqueueCandidate({
      summary: "The user explicitly asked for short progress updates during long coding tasks.",
      completed: true,
      lineage: {
        source: "completed_task",
        sessionId: "session-maintenance",
        turnId: "turn-maintenance",
        runId: "run-maintenance",
        externalContext: false
      }
    }, { expectedRevision: 0, excludeExternalContext: true, now: createdAt });
    const maintenance = await memory.processEligibleCandidates({ now: new Date("2026-08-01T06:00:00.000Z"), excludeExternalContext: true });
    assert.deepEqual({ scanned: maintenance.scanned, processed: maintenance.processed, written: maintenance.written, failed: maintenance.failed }, {
      scanned: 1,
      processed: 1,
      written: 1,
      failed: 0
    });
    assert.equal(memory.maintenanceStatus().state, "idle");
    const reloadedStatus = await new LocalMemory(workspaceRoot, unusedModel).loadMaintenanceStatus();
    assert.equal(reloadedStatus.lastScanAt, "2026-08-01T06:00:00.000Z");
    assert.equal(reloadedStatus.processed, 1);
    assert.equal((await memory.scanEligibleCandidates({ now: new Date("2026-08-02T00:00:00.000Z") })).candidates.length, 0);
    const global = await memory.listStoredEntries({ scopes: ["global"] });
    const maintained = global.entries.find(({ title }) => title === "Short progress updates");
    assert.equal(maintained?.kind, "working_style");
    assert.equal(maintained?.lineage[0]?.runId, "run-maintenance");

    let revision = (await memory.getOverview()).scopes.project.revision;
    revision = (await memory.writeScoped({
      ...projectEntry("Release tests", "Run the focused tests before publishing a release."),
      topic: "workflow",
      kind: "workflow",
      lineage: { source: "explicit", externalContext: false, sessionId: "source-a" }
    }, { expectedRevision: revision })).revision;
    revision = (await memory.writeScoped({
      ...projectEntry("Release typecheck", "Run typecheck before publishing from the main branch."),
      topic: "workflow",
      kind: "workflow",
      lineage: { source: "explicit", externalContext: false, sessionId: "source-b" }
    }, { expectedRevision: revision })).revision;
    const consolidated = await memory.consolidateScope("project", { expectedRevision: revision, topic: "workflow" });
    assert.equal(consolidated.before, 2);
    assert.equal(consolidated.after, 1);
    const merged = (await memory.listStoredEntries({ scopes: ["project"], topic: "workflow" })).entries[0];
    assert.ok(merged);
    assert.equal(merged.lineage.some(({ sessionId }) => sessionId === "source-a"), true);
    assert.equal(merged.lineage.some(({ sessionId }) => sessionId === "source-b"), true);
    assert.equal(merged.lineage.some(({ source, sourceEntryIds }) => source === "consolidation" && sourceEntryIds?.length === 2), true);
  });
}

function projectEntry(title: string, summary: string): MemoryEntryInput {
  return {
    scope: "project",
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

function jsonModel(response: (messages: AgentMessage[]) => unknown): AgentModel {
  return {
    provider: "test",
    modelId: "json",
    async stream(context: ModelStreamContext, options): Promise<AsyncIterable<ModelStreamEvent>> {
      const payload = JSON.stringify(response(context.messages));
      return (async function* () {
        options?.signal?.throwIfAborted();
        yield { type: "start" as const };
        yield { type: "text-delta" as const, text: payload };
        yield { type: "finish" as const, reason: "stop" as const };
      })();
    }
  };
}

function messageText(message: AgentMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => "text" in part && typeof part.text === "string" ? part.text : "").join("\n");
}

async function withWorkspace(run: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v2-workspace-"));
  try {
    await run(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

await main();
