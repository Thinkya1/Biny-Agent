/**
 * 权限确认答案解析模块。
 *
 * CLI 和 TUI 共用这里的纯逻辑，确保强确认不会因不同交互入口而降级。
 */
import type { PermissionAction, PermissionResult } from "./PermissionManager.js";

const fullYesConfirmation = "yes";

/** 强确认只接受完整的 yes；忽略首尾空白和大小写。 */
export function isFullYesConfirmation(answer: string): boolean {
  return normalizeAnswer(answer) === fullYesConfirmation;
}

export function permissionResultFromAnswer(answer: string, requireFullYes: boolean): PermissionResult {
  const normalized = normalizeAnswer(answer);
  if (requireFullYes) {
    if (normalized === fullYesConfirmation) return allowResult("allow_once", "once", fullYesConfirmation);
    if (normalized === `${fullYesConfirmation} command` || normalized === `${fullYesConfirmation} always`) {
      return allowResult("allow_always", "command", fullYesConfirmation);
    }
    if (isDenyAnswer(normalized)) return denyResult("deny", "Denied by user.");
    const reason = denialReason(answer);
    if (reason !== undefined || isDenyWithReasonAnswer(normalized)) return denyResult("deny_with_reason", reason);
    return denyResult("deny", "Full yes confirmation was not provided.");
  }
  if (normalized === "" || normalized === "y" || normalized === fullYesConfirmation) {
    return allowResult("allow_once", "once", undefined);
  }
  if (normalized === "c" || normalized === "a" || normalized === "always" || normalized === "allow always") {
    return allowResult("allow_always", "command", undefined);
  }
  if (isDenyAnswer(normalized)) return denyResult("deny", "Denied by user.");
  const reason = denialReason(answer);
  if (reason !== undefined || isDenyWithReasonAnswer(normalized)) return denyResult("deny_with_reason", reason);
  return denyResult("deny", "Denied by user.");
}

function normalizeAnswer(answer: string): string {
  return answer.trim().toLowerCase().replace(/\s+/gu, " ");
}

function allowResult(action: Extract<PermissionAction, "allow_once" | "allow_always">, scope: "once" | "command", confirmation: string | undefined): PermissionResult {
  return { approved: true, action, scope, confirmation };
}

function denyResult(action: Extract<PermissionAction, "deny" | "deny_with_reason">, message: string | undefined): PermissionResult {
  return { approved: false, action, scope: "once", message, confirmation: undefined };
}

function isDenyAnswer(answer: string): boolean {
  return answer === "n" || answer === "no" || answer === "deny";
}

function isDenyWithReasonAnswer(answer: string): boolean {
  return answer === "r" || answer === "reason" || answer === "deny with reason" || answer === "deny_with_reason";
}

function denialReason(answer: string): string | undefined {
  const trimmed = answer.trim();
  const normalized = trimmed.toLowerCase().replace(/\s+/gu, " ");
  for (const prefix of ["r ", "reason ", "deny with reason ", "deny_with_reason "]) {
    if (normalized.startsWith(prefix)) return trimmed.slice(prefix.length).trim() || undefined;
  }
  return undefined;
}
