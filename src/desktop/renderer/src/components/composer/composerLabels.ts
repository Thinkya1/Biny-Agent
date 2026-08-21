/** Composer 菜单共享的标签，不包含 React 状态。 */
import type { PermissionMode } from "../../../../../permission/PermissionManager.js";
import type { ThinkingSelection } from "../../../../../llm/modelThinking.js";

export function thinkingLabel(value: ThinkingSelection): string {
  if (value === "xhigh") return "XHigh";
  return value[0]?.toUpperCase() + value.slice(1);
}

export const permissionOptions: Array<{ mode: PermissionMode; label: string; description: string; risk?: string }> = [
  { mode: "ask", label: "每次询问", description: "写入、执行和其他敏感操作会请求确认" },
  { mode: "auto", label: "自动允许安全修改", description: "自动允许低风险操作，其他操作仍会询问" },
  { mode: "read-only", label: "只读", description: "允许读取，拒绝修改和命令执行" },
  { mode: "full-access", label: "完全访问", description: "除项目规定的关键操作外自动允许", risk: "高风险" }
];

export function permissionLabel(mode: PermissionMode): string {
  return permissionOptions.find((option) => option.mode === mode)?.label ?? mode;
}
