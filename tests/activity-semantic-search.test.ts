/**
 * P3 语义检索测试：searchActivitySemantic 用本地嵌入补 analysis 行向量 + cosine top N；
 * 本地嵌入不可用时返回友好降级（ok=false, no_runtime），由工具层引导回退关键词检索。
 *
 * 用 fake EmbeddingModelRuntime 提供确定性向量：不依赖任何下载/网络。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { searchActivitySemantic } from "../src/activity/semanticSearch.js";
import { ActivityStore, type ActivitySessionAnalysis } from "../src/activity/store.js";
import type { EmbeddingModelRuntime, EmbeddingResult } from "../src/llm/embedding/types.js";

const FINGERPRINT = "test-fingerprint";
const NOW = new Date(2026, 7, 26, 15, 0, 0);

await testSemanticSearchEmbedsAndRanks();
await testSemanticSearchFallsBackWhenNoRuntime();
await testSemanticSearchExcludesPlaceholderSessions();
await testSemanticSearchSkipsTrivialSessionsInBackfill();
await testSemanticSearchToleratesPassageBatchFailure();
await testSemanticSearchKeepsExistingVectorsWhenBatchFails();

/** 语义检索：补嵌入缺失向量 → 查询向量 → cosine top N 命中相关 session。 */
async function testSemanticSearchEmbedsAndRanks(): Promise<void> {
  await withStore(async (store) => {
    const login = seedAnalyzedSession(store, todayAt(9), {
      summary: "修复登录崩溃",
      topics: ["登录", "auth"],
      highlights: ["定位到 token 过期"],
      project: "biny",
      sourceEventCount: 5
    });
    seedAnalyzedSession(store, todayAt(11), {
      summary: "写公众号文章",
      topics: ["写作", "文章"],
      sourceEventCount: 5
    });
    const runtime = ruleRuntime([
      { match: /修复登录|登录/u, vector: vec([1, 0, 0, 0]) },
      { match: /写文章/u, vector: vec([0, 0, 1, 0]) }
    ]);

    const hit = await searchActivitySemantic({
      store,
      getEmbeddingRuntime: async () => runtime,
      query: "修复登录",
      limit: 3,
      now: () => new Date()
    });
    assert.equal(hit.ok, true);
    if (!hit.ok) return;
    assert.equal(hit.embedded, 2, "两个缺失向量的 analysis 行都应补嵌入");
    assert.equal(hit.hits.length, 1, "相似度 > 0 的才上榜");
    assert.equal(hit.hits[0]?.sessionId, login);
    assert.ok(hit.hits[0]!.similarity > 0.9);
    assert.equal(hit.hits[0]!.project, "biny");
  });
}

/** 嵌入运行时不可用 → ok:false + no_runtime，不抛错。 */
async function testSemanticSearchFallsBackWhenNoRuntime(): Promise<void> {
  await withStore(async (store) => {
    seedAnalyzedSession(store, todayAt(9), { summary: "修复登录崩溃", sourceEventCount: 5 });
    const result = await searchActivitySemantic({
      store,
      getEmbeddingRuntime: async () => undefined,
      query: "登录"
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "no_runtime");
    assert.match(result.message, /activity_search/u);
  });
}

/** 占位摘要（零星/失败）不进嵌入清单，也不会变成可检索命中。 */
async function testSemanticSearchExcludesPlaceholderSessions(): Promise<void> {
  await withStore(async (store) => {
    seedAnalyzedSession(store, todayAt(9), { summary: "零星活动", sourceEventCount: 1 });
    seedAnalyzedSession(store, todayAt(10), { summary: "活动分析失败", sourceEventCount: 5 });
    const runtime = ruleRuntime([{ match: /登录/u, vector: vec([1, 0, 0, 0]) }]);
    const result = await searchActivitySemantic({
      store,
      getEmbeddingRuntime: async () => runtime,
      query: "登录"
    });
    // 只有占位行时没有可检索的向量：返回友好提示（no_vectors），由工具层引导
    // 模型回退关键词 activity_search；占位行绝不进入嵌入清单或命中集合。
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "no_vectors");
    assert.match(result.message, /可检索/u);
    assert.equal(store.listAnalysisEmbeddingRows(FINGERPRINT).length, 0, "占位行没有被写入向量表");
  });
}

