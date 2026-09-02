/** Agent 权限策略设置：控制工具执行前的批准边界，不改变工具/Skill 的可见性选择。 */
import { useEffect, useState } from "react";
import type { ActivityRuntimeSnapshot } from "../../../../../activity/types.js";
import type { PermissionMode } from "../../../../../permission/PermissionManager.js";
import type { DesktopPermissionSettings } from "../../../../protocol.js";
import { Icon, type IconName } from "../Icon.js";
import { SettingsCheckbox } from "./SettingsCheckbox.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

const permissionOptions: Array<{ mode: PermissionMode; label: string; detail: string }> = [
  { mode: "ask", label: "每次询问", detail: "工具需要执行时逐次请求批准。" },
  { mode: "read-only", label: "只读", detail: "允许读取，写入和执行类操作仍会被拦截。" },
  { mode: "auto", label: "自动批准", detail: "按工具白名单自动批准，其余操作询问。" },
  { mode: "full-access", label: "完全访问", detail: "允许 Agent 自主执行工具；高风险操作仍可强制询问。" }
];

export function SettingsPermissions(): React.JSX.Element {
  const { draft, setPermission } = useSettingsDraft();
  if (!draft) return <div className="settings-sections"><section><p>正在加载权限设置…</p></section></div>;

  const permission = draft.permission;
  const update = (patch: Partial<DesktopPermissionSettings>): void => setPermission({ ...permission, ...patch });

  return (
    <div className="settings-sections agent-permission-settings">
      <section id="agent-permission-mode" tabIndex={-1}>
        <div className="section-heading-row">
          <div><h3>Agent 权限模式</h3><p>这是工具执行的批准策略；输入框里的权限按钮可以临时覆盖当前会话。</p></div>
          <span className="settings-scope-badge">全局</span>
        </div>
        <div aria-label="Agent 权限模式" className="agent-permission-options" role="radiogroup">
          {permissionOptions.map((option) => (
            <button
              aria-checked={permission.mode === option.mode}
              className={`agent-permission-option${permission.mode === option.mode ? " is-selected" : ""}`}
              key={option.mode}
              onClick={() => update({ mode: option.mode })}
              role="radio"
              type="button"
            >
              <span className={`radio${permission.mode === option.mode ? " is-selected" : ""}`} />
              <span><strong>{option.label}</strong><small>{option.detail}</small></span>
            </button>
          ))}
        </div>
      </section>

      <section id="agent-permission-safety" tabIndex={-1}>
        <h3>安全边界</h3>
        <p>关键操作会跳过自动批准白名单，始终回到确认流程。</p>
        <SettingsCheckbox
          checked={permission.criticalAlwaysAsk}
          detail="例如删除、覆盖或高影响外部操作；开启后即使处于自动或完全访问模式也会询问。"
          label="关键操作始终询问"
          onChange={(criticalAlwaysAsk) => update({ criticalAlwaysAsk })}
        />
      </section>

      <section id="agent-permission-scope" tabIndex={-1}>
        <h3>当前范围</h3>
        <p>工具白名单、允许路径和拒绝路径仍由运行时配置管理；本页不会把它们改写成能力选择。</p>
        <div className="permission-scope-summary">
          <span><strong>自动批准工具</strong><small>{permission.allowTools.length ? `${String(permission.allowTools.length)} 个` : "未指定"}</small></span>
          <span><strong>允许路径</strong><small>{permission.allowPaths.length ? `${String(permission.allowPaths.length)} 条` : "未指定"}</small></span>
          <span><strong>拒绝路径</strong><small>{permission.denyPaths.length ? `${String(permission.denyPaths.length)} 条` : "未指定"}</small></span>
        </div>
      </section>

      <SystemPermissions />
    </div>
  );
}

function SystemPermissions(): React.JSX.Element {
  const [runtime, setRuntime] = useState<ActivityRuntimeSnapshot>();

  useEffect(() => {
    let active = true;
    void window.biny.activitySnapshot().then((next) => {
      if (active) setRuntime(next);
    }).catch(() => undefined);
    const unsubscribe = window.biny.onActivityEvent((next) => {
      if (active) setRuntime(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const refresh = (): void => {
    void window.biny.activitySnapshot().then(setRuntime).catch(() => undefined);
  };
  const open = (pane: "screen-recording" | "accessibility"): void => {
    void window.biny.requestActivityPermission(pane)
      .catch(() => undefined)
      .then(() => window.biny.openSystemSettings(pane))
      .catch(() => undefined);
  };
  const permissions = [
    { detail: "隐私与安全性 → 屏幕录制", granted: runtime?.screenRecordingGranted, label: "屏幕录制", pane: "screen-recording" as const },
    { detail: "隐私与安全性 → 辅助功能", granted: runtime?.accessibilityGranted, label: "辅助功能", pane: "accessibility" as const },
  ];

  return (
    <section className="activity-card" id="system-permissions" tabIndex={-1}>
      <div className="activity-section-heading">
        <div className="activity-section-title"><Icon name="shield" size={15} /><h3>macOS 系统权限</h3></div>
        <button aria-label="刷新 macOS 系统权限状态" className="activity-icon-button" onClick={refresh} title="刷新权限状态" type="button"><Icon name="refresh" size={14} /></button>
      </div>
      <p className="activity-section-description">活动记录和屏幕上下文功能依赖这些系统授权；点击后会打开 macOS“隐私与安全性”。</p>
      <div className="activity-permission-list">
        {permissions.map((permission) => <SystemPermissionRow key={permission.pane} {...permission} onOpen={() => open(permission.pane)} />)}
      </div>
    </section>
  );
}

function SystemPermissionRow({ detail, granted, label, onOpen }: { detail: string; granted?: boolean; label: string; onOpen(): void }): React.JSX.Element {
  const status = granted === undefined ? "检查中" : granted ? "已授权" : "需授权";
  const stateClass = status === "已授权" ? "is-granted" : status === "需授权" ? "is-needed" : "";
  const stateIcon: IconName = status === "已授权" ? "check" : status === "需授权" ? "warning" : "shield";
  return (
    <div className="activity-permission-row">
      <div className={`activity-permission-copy ${stateClass}`}>
        <span className="activity-permission-state"><Icon name={stateIcon} size={11} /></span>
        <span className="activity-permission-text"><strong>{label}<em>{status}</em></strong><small>{detail}</small></span>
      </div>
      {granted === false ? <button aria-label={`在 macOS 系统设置中管理${label}权限`} className="activity-secondary-button" onClick={onOpen} type="button"><Icon name="external" size={13} />打开系统设置</button> : null}
    </div>
  );
}
