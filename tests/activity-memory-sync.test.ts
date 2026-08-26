/**
 * worthMemory → 记忆写（P3 验收项）测试：syncWorthwhileActivityMemories 把
 * activity_session_analysis 里 worth_memory=1 的行同步成 LocalMemory 条目；
 * 幂等（重复同步 written=false 不重复推进）；记忆失败不影响分析数据。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncWorthwhileActivityMemories } from "../src/activity/memorySync.js";
import { ActivityStore, type ActivitySessionAnalysis } from "../src/activity/store.js";
import type { MemoryEntry, MemoryEntryInput, MemoryOverview } from "../src/agent/context/memoryTypes.js";

const NOW = new Date(2026, 7, 26, 15, 0, 0);


class FakeLocalMemory {
  writes: MemoryEntryInput[] = [];
  duplicateByTopic = false;
  forceError = false;
  private revision = 1;

  async getOverview(): Promise<MemoryOverview> {
    return {
      storeRevision: this.revision,
      entryCount: this.writes.length,
      candidateCount: 0,
      indexChars: 0,
      origins: { user: 0, currentWorkspace: this.writes.length, otherWorkspaces: 0 }
    };
  }

  async writeEntry(input: MemoryEntryInput, options: { expectedRevision: number }): Promise<{ written: boolean; entry?: MemoryEntry; revision: number }> {
    if (this.forceError) throw new Error("memory write exploded");
    const duplicate = this.duplicateByTopic && this.writes.some((entry) => entry.topic === input.topic);
    if (duplicate) return { written: false, revision: this.revision };
    this.writes.push(input);
    this.revision += 1;
    return {
      written: true,
      revision: this.revision,
      entry: {
        id: `memory-${this.writes.length}`,
        origin: { kind: "workspace", workspaceId: "test", workspaceName: "test" },
        kind: input.kind,
        topic: input.topic,
        title: input.title,
        summary: input.summary,
        decisions: input.decisions ?? [],
        paths: input.paths ?? [],
        keywords: input.keywords ?? [],
        importance: input.importance ?? 3,
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
        revision: this.revision,
        lineage: Array.isArray(input.lineage) ? input.lineage : [input.lineage],
        recallCount: 0
      }
    };
  }
}

await testWorthMemoryRowsAreWrittenAsMemoryEntries();
await testIdempotentSyncSkipsExistingEntries();
await testMemoryFailureDoesNotThrow();
await testNonWorthMemoryRowsAreIgnored();

/** worth_memory=1 的行 → 写入记忆条目（decision 优先归类为 decision）。 */
async function testWorthMemoryRowsAreWrittenAsMemoryEntries(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedAnalyzedSession(store, { worthMemory: true, decisions: ["走 confirm_external"], storageTier: "important" });
    const memory = new FakeLocalMemory();
    const result = await syncWorthwhileActivityMemories({ store, memory });
    assert.deepEqual(result, { evaluated: 1, written: 1, skipped: 0, failed: 0 });
    assert.equal(memory.writes.length, 1);
    const input = memory.writes[0]!;
    assert.equal(input.kind, "decision");
    assert.equal(input.importance, 4, "important 档映射为高重要度");
    assert.equal(input.lineage.source, "completed_task");
    assert.equal(input.lineage.externalContext, false);
    assert.equal(input.lineage.sessionId, sessionId);
    assert.ok(input.title.includes("走 confirm_external") || input.summary.includes("走 confirm_external"));
  });
}

/** 重复同步幂等：存储层认为等价时 written=false，不计入 written、不报错。 */
async function testIdempotentSyncSkipsExistingEntries(): Promise<void> {
  await withStore(async (store) => {
    seedAnalyzedSession(store, { worthMemory: true });
    const memory = new FakeLocalMemory();
    const first = await syncWorthwhileActivityMemories({ store, memory });
    assert.equal(first.written, 1);
    // 第二次：fake 按 topic 记录已写，writeEntry 返回 written=false（模拟存储去重）。
    memory.duplicateByTopic = true;
    const second = await syncWorthwhileActivityMemories({ store, memory });
    assert.deepEqual(second, { evaluated: 1, written: 0, skipped: 1, failed: 0 });
  });
}

/** 记忆写失败（如 revision 冲突耗尽重试）只计 failed，不向调用方抛错。 */
async function testMemoryFailureDoesNotThrow(): Promise<void> {
  await withStore(async (store) => {
    seedAnalyzedSession(store, { worthMemory: true });
    const memory = new FakeLocalMemory();
    memory.forceError = true;
    const result = await syncWorthwhileActivityMemories({ store, memory });
    assert.equal(result.failed, 1);
    assert.equal(result.written, 0);
  });
}

/** worth_memory=0 的行不进入记忆写入。 */
async function testNonWorthMemoryRowsAreIgnored(): Promise<void> {
  await withStore(async (store) => {
    seedAnalyzedSession(store, { worthMemory: false });
    const memory = new FakeLocalMemory();
    const result = await syncWorthwhileActivityMemories({ store, memory });
    assert.deepEqual(result, { evaluated: 0, written: 0, skipped: 0, failed: 0 });
    assert.equal(memory.writes.length, 0);
  });
}


async function withStore(run: (store: ActivityStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-memory-sync-"));
  const store = new ActivityStore();
  try {
    await store.open(root);
    await run(store);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function seedAnalyzedSession(store: ActivityStore, overrides: Partial<ActivitySessionAnalysis> = {}): string {
  const sessionId = store.startSession(todayAt(9));
  const startMs = Date.parse(todayAt(9));
  for (let index = 0; index < 3; index += 1) {
    store.recordEvent({
      sessionId,
      occurredAt: new Date(startMs + index * 1_000).toISOString(),
      eventType: "focus_changed",
      application: "Test App",
      rawText: `Test App event ${index}`
    });
  }
  store.endSession(sessionId, todayAt(10));
  store.recordAnalysis({
    sessionId,
    analyzedAt: todayAt(10, 5),
    analyzerModel: "analyzer-test-model",
    project: "biny",
    summary: "确定分析层走 confirm_external 策略",
    topics: ["分析策略"],
    prs: [],
    issues: [],
    people: [],
    versions: [],
    decisions: ["走 confirm_external"],
    entities: ["ActivityPrivacyPolicy"],
    highlights: ["确定分析层策略"],
    worthMemory: true,
    worthKnowledge: true,
    isMeeting: false,
    storageTier: "important",
    confidence: 0.9,
    sourceEventCount: 3,
    inputHash: "hash-1",
    ...overrides
  });
  return sessionId;
}

function todayAt(hour: number, minute = 0): string {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), hour, minute, 0).toISOString();
}

