import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ACTIVITY_ANALYSIS_FAILED_SUMMARY,
  ACTIVITY_TRIVIAL_SUMMARY,
  analyzeActivitySession,
  analyzePendingActivitySessions,
  buildActivityReport,
  resolveActivityReportRange,
  type ActivityAnalyzerDeps
} from "../src/activity/analyzer.js";
import { ActivityPrivacyPolicy } from "../src/activity/privacyPolicy.js";
import { ActivityStore, type ActivitySessionAnalysis } from "../src/activity/store.js";
import type { ActivityDataResidency } from "../src/activity/settings.js";
import type { ActivityModelRuntime } from "../src/activity/types.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";

const NOW = new Date(2026, 7, 26, 15, 30, 0); // 本地 2026-08-26 15:30

const ANALYSIS_JSON = JSON.stringify({
  project: "biny",
  summary: "在 biny 仓库实现活动分析层",
  topics: ["实现 analyzer", "接入 activity_report 工具"],
  prs: [{ repo: "biny", number: 123, title: "Add analyzer" }],
  issues: [],
  people: ["@alice"],
  versions: ["v0.2.2"],
  decisions: ["改为主动拉取"],
  confidence: 0.8
});

await testTrivialSessionSkipsModel();
await testUnendedSessionSkipped();
await testAnalyzeThenCacheIsIdempotent();
await testPolicyBlocksExternalModel();
await testSweepRespectsAnalysisPolicyGate();
await testSweepRetriesAfterModelError();
await testAnalysisModelErrorKeepsPending();
await testParseFailureFallsBackToPlaceholder();
await testBuildReportGroupsAndFilters();
await testBuildReportAnalyzesPendingInRange();
await testBuildReportBlockedPolicy();
testReportRangeParsing();

/** 心跳/零星 session（事件数 < 阈值）不调用模型，直接落低置信度占位记录。 */
async function testTrivialSessionSkipsModel(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedEndedSession(
      store,
      todayAt(9),
      new Date(Date.parse(todayAt(9)) + 10_000).toISOString(),
      2
    );
    const { model, calls } = scriptedModel([ANALYSIS_JSON]);
    const outcome = await analyzeActivitySession(deps(store, localPolicy(), model), sessionId);
    assert.equal(outcome.status, "trivial");
    assert.equal(calls(), 0, "零星 session 不应调用模型");
    const stored = store.getAnalysis(sessionId);
    assert.equal(stored?.summary, ACTIVITY_TRIVIAL_SUMMARY);
    assert.equal(stored?.analyzerModel, "none");
    assert.equal(stored?.confidence, 0);
    assert.equal(stored?.sourceEventCount, 2);
  });
}

/** 尚未结束（进行中）的 session 不分析。 */
async function testUnendedSessionSkipped(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = store.startSession(todayAt(9));
    for (let index = 0; index < 3; index += 1) {
      store.recordEvent({
        sessionId,
        occurredAt: new Date(Date.parse(todayAt(9)) + index * 1_000).toISOString(),
        eventType: "focus_changed",
        application: "Test App",
        rawText: `event ${index}`
      });
    }
    const { model, calls } = scriptedModel([ANALYSIS_JSON]);
    const outcome = await analyzeActivitySession(deps(store, localPolicy(), model), sessionId);
    assert.equal(outcome.status, "skipped");
    assert.equal(outcome.status === "skipped" ? outcome.reason : undefined, "session_not_ended");
    assert.equal(calls(), 0);
    assert.equal(store.getAnalysis(sessionId), undefined);
  });
}

/** 正常分析：解析模型输出落库；输入未变时第二次直接命中缓存，不重复调用模型。 */
async function testAnalyzeThenCacheIsIdempotent(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const { model, calls } = scriptedModel([ANALYSIS_JSON]);
    const dependencies = deps(store, localPolicy(), model);

    const first = await analyzeActivitySession(dependencies, sessionId);
    assert.equal(first.status, "analyzed");
    assert.equal(first.status === "analyzed" ? first.cached : undefined, false);
    assert.equal(calls(), 1);
    const stored = store.getAnalysis(sessionId);
    assert.equal(stored?.project, "biny");
    assert.equal(stored?.summary, "在 biny 仓库实现活动分析层");
    assert.deepEqual(stored?.topics, ["实现 analyzer", "接入 activity_report 工具"]);
    assert.deepEqual(stored?.prs, [{ repo: "biny", number: 123, title: "Add analyzer" }]);
    assert.equal(stored?.analyzerModel, "analyzer-test-model");
    assert.equal(stored?.sourceEventCount, 3);
    assert.equal(stored?.confidence, 0.8);

    const second = await analyzeActivitySession(dependencies, sessionId);
    assert.equal(second.status, "analyzed");
    assert.equal(second.status === "analyzed" ? second.cached : undefined, true);
    assert.equal(calls(), 1, "输入未变应命中缓存");
  });
}

