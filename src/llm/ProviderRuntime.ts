/**
 * Provider 运行时。
 *
 * 每个配置别名对应一个实例，统一持有服务商默认值、鉴权、模型目录和请求准备逻辑。
 * API 协议的 HTTP/SSE 实现由 ApiAdapterRegistry 负责，两层不互相冒充。
 */
import type { AgentModel, ModelStreamContext, ModelStreamEvent, ModelStreamOptions } from "../agent/core/types.js";
import { effectiveThinkingSelection, modelCapabilities, modelReasoningConfig, modelThinkingLevelMap, nativeReasoningEffort, normalizeModelMetadata, reasoningBudgetTokens } from "../ai/capabilities.js";
import { fetchModelCatalogSnapshot } from "../ai/modelCatalog.js";
import { accessPathThinkingLevelMap, lookupModelMetadata, thinkingLevelMapForEfforts, type ModelMetadata } from "../ai/modelMetadata.js";
import { providerDefinition, providerProtocol } from "../ai/provider.js";
import type { ModelCatalogEntry, ProviderDefinition } from "../ai/types.js";
import type { AgentConfig, ModelAliasConfig, ModelApiBackend, ModelCompatibility, ProviderConfig, ThinkingLevelMap } from "../config/schema.js";
import { createNativeModel } from "./nativeModel.js";
import { openAiCodexHeaders, refreshSubscriptionOAuthTokens } from "./subscriptionAuth.js";
import { AiRegistry } from "./AiRegistry.js";
import type { ModelsStore } from "./ModelsStore.js";
import { createProxyAwareFetch } from "../network/proxyFetch.js";
import {
  listProviderEmbeddingModels,
  ProviderEmbeddingRuntime,
  type EmbeddingModelDescriptor,
  type EmbeddingModelRef,
  type EmbeddingModelRuntime
} from "./embedding/index.js";

const oauthRefreshWindowMs = 5 * 60 * 1_000;

export interface NativeModelSettings {
  model: AgentModel;
  providerOptions?: Record<string, unknown>;
  reasoning?: "off" | AgentConfig["thinking"]["effort"];
  timeoutMs?: number;
  maxOutputTokens?: number;
  contextWindow: number | undefined;
}

export interface ProviderRuntime {
  readonly id: string;
  readonly definition: ProviderDefinition;
  readonly config: ProviderConfig;
  getModels(): ModelCatalogEntry[];
  resolveModel(model: ModelAliasConfig): ModelAliasConfig;
  restoreModels(models: readonly ModelCatalogEntry[]): void;
  refreshModels(signal?: AbortSignal): Promise<ModelCatalogEntry[]>;
  isConfigured(model?: ModelAliasConfig): boolean;
  validate(model?: ModelAliasConfig): void;
  createModelSettings(agentConfig: AgentConfig, model: ModelAliasConfig): NativeModelSettings;
  streamSimple(
    agentConfig: AgentConfig,
    model: ModelAliasConfig,
    context: ModelStreamContext,
    options?: ModelStreamOptions
  ): Promise<AsyncIterable<ModelStreamEvent>>;
  refreshCredential(signal?: AbortSignal): Promise<ProviderConfig | undefined>;
  listEmbeddingModels(): EmbeddingModelDescriptor[];
  createEmbeddingRuntime(modelId: string): EmbeddingModelRuntime;
}

export class ConfiguredProviderRuntime implements ProviderRuntime {
  readonly definition: ProviderDefinition;
  private readonly baselineModels: ModelCatalogEntry[];
  private liveModels: ModelCatalogEntry[] = [];

  constructor(
    readonly id: string,
    readonly config: ProviderConfig,
    private readonly ai: AiRegistry,
    baselineModels: readonly ModelCatalogEntry[] = [],
    private readonly modelsStore?: ModelsStore,
    private readonly fetcher: typeof globalThis.fetch = createProxyAwareFetch()
  ) {
    this.definition = providerDefinition(config.type, ai.providers);
    this.baselineModels = baselineModels.map((model) => ({ ...model, provider: id }));
  }

