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
    .replace(/\b(password|passwd|token|secret|api[-_ ]?key|access[-_ ]?token)\s*[:=：]\s*[^\s,;，；]+/giu, "$1: [redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  return redacted ? redacted.slice(0, 2_000) : undefined;
}

export function activitySummary(application: string | undefined, ocrText: string | undefined): string {
  const parts = [
    application ? `前台应用：${application}` : "前台应用未知",
    ocrText ? `屏幕文字摘要：${ocrText}` : "检测到屏幕活动"
  ];
  return redactActivityText(parts.join("；")) ?? "检测到屏幕活动";
}
