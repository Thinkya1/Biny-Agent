/**
 * Agent 回合的轻量收口保护。
 *
 * Provider 的 stop 只表示一次响应结束，不能直接证明用户任务已经完成。这里只消费运行时
 * 已经确认的事实：工具失败/未知副作用和预算边界；文件/命令变更后的语义验收由独立的
 * completion review 负责。Todo 是模型可见的 advisory 状态，不能单独驱动运行时 continuation。
 */
import { createHash } from "node:crypto";
import { redactSecrets } from "../utils/secrets.js";
import { attemptCompletionToolName } from "../tools/completion.js";
import type { AgentToolEvent } from "./types.js";
import type { AgentUserMessage } from "./core/types.js";

const completionContinuationLimit = 6;
const stagnantContinuationLimit = 2;
/** 未声明完成的打回上限:提醒一次仍不声明就按现状收口,不无限纠缠。 */
const missingDeclarationNudgeLimit = 1;
/** 纯文本收尾里的"完成宣言";命中且本轮用过工具时,把收口升级为需要独立复核。 */
const completionClaimPattern = /(?:\b(?:done|fixed|completed|implemented|resolved|finished|all set)\b)|(?:已完成|完成了|修好了|修复了|搞定了|做完了|改好了|已实现|解决了)/iu;
const defaultMutationTools = new Set([
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "delete_file",
  "move_file",
  "run_command",
  "git_commit",
  "start_process"
]);

interface ActiveToolCall {
  tool: string;
  args: unknown;
}

interface FailedToolCall {
  tool: string;
  actionFingerprint: string;
  error: string;
  permissionDenied: boolean;
}

export interface CompletionGuardSnapshot {
  version: 1;
  reviewRequired: boolean;
  continuationAttempts: number;
  stagnantAttempts: number;
  lastBlockFingerprint: string;
  failedToolCalls: Array<{
    tool: string;
    actionFingerprint: string;
    error: string;
    permissionDenied: boolean;
  }>;
  unknownToolCalls: string[];
  /** 以下字段旧快照可能缺失,解析时按未声明/未用工具/未提醒补齐。 */
  completionDeclared: boolean;
  sawAnyTool: boolean;
  missingDeclarationNudges: number;
}

export type CompletionGuardDecision =
  | { kind: "complete" }
  | { kind: "continue"; feedback: AgentUserMessage }
  | { kind: "incomplete"; summary: string; stopReason: "hard_step_limit" | "tool_call_limit" | "repeated_action_limit" | "budget_exhausted" | "missing_terminal_event" }
  | { kind: "failed"; summary: string; stopReason: "missing_terminal_event" }
  | { kind: "blocked"; summary: string; blockedReason: "permission_denied" | "unsafe_action_required"; requiredAction: string };

export interface CompletionGuardInput {
  steps: number;
  hardStepLimit: number;
  accountedToolCalls: number;
  maxToolCalls: number;
  maxRepeatedActionCount: number;
  maxRepeatedActions: number;
  finishReason?: string;
  /** plan 等只读模式不要求显式完成声明;缺省 false 保持旧行为。 */
  explicitCompletionExpected?: boolean;
}

/** 解析断点中的完成证据；未知版本按没有证据处理，不阻塞旧 session。 */
export function parseCompletionGuardSnapshot(value: unknown): CompletionGuardSnapshot | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (
    typeof value.reviewRequired !== "boolean"
    || !isNonNegativeInteger(value.continuationAttempts)
    || !isNonNegativeInteger(value.stagnantAttempts)
    || typeof value.lastBlockFingerprint !== "string"
    || !Array.isArray(value.failedToolCalls)
    || !Array.isArray(value.unknownToolCalls)
  ) return undefined;
  const failedToolCalls = value.failedToolCalls.flatMap((item): CompletionGuardSnapshot["failedToolCalls"] => {
    if (!isRecord(item)) return [];
    if (
      typeof item.tool !== "string"
      || typeof item.actionFingerprint !== "string"
      || typeof item.error !== "string"
      || typeof item.permissionDenied !== "boolean"
    ) return [];
    return [{
      tool: item.tool,
      actionFingerprint: item.actionFingerprint,
      error: item.error,
      permissionDenied: item.permissionDenied
    }];
  });
  if (failedToolCalls.length !== value.failedToolCalls.length) return undefined;
  if (!value.unknownToolCalls.every((item): item is string => typeof item === "string")) return undefined;
  return {
    version: 1,
    reviewRequired: value.reviewRequired,
    continuationAttempts: value.continuationAttempts,
    stagnantAttempts: value.stagnantAttempts,
    lastBlockFingerprint: value.lastBlockFingerprint,
    failedToolCalls,
    unknownToolCalls: [...new Set(value.unknownToolCalls)],
    completionDeclared: value.completionDeclared === true,
    sawAnyTool: value.sawAnyTool === true,
    missingDeclarationNudges: isNonNegativeInteger(value.missingDeclarationNudges) ? value.missingDeclarationNudges : 0
  };
}

