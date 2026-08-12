/**
 * 原生模型入口。
 *
 * 模型实例只负责把统一上下文交给选定的 API Adapter；各协议的 HTTP、SSE 和事件状态机
 * 位于 apiAdapters 目录，Provider 行为由上层运行时准备。
 */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  AgentModel,
  ModelRequestErrorCode,
  ModelRequestMetrics,
  ModelStreamContext,
  ModelStreamEvent,
  ModelStreamOptions
} from "../agent/core/types.js";
import type { ModelApiBackend } from "../config/schema.js";
import { createRetryFetch, type RetryPolicy } from "../ai/retry.js";
import { ApiAdapterRegistry, type ApiAdapter, type ApiAdapterRequest } from "./ApiAdapterRegistry.js";
import { anthropicMessagesAdapter } from "./apiAdapters/anthropicMessages.js";
import { openAiChatAdapter } from "./apiAdapters/openAiChat.js";
import { openAiResponsesAdapter } from "./apiAdapters/openAiResponses.js";
import { googleGenerativeAiAdapter } from "./apiAdapters/googleGenerativeAi.js";
import { contextOverflowMarker, contextOverflowPattern } from "./apiAdapters/shared.js";
import {
  computePromptShapeDiagnostic,
  LocalPromptProjectionCache,
  promptCacheCapability,
  promptShapeBudgetMs,
  type PromptCacheCapability,
  type PromptShapeDiagnostic
} from "./promptCache.js";
import { stableSystemPromptForCache } from "../agent/prompts.js";
import { redactSecrets } from "../utils/secrets.js";

// ProviderRuntime 的 streamSimple 会为每次请求生成轻量 transport；按 session 保存诊断前一条
// shape，才能跨 transport 比较同一会话的前缀。匿名直连模型仍使用实例内 map，避免测试/调用方互相污染。
const sessionPromptShapes = new Map<string, PromptShapeState>();
const maxSessionPromptShapeStates = 2048;

export interface NativeModelConfig {
  provider: string;
  providerAlias?: string;
  modelId: string;
  api: ModelApiBackend;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  retry?: RetryPolicy;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  supportsDeveloperRole?: boolean;
  supportsTools?: boolean;
  anthropicAuthMode?: "api-key" | "bearer";
  reasoningProtocol?: "deepseek" | "openai" | "google" | "anthropic" | "alibaba" | "moonshotai";
  providerOptions?: Record<string, unknown>;
  apiAdapters?: ApiAdapterRegistry;
}

export function isModelContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(contextOverflowMarker) || contextOverflowPattern.test(message);
}

export function createNativeModel(config: NativeModelConfig): AgentModel {
  const baseFetch = config.fetch ?? globalThis.fetch;
  if (typeof baseFetch !== "function") throw new Error("This runtime does not provide fetch().");
  const adapter = (config.apiAdapters ?? nativeApiAdapters).require(config.api);
  const previousPromptShapes = new Map<string, PromptShapeState>();
  const promptProjectionCache = new LocalPromptProjectionCache();
  const promptCache = promptCacheCapability({
    provider: config.provider,
    providerAlias: config.providerAlias,
    modelId: config.modelId,
    reasoningProtocol: config.reasoningProtocol,
    api: config.api
  });
  return {
    provider: config.provider,
    modelId: config.modelId,
    supportsTools: config.supportsTools !== false,
    stream: async (context, options) => observedNativeStream(
      adapter,
      config,
      baseFetch,
      context,
      options,
      previousPromptShapes,
      promptCache,
      promptProjectionCache
    )
  };
}

