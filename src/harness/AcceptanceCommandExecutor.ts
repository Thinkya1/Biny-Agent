/**
 * 验收命令的受控执行边界。
 *
 * AcceptanceVerifier 只声明“重新执行哪条命令”，这里复用普通工具的路径约束、权限判断、
 * 资源调度和 sandbox。自动发现的 package/Maven 脚本也必须经过同一权限 gate，不能因为
 * 它来自 Verifier 就绕过默认 ask 策略。
 */
import { createHash, randomUUID } from "node:crypto";
import type { SandboxConfig } from "../config/schema.js";
import { isFullYesConfirmation } from "../permission/confirmation.js";
import {
  type PermissionPrompt,
  PermissionManager,
  type PermissionResult
} from "../permission/PermissionManager.js";
import { analyzePermissionRequest } from "../permission/policy.js";
import { ToolAccesses } from "../tools/access.js";
import { createToolPermissionRequest } from "../tools/display/ToolDisplay.js";
import {
  createRunCommandTool,
  type RunCommandResult
} from "../tools/shell/runCommand.js";
import { ToolScheduler } from "../tools/scheduler.js";
import { createToolOperationId } from "../tools/types.js";
import {
  resolveWorkspaceDirectory,
  toWorkspaceRelative
} from "../workspace/resolvePath.js";

export interface AcceptanceCommandRequest {
  criterionId: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  description?: string;
}

export interface AcceptanceCommandResult {
  status: "completed" | "failed" | "timed_out";
  sandbox?: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
  /** Session JSONL 中保存完整命令结果的 tool_call id。 */
  evidenceToolCallId?: string;
}

export interface AcceptanceCommandExecutor {
  execute(request: AcceptanceCommandRequest): Promise<AcceptanceCommandResult>;
}

export type AcceptanceCommandFailureKind =
  | "permission_required"
  | "permission_denied"
  | "execution_error";

export type AcceptanceCommandAuditEvent =
  | {
      type: "command.started";
      toolCallId: string;
      request: AcceptanceCommandRequest;
      permissionRequest: PermissionPrompt;
    }
  | {
      type: "command.completed";
      toolCallId: string;
      request: AcceptanceCommandRequest;
      permissionRequest: PermissionPrompt;
      result: AcceptanceCommandResult;
    }
  | {
      type: "command.failed";
      toolCallId: string;
      request: AcceptanceCommandRequest;
      permissionRequest?: PermissionPrompt;
      failureKind: AcceptanceCommandFailureKind;
      error: string;
    };

export interface ControlledAcceptanceCommandExecutorOptions {
  workspaceRoot: string;
  ignore?: string[];
  /** 必须显式传入运行配置，避免 Verifier 因漏配悄悄退回无沙箱执行。 */
  sandbox: SandboxConfig;
  permissionManager: PermissionManager;
  sessionId: string;
  /**
   * 默认 ask 下必须由宿主显式注入审批通道。没有审批通道时安全拒绝，不能在后台验证阶段
   * 临时读取 stdin，也不能把自动发现的脚本当成可信命令。
   */
  confirmPermission?(request: PermissionPrompt): Promise<PermissionResult>;
  maxConcurrency?: number;
  maxQueuedCommands?: number;
  /** 权限通过后、命令真正执行前捕获工作区事实基线。 */
  beforeCommandExecution?(request: AcceptanceCommandRequest): void | Promise<void>;
  onAuditEvent?(event: AcceptanceCommandAuditEvent): void | Promise<void>;
}

export class AcceptanceCommandPermissionError extends Error {
  constructor(
    message: string,
    readonly failureKind: Exclude<AcceptanceCommandFailureKind, "execution_error">
  ) {
    super(message);
    this.name = "AcceptanceCommandPermissionError";
  }
}

/**
 * 创建一个可跨多条验收条件复用的执行器。AcceptanceVerifier 当前按条件顺序执行；调度器仍
 * 保留资源声明，避免未来并行验证或多个消费者共享执行器时破坏普通工具的并发约束。
 */