/** 外部模型 + local_only 策略：不分析、不落库，session 保持待分析。 */
async function testPolicyBlocksExternalModel(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const { model, calls } = scriptedModel([ANALYSIS_JSON], { runtime: "provider" });
    const policy = new ActivityPrivacyPolicy({ analysisPolicy: "local_only" });
    const outcome = await analyzeActivitySession(deps(store, policy, model), sessionId);
    assert.equal(outcome.status, "blocked");
    assert.equal(outcome.status === "blocked" ? outcome.decision.reason : undefined, "external_blocked");
    assert.equal(calls(), 0, "策略拒绝时模型不应被调用");
    assert.equal(store.getAnalysis(sessionId), undefined);
    assert.ok(store.listSessionsPendingAnalysis().some((session) => session.id === sessionId));
  });
}

/** 周期 sweep 触发路径同样过 analysisPolicy 门禁：被拦截的 session 不计入已分析、保持待分析。 */
async function testSweepRespectsAnalysisPolicyGate(): Promise<void> {
  await withStore(async (store) => {
    const first = seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const second = seedEndedSession(store, todayAt(11), todayAt(12), 3);
    const { model, calls } = scriptedModel([ANALYSIS_JSON], { runtime: "provider" });
    const policy = new ActivityPrivacyPolicy({ analysisPolicy: "local_only" });
    const result = await analyzePendingActivitySessions(deps(store, policy, model));
    assert.equal(result.evaluated, 2);
    assert.equal(result.blocked, 2, "门禁拦截应计入 blocked 而非 analyzed");
    assert.equal(result.analyzed, 0);
    assert.equal(calls(), 0, "策略拒绝时模型不应被调用");
    assert.equal(store.getAnalysis(first), undefined);
    assert.equal(store.getAnalysis(second), undefined);
    const pending = store.listSessionsPendingAnalysis();
    assert.equal(pending.length, 2, "被拦截的 session 保持待分析，供策略放开后的下一轮 sweep 补");
  });
}

/** sweep 的自然重试：模型瞬时失败保持 pending，不消耗 attempt，下一轮 sweep 恢复后补上。 */
async function testSweepRetriesAfterModelError(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const failing = scriptedModel([new Error("boom")]);
    const first = await analyzePendingActivitySessions(deps(store, localPolicy(), failing.model));
    assert.equal(first.evaluated, 1);
    assert.equal(first.errors, 1);
    assert.equal(first.analyzed, 0);
    assert.equal(store.getAnalysis(sessionId), undefined, "失败不落库，session 保持待分析");

    const recovering = scriptedModel([ANALYSIS_JSON]);
    const second = await analyzePendingActivitySessions(deps(store, localPolicy(), recovering.model));
    assert.equal(second.errors, 0);
    assert.equal(second.analyzed, 1);
    assert.ok(store.getAnalysis(sessionId), "下一轮 sweep 自然重试成功");
  });
}

/** 模型/网络瞬时失败：返回 error 且不落库，session 留给下一周期重试。 */
async function testAnalysisModelErrorKeepsPending(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const { model, calls } = scriptedModel([new Error("boom")]);
    const outcome = await analyzeActivitySession(deps(store, localPolicy(), model), sessionId);
    assert.equal(outcome.status, "error");
    assert.equal(outcome.status === "error" ? outcome.error : undefined, "boom");
    assert.equal(calls(), 1);
    assert.equal(store.getAnalysis(sessionId), undefined);
  });
}

