/**
 * 权限命令模块。
 *
 * 这里实现 /permissions 的纯逻辑：查看状态、切换当前会话模式、重置 session
 * allowlist。TUI/CLI 只负责把返回文本展示出来。
 */
import type { PermissionManager, PermissionStatus } from "./PermissionManager.js";

export function runPermissionCommand(manager: PermissionManager, args: string[]): string {
  const subcommand = (args[0] ?? "status").toLowerCase();

  if (subcommand === "status" || subcommand === "policy" || subcommand === "show") {
    return formatPermissionStatus(manager.getStatus());
  }

  if (subcommand === "readonly" || subcommand === "read-only") {
    manager.setMode("read-only");
    return formatPermissionModeChanged(manager.getStatus().mode);
  }

  if (subcommand === "ask" || subcommand === "ask-before-write") {
    manager.setMode("ask");
    return formatPermissionModeChanged(manager.getStatus().mode);
  }

  if (subcommand === "auto") {
    manager.setMode("auto");
    return formatPermissionModeChanged(manager.getStatus().mode);
  }

  if (subcommand === "full" || subcommand === "full-access") {
    manager.setMode("full-access");
    return formatPermissionModeChanged(manager.getStatus().mode);
  }

  if (subcommand === "reset") {
    manager.resetSession();
    return `Session permissions reset.\n\n${formatPermissionStatus(manager.getStatus())}`;
  }

  return [
    `Unknown permissions command: ${subcommand}`,
    "",
    formatPermissionCommandHelp()
  ].join("\n");
}

export function formatPermissionModeChanged(mode: PermissionStatus["mode"]): string {
  return `Permission mode switched to ${formatMode(mode)}.`;
}

export function formatPermissionStatus(status: PermissionStatus): string {
  return [
    "Permissions",
    `Mode: ${formatMode(status.mode)}`,
    `Project policy: ${status.projectPolicySource ?? "default"}`,
    "",
    `Session allowed tools: ${formatList(status.sessionAllowTools)}`,
    `Session allowed paths: ${formatList(status.sessionAllowPaths)}`,
    `Session allowed commands: ${formatList(status.allowedCommands)}`,
    `Session allowed action types: ${formatList(status.allowedActions)}`,
    "",
    `Project allowed tools: ${formatList(status.projectAllowTools)}`,
    `Project allowed paths: ${formatList(status.projectAllowPaths)}`,
    "",
    `Denied operations: ${formatDeniedOperations(status)}`,
    "",
    formatPermissionLevels(status),
    "",
    formatPermissionCommandHelp()
  ].join("\n");
}

function formatMode(mode: PermissionStatus["mode"]): string {
  if (mode === "read-only") return "Read Only";
  if (mode === "auto") return "Auto Allow Safe Tools";
  if (mode === "full-access") return "Full Access";
  return "Ask Before Write";
}

function formatList(values: string[]): string {
  return values.length ? values.join(", ") : "(none)";
}

function formatPermissionLevels(status: PermissionStatus): string {
  const levels = [
    ["read-only", "Read Only", "Only read/list/grep style tools can run."],
    ["ask", "Ask Before Write", "Ask before writes, shell commands, deletes, installs and other risky operations."],
    ["auto", "Auto Allow Safe Tools", "Auto-allow low-risk safe tools; ask for risky operations."],
    ["full-access", "Full Access", "Allow normal write and shell operations; critical operations still ask."]
  ];
  return [
    "Permission levels:",
    ...levels.map(([mode, label, description]) => {
      const current = status.mode === mode ? "  current" : "";
      return `- ${label}${current}: ${description}`;
    })
  ].join("\n");
}

function formatPermissionCommandHelp(): string {
  return [
    "Change permission level:",
    "/permissions readonly  - switch to Read Only",
    "/permissions ask       - switch to Ask Before Write",
    "/permissions auto      - switch to Auto Allow Safe Tools",
    "/permissions full      - switch to Full Access",
    "/permissions reset     - reset session permissions",
    "/permissions status    - show current policy"
  ].join("\n");
}

function formatDeniedOperations(status: PermissionStatus): string {
  if (!status.deniedOperations.length) return "(none)";
  return status.deniedOperations.slice(-5).map((operation) => {
    const target = operation.target ? ` ${operation.target}` : "";
    return `${operation.toolName}:${operation.actionType}${target} - ${operation.reason}`;
  }).join("\n");
}
