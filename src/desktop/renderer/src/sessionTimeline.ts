/**
 * 会话时间线构建。
 *
 * 把两路事件合成界面用的「一问一答」轮次：`events` 是已落盘的历史事件，`liveEvents` 是本轮
 * 正在进行的实时事件。
 *
 * 关键难点是去重——实时事件先发出、随后才被写进 session，直接拼接会让同一轮出现两次。
 * `historicalPrefix` 负责找出历史里与首条实时用户消息对应的那条，从那里截断。
 *
 * 这里只做数据整形，不含任何渲染逻辑，方便单独测试。
 */
import type { ToolInputDisplay, ToolUpdate } from "../../../tools/types.js";
import type { AgentPermissionEventRequest, AgentRunModel, AgentHostEvent } from "../../../runtime/agentEvents.js";
import { activitySummaryText } from "../../../runtime/activitySummary.js";
import type { SessionEvent } from "../../../session/recorder.js";
import type { SessionUsage } from "../../../session/metadata.js";
import { publicUserMessage } from "../../../session/publicMessage.js";

export type TimelineRunStatus =
  | "idle"
  | "running"
  | "waiting_permission"
  | "completed"
  | "blocked"
  | "incomplete"
  | "cancelled"
  | "aborted"
  | "failed";
export type TimelineToolStatus = "waiting" | "running" | "success" | "failed" | "denied" | "aborted" | "cancelled" | "skipped" | "unknown";

export interface TimelinePermission {
  requestId: string;
  request: AgentPermissionEventRequest;
  resolved: boolean;
  approved?: boolean;
  message?: string;
}

export interface TimelineCommand {
  command: string;
  cwd?: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
}

export interface TimelineTool {
  id: string;
  tool: string;
  args: unknown;
  result?: unknown;
  status: TimelineToolStatus;
  description?: string;
  display?: ToolInputDisplay;
  updates: ToolUpdate[];
  durationMs?: number;
  error?: string;
  diff?: string;
  path?: string;
  command?: TimelineCommand;
  permission?: TimelinePermission;
  timestamp?: string;
  executionStatus?: "cancelled" | "succeeded" | "failed" | "unknown";
  recovered?: boolean;
  operationId?: string;
  evidence?: string;
}

export interface TimelineToolEntry {
  key: string;
  label: string;
  toolId?: string;
}

export interface TimelineReasoningStep {
  kind: "reasoning";
  id: string;
  content: string;
  status?: string;
  startedAt?: string;
  durationMs?: number;
  completed?: boolean;
  /** 上下文压缩标记：渲染为独立的压缩通知行而非思考行。 */
  notice?: "compaction";
}

export interface TimelineAssistantStep {
  kind: "assistant";
  id: string;
  content: string;
  /** 工具前的公开说明，作为时间线正文摘要展示，但不计入最终 assistant 正文。 */
  summary?: boolean;
}

export interface TimelineToolStep {
  kind: "tool";
  id: string;
  tool: TimelineTool;
}

export interface TimelineUserStep {
  kind: "user";
  id: string;
  content: string;
  delivery: "steer" | "followUp";
}

export type TimelineStep = TimelineReasoningStep | TimelineAssistantStep | TimelineToolStep | TimelineUserStep;

export function activeTimelineTool(tools: TimelineTool[], selectedToolId?: string): TimelineTool | undefined {
  return [...tools].reverse().find((tool) => tool.permission && !tool.permission.resolved)
    ?? tools.find((tool) => tool.id === selectedToolId);
}

export function timelineToolEntries(tools: TimelineTool[]): TimelineToolEntry[] {
  const totals = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const tool of tools) totals.set(tool.tool, (totals.get(tool.tool) ?? 0) + 1);
  return tools.map((tool) => {
    const occurrence = (seen.get(tool.tool) ?? 0) + 1;
    seen.set(tool.tool, occurrence);
    const duplicateLabel = (totals.get(tool.tool) ?? 0) > 1 ? ` ${String(occurrence)}` : "";
    const permissionLabel = tool.permission && !tool.permission.resolved ? " · 待授权" : "";
    return {
      key: tool.id,
      label: `${executionToolLabel(tool.tool)}${duplicateLabel}${permissionLabel}`,
      toolId: tool.id
    };
  });
}

function executionToolLabel(tool: string): string {
  if (tool === "run_command") return "Bash";
  if (tool === "invoke_skill" || tool === "skill_call") return "技能调用";
  return tool;
}

export interface TimelineTurn {
  id: string;
  user: string;
  userMessageIndex?: number;
  assistant: string;
  reasoning: string;
  reasoningStatus?: string;
  reasoningDurationMs?: number;
  reasoningStartedAt?: string;
  skills: string[];
  status: TimelineRunStatus;
  model?: AgentRunModel;
  tools: TimelineTool[];
  steps: TimelineStep[];
  error?: string;
  durationMs?: number;
  usage?: SessionUsage;
  timestamp?: string;
  resumable?: boolean;
  /** 本轮首个模型输出增量（reasoning/assistant delta）的时间戳；用于首 token 延迟。 */
  firstTokenAt?: string;
  /** 本轮开始时间（run.started）；终态事件会覆盖 `timestamp`，TTFT 必须锚定它。 */
  startedAt?: string;
  /** 首 token 延迟（firstTokenAt − startedAt），实时轮次在终态时计算。 */
  ttftMs?: number;
  /** 解码耗时（durationMs − ttftMs），实时轮次在终态时计算。 */
  decodeMs?: number;
  /** 解码 token 数（usage.outputTokens），实时轮次在终态时计算。 */
  decodeTokens?: number;
}

