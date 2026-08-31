/**
 * TaskRun 重试准入策略。
 *
 * 普通 TUI 继续是新的 user message；TaskRun retry 只允许 Host 对已经失败、
 * 且失败原因和副作用状态都能证明安全的 Attempt 发起。未知副作用不能通过
 * confirmation 绕过，因为这会把“可能已经执行”误当成“可以重新执行”。
 */
import type { TaskAttemptRecord, TaskRunWithAttempts } from "./TaskRunStore.js";

export const taskRetryableFailureClasses = [
  "RateLimit",
  "continuation_abandoned_before_provider_dispatch"
] as const;

export type TaskRetryableFailureClass = (typeof taskRetryableFailureClasses)[number];

export type TaskRetryRejectionCode =
  | "task_not_found"
  | "attempt_missing"
  | "task_not_failed"
  | "attempt_not_failed"
  | "failure_not_retryable"
  | "retry_safety_unknown"
  | "retry_safety_unsafe";

export type TaskRetryDecision =
  | {
    allowed: true;
    attempt: TaskAttemptRecord;
    failureClass: TaskRetryableFailureClass;
  }
  | {
    allowed: false;
    code: TaskRetryRejectionCode;
    reason: string;
  };

/**
 * 评估一次新的 TaskAttempt 是否可以从上一次失败继续。
 *
 * 这里故意只接受当前明确的两类基础设施失败：provider 限流，或已经
 * 证明发生在 provider dispatch 之前的 continuation abandonment。普通模型失败、
 * 工具失败、超时、取消和预算耗尽都必须由用户发新 prompt 或走专门恢复流程。
 */
export function evaluateTaskRetry(task: TaskRunWithAttempts | undefined): TaskRetryDecision {
  if (!task) {
    return { allowed: false, code: "task_not_found", reason: "TaskRun does not exist." };
  }
  const attempt = task.attempts.at(-1);
  if (!attempt) {
    return { allowed: false, code: "attempt_missing", reason: "TaskRun has no Attempt to retry." };
  }
  if (task.status !== "failed") {
    return {
      allowed: false,
      code: "task_not_failed",
      reason: `TaskRun status ${task.status} is not retryable; only failed TaskRuns may retry.`
    };
  }
  if (attempt.status !== "failed") {
    return {
      allowed: false,
      code: "attempt_not_failed",
      reason: `Latest TaskAttempt status ${attempt.status} is not retryable; only failed Attempts may retry.`
    };
  }
  const failureClass = readFailureClass(attempt.failure);
  if (!isTaskRetryableFailureClass(failureClass)) {
    return {
      allowed: false,
      code: "failure_not_retryable",
      reason: "Task retry requires failureClass RateLimit or proven continuation_abandoned_before_provider_dispatch."
    };
  }
  if (attempt.retrySafety === "unknown") {
    return {
      allowed: false,
      code: "retry_safety_unknown",
      reason: "Task retry is blocked because side effects are unknown; inspect the execution and submit a new prompt if needed."
    };
  }
  if (attempt.retrySafety === "unsafe") {
    return {
      allowed: false,
      code: "retry_safety_unsafe",
      reason: "Task retry is blocked because the previous Attempt may have side effects; confirmation cannot make a replay safe."
    };
  }
  return { allowed: true, attempt, failureClass };
}

function readFailureClass(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["failureClass", "failure_class", "taxonomy", "code", "kind"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return undefined;
}

function isTaskRetryableFailureClass(value: string | undefined): value is TaskRetryableFailureClass {
  return value !== undefined && (taskRetryableFailureClasses as readonly string[]).includes(value);
}
