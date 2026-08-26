/**
 * Activity 与模型之间共享的最小数据契约。
 *
 * 这里不放截图、OCR 原文或输入事件类型。模型只通过主动调用 activity_report 工具读取脱敏后的
 * 事件摘要聚合结果；是否放行由 ActivityPrivacyPolicy 统一决定，原始截图/OCR 任何策略下都不出设备。
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

/**
 * 分析结果的存储档位：影响记忆重要性、摘要裁剪与未来的保留策略。
 * - ephemeral  : 临时/琐碎，通常很快会被覆盖
 * - standard   : 普通工作记录（默认）
 * - important  : 高价值产出，值得长期检索（决策、发布、架构结论）
 */
export type ActivityStorageTier = "ephemeral" | "standard" | "important";

export type ActivitySource = "event" | "screenshot_fallback";

export type ActivityEventType =
  | "frontmost_application_changed"
  | "window_changed"
  | "focus_changed"
  | "title_changed"
  | "value_changed"
  | "selection_changed"
  | "mouse_down"
  | "mouse_up"
  | "mouse_drag"
  | "scroll"
  | "key_burst"
  | "browser_tab_changed"
  | "fallback_capture";

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
  inputMonitoringGranted: boolean;
  axAvailable: boolean;
  fallbackAvailable: boolean;
  sessions: number;
  events: number;
  fallbackCaptures: number;
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
  snapshotCount: number;
  eventCount: number;
  applications: string[];
}