export interface TimelineChangedFile {
  path: string;
  operation: "write" | "edit";
  status: "writing" | "completed";
}

/**
 * 合并同一帧里的 reasoning 增量。
 *
 * 思考预览需要在模型输出时出现，但不能把一帧内的几十个小片段原样塞进 React
 * 状态。只合并连续增量，遇到其他事件就重新开始，既保留事件顺序，也把每帧的
 * 时间线更新压缩成一个字符串。
 */
export function liveTimelineEvents(events: AgentHostEvent[]): AgentHostEvent[] {
  const result: AgentHostEvent[] = [];
  const lastReasoningDelta = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "reasoning.delta") {
      lastReasoningDelta.delete(event.runId);
      result.push(event);
      continue;
    }
    const previousIndex = lastReasoningDelta.get(event.runId);
    const previous = previousIndex === undefined ? undefined : result[previousIndex];
    if (previousIndex !== undefined && previous?.type === "reasoning.delta") {
      result[previousIndex] = { ...previous, content: previous.content + event.content, timestamp: event.timestamp };
      continue;
    }
    lastReasoningDelta.set(event.runId, result.length);
    result.push(event);
  }
  return result;
}

const LIVE_REASONING_LIMIT = 640;

/** 实时行只保留可用于预览的前缀，终态刷新后再从 session 恢复完整内容。 */
function appendLiveReasoning(existing: string, next: string): string {
  if (!next || existing.endsWith("…")) return existing;
  const combined = existing + next;
  return combined.length <= LIVE_REASONING_LIMIT
    ? combined
    : `${combined.slice(0, LIVE_REASONING_LIMIT - 1).trimEnd()}…`;
}

/** 完全空的轮次（只有元信息、没有任何可展示内容）不进时间线。 */
function isVisibleTimelineTurn(turn: TimelineTurn): boolean {
  return Boolean(turn.user || turn.assistant || turn.steps.length || turn.tools.length || turn.error);
}

/** 合成完整时间线；末尾过滤掉完全空的轮次（只有元信息、没有任何可展示内容）。 */
export function buildSessionTimeline(events: SessionEvent[], liveEvents: AgentHostEvent[]): TimelineTurn[] {
  const history = historicalPrefix(events, liveEvents);
  const historicalTurns = buildHistoricalTurns(history);
  // 实时轮次的用户消息序号要接着历史的算，「编辑消息」功能依赖这个序号定位。
  const historicalUserMessages = history.filter((event) => event.type === "user_message").length;
  return [...historicalTurns, ...buildLiveTurns(liveEvents, historicalUserMessages)].filter(isVisibleTimelineTurn);
}

/**
 * 找出历史事件中应当保留的前缀，避免与实时事件重复。
 *
 * 做法是在历史里找与首条实时用户消息「内容相同且时间不早于它」的那一条，从该处截断；
 * 找不到就整段保留。内容比较用 `publicUserMessage`，因为落盘的内容可能带 harness 脚手架。
 */
function historicalPrefix(events: SessionEvent[], liveEvents: AgentHostEvent[]): SessionEvent[] {
  const firstLiveUser = liveEvents.find((event) => event.type === "message.user");
  if (!firstLiveUser || firstLiveUser.type !== "message.user") return events;
  const liveTimestamp = Date.parse(firstLiveUser.timestamp);
  if (Number.isNaN(liveTimestamp)) return events;
  let matchingIndex = -1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type !== "user_message" || publicUserMessage(event.content) !== publicUserMessage(firstLiveUser.content)) continue;
    const eventTimestamp = event.time ? Date.parse(event.time) : Number.NaN;
    // 实时事件先于 AgentSession 落盘发出，所以只有时间不早于它的记录才可能是「同一条」；
    // 更早的同样内容（用户重复发过一次）必须留在历史里。
    if (!Number.isNaN(eventTimestamp) && eventTimestamp >= liveTimestamp) matchingIndex = index;
  }
  return matchingIndex >= 0 ? events.slice(0, matchingIndex) : events;
}

