/**
 * chat-dsh 纯函数测试：工具行模型（变体/状态）、指标格式化（token/时长/时钟/吞吐）、
 * 轮次指标派生，以及 sessionTimeline 的 TTFT/解码指标与压缩标记。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  classifyTool,
  firstLine,
  formatDuration,
  formatLatencySeconds,
  formatMessageClock,
  formatRunDuration,
  formatTokens,
  formatTokensPerSecond,
  toolRowState,
  turnMetrics,
  VARIANT_TITLES,
} from "../src/desktop/renderer/src/chatDshModel.js";
import {
  buildSessionTimeline,
  type TimelineTool,
} from "../src/desktop/renderer/src/sessionTimeline.js";
import { MarkdownContent } from "../src/desktop/renderer/src/components/MarkdownContent.js";

test("classifyTool 把已知工具分类到对应变体", () => {
  assert.equal(classifyTool("run_command"), "bash");
  assert.equal(classifyTool("read_file"), "read");
  assert.equal(classifyTool("web_fetch"), "read");
  assert.equal(classifyTool("web_search"), "search");
  assert.equal(classifyTool("grep_search"), "search");
  assert.equal(classifyTool("write_file"), "write");
  assert.equal(classifyTool("edit_file"), "edit");
  assert.equal(classifyTool("git_diff"), "git");
  assert.equal(classifyTool("start_process"), "process");
  assert.equal(classifyTool("invoke_skill"), "skill");
  assert.equal(classifyTool("unknown_tool"), "others");
});
test("VARIANT_TITLES 使用 DSH figma 字面量", () => {
  assert.equal(VARIANT_TITLES.bash, "Bash");
  assert.equal(VARIANT_TITLES.search, "Search");
  assert.equal(VARIANT_TITLES.read, "Read");
  assert.equal(VARIANT_TITLES.others, "Tool call");
});

test("toolRowState 从时间线状态派生行状态语义", () => {
  const base: TimelineTool = { id: "t1", tool: "run_command", args: {}, status: "waiting", updates: [] };
  assert.equal(toolRowState({ ...base, status: "running" }), "running");
  assert.equal(toolRowState({ ...base, status: "success" }), "ok");
  assert.equal(toolRowState({ ...base, status: "skipped" }), "ok");
  assert.equal(toolRowState({ ...base, status: "failed" }), "error");
  assert.equal(toolRowState({ ...base, status: "denied" }), "error");
  assert.equal(toolRowState({ ...base, status: "unknown" }), "error");
  assert.equal(toolRowState({ ...base, status: "cancelled" }), "stopped");
  assert.equal(toolRowState({ ...base, status: "aborted" }), "stopped");
});

test("firstLine 取首行，无换行时原样返回", () => {
  assert.equal(firstLine("error: boom"), "error: boom");
  assert.equal(firstLine("line1\nline2\n"), "line1");
});

test("行内路径保持灰色代码样式且不触发文件预览", () => {
  let previews = 0;
  const markup = renderToStaticMarkup(createElement(MarkdownContent, {
    content: "`agent.config.json:16` 与 `.agent/skills`",
    projectId: "project-1",
    onPreviewFile: () => { previews += 1; },
    onOpenExternal: () => undefined
  }));
  assert.match(markup, /<code>agent\.config\.json:16<\/code>/u);
  assert.match(markup, /<code>\.agent\/skills<\/code>/u);
  assert.doesNotMatch(markup, /inline-path|在右侧预览/u);
  assert.equal(previews, 0);
});

test("formatTokens 紧凑计数", () => {
  assert.equal(formatTokens(517), "517");
  assert.equal(formatTokens(12_345), "12.3K");
  assert.equal(formatTokens(517_000), "517K");
  assert.equal(formatTokens(1_234_567), "1.2M");
});

test("formatDuration / formatRunDuration 紧凑时长", () => {
  assert.equal(formatDuration(45_200), "45.2s");
  assert.equal(formatDuration(162_000), "2m42s");
  assert.equal(formatRunDuration(15_000), "15s");
  assert.equal(formatRunDuration(125_000), "2m05s");
});

test("formatLatencySeconds / formatTokensPerSecond 数字格式化", () => {
  assert.equal(formatLatencySeconds(1_200), "1.2");
  assert.equal(formatLatencySeconds(12_000), "12");
  assert.equal(formatTokensPerSecond(34.2), "34");
  assert.equal(formatTokensPerSecond(3.42), "3.4");
});

test("formatMessageClock 当天 HH:mm、今年 M/D、跨年 Y/M/D", () => {
  const now = new Date(2026, 4, 15, 12, 0, 0).getTime();
  const sameDay = new Date(2026, 4, 15, 9, 5).getTime();
  assert.equal(formatMessageClock(sameDay, now), "09:05");
  const sameYear = new Date(2026, 1, 3, 9, 5).getTime();
  assert.equal(formatMessageClock(sameYear, now), "2/3 09:05");
  const otherYear = new Date(2024, 11, 31, 23, 59).getTime();
  assert.equal(formatMessageClock(otherYear, now), "2024/12/31 23:59");
});

test("turnMetrics 只输出数据齐全的指标", () => {
  assert.deepEqual(turnMetrics({ id: "t", user: "", assistant: "", reasoning: "", skills: [], status: "completed", tools: [], steps: [] }), {});
  assert.deepEqual(
    turnMetrics({
      id: "t", user: "", assistant: "", reasoning: "", skills: [], status: "completed",
      tools: [], steps: [], ttftMs: 1_500, decodeMs: 30_000, decodeTokens: 1_020,
    }),
    { ttftMs: 1_500, tokensPerSecond: 34, llmMs: 31_500 },
  );
  assert.deepEqual(
    turnMetrics({
      id: "t", user: "", assistant: "", reasoning: "", skills: [], status: "completed",
      tools: [], steps: [], ttftMs: 1_500,
    }),
    { ttftMs: 1_500 },
  );
});

test("实时轮次在终态结算 TTFT / 解码指标", () => {
  const base = { sessionId: "s1", runId: "r1" };
  const startedAt = "2026-05-15T10:00:00.000Z";
  const firstTokenAt = "2026-05-15T10:00:01.500Z";
  const doneAt = "2026-05-15T10:00:45.000Z";
  const timeline = buildSessionTimeline([], [
    { ...base, type: "message.user", timestamp: startedAt, messageId: "m1", content: "你好" },
    { ...base, type: "run.started", timestamp: startedAt, messageId: "m1", input: "你好", mode: "normal", model: { alias: "a", provider: "p", label: "p/m", reasoning: "" }, skills: [] },
    { ...base, type: "reasoning.delta", timestamp: firstTokenAt, content: "思考中" },
    {
      ...base,
      type: "run.completed",
      timestamp: doneAt,
      durationMs: 45_000,
      usage: { operation: "turn", modelAlias: "a", provider: "p", model: "m", outputTokens: 1_020, pricingKnown: false },
    },
  ]);
  const turn = timeline[0];
  assert.ok(turn);
  assert.equal(turn.ttftMs, 1_500);
  assert.equal(turn.decodeMs, 43_500);
  assert.equal(turn.decodeTokens, 1_020);
});

test("首个输出增量决定 TTFT 分子", () => {
  const base = { sessionId: "s1", runId: "r1" };
  const startedAt = "2026-05-15T10:00:00.000Z";
  const firstDeltaAt = "2026-05-15T10:00:00.800Z";
  const timeline = buildSessionTimeline([], [
    { ...base, type: "message.user", timestamp: startedAt, messageId: "m1", content: "你好" },
    { ...base, type: "run.started", timestamp: startedAt, messageId: "m1", input: "你好", mode: "normal", model: { alias: "a", provider: "p", label: "p/m", reasoning: "" }, skills: [] },
    { ...base, type: "assistant.delta", timestamp: firstDeltaAt, content: "好的" },
    { ...base, type: "assistant.delta", timestamp: "2026-05-15T10:00:02.000Z", content: "，马上" },
    { ...base, type: "run.completed", timestamp: "2026-05-15T10:00:05.000Z", durationMs: 5_000 },
  ]);
  const turn = timeline[0];
  assert.ok(turn);
  assert.equal(turn.ttftMs, 800);
});

test("context.retrying 步骤带压缩标记且文案不带前缀", () => {
  const base = { sessionId: "s1", runId: "r1" };
  const timeline = buildSessionTimeline([], [
    { ...base, type: "message.user", timestamp: "2026-05-15T10:00:00.000Z", messageId: "m1", content: "你好" },
    { ...base, type: "run.started", timestamp: "2026-05-15T10:00:00.000Z", messageId: "m1", input: "你好", mode: "normal", model: { alias: "a", provider: "p", label: "p/m", reasoning: "" }, skills: [] },
    { ...base, type: "context.retrying", timestamp: "2026-05-15T10:00:01.000Z", reason: "context full", attempt: 1, compactedMessages: 12 },
  ]);
  const turn = timeline[0];
  assert.ok(turn);
  const step = turn.steps.find((candidate) => candidate.kind === "reasoning");
  assert.ok(step && step.kind === "reasoning");
  assert.equal(step.notice, "compaction");
  assert.equal(step.status, "已压缩 12 条消息，正在恢复请求");
});
