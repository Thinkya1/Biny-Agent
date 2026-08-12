/**
 * 权限风险识别模块。
 *
 * 这里只负责把工具调用归类为 actionType/riskLevel，并给出人可读 reason。是否允许执行由
 * PermissionManager 统一决定。
 */
import type { ActionType, PermissionRequestContext, RiskLevel } from "./PermissionManager.js";
import type { ToolRisk } from "../tools/types.js";
import { isProtectedCredentialPath } from "../utils/secrets.js";
import path from "node:path";

export type ToolName =
  | "read_file"
  | "read_tool_result"
  | "write_file"
  | "edit_file"
  | "multi_edit"
  | "delete_file"
  | "apply_patch"
  | "move_file"
  | "list_files"
  | "search_files"
  | "grep_search"
  | "git_status"
  | "git_diff"
  | "git_commit"
  | "run_command"
  | "start_process"
  | "process_status"
  | "read_process_output"
  | "stop_process"
  | "list_processes"
  | "web_search"
  | "web_fetch"
  | "update_todos";

export interface AnalyzePermissionInput {
  toolName: string;
  args: unknown;
  sessionId: string;
  projectRoot: string;
  toolRisk?: ToolRisk;
}

export function analyzePermissionRequest(input: AnalyzePermissionInput): PermissionRequestContext {
  const targetPath = normalizePermissionPath(getStringField(input.args, "path"));

  if (input.toolName === "read_file") {
    return {
      ...base(input),
      actionType: "read",
      riskLevel: isSensitivePath(targetPath) ? "critical" : "low",
      targetPath,
      reason: isSensitivePath(targetPath) ? "reads a sensitive file" : "reads a workspace file"
    };
  }

  if (input.toolName === "list_files" || input.toolName === "search_files" || input.toolName === "grep_search") {
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      reason: "searches or lists workspace files"
    };
  }

  if (input.toolName === "git_commit") {
    // 提交会改写仓库历史，且默认分支上不可静默撤销，始终按高风险确认。
    return {
      ...base(input),
      actionType: "git",
      riskLevel: "high",
      reason: "creates a git commit in this repository"
    };
  }

  if (input.toolName === "git_status" || input.toolName === "git_diff") {
    return {
      ...base(input),
      actionType: "git",
      riskLevel: "low",
      reason: input.toolName === "git_diff" ? "inspects git diff" : "inspects git status"
    };
  }

  if (input.toolName === "write_file" || input.toolName === "edit_file" || input.toolName === "multi_edit" || input.toolName === "apply_patch" || input.toolName === "move_file") {
    const moveTarget = input.toolName === "move_file" ? normalizePermissionPath(getStringField(input.args, "from")) : targetPath;
    return {
      ...base(input),
      actionType: "write",
      riskLevel: fileWriteRisk(moveTarget),
      targetPath: moveTarget,
      reason: fileWriteReason(moveTarget)
    };
  }

  if (input.toolName === "delete_file") {
    return {
      ...base(input),
      actionType: "delete",
      riskLevel: isSensitivePath(targetPath) ? "critical" : "high",
      targetPath,
      reason: isSensitivePath(targetPath) ? "deletes a sensitive file" : "deletes a workspace file"
    };
  }

  if (input.toolName === "run_command" || input.toolName === "start_process") {
    return analyzeCommand(input, getStringField(input.args, "command"));
  }

  if (input.toolName === "process_status" || input.toolName === "read_process_output" || input.toolName === "list_processes") {
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      reason: "inspects runtime-owned managed processes"
    };
  }

  if (input.toolName === "stop_process") {
    return {
      ...base(input),
      actionType: "shell",
      riskLevel: "medium",
      reason: "stops a runtime-owned managed process group"
    };
  }

  if (input.toolName === "delegate_task") {
    return {
      ...base(input),
      actionType: input.toolRisk === "execute" ? "shell" : "read",
      riskLevel: input.toolRisk === "execute" ? "medium" : "low",
      reason: input.toolRisk === "execute"
        ? "delegates a bounded workspace task with write and finite validation capabilities"
        : "delegates a bounded read-only repository investigation"
    };
  }

  if (input.toolName === "update_todos") {
    // 只写会话自己的计划清单，不碰工作区，也不触发任何外部动作。
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      reason: "records the assistant's own plan for this session"
    };
  }

  if (input.toolName === "web_fetch") {
    // 目标地址已过私网/环回/云元数据校验，与 web_search 同级：只读、不改本地状态。
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      reason: "fetches a public web page without changing local state"
    };
  }

  if (input.toolName === "web_search") {
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      reason: "searches the public web without changing local state"
    };
  }

  if (input.toolName === "invoke_skill" || input.toolName === "read_skill_resource") {
    // Skill 正文与资源都会在实际读取前重新校验路径、软链和硬链，按内置只读工具放行。
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      reason: "loads validated local skill instructions"
    };
  }

  if (input.toolName === "recall_memory") {
    // 记忆检索只读取全局 Biny 目录中当前项目分区内经过校验的文件。
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      reason: "searches the durable local project memory store"
    };
  }

  if (input.toolName === "save_memory") {
    // 只写入全局 Biny 目录中的当前项目分区（自动记忆抽取本就在无确认路径上写同一存储）。
    return {
      ...base(input),
      actionType: "write",
      riskLevel: "low",
      reason: "saves a redacted note to the durable local project memory store"
    };
  }

  if (input.toolName === "read_tool_result") {
    // 归档引用只指向本会话自己产出的工具结果，取回不比原始调用多暴露任何东西。
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      reason: "reads a tool result this session archived out of context"
    };
  }

  if (input.toolName === "mcp_list_resources" || input.toolName === "mcp_read_resource") {
    // MCP resources 是协议层只读数据，与 web_search 同级放行。
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      reason: "reads read-only resources exposed by connected MCP servers"
    };
  }

  if (input.toolRisk === "read") {
    return { ...base(input), actionType: "read", riskLevel: "medium", targetPath: targetPath || undefined, reason: "extension declares a read-only action" };
  }
  if (input.toolRisk === "write") {
    return { ...base(input), actionType: "write", riskLevel: "medium", targetPath: targetPath || undefined, reason: "extension declares a workspace-changing action" };
  }
  if (input.toolRisk === "execute") {
    return { ...base(input), actionType: "shell", riskLevel: "medium", targetPath: targetPath || undefined, reason: "extension declares an executable action" };
  }

  return {
    ...base(input),
    actionType: "unknown",
    riskLevel: "medium",
    targetPath: targetPath || undefined,
    reason: "unknown tool action"
  };
}