function buildHistoricalTurns(events: SessionEvent[]): TimelineTurn[] {
  const turns: TimelineTurn[] = [];
  let current: TimelineTurn | undefined;
  let anonymousIndex = 0;
  let userMessageIndex = 0;
  const ensureTurn = (timestamp?: string): TimelineTurn => {
    if (current) return current;
    anonymousIndex += 1;
    current = emptyTurn(`history-${String(anonymousIndex)}`, timestamp);
    turns.push(current);
    return current;
  };

  for (const event of events) {
    if (event.type === "tool_result" && event.auditOnly && event.recovered && resultString(event.result, "status") !== "skipped") continue;
    if (event.type === "user_message") {
      anonymousIndex += 1;
      current = emptyTurn(`history-${String(anonymousIndex)}`, event.time);
      current.user = publicUserMessage(event.content);
      current.userMessageIndex = userMessageIndex;
      userMessageIndex += 1;
      turns.push(current);
      continue;
    }
    if (event.type === "assistant_message") {
      const turn = ensureTurn(event.time);
      turn.assistant = event.content || turn.assistant;
      appendHistoricalReasoning(turn, event.reasoningContent);
      appendHistoricalAssistant(turn, event.content);
      turn.durationMs = elapsedMs(turn.timestamp, event.time) ?? turn.durationMs;
      turn.timestamp = event.time ?? turn.timestamp;
      turn.status = "completed";
      turn.usage = event.usage;
      if (event.usage) {
        turn.model = {
          alias: event.usage.modelAlias,
          provider: event.usage.provider,
          label: modelLabel(event.usage.provider, event.usage.model),
          reasoning: ""
        };
      }
      continue;
    }
    if (event.type === "turn_status") {
      const turn = ensureTurn(event.time);
      turn.status = event.status;
      turn.timestamp = event.time ?? turn.timestamp;
      turn.resumable = event.resumable;
      turn.error = event.status === "completed"
        ? undefined
        : historicalTurnStatusSummary(event);
      for (const tool of turn.tools) {
        if (tool.status !== "running" && tool.status !== "waiting") continue;
        tool.status = event.status === "failed" ? "failed" : event.status === "cancelled" ? "cancelled" : "unknown";
      }
      continue;
    }
    if (event.type === "tool_call") {
      const turn = ensureTurn(event.time);
      appendInvokedSkill(turn, event.tool, event.args);
      const projection = historicalToolProjection(event.tool, event.args);
      appendHistoricalReasoning(turn, event.reasoningContent);
      appendHistoricalAssistant(turn, event.assistantContent, true);
      const tool: TimelineTool = {
        id: event.toolCallId ?? `history-tool-${String(turn.tools.length)}`,
        tool: event.tool,
        args: event.args,
        status: "running",
        display: projection.display,
        path: projection.path,
        updates: [],
        timestamp: event.time
      };
      turn.tools.push(tool);
      turn.steps.push({ kind: "tool", id: tool.id, tool });
      continue;
    }
    if (event.type === "tool_result") {
      const turn = ensureTurn(event.time);
      const tool = [...turn.tools].reverse().find((candidate) => candidate.id === event.toolCallId || (candidate.tool === event.tool && candidate.result === undefined));
      if (tool) {
        tool.result = event.result;
        tool.status = timelineToolStatus(event.result, event.executionStatus);
        tool.error = resultError(event.result);
        tool.diff = resultString(event.result, "output") ?? resultString(event.result, "diffPreview");
        tool.executionStatus = event.executionStatus;
        tool.recovered = event.recovered;
        tool.operationId = event.operationId;
        tool.evidence = event.evidence;
      }
      continue;
    }
    if (event.type === "agent_message") continue;
    if (event.type === "tool_execution") continue;
    if (event.type === "context_checkpoint") continue;
    if (event.type === "model_request") continue;
    const turn = ensureTurn(event.time);
    turn.error = event.message;
    turn.durationMs = elapsedMs(turn.timestamp, event.time) ?? turn.durationMs;
    turn.timestamp = event.time ?? turn.timestamp;
    const aborted = /abort|中止|interrupted/i.test(event.message);
    turn.status = aborted ? "aborted" : "failed";
    if (aborted) {
      for (const tool of turn.tools) {
        if (tool.status === "running" || tool.status === "failed") tool.status = "unknown";
      }
    }
  }
  return turns;
}

/**
 * 实时事件的可增量折叠器。
 *
 * 实时事件以 `runId` 归属轮次、以 `toolCallId` 归属工具，所以这里用 Map 建索引，`order`
 * 单独记录出现顺序（Map 的插入序不适合在后续补写时依赖）。
 * `activeReasoning` / `activeAssistant` 保存当前正在流式追加的步骤，增量内容要续写而不是新建。
 *
 * 状态在闭包里只建一次：`apply` 逐个吸收事件，`snapshot` 产出当前轮次数组。增量复用的关键在
 * `snapshot`——自上次快照以来没有被事件触及的轮次/工具直接复用上次发布的对象引用，被触及的才克隆，
 * 这样 React.memo 能跳过没有变化的子树（ToolActivity 按 `tool` 引用记忆）。
 */
interface LiveTimelineFold {
  apply(event: AgentHostEvent): void;
  snapshot(): TimelineTurn[];
}

