/**
 * OpenAI Responses 协议 Adapter。
 */
import type { AgentUsage, ModelStreamContext, ModelStreamEvent, ModelStreamOptions } from "../../agent/core/types.js";
import type { ApiAdapter, ApiAdapterRequest } from "../ApiAdapterRegistry.js";
import { promptCacheCapability, stableAgentTools } from "../promptCache.js";
import {
  applyResponsesReasoning,
  isRecord,
  mapResponsesStopReason,
  mapResponsesUsage,
  parseJson,
  parseToolArguments,
  providerHttpError,
  providerPayloadError,
  providerNetworkError,
  randomToolCallId,
  readSse,
  readString,
  removeUndefined,
  requestHeaders,
  requestSignal,
  resolveEndpoint,
  responsesInput,
  responsesTool,
  type AgentModelFinishReason
} from "./shared.js";

export const openAiResponsesAdapter: ApiAdapter = {
  id: "responses",
  stream: (request, context, options) => streamOpenAiResponses(request, request.fetch, context, options)
};

export async function* streamOpenAiResponses(
  config: ApiAdapterRequest,
  fetcher: typeof globalThis.fetch,
  context: ModelStreamContext,
  options: ModelStreamOptions = {}
): AsyncGenerator<ModelStreamEvent, void, void> {
  const signal = requestSignal(options);
  const cacheCapability = config.promptCache ?? promptCacheCapability({
    provider: config.provider,
    providerAlias: config.providerAlias,
    modelId: config.modelId,
    reasoningProtocol: config.reasoningProtocol,
    api: "responses"
  });
  const body: Record<string, unknown> = {
    model: config.modelId,
    instructions: context.systemPrompt,
    input: responsesInput(context),
    stream: true
  };
  // 所有 Responses 请求都显式关闭服务端存储，保持本地 session 为唯一状态来源。
  // ChatGPT/Codex 端点会直接拒绝缺少该字段的请求（400 Store must be set to false）。
  body.store = false;
  if (context.tools.length) body.tools = stableAgentTools(context.tools, config.promptProjectionCache).map(responsesTool);
  if (cacheCapability.supportsPromptCacheKey && options.requestContext?.sessionId !== undefined) {
    body.prompt_cache_key = options.requestContext.sessionId;
  }
  // Codex 的 ChatGPT 访问路径不接受该字段；模型输出上限仍保留在本地元数据和预算计算中。
  // 官方 OpenAI Responses 端点继续发送它，避免把两个访问路径的契约混在一起。
  if (config.provider !== "openai-codex" && options.maxOutputTokens !== undefined) {
    body.max_output_tokens = options.maxOutputTokens;
  }
  // Codex 的 ChatGPT 访问路径同样拒绝 temperature；官方 Responses 端点正常支持。
  if (config.provider !== "openai-codex" && options.temperature !== undefined) {
    body.temperature = options.temperature;
  }
  applyResponsesReasoning(body, config, options);

  const endpoint = resolveEndpoint(config.baseUrl, "responses");
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: requestHeaders(config, "responses"),
      body: JSON.stringify(removeUndefined(body)),
      signal
    });
  } catch (error) {
    throw providerNetworkError(error, "OpenAI Responses provider", endpoint);
  }
  if (!response.ok) throw await providerHttpError(response, "OpenAI Responses provider");
  if (!response.body) throw new Error("OpenAI Responses provider returned an empty response body.");

  yield { type: "start" };
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    yield* responsesPayloadEvents(await response.json() as Record<string, unknown>, cacheCapability);
    return;
  }

  const calls = new Map<string, ResponsesToolCall>();
  let finishReason: AgentModelFinishReason = "stop";
  let usage: AgentUsage | undefined;
  let receivedTerminalEvent = false;
  for await (const event of readSse(response.body)) {
    const payload = parseJson(event.data, "OpenAI Responses stream event");
    const eventType = readString(event.event) ?? readString(payload.type);
    if (eventType === "response.output_text.delta") {
      const text = readString(payload.delta);
      if (text) yield { type: "text-delta", text };
    } else if (eventType === "response.reasoning_summary_text.delta" || eventType === "response.reasoning_text.delta") {
      const text = readString(payload.delta);
      if (text) yield {
        type: "reasoning-delta",
        id: "reasoning-0",
        text,
        providerMetadata: eventType === "response.reasoning_summary_text.delta"
          ? { openai: { summary: true } }
          : undefined
      };
    } else if (eventType === "response.output_item.added" || eventType === "response.output_item.done") {
      const item = isRecord(payload.item) ? payload.item : undefined;
      if (item?.type === "function_call") {
        const call = resolveResponsesToolCall(calls, readString(item.id), readString(item.call_id));
        call.name = readString(item.name) ?? call.name;
        call.arguments = readString(item.arguments) ?? call.arguments;
        if (eventType === "response.output_item.done") {
          const toolCall = responsesToolCallEvent(call);
          if (toolCall) yield toolCall;
        }
      }
    } else if (eventType === "response.function_call_arguments.delta") {
      const itemId = readString(payload.item_id);
      const callId = readString(payload.call_id);
      if (itemId || callId) {
        const call = resolveResponsesToolCall(calls, itemId, callId);
        call.arguments += readString(payload.delta) ?? "";
      }
    } else if (eventType === "response.function_call_arguments.done") {
      const itemId = readString(payload.item_id);
      const callId = readString(payload.call_id);
      if (itemId || callId) {
        const call = resolveResponsesToolCall(calls, itemId, callId);
        call.arguments = readString(payload.arguments) ?? call.arguments;
        call.name = readString(payload.name) ?? call.name;
        // 标准事件只在 output_item.added 里携带函数名和 call_id；若 added 丢失，
        // 等 output_item.done 补齐身份后再发，不能先用 item_id 生成错误的工具结果引用。
        const toolCall = call.name ? responsesToolCallEvent(call) : undefined;
        if (toolCall) yield toolCall;
      }
    } else if (eventType === "response.completed" || eventType === "response.done" || eventType === "response.incomplete") {
      const result = isRecord(payload.response) ? payload.response : payload;
      finishReason = mapResponsesStopReason(result.status, result.incomplete_details);
      usage = isRecord(result.usage) ? mapResponsesUsage(result.usage, cacheCapability) : usage;
      receivedTerminalEvent = true;
    } else if (eventType === "response.failed") {
      const result = isRecord(payload.response) ? payload.response : payload;
      throw new Error(providerPayloadError(result, "OpenAI Responses provider"));
    } else if (eventType === "error") {
      throw new Error(providerPayloadError(payload, "OpenAI Responses provider"));
    }
  }
  if (!receivedTerminalEvent) {
    throw new Error("OpenAI Responses stream ended before a terminal response event.");
  }
  yield { type: "finish", reason: finishReason, usage };
}

