/** Activity Recorder 设置页：只展示采集设置、运行态摘要和可操作的 macOS 权限入口。 */
import { useEffect, useRef, useState } from "react";
import type { ActivityAnalysisPolicy } from "../../../../../activity/settings.js";
import type { ActivityRuntimeSnapshot, ActivitySessionSummary } from "../../../../../activity/types.js";
import type { DesktopActivityReport, DesktopActivitySessionDetail, DesktopActivitySettingsInput } from "../../../../protocol.js";
import { Icon, type IconName } from "../Icon.js";
import { SettingsDetailLayer } from "./SettingsDetailLayer.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

const analysisPolicyOptions: Array<{ value: ActivityAnalysisPolicy; label: string }> = [
  { value: "local_only", label: "仅本地" },
  { value: "confirm_external", label: "需确认" },
  { value: "external_allowed", label: "允许外部" }
];

export function SettingsActivity(): React.JSX.Element {
  const { draft, updateActivityImmediately } = useSettingsDraft();
  if (!draft) return <div aria-busy="true" className="settings-sections"><section><p role="status">正在加载活动记录设置…</p></section></div>;
  return <SettingsActivityForm activity={draft.activity} onChange={updateActivityImmediately} />;
}

function SettingsActivityForm({ activity, onChange }: { activity: DesktopActivitySettingsInput; onChange(patch: Partial<DesktopActivitySettingsInput>): Promise<void> }): React.JSX.Element {
  const [languagesText, setLanguagesText] = useState(activity.ocrLanguages.join(", "));
  const [sensitiveApplicationsText, setSensitiveApplicationsText] = useState(activity.sensitiveApplications.join("\n"));
  const [analysisModelText, setAnalysisModelText] = useState(activity.analysisModel ?? "");
  const [runtime, setRuntime] = useState<ActivityRuntimeSnapshot>();
  const [clearing, setClearing] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [sessionDetail, setSessionDetail] = useState<DesktopActivitySessionDetail>();
  const [sessionDetailLoading, setSessionDetailLoading] = useState(false);
  const [sessionDetailError, setSessionDetailError] = useState<string>();
  const [previewError, setPreviewError] = useState<string>();
  const [previewSnapshotId, setPreviewSnapshotId] = useState<number>();
  const [previewSource, setPreviewSource] = useState<string>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [activityQuery, setActivityQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Awaited<ReturnType<typeof window.biny.searchActivity>>>();
  const [searching, setSearching] = useState(false);
  const [reportDate, setReportDate] = useState("today");
  const [report, setReport] = useState<DesktopActivityReport>();
  const [reporting, setReporting] = useState(false);
  const [activityUpdateCount, setActivityUpdateCount] = useState(0);
  const sessionDetailRequestId = useRef(0);
  const previewRequestId = useRef(0);
  const languagesInputRef = useRef<HTMLInputElement>(null);
  const sensitiveApplicationsInputRef = useRef<HTMLTextAreaElement>(null);
  const analysisModelInputRef = useRef<HTMLInputElement>(null);
  const activityFocusRestoreRef = useRef<{ id?: string; ariaLabel?: string } | undefined>(undefined);
  const updateActivity = (patch: Partial<DesktopActivitySettingsInput>): void => {
    const activeElement = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : undefined;
    if (activeElement) {
      activityFocusRestoreRef.current = {
        id: activeElement.id || undefined,
        ariaLabel: activeElement.getAttribute("aria-label") ?? undefined
      };
    }
    setActivityUpdateCount((count) => count + 1);
    setFeedback(undefined);
    void onChange(patch).catch((error: unknown) => {
      setFeedback(activityErrorMessage(error));
    }).finally(() => {
      setActivityUpdateCount((count) => Math.max(0, count - 1));
    });
  };

  useEffect(() => {
    if (activityUpdateCount !== 0) return;
    const target = activityFocusRestoreRef.current;
    activityFocusRestoreRef.current = undefined;
    if (!target || document.activeElement !== document.body) return;
    const candidate = target.id
      ? document.getElementById(target.id)
      : target.ariaLabel
        ? [...document.querySelectorAll<HTMLElement>("[aria-label]")].find((element) => {
          const rect = element.getBoundingClientRect();
          return element.getAttribute("aria-label") === target.ariaLabel && rect.width > 0 && rect.height > 0;
        })
        : undefined;
    candidate?.focus();
  }, [activityUpdateCount]);

  useEffect(() => {
    if (document.activeElement !== languagesInputRef.current) setLanguagesText(activity.ocrLanguages.join(", "));
    if (document.activeElement !== sensitiveApplicationsInputRef.current) setSensitiveApplicationsText(activity.sensitiveApplications.join("\n"));
    if (document.activeElement !== analysisModelInputRef.current) setAnalysisModelText(activity.analysisModel ?? "");
  }, [activity.ocrLanguages, activity.sensitiveApplications, activity.analysisModel]);

  useEffect(() => {
    let cancelled = false;
    const refresh = (): void => {
      void window.biny.activitySnapshot().then((next) => {
        if (!cancelled) setRuntime(next);
      }).catch((error: unknown) => {
        if (!cancelled) setFeedback(activityErrorMessage(error));
      });
    };
    refresh();
    const unsubscribe = window.biny.onActivityEvent((next) => {
      if (!cancelled) setRuntime(next);
    });
    const interval = window.setInterval(refresh, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      unsubscribe();
    };
  }, []);

  const refreshRuntime = (): void => {
    void window.biny.activitySnapshot().then(setRuntime).catch((error: unknown) => setFeedback(activityErrorMessage(error)));
  };

  const commitLanguages = (): void => {
    const languages = languagesText.split(",").map((value) => value.trim()).filter(Boolean);
    if (languages.length === 0 || languages.some((value) => value.length < 2 || value.length > 32)) {
      setLanguagesText(activity.ocrLanguages.join(", "));
      return;
    }
    setLanguagesText(languages.join(", "));
  };
  const updateLanguages = (value: string): void => {
    setLanguagesText(value);
    const languages = value.split(",").map((item) => item.trim()).filter(Boolean);
    if (languages.length > 0 && languages.every((item) => item.length >= 2 && item.length <= 32)) {
      updateActivity({ ocrLanguages: languages });
    }
  };
  const updateSensitiveApplications = (value: string): void => {
    setSensitiveApplicationsText(value);
    updateActivity({ sensitiveApplications: value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean) });
  };
  const commitAnalysisModel = (): void => {
    const trimmed = analysisModelText.trim();
    // 空串等价于「未配置」：主进程 schema 对 analysisModel 要求 min(1)，清空时必须回退 undefined 才能保存。
    updateActivity({ analysisModel: trimmed || undefined });
    setAnalysisModelText(trimmed);
  };
  const openPermissionSettings = (pane: "screen-recording" | "accessibility"): void => {
    void window.biny.requestActivityPermission(pane)
      .catch(() => undefined)
      .then(() => window.biny.openSystemSettings(pane))
      .catch(() => undefined);
  };
  const openAccessibilitySettings = (): void => openPermissionSettings("accessibility");
  const openScreenRecordingSettings = (): void => openPermissionSettings("screen-recording");
  const clearActivity = (): void => {
    if (clearing) return;
    setClearOpen(true);
  };
  const confirmClearActivity = (): void => {
    if (clearing) return;
    setClearing(true);
    void window.biny.clearActivity().then((next) => {
      setRuntime(next);
      setClearOpen(false);
      setSelectedSessionId(undefined);
      setSessionDetail(undefined);
      sessionDetailRequestId.current += 1;
      previewRequestId.current += 1;
      setPreviewError(undefined);
      setSearchResults(undefined);
      setReport(undefined);
      setFeedback("已清除全部 Activity 数据。");
    }).catch((error: unknown) => setFeedback(activityErrorMessage(error))).finally(() => setClearing(false));
  };
  const openSession = (sessionId: string): void => {
    const requestId = ++sessionDetailRequestId.current;
    previewRequestId.current += 1;
    setSelectedSessionId(sessionId);
    setSessionDetail(undefined);
    setSessionDetailError(undefined);
    setPreviewError(undefined);
    setPreviewSnapshotId(undefined);
    setPreviewSource(undefined);
    setSessionDetailLoading(true);
    void window.biny.activitySessionDetail(sessionId).then((detail) => {
      if (requestId !== sessionDetailRequestId.current) return;
      if (detail === undefined) {
        setSessionDetailError("这个会话已经不存在，可能刚刚被清除。");
        return;
      }
      setSessionDetail(detail);
    }).catch((error: unknown) => {
      if (requestId === sessionDetailRequestId.current) setSessionDetailError(activityErrorMessage(error));
    }).finally(() => {
      if (requestId === sessionDetailRequestId.current) setSessionDetailLoading(false);
    });
  };
  const closeSession = (): void => {
    sessionDetailRequestId.current += 1;
    previewRequestId.current += 1;
    setSelectedSessionId(undefined);
    setSessionDetail(undefined);
    setSessionDetailError(undefined);
    setPreviewError(undefined);
    setPreviewSnapshotId(undefined);
    setPreviewSource(undefined);
  };
  const loadSnapshotPreview = (snapshotId: number): void => {
    if (previewSnapshotId === snapshotId && previewSource) return;
    const requestId = ++previewRequestId.current;
    setPreviewSnapshotId(snapshotId);
    setPreviewSource(undefined);
    setPreviewError(undefined);
    setPreviewLoading(true);
    void window.biny.activitySnapshotPreview(snapshotId).then((source) => {
      if (requestId !== previewRequestId.current) return;
      if (source) setPreviewSource(source);
      else setPreviewError("这张截图已被容量清理，或文件暂时不可读。");
    }).catch((error: unknown) => {
      if (requestId === previewRequestId.current) setPreviewError(activityErrorMessage(error));
    }).finally(() => {
      if (requestId === previewRequestId.current) setPreviewLoading(false);
    });
  };
  const searchActivity = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const query = activityQuery.trim();
    if (!query || searching) return;
    setSearching(true);
    setFeedback(undefined);
    void window.biny.searchActivity(query, 40).then(setSearchResults).catch((error: unknown) => {
      setSearchResults(undefined);
      setFeedback(activityErrorMessage(error));
    }).finally(() => setSearching(false));
  };
  const loadReport = (): void => {
    if (reporting) return;
    setReporting(true);
    setFeedback(undefined);
    void window.biny.activityReport(reportDate.trim() || "today").then(setReport).catch((error: unknown) => {
      setReport(undefined);
      setFeedback(activityErrorMessage(error));
    }).finally(() => setReporting(false));
  };
  const storagePercent = runtime === undefined || activity.maxStorageMb <= 0
    ? 0
    : Math.min(100, (runtime.storageBytes / (activity.maxStorageMb * 1024 * 1024)) * 100);
  const runtimeLabel = activity.enabled ? activityServiceLabel(runtime) : "已暂停";
  const isRuntimeRunning = activity.enabled && runtime?.state === "running";
  const isRecording = isRuntimeRunning && runtime?.screenLocked === false;
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
  const activityUpdating = activityUpdateCount > 0;

  return (
      <div className="settings-sections activity-settings">
      <section aria-busy={activityUpdating} className="activity-card activity-overview" id="activity-overview" tabIndex={-1}>
        <div className="activity-overview-heading">
          <div className="activity-heading-copy">
            <div className="activity-title-line">
              <Icon name="activity" size={16} />
              <h3>活动记录器</h3>
              <span className={`activity-status-badge${isRecording ? " is-recording" : activity.enabled ? " is-enabled" : ""}`}>
                {runtimeLabel}
              </span>
              {isRuntimeRunning && runtime?.screenLocked ? <span className="activity-status-badge is-locked"><Icon name="lock" size={11} />已锁屏</span> : null}
            </div>
            <p>以周期性整屏截图和本地 Vision OCR 为主，输入与 AX 事件作为时间线补充。原始截图始终留在本机，脱敏文本是否送模型由分析策略控制。</p>
          </div>
          <ActivitySwitch busy={activityUpdating} checked={activity.enabled} disabled={activityUpdating} label="启用活动记录器" onChange={(enabled) => updateActivity({ enabled })} />
        </div>
        {activity.enabled ? <>
          <div className="activity-stat-grid">
            <ActivityStat icon="timer" label="会话数" value={runtime === undefined ? "—" : String(runtime.sessions)} />
            <ActivityStat icon="database" label="截图存储" value={runtime === undefined ? "—" : formatActivityBytes(runtime.storageBytes)} />
            <ActivityStat icon="activity" label="当前会话" value={runtime === undefined ? "—" : runtime.screenLocked ? "已锁屏" : runtime.currentSessionId ? "活跃" : "空闲"} />
            <ActivityStat icon="display" label="前台应用" value={runtime?.currentApplication ?? "—"} />
          </div>
          <div className="activity-storage-summary">
            <div><span>已用存储</span><strong>{runtimeStorage}</strong></div>
            <span className="activity-storage-hint">{runtime === undefined ? "超过上限时旧截图 JPEG 会自动删除" : `${runtime.fallbackCaptures} 张截图 · 超过上限时旧 JPEG 会自动删除`}</span>
          </div>
          <div aria-hidden="true" className="activity-progress"><span style={{ width: `${storagePercent}%` }} /></div>
        </> : null}
        {runtime?.error ? <p className="activity-section-description" role="alert">{runtime.error}</p> : null}
        {feedback ? <p aria-live="polite" className="activity-feedback" role="status">{feedback}</p> : null}
      </section>

      <ActivitySection
        action={<button aria-label="刷新 macOS 权限状态" className="activity-icon-button" onClick={refreshRuntime} title="刷新权限状态" type="button"><Icon name="refresh" size={14} /></button>}
        id="activity-permissions"
        icon="shield"
        title="macOS 权限"
      >
        <div className="activity-permission-list">
          <div className="activity-permission-row">
            <ActivityPermission detail="隐私与安全性 → 屏幕录制" label="屏幕录制（截图与 OCR 主链路）" status={screenPermission} />
            {screenPermission === "需授权" ? (
              <button aria-label="在 macOS 系统设置中管理屏幕录制权限" className="activity-secondary-button" onClick={openScreenRecordingSettings} type="button">
                <Icon name="external" size={13} />
                打开系统设置
              </button>
            ) : null}
          </div>
          <div className="activity-permission-row">
            <ActivityPermission detail="隐私与安全性 → 辅助功能" label="辅助功能（AX 事件流与全局输入监听）" status={accessibilityPermission} />
            {accessibilityPermission === "需授权" ? (
              <button aria-label="在 macOS 系统设置中管理辅助功能权限" className="activity-secondary-button" onClick={openAccessibilitySettings} type="button">
                <Icon name="external" size={13} />
                打开系统设置
              </button>
            ) : null}
          </div>
          {runtime?.screenRecordingGranted === false && runtime?.collectorAvailable === true
            ? <p className="activity-section-description">输入事件仍可记录，但截图与 OCR 暂不可用。</p>
            : null}
        </div>
      </ActivitySection>

      <ActivitySection id="activity-capture" icon="activity" title="采集">
        <div className="activity-field-grid">
          <ActivityNumberField disabled={!activity.enabled} id="activity-debounce" label="截图防抖（毫秒）" hint="范围：3000–30000" unit="" max={30_000} min={3_000} step={100} value={activity.captureDebounceMs} onCommit={(value) => updateActivity({ captureDebounceMs: value })} />
          <ActivityNumberField disabled={!activity.enabled} id="activity-heartbeat" label="心跳间隔（毫秒）" hint="画面不变时仍按此间隔保留时间锚点" unit="" max={300_000} min={60_000} step={1_000} value={activity.heartbeatMs} onCommit={(value) => updateActivity({ heartbeatMs: value })} />
          <ActivityNumberField disabled={!activity.enabled} id="activity-idle" label="空闲阈值（毫秒）" hint="无事件达到该时长后关闭当前会话" unit="" max={600_000} min={10_000} step={5_000} value={activity.idleTimeoutMs} onCommit={(value) => updateActivity({ idleTimeoutMs: value })} />
          <ActivityNumberField disabled={!activity.enabled} id="activity-input-pause" label="输入停顿（毫秒）" hint="无输入 N 毫秒后检查是否需要截图" unit="" max={5_000} min={800} step={100} value={activity.inputPauseMs} onCommit={(value) => updateActivity({ inputPauseMs: value })} />
          <ActivityNumberField disabled={!activity.enabled} id="activity-visual-poll" label="截图轮询（毫秒）" hint="定期检查画面并触发截图；0 = 关闭" unit="" max={30_000} min={0} step={500} value={activity.visualPollMs} onCommit={(value) => updateActivity({ visualPollMs: value })} />
          <ActivityNumberField disabled={!activity.enabled} id="activity-browser-poll" label="浏览器标签轮询（毫秒）" hint="前台浏览器标签 URL 与标题的采集间隔；0 = 关闭" unit="" max={600_000} min={0} step={1_000} value={activity.browserPollIntervalMs} onCommit={(value) => updateActivity({ browserPollIntervalMs: value })} />
          <ActivityNumberField disabled={!activity.enabled} id="activity-jpeg-quality" label="JPEG 质量" hint="30–95，越低文件越小" unit="" max={95} min={30} step={5} value={activity.jpegQuality} onCommit={(value) => updateActivity({ jpegQuality: value })} />
        </div>
      </ActivitySection>

      <ActivitySection id="activity-ocr" icon="file" title="OCR 与输入">
        <div className="activity-toggle-list">
          <ActivitySwitch checked={activity.ocrEnabled} detail="仅 macOS；对活动截图运行本地 Vision 识别。" disabled={!activity.enabled} label="对活动截图运行 Vision OCR" onChange={(ocrEnabled) => updateActivity({ ocrEnabled })} />
          <ActivitySwitch checked={activity.inputMonitoringEnabled} detail="需要 macOS‘辅助功能’授权；记录点击和键盘活动类型，不记录具体键值。" disabled={!activity.enabled} label="全局键盘与鼠标监听" onChange={(inputMonitoringEnabled) => updateActivity({ inputMonitoringEnabled })} />
        </div>
        <div className="activity-field-grid activity-ocr-fields">
          <label className="activity-field activity-field-wide" htmlFor="activity-ocr-languages">
            <span>OCR 语言（Vision 代码，逗号分隔）</span>
            <input aria-describedby="activity-ocr-languages-hint" autoComplete="off" disabled={!activity.enabled} id="activity-ocr-languages" name="activity-ocr-languages" onBlur={commitLanguages} onChange={(event) => updateLanguages(event.target.value)} ref={languagesInputRef} spellCheck={false} value={languagesText} />
            <small id="activity-ocr-languages-hint">例如 en-US, zh-Hans；修改后立即对新快照生效。</small>
          </label>
          <ActivityNumberField disabled={!activity.enabled} id="activity-ocr-every" label="每 N 张快照 OCR 一次" hint="1 = 每张都识别，5 = 每 5 张识别 1 张。" unit="" max={20} min={1} step={1} value={activity.ocrEveryNFrames} onCommit={(value) => updateActivity({ ocrEveryNFrames: value })} />
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
            <small>控制脱敏摘要和脱敏 OCR 是否允许送外部模型分析；原始截图永不出设备。confirm_external 表示首次分析前需确认。</small>
          </div>
          <label className="activity-field" htmlFor="activity-analysis-model">
            <span>分析模型</span>
            <input
              autoComplete="off"
              id="activity-analysis-model"
              maxLength={200}
              onBlur={commitAnalysisModel}
              onChange={(event) => setAnalysisModelText(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") commitAnalysisModel(); }}
              placeholder="provider:model-id（留空跟随聊天模型）…"
              spellCheck={false}
              ref={analysisModelInputRef}
              value={analysisModelText}
            />
            <small>留空表示跟随当前聊天模型；也可用 config 模型别名或 provider:model-id 单配一个更便宜的模型。</small>
          </label>
        </div>
      </ActivitySection>

      <ActivitySection id="activity-sensitive-apps" icon="shield" title="敏感应用（不保存文本/截图）">
        <p className="activity-section-description">每行一个 bundle ID，修改后按前台应用精确匹配。这些应用仍可保留必要的事件类型，但不会保存文本、OCR 或截图。</p>
        <textarea aria-label="敏感应用 bundle ID" autoComplete="off" className="activity-sensitive-apps" disabled={!activity.enabled} name="activity-sensitive-applications" onChange={(event) => updateSensitiveApplications(event.target.value)} ref={sensitiveApplicationsInputRef} rows={4} spellCheck={false} value={sensitiveApplicationsText} />
      </ActivitySection>

      <ActivitySection id="activity-storage" icon="database" title="存储配额">
        <div className="activity-field-grid">
          <ActivityNumberField disabled={!activity.enabled} id="activity-max-storage" label="最大存储（MB）" hint="只限制截图 JPEG；10240 = 10 GB。" unit="" max={200_000} min={100} step={100} value={activity.maxStorageMb} onCommit={(value) => updateActivity({ maxStorageMb: value })} />
          <label className="activity-field" htmlFor="activity-output-directory">
            <span>输出目录</span>
            <input aria-describedby="activity-output-directory-hint" autoComplete="off" id="activity-output-directory" name="activity-output-directory" readOnly spellCheck={false} value={activity.outputDirectory} />
            <small id="activity-output-directory-hint">全局目录，不写入当前项目；原图目录应保持 0700 权限。</small>
          </label>
        </div>
        <p className="activity-storage-note">事件和脱敏摘要不受 JPEG 容量上限影响；清除操作会删除事件、OCR 和所有截图 JPEG。</p>
      </ActivitySection>

      {activity.enabled && runtime?.recentSessions.length ? <ActivitySection
        action={<button aria-label="刷新最近会话" className="activity-icon-button" onClick={refreshRuntime} title="刷新最近会话" type="button"><Icon name="refresh" size={14} /></button>}
        id="activity-recent-sessions"
        icon="timer"
        title="最近会话"
      >
        <div className="activity-recent-list">{runtime.recentSessions.map((session) => <ActivitySession key={session.id} onOpen={openSession} session={session} />)}</div>
      </ActivitySection> : null}

      <ActivitySection id="activity-recall" icon="search" title="检索与日报">
        <form className="activity-search-form" onSubmit={searchActivity}>
          <label className="activity-field" htmlFor="activity-search-query">
            <span>搜索已记录活动</span>
            <input aria-describedby="activity-search-hint" autoComplete="off" id="activity-search-query" name="activity-search-query" onChange={(event) => setActivityQuery(event.target.value)} placeholder="搜索应用、窗口、OCR 或事件…" type="search" value={activityQuery} />
            <small id="activity-search-hint">关键词搜索已脱敏的事件与 OCR；点击结果可以打开对应会话。</small>
          </label>
          <button aria-busy={searching} className="activity-secondary-button" disabled={searching || !activityQuery.trim()} type="submit"><Icon name="search" size={14} />{searching ? "搜索中…" : "搜索"}</button>
        </form>
        {searchResults ? (
          searchResults.length ? (
            <ul aria-busy={searching} aria-label="活动搜索结果" className="activity-search-results" role="list">
              {searchResults.map((result) => (
                <li key={`${result.id}-${result.sessionId}`}>
                  <button className="activity-search-result" onClick={() => openSession(result.sessionId)} type="button">
                    <strong>{result.application ?? "未知应用"}</strong>
                    <span>{formatActivityDateTime(result.occurredAt)} · {result.summary}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <div className="activity-empty-state">没有找到匹配的活动记录。</div>
        ) : null}
        <div className="activity-report-row">
          <label className="activity-field" htmlFor="activity-report-date">
            <span>生成工作日报</span>
            <input aria-describedby="activity-report-hint" autoComplete="off" id="activity-report-date" name="activity-report-date" onChange={(event) => setReportDate(event.target.value)} placeholder="today、yesterday 或 2026-08-31…" spellCheck={false} value={reportDate} />
            <small id="activity-report-hint">按本地日期聚合已分析会话；没有模型时仍会显示已完成的分析。</small>
          </label>
          <div className="activity-report-actions">
            <button className="activity-icon-button" onClick={() => setReportDate("today")} title="使用今天" type="button">今天</button>
            <button className="activity-icon-button" onClick={() => setReportDate("yesterday")} title="使用昨天" type="button">昨天</button>
            <button aria-busy={reporting} className="activity-secondary-button" disabled={reporting} onClick={loadReport} type="button"><Icon name="calendar" size={14} />{reporting ? "生成中…" : "生成日报"}</button>
          </div>
        </div>
        {report ? <div aria-label={`${report.date} 活动日报`} aria-live="polite" className="activity-report-output" role="region"><pre>{report.markdown}</pre>{report.message ? <p>{report.message}</p> : null}</div> : null}
      </ActivitySection>

      <section className="activity-card activity-danger-zone" id="activity-danger" tabIndex={-1}>
        <div className="activity-section-title is-danger"><Icon name="trash" size={15} /><h3>危险区</h3></div>
        <p className="activity-section-description">删除全部已记录的活动（会话、事件、OCR 文本和所有截图 JPEG）。不可撤销。</p>
        <button className="activity-danger-button" disabled={clearing || runtime?.sessions === 0 || runtime === undefined} onClick={clearActivity} type="button"><Icon name="trash" size={14} />{clearing ? "清除中…" : "清除全部活动数据"}</button>
        <small className="activity-disabled-hint">{runtime?.sessions ? "会删除会话、事件、截图、OCR 和脱敏后的 Activity 文本，且不可撤销。" : runtime?.collectorAvailable === false ? "采集服务尚未接入，清除操作暂不可用。" : "暂无可清除的活动数据。"}</small>
      </section>

      {isRuntimeRunning ? <p className="activity-running-footer">运行中 · 多数参数即时生效；会话/空闲计时相关改动在下个会话生效。</p> : null}

      {selectedSessionId ? (
        <SettingsDetailLayer onClose={closeSession}>
          <ActivitySessionDetailPanel
            detail={sessionDetail}
            error={sessionDetailError}
            loading={sessionDetailLoading}
            onClose={closeSession}
            onPreviewSnapshot={loadSnapshotPreview}
            previewLoading={previewLoading}
            previewError={previewError}
            previewSnapshotId={previewSnapshotId}
            previewSource={previewSource}
          />
        </SettingsDetailLayer>
      ) : null}

      {clearOpen ? (
        <SettingsDetailLayer onClose={() => { if (!clearing) setClearOpen(false); }}>
          <section aria-describedby="activity-clear-description" aria-labelledby="activity-clear-title" aria-modal="true" className="settings-confirm-panel activity-clear-panel" role="dialog">
            <h3 id="activity-clear-title">清除全部 Activity 数据？</h3>
            <p id="activity-clear-description">将永久删除 {runtime?.sessions ?? 0} 个会话、{runtime?.events ?? 0} 个事件、截图和 OCR。此操作不可撤销。</p>
            <div className="settings-confirm-actions"><button className="ghost-button" disabled={clearing} onClick={() => setClearOpen(false)} type="button">取消</button><button className="ghost-button is-danger" disabled={clearing} onClick={confirmClearActivity} type="button"><Icon name="trash" size={14} />{clearing ? "清除中…" : "永久清除"}</button></div>
          </section>
        </SettingsDetailLayer>
      ) : null}
    </div>
  );
}

function ActivitySession({ onOpen, session }: { onOpen(sessionId: string): void; session: ActivitySessionSummary }): React.JSX.Element {
  const applications = session.applications.length ? session.applications.join("、") : "未知应用";
  return <button aria-label={`打开 ${applications} 的活动会话`} className="activity-session-row" onClick={() => onOpen(session.id)} type="button"><strong>{applications}</strong><span>{formatActivityRelativeTime(session.startedAt)} · {session.endedAt ? "已结束" : "活跃"} · {session.snapshotCount} 张截图 · {session.eventCount} 个事件</span><em>点击查看时间线与截图</em></button>;
}

function ActivitySessionDetailPanel({
  detail,
  error,
  loading,
  onClose,
  onPreviewSnapshot,
  previewError,
  previewLoading,
  previewSnapshotId,
  previewSource
}: {
  detail: DesktopActivitySessionDetail | undefined;
  error: string | undefined;
  loading: boolean;
  onClose(): void;
  onPreviewSnapshot(snapshotId: number): void;
  previewError: string | undefined;
  previewLoading: boolean;
  previewSnapshotId: number | undefined;
  previewSource: string | undefined;
}): React.JSX.Element {
  return (
    <section aria-labelledby="activity-detail-title" aria-modal="true" className="activity-detail-panel" role="dialog">
      <header className="activity-detail-header">
        <div><span className="activity-detail-eyebrow">Activity 回看</span><h2 id="activity-detail-title">{detail ? formatActivityDateTime(detail.startedAt) : "活动会话"}</h2><p>{detail ? `${detail.eventCount} 个事件 · ${detail.snapshots.length} 张截图` : "正在读取脱敏时间线"}</p></div>
        <button aria-label="关闭活动会话详情" className="activity-icon-button" onClick={onClose} title="关闭详情" type="button"><Icon name="close" size={15} /></button>
      </header>
      {loading ? <div className="activity-detail-state">正在读取会话详情…</div> : error ? <div className="activity-detail-state is-error" role="alert">{error}</div> : detail ? (
        <div className="activity-detail-body">
          {detail.analysis ? <section className="activity-detail-analysis"><span className="activity-detail-label">分析</span><strong>{detail.analysis.project ? `[${detail.analysis.project}] ` : ""}{detail.analysis.summary}</strong>{detail.analysis.topics.length ? <p>主题：{detail.analysis.topics.join("；")}</p> : null}{detail.analysis.highlights.length ? <p>亮点：{detail.analysis.highlights.join("；")}</p> : null}</section> : <div className="activity-detail-unavailable">这个会话尚未完成分析；下面仍显示原始事件摘要和 OCR 投影。</div>}
          <section className="activity-detail-section">
            <div className="activity-detail-section-heading"><h3>截图回看</h3><span>点击缩略图按需读取本地 JPEG</span></div>
            {detail.snapshots.length ? <div className="activity-snapshot-grid">
              {detail.snapshots.map((snapshot) => <button aria-label={`查看 ${formatActivityDateTime(snapshot.capturedAt)} 的截图`} className={previewSnapshotId === snapshot.id ? "activity-snapshot is-selected" : "activity-snapshot"} key={snapshot.id} onClick={() => onPreviewSnapshot(snapshot.id)} type="button">
                {previewSnapshotId === snapshot.id && previewSource ? <img alt={`活动截图 ${formatActivityDateTime(snapshot.capturedAt)}`} decoding="async" height={snapshot.height ?? 90} loading="lazy" src={previewSource} width={snapshot.width ?? 160} /> : <span className="activity-snapshot-placeholder"><Icon name="display" size={18} /><small>{formatActivityDateTime(snapshot.capturedAt)}</small></span>}
                <span>{snapshot.trigger ?? "定时截图"} · {formatActivityBytes(snapshot.bytes)}</span>
              </button>)}
            </div> : <div className="activity-empty-state">这个会话没有可回看的截图，可能只记录了 AX 事件。</div>}
            {previewLoading ? <p aria-live="polite" className="activity-detail-loading">正在读取截图…</p> : previewError ? <p className="activity-detail-state is-error" role="alert">{previewError}</p> : null}
          </section>
          <section className="activity-detail-section">
            <div className="activity-detail-section-heading"><h3>事件时间线</h3><span>{detail.events.length} 条脱敏记录</span></div>
            {detail.events.length ? <ol className="activity-event-timeline">{detail.events.map((event) => <li key={event.id}><time>{formatActivityDateTime(event.occurredAt)}</time><div><strong>{event.application ?? "未知应用"}</strong><p>{event.summary}</p>{event.ocrText && event.ocrText !== event.summary ? <small>OCR：{event.ocrText}</small> : null}{event.url ? <small>URL：{event.url}</small> : null}{event.keyCode !== undefined || event.mouseX !== undefined ? <small>输入元数据：{event.keyCode !== undefined ? `keyCode ${event.keyCode}` : "鼠标"}{event.inputEventCount > 1 ? ` · ${event.inputEventCount} 次` : ""}{event.inputEventFirstAt ? ` · 起于 ${formatActivityDateTime(event.inputEventFirstAt)}` : ""}{event.mouseX !== undefined && event.mouseY !== undefined ? ` · (${Math.round(event.mouseX)}, ${Math.round(event.mouseY)})` : ""}</small> : null}</div></li>)}</ol> : <div className="activity-empty-state">没有事件记录。</div>}
          </section>
        </div>
      ) : null}
    </section>
  );
}

function activityServiceLabel(runtime: ActivityRuntimeSnapshot | undefined): string {
  if (!runtime) return "正在连接";
  if (runtime.screenLocked) return "已锁屏，暂停截图";
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

function formatActivityDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function activityErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Activity 操作失败，请稍后重试。";
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

function ActivitySwitch({ busy = false, checked, detail, disabled = false, label, onChange }: { busy?: boolean; checked: boolean; detail?: string; disabled?: boolean; label: string; onChange(value: boolean): void }): React.JSX.Element {
  return (
    <button aria-busy={busy} aria-checked={checked} aria-label={label} className={`activity-switch${checked ? " is-checked" : ""}`} disabled={disabled} onClick={() => onChange(!checked)} role="switch" type="button">
      {detail ? <span className="activity-switch-copy"><strong>{label}</strong><small>{detail}</small></span> : null}
      <span aria-hidden="true" className="activity-switch-track"><span /></span>
    </button>
  );
}

function ActivityNumberField({ disabled = false, hint, id, label, max, min, onCommit, step = 1, unit, value }: { disabled?: boolean; hint: string; id: string; label: string; max: number; min: number; onCommit(value: number): void; step?: number; unit: string; value: number }): React.JSX.Element {
  const [text, setText] = useState(String(value));
  const inputRef = useRef<HTMLInputElement>(null);
  const lastSentValueRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (value === lastSentValueRef.current) lastSentValueRef.current = undefined;
    if (document.activeElement !== inputRef.current) setText(String(value));
  }, [value]);
  const clamp = (raw: string): number | undefined => {
    if (raw.trim() === "") return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return undefined;
    return Math.min(max, Math.max(min, Math.trunc(parsed)));
  };
  const send = (next: number): void => {
    if (next === value || next === lastSentValueRef.current) return;
    lastSentValueRef.current = next;
    onCommit(next);
  };
  const handleChange = (raw: string): void => {
    setText(raw);
    const next = clamp(raw);
    if (next !== undefined) send(next);
  };
  const commit = (): void => {
    const next = clamp(text);
    if (next === undefined) {
      setText(String(value));
      return;
    }
    setText(String(next));
    send(next);
  };
  return (
    <label className="activity-field" htmlFor={id}>
      <span>{label}</span>
      <div className="activity-number-input"><input aria-describedby={`${id}-hint`} autoComplete="off" disabled={disabled} id={id} inputMode="numeric" max={max} min={min} name={id} onBlur={commit} onChange={(event) => handleChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") commit(); }} ref={inputRef} step={step} type="number" value={text} />{unit ? <em>{unit}</em> : null}</div>
      <small id={`${id}-hint`}>{hint}</small>
    </label>
  );
}
