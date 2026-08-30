/**
 * OpenAI Chat Completions 兼容协议 Adapter。
 */
import type { AgentUsage, ModelStreamContext, ModelStreamEvent, ModelStreamOptions } from "../../agent/core/types.js";
import type { ApiAdapter, ApiAdapterRequest } from "../ApiAdapterRegistry.js";
import { promptCacheCapability, stableAgentTools } from "../promptCache.js";
import {
  applyOpenAiReasoning,
  firstRecord,
  isRecord,
  mapOpenAiStopReason,
  mapOpenAiUsage,
  openAiMessages,
  openAiTool,
  parseJson,
  parseToolArguments,
  parseToolArgumentsValue,
  providerHttpError,
  providerNetworkError,
  randomToolCallId,
  readSse,
  readString,
  readText,
  requestHeaders,
  requestSignal,
  resolveEndpoint,
  throwPayloadError,
  type AgentModelFinishReason
} from "./shared.js";

export const openAiChatAdapter: ApiAdapter = {
  id: "chat_completions",
  stream: (request, context, options) => streamOpenAi(request, request.fetch, context, options)
};

export async function* streamOpenAi(
  config: ApiAdapterRequest,
  fetcher: typeof globalThis.fetch,
  context: ModelStreamContext,
  options: ModelStreamOptions = {}
): AsyncGenerator<ModelStreamEvent, void, void> {
  const signal = requestSignal(options);
  const body: Record<string, unknown> = {
    model: config.modelId,
    messages: openAiMessages(context, config.supportsDeveloperRole === true, config.reasoningProtocol),
    stream: true,
    stream_options: { include_usage: true }
  };
  if (context.tools.length) {
    body.tools = stableAgentTools(context.tools, config.promptProjectionCache).map(openAiTool);
    body.tool_choice = "auto";
  }
  if (options.maxOutputTokens !== undefined) {
    body[config.maxTokensField ?? "max_tokens"] = options.maxOutputTokens;
  }
  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }
  applyOpenAiReasoning(body, config, options);
  const cacheCapability = config.promptCache ?? promptCacheCapability({
    provider: config.provider,
    providerAlias: config.providerAlias,
    modelId: config.modelId,
    reasoningProtocol: config.reasoningProtocol,
    api: "chat_completions"
  });
  if (cacheCapability.supportsPromptCacheKey && options.requestContext?.sessionId !== undefined) {
    body.prompt_cache_key = options.requestContext.sessionId;
  }

  const endpoint = resolveEndpoint(config.baseUrl, "chat/completions");
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: requestHeaders(config, "openai"),
      body: JSON.stringify(body),
      signal
    });
  } catch (error) {
    throw providerNetworkError(error, "OpenAI-compatible provider", endpoint);
  }
  if (!response.ok) throw await providerHttpError(response, "OpenAI-compatible provider");
  if (!response.body) throw new Error("OpenAI-compatible provider returned an empty response body.");

  yield { type: "start" };
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const payload = await response.json() as Record<string, any>;
    throwPayloadError(payload, "OpenAI-compatible provider");
    const choice = firstRecord(payload.choices)?.value;
    const message = isRecord(choice) && isRecord(choice.message) ? choice.message : {};
    const text = readText(message.content);
    if (text) yield { type: "text-delta", text };
    const reasoning = readString(message.reasoning_content) ?? readString(message.reasoning);
    if (reasoning) yield { type: "reasoning-delta", id: "reasoning-0", text: reasoning };
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const raw of calls) {
      if (!isRecord(raw)) continue;
      const fn = isRecord(raw.function) ? raw.function : {};
      const parsed = parseToolArgumentsValue(fn.arguments);
      yield {
        type: "tool-call",
        id: readString(raw.id) ?? randomToolCallId(),
        name: requireOpenAiToolName(readString(fn.name)),
        arguments: parsed.args,
        invalid: parsed.invalid
      };
    }
    yield { type: "finish", reason: mapOpenAiStopReason(readString(choice?.finish_reason)), usage: isRecord(payload.usage) ? mapOpenAiUsage(payload.usage, cacheCapability) : undefined };
    return;
  }
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let finishReason: AgentModelFinishReason = "stop";
  let usage: AgentUsage | undefined;
  let receivedTerminalEvent = false;
  for await (const event of readSse(response.body)) {
    if (event.data === "[DONE]") {
      receivedTerminalEvent = true;
      break;
    }
    const payload = parseJson(event.data, "OpenAI-compatible stream event");
    throwPayloadError(payload, "OpenAI-compatible provider");
    const choice = firstRecord(payload.choices)?.value;
    const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : undefined;
    if (isRecord(delta)) {
      const text = readText(delta.content);
      if (text) yield { type: "text-delta", text };
      const reasoning = readString(delta.reasoning_content) ?? readString(delta.reasoning);
      if (reasoning) {
        const id = "reasoning-0";
        yield { type: "reasoning-delta", id, text: reasoning };
      }
      const deltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const raw of deltas) {
        if (!isRecord(raw)) continue;
        const index = typeof raw.index === "number" ? raw.index : toolCalls.size;
        const fn = isRecord(raw.function) ? raw.function : {};
        const current = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
        current.id = readString(raw.id) ?? current.id;
        current.name = readString(fn.name) ?? current.name;
        current.arguments += readString(fn.arguments) ?? "";
        toolCalls.set(index, current);
      }
    }
    if (isRecord(choice)) {
      const rawFinishReason = readString(choice.finish_reason);
      if (rawFinishReason) {
        finishReason = mapOpenAiStopReason(rawFinishReason);
        receivedTerminalEvent = true;
      }
    }
    if (isRecord(payload.usage)) usage = mapOpenAiUsage(payload.usage, cacheCapability);
  }
  if (!receivedTerminalEvent) {
    throw new Error("OpenAI-compatible stream ended before a finish reason or [DONE].");
  }
  for (const call of [...toolCalls.values()]) {
    const parsed = parseToolArguments(call.arguments);
    yield {
      type: "tool-call",
      id: call.id || randomToolCallId(),
      name: requireOpenAiToolName(call.name),
      arguments: parsed.args,
      invalid: parsed.invalid
    };
  }
  yield { type: "finish", reason: finishReason, usage };
}

function requireOpenAiToolName(name: string | undefined): string {
  const normalized = name?.trim();
  if (!normalized) throw new Error("OpenAI-compatible provider returned a tool call without a function name.");
  return normalized;
}
