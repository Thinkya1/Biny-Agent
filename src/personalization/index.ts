/**
 * 个性化配置与会话覆盖的共享内核。
 *
 * 配置、Desktop、TUI 和 Agent runtime 都复用这里的严格 schema 与解析规则，避免不同入口
 * 对 inherit/disabled、字节上限或记忆开关产生不同解释。自定义指令正文只进入模型 prompt；
 * 普通 session/telemetry 使用不可逆摘要元数据。
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const PERSONALIZATION_CONFIG_VERSION = 1 as const;
export const PERSONALIZATION_CUSTOM_INSTRUCTIONS_MAX_BYTES = 4 * 1024;

export const personalityPresetSchema = z.enum(["none", "friendly", "pragmatic"]);
export type PersonalityPreset = z.infer<typeof personalityPresetSchema>;

const customInstructionsSchema = z.string().superRefine((value, context) => {
  if (Buffer.byteLength(value, "utf8") <= PERSONALIZATION_CUSTOM_INSTRUCTIONS_MAX_BYTES) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: `Custom instructions must not exceed ${String(PERSONALIZATION_CUSTOM_INSTRUCTIONS_MAX_BYTES)} UTF-8 bytes.`
  });
});

export const personalizationSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  personality: personalityPresetSchema.default("none"),
  customInstructions: customInstructionsSchema.default("")
}).strict().default({ enabled: true, personality: "none", customInstructions: "" });

export type PersonalizationSettings = z.infer<typeof personalizationSettingsSchema>;

export const memoryPolicySchema = z.object({
  useMemories: z.boolean().default(false),
  generateMemories: z.boolean().default(false),
  extractModel: z.string().min(1).optional(),
  consolidationModel: z.string().min(1).optional(),
  // 外部网页、MCP/Plugin 与子代理结果默认不进入自动记忆候选。
  excludeExternalContext: z.boolean().default(true),
  maxRecalled: z.number().int().min(1).max(20).default(3)
}).strict().default({
  useMemories: false,
  generateMemories: false,
  extractModel: undefined,
  consolidationModel: undefined,
  excludeExternalContext: true,
  maxRecalled: 3
});

export type MemoryPolicy = z.infer<typeof memoryPolicySchema>;

export const chatCustomInstructionsOverrideSchema = z.object({
  mode: z.enum(["inherit", "replace", "disabled"]),
  value: customInstructionsSchema.optional()
}).strict().superRefine((override, context) => {
  if (override.mode === "replace" && override.value === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["value"],
      message: "Replacement custom instructions require a value."
    });
  }
  if (override.mode !== "replace" && override.value !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["value"],
      message: "Only replacement custom instructions may include a value."
    });
  }
});

export const chatPersonalizationOverrideSchema = z.object({
  personality: z.enum(["inherit", "none", "friendly", "pragmatic"]),
  customInstructions: chatCustomInstructionsOverrideSchema,
  useMemories: z.union([z.literal("inherit"), z.boolean()]),
  contributeMemories: z.union([z.literal("inherit"), z.boolean()])
}).strict();

export type ChatPersonalizationOverride = z.infer<typeof chatPersonalizationOverrideSchema>;

export const chatPersonalizationOverridePatchSchema = z.object({
  personality: chatPersonalizationOverrideSchema.shape.personality.optional(),
  customInstructions: chatCustomInstructionsOverrideSchema.optional(),
  useMemories: chatPersonalizationOverrideSchema.shape.useMemories.optional(),
  contributeMemories: chatPersonalizationOverrideSchema.shape.contributeMemories.optional()
}).strict();

export const defaultChatPersonalizationOverride: ChatPersonalizationOverride = {
  personality: "inherit",
  customInstructions: { mode: "inherit", value: undefined },
  useMemories: "inherit",
  contributeMemories: "inherit"
};

export type ChatPersonalizationOverridePatch = z.infer<typeof chatPersonalizationOverridePatchSchema>;

/** 普通 session/telemetry 可持久化的个性化摘要；不含自定义指令正文。 */
export interface PersonalizationMetadata {
  personality: PersonalityPreset;
  configVersion: typeof PERSONALIZATION_CONFIG_VERSION;
  instructionsHash: string;
}

