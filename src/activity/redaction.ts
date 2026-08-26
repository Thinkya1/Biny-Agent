import { redactSecrets } from "../utils/redaction.js";

/**
 * Activity 原始 OCR 只在 sidecar 到主进程的短暂内存链路中存在；写入 SQLite 前先做规则脱敏和
 * 长度限制。输入监听只保存计数，不接收具体键值，因此不会把按键内容带入这条链路。
 */
export function redactActivityText(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const redacted = redactSecrets(value)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, "[redacted email]")
    .replace(/https?:\/\/[^\s]+/giu, "[redacted url]")
    .replace(/(?:\/Users\/|\/private\/var\/folders\/)[^\s]+/gu, "[redacted path]")
    .replace(/\b(?:\d[ -]?){13,19}\b/gu, "[redacted number]")
    .replace(/\b(password|passwd|token|secret|api[-_ ]?key|access[-_ ]?token)\s*([:=：])\s*[^\s,;，；]+/giu, "$1$2[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  return redacted ? redacted.slice(0, 2_000) : undefined;
}

export interface ActivitySummaryDetails {
  eventType?: string;
  windowTitle?: string;
  axRole?: string;
  axTitle?: string;
  mouseEventType?: string;
  fallbackReason?: string;
}

export function activitySummary(application: string | undefined, text: string | undefined, details: ActivitySummaryDetails = {}): string {
  const safeApplication = redactActivityText(application);
  const safeWindowTitle = redactActivityText(details.windowTitle);
  const safeAxRole = redactActivityText(details.axRole);
  const safeAxTitle = redactActivityText(details.axTitle);
  const parts = [
    safeApplication ? `前台应用：${safeApplication}` : "前台应用未知",
    safeWindowTitle ? `窗口：${safeWindowTitle}` : undefined,
    details.eventType ? `事件：${activityEventLabel(details.eventType)}` : undefined,
    safeAxRole ? `控件：${safeAxRole}` : undefined,
    safeAxTitle ? `控件标题：${safeAxTitle}` : undefined,
    details.mouseEventType ? `鼠标：${activityEventLabel(details.mouseEventType)}` : undefined,
    details.fallbackReason ? `视觉 fallback：${activityEventLabel(details.fallbackReason)}` : undefined,
    text ? `文本摘要：${text}` : "检测到活动"
  ];
  return redactActivityText(parts.join("；")) ?? "检测到屏幕活动";
}

function activityEventLabel(value: string): string {
  const labels: Record<string, string> = {
    frontmost_application_changed: "前台应用变化",
    window_changed: "窗口变化",
    focus_changed: "焦点变化",
    title_changed: "标题变化",
    value_changed: "控件值变化",
    selection_changed: "选区变化",
    mouse_down: "鼠标按下",
    mouse_up: "鼠标释放",
    mouse_drag: "鼠标拖拽",
    scroll: "滚轮",
    key_burst: "键盘活动",
    browser_tab_changed: "浏览器标签变化",
    fallback_capture: "截图 fallback",
    accessibility_unavailable: "辅助功能不可用",
    ax_connection_failed: "AX 连接失败",
    missing_window_or_focus_semantics: "缺少窗口或焦点语义",
    visual_application: "视觉型应用"
  };
  return labels[value] ?? value.slice(0, 80);
}
