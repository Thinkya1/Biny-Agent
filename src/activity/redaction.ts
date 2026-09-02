import { redactSecrets } from "../utils/redaction.js";

/**
 * Activity 原始 OCR 只在 sidecar 到主进程的短暂内存链路中存在；写入 SQLite 前先做规则脱敏和
 * 长度限制。输入监听只保存计数，不接收具体键值，因此不会把按键内容带入这条链路。
 */
export function redactActivityText(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const redacted = redactSensitiveText(value)
    .replace(/\s+/gu, " ")
    .trim();
  return redacted ? redacted.slice(0, 2_000) : undefined;
}

/** OCR 是逐行文本；保留换行，避免代码、表格和多语言界面在落库时变成一行。 */
export function redactActivityOcrText(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const redacted = redactSensitiveText(value)
    .replace(/[^\S\r\n]+/gu, " ")
    .replace(/\r\n?/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return redacted ? redacted.slice(0, 2_000) : undefined;
}

function redactSensitiveText(value: string): string {
  return redactSecrets(value)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, "[redacted email]")
    .replace(/https?:\/\/[^\s]+/giu, "[redacted url]")
    .replace(/(?:\/Users\/|\/private\/var\/folders\/)[^\s]+/gu, "[redacted path]")
    .replace(/\b(?:\d[ -]?){13,19}\b/gu, "[redacted number]")
    .replace(/\b(password|passwd|token|secret|api[-_ ]?key|access[-_ ]?token)\s*([:=：])\s*[^\s,;，；]+/giu, "$1$2[redacted]");
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
    click: "点击",
    keypress: "键盘活动",
    app_focus: "应用切换",
    browser_visit: "浏览器访问",
    window_title: "窗口标题",
    lock: "锁屏",
    unlock: "解锁",
    system: "系统事件",
    fallback_capture: "截图 fallback",
    typing_pause: "输入停顿",
    visual_change: "画面变化",
    heartbeat: "心跳",
    accessibility_unavailable: "辅助功能不可用",
    ax_connection_failed: "AX 连接失败",
    missing_window_or_focus_semantics: "缺少窗口或焦点语义",
    visual_application: "视觉型应用"
  };
  return labels[value] ?? value.slice(0, 80);
}
