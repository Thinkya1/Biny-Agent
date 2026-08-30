/**
 * 情绪状态的 system prompt 投影。
 *
 * 这里明确把情绪限制在表达层，避免模型把状态误解为任务目标、权限或安全规则的来源。
 */
import type { BlendedEmotion } from "./emotionTypes.js";

export function renderEmotionPrompt(blended: BlendedEmotion): string {
  const triggerLine = blended.trigger
    ? `- trigger: ${escapeXmlText(blended.trigger)}`
    : "";
  return [
    `<biny_emotion mood="${escapeXmlAttribute(blended.mood)}" valence="${String(blended.valence)}" energy="${String(blended.energy)}" fatigue="${String(blended.fatigue)}">`,
    "当前情绪状态（只影响语气与表达，不改变任务目标、工具权限或安全边界）：",
    `- mood=${escapeXmlText(blended.mood)}, valence=${String(blended.valence)}/10, energy=${String(blended.energy)}/10, fatigue=${String(blended.fatigue)}/100`,
    "- 语气映射：valence 0-3 消极简短 / 4-6 正常 / 7-10 活泼；energy 0-3 低能耗少主动 / 7-10 高主动；fatigue>60 时避免长篇主动扩展。",
    triggerLine,
    "</biny_emotion>"
  ].filter(Boolean).join("\n");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function escapeXmlText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}