  getModels(): ModelCatalogEntry[] {
    const models = this.mergedCatalog().map((model) => this.normalizeCatalogEntry(model));
    try {
      const filtered = this.definition.filterModels?.(models, {
        configured: this.isConfigured(),
        authMode: this.config.authMode ?? this.definition.authModes[0]
      }) ?? models;
      return [...filtered].map((model) => ({ ...model }));
    } catch {
      // 一个扩展过滤器异常不能让整个模型菜单消失，退回完整目录。
      return models.map((model) => ({ ...model }));
    }
  }

  listEmbeddingModels(): EmbeddingModelDescriptor[] {
    return listProviderEmbeddingModels(this.id, this.config, this.definition);
  }

  createEmbeddingRuntime(modelId: string): EmbeddingModelRuntime {
    return new ProviderEmbeddingRuntime(this.id, this.config, this.definition, modelId, { fetcher: this.fetcher });
  }

  restoreModels(models: readonly ModelCatalogEntry[]): void {
    // `/models` 与旧缓存都属于不可信元数据源。目录只能补充能力和 token 限制，
    // 不能改变请求地址、鉴权头或 API 协议；这些传输字段只接受用户配置和本地注册基线。
    this.liveModels = models.map((model) => liveCatalogMetadata(model, this.id));
  }

  async refreshModels(signal?: AbortSignal): Promise<ModelCatalogEntry[]> {
    signal?.throwIfAborted();
    const cached = await this.modelsStore?.read(this.id).catch(() => undefined);
    let models: readonly ModelCatalogEntry[];
    let etag = cached?.etag;
    let lastModified = cached?.lastModified;
    if (this.definition.fetchModels) {
      models = await this.definition.fetchModels({ providerAlias: this.id, config: this.config, signal, fetcher: this.fetcher });
      etag = undefined;
      lastModified = undefined;
    } else {
      const result = await fetchModelCatalogSnapshot(
        { alias: this.id, config: this.config, definition: this.definition },
        signal,
        { etag: cached?.etag, lastModified: cached?.lastModified },
        this.fetcher
      );
      if (result.notModified && !cached) throw new Error(`Provider ${this.id} returned 304 without a stored model catalog.`);
      models = result.notModified ? cached!.models : result.models ?? [];
      etag = result.etag;
      lastModified = result.lastModified;
    }
    signal?.throwIfAborted();
    this.restoreModels(models);
    await this.modelsStore?.write(this.id, {
      models: this.liveModels.map((model) => this.normalizeCatalogEntry(model)),
      checkedAt: Date.now(),
      etag,
      lastModified
    }).catch(() => undefined);
    return this.getModels();
  }

  isConfigured(model?: ModelAliasConfig): boolean {
    const endpoint = model?.baseUrl ?? this.config.baseUrl ?? this.definition.baseUrl;
    if (!endpoint || !isHttpEndpoint(endpoint)) return false;
    if (!(this.config.requiresApiKey ?? this.definition.requiresApiKey)) return true;
    return this.resolveApiKey() !== undefined;
  }

  resolveModel(model: ModelAliasConfig): ModelAliasConfig {
    const catalog = this.mergedCatalog().find((entry) => entry.id === model.model);
    const generated = lookupModelMetadata(this.config.type, model.model);
    const catalogModel = catalog ? catalogEntryToModel(catalog, generated !== undefined) : undefined;
    const generatedModel = generated ? metadataToModel(this.id, this.config.type, model.model, generated) : undefined;
    const catalogBase = catalogModel && generatedModel
      ? mergeModelMetadata(generatedModel, catalogModel)
      : catalogModel ?? generatedModel;
    const merged = catalogBase ? mergeModelMetadata(catalogBase, model) : model;
    return normalizeModelMetadata(
      { ...merged, compatibility: mergeCompatibility(this.config.compatibility, merged.compatibility) },
      this.definition.modelDefaults
    );
  }

