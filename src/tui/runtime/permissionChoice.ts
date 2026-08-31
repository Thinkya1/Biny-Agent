import type { PermissionResult } from "../../permission/PermissionManager.js";
import { permissionScopeForAlways } from "../../permission/permissionScope.js";
import type { PermissionChoice } from "../types.js";
import type { TuiPermissionRequest } from "../types.js";

/** 把 TUI 四种审批动作转换成运行时权限结果。 */
export function permissionChoiceToResult(
  choice: PermissionChoice,
  request: TuiPermissionRequest,
  denialReason = ""
): PermissionResult {
  const confirmation = request.requireFullYes ? "yes" : undefined;
  if (choice === "allow_once") {
    return { approved: true, action: "allow_once", scope: "once", confirmation };
  }
  if (choice === "allow_always") {
    return { approved: true, action: "allow_always", scope: permissionScopeForAlways(request), confirmation };
  }
  if (choice === "deny_with_reason") {
    return {
      approved: false,
      action: "deny_with_reason",
      scope: "once",
      message: denialReason.trim() || "A denial reason is required.",
      confirmation: undefined
    };
  }
  return { approved: false, action: "deny", scope: "once", message: "Denied by user.", confirmation: undefined };
}