function createLiveTimelineFold(initialUserMessageIndex: number): LiveTimelineFold {
  const turns = new Map<string, TimelineTurn>();
  const order: string[] = [];
  const toolMaps = new Map<string, Map<string, TimelineTool>>();
  const activeReasoning = new Map<string, TimelineReasoningStep>();
  const activeAssistant = new Map<string, TimelineAssistantStep>();
  let userMessageIndex = initialUserMessageIndex;
  /** 自上次 snapshot 以来被事件触及的轮次/工具；决定哪些对象需要发布新引用。 */
  const dirtyTurns = new Set<string>();
  const dirtyTools = new Set<string>();
  /** 上次 snapshot 对外发布的对象；未变化的轮次/工具原样复用，保持引用稳定。 */
  const publishedTurns = new Map<string, TimelineTurn>();
  const publishedTools = new Map<string, TimelineTool>();
  const turnFor = (event: AgentHostEvent): TimelineTurn => {
    const current = turns.get(event.runId);
    if (current) return current;
    const turn = emptyTurn(event.runId, event.timestamp);
    turns.set(event.runId, turn);
    toolMaps.set(event.runId, new Map());
    order.push(event.runId);
    return turn;
  };
  const toolFor = (event: AgentHostEvent & { toolCallId: string }, toolName = "tool"): TimelineTool => {
    const turn = turnFor(event);
    const tools = toolMaps.get(event.runId);
    if (!tools) throw new Error("Timeline tool map is missing.");
    markActiveAssistantSummary(turn, event.runId);
    const current = tools.get(event.toolCallId);
    if (current) {
      dirtyTools.add(current.id);
      return current;
    }
    const tool: TimelineTool = {
      id: event.toolCallId,
      tool: toolName,
      args: {},
      status: "waiting",
      updates: [],
      timestamp: event.timestamp
    };
    tools.set(event.toolCallId, tool);
    turn.tools.push(tool);
    turn.steps.push({ kind: "tool", id: tool.id, tool });
    dirtyTools.add(tool.id);
    return tool;
  };

  const finishReasoning = (runId: string, timestamp: string): void => {
    const step = activeReasoning.get(runId);
    const turn = turns.get(runId);
    if (!step || !turn) return;
    step.completed = true;
    step.durationMs = elapsedMs(step.startedAt, timestamp);
    turn.reasoningDurationMs = addReasoningDuration(turn.reasoningDurationMs, turn.reasoningStartedAt, timestamp);
    turn.reasoningStartedAt = undefined;
    activeReasoning.delete(runId);
  };

  /** 记录本轮首个输出增量时间（首个 reasoning/assistant delta），TTFT 的分子。 */
  const noteFirstToken = (turn: TimelineTurn, timestamp: string): void => {
    if (!turn.firstTokenAt) turn.firstTokenAt = timestamp;
  };

  /** 终态结算：从已记录的时间戳与 usage 派生 TTFT / 解码耗时 / 解码 token。 */
  const settleMetrics = (turn: TimelineTurn): void => {
    const start = Date.parse(turn.startedAt ?? turn.timestamp ?? "");
    const firstToken = turn.firstTokenAt ? Date.parse(turn.firstTokenAt) : Number.NaN;
    if (!Number.isNaN(start) && !Number.isNaN(firstToken) && firstToken >= start) {
      turn.ttftMs = firstToken - start;
    }
    if (turn.durationMs !== undefined && turn.ttftMs !== undefined && turn.durationMs > turn.ttftMs) {
      turn.decodeMs = turn.durationMs - turn.ttftMs;
    }
    turn.decodeTokens = turn.usage?.outputTokens;
  };

  const startReasoning = (event: Extract<AgentHostEvent, { type: "reasoning.started" }>): TimelineReasoningStep => {
    finishReasoning(event.runId, event.timestamp);
    const turn = turnFor(event);
    const status = event.phase === "initial" ? "正在分析任务" : "正在继续处理";
    const step: TimelineReasoningStep = {
      kind: "reasoning",
      id: `${event.runId}:reasoning:${String(turn.steps.filter((candidate) => candidate.kind === "reasoning").length)}`,
      content: "",
      status,
      startedAt: event.timestamp
    };
    turn.steps.push(step);
    activeReasoning.set(event.runId, step);
    turn.reasoningStatus = status;
    turn.reasoningStartedAt = event.timestamp;
    return step;
  };

  const reasoningStepFor = (event: Extract<AgentHostEvent, { type: "reasoning.delta" }>): TimelineReasoningStep => {
    const existing = activeReasoning.get(event.runId);
    if (existing) return existing;
    return startReasoning({ ...event, type: "reasoning.started", phase: "continuing" });
  };

  const appendAssistant = (turn: TimelineTurn, content: string): void => {
    if (!content) return;
    const active = activeAssistant.get(turn.id);
    if (active) {
      active.content += content;
      return;
    }
    const step: TimelineAssistantStep = {
      kind: "assistant",
      id: `${turn.id}:assistant:${String(turn.steps.filter((candidate) => candidate.kind === "assistant").length)}`,
      content
    };
    turn.steps.push(step);
    activeAssistant.set(turn.id, step);
  };

  const markActiveAssistantSummary = (turn: TimelineTurn, runId: string): void => {
    const step = activeAssistant.get(runId);
    if (!step) return;
    const content = activitySummaryText(step.content);
    const index = turn.steps.indexOf(step);
    if (!content) {
      if (index >= 0) turn.steps.splice(index, 1);
    } else {
      step.content = content;
      step.summary = true;
    }
    activeAssistant.delete(runId);
  };

  const apply = (event: AgentHostEvent): void => {
    const turn = turnFor(event);
    dirtyTurns.add(turn.id);
    if (event.type === "message.user") {
      const content = publicUserMessage(event.content);
      if (event.delivery && turn.user) {
        finishReasoning(event.runId, event.timestamp);
        activeAssistant.delete(event.runId);
        turn.steps.push({
          kind: "user",
          id: `${event.runId}:user:${event.messageId}`,
          content,
          delivery: event.delivery
        });
      } else {
        turn.user = content;
        turn.userMessageIndex = userMessageIndex;
      }
      userMessageIndex += 1;
      turn.status = "running";
    } else if (event.type === "run.started") {
      turn.status = "running";
      turn.model = event.model;
      turn.startedAt = event.timestamp;
    } else if (event.type === "context.retrying") {
      turn.steps.push({
        kind: "reasoning",
        id: `${event.runId}:context-retry:${String(event.attempt)}`,
        content: "",
        status: `已压缩 ${String(event.compactedMessages)} 条消息，正在恢复请求`,
        completed: true,
        notice: "compaction"
      });
    } else if (event.type === "assistant.delta") {
      finishReasoning(event.runId, event.timestamp);
      noteFirstToken(turn, event.timestamp);
      appendAssistant(turn, event.content);
    } else if (event.type === "assistant.completed") {
      finishReasoning(event.runId, event.timestamp);
      const active = activeAssistant.get(event.runId);
      if (active) {
        if (event.content) active.content = event.content;
        activeAssistant.delete(event.runId);
      } else if (event.content && latestAssistantContent(turn) !== event.content) {
        appendAssistant(turn, event.content);
        activeAssistant.delete(event.runId);
      }
      turn.timestamp = event.timestamp;
    } else if (event.type === "reasoning.started") {
      startReasoning(event);
    } else if (event.type === "reasoning.delta") {
      const step = reasoningStepFor(event);
      noteFirstToken(turn, event.timestamp);
      step.content = appendLiveReasoning(step.content, event.content);
      turn.reasoning = appendLiveReasoning(turn.reasoning, event.content);
    } else if (event.type === "reasoning.completed") {
      turn.reasoningStatus = "分析完成";
      const step = activeReasoning.get(event.runId);
      if (step) {
        step.status = "分析完成";
        finishReasoning(event.runId, event.timestamp);
      }
    } else if (event.type === "tool.started") {
      finishReasoning(event.runId, event.timestamp);
      appendInvokedSkill(turn, event.tool, event.args);
      const tool = toolFor(event, event.tool);
      tool.tool = event.tool;
      tool.args = event.args;
      tool.status = "running";
      tool.description = event.description;
      tool.display = event.display;
      if (event.display?.kind === "file_io") tool.path = event.display.path;
      if (event.display?.kind === "command") {
        tool.command = { command: event.display.command, cwd: event.display.cwd, stdout: "", stderr: "" };
      }
      turn.reasoningStatus = toolStatus(event.tool, event.display);
    } else if (event.type === "tool.progress") {
      const tool = toolFor(event, event.tool);
      tool.updates.push(event.update);
      if (tool.command && event.update.text) {
        if (event.update.kind === "stdout") tool.command.stdout += event.update.text;
        if (event.update.kind === "stderr") tool.command.stderr += event.update.text;
      }
    } else if (event.type === "tool.completed") {
      const tool = toolFor(event, event.tool);
      applyToolResult(tool, event.result);
      tool.status = timelineToolStatus(event.result, event.executionStatus);
      tool.executionStatus = event.executionStatus;
      tool.recovered = event.recovered;
      tool.operationId = event.operationId;
      tool.evidence = event.evidence;
      tool.durationMs = event.durationMs;
    } else if (event.type === "tool.failed") {
      const tool = toolFor(event, event.tool);
      if (event.result !== undefined) applyToolResult(tool, event.result);
      tool.status = timelineToolStatus(event.result ?? { error: event.error }, event.executionStatus === "unknown" ? "unknown" : event.executionStatus === "cancelled" ? "cancelled" : "failed");
      tool.executionStatus = event.executionStatus;
      tool.recovered = event.recovered;
      tool.operationId = event.operationId;
      tool.evidence = event.evidence;
      tool.error = event.error;
      tool.durationMs = event.durationMs;
    } else if (event.type === "permission.requested") {
      const tool = toolFor(event, event.request.tool);
      tool.status = "running";
      tool.permission = { requestId: event.requestId, request: event.request, resolved: false };
      turn.status = "waiting_permission";
    } else if (event.type === "permission.resolved") {
      const tool = toolFor(event, event.tool);
      tool.permission = {
        requestId: event.requestId,
        request: tool.permission?.request ?? permissionFallback(event.toolCallId, event.tool),
        resolved: true,
        approved: event.approved,
        message: event.message
      };
      if (!event.approved) tool.status = "denied";
      turn.status = "running";
    } else if (event.type === "run.completed") {
      turn.status = "completed";
      turn.resumable = undefined;
      turn.timestamp = event.timestamp;
      turn.durationMs = event.durationMs;
      finishReasoning(event.runId, event.timestamp);
      turn.usage = event.usage;
      settleMetrics(turn);
    } else if (event.type === "run.blocked") {
      turn.status = "blocked";
      turn.resumable = event.resumable;
      turn.timestamp = event.timestamp;
      turn.error = event.requiredAction
        ? `${event.summary}\nRequired action: ${event.requiredAction}`
        : event.summary;
      turn.durationMs = event.durationMs;
      finishReasoning(event.runId, event.timestamp);
      turn.usage = event.usage;
      for (const tool of turn.tools) {
        if (tool.status !== "running" && tool.status !== "waiting") continue;
        tool.status = "unknown";
        dirtyTools.add(tool.id);
      }
    } else if (event.type === "run.incomplete") {
      turn.status = "incomplete";
      turn.resumable = event.resumable;
      turn.timestamp = event.timestamp;
      turn.error = event.reason;
      turn.durationMs = event.durationMs;
      finishReasoning(event.runId, event.timestamp);
      turn.usage = event.usage;
      settleMetrics(turn);
      for (const tool of turn.tools) {
        if (tool.status !== "running" && tool.status !== "waiting") continue;
        tool.status = "unknown";
        dirtyTools.add(tool.id);
      }
    } else if (event.type === "run.cancelled") {
      turn.status = "cancelled";
      turn.resumable = undefined;
      turn.timestamp = event.timestamp;
      turn.error = event.reason;
      turn.durationMs = event.durationMs;
      finishReasoning(event.runId, event.timestamp);
      turn.usage = event.usage;
      settleMetrics(turn);
      for (const tool of turn.tools) {
        if (tool.status !== "running" && tool.status !== "waiting") continue;
        tool.status = "unknown";
        dirtyTools.add(tool.id);
      }
    } else if (event.type === "run.aborted") {
      turn.status = "aborted";
      turn.resumable = undefined;
      turn.timestamp = event.timestamp;
      turn.error = event.reason;
      turn.durationMs = event.durationMs;
      finishReasoning(event.runId, event.timestamp);
      for (const tool of turn.tools) {
        if (tool.status !== "running" && tool.status !== "waiting") continue;
        tool.status = "unknown";
        dirtyTools.add(tool.id);
      }
    } else if (event.type === "run.failed") {
      turn.status = "failed";
      turn.resumable = undefined;
      turn.timestamp = event.timestamp;
      turn.error = event.error;
      turn.durationMs = event.durationMs;
      finishReasoning(event.runId, event.timestamp);
      settleMetrics(turn);
      for (const tool of turn.tools) {
        if (tool.status !== "running" && tool.status !== "waiting") continue;
        tool.status = "failed";
        dirtyTools.add(tool.id);
      }
    }
  };

  const snapshot = (): TimelineTurn[] => {
    const result: TimelineTurn[] = [];
    for (const runId of order) {
      const working = turns.get(runId);
      if (!working) continue;
      const previous = publishedTurns.get(runId);
      if (previous && !dirtyTurns.has(runId)) {
        result.push(previous);
        continue;
      }
      let tools = working.tools;
      let steps = working.steps;
      if (working.tools.length > 0) {
        // 发布引用必须始终经过 publishedTools：干净工具复用旧引用、脏工具克隆新引用，不能在
        // 两者间来回切换，否则 ToolActivity 的 memo 会因引用抖动失效。步骤里的 tool 引用同步刷新。
        const publishedById = new Map<string, TimelineTool>();
        tools = working.tools.map((tool) => {
          const publishedTool = publishedTools.get(tool.id);
          const next = publishedTool && !dirtyTools.has(tool.id) ? publishedTool : { ...tool };
          publishedTools.set(tool.id, next);
          publishedById.set(tool.id, next);
          return next;
        });
        steps = working.steps.map((step) => step.kind === "tool"
          ? { ...step, tool: publishedById.get(step.tool.id) ?? step.tool }
          : step);
      }
      const published: TimelineTurn = { ...working, assistant: liveAssistantText(working), tools, steps };
      publishedTurns.set(runId, published);
      result.push(published);
    }
    dirtyTurns.clear();
    dirtyTools.clear();
    return result;
  };

  return { apply, snapshot };
}

