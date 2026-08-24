/** Activity Recorder 设置页：采集参数可保存，运行时统计和 macOS 授权由采集服务提供。 */
import { useEffect, useState } from "react";
import type { ActivityRuntimeSnapshot, ActivitySessionSummary } from "../../../../../activity/types.js";
import type { DesktopActivitySettingsInput } from "../../../../protocol.js";
import { Icon, type IconName } from "../Icon.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

export function SettingsActivity(): React.JSX.Element {
  const { draft, setActivity } = useSettingsDraft();
  if (!draft) return <div className="settings-sections"><section><p>正在加载活动记录设置…</p></section></div>;
  return <SettingsActivityForm activity={draft.activity} onChange={setActivity} />;
}

function SettingsActivityForm({ activity, onChange }: { activity: DesktopActivitySettingsInput; onChange(value: DesktopActivitySettingsInput): void }): React.JSX.Element {
  const [languagesText, setLanguagesText] = useState(activity.ocrLanguages.join(", "));
  const [sensitiveApplicationsText, setSensitiveApplicationsText] = useState(activity.sensitiveApplications.join("\n"));
  const [runtime, setRuntime] = useState<ActivityRuntimeSnapshot>();
  const [clearing, setClearing] = useState(false);
  const updateActivity = (next: Partial<DesktopActivitySettingsInput>): void => {
    onChange({ ...activity, ...next });
  };

  useEffect(() => {
    setLanguagesText(activity.ocrLanguages.join(", "));
    setSensitiveApplicationsText(activity.sensitiveApplications.join("\n"));
  }, [activity.ocrLanguages, activity.sensitiveApplications]);

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
  const openAccessibilitySettings = (): void => {
    void window.biny.openSystemSettings("accessibility").catch(() => undefined);
  };
  const clearActivity = (): void => {
    if (clearing) return;
    setClearing(true);
    void window.biny.clearActivity().then(setRuntime).catch(() => undefined).finally(() => setClearing(false));
  };
  const storagePercent = runtime === undefined || activity.maxStorageMb <= 0
    ? 0
    : Math.min(100, (runtime.storageBytes / (activity.maxStorageMb * 1024 * 1024)) * 100);
  const runtimeLabel = activity.enabled ? activityServiceLabel(runtime) : "已暂停";
  const runtimeStorage = runtime === undefined
    ? "采集服务未接入"
    : `${formatActivityBytes(runtime.storageBytes)} / ${formatActivityBytes(activity.maxStorageMb * 1024 * 1024)}（${Math.round(storagePercent)}%）`;
  const permissionDetail = runtime?.collectorAvailable === true ? "由 macOS sidecar 检查系统授权" : "采集服务未接入";
  const screenPermission = runtime === undefined ? "待检查" : runtime.screenRecordingGranted ? "已授权" : "未授权";
  const accessibilityPermission = runtime === undefined ? "待检查" : runtime.accessibilityGranted ? "已授权" : "未授权";

  return (
    <div className="settings-sections activity-settings">
      <section className="activity-card activity-overview" id="activity-overview" tabIndex={-1}>
        <div className="activity-overview-heading">
          <div className="activity-heading-copy">
            <div className="activity-title-line">
              <Icon name="activity" size={16} />
              <h3>活动记录器</h3>
              <span className={`activity-status-badge${activity.enabled ? " is-enabled" : ""}`}>
                {runtimeLabel}
              </span>
            </div>
            <p>静默截屏、OCR 识别并跟踪输入事件，让 Chat 能回答“我刚才在做什么”。原始数据只在本地处理。</p>
          </div>
          <ActivitySwitch checked={activity.enabled} label="启用活动记录器" onChange={(enabled) => updateActivity({ enabled })} />
        </div>
        <div className="activity-stat-grid">
          <ActivityStat label="会话数" value={runtime === undefined ? "—" : String(runtime.sessions)} />
          <ActivityStat label="快照数" value={runtime === undefined ? "—" : String(runtime.captures)} />
          <ActivityStat label="当前会话" value={runtime?.currentSessionId ? "活跃" : runtime === undefined ? "未连接" : "无"} />
          <ActivityStat label="前台应用" value={runtime?.currentApplication ?? "—"} />
        </div>
        <div className="activity-storage-summary">
          <div><span>已用存储</span><strong>{runtimeStorage}</strong></div>
          <span className="activity-storage-hint">超过上限的旧快照会自动删除</span>
        </div>
        <div aria-hidden="true" className="activity-progress"><span style={{ width: `${storagePercent}%` }} /></div>
        <div className="settings-inline-notice activity-privacy-notice">
          <Icon name="shield" size={15} />
          <span><strong>仅本地模型</strong> Activity 只允许内置 llama.cpp 查询、总结和注入；云模型不会收到活动摘要，也不会自动 fallback。未来外发策略当前版本暂不支持。</span>
        </div>
      </section>

      <ActivitySection id="activity-permissions" icon="shield" title="macOS 权限">
        <div className="activity-permission-list">
          <ActivityPermission icon="shield" label="屏幕录制" detail={permissionDetail} status={screenPermission} />
          <div className="activity-permission-row">
            <ActivityPermission icon="shield" label="辅助功能（用于全局键盘监听）" detail={permissionDetail} status={accessibilityPermission} />
            <button className="activity-secondary-button" onClick={openAccessibilitySettings} type="button">
              <Icon name="external" size={13} />
              打开系统设置
            </button>
          </div>
        </div>
      </ActivitySection>

      <ActivitySection id="activity-capture" icon="activity" title="采集">
        <div className="activity-field-grid">
          <ActivityNumberField id="activity-debounce" label="快照防抖" hint="两次采集之间的最小间隔" unit="毫秒" max={60_000} min={250} value={activity.captureDebounceMs} onCommit={(value) => updateActivity({ captureDebounceMs: value })} />
          <ActivityNumberField id="activity-heartbeat" label="心跳间隔" hint="即使空间也按此间隔强制采集" unit="毫秒" max={600_000} min={1_000} value={activity.heartbeatMs} onCommit={(value) => updateActivity({ heartbeatMs: value })} />
          <ActivityNumberField id="activity-idle" label="空闲阈值" hint="无输入达到时长后关闭会话" unit="毫秒" max={600_000} min={1_000} value={activity.idleTimeoutMs} onCommit={(value) => updateActivity({ idleTimeoutMs: value })} />
          <ActivityNumberField id="activity-input-pause" label="输入暂停" hint="无按键 N 毫秒后采集" unit="毫秒" max={60_000} min={0} value={activity.inputPauseMs} onCommit={(value) => updateActivity({ inputPauseMs: value })} />
          <ActivityNumberField id="activity-visual-poll" label="画面变化轮询" hint="无输入时检测画面变化（0 = 关闭）" unit="毫秒" max={600_000} min={0} value={activity.visualPollMs} onCommit={(value) => updateActivity({ visualPollMs: value })} />
          <ActivityNumberField id="activity-jpeg-quality" label="JPEG 质量" hint="1–100，越低文件越小" unit="" max={100} min={1} value={activity.jpegQuality} onCommit={(value) => updateActivity({ jpegQuality: value })} />
        </div>
      </ActivitySection>

      <ActivitySection id="activity-ocr" icon="file" title="OCR 与输入">
        <div className="activity-toggle-list">
          <ActivitySwitch checked={activity.ocrEnabled} detail="仅 macOS、快照与语言设置使用。" label="对每张快照运行 Vision OCR" onChange={(ocrEnabled) => updateActivity({ ocrEnabled })} />
          <ActivitySwitch checked={activity.inputMonitoringEnabled} detail="记录点击/按键事件，不记录具体键值。" label="全局键盘与鼠标监听" onChange={(inputMonitoringEnabled) => updateActivity({ inputMonitoringEnabled })} />
        </div>
        <div className="activity-field-grid activity-ocr-fields">
          <label className="activity-field activity-field-wide" htmlFor="activity-ocr-languages">
            <span>OCR 语言（Vision 代码，逗号分隔）</span>
            <input id="activity-ocr-languages" onBlur={commitLanguages} onChange={(event) => setLanguagesText(event.target.value)} value={languagesText} />
          </label>
          <ActivityNumberField id="activity-ocr-every" label="每 N 张快照 OCR 一次" hint="1 = 每张都识别，5 = 每 5 张识别 1 张。长会话可降低频率。" unit="" max={60} min={1} value={activity.ocrEveryNFrames} onCommit={(value) => updateActivity({ ocrEveryNFrames: value })} />
        </div>
      </ActivitySection>

      <ActivitySection id="activity-sensitive-apps" icon="shield" title="敏感应用（永不采集）">
        <p className="activity-section-description">每行一个 bundle ID。这些应用在前台时不采集截图、OCR 或输入活动。</p>
        <textarea aria-label="敏感应用 bundle ID" className="activity-sensitive-apps" onBlur={commitSensitiveApplications} onChange={(event) => setSensitiveApplicationsText(event.target.value)} rows={4} value={sensitiveApplicationsText} />
      </ActivitySection>

      <ActivitySection id="activity-storage" icon="database" title="存储配置">
        <div className="activity-field-grid">
          <ActivityNumberField id="activity-max-storage" label="最大存储" hint="超过上限时自动删除最旧快照。10240 = 10 GB。" unit="MB" max={1_048_576} min={256} value={activity.maxStorageMb} onCommit={(value) => updateActivity({ maxStorageMb: value })} />
          <label className="activity-field" htmlFor="activity-output-directory">
            <span>输出目录</span>
            <input id="activity-output-directory" onChange={(event) => updateActivity({ outputDirectory: event.target.value })} value={activity.outputDirectory} />
            <small>全局目录，不写入当前项目；原图目录应保持 0700 权限。</small>
          </label>
        </div>
        <p className="activity-storage-note">快照随年龄逐级压缩（warm: 1280×720 q40，cold: ≤640×360 q30）。超出上限时自动删除最旧快照。</p>
      </ActivitySection>

      <ActivitySection id="activity-recent-sessions" icon="timer" title="最近会话">
        {runtime?.recentSessions.length
          ? <div className="activity-recent-list">{runtime.recentSessions.map((session) => <ActivitySession key={session.id} session={session} />)}</div>
          : <div className="activity-empty-state">{runtime?.collectorAvailable === false ? "采集服务尚未接入，暂无可显示的活动会话。" : "暂无活动会话。"}</div>}
      </ActivitySection>

      <section className="activity-card activity-danger-zone" id="activity-danger" tabIndex={-1}>
        <div className="activity-section-title is-danger"><Icon name="trash" size={15} /><h3>危险区</h3></div>
        <p className="activity-section-description">删除全部已记录的活动（会话、磁盘上的截图、OCR 文本、向量）。不可撤销。</p>
        <button className="activity-danger-button" disabled={clearing || runtime?.captures === 0 || runtime === undefined} onClick={clearActivity} type="button"><Icon name="trash" size={14} />{clearing ? "清除中…" : "清除全部活动数据"}</button>
        <small className="activity-disabled-hint">{runtime?.captures ? "会删除会话、截图和脱敏后的 Activity 文本，且不可撤销。" : runtime?.collectorAvailable === false ? "采集服务尚未接入，清除操作暂不可用。" : "暂无可清除的活动数据。"}</small>
      </section>
    </div>
  );
}

function ActivitySession({ session }: { session: ActivitySessionSummary }): React.JSX.Element {
  const applications = session.applications.length ? session.applications.join("、") : "未知应用";
  return <div className="activity-session-row"><strong>{applications}</strong><span>{formatActivityDate(session.startedAt)} · {session.endedAt ? "已结束" : "活跃"} · {session.eventCount} 个快照</span></div>;
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

function formatActivityDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function ActivitySection({ children, icon, id, title }: { children: React.ReactNode; icon: IconName; id: string; title: string }): React.JSX.Element {
  return (
    <section className="activity-card" id={id} tabIndex={-1}>
      <div className="activity-section-title"><Icon name={icon} size={15} /><h3>{title}</h3></div>
      {children}
    </section>
  );
}

function ActivityStat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className="activity-stat"><span>{label}</span><strong>{value}</strong></div>;
}

function ActivityPermission({ detail, icon, label, status }: { detail: string; icon: IconName; label: string; status: string }): React.JSX.Element {
  return <div className="activity-permission-copy"><Icon name={icon} size={14} /><span><strong>{label}</strong><small>{detail}</small></span><em>{status}</em></div>;
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
