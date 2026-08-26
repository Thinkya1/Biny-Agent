/** Activity Recorder 设置页：只展示采集设置、运行态摘要和可操作的 macOS 权限入口。 */
import { useEffect, useState } from "react";
import type { ActivityAnalysisPolicy } from "../../../../../activity/settings.js";
import type { ActivityRuntimeSnapshot, ActivitySessionSummary } from "../../../../../activity/types.js";
import type { DesktopActivitySettingsInput } from "../../../../protocol.js";
import { Icon, type IconName } from "../Icon.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

const analysisPolicyOptions: Array<{ value: ActivityAnalysisPolicy; label: string }> = [
  { value: "local_only", label: "仅本地" },
  { value: "confirm_external", label: "需确认" },
  { value: "external_allowed", label: "允许外部" }
];

export function SettingsActivity(): React.JSX.Element {
  const { draft, setActivity } = useSettingsDraft();
  if (!draft) return <div className="settings-sections"><section><p>正在加载活动记录设置…</p></section></div>;
  return <SettingsActivityForm activity={draft.activity} onChange={setActivity} />;
}

function SettingsActivityForm({ activity, onChange }: { activity: DesktopActivitySettingsInput; onChange(value: DesktopActivitySettingsInput): void }): React.JSX.Element {
  const [languagesText, setLanguagesText] = useState(activity.ocrLanguages.join(", "));
  const [sensitiveApplicationsText, setSensitiveApplicationsText] = useState(activity.sensitiveApplications.join("\n"));
  const [analysisModelText, setAnalysisModelText] = useState(activity.analysisModel ?? "");
  const [runtime, setRuntime] = useState<ActivityRuntimeSnapshot>();
  const [clearing, setClearing] = useState(false);
  const updateActivity = (next: Partial<DesktopActivitySettingsInput>): void => {
    onChange({ ...activity, ...next });
  };

  useEffect(() => {
    setLanguagesText(activity.ocrLanguages.join(", "));
    setSensitiveApplicationsText(activity.sensitiveApplications.join("\n"));
    setAnalysisModelText(activity.analysisModel ?? "");
  }, [activity.ocrLanguages, activity.sensitiveApplications, activity.analysisModel]);

  useEffect(() => {
    let cancelled = false;
    void window.biny.activitySnapshot().then((next) => {
      if (!cancelled) setRuntime(next);
    }).catch(() => undefined);
    const unsubscribe = window.biny.onActivityEvent((next) => {
      if (!cancelled) setRuntime(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const refreshRuntime = (): void => {
    void window.biny.activitySnapshot().then(setRuntime).catch(() => undefined);
  };

  const commitLanguages = (): void => {
    const languages = languagesText.split(",").map((value) => value.trim()).filter(Boolean);
    updateActivity({ ocrLanguages: languages });
    setLanguagesText(languages.join(", "));
  };
  const commitSensitiveApplications = (): void => {
    const applications = sensitiveApplicationsText.split("\n").map((value) => value.trim()).filter(Boolean);
    updateActivity({ sensitiveApplications: applications });
    setSensitiveApplicationsText(applications.join("\n"));
  };
  const commitAnalysisModel = (): void => {
    const trimmed = analysisModelText.trim();
    // 空串等价于「未配置」：主进程 schema 对 analysisModel 要求 min(1)，清空时必须回退 undefined 才能保存。
    updateActivity({ analysisModel: trimmed || undefined });
    setAnalysisModelText(trimmed);
  };
  const openPermissionSettings = (pane: "screen-recording" | "accessibility" | "input-monitoring"): void => {
    void window.biny.requestActivityPermission(pane)
      .catch(() => undefined)
      .then(() => window.biny.openSystemSettings(pane))
      .catch(() => undefined);
  };
  const openAccessibilitySettings = (): void => openPermissionSettings("accessibility");
  const openInputMonitoringSettings = (): void => openPermissionSettings("input-monitoring");
  const openScreenRecordingSettings = (): void => openPermissionSettings("screen-recording");
  const clearActivity = (): void => {
    if (clearing) return;
    setClearing(true);
    void window.biny.clearActivity().then(setRuntime).catch(() => undefined).finally(() => setClearing(false));
  };
  const storagePercent = runtime === undefined || activity.maxStorageMb <= 0
    ? 0
    : Math.min(100, (runtime.storageBytes / (activity.maxStorageMb * 1024 * 1024)) * 100);
  const runtimeLabel = activity.enabled ? activityServiceLabel(runtime) : "已暂停";
  const isRecording = activity.enabled && runtime?.state === "running";
  const runtimeStorage = runtime === undefined
    ? "采集服务未接入"
    : `${formatActivityBytes(runtime.storageBytes)} / ${formatActivityBytes(activity.maxStorageMb * 1024 * 1024)}（${Math.round(storagePercent)}%）`;
  const permissionStatus = (granted: boolean | undefined, enabled = true): string => {
    if (!enabled) return "未启用";
    if (granted === undefined) return "检查中";
    return granted ? "已授权" : "需授权";
  };
  const screenPermission = permissionStatus(runtime?.screenRecordingGranted);
  const accessibilityPermission = permissionStatus(runtime?.accessibilityGranted);
  const inputMonitoringPermission = permissionStatus(runtime?.inputMonitoringGranted, activity.inputMonitoringEnabled);

  return (
    <div className="settings-sections activity-settings">
      <section className="activity-card activity-overview" id="activity-overview" tabIndex={-1}>
        <div className="activity-overview-heading">
          <div className="activity-heading-copy">
            <div className="activity-title-line">
              <Icon name="activity" size={16} />
              <h3>活动记录器</h3>
              <span className={`activity-status-badge${isRecording ? " is-recording" : activity.enabled ? " is-enabled" : ""}`}>
                {runtimeLabel}
              </span>
            </div>
            <p>静默记录事件和最小 AX 语义；AX 无法提供有效上下文时才使用视觉 fallback 和 OCR。数据不会离开本机。</p>
          </div>
          <ActivitySwitch checked={activity.enabled} label="启用活动记录器" onChange={(enabled) => updateActivity({ enabled })} />
        </div>
        <div className="activity-stat-grid">
          <ActivityStat icon="timer" label="会话数" value={runtime === undefined ? "—" : String(runtime.sessions)} />
          <ActivityStat icon="database" label="快照数" value={runtime === undefined ? "—" : formatActivityBytes(runtime.storageBytes)} />
          <ActivityStat icon="activity" label="当前会话" value={runtime === undefined ? "—" : runtime.currentSessionId ? "活跃" : activity.enabled ? "空闲" : "已暂停"} />
          <ActivityStat icon="display" label="前台应用" value={runtime?.currentApplication ?? "—"} />
        </div>
        <div className="activity-storage-summary">
          <div><span>已用存储</span><strong>{runtimeStorage}</strong></div>
          <span className="activity-storage-hint">超过上限时旧 fallback JPEG 会自动删除</span>
        </div>
        <div aria-hidden="true" className="activity-progress"><span style={{ width: `${storagePercent}%` }} /></div>
        {runtime?.error ? <p className="activity-section-description">{runtime.error}</p> : null}
      </section>

      <ActivitySection
        action={<button aria-label="刷新 macOS 权限状态" className="activity-icon-button" onClick={refreshRuntime} title="刷新权限状态" type="button"><Icon name="refresh" size={14} /></button>}
        id="activity-permissions"
        icon="shield"
        title="macOS 权限"
      >
        <div className="activity-permission-list">
          <div className="activity-permission-row">
            <ActivityPermission detail="隐私与安全性 → 屏幕录制" label="屏幕录制（仅视觉 fallback）" status={screenPermission} />
            {screenPermission === "需授权" ? (
              <button aria-label="在 macOS 系统设置中管理屏幕录制权限" className="activity-secondary-button" onClick={openScreenRecordingSettings} type="button">
                <Icon name="external" size={13} />
                打开系统设置
              </button>
            ) : null}
          </div>
          <div className="activity-permission-row">
            <ActivityPermission detail="隐私与安全性 → 辅助功能" label="辅助功能（AX 事件流）" status={accessibilityPermission} />
            {accessibilityPermission === "需授权" ? (
              <button aria-label="在 macOS 系统设置中管理辅助功能权限" className="activity-secondary-button" onClick={openAccessibilitySettings} type="button">
                <Icon name="external" size={13} />
                打开系统设置
              </button>
            ) : null}
          </div>
          <div className="activity-permission-row">
            <ActivityPermission detail="隐私与安全性 → 输入监控" label="输入监控（点击、拖拽、滚轮、键盘活动）" status={inputMonitoringPermission} />
            {inputMonitoringPermission === "需授权" ? (
              <button aria-label="在 macOS 系统设置中管理输入监控权限" className="activity-secondary-button" onClick={openInputMonitoringSettings} type="button">
                <Icon name="external" size={13} />
                打开系统设置
              </button>
            ) : null}
          </div>
          {runtime?.screenRecordingGranted === false && runtime?.collectorAvailable === true
            ? <p className="activity-section-description">事件记录正常，视觉 fallback 不可用。</p>
            : null}
        </div>
      </ActivitySection>

      <ActivitySection id="activity-capture" icon="activity" title="采集">
        <div className="activity-field-grid">
          <ActivityNumberField id="activity-debounce" label="快照防抖（毫秒）" hint="两次 fallback 截图之间的最小间隔" unit="" max={60_000} min={250} value={activity.captureDebounceMs} onCommit={(value) => updateActivity({ captureDebounceMs: value })} />
          <ActivityNumberField id="activity-heartbeat" label="心跳间隔（毫秒）" hint="AX 不可用时按此间隔重试视觉 fallback" unit="" max={600_000} min={1_000} value={activity.heartbeatMs} onCommit={(value) => updateActivity({ heartbeatMs: value })} />
          <ActivityNumberField id="activity-idle" label="空闲阈值（毫秒）" hint="无事件达到该时长后关闭当前会话" unit="" max={600_000} min={1_000} value={activity.idleTimeoutMs} onCommit={(value) => updateActivity({ idleTimeoutMs: value })} />
          <ActivityNumberField id="activity-input-pause" label="输入停顿（毫秒）" hint="无输入 N 毫秒后检查视觉 fallback" unit="" max={60_000} min={0} value={activity.inputPauseMs} onCommit={(value) => updateActivity({ inputPauseMs: value })} />
          <ActivityNumberField id="activity-visual-poll" label="画面变化轮询（毫秒）" hint="检查 AX/Fallback 状态；0 = 关闭" unit="" max={600_000} min={0} value={activity.visualPollMs} onCommit={(value) => updateActivity({ visualPollMs: value })} />
          <ActivityNumberField id="activity-browser-poll" label="浏览器标签轮询（毫秒）" hint="前台浏览器（Safari/Chrome/Edge）标签 URL 与标题的采集间隔；0 = 关闭" unit="" max={600_000} min={0} value={activity.browserPollIntervalMs} onCommit={(value) => updateActivity({ browserPollIntervalMs: value })} />
          <ActivityNumberField id="activity-jpeg-quality" label="JPEG 质量" hint="1–100，越低文件越小" unit="" max={100} min={1} value={activity.jpegQuality} onCommit={(value) => updateActivity({ jpegQuality: value })} />
        </div>
      </ActivitySection>

      <ActivitySection id="activity-ocr" icon="file" title="OCR 与输入">
        <div className="activity-toggle-list">
          <ActivitySwitch checked={activity.ocrEnabled} detail="仅 macOS；对视觉 fallback 截图进行识别。" label="对每张快照运行 Vision OCR" onChange={(ocrEnabled) => updateActivity({ ocrEnabled })} />
          <ActivitySwitch checked={activity.inputMonitoringEnabled} detail="记录点击、拖拽、滚轮和键盘活动类型；不记录具体键值。" label="全局键盘与鼠标监听" onChange={(inputMonitoringEnabled) => updateActivity({ inputMonitoringEnabled })} />
        </div>
        <div className="activity-field-grid activity-ocr-fields">
          <label className="activity-field activity-field-wide" htmlFor="activity-ocr-languages">
            <span>OCR 语言（Vision 代码，逗号分隔）</span>
            <input id="activity-ocr-languages" onBlur={commitLanguages} onChange={(event) => setLanguagesText(event.target.value)} value={languagesText} />
          </label>
          <ActivityNumberField id="activity-ocr-every" label="每 N 张快照 OCR 一次" hint="1 = 每张都识别，5 = 每 5 张识别 1 张。" unit="" max={60} min={1} value={activity.ocrEveryNFrames} onCommit={(value) => updateActivity({ ocrEveryNFrames: value })} />
        </div>
      </ActivitySection>

      <ActivitySection id="activity-analysis" icon="brain" title="分析">
        <div className="activity-field-grid activity-analysis-fields">
          <div className="activity-field">
            <span>外部分析策略</span>
            <div aria-label="外部分析策略" className="settings-segmented" role="radiogroup">
              {analysisPolicyOptions.map((option) => (
                <button
                  aria-checked={activity.analysisPolicy === option.value}
                  className={activity.analysisPolicy === option.value ? "is-selected" : ""}
                  key={option.value}
                  onClick={() => updateActivity({ analysisPolicy: option.value })}
                  role="radio"
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
            <small>控制脱敏摘要是否允许送外部模型分析，截图与 OCR 原文永不出设备；confirm_external 表示首次分析前需确认。</small>
          </div>
          <label className="activity-field" htmlFor="activity-analysis-model">
            <span>分析模型</span>
            <input
              id="activity-analysis-model"
              maxLength={200}
              onBlur={commitAnalysisModel}
              onChange={(event) => setAnalysisModelText(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") commitAnalysisModel(); }}
              placeholder="provider:model-id（留空跟随聊天模型）"
              value={analysisModelText}
            />
            <small>留空表示跟随当前聊天模型；也可用 config 模型别名或 provider:model-id 单配一个更便宜的模型。</small>
          </label>
        </div>
      </ActivitySection>

      <ActivitySection id="activity-sensitive-apps" icon="shield" title="敏感应用（不保存文本/截图）">
        <p className="activity-section-description">每行一个 bundle ID，保存后按前台应用精确匹配。这些应用仍可保留必要的事件类型，但不会保存文本、OCR 或截图。</p>
        <textarea aria-label="敏感应用 bundle ID" className="activity-sensitive-apps" onBlur={commitSensitiveApplications} onChange={(event) => setSensitiveApplicationsText(event.target.value)} rows={4} value={sensitiveApplicationsText} />
      </ActivitySection>

      <ActivitySection id="activity-storage" icon="database" title="存储配额">
        <div className="activity-field-grid">
          <ActivityNumberField id="activity-max-storage" label="最大存储（MB）" hint="只限制 fallback JPEG；10240 = 10 GB。" unit="" max={1_048_576} min={256} value={activity.maxStorageMb} onCommit={(value) => updateActivity({ maxStorageMb: value })} />
          <label className="activity-field" htmlFor="activity-output-directory">
            <span>输出目录</span>
            <input id="activity-output-directory" onChange={(event) => updateActivity({ outputDirectory: event.target.value })} value={activity.outputDirectory} />
            <small>全局目录，不写入当前项目；原图目录应保持 0700 权限。</small>
          </label>
        </div>
        <p className="activity-storage-note">事件和脱敏摘要不受 JPEG 容量上限影响；清除操作会删除事件、OCR 和所有 fallback JPEG。</p>
      </ActivitySection>

      <ActivitySection
        action={<button aria-label="刷新最近会话" className="activity-icon-button" onClick={refreshRuntime} title="刷新最近会话" type="button"><Icon name="refresh" size={14} /></button>}
        id="activity-recent-sessions"
        icon="timer"
        title="最近会话"
      >
        {runtime?.recentSessions.length
          ? <div className="activity-recent-list">{runtime.recentSessions.map((session) => <ActivitySession key={session.id} session={session} />)}</div>
          : <div className="activity-empty-state">{runtime?.collectorAvailable === false ? "采集服务尚未接入，暂无可显示的活动会话。" : "暂无活动会话。"}</div>}
      </ActivitySection>

      <section className="activity-card activity-danger-zone" id="activity-danger" tabIndex={-1}>
        <div className="activity-section-title is-danger"><Icon name="trash" size={15} /><h3>危险区</h3></div>
        <p className="activity-section-description">删除全部已记录的活动（会话、事件、OCR 文本和所有 fallback JPEG）。不可撤销。</p>
        <button className="activity-danger-button" disabled={clearing || runtime?.events === 0 || runtime === undefined} onClick={clearActivity} type="button"><Icon name="trash" size={14} />{clearing ? "清除中…" : "清除全部活动数据"}</button>
        <small className="activity-disabled-hint">{runtime?.events ? "会删除会话、事件、截图和脱敏后的 Activity 文本，且不可撤销。" : runtime?.collectorAvailable === false ? "采集服务尚未接入，清除操作暂不可用。" : "暂无可清除的活动数据。"}</small>
      </section>
    </div>
  );
}

function ActivitySession({ session }: { session: ActivitySessionSummary }): React.JSX.Element {
  const applications = session.applications.length ? session.applications.join("、") : "未知应用";
  return <div className="activity-session-row"><strong>{applications}</strong><span>{formatActivityRelativeTime(session.startedAt)} · {session.endedAt ? "已结束" : "活跃"} · {session.snapshotCount} 张快照 · {session.eventCount} 个事件</span></div>;
}

function activityServiceLabel(runtime: ActivityRuntimeSnapshot | undefined): string {
  if (!runtime) return "正在连接";
  if (runtime.state === "running") return "录制中";
  if (runtime.state === "permission_required") return "等待权限";
  if (runtime.state === "error") return "采集错误";
  if (runtime.state === "unavailable") return "不可用";
  if (runtime.state === "paused") return "已暂停";
  return "未连接";
}

function formatActivityBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024 * 1024) >= 1 ? value / (1024 * 1024 * 1024) : value / (1024 * 1024)).toFixed(2)} ${value / (1024 * 1024 * 1024) >= 1 ? "GB" : "MB"}`;
}

function formatActivityRelativeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
  if (elapsedMinutes < 1) return "刚刚";
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} 小时前`;
  return `${Math.floor(elapsedHours / 24)} 天前`;
}

function ActivitySection({ action, children, icon, id, title }: { action?: React.ReactNode; children: React.ReactNode; icon: IconName; id: string; title: string }): React.JSX.Element {
  return (
    <section className="activity-card" id={id} tabIndex={-1}>
      <div className="activity-section-heading">
        <div className="activity-section-title"><Icon name={icon} size={15} /><h3>{title}</h3></div>
        {action}
      </div>
      {children}
    </section>
  );
}

function ActivityStat({ icon, label, value }: { icon: IconName; label: string; value: string }): React.JSX.Element {
  return (
    <div className="activity-stat">
      <span className="activity-stat-label"><Icon name={icon} size={12} />{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ActivityPermission({ detail, label, status }: { detail: string; label: string; status: string }): React.JSX.Element {
  const stateClass = status === "已授权" ? "is-granted" : status === "需授权" ? "is-needed" : status === "未启用" ? "is-disabled" : "";
  /* 状态图标做成圆形徽章：已授权显示对勾，需授权显示警告，其余为中性盾牌。 */
  const stateIcon: IconName = status === "已授权" ? "check" : status === "需授权" ? "warning" : "shield";
  return (
    <div className={`activity-permission-copy ${stateClass}`}>
      <span className="activity-permission-state"><Icon name={stateIcon} size={11} /></span>
      <span className="activity-permission-text">
        <strong>{label}<em>{status}</em></strong>
        <small>{detail}</small>
      </span>
    </div>
  );
}

function ActivitySwitch({ checked, detail, label, onChange }: { checked: boolean; detail?: string; label: string; onChange(value: boolean): void }): React.JSX.Element {
  return (
    <button aria-checked={checked} aria-label={label} className={`activity-switch${checked ? " is-checked" : ""}`} onClick={() => onChange(!checked)} role="switch" type="button">
      {detail ? <span className="activity-switch-copy"><strong>{label}</strong><small>{detail}</small></span> : null}
      <span aria-hidden="true" className="activity-switch-track"><span /></span>
    </button>
  );
}

function ActivityNumberField({ hint, id, label, max, min, onCommit, unit, value }: { hint: string; id: string; label: string; max: number; min: number; onCommit(value: number): void; unit: string; value: number }): React.JSX.Element {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (): void => {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      setText(String(value));
      return;
    }
    const next = Math.min(max, Math.max(min, Math.trunc(parsed)));
    setText(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <label className="activity-field" htmlFor={id}>
      <span>{label}</span>
      <div className="activity-number-input"><input id={id} inputMode="numeric" max={max} min={min} onBlur={commit} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") commit(); }} type="number" value={text} />{unit ? <em>{unit}</em> : null}</div>
      <small>{hint}</small>
    </label>
  );
}
