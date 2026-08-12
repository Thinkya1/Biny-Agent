/**
 * Provider 定义注册表。
 *
 * 内置定义、插件定义和用户配置分别提供默认值、扩展行为与实例覆盖。注册表不保存凭据，
 * 未注册的自定义类型按 OpenAI 兼容服务处理，并要求配置显式提供 baseUrl。
 */
import type { ModelProvider, ProviderConfig } from "../config/schema.js";
import { builtinProviderModels } from "./builtinModels.js";
import type { ModelCatalogEntry, ProviderDefinition, ProviderModelDefaults } from "./types.js";
import { createRetryFetch } from "./retry.js";
import { createProxyAwareFetch } from "../network/proxyFetch.js";

export interface ProviderRegistration {
  definition: ProviderDefinition;
  models: ModelCatalogEntry[];
}

export class ProviderDefinitionRegistry {
  private readonly registrations = new Map<string, ProviderRegistration>();

  constructor(registrations: readonly ProviderRegistration[] = []) {
    for (const registration of registrations) this.register(registration.definition, registration.models);
  }

  register(definition: ProviderDefinition, models: readonly ModelCatalogEntry[] = []): void {
    this.registrations.set(definition.type, {
      definition,
      models: models.map((model) => ({ ...model }))
    });
  }

  get(type: string): ProviderRegistration | undefined {
    const registration = this.registrations.get(type);
    return registration
      ? { definition: registration.definition, models: registration.models.map((model) => ({ ...model })) }
      : undefined;
  }

  list(): ProviderRegistration[] {
    return [...this.registrations.values()].map((registration) => ({
      definition: registration.definition,
      models: registration.models.map((model) => ({ ...model }))
    }));
  }

  clone(): ProviderDefinitionRegistry {
    return new ProviderDefinitionRegistry(this.list());
  }
}

