/**
 * 在途回合状态模块。
 *
 * session JSONL 记的是已经发生的事实，它能重放出历史，但重放不出"这个回合还没跑完"。
 * 之前一个回合被异常打断（进程退出、断网、Ctrl+C）就整个作废，哪怕前面 20 步的工具调用
 * 都成功了 —— 那些 token 全部白烧。
 *
 * 循环拿回自己手里之后，步与步之间有了落盘的位置。这里存的就是每步结束时的完整 context：
 * 下次启动发现它还在，就能从最后一个完成的步继续，而不是从头再来。
 *
 * 工具步之间保存实际已用步数；blocked 或可恢复的 incomplete 终态用 0 保存，表示只有用户
 * 显式恢复请求后才开启一个新预算窗口。正常 completed、cancelled、failed 或新根回合会清掉。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentMessage } from "../agent/core/types.js";
import type { ToolExecutionState, ToolRetrySafety } from "../tools/types.js";
import type { RuntimeHighWater } from "./runtimeEvent.js";
import { agentDir, ensureAgentDirs } from "./store.js";

const turnStateVersion = 4;

export interface InterruptedTurn {
  sessionId: string;
  /** 同一个用户任务及其所有 continuation 共用的身份。旧断点可能没有该字段。 */
  turnId?: string;
  /** 触发这个回合的用户输入，用于向用户描述要续跑的是什么。 */
  prompt: string;
  /** 最后一个完成的步结束时的完整 context。 */
  systemPrompt?: string;
  messages: AgentMessage[];
  completedSteps: number;
  /** 工具执行预算快照；仅用于在途回合恢复时继续计算工具额度。 */
  facts?: unknown;
  /** blocked / incomplete 终态的恢复边界；普通工具步断点没有该字段。 */
  terminal?: InterruptedTurnTerminal;
  /** 同一 Turn 续跑前已经发生的终态；新预算窗口不能覆盖原终态。 */
  previousTerminals?: InterruptedTurnTerminal[];
  /** 只记录恢复审计需要的工具断点，不作为会话事实的替代。 */
  lastToolSequence?: number;
  pendingToolExecutions?: InterruptedToolExecutionCheckpoint[];
  /** 最后一个已写入 session JSONL 的 runtime event 高水位。 */
  runtimeHighWater?: RuntimeHighWater;
  updatedAt: string;
}

export interface InterruptedToolExecutionCheckpoint {
  tool: string;
  toolCallId: string;
  sequence: number;
  operationId: string;
  state: ToolExecutionState;
  evidence?: string;
  retrySafety?: ToolRetrySafety;
}

export interface InterruptedTurnTerminal {
  status: "blocked" | "incomplete";
  stopReason: string;
  summary: string;
  blockedReason?: string;
  requiredAction?: string;
}

export class TurnStore {
  constructor(private readonly persistenceRoot: string, private readonly sessionId: string) {}