export interface ResolvedChatPersonalization extends PersonalizationMetadata {
  enabled: boolean;
  customInstructions: string;
  useMemories: boolean;
  contributeMemories: boolean;
  extractModel?: string;
  consolidationModel?: string;
  excludeExternalContext: boolean;
  maxRecalled: number;
}

export interface AgentPersonalizationState {
  /** 当前工作区的有效基础配置（全局 config 叠加 project settings 后）。 */
  global: PersonalizationSettings;
  memory: MemoryPolicy;
  override: ChatPersonalizationOverride;
  resolved: ResolvedChatPersonalization;
  catalogRevision: string;
  configRevision?: string;
}

export const globalPersonalizationUpdateSchema = z.object({
  personalization: personalizationSettingsSchema.optional(),
  memory: memoryPolicySchema.optional()
}).strict();

export type GlobalPersonalizationUpdate = z.infer<typeof globalPersonalizationUpdateSchema>;

export function resolveChatPersonalization(
  settings: PersonalizationSettings,
  memory: MemoryPolicy,
  override: ChatPersonalizationOverride = defaultChatPersonalizationOverride
): ResolvedChatPersonalization {
  const parsedSettings = personalizationSettingsSchema.parse(settings);
  const parsedMemory = memoryPolicySchema.parse(memory);
  const parsedOverride = chatPersonalizationOverrideSchema.parse(override);
  const enabled = parsedSettings.enabled;
  const personality = enabled
    ? parsedOverride.personality === "inherit" ? parsedSettings.personality : parsedOverride.personality
    : "none";
  const customInstructions = enabled
    ? parsedOverride.customInstructions.mode === "inherit"
      ? parsedSettings.customInstructions
      : parsedOverride.customInstructions.mode === "replace"
        ? parsedOverride.customInstructions.value ?? ""
        : ""
    : "";
  return {
    enabled,
    customInstructions,
    useMemories: parsedOverride.useMemories === "inherit" ? parsedMemory.useMemories : parsedOverride.useMemories,
    contributeMemories: parsedOverride.contributeMemories === "inherit"
      ? parsedMemory.generateMemories
      : parsedOverride.contributeMemories,
    extractModel: parsedMemory.extractModel,
    consolidationModel: parsedMemory.consolidationModel,
    excludeExternalContext: parsedMemory.excludeExternalContext,
    maxRecalled: parsedMemory.maxRecalled,
    ...personalizationMetadata(personality, customInstructions)
  };
}

export function mergeChatPersonalizationOverride(
  current: ChatPersonalizationOverride,
  patch: ChatPersonalizationOverridePatch
): ChatPersonalizationOverride {
  const parsedPatch = chatPersonalizationOverridePatchSchema.parse(patch);
  return chatPersonalizationOverrideSchema.parse({
    ...current,
    personality: parsedPatch.personality === undefined ? current.personality : parsedPatch.personality,
    customInstructions: parsedPatch.customInstructions === undefined
      ? current.customInstructions
      : parsedPatch.customInstructions,
    useMemories: parsedPatch.useMemories === undefined ? current.useMemories : parsedPatch.useMemories,
    contributeMemories: parsedPatch.contributeMemories === undefined
      ? current.contributeMemories
      : parsedPatch.contributeMemories
  });
}

export function personalizationMetadata(
  personality: PersonalityPreset,
  customInstructions: string
): PersonalizationMetadata {
  return {
    personality,
    configVersion: PERSONALIZATION_CONFIG_VERSION,
    instructionsHash: `sha256:${createHash("sha256").update(customInstructions, "utf8").digest("hex")}`
  };
}

export function metadataForPersonalization(value: ResolvedChatPersonalization): PersonalizationMetadata {
  return {
    personality: value.personality,
    configVersion: value.configVersion,
    instructionsHash: value.instructionsHash
  };
}

export function cloneChatPersonalizationOverride(
  override: ChatPersonalizationOverride
): ChatPersonalizationOverride {
  return {
    ...override,
    customInstructions: { ...override.customInstructions }
  };
}
