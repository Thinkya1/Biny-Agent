/**
 * Google Generative AI 原生协议 Adapter。
 *
 * Gemini 的 parts、functionCall 和 usageMetadata 在这里归一化，上层只接收 Biny 的统一事件。
 */
import type {
  AgentMessage,
  AgentTool,
  AgentUserMessage,
  ModelStreamContext,
  ModelStreamEvent,
  ModelStreamOptions
} from "../../agent/core/types.js";
import type { ApiAdapter, ApiAdapterRequest } from "../ApiAdapterRegistry.js";
import { stableAgentTools } from "../promptCache.js";
import {
  isRecord,
  parseJson,
  providerHttpError,
  providerNetworkError,
  randomToolCallId,
  readNumber,
  readSse,
  readString,
  removeUndefined
} from "./shared.js";

export const googleGenerativeAiAdapter: ApiAdapter = {
  id: "google_generative_ai",
  stream: (request, context, options) => streamGoogle(request, context, options)
};

async function* streamGoogle(
  request: ApiAdapterRequest,
  context: ModelStreamContext,
  options: ModelStreamOptions = {}
): AsyncGenerator<ModelStreamEvent, void, void> {
  const body: Record<string, unknown> = {
    systemInstruction: context.systemPrompt ? { parts: [{ text: context.systemPrompt }] } : undefined,
    contents: context.messages.map(googleMessage),
    tools: context.tools.length ? [{ functionDeclarations: stableAgentTools(context.tools, request.promptProjectionCache).map(googleTool) }] : undefined,
    generationConfig: {
      maxOutputTokens: options.maxOutputTokens,
      thinkingConfig: googleThinking(options.reasoning, request.providerOptions)
    }
  };
  const baseUrl = request.baseUrl.replace(/\/+$/u, "");
  const endpoint = `${baseUrl}/models/${encodeURIComponent(request.modelId)}:streamGenerateContent?alt=sse`;
  let response: Response;
  try {
    response = await request.fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...(request.apiKey ? { "x-goog-api-key": request.apiKey } : {}),
        ...request.headers
      },
      body: JSON.stringify(removeUndefined(body)),
      signal: requestSignal(options)
    });
  } catch (error) {
    throw providerNetworkError(error, "Google Generative AI provider", endpoint);
  }
  if (!response.ok) throw await providerHttpError(response, "Google Generative AI provider");
  if (!response.body) throw new Error("Google Generative AI provider returned an empty response body.");

  yield { type: "start" };
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const payload = await response.json() as unknown;
    let receivedFinish = false;
    for (const item of Array.isArray(payload) ? payload : [payload]) {
      for (const event of googlePayloadEvents(item, true)) {
        if (event.type === "finish") receivedFinish = true;
        yield event;
      }
    }
    if (!receivedFinish) throw new Error("Google Generative AI response did not contain a finish reason.");
    return;
  }
  let receivedFinish = false;
  for await (const event of readSse(response.body)) {
    for (const modelEvent of googlePayloadEvents(parseJson(event.data, "Google Generative AI stream event"), false)) {
      if (modelEvent.type === "finish") receivedFinish = true;
      yield modelEvent;
    }
  }
  if (!receivedFinish) throw new Error("Google Generative AI stream ended before a finish reason.");
}

