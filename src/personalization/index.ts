/**
 * 个性化配置与会话覆盖的共享内核。
 *
 * 配置、Desktop、TUI 和 Agent runtime 都复用这里的严格 schema 与解析规则，避免不同入口
 * 对 inherit/disabled、字节上限或记忆开关产生不同解释。自定义指令正文只进入模型 prompt；
 * 普通 session/telemetry 使用不可逆摘要元数据。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { EmbeddingModelRef } from "../llm/embedding/types.js";

export const PERSONALIZATION_CONFIG_VERSION = 1 as const;
export const PERSONALIZATION_CUSTOM_INSTRUCTIONS_MAX_BYTES = 4 * 1024;

export const personalityPresetSchema = z.enum(["none", "friendly", "pragmatic", "buddy"]);
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

export const embeddingModelRefSchema: z.ZodType<EmbeddingModelRef> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    model: z.enum(["multilingual-e5-small", "paraphrase-multilingual-MiniLM-L12-v2"])
  }).strict(),
  z.object({
    kind: z.literal("provider"),
    provider: z.string().min(1),
    model: z.string().min(1)
  }).strict()
]);

export type { EmbeddingModelRef } from "../llm/embedding/types.js";

export const telosPolicySchema = z.object({
  /** 显式 TELOS 可以独立于事实记忆启用。 */
  enabled: z.boolean().default(false),
  /** 是否从成功根回合中积累脱敏行为观察。 */
  autoObserve: z.boolean().default(false),
  /** 是否把已确认行为模式与 TELOS 做偏差比较。 */
  driftDetection: z.boolean().default(false),
  /** 是否在 Desktop idle 时显示偏差提醒。 */
  proactivePrompts: z.boolean().default(false)
}).strict();

export type TelosPolicy = z.infer<typeof telosPolicySchema>;

export const defaultTelosPolicy: TelosPolicy = {
  enabled: false,
  autoObserve: false,
  driftDetection: false,
  proactivePrompts: false
};

/** 早期记忆配置里出现过、当前已废弃的键；strict 校验前剥离以兼容旧文件。 */
const deprecatedMemoryPolicyKeys = [] as const;

const stripDeprecatedMemoryPolicy = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const record = { ...(value as Record<string, unknown>) };
  for (const key of deprecatedMemoryPolicyKeys) delete record[key];
  return record;
};

export const memorySimilarityThresholdSchema = z.object({
  currentWorkspace: z.number().min(0).max(1),
  crossWorkspace: z.number().min(0).max(1)
}).strict().superRefine((value, context) => {
  if (value.crossWorkspace >= value.currentWorkspace) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["crossWorkspace"],
    message: "Cross-project memory threshold must be at least the current-project threshold."
  });
});

const rawMemoryPolicySchema = z.preprocess(stripDeprecatedMemoryPolicy, z.object({
  // enabled 是硬门禁；聊天级 use/contribute 覆盖不能绕过它。
  enabled: z.boolean().optional(),
  useMemories: z.boolean().default(true),
  generateMemories: z.boolean().default(true),
  // 语义召回：概览注入之外的 embedding 检索；查询重写可用便宜模型改写检索词。
  queryRewrite: z.boolean().default(true),
  memoryModel: z.string().min(1).optional(),
  rewriteModel: z.string().min(1).optional(),
  extractModel: z.string().min(1).optional(),
  consolidationModel: z.string().min(1).optional(),
  // 嵌入模型默认本地 multilingual-e5-small（可下载）；云端需 provider 已配置并经隐私确认。
  embeddingModel: embeddingModelRefSchema.optional(),
  similarityThresholds: z.record(memorySimilarityThresholdSchema).default({}),
  // key 是 provider alias + endpoint 的不可逆摘要；不保存 URL、凭据或记忆正文。
  cloudEmbeddingConsents: z.record(z.object({
    endpointHash: z.string().min(16).max(128),
    confirmedAt: z.string().datetime()
  }).strict()).default({}),
  // 外部网页、MCP/Plugin 与子代理结果默认不进入自动记忆候选。
  excludeExternalContext: z.boolean().default(true),
  // 自动注入条数上限（概览之外的条目召回）。
  maxRecalled: z.number().int().min(1).max(20).default(5),
  // 新增策略保持 optional，旧 config 不会因为升级而出现无意义的写回差异。
  telos: telosPolicySchema.optional()
}).strict());

export const memoryPolicySchema = rawMemoryPolicySchema.transform((policy) => ({
  ...policy,
  // v2 没有总开关。读取旧配置时用两个既有开关的 OR 初始化，避免升级后意外停用。
  enabled: policy.enabled ?? (policy.useMemories || policy.generateMemories)
})).default({
  enabled: false,
  useMemories: true,
  generateMemories: true,
  queryRewrite: true,
  memoryModel: undefined,
  rewriteModel: undefined,
  extractModel: undefined,
  consolidationModel: undefined,
  embeddingModel: { kind: "local", model: "multilingual-e5-small" },
  similarityThresholds: {},
  cloudEmbeddingConsents: {},
  excludeExternalContext: true,
  maxRecalled: 5
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
  personality: z.enum(["inherit", "none", "friendly", "pragmatic", "buddy"]),
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
  memoryEnabled: boolean;
  useMemories: boolean;
  contributeMemories: boolean;
  queryRewrite: boolean;
  memoryModel?: string;
  rewriteModel?: string;
  extractModel?: string;
  consolidationModel?: string;
  embeddingModel?: EmbeddingModelRef;
  similarityThresholds: Record<string, z.infer<typeof memorySimilarityThresholdSchema>>;
  excludeExternalContext: boolean;
  maxRecalled: number;
  telos: TelosPolicy;
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
    memoryEnabled: parsedMemory.enabled,
    useMemories: parsedMemory.enabled && (parsedOverride.useMemories === "inherit" ? parsedMemory.useMemories : parsedOverride.useMemories),
    contributeMemories: parsedMemory.enabled && (parsedOverride.contributeMemories === "inherit"
      ? parsedMemory.generateMemories
      : parsedOverride.contributeMemories),
    memoryModel: parsedMemory.memoryModel,
    queryRewrite: parsedMemory.queryRewrite,
    rewriteModel: parsedMemory.rewriteModel,
    extractModel: parsedMemory.extractModel,
    consolidationModel: parsedMemory.consolidationModel,
    embeddingModel: parsedMemory.embeddingModel,
    similarityThresholds: parsedMemory.similarityThresholds,
    excludeExternalContext: parsedMemory.excludeExternalContext,
    maxRecalled: parsedMemory.maxRecalled,
    telos: parsedMemory.telos ?? defaultTelosPolicy,
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