/** 缺向量补嵌入（backfill）跳过 source_event_count < 3 的心跳行。 */
async function testSemanticSearchSkipsTrivialSessionsInBackfill(): Promise<void> {
  await withStore(async (store) => {
    seedAnalyzedSession(store, todayAt(9), { summary: "闪了一下", sourceEventCount: 2 });
    const real = seedAnalyzedSession(store, todayAt(10), { summary: "修 bug", sourceEventCount: 5 });
    const runtime = ruleRuntime([{ match: /修 bug/u, vector: vec([1, 0, 0, 0]) }]);
    const result = await searchActivitySemantic({
      store,
      getEmbeddingRuntime: async () => runtime,
      query: "修 bug"
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.embedded, 1, "只补真实行的向量");
    assert.deepEqual(result.hits.map((hit) => hit.sessionId), [real]);
  });
}

/** passage 批次嵌入失败不穿透：没有任何可用向量时友好返回 ok:false，而不是把异常抛给工具层。 */
async function testSemanticSearchToleratesPassageBatchFailure(): Promise<void> {
  await withStore(async (store) => {
    seedAnalyzedSession(store, todayAt(9), { summary: "修复登录崩溃", sourceEventCount: 5 });
    const runtime = failingPassageRuntime([{ match: /登录/u, vector: vec([1, 0, 0, 0]) }]);
    const result = await searchActivitySemantic({
      store,
      getEmbeddingRuntime: async () => runtime,
      query: "登录"
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "no_vectors");
  });
}

/** 批次失败只跳过本批：已有向量继续参与检索，缺的行仍待下次补嵌入。 */
async function testSemanticSearchKeepsExistingVectorsWhenBatchFails(): Promise<void> {
  await withStore(async (store) => {
    const login = seedAnalyzedSession(store, todayAt(9), {
      summary: "修复登录崩溃",
      topics: ["登录", "auth"],
      sourceEventCount: 5
    });
    const healthy = ruleRuntime([{ match: /登录/u, vector: vec([1, 0, 0, 0]) }]);
    const first = await searchActivitySemantic({
      store,
      getEmbeddingRuntime: async () => healthy,
      query: "登录"
    });
    assert.equal(first.ok, true, "先在健康运行时下写入旧向量");

    seedAnalyzedSession(store, todayAt(11), { summary: "写公众号文章", sourceEventCount: 5 });
    const degraded = failingPassageRuntime([{ match: /登录/u, vector: vec([1, 0, 0, 0]) }]);
    const second = await searchActivitySemantic({
      store,
      getEmbeddingRuntime: async () => degraded,
      query: "登录"
    });
    assert.equal(second.ok, true, "新批次失败不应拖垮整体检索");
    if (!second.ok) return;
    assert.equal(second.embedded, 0, "失败批次不计入新嵌入数");
    assert.deepEqual(second.hits.map((hit) => hit.sessionId), [login], "已有向量仍可命中");
    assert.equal(store.listAnalysisEmbeddingSources(FINGERPRINT).length, 1, "失败批次的行仍缺向量，留给下次补");
  });
}

/** passage 嵌入必失败、query 按规则返回的 fake 运行时：验证批次失败被容错而非穿透。 */
function failingPassageRuntime(rules: ReadonlyArray<{ match: RegExp; vector: Float32Array }>): EmbeddingModelRuntime {
  const base = ruleRuntime(rules);
  return {
    ...base,
    embed: async (request) => {
      if (request.inputType === "passage") throw new Error("embedding backend offline");
      return await base.embed(request);
    }
  };
}

// —— helpers ——

function vec(value: readonly number[]): Float32Array {
  return new Float32Array(value);
}

/** 按规则匹配文本的 fake 嵌入运行时：命中最先匹配的规则取向量，缺省 0 向量（不相似）。 */
function ruleRuntime(rules: ReadonlyArray<{ match: RegExp; vector: Float32Array }>): EmbeddingModelRuntime {
  return {
    fingerprint: FINGERPRINT,
    descriptor: {
      ref: { kind: "local", model: "multilingual-e5-small" },
      fingerprint: FINGERPRINT,
      displayName: "test-embedder",
      dimensions: 4,
      recommendedThresholds: { currentWorkspace: 0.3, crossWorkspace: 0.2 },
      source: "local",
      available: true,
      installed: true
    },
    async embed(request: { texts: readonly string[]; inputType: "query" | "passage" }): Promise<EmbeddingResult> {
      return {
        embeddings: request.texts.map((text) => {
          const rule = rules.find((candidate) => candidate.match.test(text));
          return rule?.vector ?? new Float32Array(4);
        }),
        dimensions: 4,
        fingerprint: FINGERPRINT,
        model: { kind: "local", model: "multilingual-e5-small" }
      };
    }
  };
}

async function withStore(run: (store: ActivityStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-semantic-"));
  const store = new ActivityStore();
  try {
    await store.open(root);
    await run(store);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function todayAt(hour: number): string {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), hour, 0, 0).toISOString();
}

function seedAnalyzedSession(store: ActivityStore, startedAtIso: string, overrides: Partial<ActivitySessionAnalysis> = {}): string {
  const sessionId = store.startSession(startedAtIso);
  const startMs = Date.parse(startedAtIso);
  for (let index = 0; index < 3; index += 1) {
    store.recordEvent({
      sessionId,
      occurredAt: new Date(startMs + index * 1_000).toISOString(),
      eventType: "focus_changed",
      application: "Test App",
      rawText: `Test App event ${index}`
    });
  }
  store.endSession(sessionId, new Date(Date.parse(startedAtIso) + 60 * 60 * 1_000).toISOString());
  store.recordAnalysis({
    sessionId,
    analyzedAt: todayAt(12),
    analyzerModel: "analyzer-test-model",
    project: "side",
    summary: "修了点东西",
    topics: [],
    prs: [],
    issues: [],
    people: [],
    versions: [],
    decisions: [],
    entities: [],
    highlights: [],
    worthMemory: false,
    worthKnowledge: false,
    isMeeting: false,
    storageTier: "standard",
    confidence: 0.7,
    sourceEventCount: 3,
    inputHash: `hash-${sessionId}`,
    ...overrides
  });
  return sessionId;
}
