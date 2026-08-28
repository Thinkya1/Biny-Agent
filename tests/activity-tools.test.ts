/**
 * P2/P3 工具层测试：activity_digest / activity_search / activity_sessions
 * 的渲染与执行；activity_report 的按日缓存（同一天重复提问不重复
 * 补分析、TTL 过期后重新生成）。
 *
 * 全部走「真实 ActivityStore + 临时目录 + 注入时钟」；模型只用于 report 补分析，
 * 用 scriptedModel 控制输出并记录调用次数。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createActivityDigestTool } from "../src/tools/activity/digest.js";
import { createActivitySearchTool } from "../src/tools/activity/search.js";
import { createActivityReportTool, createInMemoryActivityReportCache } from "../src/tools/activity/report.js";
import { createActivitySessionsTool } from "../src/tools/activity/sessions.js";
import { ActivityStore, type ActivitySessionAnalysis } from "../src/activity/store.js";
import { defaultActivitySettings, type ActivitySettings } from "../src/activity/settings.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import type { ActivityModelRuntime, ActivityDataResidency } from "../src/activity/types.js";
import type { Tool } from "../src/tools/types.js";

const NOW = new Date(2026, 7, 26, 15, 30, 0); // 本地 2026-08-26 15:30

const ANALYSIS_JSON_NEW_SESSION = JSON.stringify({
  project: "biny",
  summary: "下午的收尾",
  topics: ["新会话主题"],
  confidence: 0.6
});

const ANALYSIS_JSON = JSON.stringify({
  project: "biny",
  summary: "在 biny 仓库实现活动分析层",
  topics: ["实现 analyzer", "接入 activity 工具"],
  prs: [{ repo: "biny", number: 123, title: "Add analyzer" }],
  decisions: ["改为主动拉取"],
  worthMemory: true,
  confidence: 0.8
});

await testDigestRendersTimelineWithUnanalyzedSessions();
await testKeywordSearchToolHitsRedactedSummaries();
await testSessionsAndShowTools();
await testReportToolCachesSameDayWithoutReanalysis();
await testReportCacheExpiresAfterTtl();
await testReportCacheInMemoryBehavior();

/** digest：窗口内 session 渲染成 旧→新 时间线；未分析 session 退化展示事件摘要并标注。 */
async function testDigestRendersTimelineWithUnanalyzedSessions(): Promise<void> {
  await withStore(async (store, root) => {
    const analyzed = seedEndedSession(store, todayAt(14, 0), todayAt(14, 30), 3);
    seedEndedSession(store, todayAt(13, 0), todayAt(13, 30), 3);
    store.recordAnalysis(analysisRow(analyzed, { project: "biny", topics: ["实现 analyzer"] }));

    const tool = createActivityDigestTool({
      loadSettings: async () => settingsFor(root),
      now: () => new Date(NOW.getTime())
    });
    const markdown = await executeTool(tool, {});
    assert.match(markdown, /## 近期活动摘要/u);
    assert.ok(markdown.includes("实现 analyzer"), "已分析 session 显示 topics");
    assert.ok(markdown.includes("未分析"), "未分析 session 明确标注");
  });
}

/** activity_search：FTS5 关键词命中脱敏后的事件摘要；敏感原文不进结果。 */
async function testKeywordSearchToolHitsRedactedSummaries(): Promise<void> {
  await withStore(async (store, root) => {
    seedEndedSession(store, todayAt(10, 0), todayAt(10, 30), 3);
    const tool = createActivitySearchTool({ loadSettings: async () => settingsFor(root) });
    const markdown = await executeTool(tool, { query: "Test App" });
    assert.match(markdown, /## activity_search: Test App/u);
    assert.match(markdown, /Test App event/u);
    assert.ok(!markdown.includes("window-secret"), "脱敏原文不应出现在结果里");
  });
}

/** activity_sessions 双模式：无参列表带分析；带 sessionId 展开事件时间线与分析。 */
async function testSessionsAndShowTools(): Promise<void> {
  await withStore(async (store, root) => {
    const sessionId = seedEndedSession(store, todayAt(9, 0), todayAt(10, 0), 3);
    store.recordAnalysis(analysisRow(sessionId, { project: "biny", topics: ["接入工具"], decisions: ["走工具"] }));

    const sessionsTool = createActivitySessionsTool({ loadSettings: async () => settingsFor(root) });
    const list = await executeTool(sessionsTool, {});
    assert.match(list, /## 最近的活动会话/u);
    assert.ok(list.includes(sessionId), "列表带 session id 供下一步打开");
    assert.ok(list.includes("接入工具"));

    const detail = await executeTool(sessionsTool, { sessionId });
    assert.match(detail, /## 会话/u);
    assert.ok(detail.includes(sessionId));
    assert.ok(detail.includes("事件时间线"));
    assert.ok(detail.includes("接入工具") || detail.includes("走工具"));

    const missing = await executeTool(sessionsTool, { sessionId: "no-such-session" });
    assert.match(missing, /没有找到会话/u);
  });
}

/** report 短 TTL 缓存：同一天连续两次调用只补一次分析（模型调用不增加），结果一致。 */
async function testReportToolCachesSameDayWithoutReanalysis(): Promise<void> {
  await withStore(async (store, root) => {
    seedEndedSession(store, todayAt(9, 0), todayAt(10, 0), 3);
    const cache = createInMemoryActivityReportCache(60_000);
    const { model, calls } = scriptedModel([ANALYSIS_JSON]);
    const tool = createActivityReportTool({
      getModel: () => model,
      loadSettings: async () => settingsFor(root),
      cache,
      now: () => new Date(NOW.getTime())
    });
    const first = await executeTool(tool, {});
    const second = await executeTool(tool, {});
    assert.equal(calls(), 1, "TTL 内不得重复补分析");
    assert.equal(first, second, "同一自然日缓存命中返回相同报告");
    assert.match(first, /## 2026-08-26 工作日记/u);
    assert.match(first, /### biny/u);
  });
}

/** TTL 过期后同一日期重新补分析：新结束的 session 会被纳入第二次报告。 */
async function testReportCacheExpiresAfterTtl(): Promise<void> {
  await withStore(async (store, root) => {
    seedEndedSession(store, todayAt(9, 0), todayAt(10, 0), 3);
    const cache = createInMemoryActivityReportCache(0); // 立即过期
    const { model, calls } = scriptedModel([ANALYSIS_JSON, ANALYSIS_JSON_NEW_SESSION]);
    const tool = createActivityReportTool({
      getModel: () => model,
      loadSettings: async () => settingsFor(root),
      cache,
      now: () => new Date(NOW.getTime())
    });
    await executeTool(tool, {});
    assert.equal(calls(), 1);
    // TTL 窗口外又有新 session 结束；缓存已失效，第二次调用应重新补分析并纳入它。
    seedEndedSession(store, todayAt(11, 0), todayAt(12, 0), 3);
    const second = await executeTool(tool, {});
    assert.equal(calls(), 2, "缓存过期后应重新跑补分析");
    assert.ok(second.includes("新会话主题"), "新 session 的分析进入第二次报告，而非命中旧缓存");
  });
}

/** 默认内存缓存自身的 get/set/TTL 语义。 */
async function testReportCacheInMemoryBehavior(): Promise<void> {
  const cache = createInMemoryActivityReportCache(60_000);
  assert.equal(cache.get("2026-08-26"), undefined, "未写入时 miss");
  const result = {
    date: "2026-08-26",
    startIso: "",
    endIso: "",
    markdown: "## 2026-08-26 工作日记\n\n（占位）",
    sessionCount: 0,
    analyzedNow: 0,
    pendingModel: 0,
    blocked: false
  };
  cache.set("2026-08-26", result);
  assert.equal(cache.get("2026-08-26"), result, "写入后命中同一对象");
  const ttlZero = createInMemoryActivityReportCache(0);
  ttlZero.set("yesterday", result);
  assert.equal(ttlZero.get("yesterday"), undefined, "TTL=0 视为立即失效");
}

function settingsFor(root: string): Promise<ActivitySettings> {
  return Promise.resolve({ ...defaultActivitySettings, outputDirectory: root });
}

async function withStore(run: (store: ActivityStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-tools-"));
  const store = new ActivityStore();
  try {
    await store.open(root);
    await run(store, root);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function todayAt(hour: number, minute: number): string {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), hour, minute, 0).toISOString();
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
      windowTitle: "token=window-secret",
      rawText: `Test App event ${index}`
    });
  }
  store.endSession(sessionId, endedAt);
  return sessionId;
}

function analysisRow(sessionId: string, overrides: Partial<ActivitySessionAnalysis> = {}): ActivitySessionAnalysis {
  return {
    sessionId,
    analyzedAt: todayAt(10, 0),
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

/** 执行工具（字符串结果），封装 resolveExecution 的 union。 */
async function executeTool<TArgs>(tool: Tool<TArgs, string>, args: TArgs): Promise<string> {
  const execution = await tool.resolveExecution(args);
  if ("isError" in execution) throw new Error(execution.errorMessage);
  return await execution.execute({ toolCallId: "test-tool", operationId: "test-op" });
}
