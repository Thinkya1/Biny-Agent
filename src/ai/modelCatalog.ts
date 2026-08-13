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
  // Anthropic 原生协议用 x-api-key，OAuth 场景和 OpenAI 兼容端点用 Bearer。
  const authMode = request.config.authMode ?? request.definition.authModes[0];
  const headers: Record<string, string> = codex
    ? {
      Authorization: apiKey ? `Bearer ${apiKey}` : "",
      ...openAiCodexHeaders(apiKey),
      "content-type": "application/json"
    }
    : protocol === "anthropic" && authMode !== "oauth-bearer"
    ? { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" }
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
    const visibility = stringValue(item.visibility)?.toLowerCase();
    if (visibility === "hide" || visibility === "hidden") return [];
    const slug = stringValue(item.slug);
    const id = stringValue(item.id) ?? stringValue(item.model) ?? stringValue(item.name) ?? slug;
    if (!id) return [];
    const contextWindow = numberValue(item.context_window)
      ?? numberValue(item.contextWindow)
      ?? numberValue(item.context_length)
      ?? numberValue(item.contextLength)
      ?? numberValue(item.input_token_limit)
      ?? numberValue(item.inputTokenLimit);
    const maxInputTokens = numberValue(item.max_input_tokens)
      ?? numberValue(item.maxInputTokens)
      ?? numberValue(item.input_token_limit)
      ?? numberValue(item.inputTokenLimit);
    const maxOutputTokens = numberValue(item.max_tokens)
      ?? numberValue(item.maxOutputTokens)
      ?? numberValue(item.max_output_tokens)
      ?? numberValue(item.output_token_limit)
      ?? numberValue(item.outputTokenLimit)
      ?? numberValue(item.max_completion_tokens)
      ?? numberValue(item.maxCompletionTokens);
    const declaredThinkingLevelMap = parseThinkingLevelMap(item.thinkingLevelMap ?? item.thinking_level_map);
    const declaredReasoningEfforts = declaredThinkingLevelMap
      ? Object.keys(declaredThinkingLevelMap)
        .filter((level) => level !== "off" && declaredThinkingLevelMap[level] !== null)
        .filter(isReasoningEffort)
      : Array.isArray(item.reasoning_efforts)
      ? item.reasoning_efforts.filter(isReasoningEffort)
      : Array.isArray(item.reasoningEfforts)
        ? item.reasoningEfforts.filter(isReasoningEffort)
        : undefined;
    const supportsReasoning = booleanValue(item.supports_reasoning) ?? booleanValue(item.supportsReasoning);
    const reasoningEfforts = supportsReasoning === false
      ? []
      : declaredReasoningEfforts ?? (inferReasoningFromId ? inferReasoningEfforts(id) : []);
    const modalities = Array.isArray(item.modalities) ? item.modalities : [];
    const supportsThinking = booleanValue(item.thinking)
      ?? booleanValue(item.supports_thinking)
      ?? booleanValue(item.supportsThinking);
    const capabilities: Partial<ModelCapabilities> = {
      tools: booleanValue(item.supports_tools) ?? booleanValue(item.supportsTools),
      reasoning: supportsReasoning ?? supportsThinking,
      vision: booleanValue(item.supports_vision) ?? booleanValue(item.supportsVision) ?? modalityCapability(modalities, "image"),
      audio: booleanValue(item.supports_audio) ?? booleanValue(item.supportsAudio) ?? modalityCapability(modalities, "audio"),
      streaming: booleanValue(item.supports_streaming) ?? booleanValue(item.supportsStreaming) ?? true
    };
    const parallelToolCalls = booleanValue(item.parallel_tool_calls)
      ?? booleanValue(item.parallelToolCalls)
      ?? booleanValue(item.supports_parallel_tool_calls)
      ?? booleanValue(item.supportsParallelToolCalls);
    const reasoningStream = booleanValue(item.reasoning_stream)
      ?? booleanValue(item.reasoningStream)
      ?? booleanValue(item.supports_reasoning_stream)
      ?? booleanValue(item.supportsReasoningStream);
    const reasoningSummary = booleanValue(item.reasoning_summary)
      ?? booleanValue(item.reasoningSummary)
      ?? booleanValue(item.supports_reasoning_summary)
      ?? booleanValue(item.supportsReasoningSummary);
    if (parallelToolCalls !== undefined) capabilities.parallelToolCalls = parallelToolCalls;
    if (reasoningStream !== undefined) capabilities.reasoningStream = reasoningStream;
    if (reasoningSummary !== undefined) capabilities.reasoningSummary = reasoningSummary;
    const entry: ModelCatalogEntry = {
      id,
      displayName: stringValue(item.display_name) ?? stringValue(item.displayName) ?? stringValue(item.name) ?? (slug ? formatCodexModelName(id) : id),
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
    const limits = parseLimits(item);
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

function parseLimits(value: Record<string, unknown>): ModelLimits | undefined {
  const limits = isRecord(value.limits) ? value.limits : value;
  const parsed: ModelLimits = {
    maxInputTokens: numberValue(limits.maxInputTokens) ?? numberValue(limits.max_input_tokens),
    reasoningReserveTokens: nonNegativeInteger(limits.reasoningReserveTokens) ?? nonNegativeInteger(limits.reasoning_reserve_tokens),
    toolSchemaReserveTokens: nonNegativeInteger(limits.toolSchemaReserveTokens) ?? nonNegativeInteger(limits.tool_schema_reserve_tokens),
    systemPromptReserveTokens: nonNegativeInteger(limits.systemPromptReserveTokens) ?? nonNegativeInteger(limits.system_prompt_reserve_tokens),
    protocolSafetyMarginTokens: nonNegativeInteger(limits.protocolSafetyMarginTokens) ?? nonNegativeInteger(limits.protocol_safety_margin_tokens)
  };
  return Object.values(parsed).some((item) => item !== undefined) ? parsed : undefined;
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
