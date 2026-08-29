/**
 * 快速对话（QuickChat）设置页。
 *
 * 三个开关都是纯 UI 行为偏好，走 DesktopStateStore 的逐字段直达通道（setQuickChatSettings），
 * 即时生效，不进跨页设置草稿事务——所以这里不读 useSettingsDraft，而是挂载时拉一次
 * quickChatSettings()，勾选后直接把整份设置回写。「注入实时屏幕上下文」依赖活动记录器，
 * 活动未启用时置灰并提示。
 */
import { useEffect, useState } from "react";
import type { DesktopQuickChatSettings } from "../../../../protocol.js";
import { Icon } from "../Icon.js";
import { SettingsCheckbox } from "./SettingsCheckbox.js";

export function SettingsQuickChat(): React.JSX.Element {
  const [settings, setSettings] = useState<DesktopQuickChatSettings>();
  const [activityEnabled, setActivityEnabled] = useState(false);
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    // 活动设置是全局数据，不能借用需要非空 projectId 的项目设置快照。
    void Promise.all([window.biny.quickChatSettings(), window.biny.activitySettings()])
      .then(([nextSettings, activity]) => {
        if (cancelled) return;
        setSettings(nextSettings);
        setActivityEnabled(activity.enabled);
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

  const injectDisabled = !activityEnabled;

  return (
    <div className="settings-sections appearance-settings">
      <section className="appearance-card" id="quickchat-shortcut" tabIndex={-1}>
        <div className="quickchat-shortcut-row">
          <span className="quickchat-shortcut-icon"><Icon name="compose" size={16} /></span>
          <span className="quickchat-shortcut-copy">
            <strong>全局快捷键</strong>
            <small>随时按下唤醒或收起悬浮小窗。</small>
          </span>
          <kbd className="quickchat-kbd">⌥ Space</kbd>
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
            detail="每条 QuickChat 消息都会附带最新的屏幕内容片段（前台应用、浏览器 URL、最新 OCR、最近分析的会话）。需要启用活动记录器。"
            disabled={injectDisabled}
            label="注入实时屏幕上下文"
            onChange={(value) => update({ injectScreenContext: value })}
          />
          {injectDisabled ? (
            <p className="quickchat-hint">需要先在「活动记录」页启用活动记录器，才能注入实时屏幕上下文。</p>
          ) : null}
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
