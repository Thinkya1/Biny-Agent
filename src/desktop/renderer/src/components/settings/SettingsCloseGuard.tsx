/** 底部“取消”放弃设置草稿前的二次确认；系统窗口关闭不经过这里。 */
import { AppIcon } from "../AppIcon.js";
import { SettingsDetailLayer } from "./SettingsDetailLayer.js";

export function SettingsCloseGuard({ busy, onCancel, onDiscard }: {
  busy: boolean;
  onCancel(): void;
  onDiscard(): void;
}): React.JSX.Element {
  return (
    <SettingsDetailLayer onClose={onCancel}>
      <section aria-labelledby="settings-close-title" className="settings-confirm-panel settings-discard-panel" role="dialog">
        <div className="settings-confirm-icon-frame">
          <AppIcon className="settings-confirm-icon" size={88} />
        </div>
        <h3 id="settings-close-title">有未保存的更改</h3>
        <p className="settings-discard-desc">确定要关闭吗？未保存的更改将丢失。</p>
        <div className="settings-confirm-actions">
          <button className="ghost-button" disabled={busy} onClick={onCancel} type="button">取消</button>
          <button data-settings-detail-autofocus disabled={busy} onClick={onDiscard} type="button">放弃更改</button>
        </div>
      </section>
    </SettingsDetailLayer>
  );
}
