import { z } from "zod";

/** Activity 回忆维度的外发策略。v1 只执行 local_only，另外两个值仅作为持久化预留。 */
export const activityExternalPolicySchema = z.enum([
  "local_only",
  "confirm_external",
  "external_allowed"
]);

/**
 * Activity 分析的外发策略，与回忆（注入上下文）维度独立：
 * - local_only：只用受信任的本地模型分析；当前聊天模型是外部模型时不分析。
 * - confirm_external：默认。外部模型需用户在设置页显式确认后才放行。
 * - external_allowed：允许把脱敏后的摘要聚合送到当前配置的外部聊天模型。
 */
export const activityAnalysisPolicySchema = z.enum([
  "local_only",
  "confirm_external",
  "external_allowed"
]);

export const activityDataResidencySchema = z.enum(["local", "external"]);

/** 已从设置里删除、但旧配置文件仍可能携带的键；解析前剥离，避免 .strict() 拒绝旧配置。 */
const deprecatedActivitySettingKeys = new Set(["activityRecallEnabled"]);

function stripDeprecatedActivitySettings(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const record: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of deprecatedActivitySettingKeys) delete record[key];
  return record;
}

const activitySettingsObjectSchema = z.object({
  /** 采集服务接入前默认关闭，避免设置页出现“已录制”但实际没有采集器的假状态。 */
  enabled: z.boolean().default(false),
  /** 分析维度策略；默认 confirm_external，即外部模型需先经用户确认。 */
  analysisPolicy: activityAnalysisPolicySchema.default("confirm_external"),
  /** confirm_external 下用户已确认放行外部分析；可随时在设置页撤回。 */
  analysisExternalConfirmed: z.boolean().default(false),
  /**
   * 分析专用模型，用仓库现有的模型标识：config.models 的别名，或 provider/model-id 引用
   * （容忍写成 provider:model-id）。缺省（未配置）时回退当前聊天模型 defaultModel。
   * 让用户可以给分析配一个更便宜的模型；指向未知别名/无法构造时视为「无可用分析模型」，
   * 对应 session 保持待分析，由周期 sweep 在配置修正后补分析。
   */
  analysisModel: z.string().trim().min(1).max(200).optional(),
  captureDebounceMs: z.number().int().min(250).max(60_000).default(4_000),
  heartbeatMs: z.number().int().min(1_000).max(600_000).default(120_000),
  idleTimeoutMs: z.number().int().min(1_000).max(600_000).default(30_000),
  inputPauseMs: z.number().int().min(0).max(60_000).default(1_200),
  visualPollMs: z.number().int().min(0).max(600_000).default(12_000),
  /** 前台浏览器（Safari/Chrome/Edge）当前标签 URL+标题的轮询间隔；0 表示关闭浏览器标签采集。 */
  browserPollIntervalMs: z.number().int().min(0).max(600_000).default(12_000),
  jpegQuality: z.number().int().min(1).max(100).default(55),
  ocrEnabled: z.boolean().default(true),
  inputMonitoringEnabled: z.boolean().default(true),
  ocrLanguages: z.array(z.string().trim().min(2).max(32)).min(1).max(16).default(["en-US", "zh-Hans", "zh-Hant", "ja"]),
  ocrEveryNFrames: z.number().int().min(1).max(60).default(5),
  sensitiveApplications: z.array(z.string().trim().min(1).max(256)).max(256).default([
    "com.apple.keychainaccess",
    "com.1password.1password",
    "org.bitwarden.desktop",
    "com.lastpass.LastPass"
  ]),
  maxStorageMb: z.number().int().min(256).max(1_048_576).default(10_240),
  outputDirectory: z.string().trim().min(1).max(2_048).default("~/.biny/agent/activity-records")
}).strict();

export const activitySettingsInputSchema = z.preprocess(
  stripDeprecatedActivitySettings,
  activitySettingsObjectSchema
);

export const activitySettingsSchema = z.preprocess(
  stripDeprecatedActivitySettings,
  activitySettingsObjectSchema.extend({
    /** 回忆维度的外发策略不由设置页开放；v1 的执行层始终按 local_only 处理。 */
    externalPolicy: activityExternalPolicySchema.default("local_only")
  }).strict()
).default({
  enabled: false,
  analysisPolicy: "confirm_external",
  analysisExternalConfirmed: false,
  captureDebounceMs: 4_000,
  heartbeatMs: 120_000,
  idleTimeoutMs: 30_000,
  inputPauseMs: 1_200,
  visualPollMs: 12_000,
  browserPollIntervalMs: 12_000,
  jpegQuality: 55,
  ocrEnabled: true,
  inputMonitoringEnabled: true,
  ocrLanguages: ["en-US", "zh-Hans", "zh-Hant", "ja"],
  ocrEveryNFrames: 5,
  sensitiveApplications: [
    "com.apple.keychainaccess",
    "com.1password.1password",
    "org.bitwarden.desktop",
    "com.lastpass.LastPass"
  ],
  maxStorageMb: 10_240,
  outputDirectory: "~/.biny/agent/activity-records",
  externalPolicy: "local_only"
});

export type ActivityExternalPolicy = z.infer<typeof activityExternalPolicySchema>;
export type ActivityAnalysisPolicy = z.infer<typeof activityAnalysisPolicySchema>;
export type ActivityDataResidency = z.infer<typeof activityDataResidencySchema>;
export type ActivitySettings = z.infer<typeof activitySettingsSchema>;
export type ActivitySettingsInput = Omit<ActivitySettings, "externalPolicy">;

export const defaultActivitySettings: ActivitySettings = {
  enabled: false,
  analysisPolicy: "confirm_external",
  analysisExternalConfirmed: false,
  captureDebounceMs: 4_000,
  heartbeatMs: 120_000,
  idleTimeoutMs: 30_000,
  inputPauseMs: 1_200,
  visualPollMs: 12_000,
  browserPollIntervalMs: 12_000,
  jpegQuality: 55,
  ocrEnabled: true,
  inputMonitoringEnabled: true,
  ocrLanguages: ["en-US", "zh-Hans", "zh-Hant", "ja"],
  ocrEveryNFrames: 5,
  sensitiveApplications: [
    "com.apple.keychainaccess",
    "com.1password.1password",
    "org.bitwarden.desktop",
    "com.lastpass.LastPass"
  ],
  maxStorageMb: 10_240,
  outputDirectory: "~/.biny/agent/activity-records",
  externalPolicy: "local_only"
};