function liveAssistantText(turn: TimelineTurn): string {
  return turn.steps
    .filter((step): step is TimelineAssistantStep => step.kind === "assistant" && !step.summary)
    .map((step) => step.content)
    .join("\n\n");
}

function buildLiveTurns(events: AgentHostEvent[], initialUserMessageIndex: number): TimelineTurn[] {
  const fold = createLiveTimelineFold(initialUserMessageIndex);
  for (const event of events) fold.apply(event);
  return fold.snapshot();
}

/**
 * 增量时间线投影器。
 *
 * 历史段按 `events` 数组引用记忆（引用不变就不重算），实时段用 LiveTimelineFold 只增量折叠
 * 新增的 liveEvents。会话切换、`events` 引用变化、`liveEvents` 变短或首条实时用户消息变化时整体重置。
 * 输出内容与 `buildSessionTimeline` 完全一致，但未变化的轮次保持对象引用稳定，配合 React.memo
 * 让流式期间每帧只重算、只重渲染变化的轮次。
 */
export interface SessionTimelineProjector {
  update(input: { sessionId: string; events: SessionEvent[]; liveEvents: AgentHostEvent[] }): TimelineTurn[];
}

export function createSessionTimelineProjector(): SessionTimelineProjector {
  let sessionId: string | undefined;
  let eventsRef: SessionEvent[] | undefined;
  let firstLiveUser: AgentHostEvent | undefined;
  let historyTurns: TimelineTurn[] = [];
  let fold: LiveTimelineFold | undefined;
  let processedLive = 0;

  const rebuild = (events: SessionEvent[], liveEvents: AgentHostEvent[]): void => {
    const history = historicalPrefix(events, liveEvents);
    historyTurns = buildHistoricalTurns(history).filter(isVisibleTimelineTurn);
    const historicalUserMessages = history.filter((event) => event.type === "user_message").length;
    const nextFold = createLiveTimelineFold(historicalUserMessages);
    for (const event of liveEvents) nextFold.apply(event);
    fold = nextFold;
    processedLive = liveEvents.length;
  };

  return {
    update({ sessionId: nextSessionId, events, liveEvents }): TimelineTurn[] {
      const firstUser = liveEvents.find((event) => event.type === "message.user");
      const mustReset = fold === undefined
        || nextSessionId !== sessionId
        || events !== eventsRef
        || liveEvents.length < processedLive
        || firstUser !== firstLiveUser;
      if (mustReset) {
        sessionId = nextSessionId;
        eventsRef = events;
        firstLiveUser = firstUser;
        rebuild(events, liveEvents);
      } else if (liveEvents.length > processedLive && fold !== undefined) {
        for (let index = processedLive; index < liveEvents.length; index += 1) {
          const event = liveEvents[index];
          if (event) fold.apply(event);
        }
        processedLive = liveEvents.length;
      }
      const liveTurns = (fold ? fold.snapshot() : []).filter(isVisibleTimelineTurn);
      return [...historyTurns, ...liveTurns];
    }
  };
}

