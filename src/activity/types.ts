/**
 * Activity 与模型之间共享的最小数据契约。
 *
 * 这里不放截图、OCR 原文或输入事件类型。Activity 进入 Agent 上下文前只能以脱敏后的
 * 历史证据摘要出现，模型是否可以看到它由 ActivityPrivacyPolicy 统一决定。
 */
import type { ActivityDataResidency } from "./settings.js";

export type ActivityModelRuntime = "builtin-llama.cpp" | "provider";

/** 策略层只读取这些字段，不从 provider 名称或 endpoint 猜测本地性。 */
export interface ActivityModelIdentity {
  runtime?: ActivityModelRuntime;
  dataResidency?: ActivityDataResidency;
  provider?: string;
  modelId?: string;
}

/** 可以进入 ContextMemory 的 Activity 形态；原始截图/OCR/输入事件不属于这个契约。 */
export interface ActivityContextEntry {
  summary: string;
  occurredAt?: string;
  application?: string;
}

export type ActivityServiceState =
  | "stopped"
  | "paused"
  | "running"
  | "permission_required"
  | "unavailable"
  | "error";

/** Desktop 设置页展示的运行态；它不包含截图、OCR 原文或输入具体键值。 */
export interface ActivityRuntimeSnapshot {
  state: ActivityServiceState;
  collectorAvailable: boolean;
  screenRecordingGranted: boolean;
  accessibilityGranted: boolean;
  sessions: number;
  captures: number;
  storageBytes: number;
  recentSessions: ActivitySessionSummary[];
  currentSessionId?: string;
  currentApplication?: string;
  error?: string;
}

export interface ActivitySessionSummary {
  id: string;
  startedAt: string;
  endedAt?: string;
  eventCount: number;
  applications: string[];
}