  validate(model?: ModelAliasConfig): void {
    const endpoint = model?.baseUrl ?? this.config.baseUrl ?? this.definition.baseUrl;
    if (!endpoint) throw new Error(`No model endpoint configured. Set providers.${this.id}.baseUrl.`);
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new Error(`Invalid model endpoint for provider ${this.id}: ${endpoint}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Model endpoint for provider ${this.id} must use http:// or https://.`);
    }
    if (parsed.username || parsed.password) {
      throw new Error(`Model endpoint for provider ${this.id} must not contain credentials in the URL.`);
    }
    if ((this.config.requiresApiKey ?? this.definition.requiresApiKey) && !this.resolveApiKey()) {
      throw new Error(missingKeyMessage(this.id, this.config.apiKeyEnv, this.definition.apiKeyEnv));
    }
  }

  createModelSettings(agentConfig: AgentConfig, model: ModelAliasConfig): NativeModelSettings {
    const normalizedModel = this.resolveModel(model);
    this.validate(normalizedModel);
    const apiKey = this.resolveApiKey();
    const baseUrl = normalizedModel.baseUrl ?? this.config.baseUrl ?? this.definition.baseUrl;
    if (!baseUrl) throw new Error(`No model endpoint configured. Set providers.${this.id}.baseUrl.`);
    const protocol = nativeProtocolForModel(normalizedModel, this.config, this.definition);
    const api = normalizedModel.apiBackend
      ?? this.config.apiBackend
      ?? this.definition.api
      ?? (this.config.type === "openai-codex"
        ? "responses"
        : protocol === "anthropic" ? "anthropic_messages" : "chat_completions");
    const reasoningProtocol = this.definition.reasoningProtocol
      ?? (api === "anthropic_messages"
        ? "anthropic"
        : api === "responses" || this.config.type === "openai-compatible" ? "openai" : undefined);
    const compatibility = normalizedModel.compatibility;
    const capabilities = modelCapabilities(normalizedModel);
    const selection = effectiveThinkingSelection(normalizedModel, agentConfig.thinking);
    const enabled = selection !== "off";
    const effort = enabled ? selection : undefined;
    const retry = this.config.retry ?? { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 };
    const providerOptions = createProviderOptions(reasoningProtocol, this.config, normalizedModel, api, enabled, effort);

    const transport = createNativeModel({
      provider: this.config.type,
      providerAlias: this.id,
      modelId: normalizedModel.model,
      api,
      baseUrl,
      apiKey,
      headers: {
        ...(this.config.type === "openai-codex" ? openAiCodexHeaders(apiKey) : {}),
        ...this.config.headers,
        ...normalizedModel.headers
      },
      fetch: this.fetcher,
      retry,
      maxTokensField: compatibility?.maxTokensField === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens",
      supportsDeveloperRole: compatibility?.supportsDeveloperRole === true,
      supportsTools: capabilities.tools,
      anthropicAuthMode: this.config.type === "anthropic" && this.config.authMode !== "oauth-bearer" ? "api-key" : "bearer",
      reasoningProtocol,
      providerOptions,
      apiAdapters: this.ai.adapters
    });
    const executable: AgentModel = {
      ...transport,
      streamSimple: async (context, options) => await this.streamSimple(agentConfig, model, context, options)
    };
    return {
      model: executable,
      providerOptions,
      reasoning: selection,
      timeoutMs: this.config.timeoutMs,
      maxOutputTokens: normalizedModel.maxOutputTokens,
      contextWindow: normalizedModel.contextWindow
    };
  }

  async streamSimple(
    agentConfig: AgentConfig,
    model: ModelAliasConfig,
    context: ModelStreamContext,
    options: ModelStreamOptions = {}
  ): Promise<AsyncIterable<ModelStreamEvent>> {
    const normalizedModel = this.resolveModel(model);
    const thinking = resolveSimpleThinking(agentConfig, normalizedModel, options.reasoning);
    const settings = this.createModelSettings({ ...agentConfig, thinking }, normalizedModel);
    return await settings.model.stream(context, {
      signal: options.signal,
      maxOutputTokens: options.maxOutputTokens ?? settings.maxOutputTokens,
      reasoning: settings.reasoning,
      providerOptions: options.providerOptions ?? settings.providerOptions,
      timeoutMs: options.timeoutMs ?? settings.timeoutMs,
      onRequestMetrics: options.onRequestMetrics,
      requestContext: options.requestContext
    });
  }

  async refreshCredential(signal?: AbortSignal): Promise<ProviderConfig | undefined> {
    const oauth = this.config.oauth;
    if (
      this.config.authMode !== "oauth-bearer"
      || !oauth?.refreshToken
      || oauth.expiresAt - Date.now() > oauthRefreshWindowMs
    ) return undefined;
    const extensionHandler = this.ai.credentialHandler(oauth.provider);
    if (extensionHandler) return await extensionHandler(this.config, signal);
    if (oauth.provider !== "claude-code" && oauth.provider !== "openai-codex") {
      throw new Error(`No credential refresh handler registered for ${oauth.provider}.`);
    }
    const refreshed = await refreshSubscriptionOAuthTokens(oauth.provider, {
      accessToken: this.config.apiKey ?? "",
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      accountId: oauth.accountId
    }, signal, this.fetcher);
    return {
      ...this.config,
      apiKey: refreshed.accessToken,
      oauth: {
        provider: oauth.provider,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
        accountId: refreshed.accountId
      }
    };
  }

  private resolveApiKey(): string | undefined {
    if (this.config.apiKey) return this.config.apiKey;
    const envName = this.config.apiKeyEnv ?? this.definition.apiKeyEnv;
    return envName ? process.env[envName] : undefined;
  }

  private normalizeCatalogEntry(entry: ModelCatalogEntry): ModelCatalogEntry {
    const model = catalogEntryToModel(entry);
    const normalized = normalizeModelMetadata(model, this.definition.modelDefaults);
    const reasoning = modelReasoningConfig(normalized);
    return {
      ...entry,
      id: normalized.model,
      displayName: normalized.displayName ?? normalized.model,
      provider: this.id,
      contextWindow: normalized.contextWindow,
      maxInputTokens: normalized.maxInputTokens,
      maxOutputTokens: normalized.maxOutputTokens,
      limits: normalized.limits,
      capabilities: modelCapabilities(normalized),
      reasoningEfforts: reasoning?.efforts ?? [],
      reasoningEffortsSource: entry.reasoningEffortsSource,
      thinkingLevelMap: modelThinkingLevelMap(normalized),
      apiBackend: normalized.apiBackend,
      baseUrl: normalized.baseUrl,
      headers: normalized.headers,
      compatibility: normalized.compatibility
    };
  }

  private mergedCatalog(): ModelCatalogEntry[] {
    const combined = new Map((this.config.type === "openai-codex" && this.liveModels.length
      ? this.liveModels
      : this.baselineModels).map((model) => [model.id, model]));
    for (const model of this.liveModels) {
      const existing = combined.get(model.id);
      combined.set(model.id, existing ? mergeCatalogMetadata(existing, model) : model);
    }
    return [...combined.values()];
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderRuntime>();

  constructor(
    private readonly config: AgentConfig,
    catalogs: readonly [string, ModelCatalogEntry[]][] = [],
    private readonly ai: AiRegistry = new AiRegistry(),
    modelsStore?: ModelsStore,
    private readonly fetcher: typeof globalThis.fetch = createProxyAwareFetch()
  ) {
    for (const [id, provider] of Object.entries(config.providers)) {
      const registration = ai.providers.get(provider.type);
      this.providers.set(id, new ConfiguredProviderRuntime(id, provider, ai, registration?.models, modelsStore, fetcher));
    }
    for (const [id, models] of catalogs) this.providers.get(id)?.restoreModels(models);
  }

  get(id: string): ProviderRuntime | undefined {
    return this.providers.get(id);
  }

  require(id: string): ProviderRuntime {
    const provider = this.get(id);
    if (!provider) throw new Error(`Unknown provider alias: ${id}`);
    return provider;
  }

  forModel(alias: string): { provider: ProviderRuntime; model: ModelAliasConfig } {
    const model = this.config.models[alias];
    if (!model) throw new Error(`Unknown model alias: ${alias}`);
    const provider = this.require(model.provider);
    return { provider, model: provider.resolveModel(model) };
  }

  createModelSettings(alias = this.config.defaultModel): NativeModelSettings {
    const { provider, model } = this.forModel(alias);
    return provider.createModelSettings(this.config, model);
  }

  listEmbeddingModels(): EmbeddingModelDescriptor[] {
    return [...this.providers.values()].flatMap((provider) => provider.listEmbeddingModels());
  }

  createEmbeddingRuntime(ref: Extract<EmbeddingModelRef, { kind: "provider" }>): EmbeddingModelRuntime {
    return this.require(ref.provider).createEmbeddingRuntime(ref.model);
  }

  validate(alias = this.config.defaultModel): void {
    const { provider, model } = this.forModel(alias);
    provider.validate(model);
  }

  async refreshModels(id: string, signal?: AbortSignal): Promise<ModelCatalogEntry[]> {
    return await this.require(id).refreshModels(signal);
  }

  catalogsSnapshot(): Array<[string, ModelCatalogEntry[]]> {
    return [...this.providers].flatMap(([id, provider]) => {
      const models = provider.getModels();
      return models.length ? [[id, models] as [string, ModelCatalogEntry[]]] : [];
    });
  }
}

