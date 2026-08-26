/**
 * chatModel 纯函数测试：工具行模型（变体/状态）、轮次级错误呈现（标题/语义色/人话映射）、
 * 指标格式化（token/时长/时钟/吞吐）、轮次指标派生，以及 sessionTimeline 的 TTFT/解码指标与压缩标记。
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
  humanizeRunError,
  runErrorPresentation,
  toolRowState,
  turnMetrics,
  VARIANT_TITLES,
} from "../src/desktop/renderer/src/chatModel.js";
import {
  buildSessionTimeline,
  createSessionTimelineProjector,
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

test("增量投影：追加实时事件时历史轮次与未触及工具引用稳定、内容与全量一致", () => {
  const base = { sessionId: "s1", runId: "r1", timestamp: "2026-05-15T10:00:00.000Z" };
  const events = [
    { type: "user_message", content: "历史问题", time: "2026-05-15T09:00:00.000Z" },
    { type: "assistant_message", content: "历史回答", time: "2026-05-15T09:00:05.000Z" },
  ];
  const liveStart = [
    { ...base, type: "message.user", messageId: "m1", content: "实时问题" },
    { ...base, type: "run.started", messageId: "m1", input: "实时问题", mode: "normal", model: { alias: "a", provider: "p", label: "p/m", reasoning: "" }, skills: [] },
    { ...base, type: "tool.started", toolCallId: "tool-a", tool: "run_command", args: { command: "ls" }, display: { kind: "command", command: "ls", cwd: "/w" } },
  ];
  // 追加的 assistant.delta 只触及实时轮次正文，不触及工具。
  const assistantDelta = { ...base, type: "assistant.delta", timestamp: "2026-05-15T10:00:01.000Z", content: "你好" };
  // 追加的 tool.progress 触及 tool-a。
  const toolProgress = { ...base, type: "tool.progress", toolCallId: "tool-a", tool: "run_command", update: { kind: "stdout", text: "out\n" } };

  const projector = createSessionTimelineProjector();
  const first = projector.update({ sessionId: "s1", events, liveEvents: liveStart });
  assert.deepEqual(first, buildSessionTimeline(events, liveStart));

  const liveAfterDelta = [...liveStart, assistantDelta];
  const second = projector.update({ sessionId: "s1", events, liveEvents: liveAfterDelta });
  assert.deepEqual(second, buildSessionTimeline(events, liveAfterDelta));
  assert.equal(second[0], first[0]); // 历史轮次对象引用不变（Turn memo 跳过子树）
  assert.notEqual(second[1], first[1]); // 进行中的实时轮次发布了新引用
  assert.equal(second[1]?.tools[0], first[1]?.tools[0]); // 未触及的工具引用不变（ToolActivity memo 生效）

  const liveAfterProgress = [...liveAfterDelta, toolProgress];
  const third = projector.update({ sessionId: "s1", events, liveEvents: liveAfterProgress });
  assert.deepEqual(third, buildSessionTimeline(events, liveAfterProgress));
  assert.equal(third[0], first[0]); // 历史轮次依旧稳定
  assert.notEqual(third[1]?.tools[0], second[1]?.tools[0]); // 被触及的工具发布了新引用
  assert.equal(third[1]?.tools[0]?.command?.stdout, "out\n");
});

test("增量投影：events 引用变化或实时流收缩时整体重置", () => {
  const base = { sessionId: "s1", runId: "r1", timestamp: "2026-05-15T10:00:00.000Z" };
  const events = [
    { type: "user_message", content: "历史问题", time: "2026-05-15T09:00:00.000Z" },
    { type: "assistant_message", content: "历史回答", time: "2026-05-15T09:00:05.000Z" },
  ];
  const live = [{ ...base, type: "message.user", messageId: "m1", content: "实时问题" }];
  const projector = createSessionTimelineProjector();
  const first = projector.update({ sessionId: "s1", events, liveEvents: live });

  // liveEvents 变短（会话刷新/切换）→ 重置，历史轮次重新计算得到新引用。
  const reset = projector.update({ sessionId: "s1", events, liveEvents: [] });
  assert.deepEqual(reset, buildSessionTimeline(events, []));
  assert.notEqual(reset[0], first[0]);

  // events 换了引用（终态刷新后 openSession 返回新数组）→ 同样整体重置。
  const newEvents = [...events];
  const afterReload = projector.update({ sessionId: "s1", events: newEvents, liveEvents: [] });
  assert.notEqual(afterReload[0], reset[0]);

  // 切到另一个会话 → 重置。
  const other = projector.update({ sessionId: "s2", events: [], liveEvents: [] });
  assert.deepEqual(other, []);
});

test("runErrorPresentation 按终态区分标题与语义色", () => {
  assert.deepEqual(runErrorPresentation("blocked"), { title: "任务被阻塞", variant: "warning" });
  assert.deepEqual(runErrorPresentation("cancelled"), { title: "已取消", variant: "warning" });
  assert.deepEqual(runErrorPresentation("aborted"), { title: "已中止", variant: "warning" });
  assert.deepEqual(runErrorPresentation("incomplete"), { title: "本轮运行未完成", variant: "error" });
  assert.deepEqual(runErrorPresentation("failed"), { title: "本轮运行失败", variant: "error" });
});

test("humanizeRunError 把网络/运行时错误码映射成人话", () => {
  // 连接 / 响应超时（undici 原始码）
  assert.equal(humanizeRunError("TypeError: fetch failed (UND_ERR_CONNECT_TIMEOUT)"), "网络连接超时，请检查代理或网络后重试。");
  assert.equal(humanizeRunError("UND_ERR_HEADERS_TIMEOUT"), "服务器响应超时，请稍后重试。");
  // 连接中断 / 拒绝 / 域名解析
  assert.equal(humanizeRunError("Error: read ECONNRESET"), "连接被中断，请检查网络或代理后重试。");
  assert.equal(humanizeRunError("connect ECONNREFUSED 127.0.0.1:443"), "无法连接到服务器，请确认服务可用或代理配置正确。");
  assert.equal(humanizeRunError("getaddrinfo ENOTFOUND api.example.com"), "域名解析失败，请检查网络或代理设置。");
  // 通用网络失败兜底
  assert.equal(humanizeRunError("TypeError: fetch failed"), "网络请求失败，请检查网络或代理后重试。");
});

test("humanizeRunError 映射鉴权/限流/服务端/上下文/取消", () => {
  assert.equal(humanizeRunError("HTTP 401 Unauthorized"), "鉴权失败，请检查 API Key 是否正确。");
  assert.equal(humanizeRunError("429 Too Many Requests"), "请求过于频繁或额度不足，请稍后重试。");
  assert.equal(humanizeRunError("500 Internal Server Error"), "服务端暂时不可用，请稍后重试。");
  assert.equal(humanizeRunError("This model's maximum context length is 200000 tokens"), "超出模型上下文长度，请压缩上下文或开启新会话。");
  assert.equal(humanizeRunError("The operation was aborted"), "操作已被取消。");
});

test("humanizeRunError 可读文案保留首行，空串原样返回", () => {
  assert.equal(humanizeRunError("Something unexpected happened.\nMore detail here."), "Something unexpected happened.");
  assert.equal(humanizeRunError("   "), "");
});