export class CompletionGuard {
  private readonly mutationTools: ReadonlySet<string>;
  private reviewRequired = false;
  private continuationAttempts = 0;
  private stagnantAttempts = 0;
  private lastBlockFingerprint = "";
  private completionDeclared = false;
  private sawAnyTool = false;
  private missingDeclarationNudges = 0;
  private readonly activeTools = new Map<string, ActiveToolCall>();
  private readonly failedToolCalls = new Map<string, FailedToolCall>();
  private readonly unknownToolCalls = new Set<string>();

  constructor(initial?: CompletionGuardSnapshot, mutationToolNames?: Iterable<string>) {
    this.mutationTools = new Set(mutationToolNames ?? defaultMutationTools);
    if (!initial) return;
    this.reviewRequired = initial.reviewRequired;
    this.continuationAttempts = initial.continuationAttempts;
    this.stagnantAttempts = initial.stagnantAttempts;
    this.lastBlockFingerprint = initial.lastBlockFingerprint;
    this.completionDeclared = initial.completionDeclared;
    this.sawAnyTool = initial.sawAnyTool;
    this.missingDeclarationNudges = initial.missingDeclarationNudges;
    for (const failure of initial.failedToolCalls) {
      this.failedToolCalls.set(failureKey(failure.tool, failure.actionFingerprint), { ...failure });
    }
    for (const tool of initial.unknownToolCalls) this.unknownToolCalls.add(tool);
  }

  /** 文件/命令副作用只表示需要独立验收，不等于任务已经失败或完成。 */
  requiresSemanticReview(): boolean {
    return this.reviewRequired;
  }

  /** 只读跑了一轮却直接用文字宣称"做完了":升级为需要独立复核,专抓口头收工。 */
  noteTextCompletionClaim(text: string): void {
    if (!this.sawAnyTool || this.reviewRequired) return;
    if (completionClaimPattern.test(text)) this.reviewRequired = true;
  }

  observeToolEvent(event: AgentToolEvent): void {
    if (event.type === "tool.started") {
      this.activeTools.set(event.toolCallId, { tool: event.tool, args: event.args });
      // 计划/声明这类控制面工具不算"干过活",避免纯规划回合也被要求补完成声明。
      if (event.tool !== attemptCompletionToolName && event.tool !== "update_todos") {
        this.sawAnyTool = true;
      }
      if (this.mutationTools.has(event.tool)) {
        this.reviewRequired = true;
      }
      if (event.tool === attemptCompletionToolName) {
        // 声明完成即主动要求验收:无论是否用过变更工具,都触发一次独立复核。
        this.completionDeclared = true;
        this.reviewRequired = true;
      }
      return;
    }
    if (event.type === "tool.progress") return;

    const active = this.activeTools.get(event.toolCallId);
    this.activeTools.delete(event.toolCallId);
    const actionFingerprint = active
      ? toolActionFingerprint(active.tool, active.args)
      : `call:${event.toolCallId}`;
    if (event.executionStatus === "unknown") {
      this.unknownToolCalls.add(event.tool);
      return;
    }
    if (event.type === "tool.failed" || event.executionStatus === "failed" || event.executionStatus === "cancelled") {
      const error = event.type === "tool.failed" ? event.error : `Tool ${event.tool} did not finish successfully.`;
      this.failedToolCalls.set(failureKey(event.tool, actionFingerprint), {
        tool: event.tool,
        actionFingerprint,
        error: safeError(error),
        permissionDenied: permissionWasDenied(event.result)
      });
      return;
    }

    if (!active) return;
    for (const [key, failure] of this.failedToolCalls) {
      if (failure.actionFingerprint === actionFingerprint) this.failedToolCalls.delete(key);
    }
  }

