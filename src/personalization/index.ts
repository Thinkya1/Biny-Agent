/**
 * 个性化配置与会话覆盖的共享内核。
 *
 * 人格预设与自定义指令已下线（改由 SOUL/IDENTITY/STYLE 与 USER.md 承载）；这里只保留
 * 记忆与 TELOS 策略，以及「按聊天覆盖记忆开关」这一最小能力。配置、Desktop、TUI 和
 * Agent runtime 都复用这里的严格 schema 与解析规则，避免不同入口对记忆开关产生不同解释。
 */
import { z } from "zod";
import type { EmbeddingModelRef } from "../llm/embedding/types.js";

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
  /** TELOS 受 memory.enabled 外层门禁约束；这里是 TELOS 自身的总开关。 */
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
  // 缺少总开关的旧配置按两个自动开关的 OR 推导；显式关闭总开关时由迁移结果保留关闭语义。
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

/**
 * 按聊天的记忆开关覆盖。人格/指令字段已从可编辑面移除，但旧 session catalog 记录里仍可能
 * 携带这些废弃键；`.passthrough()` + transform 读旧记录时丢弃它们，只保留记忆开关。
 */
const chatMemorySwitchSchema = z.union([z.literal("inherit"), z.boolean()]);

export const chatPersonalizationOverrideSchema = z.object({
  useMemories: chatMemorySwitchSchema,
  contributeMemories: chatMemorySwitchSchema
}).passthrough().transform(({ useMemories, contributeMemories }) => ({ useMemories, contributeMemories }));

export type ChatPersonalizationOverride = z.infer<typeof chatPersonalizationOverrideSchema>;

export const chatPersonalizationOverridePatchSchema = z.object({
  useMemories: chatMemorySwitchSchema.optional(),
  contributeMemories: chatMemorySwitchSchema.optional()
}).strict();

export const defaultChatPersonalizationOverride: ChatPersonalizationOverride = {
  useMemories: "inherit",
  contributeMemories: "inherit"
};

export type ChatPersonalizationOverridePatch = z.infer<typeof chatPersonalizationOverridePatchSchema>;

/**
 * 持久化到 session/telemetry 的个性化元数据占位。人格/指令已下线，此结构仅保留为历史
 * session 记录的兼容字段（SessionContextState.personalization），不再承载任何信息。
 */
export interface PersonalizationMetadata {}

export interface ResolvedChatPersonalization {
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
  /** 当前工作区的有效记忆策略（全局 config 叠加 project settings 后）。 */
  memory: MemoryPolicy;
  override: ChatPersonalizationOverride;
  resolved: ResolvedChatPersonalization;
  catalogRevision: string;
  configRevision?: string;
}

export const globalPersonalizationUpdateSchema = z.object({
  memory: memoryPolicySchema.optional()
}).strict();

export type GlobalPersonalizationUpdate = z.infer<typeof globalPersonalizationUpdateSchema>;

export function resolveChatPersonalization(
  memory: MemoryPolicy,
  override: ChatPersonalizationOverride = defaultChatPersonalizationOverride
): ResolvedChatPersonalization {
  const parsedMemory = memoryPolicySchema.parse(memory);
  const parsedOverride = chatPersonalizationOverrideSchema.parse(override);
  const configuredTelos = parsedMemory.telos ?? defaultTelosPolicy;
  // memory.enabled 是 TELOS 的外层门禁；任一层关闭都不注入策略、不记录观察、不检测偏差，
  // 但不清理已保存的 TELOS 文档、观察或审核结果。
  const telos = parsedMemory.enabled && configuredTelos.enabled
    ? configuredTelos
    : defaultTelosPolicy;
  return {
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
    telos
  };
}

export function mergeChatPersonalizationOverride(
  current: ChatPersonalizationOverride,
  patch: ChatPersonalizationOverridePatch
): ChatPersonalizationOverride {
  const parsedPatch = chatPersonalizationOverridePatchSchema.parse(patch);
  return chatPersonalizationOverrideSchema.parse({
    ...current,
    useMemories: parsedPatch.useMemories === undefined ? current.useMemories : parsedPatch.useMemories,
    contributeMemories: parsedPatch.contributeMemories === undefined
      ? current.contributeMemories
      : parsedPatch.contributeMemories
  });
}

export function personalizationMetadata(): PersonalizationMetadata {
  return {};
}

export function metadataForPersonalization(): PersonalizationMetadata {
  return {};
}

export function cloneChatPersonalizationOverride(
  override: ChatPersonalizationOverride
): ChatPersonalizationOverride {
  return { ...override };
}