interface ResponsesToolCall {
  id: string;
  name: string;
  arguments: string;
  emitted: boolean;
}

/** 同一调用在不同 Responses 事件里分别使用 item_id 与 call_id，需要映射到同一状态。 */
function resolveResponsesToolCall(
  calls: Map<string, ResponsesToolCall>,
  itemId: string | undefined,
  callId: string | undefined
): ResponsesToolCall {
  const call = (callId ? calls.get(callId) : undefined)
    ?? (itemId ? calls.get(itemId) : undefined)
    ?? { id: callId ?? itemId ?? randomToolCallId(), name: "", arguments: "", emitted: false };
  if (callId) {
    call.id = callId;
    calls.set(callId, call);
  }
  if (itemId) calls.set(itemId, call);
  return call;
}

function responsesToolCallEvent(call: ResponsesToolCall): ModelStreamEvent | undefined {
  if (call.emitted) return undefined;
  const parsed = parseToolArguments(call.arguments);
  call.emitted = true;
  return { type: "tool-call", id: call.id, name: call.name || "unknown", arguments: parsed.args, invalid: parsed.invalid };
}

function* responsesPayloadEvents(
  payload: Record<string, unknown>,
  cacheCapability: ReturnType<typeof promptCacheCapability>
): Generator<ModelStreamEvent, void, void> {
  if (payload.error !== undefined) {
    yield { type: "error", error: providerPayloadError(payload, "OpenAI Responses provider") };
    return;
  }
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content) {
        if (isRecord(part) && (part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
          yield { type: "text-delta", text: part.text };
        }
      }
    } else if (item.type === "function_call") {
      const parsed = parseToolArguments(readString(item.arguments) ?? "{}");
      yield { type: "tool-call", id: readString(item.call_id) ?? readString(item.id) ?? randomToolCallId(), name: readString(item.name) ?? "unknown", arguments: parsed.args, invalid: parsed.invalid };
    } else if (item.type === "reasoning") {
      const summary = Array.isArray(item.summary) ? item.summary : [];
      for (const part of summary) {
        if (isRecord(part) && typeof part.text === "string") yield {
          type: "reasoning-delta",
          id: "reasoning-0",
          text: part.text,
          providerMetadata: { openai: { summary: true } }
        };
      }
    }
  }
  yield { type: "finish", reason: mapResponsesStopReason(readString(payload.status), payload.incomplete_details), usage: isRecord(payload.usage) ? mapResponsesUsage(payload.usage, cacheCapability) : undefined };
}
