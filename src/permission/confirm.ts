/**
 * 终端确认模块。
 *
 * 非 TUI 命令在执行有副作用工具前会调用这里，向用户展示标题、详情和可选的强确认要求。
 * TUI 模式会注入自己的权限 UI，因此这个模块只覆盖普通命令行交互。
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { isFullYesConfirmation, permissionResultFromAnswer } from "./confirmation.js";
import type { PermissionPrompt, PermissionResult } from "./PermissionManager.js";

export interface ConfirmOptions {
  // 高风险操作可以要求完整输入 yes，避免用户误按 y。
  requireFullYes?: boolean;
}

export async function confirmAction(title: string, details: string, options: ConfirmOptions = {}): Promise<boolean> {
  // 这是非 TUI 场景的同步式确认入口；TUI 会通过 confirmPermission 注入自己的 UI。
  output.write(`\n${title}\n${details}\nAllow? ${options.requireFullYes ? "type yes to confirm" : "yes/no"}\n`);
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("> ");
    if (options.requireFullYes) return isFullYesConfirmation(answer);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

export async function confirmPermissionRequest(
  request: PermissionPrompt,
  signal?: AbortSignal
): Promise<PermissionResult> {
  output.write(`\n${request.title}\n`);
  output.write(`Tool: ${request.tool}\n`);
  output.write(`Action: ${request.actionType}\n`);
  output.write(`Risk: ${request.riskLevel}\n`);
  if (request.targetPath) output.write(`Target: ${request.targetPath}\n`);
  if (request.command) output.write(`Command: ${request.command}\n`);
  if (request.reason) output.write(`Reason: ${request.reason}\n`);
  if (request.changeSummary) output.write(`Summary: ${request.changeSummary}\n`);
  output.write(`${request.details}\n`);
  output.write((request.requireFullYes ? [
    "Choose (full confirmation required):",
    "  yes          Allow Once",
    "  yes command  Always Allow",
    "  n            Deny",
    "  r <reason>   Deny With Reason"
  ] : [
    "Choose:",
    "  y / Enter   Allow Once",
    "  a           Always Allow",
    "  n           Deny",
    "  r <reason>  Deny With Reason"
  ]).join("\n"));
  output.write("\n");

  const rl = createInterface({ input, output });
  try {
    const result = permissionResultFromAnswer(await rl.question("> ", { signal }), request.requireFullYes);
    if (result.action !== "deny_with_reason" || result.message?.trim()) return result;
    const reason = (await rl.question("Reason (required): ", { signal })).trim();
    return reason
      ? { ...result, message: reason }
      : { approved: false, action: "deny", scope: "once", message: "Denied by user.", confirmation: undefined };
  } finally {
    rl.close();
  }
}