  decide(input: CompletionGuardInput): CompletionGuardDecision {
    if (input.steps >= input.hardStepLimit) {
      return {
        kind: "incomplete",
        stopReason: "hard_step_limit",
        summary: `已达到本轮运行的硬步数上限（${String(input.hardStepLimit)} 步）。`
      };
    }
    if (input.accountedToolCalls >= input.maxToolCalls) {
      return {
        kind: "incomplete",
        stopReason: "tool_call_limit",
        summary: `已达到本轮运行的工具调用上限（${String(input.maxToolCalls)} 次）。`
      };
    }
    if (input.maxRepeatedActionCount >= input.maxRepeatedActions) {
      return {
        kind: "incomplete",
        stopReason: "repeated_action_limit",
        summary: `同一工具操作的重复次数达到上限（${String(input.maxRepeatedActions)} 次）。`
      };
    }
    if (input.finishReason === "error" || input.finishReason === "aborted" || input.finishReason === "length") {
      return { kind: "complete" };
    }
    if (input.finishReason !== undefined && input.finishReason !== "stop") {
      return this.continueOrStop(
        `The model response ended with the non-terminal reason ${input.finishReason}. Inspect the current task state and continue if work remains.`,
        `finish:${input.finishReason}`
      );
    }

    if (this.unknownToolCalls.size > 0) {
      if (this.continuationAttempts > 0) {
        return {
          kind: "blocked",
          summary: `以下工具操作可能产生了未确认的副作用：${[...this.unknownToolCalls].join("、")}。`,
          blockedReason: "unsafe_action_required",
          requiredAction: "Inspect the session facts and workspace before deciding whether the unresolved operation completed; then start a new turn."
        };
      }
      return this.continueOrStop(
        `These tool operations may have produced an unresolved side effect: ${[...this.unknownToolCalls].join(", ")}. Inspect their structured result before claiming completion.`,
        `unknown:${[...this.unknownToolCalls].sort().join(",")}`
      );
    }

    const permissionFailure = [...this.failedToolCalls.values()].find((failure) => failure.permissionDenied);
    if (permissionFailure) {
      return {
        kind: "blocked",
        summary: `工具 ${permissionFailure.tool} 未获批准，无法确认请求的工作已完成。`,
        blockedReason: "permission_denied",
        requiredAction: "Approve the required action or revise the request, then start a new turn."
      };
    }
    if (this.failedToolCalls.size > 0) {
      const failures = [...this.failedToolCalls.values()]
        .map((failure) => `${failure.tool}: ${failure.error}`)
        .join("; ");
      return this.continueOrStop(
        `Tool failures still need resolution: ${failures}`,
        `failures:${[...this.failedToolCalls.keys()].sort().join(",")}`
      );
    }

    // 软强制显式收尾:动过文件/命令(或文字宣言已被升级为待复核)却只纯文本停下、没声明完成
    // → 打回一次要求补声明。只提醒一次:坚持不声明就按现状收口,交给独立复核兜底,不无限纠缠。
    // 纯只读的中性回答(没变更也没宣称完成)直接放行,不打扰问答型回合。
    if (
      input.explicitCompletionExpected === true
      && this.sawAnyTool
      && this.reviewRequired
      && !this.completionDeclared
      && this.missingDeclarationNudges < missingDeclarationNudgeLimit
    ) {
      this.missingDeclarationNudges += 1;
      return {
        kind: "continue",
        feedback: {
          role: "user",
          content: [
            "## Biny completion review",
            "",
            "You used tools this run but have not declared completion. If the task is done, call attempt_completion with a concise summary and the concrete evidence; otherwise continue the remaining work.",
            "A plain-text stop without that declaration is not treated as a confirmed finish."
          ].join("\n")
        }
      };
    }

    return { kind: "complete" };
  }

  /** 供独立 completion review 在确认目标未满足时复用有界 continuation。 */
  requestContinuation(reason: string, fingerprint: string): CompletionGuardDecision {
    return this.continueOrStop(reason, fingerprint);
  }

  snapshot(): CompletionGuardSnapshot {
    return {
      version: 1,
      reviewRequired: this.reviewRequired,
      continuationAttempts: this.continuationAttempts,
      stagnantAttempts: this.stagnantAttempts,
      lastBlockFingerprint: this.lastBlockFingerprint,
      failedToolCalls: [...this.failedToolCalls.values()].map((failure) => ({ ...failure })),
      unknownToolCalls: [...this.unknownToolCalls].sort(),
      completionDeclared: this.completionDeclared,
      sawAnyTool: this.sawAnyTool,
      missingDeclarationNudges: this.missingDeclarationNudges
    };
  }

  private continueOrStop(reason: string, fingerprint: string): CompletionGuardDecision {
    if (fingerprint === this.lastBlockFingerprint) this.stagnantAttempts += 1;
    else this.stagnantAttempts = 0;
    this.lastBlockFingerprint = fingerprint;
    if (this.stagnantAttempts >= stagnantContinuationLimit || this.continuationAttempts >= completionContinuationLimit) {
      return {
        kind: "incomplete",
        stopReason: "budget_exhausted",
        summary: "多次续跑后仍无法确认任务完成。"
      };
    }
    this.continuationAttempts += 1;
    return {
      kind: "continue",
      feedback: {
        role: "user",
        content: [
          "## Biny completion review",
          "",
          reason,
          "Continue the same user task now. Do not report completion while any required work or unresolved tool result remains."
        ].join("\n")
      }
    };
  }
}

function toolActionFingerprint(tool: string, args: unknown): string {
  return createHash("sha256")
    .update(tool)
    .update("\0")
    .update(stableValue(args))
    .digest("hex");
}

function failureKey(tool: string, actionFingerprint: string): string {
  return `${tool}\0${actionFingerprint}`;
}

function permissionWasDenied(result: unknown): boolean {
  if (!isRecord(result)) return false;
  return result.approved === false || result.status === "denied" || result.status === "permission_required";
}

function safeError(value: string): string {
  return redactSecrets(value).replace(/\s+/gu, " ").trim().slice(0, 500);
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`).join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
