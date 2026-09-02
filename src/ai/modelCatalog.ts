/**
 * 模型目录拉取与解析。
 *
 * 各服务商的 `/models` 响应字段命名很不统一（下划线/驼峰、context_window/context_length
 * 等），这里把它们归一成 `ModelCatalogEntry`。解析对未知字段一律宽容：识别不了就留空，
 * 不抛错，避免一个模型的异常字段导致整份目录不可用。
 *
 * 这里只读取凭据用于请求，不写配置、不落盘 key。
 */
import type { ModelLimits, ReasoningEffort, ThinkingLevelMap } from "../config/schema.js";
import { inferReasoningEfforts } from "./capabilities.js";
import { openAiCodexHeaders } from "./codexAuth.js";
import { providerProtocol } from "./provider.js";
import { createRetryFetch } from "./retry.js";
import type { CatalogProviderRequest, ModelCapabilities, ModelCatalogEntry } from "./types.js";
import { createProxyAwareFetch } from "../network/proxyFetch.js";

const catalogTimeoutMs = 15_000;

export interface ModelCatalogValidators {
  etag?: string;
  lastModified?: number;
}

export interface ModelCatalogFetchResult {
  models?: ModelCatalogEntry[];
  notModified: boolean;
  etag?: string;
  lastModified?: number;
}

/** 拉取服务商的实时模型列表；只读，不写入任何凭据或配置。 */
export async function fetchModelCatalog(request: CatalogProviderRequest, signal?: AbortSignal): Promise<ModelCatalogEntry[]> {
  return (await fetchModelCatalogSnapshot(request, signal)).models ?? [];
}

