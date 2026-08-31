/**
 * 权限确认选项状态模块。
 *
 * PermissionPrompt 用这里的纯函数处理四种审批动作，便于不启动完整 TUI 就能测试上下移动和 Enter 映射。
 */
import type { PermissionChoice, TuiPermissionRequest } from "./types.js";
import { isFullYesConfirmation } from "../permission/confirmation.js";

export interface PermissionOption {
  label: string;
  description: string;
  choice: PermissionChoice;
  dangerous?: boolean;
}

export interface PermissionPromptInteractionState {
  request?: TuiPermissionRequest;
  selectedIndex: number;
  confirmation: string;
  confirmationAttempted: boolean;
  denialReason: string;
  denialReasonAttempted: boolean;
}

export const DEFAULT_PERMISSION_SELECTION = 2;

export const permissionOptions: PermissionOption[] = [
  { label: "拒绝", description: "不执行本次操作", choice: "deny", dangerous: true },
  { label: "拒绝并说明理由", description: "拒绝本次操作，并把原因交给 Agent", choice: "deny_with_reason", dangerous: true },
  { label: "允许一次", description: "只允许本次操作", choice: "allow_once" },
  { label: "始终允许", description: "本会话后续同类操作直接执行", choice: "allow_always" }
];

export function movePermissionSelection(currentIndex: number, direction: -1 | 1): number {
  return (currentIndex + direction + permissionOptions.length) % permissionOptions.length;
}

export function permissionChoiceAt(index: number): PermissionChoice {
  return permissionOptions[normalizePermissionSelection(index)]?.choice ?? "allow_once";
}

/** 强确认下，拒绝可以立即提交；拒绝并说明理由必须先填理由，批准项必须提供完整 yes。 */
export function confirmedPermissionChoice(
  index: number,
  requireFullYes: boolean,
  confirmation: string,
  denialReason = ""
): PermissionChoice | undefined {
  const choice = permissionChoiceAt(index);
  if (choice === "deny") return choice;
  if (choice === "deny_with_reason") return denialReason.trim() ? choice : undefined;
  if (!requireFullYes || isFullYesConfirmation(confirmation)) return choice;
  return undefined;
}

/** 只保留单行可打印输入并限制长度，避免确认行撑破权限框。 */
export function appendPermissionConfirmation(current: string, input: string): string {
  const printable = input.replace(/[\u0000-\u001F\u007F]/gu, "");
  return `${current}${printable}`.slice(0, 16);
}

/** 拒绝理由允许比 yes 更长，但仍限制为单行，避免撑破终端弹层。 */
export function appendPermissionReason(current: string, input: string): string {
  const printable = input.replace(/[\u0000-\u001F\u007F]/gu, "");
  return `${current}${printable}`.slice(0, 240);
}

export function createPermissionPromptInteractionState(
  request?: TuiPermissionRequest
): PermissionPromptInteractionState {
  return {
    request,
    selectedIndex: DEFAULT_PERMISSION_SELECTION,
    confirmation: "",
    confirmationAttempted: false,
    denialReason: "",
    denialReasonAttempted: false
  };
}

/** 新请求永远从默认选项和空确认词开始，防止复用上一请求的 yes。 */
export function permissionPromptStateForRequest(
  state: PermissionPromptInteractionState,
  request?: TuiPermissionRequest
): PermissionPromptInteractionState {
  return state.request === request ? state : createPermissionPromptInteractionState(request);
}

export function normalizePermissionSelection(index: number): number {
  if (!Number.isInteger(index)) return 0;
  return (index + permissionOptions.length) % permissionOptions.length;
}