async function* observedNativeStream(
  adapter: ApiAdapter,
  config: NativeModelConfig,
  baseFetch: typeof globalThis.fetch,
  context: ModelStreamContext,
  options: ModelStreamOptions | undefined,
  previousPromptShapes: Map<string, PromptShapeState>,
  promptCache: PromptCacheCapability,
  promptProjectionCache: LocalPromptProjectionCache
): AsyncGenerator<ModelStreamEvent, void, void> {
  const startedAtMs = Date.now();
  const metrics: ModelRequestMetrics = {
    requestId: randomUUID(),
    provider: config.provider,
    modelId: config.modelId,
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: 0,
    attempts: [],
    eventCount: 0,
    requestContext: options?.requestContext === undefined
      ? undefined
      : {
        ...options.requestContext,
        relatedToolCallIds: options.requestContext.relatedToolCallIds === undefined
          ? undefined
          : [...options.requestContext.relatedToolCallIds]
      }
  };
  const sessionId = options?.requestContext?.sessionId;
  const shapeKey = sessionId ?? "__anonymous__";
  const shapeHistory = sessionId === undefined ? previousPromptShapes : sessionPromptShapes;
  const previousShapeState = shapeHistory.get(shapeKey);
  const promptEpoch = options?.requestContext?.promptEpoch;
  const shouldSkipPromptShape = previousShapeState?.skipDiagnostic === true
    && previousShapeState.slowEpoch === promptEpoch;
  if (shouldSkipPromptShape) {
    // 这里只跳过诊断 hash；adapter 仍然按正常路径构造并发送本次请求。
    metrics.promptShapeDurationMs = 0;
    metrics.promptShapeStatus = "skipped_due_to_budget";
    metrics.promptShapeBudgetExceeded = true;
  } else {
    const promptShapeStartedAt = performance.now();
    const promptShape = computePromptShapeDiagnostic({
      provider: config.provider,
      providerAlias: config.providerAlias,
      modelId: config.modelId,
      stableSystemPrompt: stableSystemPromptForCache(context.systemPrompt),
      systemPrompt: context.systemPrompt,
      tools: context.tools,
      messages: context.messages,
      providerOptions: options?.providerOptions ?? config.providerOptions,
      promptEpoch,
      promptEpochReason: options?.requestContext?.promptEpochReason,
      promptEpochCreatedAt: options?.requestContext?.promptEpochCreatedAt,
      localPromptCache: promptProjectionCache
    }, previousShapeState?.promptShape);
    const promptShapeDurationMs = Math.max(0, performance.now() - promptShapeStartedAt);
    const promptShapeBudgetExceeded = promptShapeDurationMs > promptShapeBudgetMs;
    metrics.promptShape = promptShape;
    metrics.promptShapeDurationMs = promptShapeDurationMs;
    metrics.promptShapeStatus = "full";
    metrics.promptShapeBudgetExceeded = promptShapeBudgetExceeded;
    rememberPromptShapeState(shapeHistory, shapeKey, {
      promptShape,
      skipDiagnostic: promptShapeBudgetExceeded,
      slowEpoch: promptShapeBudgetExceeded ? promptEpoch : undefined
    });
  }
  const report = async (error?: unknown): Promise<void> => {
    metrics.durationMs = Math.max(0, Date.now() - startedAtMs);
    if (error !== undefined) {
      metrics.error = safeErrorMessage(error);
      metrics.errorCode = classifyModelRequestError(error, metrics, options?.signal);
      metrics.errorPhase = metrics.timeToFirstEventMs === undefined ? "request" : "stream";
    }
    const observer = options?.onRequestMetrics;
    if (!observer) return;
    try {
      await observer({
        ...metrics,
        attempts: metrics.attempts.map((attempt) => ({ ...attempt })),
        requestContext: metrics.requestContext === undefined
          ? undefined
          : {
            ...metrics.requestContext,
            relatedToolCallIds: metrics.requestContext.relatedToolCallIds === undefined
              ? undefined
              : [...metrics.requestContext.relatedToolCallIds]
          }
      });
    } catch {
      // 观测回调属于旁路，不能让 provider 请求因为日志问题失败。
    }
  };
  let reported = false;
  const reportOnce = async (error?: unknown): Promise<void> => {
    if (reported) return;
    reported = true;
    await report(error);
  };
  const retry = config.retry ?? { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 };
  const fetcher = createRetryFetch(retry, baseFetch, (attempt) => {
    metrics.attempts.push({
      ...attempt,
      error: attempt.error === undefined ? undefined : redactSecrets(attempt.error)
    });
    if (attempt.status !== undefined) metrics.status = attempt.status;
  });
  const request: ApiAdapterRequest = {
    ...config,
    fetch: fetcher,
    promptCache,
    promptProjectionCache
  };
  try {
    const stream = adapter.stream(request, context, options);
    for await (const event of stream) {
      metrics.eventCount += 1;
      if (metrics.timeToFirstEventMs === undefined) {
        metrics.timeToFirstEventMs = Math.max(0, Date.now() - startedAtMs);
      }
      if (
        metrics.timeToFirstOutputMs === undefined
        && (event.type === "text-delta" || event.type === "reasoning-delta" || event.type === "tool-call")
      ) {
        metrics.timeToFirstOutputMs = Math.max(0, Date.now() - startedAtMs);
      }
      if (event.type === "finish") {
        metrics.finishReason = event.reason;
        metrics.usage = event.usage;
      }
      if (event.type === "error") {
        await reportOnce(event.error);
      }
      yield event;
    }
    await reportOnce();
  } catch (error) {
    await reportOnce(error);
    throw error;
  }
}

interface PromptShapeState {
  promptShape?: PromptShapeDiagnostic;
  skipDiagnostic: boolean;
  slowEpoch?: number;
}

function rememberPromptShapeState(
  shapeHistory: Map<string, PromptShapeState>,
  shapeKey: string,
  state: PromptShapeState
): void {
  shapeHistory.set(shapeKey, state);
  if (shapeHistory !== sessionPromptShapes || shapeHistory.size <= maxSessionPromptShapeStates) return;
  const oldestKey = shapeHistory.keys().next().value;
  if (oldestKey !== undefined) shapeHistory.delete(oldestKey);
}

function safeErrorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function classifyModelRequestError(
  error: unknown,
  metrics: ModelRequestMetrics,
  signal: AbortSignal | undefined
): ModelRequestErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return "aborted";
  if ((error instanceof Error && error.name === "TimeoutError") || /timed? ?out|timeout/iu.test(message)) return "timeout";
  if (isModelContextOverflowError(error)) return "context_overflow";
  if (/request failed \(\d{3}\)/u.test(message) || (metrics.status !== undefined && metrics.status >= 400)) return "http_error";
  if (error instanceof TypeError || /fetch failed|network|socket|econn|enotfound/iu.test(message)) return "network_error";
  if (/invalid json|empty response body|ended before|returned an error|contained invalid/iu.test(message)) return "protocol_error";
  if (error instanceof Error) return "provider_error";
  return "unknown";
}

export function createNativeApiAdapterRegistry(): ApiAdapterRegistry {
  return new ApiAdapterRegistry([openAiChatAdapter, openAiResponsesAdapter, anthropicMessagesAdapter, googleGenerativeAiAdapter]);
}

const nativeApiAdapters = createNativeApiAdapterRegistry();