function nativeProtocolForModel(
  model: ModelAliasConfig,
  provider: ProviderConfig,
  definition: ProviderDefinition
): "anthropic" | "openai-compatible" {
  if (model.apiBackend === "anthropic_messages") return "anthropic";
  if (model.apiBackend === "chat_completions") return "openai-compatible";
  return providerProtocol(provider, definition);
}

function missingKeyMessage(providerAlias: string, configuredEnv: string | undefined, defaultEnv: string | undefined): string {
  const envName = configuredEnv ?? defaultEnv;
  const credentialHint = process.platform === "darwin"
    ? `macOS Keychain 中的 provider:${providerAlias}:apiKey 或 ${envName ?? "配置的环境变量"}`
    : (envName ?? `providers.${providerAlias}.apiKeyEnv 环境变量`);
  return `No model available. Set ${credentialHint}.`;
}

function mergeCompatibility(provider: ModelCompatibility | undefined, model: ModelCompatibility | undefined): ModelCompatibility | undefined {
  if (!provider && !model) return undefined;
  return { ...provider, ...model };
}

function createProviderOptions(
  reasoningProtocol: ProviderDefinition["reasoningProtocol"],
  provider: ProviderConfig,
  model: ModelAliasConfig,
  api: ModelApiBackend,
  enabled: boolean,
  effort: AgentConfig["thinking"]["effort"] | undefined
): Record<string, unknown> | undefined {
  if (mergeCompatibility(provider.compatibility, model.compatibility)?.supportsReasoning === false) return undefined;
  if (!modelCapabilities(model).reasoning || modelReasoningConfig(model) === undefined) return undefined;
  const nativeEffort = effort === undefined ? undefined : nativeReasoningEffort(model, effort);
  const budgetTokens = effort === undefined ? 4_096 : reasoningBudgetTokens(model, effort);
  if (api === "anthropic_messages" || reasoningProtocol === "anthropic") {
    return { anthropic: { thinking: enabled ? { type: "enabled", budgetTokens } : { type: "disabled" } } };
  }
  if (reasoningProtocol === "deepseek") return { deepseek: { thinking: { type: enabled ? "enabled" : "disabled" }, reasoningEffort: enabled ? nativeEffort : undefined } };
  if (reasoningProtocol === "openai") return { openai: { reasoningEffort: enabled ? nativeEffort : "none" } };
  if (reasoningProtocol === "google") {
    return {
      google: {
        reasoningEffort: enabled ? nativeEffort : "none",
        thinkingBudget: enabled ? budgetTokens : 0,
        includeThoughts: enabled
      }
    };
  }
  if (reasoningProtocol === "alibaba") return { alibaba: { enableThinking: enabled, thinkingBudget: enabled ? budgetTokens : undefined } };
  if (reasoningProtocol === "moonshotai") {
    if (modelThinkingLevelMap(model).off === undefined) {
      return { moonshotai: { reasoningEffort: enabled ? nativeEffort ?? "high" : "low" } };
    }
    return { moonshotai: { thinking: { type: enabled ? "enabled" : "disabled" } } };
  }
  return undefined;
}

function isHttpEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function resolveSimpleThinking(
  config: AgentConfig,
  model: ModelAliasConfig,
  requested: ModelStreamOptions["reasoning"]
): AgentConfig["thinking"] {
  if (requested === undefined) return config.thinking;
  if (requested === "off") {
    const off = modelThinkingLevelMap(model).off;
    if (modelCapabilities(model).reasoning && (off === undefined || off === null)) {
      throw new Error(`Model ${model.model} does not support disabling thinking.`);
    }
    return { enabled: false, effort: config.thinking.effort };
  }
  const native = modelThinkingLevelMap(model)[requested];
  if (native === undefined || native === null || !modelReasoningConfig(model)?.efforts.includes(requested)) {
    throw new Error(`Model ${model.model} does not support ${requested} thinking effort.`);
  }
  return { enabled: true, effort: requested };
}

function catalogEntryToModel(entry: ModelCatalogEntry, preferGeneratedReasoning = false): ModelAliasConfig {
  const thinkingLevelMap = preferGeneratedReasoning && entry.reasoningEffortsSource === "inferred"
    ? undefined
    : entry.thinkingLevelMap
      ?? (entry.reasoningEfforts.length ? thinkingLevelMapForEfforts(entry.reasoningEfforts) : undefined);
  return {
    provider: entry.provider,
    model: entry.id,
    displayName: entry.displayName,
    description: entry.description,
    capabilities: entry.capabilities,
    contextWindow: entry.contextWindow,
    maxInputTokens: entry.maxInputTokens,
    maxOutputTokens: entry.maxOutputTokens,
    limits: entry.limits,
    apiBackend: entry.apiBackend,
    baseUrl: entry.baseUrl,
    headers: entry.headers,
    compatibility: entry.compatibility,
    thinkingLevelMap,
    pricing: entry.pricing
  };
}