function* googlePayloadEvents(value: unknown, completeResponse: boolean): Generator<ModelStreamEvent, void, void> {
  if (!isRecord(value)) return;
  if (isRecord(value.error)) throw new Error(`Google Generative AI provider returned an error: ${readString(value.error.message) ?? "unknown error"}`);
  const candidate = Array.isArray(value.candidates) && isRecord(value.candidates[0]) ? value.candidates[0] : undefined;
  const content = candidate && isRecord(candidate.content) ? candidate.content : undefined;
  const parts = content && Array.isArray(content.parts) ? content.parts : [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    const text = readString(part.text);
    if (text) {
      yield part.thought === true
        ? { type: "reasoning-delta", id: "reasoning-0", text }
        : { type: "text-delta", text };
    }
    if (isRecord(part.functionCall)) {
      yield {
        type: "tool-call",
        id: readString(part.functionCall.id) ?? randomToolCallId(),
        name: readString(part.functionCall.name) ?? "unknown",
        arguments: isRecord(part.functionCall.args) ? part.functionCall.args : {},
        invalid: !isRecord(part.functionCall.args)
      };
    }
  }
  const finishReason = readString(candidate?.finishReason);
  const usage = isRecord(value.usageMetadata) ? value.usageMetadata : undefined;
  if (finishReason || (completeResponse && usage)) {
    yield {
      type: "finish",
      reason: mapGoogleStopReason(finishReason),
      usage: usage ? {
        inputTokens: readNumber(usage.promptTokenCount) ?? readNumber(usage.prompt_token_count) ?? readNumber(usage.prompt_tokens),
        outputTokens: readNumber(usage.candidatesTokenCount) ?? readNumber(usage.candidates_token_count) ?? readNumber(usage.candidates_tokens),
        totalTokens: readNumber(usage.totalTokenCount) ?? readNumber(usage.total_token_count) ?? readNumber(usage.total_tokens),
        cacheReadTokens: googleCachedTokens(usage),
        cacheMissTokens: googleCacheMissTokens(usage)
      } : undefined
    };
  }
}

function googleCacheMissTokens(usage: Record<string, unknown>): number | undefined {
  const inputTokens = readNumber(usage.promptTokenCount) ?? readNumber(usage.prompt_token_count) ?? readNumber(usage.prompt_tokens);
  const cachedTokens = googleCachedTokens(usage);
  if (inputTokens === undefined || cachedTokens === undefined) return undefined;
  return Math.max(0, inputTokens - cachedTokens);
}

function googleCachedTokens(usage: Record<string, unknown>): number | undefined {
  return readNumber(usage.total_cached_tokens)
    ?? readNumber(usage.cachedContentTokenCount)
    ?? readNumber(usage.cached_content_token_count);
}

function googleMessage(message: AgentMessage): unknown {
  if (message.role === "user") return { role: "user", parts: googleUserParts(message.content) };
  if (message.role === "assistant") {
    return {
      role: "model",
      parts: message.content.flatMap((part): unknown[] => {
        if (part.type === "text") return [{ text: part.text }];
        if (part.type === "reasoning") return [{ text: part.text, thought: true }];
        return [{ functionCall: { id: part.id, name: part.name, args: part.arguments } }];
      })
    };
  }
  return {
    role: "user",
    parts: [{
      functionResponse: {
        id: message.toolCallId,
        name: message.toolName,
        response: { output: message.content.map((part) => part.type === "text" ? part.text : `[${part.mimeType} image]`).join("\n"), isError: message.isError }
      }
    }]
  };
}

function googleUserParts(content: AgentUserMessage["content"]): unknown[] {
  if (typeof content === "string") return [{ text: content }];
  return content.map((part) => part.type === "text"
    ? { text: part.text }
    : { inlineData: { mimeType: part.mimeType, data: part.data } });
}

function googleTool(tool: AgentTool): unknown {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

function googleThinking(
  reasoning: ModelStreamOptions["reasoning"],
  providerOptions: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const google = isRecord(providerOptions?.google) ? providerOptions.google : undefined;
  const configuredBudget = readNumber(google?.thinkingBudget);
  const configuredIncludeThoughts = typeof google?.includeThoughts === "boolean" ? google.includeThoughts : undefined;
  if (configuredBudget !== undefined || configuredIncludeThoughts !== undefined) {
    return {
      thinkingBudget: configuredBudget,
      includeThoughts: configuredIncludeThoughts
    };
  }
  if (reasoning === undefined) return undefined;
  if (reasoning === "off") return { thinkingBudget: 0, includeThoughts: false };
  const budgets = { minimal: 512, low: 1_024, medium: 4_096, high: 8_192, xhigh: 16_384, max: 24_576 };
  return { thinkingBudget: budgets[reasoning], includeThoughts: true };
}

function mapGoogleStopReason(reason: string | undefined): "stop" | "tool-calls" | "length" | "error" | "other" {
  if (!reason || reason === "STOP") return "stop";
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "MALFORMED_FUNCTION_CALL" || reason === "SAFETY" || reason === "RECITATION") return "error";
  return "other";
}

function requestSignal(options: ModelStreamOptions): AbortSignal | undefined {
  const timeout = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
  return options.signal && timeout ? AbortSignal.any([options.signal, timeout]) : options.signal ?? timeout;
}
