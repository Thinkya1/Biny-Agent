/**
 * models.dev 生成快照的运行时适配层。
 *
 * 快照只提供模型事实和价格；它不能提供请求地址、协议或密钥。后者仍由 Biny 的 provider
 * 定义和配置决定，避免把第三方目录当成可执行 transport 配置。
 */
import {
  GENERATED_MODELS_DEV_CATALOG_PROVIDERS,
  GENERATED_MODELS_DEV_METADATA,
  GENERATED_MODELS_DEV_PROVIDER_ALIASES
} from "./modelMetadata.generated.js";
import { openAiCodexThinkingLevelMaps } from "./codexModels.js";
import type { ModelCapabilities, ModelCatalogEntry } from "./types.js";
import type { ModelPricing, ReasoningEffort, ThinkingLevelMap } from "../config/schema.js";

export interface ModelMetadata {
  displayName: string;
  description?: string;
  contextWindow: number;
  maxInputTokens?: number;
  maxOutputTokens: number;
  capabilities: Partial<ModelCapabilities>;
  reasoningEfforts: ReasoningEffort[];
  thinkingLevelMap?: ThinkingLevelMap;
  knowledgeCutoff?: string;
  structuredOutput?: boolean;
  lastUpdated?: string;
  modalities?: {
    input: string[];
    output: string[];
  };
  pricing?: ModelPricing;
}

export const generatedModelProviderTypes = [...GENERATED_MODELS_DEV_CATALOG_PROVIDERS];

/** Access-path 覆盖只补充已核实事实，优先级低于动态目录和用户显式配置。 */
export function accessPathThinkingLevelMap(providerType: string, modelId: string): ThinkingLevelMap | undefined {
  const map = providerType === "openai-codex" ? openAiCodexThinkingLevelMaps[modelId] : undefined;
  return map ? { ...map } : undefined;
}

/**
 * Codex OAuth 与 OpenAI API 共用模型 ID，但订阅访问路径的有效上下文窗口更小。
 * 这是访问路径事实，不应覆盖普通 OpenAI provider 的模型元数据。
 */
const openAiCodexContextWindows: Record<string, number> = {
  "gpt-5.6-sol": 372_000,
  "gpt-5.5": 272_000,
  "gpt-5.4": 272_000,
  "gpt-5.4-mini": 272_000
};

/** 按 models.dev 快照的 access-path 别名查找模型事实。 */
export function lookupModelMetadata(
  providerType: string,
  modelId: string,
  baseUrl?: string
): ModelMetadata | undefined {
  const provider = generatedProviderType(providerType);
  const metadata = GENERATED_MODELS_DEV_METADATA[provider]?.[modelId.trim()]
    ?? openCodeKnownModelMetadata(baseUrl, modelId);
  if (!metadata || providerType !== "openai-codex") return metadata;
  const contextWindow = openAiCodexContextWindows[modelId.trim()];
  return contextWindow === undefined ? metadata : { ...metadata, contextWindow };
}

/**
 * OpenCode Zen/Go 的目录把托管模型统一标成 `reasoning: false` 且不带上下文窗口。
 * 这里的已知模型事实用于纠正该 access path，不作用于普通 OpenAI 兼容端点。
 */
export function isOpenCodeModelEndpoint(baseUrl: string | undefined): boolean {
  return Boolean(baseUrl && /^https:\/\/opencode\.ai\/zen(?:\/go)?\/v1\/?$/u.test(baseUrl.trim()));
}

function openCodeKnownModelMetadata(baseUrl: string | undefined, modelId: string): ModelMetadata | undefined {
  if (!isOpenCodeModelEndpoint(baseUrl)) return undefined;
  const normalized = modelId.trim();
  if (normalized !== "deepseek-v4-flash" && normalized !== "deepseek-v4-pro") return undefined;
  return GENERATED_MODELS_DEV_METADATA.deepseek?.[normalized];
}

/** 返回适合 Biny tool agent 的离线模型目录；无 tool_call 声明的模型只保留为显式配置元数据。 */
export function generatedProviderModels(providerType: string): ModelCatalogEntry[] {
  if (!GENERATED_MODELS_DEV_CATALOG_PROVIDERS.includes(providerType)) return [];
  const provider = generatedProviderType(providerType);
  return Object.entries(GENERATED_MODELS_DEV_METADATA[provider] ?? {})
    .filter(([, metadata]) => metadata.capabilities.tools === true)
    .map(([id, metadata]) => metadataToCatalogEntry(id, metadata, providerType));
}

function generatedProviderType(providerType: string): string {
  let current = providerType;
  const visited = new Set<string>();
  while (GENERATED_MODELS_DEV_PROVIDER_ALIASES[current] && !visited.has(current)) {
    visited.add(current);
    current = GENERATED_MODELS_DEV_PROVIDER_ALIASES[current]!;
  }
  return current;
}

function metadataToCatalogEntry(id: string, metadata: ModelMetadata, provider: string): ModelCatalogEntry {
  return {
    id,
    displayName: metadata.displayName,
    provider,
    description: metadata.description,
    contextWindow: metadata.contextWindow,
    maxInputTokens: metadata.maxInputTokens,
    maxOutputTokens: metadata.maxOutputTokens,
    capabilities: { ...metadata.capabilities },
    reasoningEfforts: [...metadata.reasoningEfforts],
    reasoningEffortsSource: metadata.reasoningEfforts.length ? "declared" : undefined,
    thinkingLevelMap: metadata.thinkingLevelMap
      ? { ...metadata.thinkingLevelMap }
      : metadata.reasoningEfforts.length ? thinkingLevelMapForEfforts(metadata.reasoningEfforts) : undefined,
    pricing: metadata.pricing ? { ...metadata.pricing } : undefined
  };
}

/** 只把模型明确声明的 efforts 转成 canonical map，不凭空增加关闭思考档位。 */
export function thinkingLevelMapForEfforts(efforts: readonly ReasoningEffort[]): ThinkingLevelMap {
  return Object.fromEntries(efforts.map((effort) => [effort, effort]));
}
