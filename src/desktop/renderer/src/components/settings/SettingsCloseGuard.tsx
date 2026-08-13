/** 未保存草稿的关闭确认；保存、放弃和取消是三个明确结果。 */
import { SettingsDetailLayer } from "./SettingsDetailLayer.js";

export function SettingsCloseGuard({ busy, onCancel, onDiscard, onSave, saveDisabled = false }: {
  busy: boolean;
  onCancel(): void;
  onDiscard(): void;
  onSave(): void;
  saveDisabled?: boolean;
}): React.JSX.Element {
  return (
    <SettingsDetailLayer onClose={onCancel}>
      <section aria-labelledby="settings-close-title" className="settings-confirm-panel" role="dialog">
        <h3 id="settings-close-title">保存设置更改？</h3>
        <p>你在多个分页中的修改还没有保存。放弃后，主题和字体预览也会恢复。</p>
        <div className="settings-confirm-actions">
          <button className="ghost-button" disabled={busy} onClick={onCancel} type="button">取消</button>
          <button className="ghost-button is-danger" disabled={busy} onClick={onDiscard} type="button">放弃更改</button>
          <button data-settings-detail-autofocus disabled={busy || saveDisabled} onClick={onSave} type="button">保存全部</button>
        </div>
      </section>
    </SettingsDetailLayer>
  );
}