export function createControlledAcceptanceCommandExecutor(
  options: ControlledAcceptanceCommandExecutorOptions
): AcceptanceCommandExecutor {
  const ignore = options.ignore ?? [];
  const scheduler = new ToolScheduler<RunCommandResult>({
    maxConcurrency: options.maxConcurrency ?? 1,
    maxQueuedTasks: options.maxQueuedCommands ?? 64
  });

  return {
    async execute(request): Promise<AcceptanceCommandResult> {
      request.signal?.throwIfAborted();
      if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1) {
        throw new RangeError("Acceptance command timeoutMs must be a positive safe integer.");
      }

      const toolCallId = `verification:${request.criterionId}:${randomUUID()}`;
      let permissionRequest: PermissionPrompt | undefined;
      let auditStarted = false;
      try {
        const cwd = resolveWorkspaceDirectory(options.workspaceRoot, request.cwd, ignore);
        const args = {
          command: request.command,
          cwd: toWorkspaceRelative(options.workspaceRoot, cwd)
        };
        const tool = createRunCommandTool(
          { workspaceRoot: options.workspaceRoot, ignore },
          options.sandbox,
          { timeoutMs: request.timeoutMs }
        );
        const execution = await tool.resolveExecution(args);
        if ("isError" in execution) throw new Error(execution.errorMessage);

        const permissionContext = analyzePermissionRequest({
          toolName: tool.name,
          args,
          sessionId: options.sessionId,
          projectRoot: options.workspaceRoot,
          toolRisk: tool.risk
        });
        permissionRequest = await createToolPermissionRequest({
          id: toolCallId,
          name: tool.name,
          args
        }, {
          workspaceRoot: options.workspaceRoot,
          ignore,
          sessionId: options.sessionId
        }, permissionContext);
        permissionRequest = {
          ...permissionRequest,
          approvalRule: approvalFingerprint(execution.approvalRule, args),
          reason: execution.description ?? permissionRequest.reason
        };

        await options.onAuditEvent?.({
          type: "command.started",
          toolCallId,
          request,
          permissionRequest
        });
        auditStarted = true;

        const evaluation = options.permissionManager.evaluate(permissionRequest);
        if (evaluation.decision === "deny") {
          options.permissionManager.applyResult(permissionRequest, {
            approved: false,
            message: evaluation.reason
          });
          throw new AcceptanceCommandPermissionError(
            `Verification command was denied: ${evaluation.reason}`,
            "permission_denied"
          );
        }

        if (evaluation.decision === "ask") {
          if (!options.confirmPermission) {
            const message = "Verification command requires explicit approval, but no approval handler is available.";
            options.permissionManager.applyResult(permissionRequest, {
              approved: false,
              message
            });
            throw new AcceptanceCommandPermissionError(
              message,
              "permission_required"
            );
          }
          request.signal?.throwIfAborted();
          const answer = validateStrongConfirmation(
            permissionRequest,
            await options.confirmPermission(permissionRequest)
          );
          request.signal?.throwIfAborted();
          options.permissionManager.applyResult(permissionRequest, answer);
          if (!answer.approved) {
            throw new AcceptanceCommandPermissionError(
              `Verification command was not approved: ${answer.message ?? "Denied by user."}`,
              "permission_denied"
            );
          }
        } else {
          options.permissionManager.applyResult(permissionRequest, {
            approved: true,
            scope: "once"
          });
        }

        await options.beforeCommandExecution?.(request);
        const commandResult = await scheduler.schedule({
          accesses: execution.accesses ?? ToolAccesses.all(),
          signal: request.signal,
          start: async () => {
            request.signal?.throwIfAborted();
            return await execution.execute({
              toolCallId,
              operationId: createToolOperationId(options.sessionId, toolCallId),
              signal: request.signal
            });
          }
        });
        const result: AcceptanceCommandResult = {
          ...commandResult,
          evidenceToolCallId: toolCallId
        };
        await options.onAuditEvent?.({
          type: "command.completed",
          toolCallId,
          request,
          permissionRequest,
          result
        });
        return result;
      } catch (error) {
        if (auditStarted) {
          await options.onAuditEvent?.({
            type: "command.failed",
            toolCallId,
            request,
            permissionRequest,
            failureKind: error instanceof AcceptanceCommandPermissionError
              ? error.failureKind
              : "execution_error",
            error: errorMessage(error)
          });
        }
        throw error;
      }
    }
  };
}

function validateStrongConfirmation(
  request: PermissionPrompt,
  result: PermissionResult
): PermissionResult {
  if (
    !request.requireFullYes
    || !result.approved
    || isFullYesConfirmation(result.confirmation ?? "")
  ) return result;
  return {
    approved: false,
    action: "deny",
    scope: "once",
    message: "Full yes confirmation was not provided.",
    confirmation: result.confirmation
  };
}

function approvalFingerprint(approvalRule: string, args: unknown): string {
  return createHash("sha256")
    .update(`${approvalRule}\0${stableJson(args)}`)
    .digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
