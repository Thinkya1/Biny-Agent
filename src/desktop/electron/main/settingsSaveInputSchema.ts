/**
 * 桌面端设置保存的入参校验。
 *
 * 渲染层按不可信输入对待，设置保存前必须先过这层 zod 校验。独立成不依赖 electron 的
 * 模块是为了让测试可以直接 import——ipc.ts 顶层引了 electron，只能在主进程里加载。
 */
import { z } from "zod";
import { activitySettingsInputSchema } from "../../../activity/settings.js";
import {
  chatParamsSchema,
  compactionSchema,
  modelApiBackendSchema,
  modelCompatibilitySchema,
  modelLimitsSchema,
  modelProviderSchema,
  providerProtocolSchema,
  reasoningEffortSchema
} from "../../../config/schema.js";
import { memoryPolicySchema } from "../../../personalization/index.js";

// 上限值都刻意给得比正常用法宽松，只用于挡住异常大的输入，不承担业务规则校验。
export const idSchema = z.string().min(1).max(240);
export const configRevisionSchema = z.string().min(1).max(200);
export const thinkingSchema = z.union([z.literal("off"), reasoningEffortSchema]);
export const modelConfigurationSchema = z.object({
  alias: idSchema,
  displayName: z.string().trim().min(1).max(120),
  providerAlias: idSchema,
  providerType: modelProviderSchema,
  protocol: providerProtocolSchema.optional(),
  model: z.string().trim().min(1).max(240),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).max(4_000).optional(),
  apiKeyHandle: z.string().uuid().optional(),
  apiKeyEnv: z.string().trim().min(1).max(120).optional(),
  requiresApiKey: z.boolean().optional(),
  supportsTools: z.boolean(),
  supportsThinking: z.boolean().optional(),
  parallelToolCalls: z.boolean().optional(),
  reasoningStream: z.boolean().optional(),
  reasoningSummary: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsAudio: z.boolean().optional(),
  contextWindow: z.number().int().min(4_096).max(2_000_000).optional(),
  maxInputTokens: z.number().int().min(2_048).max(2_000_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(384_000).optional(),
  limits: modelLimitsSchema.optional(),
  apiBackend: modelApiBackendSchema.optional(),
  thinkingLevelMap: z.record(z.string().min(1), z.string().min(1).nullable()).optional(),
  compatibility: modelCompatibilitySchema.optional(),
  makeDefault: z.boolean().optional()
});
const webSearchSettingsSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(["duckduckgo", "google", "tavily", "brave", "anysearch"]),
  apiKey: z.string().max(4_000).optional(),
  apiKeyHandle: z.string().uuid().optional(),
  apiKeyEnv: z.string().trim().min(1).max(120).optional(),
  timeoutMs: z.number().int().min(1_000).max(60_000),
  maxResults: z.number().int().min(1).max(10)
});
const personalitySchema = z.enum(["none", "friendly", "pragmatic", "buddy"]);
const customInstructionsSchema = z.string().refine(
  (value) => Buffer.byteLength(value, "utf8") <= 4_096,
  "Custom instructions must not exceed 4 KiB."
);
export const chatPersonalizationSchema = z.object({
  personality: z.union([z.literal("inherit"), personalitySchema]),
  customInstructions: z.object({
    mode: z.enum(["inherit", "replace", "disabled"]),
    value: customInstructionsSchema.optional()
  }).strict(),
  useMemories: z.union([z.literal("inherit"), z.boolean()]),
  contributeMemories: z.union([z.literal("inherit"), z.boolean()])
}).strict();
export const memorySettingsSchema = memoryPolicySchema;
export const identitySettingsSchema = z.object({
  enabled: z.boolean(),
  userEnabled: z.boolean()
}).strict();
export const personalizationSettingsSchema = z.object({
  expectedRevision: configRevisionSchema,
  settings: z.object({
    enabled: z.boolean(),
    personality: personalitySchema,
    customInstructions: customInstructionsSchema
  }).strict(),
  memory: memorySettingsSchema
}).strict();
export const themePreferenceSchema = z.enum(["system", "light", "dark"]);
export const fontPreferenceSchema = z.object({
  family: z.string().min(1).max(100),
  size: z.number().finite()
}).strict();
export const settingsSaveInputSchema = z.object({
  expectedPreferenceRevision: z.number().int().nonnegative(),
  expectedConfigRevision: configRevisionSchema,
  themePreference: themePreferenceSchema.optional(),
  fontPreference: fontPreferenceSchema.optional(),
  personalization: personalizationSettingsSchema.shape.settings.optional(),
  activity: activitySettingsInputSchema.optional(),
  identity: identitySettingsSchema.optional(),
  memory: memorySettingsSchema.optional(),
  compaction: compactionSchema.optional(),
  chatParams: chatParamsSchema.optional(),
  webSearch: webSearchSettingsSchema.optional(),
  models: z.object({
    upserts: z.array(modelConfigurationSchema).max(200),
    removeAliases: z.array(idSchema).max(200),
    defaultModel: z.object({ alias: idSchema, thinking: thinkingSchema }).strict().optional(),
    oauthCredentialHandles: z.array(z.string().uuid()).max(20).optional()
  }).strict().optional(),
  skills: z.object({
    globalDefaults: z.record(z.boolean()).refine((value) => Object.keys(value).length <= 512, "技能全局开关不能超过 512 项。"),
    projectOverrides: z.record(z.boolean()).refine((value) => Object.keys(value).length <= 512, "技能项目开关不能超过 512 项。"),
    extraction: z.object({
      enabled: z.boolean(),
      minToolCalls: z.number().int().min(1).max(64)
    }).strict()
  }).strict().optional(),
  chat: z.object({
    sessionId: idSchema,
    expectedMetadataRevision: configRevisionSchema,
    personalization: chatPersonalizationSchema
  }).strict().optional()
}).strict();
