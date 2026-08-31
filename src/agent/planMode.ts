/**
 * Plan 模式的协作策略。
 *
 * Plan 是工作流状态，不是权限模式。只有 `full-access` 才允许模型在规划回合中
 * 看到写入和执行工具；真正的放行仍由 PermissionManager 决定，避免把提示词当成
 * 安全边界。这里将“协作提示词”和“权限工具面”分开：全权限只解除
 * 工具面的只读限制，不代表用户已经批准实施。子代理始终不在 Plan 工具面中，
 * 防止规划阶段递归启动实际工作。
 */
import type { PermissionMode } from "../permission/PermissionManager.js";
import type { Tool } from "../tools/types.js";

export function selectPlanTools(tools: readonly Tool[], permissionMode: PermissionMode): Tool[] {
  const fullAccess = permissionMode === "full-access";
  return tools.filter((tool) => {
    if (tool.source === "subagent") return false;
    return fullAccess || tool.risk === "read";
  });
}

export function renderPlanModePrompt(permissionMode: PermissionMode): string {
  const fullAccess = permissionMode === "full-access";
  // Plan 提示词不能固定写成只读；它要与当前权限模式保持一致，避免模型看见
  // full-access 工具后仍被旧提示词要求绝对禁止写入。真正的执行许可仍由权限层判断。
  return [
    "Mode: Plan mode.",
    "Plan mode is a collaboration workflow, not a permission mode.",
    "Stay in planning and research mode until the user switches back to chat or explicitly asks you to act now.",
    fullAccess
      ? "Full access is active. Do not impose a read-only restriction on the available tools, but use mutating tools or commands only when the current user request explicitly asks for that side effect during planning. Full access is not implementation approval by itself."
      : "The current permission mode only exposes read and inspection tools in Plan mode. Do not modify files, delete or move data, run commands, or delegate work.",
    "Inspect the repository and available context before proposing a concrete ordered plan with affected files, validation, assumptions, and material risks.",
    "Use update_todos for a multi-step plan and keep its statuses accurate.",
    "Do not claim that implementation has started or completed unless the user explicitly asked for those side effects and the tool results confirm them."
  ].join("\n");
}
