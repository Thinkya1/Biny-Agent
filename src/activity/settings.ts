import { z } from "zod";

/** Activity 的外发策略。v1 只执行 local_only，另外两个值仅作为持久化预留。 */
export const activityExternalPolicySchema = z.enum([
  "local_only",
  "confirm_external",
  "external_allowed"
]);

export const activityDataResidencySchema = z.enum(["local", "external"]);

export const activitySettingsInputSchema = z.object({
  /** 采集服务接入前默认关闭，避免设置页出现“已录制”但实际没有采集器的假状态。 */
  enabled: z.boolean().default(false),
  captureDebounceMs: z.number().int().min(250).max(60_000).default(4_000),
  heartbeatMs: z.number().int().min(1_000).max(600_000).default(120_000),
  idleTimeoutMs: z.number().int().min(1_000).max(600_000).default(30_000),
  inputPauseMs: z.number().int().min(0).max(60_000).default(1_200),
  visualPollMs: z.number().int().min(0).max(600_000).default(12_000),
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

export const activitySettingsSchema = activitySettingsInputSchema.extend({
  /** 外发策略不由设置页开放；v1 的执行层始终按 local_only 处理。 */
  externalPolicy: activityExternalPolicySchema.default("local_only")
}).strict().default({
  enabled: false,
  captureDebounceMs: 4_000,
  heartbeatMs: 120_000,
  idleTimeoutMs: 30_000,
  inputPauseMs: 1_200,
  visualPollMs: 12_000,
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
export type ActivityDataResidency = z.infer<typeof activityDataResidencySchema>;
export type ActivitySettings = z.infer<typeof activitySettingsSchema>;
export type ActivitySettingsInput = Omit<ActivitySettings, "externalPolicy">;

export const defaultActivitySettings: ActivitySettings = {
  enabled: false,
  captureDebounceMs: 4_000,
  heartbeatMs: 120_000,
  idleTimeoutMs: 30_000,
  inputPauseMs: 1_200,
  visualPollMs: 12_000,
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
