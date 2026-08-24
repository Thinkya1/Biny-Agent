/** Composer 菜单共享的标签，不包含 React 状态。 */
import type { PermissionMode } from "../../../../../permission/PermissionManager.js";
import type { ThinkingSelection } from "../../../../../llm/modelThinking.js";
import type { IconName } from "../Icon.js";

export function thinkingLabel(value: ThinkingSelection): string {
  if (value === "xhigh") return "XHigh";
  return value[0]?.toUpperCase() + value.slice(1);
}

export type SelectablePermissionMode = Extract<PermissionMode, "ask" | "auto" | "full-access">;

export const permissionOptions: Array<{ mode: SelectablePermissionMode; label: string; description: string; icon: IconName; risk?: string }> = [
  { mode: "ask", label: "请求批准", description: "写入、执行命令和敏感操作前请求确认", icon: "shield" },
  { mode: "auto", label: "帮我批准", description: "自动允许低风险操作，其他操作仍会请求确认", icon: "wand" },
  { mode: "full-access", label: "完全访问权限", description: "自动允许大多数操作，关键操作仍可能请求确认", icon: "warning", risk: "高风险" }
];

export function permissionLabel(mode: PermissionMode): string {
  if (mode === "read-only") return "只读";
  return permissionOptions.find((option) => option.mode === mode)?.label ?? mode;
}

export function permissionIcon(mode: PermissionMode): IconName {
  if (mode === "read-only") return "eye";
  return permissionOptions.find((option) => option.mode === mode)?.icon ?? "shield";
}
