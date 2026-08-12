/**
 * AI 能力层共享类型。
 *
 * provider 定义、模型能力、上下文预算和模型目录条目的形状都在这里，`src/ai` 内各文件
 * 以及调用方都以这些类型为契约。
 */
import type { ModelApiBackend, ModelCompatibility, ModelPricing, ModelProvider, ProviderConfig, ReasoningEffort, ThinkingLevelMap } from "../config/schema.js";

export type AiProtocol = "anthropic" | "openai-compatible";
export type AiAuthMode = "api-key" | "oauth-bearer";

export interface ModelCapabilities {
  tools: boolean;
  parallelToolCalls: boolean;
  reasoning: boolean;
  reasoningStream: boolean;
  reasoningSummary: boolean;
  vision: boolean;
  audio: boolean;
  streaming: boolean;
}

/** 模型/协议限制。缺失的字段由 ProviderRuntime 用保守默认值补齐。 */
export interface ModelLimits {
  maxInputTokens?: number;
  reasoningReserveTokens?: number;
  toolSchemaReserveTokens?: number;
  systemPromptReserveTokens?: number;
  protocolSafetyMarginTokens?: number;
}

export interface ModelContextBudget {
  modelAlias?: string;
  contextWindow: number;
  maxInputTokens: number;
  maxOutputTokens: number | undefined;
  outputReserveTokens?: number;
  reasoningReserveTokens?: number;
  toolSchemaReserveTokens?: number;
  systemPromptReserveTokens?: number;
  protocolSafetyMarginTokens?: number;
}

/** Provider 对未知模型的保守默认值，以及动态目录缺字段时的补全规则。 */
export interface ProviderModelDefaults {
  capabilities: Partial<ModelCapabilities>;
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  limits?: ModelLimits;
  reasoningEfforts?: ReasoningEffort[];
  thinkingLevelMap?: ThinkingLevelMap;
  inferReasoningFromId?: boolean;
}

/**
 * 一个 provider 的接入方式：走哪种协议、默认 base URL、鉴权方式，以及思考内容用哪家的
 * 协议解析（各家 reasoning 字段并不通用）。
 */
export interface ProviderDefinition {
  type: ModelProvider;
  name?: string;
  protocol: AiProtocol;
  api?: ModelApiBackend;
  baseUrl?: string;
  apiKeyEnv?: string;
  requiresApiKey: boolean;
  authModes: AiAuthMode[];
  reasoningProtocol?: "deepseek" | "openai" | "google" | "anthropic" | "alibaba" | "moonshotai";
  modelDefaults?: ProviderModelDefaults;
  fetchModels?: (context: {
    providerAlias: string;
    config: ProviderConfig;
    signal?: AbortSignal;
  }) => Promise<readonly ModelCatalogEntry[]>;
  filterModels?: (
    models: readonly ModelCatalogEntry[],
    context: { configured: boolean; authMode: AiAuthMode | undefined }
  ) => readonly ModelCatalogEntry[];
}

export interface ModelCatalogEntry {
  id: string;
  displayName: string;
  provider: string;
  description?: string;
  /** 是否出现在普通模型选择器；未声明时由共享可见性策略决定。 */
  showInPicker?: boolean;
  contextWindow: number | undefined;
  maxInputTokens?: number;
  maxOutputTokens: number | undefined;
  limits?: ModelLimits;
  capabilities: Partial<ModelCapabilities>;
  reasoningEfforts: ReasoningEffort[];
  thinkingLevelMap?: ThinkingLevelMap;
  apiBackend?: ModelApiBackend;
  baseUrl?: string;
  headers?: Record<string, string>;
  compatibility?: ModelCompatibility;
  pricing?: ModelPricing;
}

export interface CatalogProviderRequest {
  alias: string;
  config: ProviderConfig;
  definition: ProviderDefinition;
}