/** 两次输出都无法解析时落「活动分析失败」占位（confidence 0），仍算已处理、不反复重试。 */
async function testParseFailureFallsBackToPlaceholder(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const { model, calls } = scriptedModel(["not json", "still not json"]);
    const outcome = await analyzeActivitySession(deps(store, localPolicy(), model), sessionId);
    assert.equal(outcome.status, "analyzed");
    assert.equal(calls(), 2, "解析失败重试一次后落占位");
    assert.equal(store.getAnalysis(sessionId)?.summary, ACTIVITY_ANALYSIS_FAILED_SUMMARY);
    assert.equal(store.getAnalysis(sessionId)?.confidence, 0);
  });
}

/** 报告按项目分组渲染，过滤零星/失败占位，且只取目标日期的 session。渲染本身不调用模型。 */
async function testBuildReportGroupsAndFilters(): Promise<void> {
  await withStore(async (store) => {
    const a = seedEndedSession(store, todayAt(9), todayAt(10), 1);
    const b = seedEndedSession(store, todayAt(11), todayAt(12), 1);
    const c = seedEndedSession(store, todayAt(13), todayAt(14), 1);
    const d = seedEndedSession(store, todayAt(14), todayAt(15), 1);
    const e = seedEndedSession(store, yesterdayAt(9), yesterdayAt(10), 1);
    store.recordAnalysis(analysisRow(a, {
      project: "biny",
      topics: ["实现 analyzer"],
      prs: [{ repo: "biny", number: 123, title: "Add analyzer" }],
      confidence: 0.9
    }));
    store.recordAnalysis(analysisRow(b, { summary: ACTIVITY_TRIVIAL_SUMMARY, analyzerModel: "none", confidence: 0 }));
    store.recordAnalysis(analysisRow(c, { summary: ACTIVITY_ANALYSIS_FAILED_SUMMARY, confidence: 0 }));
    store.recordAnalysis(analysisRow(d, { project: "biny", topics: ["接入 activity_report"], confidence: 0.7 }));
    store.recordAnalysis(analysisRow(e, { project: "side", topics: ["昨日任务"], confidence: 0.8 }));

    const { model, calls } = scriptedModel([ANALYSIS_JSON]);
    const result = await buildActivityReport(deps(store, localPolicy(), model), "today");
    assert.equal(result.sessionCount, 2, "只统计可入报告的 session（过滤占位）");
    assert.equal(result.blocked, false);
    assert.equal(result.analyzedNow, 0, "范围内没有待分析 session");
    assert.equal(calls(), 0, "已有分析结果时渲染不再调用模型");
    assert.match(result.markdown, /## 2026-08-26 工作日记/u);
    assert.match(result.markdown, /### biny/u);
    assert.ok(result.markdown.includes("- 实现 analyzer"));
    assert.ok(result.markdown.includes("- PR biny#123 Add analyzer"));
    assert.ok(result.markdown.includes("- 接入 activity_report"));
    assert.ok(!result.markdown.includes(ACTIVITY_TRIVIAL_SUMMARY), "零星占位不进报告");
    assert.ok(!result.markdown.includes(ACTIVITY_ANALYSIS_FAILED_SUMMARY), "失败占位不进报告");
    assert.ok(!result.markdown.includes("昨日任务"), "其它日期的 session 不进当天报告");
  });
}

/** 报告会先补分析范围内「已结束但没分析」的 session，再渲染。 */
async function testBuildReportAnalyzesPendingInRange(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const { model, calls } = scriptedModel([ANALYSIS_JSON]);
    const result = await buildActivityReport(deps(store, localPolicy(), model), "today");
    assert.equal(result.analyzedNow, 1);
    assert.equal(result.sessionCount, 1);
    assert.equal(calls(), 1);
    assert.ok(store.getAnalysis(sessionId));
    assert.ok(result.markdown.includes("实现 analyzer"));
  });
}

/** 范围内的待分析 session 因策略被拦截时：报告只渲染已分析部分并说明原因。 */
async function testBuildReportBlockedPolicy(): Promise<void> {
  await withStore(async (store) => {
    seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const { model, calls } = scriptedModel([ANALYSIS_JSON], { runtime: "provider" });
    const policy = new ActivityPrivacyPolicy({ analysisPolicy: "local_only" });
    const result = await buildActivityReport(deps(store, policy, model), "today");
    assert.equal(result.blocked, true);
    assert.equal(result.pendingModel, 1);
    assert.ok(result.message);
    assert.equal(result.sessionCount, 0);
    assert.equal(calls(), 0);
    assert.ok(result.markdown.includes("没有已分析的活动记录"));
  });
}

