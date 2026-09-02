/**
 * Activity 与模型之间共享的最小数据契约。
 *
 * 这里不放截图、OCR 原文或输入事件类型。模型只能读取脱敏后的事件、OCR 和分析投影：来源可以是
 * 用户主动调用 activity_report、后台 session 分析或每日叙事摘要；是否放行由
 * ActivityPrivacyPolicy 统一决定，原始截图/OCR 任何策略下都不出设备。
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

/** 截图文件的物理保留档位，与分析结果的 storageTier 不是同一套枚举。 */
export type ActivitySnapshotStorageTier = "hot" | "warm" | "cold";

export type ActivitySource = "event" | "screenshot_fallback";

export type ActivityEventType =
  | "click"
  | "keypress"
  | "app_focus"
  | "browser_visit"
  | "window_title"
  | "lock"
  | "unlock"
  | "system";

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
  axAvailable: boolean;
  fallbackAvailable: boolean;
  /** macOS 当前是否处于锁屏；锁屏期间不采集截图，解锁后恢复。 */
  screenLocked: boolean;
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