export function commandSafetyWarnings(command: string): string[] {
  const request = analyzeCommand({ toolName: "run_command", args: { command }, sessionId: "", projectRoot: "" }, command);
  if (request.riskLevel === "low") return [];
  return request.reason ? [request.reason] : ["command requires permission"];
}

function analyzeCommand(input: AnalyzePermissionInput, command: string): PermissionRequestContext {
  const normalized = command.toLowerCase().replace(/\s+/g, " ").trim();
  const critical = criticalCommandReason(normalized);
  if (critical) {
    return { ...base(input), actionType: commandAction(normalized, "critical"), riskLevel: "critical", command, reason: critical };
  }

  const high = highRiskCommandReason(normalized);
  if (high) {
    return { ...base(input), actionType: commandAction(normalized, "high"), riskLevel: "high", command, reason: high };
  }

  return {
    ...base(input),
    actionType: "shell",
    riskLevel: "medium",
    command,
    reason: testCommandReason(normalized) ?? "executes a shell command"
  };
}

function criticalCommandReason(command: string): string | undefined {
  if (/(^|[;&|]\s*)sudo(\s|$)/.test(command)) return "executes sudo";
  if (/(curl|wget)[^|;&]*\|\s*(sh|bash|zsh)\b/.test(command)) return "pipes a network script into a shell";
  if (/(^|[;&|]\s*)rm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)\b/.test(command)) return "recursively force deletes files";
  if (/(^|[;&|]\s*)git\s+push\b.*\s(--force|-f)(\s|$)/.test(command)) return "force pushes git history";
  return undefined;
}

function highRiskCommandReason(command: string): string | undefined {
  if (/(^|[;&|]\s*)rm(\s|$)/.test(command)) return "deletes files";
  if (/(^|[;&|]\s*)mv(\s|$)/.test(command)) return "moves or overwrites files";
  if (/(^|[;&|]\s*)chmod(\s|$)/.test(command)) return "changes file permissions";
  if (/(^|[;&|]\s*)chown(\s|$)/.test(command)) return "changes file ownership";
  if (/(^|[;&|]\s*)(npm|pnpm|yarn|bun)\s+(install|add|remove|update|upgrade)\b/.test(command)) return "changes dependencies";
  if (/(^|[;&|]\s*)git\s+(commit|push|reset|checkout|clean|rebase|merge)\b/.test(command)) return "changes git state";
  if (/(^|[;&|]\s*)(curl|wget)\b/.test(command)) return "accesses the network";
  if (/https?:\/\//.test(command)) return "accesses the network";
  return undefined;
}

function testCommandReason(command: string): string | undefined {
  if (/^(pnpm|npm|yarn|bun)\s+(test|run\s+test|typecheck|run\s+typecheck|lint|run\s+lint)\b/.test(command)) return "runs project checks";
  return undefined;
}

function commandAction(command: string, riskLevel: RiskLevel): ActionType {
  if (/(^|[;&|]\s*)rm(\s|$)/.test(command)) return "delete";
  if (/(^|[;&|]\s*)git\b/.test(command)) return "git";
  if (/(^|[;&|]\s*)(npm|pnpm|yarn|bun)\s+(install|add|remove|update|upgrade)\b/.test(command)) return "install";
  if (/(^|[;&|]\s*)(curl|wget)\b/.test(command) || /https?:\/\//.test(command)) return "network";
  return riskLevel === "critical" ? "shell" : "shell";
}

function fileWriteRisk(filePath: string): RiskLevel {
  if (isSensitivePath(filePath)) return "high";
  if (isShellProfile(filePath)) return "critical";
  if (isLockfile(filePath)) return "high";
  return "medium";
}

function fileWriteReason(filePath: string): string {
  if (isShellProfile(filePath)) return "modifies a shell profile";
  if (isSensitivePath(filePath)) return "modifies a sensitive file";
  if (isLockfile(filePath)) return "modifies a lockfile";
  return "modifies a workspace file";
}

function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  return isProtectedCredentialPath(normalized)
    || normalized === ".env"
    || normalized.startsWith(".env.")
    || normalized.startsWith(".ssh/")
    || normalized.endsWith("/.env")
    || normalized.includes("/.ssh/");
}

function isLockfile(filePath: string): boolean {
  return ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"].includes(filePath);
}

function isShellProfile(filePath: string): boolean {
  return [".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile"].includes(filePath);
}

function base(input: AnalyzePermissionInput): Pick<PermissionRequestContext, "toolName" | "sessionId" | "projectRoot"> {
  return {
    toolName: input.toolName,
    sessionId: input.sessionId,
    projectRoot: input.projectRoot
  };
}

function getStringField(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

function normalizePermissionPath(value: string): string {
  if (!value) return "";
  const normalized = path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
  return normalized === "." ? "" : normalized;
}
