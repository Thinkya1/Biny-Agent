/**
 * Anthropic Messages 协议 Adapter。
 */
import type { AgentUsage, ModelStreamContext, ModelStreamEvent, ModelStreamOptions } from "../../agent/core/types.js";
import type { ApiAdapter, ApiAdapterRequest } from "../ApiAdapterRegistry.js";
import { stableAgentTools } from "../promptCache.js";
import {
  anthropicMessages,
  anthropicReasoningMetadata,
  anthropicTool,
  applyAnthropicThinking,
  isRecord,
  mapAnthropicUsage,
  mapAnthropicStopReason,
  parseJson,
  parseToolArguments,
  providerHttpError,
  providerNetworkError,
  providerPayloadError,
  randomToolCallId,
  readNumber,
  readSse,
  readString,
  removeUndefined,
  requestHeaders,
  requestSignal,
  resolveEndpoint,
  sumUsage,
  throwPayloadError,
  type AgentModelFinishReason
} from "./shared.js";

export const anthropicMessagesAdapter: ApiAdapter = {
  id: "anthropic_messages",
  stream: (request, context, options) => streamAnthropic(request, request.fetch, context, options)
};

export async function* streamAnthropic(
  config: ApiAdapterRequest,
  fetcher: typeof globalThis.fetch,
  context: ModelStreamContext,
  options: ModelStreamOptions = {}
): AsyncGenerator<ModelStreamEvent, void, void> {
  const signal = requestSignal(options);
  const body: Record<string, unknown> = {
    model: config.modelId,
    system: context.systemPrompt ? [{ type: "text", text: context.systemPrompt }] : undefined,
    messages: anthropicMessages(context),
    max_tokens: options.maxOutputTokens ?? 4_096,
    stream: true
  };
  if (context.tools.length) body.tools = stableAgentTools(context.tools, config.promptProjectionCache).map(anthropicTool);
  // Anthropic 开启扩展思考时不允许自定义 temperature（必须为 1）；判断来源与
  // applyAnthropicThinking 一致（providerOptions.anthropic.thinking），思考开启时跳过下发。
  const configuredOptions = isRecord(options.providerOptions) ? options.providerOptions : config.providerOptions;
  const anthropicOptions = isRecord(configuredOptions?.anthropic) ? configuredOptions.anthropic : undefined;
  const thinkingActive = isRecord(anthropicOptions?.thinking) && anthropicOptions.thinking.type === "enabled";
  if (options.temperature !== undefined && !thinkingActive) {
    body.temperature = options.temperature;
  }
  applyAnthropicThinking(body, config, options);

  const endpoint = resolveEndpoint(config.baseUrl, "v1/messages");
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: requestHeaders(config, "anthropic"),
      body: JSON.stringify(removeUndefined(body)),
      signal
    });
  } catch (error) {
    throw providerNetworkError(error, "Anthropic provider", endpoint);
  }
  if (!response.ok) throw await providerHttpError(response, "Anthropic provider");
  if (!response.body) throw new Error("Anthropic provider returned an empty response body.");

  yield { type: "start" };
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const payload = await response.json() as Record<string, any>;
    throwPayloadError(payload, "Anthropic provider");
    const blocks = Array.isArray(payload.content) ? payload.content : [];
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") yield { type: "text-delta", text: block.text };
      else if (block.type === "thinking" && typeof block.thinking === "string") {
        const providerMetadata = anthropicReasoningMetadata(readString(block.signature));
        yield { type: "reasoning-start", id: "reasoning-0" };
        yield { type: "reasoning-delta", id: "reasoning-0", text: block.thinking, providerMetadata };
        yield { type: "reasoning-end", id: "reasoning-0", providerMetadata };
      } else if (block.type === "tool_use") {
        const parsed = isRecord(block.input) ? { args: block.input, invalid: false } : { args: {}, invalid: true };
        yield { type: "tool-call", id: readString(block.id) ?? randomToolCallId(), name: readString(block.name) ?? "unknown", arguments: parsed.args, invalid: parsed.invalid };
      }
    }
    yield {
      type: "finish",
      reason: mapAnthropicStopReason(readString(payload.stop_reason)),
      usage: isRecord(payload.usage) ? mapAnthropicUsage(payload.usage) : undefined
    };
    return;
  }
  const blocks = new Map<number, { type: string; id?: string; name?: string; input: string; signature?: string }>();
  let finishReason: AgentModelFinishReason = "stop";
  let usage: AgentUsage | undefined;
  let receivedTerminalEvent = false;
  for await (const event of readSse(response.body)) {
    const payload = parseJson(event.data, "Anthropic stream event");
    const eventType = readString(payload.type);
    if (eventType === "error") {
      throw new Error(providerPayloadError(payload, "Anthropic provider"));
    } else if (eventType === "message_start" && isRecord(payload.message) && isRecord(payload.message.usage)) {
      usage = mapAnthropicUsage(payload.message.usage);
    } else if (eventType === "content_block_start") {
      const index = readNumber(payload.index) ?? blocks.size;
      const block = isRecord(payload.content_block) ? payload.content_block : {};
      const type = readString(block.type) ?? "text";
      const entry = { type, id: readString(block.id), name: readString(block.name), input: "", signature: readString(block.signature) };
      blocks.set(index, entry);
      if (type === "thinking") yield { type: "reasoning-start", id: `reasoning-${String(index)}` };
    } else if (eventType === "content_block_delta") {
      const index = readNumber(payload.index) ?? 0;
      const delta = isRecord(payload.delta) ? payload.delta : {};
      const deltaType = readString(delta.type);
      if (deltaType === "text_delta") {
        const text = readString(delta.text);
        if (text) yield { type: "text-delta", text };
      } else if (deltaType === "thinking_delta") {
        const text = readString(delta.thinking);
        if (text) yield { type: "reasoning-delta", id: `reasoning-${String(index)}`, text };
      } else if (deltaType === "input_json_delta") {
        const block = blocks.get(index);
        if (block) block.input += readString(delta.partial_json) ?? "";
      } else if (deltaType === "signature_delta") {
        const block = blocks.get(index);
        if (block) block.signature = `${block.signature ?? ""}${readString(delta.signature) ?? ""}`;
      }
    } else if (eventType === "content_block_stop") {
      const index = readNumber(payload.index) ?? 0;
      const block = blocks.get(index);
      if (block?.type === "tool_use") {
        const parsed = parseToolArguments(block.input);
        yield { type: "tool-call", id: block.id ?? randomToolCallId(), name: block.name ?? "unknown", arguments: parsed.args, invalid: parsed.invalid };
      } else if (block?.type === "thinking") {
        yield { type: "reasoning-end", id: `reasoning-${String(index)}`, providerMetadata: anthropicReasoningMetadata(block.signature) };
      }
    } else if (eventType === "message_delta") {
      const delta = isRecord(payload.delta) ? payload.delta : {};
      const rawStopReason = readString(delta.stop_reason);
      if (rawStopReason) {
        finishReason = mapAnthropicStopReason(rawStopReason);
        receivedTerminalEvent = true;
      }
      if (isRecord(payload.usage)) {
        usage = { ...usage, outputTokens: readNumber(payload.usage.output_tokens), totalTokens: sumUsage(usage, readNumber(payload.usage.output_tokens)) };
      }
    } else if (eventType === "message_stop") {
      receivedTerminalEvent = true;
    }
  }
  if (!receivedTerminalEvent) throw new Error("Anthropic stream ended before message_stop or a stop reason.");
  yield { type: "finish", reason: finishReason, usage };
}