function testReportRangeParsing(): void {
  const today = resolveActivityReportRange("today", NOW);
  assert.equal(today.label, "2026-08-26");
  assert.equal(new Date(today.startIso).getHours(), 0, "start 应落在本地零点");
  assert.ok(today.startIso < today.endIso);

  const yesterday = resolveActivityReportRange("yesterday", NOW);
  assert.equal(yesterday.label, "2026-08-25");

  const explicit = resolveActivityReportRange("2026-08-01", NOW);
  assert.equal(explicit.label, "2026-08-01");
  assert.equal(new Date(explicit.startIso).getHours(), 0);

  assert.throws(() => resolveActivityReportRange("last week", NOW), /无法识别/u);
  // Date 构造对越界日期会进位（2026-02-31 → 3 月 3 日）而非报错，必须按无效输入拒绝。
  assert.throws(() => resolveActivityReportRange("2026-02-29", NOW), /无效日期/u);
  assert.throws(() => resolveActivityReportRange("2026-02-31", NOW), /无效日期/u);
  assert.throws(() => resolveActivityReportRange("2026-13-01", NOW), /无效日期/u);
  const leapDay = resolveActivityReportRange("2028-02-29", NOW);
  assert.equal(leapDay.label, "2028-02-29", "真正的闰日仍应解析成功");
}

function localPolicy(): ActivityPrivacyPolicy {
  return new ActivityPrivacyPolicy();
}

function deps(store: ActivityStore, policy: ActivityPrivacyPolicy, model?: AgentModel): ActivityAnalyzerDeps {
  return { store, policy, model, now: () => new Date(NOW.getTime()) };
}

/** 本地某时刻的 ISO；同一本地日历日，必然落在 resolveActivityReportRange("today") 的 [start,end) 内。 */
function todayAt(hour: number): string {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), hour, 0, 0).toISOString();
}

function yesterdayAt(hour: number): string {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1, hour, 0, 0).toISOString();
}

/** 建立一条已结束 session 并写入 eventCount 条事件；store 会据此生成脱敏 summary。 */
function seedEndedSession(store: ActivityStore, startedAt: string, endedAt: string, eventCount: number): string {
  const sessionId = store.startSession(startedAt);
  const startMs = Date.parse(startedAt);
  for (let index = 0; index < eventCount; index += 1) {
    store.recordEvent({
      sessionId,
      occurredAt: new Date(startMs + index * 1_000).toISOString(),
      eventType: "focus_changed",
      application: "Test App",
      rawText: `Test App event ${index}`
    });
  }
  store.endSession(sessionId, endedAt);
  return sessionId;
}

function analysisRow(sessionId: string, overrides: Partial<ActivitySessionAnalysis> = {}): ActivitySessionAnalysis {
  return {
    sessionId,
    analyzedAt: todayAt(23),
    analyzerModel: "analyzer-test-model",
    project: undefined,
    summary: "做了些事",
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
    confidence: 0.5,
    sourceEventCount: 1,
    inputHash: `hash-${sessionId}`,
    ...overrides
  };
}

/** 受控的分析模型：按脚本逐次吐出 JSON 文本或错误，并记录被调用次数。 */
function scriptedModel(
  script: Array<string | Error>,
  identity: { runtime?: ActivityModelRuntime; dataResidency?: ActivityDataResidency } = {}
): { model: AgentModel; calls: () => number } {
  let calls = 0;
  const model: AgentModel = {
    provider: "test",
    modelId: "analyzer-test-model",
    runtime: identity.runtime ?? "builtin-llama.cpp",
    dataResidency: identity.dataResidency ?? "local",
    stream: async () => {
      calls += 1;
      const next = script.length > 0 ? script.shift()! : "{}";
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (next instanceof Error) {
          yield { type: "error", error: next };
          return;
        }
        yield { type: "text-delta", text: next };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
  return { model, calls: () => calls };
}

async function withStore(run: (store: ActivityStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-analyzer-"));
  const store = new ActivityStore();
  try {
    await store.open(root);
    await run(store);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}
