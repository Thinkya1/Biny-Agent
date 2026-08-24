/** 设置中心固定底栏：统一展示草稿状态并提交整个设置事务。 */
import type { SettingsSaveState } from "./SettingsDraftContext.js";

export function SettingsPageFooter({
  dirtyCount,
  disabled,
  onCancel,
  onSave,
  state
}: {
  dirtyCount: number;
  disabled: boolean;
  onCancel(): void;
  onSave(): void;
  state: SettingsSaveState;
}): React.JSX.Element {
  const status = settingsSaveStatus(state, dirtyCount);
  return (
    <footer className="settings-page-footer">
      <span aria-live="polite" className={`settings-save-status is-${state}`} role="status">{status}</span>
      <span className="settings-footer-actions">
        <button className="ghost-button" disabled={state === "saving" || state === "rolling_back"} onClick={onCancel} type="button">取消</button>
        <button
          disabled={disabled || dirtyCount === 0 || state === "invalid" || state === "saving" || state === "rolling_back" || state === "recovery_required"}
          onClick={onSave}
          type="button"
        >
          {state === "saving" ? "保存中…" : state === "rolling_back" ? "回滚中…" : "保存"}
        </button>
      </span>
    </footer>
  );
}

function settingsSaveStatus(state: SettingsSaveState, dirtyCount: number): string {
  if (state === "invalid") return "校验失败";
  if (state === "saving") return "保存中…";
  if (state === "rolling_back") return "回滚中…";
  if (state === "recovery_required") return "需要恢复设置后才能继续";
  if (state === "dirty" || dirtyCount > 0) return "未保存的更改";
  return "所有更改已保存";
}