const definitions: ProviderDefinition[] = [
  definition("deepseek", "https://api.deepseek.com", "DEEPSEEK_API_KEY", { reasoningProtocol: "deepseek", modelDefaults: reasoningProviderDefaults() }),
  definition("openai", "https://api.openai.com/v1", "OPENAI_API_KEY", { reasoningProtocol: "openai", modelDefaults: reasoningProviderDefaults() }),
  definition("anthropic", "https://api.anthropic.com", "ANTHROPIC_API_KEY", { protocol: "anthropic", api: "anthropic_messages", reasoningProtocol: "anthropic", modelDefaults: reasoningProviderDefaults() }),
  definition("claude-subscription", "https://api.anthropic.com", undefined, { protocol: "anthropic", api: "anthropic_messages", authModes: ["oauth-bearer"], reasoningProtocol: "anthropic", modelDefaults: reasoningProviderDefaults() }),
  definition("openai-codex", "https://chatgpt.com/backend-api/codex", undefined, { api: "responses", authModes: ["oauth-bearer"], reasoningProtocol: "openai", modelDefaults: responseReasoningProviderDefaults() }),
  definition("gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "GEMINI_API_KEY", { reasoningProtocol: "google", modelDefaults: reasoningProviderDefaults() }),
  definition("google-native", "https://generativelanguage.googleapis.com/v1beta", "GEMINI_API_KEY", { api: "google_generative_ai", fetchModels: fetchGoogleModels, reasoningProtocol: "google", modelDefaults: reasoningProviderDefaults() }),
  definition("kimi", "https://api.moonshot.ai/v1", "MOONSHOT_API_KEY", { reasoningProtocol: "moonshotai", modelDefaults: reasoningProviderDefaults() }),
  definition("qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", "DASHSCOPE_API_KEY", { reasoningProtocol: "alibaba", modelDefaults: reasoningProviderDefaults() }),
  definition("ollama", "http://127.0.0.1:11434/v1", undefined, { requiresApiKey: false }),
  definition("openai-compatible", undefined, undefined),
  definition("xai", "https://api.x.ai/v1", "XAI_API_KEY", { reasoningProtocol: "openai", modelDefaults: reasoningProviderDefaults() }),
  definition("mistral", "https://api.mistral.ai/v1", "MISTRAL_API_KEY"),
  definition("groq", "https://api.groq.com/openai/v1", "GROQ_API_KEY"),
  definition("openrouter", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
  definition("cerebras", "https://api.cerebras.ai/v1", "CEREBRAS_API_KEY"),
  definition("togetherai", "https://api.together.xyz/v1", "TOGETHER_API_KEY"),
  definition("fireworks-ai", "https://api.fireworks.ai/inference/v1", "FIREWORKS_API_KEY"),
  definition("nvidia", "https://integrate.api.nvidia.com/v1", "NVIDIA_API_KEY"),
  definition("deepinfra", "https://api.deepinfra.com/v1/openai", "DEEPINFRA_API_KEY"),
  definition("siliconflow", "https://api.siliconflow.cn/v1", "SILICONFLOW_API_KEY"),
  definition("zai", "https://api.z.ai/api/paas/v4", "ZAI_API_KEY", { modelDefaults: reasoningProviderDefaults() }),
  definition("minimax", "https://api.minimax.io/v1", "MINIMAX_API_KEY", { modelDefaults: reasoningProviderDefaults() }),
  definition("minimax-cn", "https://api.minimaxi.com/v1", "MINIMAX_API_KEY", { modelDefaults: reasoningProviderDefaults() }),
  definition("stepfun", "https://api.stepfun.com/v1", "STEPFUN_API_KEY", { modelDefaults: reasoningProviderDefaults() }),
  definition("volcengine", "https://ark.cn-beijing.volces.com/api/v3", "ARK_API_KEY"),
  definition("cohere", "https://api.cohere.com/compatibility/v1", "COHERE_API_KEY"),
  definition("huggingface", "https://router.huggingface.co/v1", "HF_TOKEN"),
  definition("lm-studio", "http://127.0.0.1:1234/v1", undefined, { requiresApiKey: false }),
  definition("localai", "http://127.0.0.1:8080/v1", undefined, { requiresApiKey: false })
];

export function createBuiltinProviderRegistry(): ProviderDefinitionRegistry {
  return new ProviderDefinitionRegistry(definitions.map((item) => ({
    definition: item,
    models: builtinProviderModels[item.type] ?? []
  })));
}

const defaultRegistry = createBuiltinProviderRegistry();

export function providerDefinition(type: ModelProvider, registry: ProviderDefinitionRegistry = defaultRegistry): ProviderDefinition {
  return registry.get(type)?.definition ?? definition(type, undefined, undefined);
}

export function providerProtocol(config: ProviderConfig, provider: ProviderDefinition): ProviderDefinition["protocol"] {
  return config.protocol ?? provider.protocol;
}

function definition(
  type: string,
  baseUrl: string | undefined,
  apiKeyEnv: string | undefined,
  overrides: Partial<ProviderDefinition> = {}
): ProviderDefinition {
  return {
    type,
    name: overrides.name,
    protocol: overrides.protocol ?? "openai-compatible",
    api: overrides.api ?? (overrides.protocol === "anthropic" ? "anthropic_messages" : "chat_completions"),
    baseUrl,
    apiKeyEnv,
    requiresApiKey: overrides.requiresApiKey ?? true,
    authModes: overrides.authModes ?? ["api-key"],
    reasoningProtocol: overrides.reasoningProtocol,
    modelDefaults: {
      capabilities: {
        tools: true,
        streaming: true,
        ...overrides.modelDefaults?.capabilities
      },
      contextWindow: overrides.modelDefaults?.contextWindow,
      maxInputTokens: overrides.modelDefaults?.maxInputTokens,
      maxOutputTokens: overrides.modelDefaults?.maxOutputTokens,
      limits: overrides.modelDefaults?.limits,
      reasoningEfforts: overrides.modelDefaults?.reasoningEfforts,
      thinkingLevelMap: overrides.modelDefaults?.thinkingLevelMap,
      inferReasoningFromId: overrides.modelDefaults?.inferReasoningFromId
    },
    fetchModels: overrides.fetchModels,
    filterModels: overrides.filterModels
  };
}

async function fetchGoogleModels(context: {
  providerAlias: string;
  config: ProviderConfig;
  signal?: AbortSignal;
  fetcher?: typeof globalThis.fetch;
}): Promise<ModelCatalogEntry[]> {
  const baseUrl = context.config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  const endpoint = context.config.modelsEndpoint ?? `${baseUrl.replace(/\/+$/u, "")}/models`;
  const envName = context.config.apiKeyEnv ?? "GEMINI_API_KEY";
  const apiKey = context.config.apiKey ?? process.env[envName];
  if (!apiKey) throw new Error(`No credentials available for provider ${context.providerAlias}.`);
  const timeout = AbortSignal.timeout(15_000);
  const retry = context.config.retry ?? { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 };
  const response = await createRetryFetch(retry, context.fetcher ?? createProxyAwareFetch())(endpoint, {
    headers: { "x-goog-api-key": apiKey, ...context.config.headers },
    signal: context.signal ? AbortSignal.any([context.signal, timeout]) : timeout
  });
  if (!response.ok) throw new Error(`Model catalog request failed (${String(response.status)}).`);
  const payload = await response.json() as unknown;
  const items = payload && typeof payload === "object" && Array.isArray((payload as { models?: unknown }).models)
    ? (payload as { models: unknown[] }).models
    : [];
  return items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const methods = Array.isArray(value.supportedGenerationMethods) ? value.supportedGenerationMethods : [];
    if (methods.length && !methods.includes("generateContent")) return [];
    const rawName = typeof value.name === "string" ? value.name : undefined;
    const id = rawName?.replace(/^models\//u, "");
    if (!id) return [];
    const thinking = typeof value.thinking === "boolean"
      ? value.thinking
      : value.thinking !== undefined && value.thinking !== null;
    const declaredThinking = typeof value.supportsThinking === "boolean"
      ? value.supportsThinking
      : typeof value.supportsReasoning === "boolean"
        ? value.supportsReasoning
        : value.thinking === undefined ? undefined : thinking;
    return [{
      id,
      displayName: typeof value.displayName === "string" ? value.displayName : id,
      provider: context.providerAlias,
      contextWindow: positiveInteger(value.inputTokenLimit),
      maxOutputTokens: positiveInteger(value.outputTokenLimit),
      maxInputTokens: positiveInteger(value.inputTokenLimit),
      capabilities: {
        tools: true,
        reasoning: declaredThinking,
        reasoningStream: declaredThinking,
        vision: typeof value.supportsVision === "boolean" ? value.supportsVision : undefined,
        audio: typeof value.supportsAudio === "boolean" ? value.supportsAudio : undefined,
        streaming: methods.length === 0 || methods.includes("streamGenerateContent")
      },
      reasoningEfforts: [],
      apiBackend: "google_generative_ai"
    }];
  });
}

function reasoningProviderDefaults(): ProviderModelDefaults {
  return {
    capabilities: {
      parallelToolCalls: true,
      reasoningStream: true
    },
    reasoningEfforts: ["high", "max"],
    inferReasoningFromId: true
  };
}

function responseReasoningProviderDefaults(): ProviderModelDefaults {
  return {
    ...reasoningProviderDefaults(),
    capabilities: {
      ...reasoningProviderDefaults().capabilities,
      reasoningSummary: true
    }
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