/** 带 HTTP 校验信息拉取目录，Provider Runtime 用它实现跨进程缓存复用。 */
export async function fetchModelCatalogSnapshot(
  request: CatalogProviderRequest,
  signal?: AbortSignal,
  validators: ModelCatalogValidators = {},
  fetcher: typeof globalThis.fetch = createProxyAwareFetch()
): Promise<ModelCatalogFetchResult> {
  const protocol = providerProtocol(request.config, request.definition);
  const endpoint = request.config.modelsEndpoint ?? defaultModelsEndpoint(request.config.baseUrl ?? request.definition.baseUrl, protocol);
  if (!endpoint) throw new Error(`No model catalog endpoint configured for provider ${request.alias}.`);
  const codex = request.config.type === "openai-codex";
  const catalogEndpoint = codex && !/[?&]client_version=/u.test(endpoint)
    ? `${endpoint}${endpoint.includes("?") ? "&" : "?"}client_version=1.0.0`
    : endpoint;
  // key 的取值顺序：配置里的明文 → 配置指定的环境变量 → provider 定义的默认环境变量。
  const apiKey = request.config.apiKey
    ?? (request.config.apiKeyEnv ? process.env[request.config.apiKeyEnv] : undefined)
    ?? (request.definition.apiKeyEnv ? process.env[request.definition.apiKeyEnv] : undefined);
  if ((request.config.requiresApiKey ?? request.definition.requiresApiKey) && !apiKey) {
    throw new Error(`No credentials available for provider ${request.alias}.`);
  }
  // Anthropic 原生协议用 x-api-key，Gemini 原生协议用 x-goog-api-key，
  // OAuth 场景和 OpenAI 兼容端点用 Bearer。
  const authMode = request.config.authMode ?? request.definition.authModes[0];
  const googleNative = request.config.apiBackend === "google_generative_ai" && authMode !== "oauth-bearer";
  const headers: Record<string, string> = codex
    ? {
      Authorization: apiKey ? `Bearer ${apiKey}` : "",
      ...openAiCodexHeaders(apiKey),
      "content-type": "application/json"
    }
    : protocol === "anthropic" && authMode !== "oauth-bearer"
    ? { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" }
    : googleNative
    ? { "x-goog-api-key": apiKey ?? "" }
    : { Authorization: apiKey ? `Bearer ${apiKey}` : "" };
  if (protocol === "anthropic" && authMode === "oauth-bearer") headers["anthropic-version"] = "2023-06-01";
  Object.assign(headers, request.config.headers);
  if (validators.etag) headers["If-None-Match"] = validators.etag;
  if (validators.lastModified) headers["If-Modified-Since"] = new Date(validators.lastModified).toUTCString();
  const retry = request.config.retry ?? { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 };
  const timeoutSignal = AbortSignal.timeout(catalogTimeoutMs);
  const response = await createRetryFetch(retry, fetcher)(catalogEndpoint, {
    headers,
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  });
  const responseValidators = {
    etag: response.headers.get("etag") ?? validators.etag,
    lastModified: httpTimestamp(response.headers.get("last-modified")) ?? validators.lastModified
  };
  if (response.status === 304) return { notModified: true, ...responseValidators };
  if (!response.ok) throw new Error(`Model catalog request failed (${String(response.status)}).`);
  const body = await response.json() as unknown;
  return {
    models: parseModelCatalog(body, request.alias, protocol, request.definition.modelDefaults?.inferReasoningFromId === true),
    notModified: false,
    ...responseValidators
  };
}

/**
 * 解析 `/models` 响应。响应体或条目形状不符合预期时跳过，不抛错，因此返回空数组既可能是
 * 「没有模型」也可能是「响应不认识」。
 */
export function parseModelCatalog(
  value: unknown,
  provider: string,
  _protocol: "anthropic" | "openai-compatible",
  inferReasoningFromId = true
): ModelCatalogEntry[] {
  const items = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.data)
      ? value.data
      : isRecord(value) && Array.isArray(value.models)
        ? value.models
        : [];
  // 用 flatMap 而不是 map+filter：无效条目直接返回空数组丢弃。
  return items.flatMap((item) => {
    if (!isRecord(item)) return [];
    const sources = modelMetadataSources(item);
    const visibility = stringValue(item.visibility)?.toLowerCase();
    if (visibility === "hide" || visibility === "hidden") return [];
    const slug = stringValue(item.slug);
    // Google 风格的目录只给资源名（name: "models/gemini-x"）；从 name 取 id 时剥掉资源段，
    // 让模型 id 保持可直接用于请求的形状。
    const resourceName = stringValue(item.name)?.replace(/^models\//u, "");
    const id = firstString(sources, ["id", "model", "name", "slug"])?.replace(/^models\//u, "") ?? resourceName ?? slug;
    if (!id) return [];
    const contextWindow = firstNumber(sources, [
      "context_window", "contextWindow", "context_length", "contextLength", "max_context_tokens", "maxContextTokens",
      "max_context_length", "maxContextLength"
    ]);
    const maxInputTokens = firstNumber(sources, [
      "max_input_tokens", "maxInputTokens", "input_token_limit", "inputTokenLimit", "max_input_length", "maxInputLength"
    ]);
    const maxOutputTokens = firstNumber(sources, [
      "max_tokens", "maxOutputTokens", "max_output_tokens", "output_token_limit", "outputTokenLimit",
      "max_completion_tokens", "maxCompletionTokens"
    ]);
    const declaredThinkingLevelMap = parseThinkingLevelMap(firstValue(sources, ["thinkingLevelMap", "thinking_level_map"]));
    const rawReasoningEfforts = firstArray(sources, [
      "reasoning_efforts", "reasoningEfforts", "thinking_levels", "thinkingLevels", "efforts"
    ]);
    const declaredReasoningEfforts = declaredThinkingLevelMap
      ? Object.keys(declaredThinkingLevelMap)
        .filter((level) => level !== "off" && declaredThinkingLevelMap[level] !== null)
        .filter(isReasoningEffort)
      : rawReasoningEfforts?.filter(isReasoningEffort);
    const supportsReasoning = firstBoolean(sources, ["supports_reasoning", "supportsReasoning", "reasoning"]);
    const reasoningEfforts = supportsReasoning === false
      ? []
      : declaredReasoningEfforts ?? (inferReasoningFromId ? inferReasoningEfforts(id) : []);
    const modalities = firstArray(sources, ["modalities", "input_modalities", "inputModalities"]) ?? [];
    const supportsThinking = firstBoolean(sources, ["thinking", "supports_thinking", "supportsThinking"]);
    const capabilities: Partial<ModelCapabilities> = {
      tools: firstBoolean(sources, ["supports_tools", "supportsTools", "tools"]),
      reasoning: supportsReasoning ?? supportsThinking,
      vision: firstBoolean(sources, ["supports_vision", "supportsVision", "vision"]) ?? modalityCapability(modalities, "image"),
      audio: firstBoolean(sources, ["supports_audio", "supportsAudio", "audio"]) ?? modalityCapability(modalities, "audio"),
      streaming: firstBoolean(sources, ["supports_streaming", "supportsStreaming", "streaming"]) ?? true
    };
    const parallelToolCalls = firstBoolean(sources, [
      "parallel_tool_calls", "parallelToolCalls", "supports_parallel_tool_calls", "supportsParallelToolCalls"
    ]);
    const reasoningStream = firstBoolean(sources, [
      "reasoning_stream", "reasoningStream", "supports_reasoning_stream", "supportsReasoningStream"
    ]);
    const reasoningSummary = firstBoolean(sources, [
      "reasoning_summary", "reasoningSummary", "supports_reasoning_summary", "supportsReasoningSummary"
    ]);
    if (parallelToolCalls !== undefined) capabilities.parallelToolCalls = parallelToolCalls;
    if (reasoningStream !== undefined) capabilities.reasoningStream = reasoningStream;
    if (reasoningSummary !== undefined) capabilities.reasoningSummary = reasoningSummary;
    const entry: ModelCatalogEntry = {
      id,
      displayName: firstString(sources, ["display_name", "displayName", "name"]) ?? (slug ? formatCodexModelName(id) : id),
      provider,
      contextWindow,
      maxOutputTokens,
      capabilities,
      reasoningEfforts,
      reasoningEffortsSource: supportsReasoning === false || declaredReasoningEfforts !== undefined
        ? "declared"
        : reasoningEfforts.length ? "inferred" : undefined
    };
    if (maxInputTokens !== undefined) entry.maxInputTokens = maxInputTokens;
    const limits = parseLimits(sources);
    if (limits) entry.limits = limits;
    if (declaredThinkingLevelMap) entry.thinkingLevelMap = declaredThinkingLevelMap;
    return [entry];
  });
}

/** Anthropic 的模型列表在 `/v1/models`，兼容端点的 baseUrl 通常已经带了版本段。 */
function defaultModelsEndpoint(baseUrl: string | undefined, protocol: "anthropic" | "openai-compatible"): string | undefined {
  if (!baseUrl) return undefined;
  const normalized = baseUrl.replace(/\/+$/u, "");
  return protocol === "anthropic" && !/\/v1$/u.test(normalized)
    ? `${normalized}/v1/models`
    : `${normalized}/models`;
}

// 以下取值函数统一策略：类型不对或明显无意义（空串、非正整数）就返回 undefined，
// 交给上层的 `??` 链继续尝试下一个字段名。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function formatCodexModelName(modelId: string): string {
  if (/^gpt-/iu.test(modelId)) return `GPT-${modelId.slice(4)}`;
  return modelId.replace(/(^|[-_])([a-z0-9])/giu, (_match, separator: string, character: string) => `${separator ? " " : ""}${character.toUpperCase()}`);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function modelMetadataSources(item: Record<string, unknown>): Record<string, unknown>[] {
  const sources = [item];
  for (const key of ["metadata", "model_info", "modelInfo", "limits", "capabilities", "reasoning", "model"]) {
    const nested = item[key];
    if (isRecord(nested)) sources.push(nested);
  }
  return sources;
}

function firstValue(sources: readonly Record<string, unknown>[], keys: readonly string[]): unknown {
  for (const source of sources) {
    for (const key of keys) {
      if (source[key] !== undefined) return source[key];
    }
  }
  return undefined;
}

function firstString(sources: readonly Record<string, unknown>[], keys: readonly string[]): string | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const value = stringValue(source[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function firstNumber(sources: readonly Record<string, unknown>[], keys: readonly string[]): number | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const value = numberValue(source[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function firstBoolean(sources: readonly Record<string, unknown>[], keys: readonly string[]): boolean | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const value = booleanValue(source[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function firstArray(sources: readonly Record<string, unknown>[], keys: readonly string[]): unknown[] | undefined {
  for (const source of sources) {
    for (const key of keys) {
      if (Array.isArray(source[key])) return source[key];
    }
  }
  return undefined;
}

function parseThinkingLevelMap(value: unknown): ThinkingLevelMap | undefined {
  if (!isRecord(value)) return undefined;
  const map: ThinkingLevelMap = {};
  for (const [key, native] of Object.entries(value)) {
    if (key !== "off" && !isReasoningEffort(key)) continue;
    if (native === null) map[key] = null;
    else if (typeof native === "string" && native.trim()) map[key] = native;
  }
  return Object.keys(map).length ? map : undefined;
}

function parseLimits(sources: readonly Record<string, unknown>[]): ModelLimits | undefined {
  const parsed: ModelLimits = {
    maxInputTokens: firstNumber(sources, ["maxInputTokens", "max_input_tokens"]),
    reasoningReserveTokens: firstNonNegativeInteger(sources, ["reasoningReserveTokens", "reasoning_reserve_tokens"]),
    toolSchemaReserveTokens: firstNonNegativeInteger(sources, ["toolSchemaReserveTokens", "tool_schema_reserve_tokens"]),
    systemPromptReserveTokens: firstNonNegativeInteger(sources, ["systemPromptReserveTokens", "system_prompt_reserve_tokens"]),
    protocolSafetyMarginTokens: firstNonNegativeInteger(sources, ["protocolSafetyMarginTokens", "protocol_safety_margin_tokens"])
  };
  return Object.values(parsed).some((item) => item !== undefined) ? parsed : undefined;
}

function firstNonNegativeInteger(sources: readonly Record<string, unknown>[], keys: readonly string[]): number | undefined {
  return nonNegativeInteger(firstValue(sources, keys));
}

/**
 * 只在 modality 出现时返回 true。不返回 false 是故意的：`modalities` 缺项不代表不支持，
 * 返回 undefined 才能让上层继续按默认值处理。
 */
function modalityCapability(modalities: unknown[], modality: string): boolean | undefined {
  return modalities.includes(modality) ? true : undefined;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function httpTimestamp(value: string | null): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
