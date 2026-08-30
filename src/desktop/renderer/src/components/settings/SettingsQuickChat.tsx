/**
 * 快速对话（QuickChat）设置页。
 *
 * 三个开关都是纯 UI 行为偏好，走 DesktopStateStore 的逐字段直达通道（setQuickChatSettings），
 * 即时生效，不进跨页设置草稿事务——所以这里不读 useSettingsDraft，而是挂载时拉一次
 * quickChatSettings()，勾选后直接把整份设置回写。前台应用上下文由 QuickChat 唤起时按需读取，
 * 与活动记录器完全分离。
 */
import { useEffect, useState } from "react";
import type { DesktopQuickChatSettings } from "../../../../protocol.js";
import { Icon } from "../Icon.js";
import { SettingsCheckbox } from "./SettingsCheckbox.js";

export function SettingsQuickChat(): React.JSX.Element {
  const [settings, setSettings] = useState<DesktopQuickChatSettings>();
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void window.biny.quickChatSettings()
      .then((nextSettings) => {
        if (cancelled) return;
        setSettings(nextSettings);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (patch: Partial<DesktopQuickChatSettings>): void => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    // 乐观更新；落盘失败时回滚并用权威值刷新，避免勾选态与持久化漂移。
    setSettings(next);
    void window.biny.setQuickChatSettings(next).then(setSettings).catch(() => {
      void window.biny.quickChatSettings().then(setSettings).catch(() => undefined);
    });
  };

  if (loadError) {
    return <div className="settings-sections"><section className="appearance-card"><p className="quickchat-hint">无法加载快速对话设置：{loadError}</p></section></div>;
  }
  if (!settings) {
    return <div className="settings-sections"><section className="appearance-card"><p className="quickchat-hint">正在加载快速对话设置…</p></section></div>;
  }

  return (
    <div className="settings-sections appearance-settings">
      <section className="appearance-card" id="quickchat-shortcut" tabIndex={-1}>
        <div className="quickchat-shortcut-row">
          <span className="quickchat-shortcut-icon"><Icon name="compose" size={16} /></span>
          <span className="quickchat-shortcut-copy">
            <strong>全局快捷键</strong>
            <small>随时按下唤醒或收起悬浮小窗。</small>
          </span>
          <kbd className="quickchat-kbd">{navigator.userAgent.includes("Mac") ? "⌘ ⇧ Space" : "Ctrl ⇧ Space"}</kbd>
        </div>
      </section>

      <section className="appearance-card" id="quickchat-behavior" tabIndex={-1}>
        <h3>行为</h3>
        <div className="quickchat-toggle-list">
          <SettingsCheckbox
            checked={settings.autoHideOnBlur}
            detail="开启后，Quick Chat 窗口在失去焦点时会自动隐藏"
            label="失焦时自动隐藏"
            onChange={(value) => update({ autoHideOnBlur: value })}
          />
          <SettingsCheckbox
            checked={settings.injectScreenContext}
            detail="发送时附带 QuickChat 唤起后读取的前台应用、窗口标题、浏览器地址和可访问文本，不读取活动记录缓存。"
            label="注入前台应用上下文"
            onChange={(value) => update({ injectScreenContext: value })}
          />
          <SettingsCheckbox
            checked={settings.clickThrough}
            detail="QuickChat 可见但忽略鼠标事件，悬浮在工作上方而不抢焦点。按 QuickChat 快捷键唤醒。"
            label="以环境（点击穿透）模式启动"
            onChange={(value) => update({ clickThrough: value })}
          />
        </div>
      </section>
    </div>
  );
}