function latestAssistantContent(turn: TimelineTurn): string | undefined {
  return [...turn.steps].reverse().find((step): step is TimelineAssistantStep => step.kind === "assistant" && !step.summary)?.content;
}

function emptyTurn(id: string, timestamp?: string): TimelineTurn {
  return { id, user: "", assistant: "", reasoning: "", skills: [], status: "idle", tools: [], steps: [], timestamp };
}

function historicalTurnStatusSummary(event: Extract<SessionEvent, { type: "turn_status" }>): string {
  const summary = event.summary ?? `Task ended with status ${event.status} (${event.stopReason}).`;
  return event.requiredAction ? `${summary}\nRequired action: ${event.requiredAction}` : summary;
}

function appendHistoricalReasoning(turn: TimelineTurn, content: string | undefined): void {
  if (!content || turn.reasoning.endsWith(content)) return;
  turn.reasoning = appendReasoning(turn.reasoning, content);
  const previous = turn.steps.at(-1);
  if (previous?.kind === "reasoning") {
    previous.content = appendReasoning(previous.content, content);
    return;
  }
  turn.steps.push({ kind: "reasoning", id: `${turn.id}:reasoning:${String(turn.steps.filter((step) => step.kind === "reasoning").length)}`, content, completed: true });
}

function appendHistoricalAssistant(turn: TimelineTurn, content: string | undefined, summary = false): void {
  const visibleContent = summary ? activitySummaryText(content ?? "") : content;
  if (!visibleContent) return;
  // 去重要跨整个轮次：tool_call 事件会夹带当时的 assistant 段落作为 summary 步骤，
  // 中间隔着工具步骤，仅看相邻步骤挡不住同一段落反复出现（截图里的刷屏重复）。
  const summaryFlag = summary || undefined;
  const duplicated = turn.steps.some((step) =>
    step.kind === "assistant" && step.content === visibleContent && step.summary === summaryFlag);
  if (duplicated) return;
  turn.steps.push({ kind: "assistant", id: `${turn.id}:assistant:${String(turn.steps.filter((step) => step.kind === "assistant").length)}`, content: visibleContent, summary: summary || undefined });
}