  async save(
    prompt: string,
    systemPrompt: string | undefined,
    messages: readonly AgentMessage[],
    completedSteps: number,
    facts?: unknown,
    terminal?: InterruptedTurnTerminal,
    previousTerminals?: readonly InterruptedTurnTerminal[],
    pendingToolExecutions?: readonly InterruptedToolExecutionCheckpoint[],
    runtimeHighWater?: RuntimeHighWater
  ): Promise<void> {
    await ensureAgentDirs(this.persistenceRoot);
    const payload: InterruptedTurn = {
      sessionId: this.sessionId,
      turnId: runtimeHighWater?.turnId,
      prompt,
      systemPrompt,
      messages: [...messages],
      completedSteps,
      facts,
      terminal,
      previousTerminals: previousTerminals ? [...previousTerminals] : undefined,
      lastToolSequence: pendingToolExecutions?.reduce((maximum, checkpoint) => Math.max(maximum, checkpoint.sequence), 0) || undefined,
      pendingToolExecutions: pendingToolExecutions?.length ? [...pendingToolExecutions] : undefined,
      runtimeHighWater,
      updatedAt: new Date().toISOString()
    };
    const target = this.filePath();
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ version: turnStateVersion, turn: payload })}\n`, { encoding: "utf8", mode: 0o600 });
    const handle = await fs.open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
  }

  async load(): Promise<InterruptedTurn | undefined> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.filePath(), "utf8"));
      const version = (parsed as { version?: unknown }).version;
      if (version !== turnStateVersion && version !== 3 && version !== 2) return undefined;
      const turn = (parsed as { turn?: unknown }).turn;
      return isInterruptedTurn(turn) ? turn : undefined;
    } catch {
      return undefined;
    }
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath(), { force: true });
  }

  private filePath(): string {
    return path.join(agentDir(this.persistenceRoot), "turns", `${this.sessionId}.json`);
  }
}

/** 删除会话对应的在途回合旁路状态，供统一 session 生命周期清理使用。 */
export async function deleteInterruptedTurn(persistenceRoot: string, sessionId: string): Promise<void> {
  await new TurnStore(persistenceRoot, sessionId).clear();
}

function isInterruptedTurn(value: unknown): value is InterruptedTurn {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<InterruptedTurn>;
  return typeof candidate.sessionId === "string"
    && (candidate.turnId === undefined || typeof candidate.turnId === "string" && candidate.turnId.length > 0)
    && typeof candidate.prompt === "string"
    && (candidate.systemPrompt === undefined || typeof candidate.systemPrompt === "string")
    && Array.isArray(candidate.messages)
    && candidate.messages.length > 0
    && candidate.messages.every(isAgentMessage)
    && Number.isSafeInteger(candidate.completedSteps)
    && (candidate.completedSteps ?? -1) >= 0
    && (candidate.terminal === undefined || isInterruptedTurnTerminal(candidate.terminal))
    && (candidate.previousTerminals === undefined
      || Array.isArray(candidate.previousTerminals)
      && candidate.previousTerminals.every(isInterruptedTurnTerminal))
    && (candidate.lastToolSequence === undefined || Number.isSafeInteger(candidate.lastToolSequence) && candidate.lastToolSequence >= 0)
    && (candidate.pendingToolExecutions === undefined
      || Array.isArray(candidate.pendingToolExecutions)
      && candidate.pendingToolExecutions.every(isInterruptedToolExecutionCheckpoint))
    && (candidate.runtimeHighWater === undefined || isRuntimeHighWater(candidate.runtimeHighWater))
    && typeof candidate.updatedAt === "string";
}

function isRuntimeHighWater(value: unknown): value is RuntimeHighWater {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<RuntimeHighWater>;
  return typeof candidate.eventId === "string"
    && candidate.eventId.length > 0
    && Number.isSafeInteger(candidate.eventSeq)
    && (candidate.eventSeq ?? 0) > 0
    && (candidate.runId === undefined || typeof candidate.runId === "string" && candidate.runId.length > 0)
    && (candidate.turnId === undefined || typeof candidate.turnId === "string" && candidate.turnId.length > 0);
}

function isInterruptedToolExecutionCheckpoint(value: unknown): value is InterruptedToolExecutionCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<InterruptedToolExecutionCheckpoint>;
  return typeof candidate.tool === "string"
    && typeof candidate.toolCallId === "string"
    && Number.isSafeInteger(candidate.sequence)
    && (candidate.sequence ?? -1) >= 0
    && typeof candidate.operationId === "string"
    && (candidate.state === "not_started"
      || candidate.state === "running"
      || candidate.state === "admitted"
      || candidate.state === "side_effect_committed"
      || candidate.state === "cancel_requested"
      || candidate.state === "cancelled"
      || candidate.state === "succeeded"
      || candidate.state === "failed"
      || candidate.state === "unknown")
    && (candidate.evidence === undefined || typeof candidate.evidence === "string")
    && (candidate.retrySafety === undefined
      || candidate.retrySafety === "safe"
      || candidate.retrySafety === "idempotent"
      || candidate.retrySafety === "unsafe"
      || candidate.retrySafety === "unknown");
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.role === "user") {
    return typeof message.content === "string"
      || Array.isArray(message.content) && message.content.every(isUserContent);
  }
  if (message.role === "assistant") {
    return Array.isArray(message.content) && message.content.every((part) => {
      if (typeof part !== "object" || part === null) return false;
      const content = part as Record<string, unknown>;
      if (content.type === "text" || content.type === "reasoning") return typeof content.text === "string";
      return content.type === "toolCall"
        && typeof content.id === "string"
        && typeof content.name === "string"
        && typeof content.arguments === "object"
        && content.arguments !== null
        && !Array.isArray(content.arguments);
    });
  }
  return message.role === "toolResult"
    && typeof message.toolCallId === "string"
    && typeof message.toolName === "string"
    && Array.isArray(message.content)
    && message.content.every(isToolResultContent);
}

function isUserContent(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const content = value as Record<string, unknown>;
  if (content.type === "text") return typeof content.text === "string";
  return (content.type === "image" || content.type === "audio")
    && typeof content.data === "string"
    && typeof content.mimeType === "string";
}

function isToolResultContent(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const content = value as Record<string, unknown>;
  if (content.type === "text") return typeof content.text === "string";
  return content.type === "image"
    && typeof content.data === "string"
    && typeof content.mimeType === "string";
}

function isInterruptedTurnTerminal(value: unknown): value is InterruptedTurnTerminal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<InterruptedTurnTerminal>;
  return (candidate.status === "blocked" || candidate.status === "incomplete")
    && typeof candidate.stopReason === "string"
    && Boolean(candidate.stopReason)
    && typeof candidate.summary === "string"
    && Boolean(candidate.summary)
    && (candidate.blockedReason === undefined || typeof candidate.blockedReason === "string")
    && (candidate.requiredAction === undefined || typeof candidate.requiredAction === "string");
}