function metadataToModel(provider: string, providerType: string, modelId: string, metadata: ModelMetadata): ModelAliasConfig {
  const thinkingLevelMap = accessPathThinkingLevelMap(providerType, modelId)
    ?? (metadata.thinkingLevelMap
    ? { ...metadata.thinkingLevelMap }
    : metadata.reasoningEfforts.length ? thinkingLevelMapForEfforts(metadata.reasoningEfforts) : undefined);
  return {
    provider,
    model: modelId,
    displayName: metadata.displayName,
    description: metadata.description,
    capabilities: metadata.capabilities,
    contextWindow: metadata.contextWindow,
    maxInputTokens: metadata.maxInputTokens,
    maxOutputTokens: metadata.maxOutputTokens,
    thinkingLevelMap,
    pricing: metadata.pricing
  };
}

function liveCatalogMetadata(entry: ModelCatalogEntry, provider: string): ModelCatalogEntry {
  return {
    id: entry.id,
    displayName: entry.displayName,
    provider,
    description: entry.description,
    showInPicker: entry.showInPicker,
    contextWindow: entry.contextWindow,
    maxInputTokens: entry.maxInputTokens,
    maxOutputTokens: entry.maxOutputTokens,
    limits: entry.limits ? { ...entry.limits } : undefined,
    capabilities: { ...entry.capabilities },
    reasoningEfforts: [...entry.reasoningEfforts],
    reasoningEffortsSource: entry.reasoningEffortsSource,
    thinkingLevelMap: entry.thinkingLevelMap ? { ...entry.thinkingLevelMap } : undefined,
    apiBackend: undefined,
    baseUrl: undefined,
    headers: undefined,
    compatibility: undefined,
    pricing: entry.pricing ? { ...entry.pricing } : undefined
  };
}

