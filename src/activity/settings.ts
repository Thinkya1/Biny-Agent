import { z } from "zod";

/** Activity 回忆维度的外发策略；默认 local_only，外部模型需单独显式放行。 */
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

interface ActivitySettingsNormalizationFields {
  captureDebounceMs: number;
  heartbeatMs: number;
  idleTimeoutMs: number;
  inputPauseMs: number;
  visualPollMs: number;
  browserPollIntervalMs: number;
  jpegQuality: number;
  ocrEveryNFrames: number;
}

/** 运行时对时间间隔和 JPEG/OCR 参数做的归一化；设置文件也必须共享这一规则。 */
function normalizeActivitySettingsValue<T extends ActivitySettingsNormalizationFields>(value: T): T {
  const requiredInterval = (current: number, fallback: number, minimum: number): number =>
    Math.max(minimum, Math.round(current || fallback));
  const optionalInterval = (current: number, minimum: number): number =>
    current > 0 ? Math.max(minimum, Math.round(current)) : 0;
  return {
    ...value,
    captureDebounceMs: requiredInterval(value.captureDebounceMs, 4_000, 3_000),
    heartbeatMs: requiredInterval(value.heartbeatMs, 120_000, 60_000),
    idleTimeoutMs: requiredInterval(value.idleTimeoutMs, 30_000, 10_000),
    inputPauseMs: requiredInterval(value.inputPauseMs, 1_200, 800),
    visualPollMs: optionalInterval(value.visualPollMs, 10_000),
    browserPollIntervalMs: optionalInterval(value.browserPollIntervalMs, 10_000),
    jpegQuality: Math.max(30, Math.min(95, Math.round(value.jpegQuality || 55))),
    ocrEveryNFrames: Math.max(1, Math.min(20, Math.round(value.ocrEveryNFrames || 3)))
  } as T;
}

/** 已从设置里删除、但旧配置文件仍可能携带的键；解析前剥离，避免 .strict() 拒绝旧配置。 */
const deprecatedActivitySettingKeys = new Set(["activityRecallEnabled"]);

function stripDeprecatedActivitySettings(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const record: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of deprecatedActivitySettingKeys) delete record[key];
  return record;
}

const activitySettingsObjectSchema = z.object({
  /** 首次启动即开启，用户仍可在设置页一键暂停。 */
  enabled: z.boolean().default(true),
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
  captureDebounceMs: z.number().int().min(0).max(30_000).default(4_000),
  heartbeatMs: z.number().int().min(0).max(300_000).default(120_000),
  idleTimeoutMs: z.number().int().min(0).max(600_000).default(30_000),
  inputPauseMs: z.number().int().min(0).max(5_000).default(1_200),
  visualPollMs: z.number().int().min(0).max(30_000).default(12_000),
  /** 前台浏览器（Safari/Chrome/Edge）当前标签 URL+标题的轮询间隔；0 表示关闭浏览器标签采集。 */
  browserPollIntervalMs: z.number().int().min(0).max(600_000).default(12_000),
  jpegQuality: z.number().int().min(0).max(100).default(55),
  /** 整屏截图缩略图的直方图变化阈值；用于过滤画面没有实质变化的帧。 */
  histogramChangeThreshold: z.number().min(0).max(1).default(0.05),
  /** 整屏截图缩略图的像素变化比例阈值。 */
  pixelDiffThreshold: z.number().min(0).max(1).default(0.02),
  /** 判断像素变化时允许的每通道误差。 */
  pixelTolerance: z.number().int().min(0).max(255).default(30),
  ocrEnabled: z.boolean().default(true),
  inputMonitoringEnabled: z.boolean().default(true),
  ocrLanguages: z.array(z.string().trim().min(2).max(32)).min(1).max(16).default(["en-US", "zh-Hans", "zh-Hant", "ja"]),
  ocrEveryNFrames: z.number().int().min(0).max(20).default(3),
  sensitiveApplications: z.array(z.string().trim().min(1).max(256)).max(256).default([
    "com.apple.keychainaccess",
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "org.bitwarden.desktop",
    "com.lastpass.LastPass",
    "com.dashlane.dashlanephonefinal"
  ]),
  maxStorageMb: z.number().int().min(100).max(200_000).default(10_240),
  outputDirectory: z.string().trim().min(1).max(2_048).default("~/.biny/agent/activity-records"),
}).strict();

export const activitySettingsInputSchema = z.preprocess(
  stripDeprecatedActivitySettings,
  activitySettingsObjectSchema
).transform(normalizeActivitySettingsValue);

/** 设置页即时更新只接受局部字段；完整归一化在与当前配置合并后再执行。 */
export const activitySettingsPatchSchema = z.preprocess(
  stripDeprecatedActivitySettings,
  activitySettingsObjectSchema.partial()
);

export const activitySettingsSchema = z.preprocess(
  stripDeprecatedActivitySettings,
  activitySettingsObjectSchema.extend({
    /** 回忆维度的外发策略；local_only 是默认安全边界。 */
    externalPolicy: activityExternalPolicySchema.default("local_only")
  }).strict()
).transform(normalizeActivitySettingsValue).default({
  enabled: true,
  analysisPolicy: "confirm_external",
  analysisExternalConfirmed: false,
  captureDebounceMs: 4_000,
  heartbeatMs: 120_000,
  idleTimeoutMs: 30_000,
  inputPauseMs: 1_200,
  visualPollMs: 12_000,
  browserPollIntervalMs: 12_000,
  jpegQuality: 55,
  histogramChangeThreshold: 0.05,
  pixelDiffThreshold: 0.02,
  pixelTolerance: 30,
  ocrEnabled: true,
  inputMonitoringEnabled: true,
  ocrLanguages: ["en-US", "zh-Hans", "zh-Hant", "ja"],
  ocrEveryNFrames: 3,
  sensitiveApplications: [
    "com.apple.keychainaccess",
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "org.bitwarden.desktop",
    "com.lastpass.LastPass",
    "com.dashlane.dashlanephonefinal"
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
export type ActivitySettingsPatch = Partial<ActivitySettingsInput>;

export const defaultActivitySettings: ActivitySettings = {
  enabled: true,
  analysisPolicy: "confirm_external",
  analysisExternalConfirmed: false,
  captureDebounceMs: 4_000,
  heartbeatMs: 120_000,
  idleTimeoutMs: 30_000,
  inputPauseMs: 1_200,
  visualPollMs: 12_000,
  browserPollIntervalMs: 12_000,
  jpegQuality: 55,
  histogramChangeThreshold: 0.05,
  pixelDiffThreshold: 0.02,
  pixelTolerance: 30,
  ocrEnabled: true,
  inputMonitoringEnabled: true,
  ocrLanguages: ["en-US", "zh-Hans", "zh-Hant", "ja"],
  ocrEveryNFrames: 3,
  sensitiveApplications: [
    "com.apple.keychainaccess",
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "org.bitwarden.desktop",
    "com.lastpass.LastPass",
    "com.dashlane.dashlanephonefinal"
  ],
  maxStorageMb: 10_240,
  outputDirectory: "~/.biny/agent/activity-records",
  externalPolicy: "local_only"
};
