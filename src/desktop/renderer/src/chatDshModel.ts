/**
 * DSH 风格聊天行的纯函数模型。
 *
 * 复刻 deepseek-harness ui-tool 的 tool-call-model（figma 122:9479）：把工具名分类成
 * 视觉变体、派生行标题与状态语义；以及 message-chrome 的时间/指标格式化（日期感知时钟、
 * 用时、首 token 延迟、解码吞吐）。全部为纯函数，不依赖 React，便于单测。
 */
import type { TimelineTool, TimelineTurn } from "./sessionTimeline.js";
import type { IconName } from "./components/Icon.js";

/** 工具行视觉变体（标题字面量来自 DSH figma 设计）。 */
export type ToolRowVariant = "search" | "read" | "bash" | "write" | "edit" | "git" | "process" | "skill" | "others";

/** 行状态语义；颜色由 StateDot 自供。 */
export type ToolRowState = "running" | "ok" | "error" | "stopped";

/** 变体 leading 图标名（Biny Icon 名；DSH figma 表：search/read/bash/write/edit/code/others）。 */
export const VARIANT_ICON_NAMES: Record<ToolRowVariant, IconName> = {
  search: "search",
  read: "file",
  bash: "terminal",
  write: "edit",
  edit: "edit",
  git: "diff",
  process: "activity",
  skill: "wand",
  others: "spark",
};

/** 变体行标题（DSH figma 字面量，非翻译文案）。 */
export const VARIANT_TITLES: Record<ToolRowVariant, string> = {
  search: "Search",
  read: "Read",
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  git: "Git",
  process: "Process",
  skill: "Skill",
  others: "Tool call",
};

/** 已知工具名 → 变体；未知工具落到通用 `others`。 */
const TOOL_VARIANTS: Record<string, ToolRowVariant> = {
  run_command: "bash",
  read_file: "read",
  web_fetch: "read",
  web_search: "search",
  search_files: "search",
  grep_search: "search",
  write_file: "write",
  edit_file: "edit",
  multi_edit: "edit",
  apply_patch: "edit",
  delete_file: "edit",
  move_file: "edit",
  git_diff: "git",
  git_status: "git",
  git_commit: "git",
  start_process: "process",
  stop_process: "process",
  process_status: "process",
  read_process_output: "process",
  list_processes: "process",
  invoke_skill: "skill",
  skill_call: "skill",
};

/** 把工具名分类成行变体。 */
export function classifyTool(toolName: string): ToolRowVariant {
  return TOOL_VARIANTS[toolName] ?? "others";
}

/** 从时间线工具状态派生行状态语义。 */
export function toolRowState(tool: TimelineTool): ToolRowState {
  if (tool.status === "running" || tool.status === "waiting") return "running";
  if (tool.status === "failed" || tool.status === "denied" || tool.status === "unknown") return "error";
  if (tool.status === "cancelled" || tool.status === "aborted") return "stopped";
  return "ok";
}

/** 错误行的折叠摘要 = 失败文本首行（DSH：错误摘要替换摘要槽）。 */
export function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

/** 折叠的 token 计数：517 / 12.2K / 517K / 1.2M（一位小数仅在三位数以下）。 */
export function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`;
  return `${scaled(n / 1_000_000)}M`;
}

/** 紧凑时长：45.2s（不足一分钟）、2m42s（以上）。 */
export function formatDuration(ms: number): string {
  const s = ms / 1_000;
  if (s < 60) return `${Math.round(s * 10) / 10}s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, "0")}s`;
}

/** 人类可读的整轮用时：`2m05s` / `15s`。 */
export function formatRunDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0
    ? `${minutes}m${String(seconds).padStart(2, "0")}s`
    : `${seconds}s`;
}

/** 亚轮延迟数字：10 秒内一位小数，以上取整（单位由调用方补）。 */
export function formatLatencySeconds(ms: number): string {
  const s = Math.max(0, ms) / 1_000;
  return s < 10 ? String(Math.round(s * 10) / 10) : String(Math.round(s));
}

/** 解码吞吐数字：10 以上取整，以下一位小数（单位由调用方补）。 */
export function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

/**
 * 日期感知的本地时钟：当天 `HH:mm`；今年 `M/D HH:mm`；跨年 `Y/M/D HH:mm`。
 * @param time - Unix epoch ms。
 * @param now - 参考时刻，默认墙钟。
 */
export function formatMessageClock(time: number, now: number = Date.now()): string {
  const d = new Date(time);
  const n = new Date(now);
  const pad2 = (value: number): string => String(value).padStart(2, "0");
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return clock;
  }
  const date = d.getFullYear() === n.getFullYear()
    ? `${d.getMonth() + 1}/${d.getDate()}`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  return `${date} ${clock}`;
}

/** 一轮的展示指标：首 token 延迟与解码吞吐（只有数据齐全才给出）。 */
export interface TurnMetrics {
  ttftMs?: number;
  tokensPerSecond?: number;
}

/** 一轮的展示指标：首 token 延迟、解码吞吐、模型耗时（TTFT + 解码）。 */
export interface TurnMetrics {
  ttftMs?: number;
  tokensPerSecond?: number;
  /** 模型输出耗时（TTFT + 解码墙钟）；只有两者都可用时才给出。 */
  llmMs?: number;
}

/** 从时间线轮次派生展示指标；历史轮次缺 firstTokenAt 时只保留可用的部分。 */
export function turnMetrics(turn: TimelineTurn): TurnMetrics {
  const metrics: TurnMetrics = {};
  if (turn.ttftMs !== undefined) metrics.ttftMs = turn.ttftMs;
  if (turn.decodeMs !== undefined && turn.decodeTokens !== undefined && turn.decodeMs > 0) {
    metrics.tokensPerSecond = turn.decodeTokens / (turn.decodeMs / 1_000);
  }
  if (turn.ttftMs !== undefined && turn.decodeMs !== undefined) {
    metrics.llmMs = turn.ttftMs + turn.decodeMs;
  }
  return metrics;
}