function mergeCatalogMetadata(base: ModelCatalogEntry, overlay: ModelCatalogEntry): ModelCatalogEntry {
  const useBaseReasoning = base.reasoningEffortsSource !== undefined || base.reasoningEfforts.length > 0;
  return {
    ...overlay,
    ...base,
    displayName: base.displayName || overlay.displayName,
    description: base.description ?? overlay.description,
    contextWindow: base.contextWindow ?? overlay.contextWindow,
    maxInputTokens: base.maxInputTokens ?? overlay.maxInputTokens,
    maxOutputTokens: base.maxOutputTokens ?? overlay.maxOutputTokens,
    limits: mergeCatalogLimits(base.limits, overlay.limits),
    capabilities: mergeCatalogCapabilities(base.capabilities, overlay.capabilities),
    reasoningEfforts: useBaseReasoning ? base.reasoningEfforts : overlay.reasoningEfforts,
    reasoningEffortsSource: useBaseReasoning ? base.reasoningEffortsSource : overlay.reasoningEffortsSource,
    thinkingLevelMap: base.thinkingLevelMap ?? overlay.thinkingLevelMap,
    apiBackend: base.apiBackend ?? overlay.apiBackend,
    baseUrl: base.baseUrl ?? overlay.baseUrl,
    headers: mergeHeaders(base.headers, overlay.headers),
    compatibility: mergeCompatibility(overlay.compatibility, base.compatibility),
    pricing: mergePricing(base.pricing, overlay.pricing)
  };
}

function mergeModelMetadata(base: ModelAliasConfig, override: ModelAliasConfig): ModelAliasConfig {
  const thinkingLevelMap = override.thinkingLevelMap
    ?? (override.reasoning ? reasoningConfigThinkingLevelMap(override.reasoning, base.thinkingLevelMap) : base.thinkingLevelMap);
  return {
    ...base,
    ...override,
    displayName: override.displayName ?? base.displayName,
    description: override.description ?? base.description,
    supportsTools: override.supportsTools ?? base.supportsTools,
    capabilities: mergeUserCapabilities(base.capabilities, override.capabilities),
    contextWindow: override.contextWindow ?? base.contextWindow,
    maxInputTokens: override.maxInputTokens ?? base.maxInputTokens,
    maxOutputTokens: override.maxOutputTokens ?? base.maxOutputTokens,
    limits: mergeUserLimits(base.limits, override.limits),
    thinkingLevelMap,
    reasoning: override.reasoning ?? base.reasoning,
    apiBackend: override.apiBackend ?? base.apiBackend,
    baseUrl: override.baseUrl ?? base.baseUrl,
    headers: mergeHeaders(override.headers, base.headers),
    compatibility: mergeCompatibility(base.compatibility, override.compatibility),
    pricing: override.pricing ?? base.pricing
  };
}

function reasoningConfigThinkingLevelMap(
  reasoning: NonNullable<ModelAliasConfig["reasoning"]>,
  base: ThinkingLevelMap | undefined
): ThinkingLevelMap {
  return {
    ...(base?.off !== undefined ? { off: base.off } : {}),
    ...Object.fromEntries(reasoning.efforts.map((effort) => [effort, reasoning.mapping?.[effort] ?? effort]))
  };
}