/** 追加思考内容。已经以同样内容结尾时跳过：session 里同一段思考可能被重复记录。 */
function appendReasoning(existing: string, next: string | undefined): string {
  if (!next) return existing;
  if (!existing) return next;
  if (existing.endsWith(next)) return existing;
  return `${existing}\n\n${next}`;
}

/** “已使用技能”只认真实 invoke_skill 调用，不能把启动时全部可用路径投影成已使用。 */
function appendInvokedSkill(turn: TimelineTurn, tool: string, args: unknown): void {
  if (tool !== "invoke_skill" || typeof args !== "object" || args === null || !("skill" in args)) return;
  const skill = (args as { skill?: unknown }).skill;
  if (typeof skill === "string" && skill.trim() && !turn.skills.includes(skill.trim())) turn.skills.push(skill.trim());
}

function addReasoningDuration(total: number | undefined, startedAt: string | undefined, endedAt: string): number | undefined {
  if (!startedAt) return total;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return total;
  return (total ?? 0) + end - start;
}

function elapsedMs(startedAt: string | undefined, endedAt: string | undefined): number | undefined {
  if (!startedAt || !endedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined;
  return end - start;
}

function permissionFallback(toolCallId: string, tool: string): AgentPermissionEventRequest {
  return {
    toolCallId,
    tool,
    title: `允许执行 ${tool}`,
    details: "此权限请求已恢复。",
    requireFullYes: false,
    actionType: "unknown",
    riskLevel: "unknown"
  };
}

function resultFailed(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const record = result as Record<string, unknown>;
  return typeof record.error === "string"
    || (typeof record.exitCode === "number" && record.exitCode !== 0)
    || record.status === "failed"
    || record.status === "timed_out"
    || record.status === "aborted"
    || record.status === "denied";
}

function timelineToolStatus(
  result: unknown,
  executionStatus: "cancelled" | "succeeded" | "failed" | "unknown" | undefined
): TimelineToolStatus {
  if (executionStatus === "unknown") return "unknown";
  if (executionStatus === "cancelled") {
    return resultString(result, "status") === "skipped" ? "skipped" : "cancelled";
  }
  if (resultString(result, "status") === "skipped") return "skipped";
  if (executionStatus === "failed") return "failed";
  if (executionStatus === "succeeded") return "success";
  if (resultString(result, "status") === "recovered-success") return "success";
  return resultFailed(result) ? "failed" : "success";
}

// 只保留真实错误文本；「失败」本身由状态字形表达，不值得一段占位文案。
function resultError(result: unknown): string | undefined {
  return resultString(result, "error");
}

function resultString(result: unknown, key: string): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const value = (result as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function resultNumber(result: unknown, key: string): number | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const value = (result as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function applyToolResult(tool: TimelineTool, result: unknown): void {
  tool.result = result;
  tool.diff = tool.tool === "git_diff"
    ? resultString(result, "output")
    : resultString(result, "diffPreview");
  if (tool.command) tool.command.exitCode = resultNumber(result, "exitCode");
}

function toolStatus(tool: string, display: ToolInputDisplay | undefined): string {
  if (display?.kind === "command") return "正在运行命令";
  if (display?.kind === "file_io") {
    if (display.operation === "read") return "正在读取文件";
    if (display.operation === "write" || display.operation === "edit") return "正在修改文件";
    if (display.operation === "search" || display.operation === "grep") return "正在搜索项目";
    if (display.operation === "git") return "正在检查 Git 状态";
  }
  return `正在执行 ${tool}`;
}

function modelLabel(provider: string, model: string): string {
  return model === provider || model.startsWith(`${provider}-`) ? model : `${provider}/${model}`;
}

function historicalToolProjection(tool: string, args: unknown): { display?: ToolInputDisplay; path?: string } {
  const record = typeof args === "object" && args !== null ? args as Record<string, unknown> : undefined;
  const path = typeof record?.path === "string" ? record.path : undefined;
  const query = typeof record?.query === "string" ? record.query : undefined;
  if (tool === "read_file" || tool === "write_file" || tool === "edit_file") {
    const operation = tool === "read_file" ? "read" : tool === "write_file" ? "write" : "edit";
    return { path, display: { kind: "file_io", operation, path } };
  }
  if (tool === "search_files" || tool === "grep_search") {
    return {
      path: undefined,
      display: { kind: "file_io", operation: tool === "search_files" ? "search" : "grep", path: ".", detail: query }
    };
  }
  if (tool === "web_search") {
    return { path: undefined, display: query ? { kind: "generic", summary: query, detail: args } : undefined };
  }
  if (tool === "list_files") return { path: undefined, display: { kind: "file_io", operation: "list", path: "." } };
  if (tool === "git_diff" || tool === "git_status") {
    return { path: undefined, display: { kind: "file_io", operation: "git", path: ".", detail: tool === "git_diff" ? "git diff" : "git status --short" } };
  }
  return { path: undefined, display: undefined };
}

export function listChangedFiles(turn: TimelineTurn): TimelineChangedFile[] {
  const files = new Map<string, TimelineChangedFile>();
  for (const tool of turn.tools) {
    const operation = changedFileOperation(tool);
    const path = tool.path ?? (tool.display?.kind === "file_io" ? tool.display.path : undefined);
    if (!operation || !path || tool.status === "failed" || tool.status === "denied" || tool.status === "aborted" || tool.status === "cancelled" || tool.status === "skipped" || tool.status === "unknown") continue;
    files.set(path, {
      path,
      operation,
      status: tool.status === "success" ? "completed" : "writing"
    });
  }
  return [...files.values()];
}

export function listTimelineFiles(turns: TimelineTurn[]): TimelineChangedFile[] {
  const files = new Map<string, TimelineChangedFile>();
  for (const turn of turns) {
    for (const file of listChangedFiles(turn)) {
      if (file.status !== "completed") continue;
      files.delete(file.path);
      files.set(file.path, file);
    }
  }
  return [...files.values()].reverse();
}

function changedFileOperation(tool: TimelineTool): TimelineChangedFile["operation"] | undefined {
  if (tool.display?.kind === "file_io" && (tool.display.operation === "write" || tool.display.operation === "edit")) return tool.display.operation;
  if (tool.tool === "write_file") return "write";
  if (tool.tool === "edit_file") return "edit";
  return undefined;
}