function mergePricing(
  base: ModelCatalogEntry["pricing"],
  overlay: ModelCatalogEntry["pricing"]
): ModelCatalogEntry["pricing"] {
  if (!base && !overlay) return undefined;
  return {
    inputPerMillionTokens: base?.inputPerMillionTokens ?? overlay?.inputPerMillionTokens,
    outputPerMillionTokens: base?.outputPerMillionTokens ?? overlay?.outputPerMillionTokens,
    cacheReadPerMillionTokens: base?.cacheReadPerMillionTokens ?? overlay?.cacheReadPerMillionTokens,
    cacheWritePerMillionTokens: base?.cacheWritePerMillionTokens ?? overlay?.cacheWritePerMillionTokens
  };
}

function mergeCatalogCapabilities(
  base: ModelAliasConfig["capabilities"],
  override: ModelAliasConfig["capabilities"]
): NonNullable<ModelAliasConfig["capabilities"]> {
  return {
    tools: base?.tools ?? override?.tools,
    parallelToolCalls: base?.parallelToolCalls ?? override?.parallelToolCalls,
    reasoning: base?.reasoning ?? override?.reasoning,
    reasoningStream: base?.reasoningStream ?? override?.reasoningStream,
    reasoningSummary: base?.reasoningSummary ?? override?.reasoningSummary,
    vision: base?.vision ?? override?.vision,
    audio: base?.audio ?? override?.audio,
    streaming: base?.streaming ?? override?.streaming
  };
}

function mergeUserCapabilities(
  base: ModelAliasConfig["capabilities"],
  override: ModelAliasConfig["capabilities"]
): NonNullable<ModelAliasConfig["capabilities"]> {
  return {
    tools: override?.tools ?? base?.tools,
    parallelToolCalls: override?.parallelToolCalls ?? base?.parallelToolCalls,
    reasoning: override?.reasoning ?? base?.reasoning,
    reasoningStream: override?.reasoningStream ?? base?.reasoningStream,
    reasoningSummary: override?.reasoningSummary ?? base?.reasoningSummary,
    vision: override?.vision ?? base?.vision,
    audio: override?.audio ?? base?.audio,
    streaming: override?.streaming ?? base?.streaming
  };
}

function mergeHeaders(
  base: Record<string, string> | undefined,
  overlay: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!base && !overlay) return undefined;
  return { ...overlay, ...base };
}

function mergeCatalogLimits(
  base: ModelCatalogEntry["limits"],
  overlay: ModelCatalogEntry["limits"]
): ModelCatalogEntry["limits"] {
  if (!base && !overlay) return undefined;
  return {
    maxInputTokens: base?.maxInputTokens ?? overlay?.maxInputTokens,
    reasoningReserveTokens: base?.reasoningReserveTokens ?? overlay?.reasoningReserveTokens,
    toolSchemaReserveTokens: base?.toolSchemaReserveTokens ?? overlay?.toolSchemaReserveTokens,
    systemPromptReserveTokens: base?.systemPromptReserveTokens ?? overlay?.systemPromptReserveTokens,
    protocolSafetyMarginTokens: base?.protocolSafetyMarginTokens ?? overlay?.protocolSafetyMarginTokens
  };
}

function mergeUserLimits(
  base: ModelCatalogEntry["limits"],
  override: ModelCatalogEntry["limits"]
): ModelCatalogEntry["limits"] {
  if (!base && !override) return undefined;
  return {
    maxInputTokens: override?.maxInputTokens ?? base?.maxInputTokens,
    reasoningReserveTokens: override?.reasoningReserveTokens ?? base?.reasoningReserveTokens,
    toolSchemaReserveTokens: override?.toolSchemaReserveTokens ?? base?.toolSchemaReserveTokens,
    systemPromptReserveTokens: override?.systemPromptReserveTokens ?? base?.systemPromptReserveTokens,
    protocolSafetyMarginTokens: override?.protocolSafetyMarginTokens ?? base?.protocolSafetyMarginTokens
  };
}
