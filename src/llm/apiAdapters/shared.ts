/**
 * API Adapter 共用的消息转换、SSE 解码与错误归一化。
 */
import type {
  AgentAssistantMessage,
  AgentTool,
  AgentToolCallContent,
  AgentUserMessage,
  AgentUsage,
  ModelStreamContext,
  ModelStreamOptions
} from "../../agent/core/types.js";
import type { ApiAdapterRequest } from "../ApiAdapterRegistry.js";
import type { PromptCacheCapability } from "../promptCache.js";
import { CLAUDE_SUBSCRIPTION_BETA } from "../subscriptionAuth.js";

export const contextOverflowMarker = "[context_overflow]";
export const contextOverflowPattern = /context[_ -]?length|maximum context|context window|too many (?:input )?tokens|prompt (?:is )?too long|input.{0,40}tokens.{0,40}exceed|request too large/iu;

export function openAiMessages(
  context: ModelStreamContext,
  supportsDeveloperRole: boolean,
  reasoningProtocol: ApiAdapterRequest["reasoningProtocol"]
): unknown[] {
  const messages: unknown[] = [];
  if (context.systemPrompt) messages.push({ role: supportsDeveloperRole ? "developer" : "system", content: context.systemPrompt });
  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: openAiUserContent(message.content) });
    } else if (message.role === "assistant") {
      const calls = message.content.filter((part): part is AgentToolCallContent => part.type === "toolCall");
      const toolCalls = calls.length
        ? calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }))
        : undefined;
      const text = textContent(message.content);
      const reasoning = reasoningContent(message.content);
      // reasoning-only 或空 assistant 不是 Chat Completions 的合法历史消息；它们通常来自
      // 被中断的输出或回放时丢弃了无签名 reasoning 的旧 session。tool call-only assistant 仍要保留。
      if (!text && toolCalls === undefined) continue;
      messages.push({
        role: "assistant",
        content: text ?? undefined,
        reasoning_content: reasoning && reasoningProtocol !== "openai" && reasoningProtocol !== "anthropic" ? reasoning : undefined,
        tool_calls: toolCalls
      });
    } else {
      messages.push({ role: "tool", tool_call_id: message.toolCallId, content: resultText(message.content) });
    }
  }
  return messages;
}

export function anthropicMessages(context: ModelStreamContext): unknown[] {
  const messages: unknown[] = [];
  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: anthropicUserContent(message.content) });
    } else if (message.role === "assistant") {
      const content = message.content.flatMap((part): unknown[] => {
        if (part.type === "text") return [{ type: "text", text: part.text }];
        if (part.type === "reasoning") {
          const signature = anthropicReasoningSignature(part.providerMetadata);
          return signature ? [{ type: "thinking", thinking: part.text, signature }] : [];
        }
        return [{ type: "tool_use", id: part.id, name: part.name, input: part.arguments }];
      });
      // 与 OpenAI 路径对齐：空 assistant（被中断的输出、回放丢弃了无签名 reasoning 的旧
      // session）会产出 content: []，Anthropic 对空 content 直接 400，必须跳过。
      if (!content.length) continue;
      messages.push({ role: "assistant", content });
    } else {
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: resultText(message.content), is_error: message.isError === true }] });
    }
  }
  return messages;
}

export function openAiTool(tool: AgentTool): unknown {
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

export function anthropicTool(tool: AgentTool): unknown {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters };
}

export function responsesTool(tool: AgentTool): unknown {
  return { type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false };
}

export function responsesInput(context: ModelStreamContext): unknown[] {
  const input: unknown[] = [];
  for (const message of context.messages) {
    if (message.role === "user") {
      input.push({ role: "user", content: responsesUserContent(message.content) });
    } else if (message.role === "assistant") {
      const text = textContent(message.content);
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const call of message.content.filter((part): part is AgentToolCallContent => part.type === "toolCall")) {
        input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
      }
    } else {
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: resultText(message.content) });
    }
  }
  return input;
}

export function responsesUserContent(content: AgentUserMessage["content"]): unknown {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  return content.map((part) => {
    if (part.type === "text") return { type: "input_text", text: part.text };
    if (part.type === "audio") return { type: "input_audio", input_audio: { data: part.data, format: audioFormat(part.mimeType) } };
    return { type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` };
  });
}

export function openAiUserContent(content: AgentUserMessage["content"]): unknown {
  if (typeof content === "string") return content;
  if (content.length > 0 && content.every((part) => part.type === "text")) return content.map((part) => part.text).join("");
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "audio") return { type: "input_audio", input_audio: { data: part.data, format: audioFormat(part.mimeType) } };
    return { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } };
  });
}

export function anthropicUserContent(content: AgentUserMessage["content"]): unknown {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "audio") throw new Error("Anthropic Messages transport does not support audio input.");
    return { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } };
  });
}

export function audioFormat(mimeType: string): "mp3" | "wav" {
  if (mimeType === "audio/mpeg" || mimeType === "audio/mp3") return "mp3";
  if (mimeType === "audio/wav" || mimeType === "audio/x-wav") return "wav";
  throw new Error(`Unsupported audio input type: ${mimeType}. Use audio/mpeg or audio/wav.`);
}

export function anthropicReasoningMetadata(signature: string | undefined): Record<string, unknown> | undefined {
  return signature ? { anthropic: { signature } } : undefined;
}

export function anthropicReasoningSignature(providerMetadata: Record<string, unknown> | undefined): string | undefined {
  const anthropic = isRecord(providerMetadata?.anthropic) ? providerMetadata.anthropic : undefined;
  return readString(anthropic?.signature);
}

export function textContent(content: AgentAssistantMessage["content"]): string | null {
  const text = content.filter((part) => part.type === "text").map((part) => part.text).join("");
  return text || null;
}

export function reasoningContent(content: AgentAssistantMessage["content"]): string | null {
  const text = content.filter((part) => part.type === "reasoning").map((part) => part.text).join("");
  return text || null;
}

export function resultText(content: AgentToolResultContentLike[]): string {
  return content.map((part) => part.type === "text" ? part.text : `[${part.mimeType} image]`).join("\n");
}

type AgentToolResultContentLike = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export function applyOpenAiReasoning(body: Record<string, unknown>, config: ApiAdapterRequest, options: ModelStreamOptions): void {
  const configured = isRecord(options.providerOptions) ? options.providerOptions : config.providerOptions;
  const openai = isRecord(configured?.openai) ? configured.openai : undefined;
  const deepseek = isRecord(configured?.deepseek) ? configured.deepseek : undefined;
  const effort = readString(openai?.reasoningEffort);
  if (effort && effort !== "none") body.reasoning_effort = effort;
  const deepseekEffort = readString(deepseek?.reasoningEffort);
  if (deepseekEffort) body.reasoning_effort = deepseekEffort;
  const google = isRecord(configured?.google) ? configured.google : undefined;
  const googleEffort = readString(google?.reasoningEffort);
  if (config.reasoningProtocol === "google" && googleEffort && googleEffort !== "none") body.reasoning_effort = googleEffort;
  if (isRecord(deepseek?.thinking)) body.thinking = deepseek.thinking;
  if (config.reasoningProtocol === "deepseek" && options.reasoning === "off") body.thinking = { type: "disabled" };
  applyAlibabaThinking(body, configured);
  if (config.reasoningProtocol === "moonshotai") {
    const moonshot = isRecord(configured?.moonshotai) ? configured.moonshotai : undefined;
    const configuredEffort = readString(moonshot?.reasoningEffort);
    if (!configuredEffort) {
      applyMoonshotThinking(body, configured);
      return;
    }
    const fallbackEffort = options.reasoning && options.reasoning !== "off" ? options.reasoning : undefined;
    const effort = normalizeKimiReasoningEffort(configuredEffort ?? fallbackEffort);
    if (effort) body.reasoning_effort = effort;
    return;
  }
  applyMoonshotThinking(body, configured);
}

export function normalizeKimiReasoningEffort(value: string | undefined): "low" | "high" | "max" | undefined {
  if (value === "low" || value === "minimal" || value === "medium") return "low";
  if (value === "high") return "high";
  if (value === "max" || value === "xhigh") return "max";
  return undefined;
}

export function applyAnthropicThinking(body: Record<string, unknown>, config: ApiAdapterRequest, options: ModelStreamOptions): void {
  const configured = isRecord(options.providerOptions) ? options.providerOptions : config.providerOptions;
  const anthropic = isRecord(configured?.anthropic) ? configured.anthropic : undefined;
  if (isRecord(anthropic?.thinking) && anthropic.thinking.type === "enabled") {
    const budgetTokens = readNumber(anthropic.thinking.budgetTokens) ?? readNumber(anthropic.thinking.budget_tokens);
    body.thinking = {
      type: "enabled",
      ...(budgetTokens === undefined ? {} : { budget_tokens: budgetTokens })
    };
    const maxTokens = readNumber(body.max_tokens);
    if (budgetTokens !== undefined && maxTokens !== undefined && maxTokens <= budgetTokens) {
      body.max_tokens = budgetTokens + 1_024;
    }
  }
}

export function applyAlibabaThinking(body: Record<string, unknown>, configured: Record<string, unknown> | undefined): void {
  const alibaba = isRecord(configured?.alibaba) ? configured.alibaba : undefined;
  if (!alibaba) return;
  const enabled = typeof alibaba.enableThinking === "boolean"
    ? alibaba.enableThinking
    : typeof alibaba.enable_thinking === "boolean"
      ? alibaba.enable_thinking
      : undefined;
  if (enabled !== undefined) body.enable_thinking = enabled;
  const budget = readNumber(alibaba.thinkingBudget) ?? readNumber(alibaba.thinking_budget);
  if (budget !== undefined) body.thinking_budget = budget;
}

export function applyMoonshotThinking(body: Record<string, unknown>, configured: Record<string, unknown> | undefined): void {
  const moonshot = isRecord(configured?.moonshotai) ? configured.moonshotai : undefined;
  const thinking = isRecord(moonshot?.thinking) ? moonshot.thinking : undefined;
  if (!thinking) return;
  const type = readString(thinking.type);
  const budgetTokens = readNumber(thinking.budgetTokens) ?? readNumber(thinking.budget_tokens);
  body.thinking = {
    ...(type ? { type } : {}),
    ...(budgetTokens === undefined ? {} : { budget_tokens: budgetTokens })
  };
}

export function applyResponsesReasoning(body: Record<string, unknown>, config: ApiAdapterRequest, options: ModelStreamOptions): void {
  const configured = isRecord(options.providerOptions) ? options.providerOptions : config.providerOptions;
  const openai = isRecord(configured?.openai) ? configured.openai : undefined;
  const effort = readString(openai?.reasoningEffort);
  if (effort && effort !== "none") body.reasoning = { effort };
  if (config.reasoningProtocol === "openai" && options.reasoning && options.reasoning !== "off" && !effort) {
    body.reasoning = { effort: options.reasoning === "xhigh" ? "high" : options.reasoning };
  }
}

export function requestHeaders(config: ApiAdapterRequest, protocol: "openai" | "responses" | "anthropic"): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream", ...config.headers };
  if (config.apiKey) {
    if (protocol === "anthropic" && config.anthropicAuthMode !== "bearer") headers["x-api-key"] = config.apiKey;
    else headers.authorization = `Bearer ${config.apiKey}`;
  }
  if (protocol === "anthropic") {
    headers["anthropic-version"] ??= "2023-06-01";
    if (config.provider === "claude-subscription") {
      headers["anthropic-beta"] ??= CLAUDE_SUBSCRIPTION_BETA;
      headers["anthropic-dangerous-direct-browser-access"] ??= "true";
      headers["x-app"] ??= "cli";
      headers["User-Agent"] ??= "claude-cli/2.1.153 (external, cli)";
    }
  }
  return headers;
}

export function resolveEndpoint(baseUrl: string, suffix: string): string {
  const normalized = baseUrl.replace(/\/+$/u, "");
  if (normalized.endsWith(`/${suffix}`)) return normalized;
  if (suffix.startsWith("v1/") && normalized.endsWith("/v1")) return `${normalized}/${suffix.slice(3)}`;
  return `${normalized}/${suffix}`;
}

export function requestSignal(options: ModelStreamOptions): AbortSignal | undefined {
  if (options.timeoutMs === undefined || options.timeoutMs <= 0) return options.signal;
  const timeout = AbortSignal.timeout(options.timeoutMs);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

export async function providerHttpError(response: Response, provider: string): Promise<Error> {
  const body = await response.text().catch(() => "");
  const detail = `${provider} request failed (${String(response.status)}): ${body.slice(0, 2_000)}`;
  return new Error(response.status === 413 || contextOverflowPattern.test(body)
    ? `${contextOverflowMarker} ${detail}`
    : detail);
}

/** 网络层没有 HTTP 响应时保留域名和底层错误码，方便区分代理、DNS、TLS 与服务端拒绝。 */
export function providerNetworkError(error: unknown, provider: string, endpoint: string): Error {
  const cause = error instanceof Error && "cause" in error
    ? (error as Error & { cause?: unknown }).cause
    : undefined;
  const code = cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;
  const detail = cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
  return new Error(`${provider} network request failed (${new URL(endpoint).hostname}${code ? `, ${code}` : ""}): ${detail}`, { cause: error });
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      const blocks = buffer.split(/\r?\n\r?\n/u);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = parseSseBlock(block);
        if (event) yield event;
      }
      if (chunk.done) {
        const event = parseSseBlock(buffer);
        if (event) yield event;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function parseSseBlock(block: string): { event?: string; data: string } | undefined {
  const data: string[] = [];
  let event: string | undefined;
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length ? { event, data: data.join("\n") } : undefined;
}

export function parseJson(value: string, label: string): Record<string, any> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(`${label} contained invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function throwPayloadError(payload: Record<string, any>, provider: string): void {
  if (payload.error === undefined && payload.type !== "error") return;
  throw new Error(providerPayloadError(payload, provider));
}

export function providerPayloadError(payload: Record<string, any>, provider: string): string {
  const error = isRecord(payload.error) ? payload.error : payload;
  const message = readString(error.message) ?? readString(error.detail) ?? readString(error.type);
  return `${provider} returned an error: ${message ?? JSON.stringify(error).slice(0, 2_000)}`;
}

export function parseToolArguments(value: string): { args: Record<string, unknown>; invalid: boolean } {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    return isRecord(parsed) ? { args: parsed, invalid: false } : { args: {}, invalid: true };
  } catch {
    return { args: {}, invalid: true };
  }
}

export function parseToolArgumentsValue(value: unknown): { args: Record<string, unknown>; invalid: boolean } {
  if (isRecord(value)) return { args: value, invalid: false };
  return parseToolArguments(readString(value) ?? "{}");
}

export function mapOpenAiStopReason(reason: string | undefined): AgentModelFinishReason {
  if (reason === "tool_calls" || reason === "function_call") return "tool-calls";
  if (reason === "length") return "length";
  if (reason === "stop") return "stop";
  return reason ? "other" : "stop";
}

export function mapAnthropicStopReason(reason: string | undefined): AgentModelFinishReason {
  if (reason === "tool_use") return "tool-calls";
  if (reason === "max_tokens") return "length";
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  return reason ? "other" : "stop";
}

export function mapResponsesStopReason(status: unknown, incompleteDetails: unknown): AgentModelFinishReason {
  if (status === "completed") return "stop";
  if (status === "incomplete") {
    const reason = isRecord(incompleteDetails) ? readString(incompleteDetails.reason) : undefined;
    return reason === "max_output_tokens" ? "length" : "other";
  }
  return status ? "other" : "stop";
}

export type AgentModelFinishReason = "stop" | "tool-calls" | "length" | "error" | "aborted" | "other";

export function mapOpenAiUsage(value: Record<string, any>, cacheCapability?: PromptCacheCapability): AgentUsage {
  const promptDetails = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  const inputTokens = readNumber(value.prompt_tokens);
  const cacheReadTokens = readNumber(promptDetails.cached_tokens)
    ?? readNumber(promptDetails.cache_read_tokens)
    ?? readNumber(value.cached_tokens)
    ?? readNumber(value.prompt_cache_hit_tokens)
    ?? readNumber(value.cache_read_input_tokens);
  const cacheWriteTokens = readNumber(promptDetails.cache_write_tokens)
    ?? readNumber(promptDetails.cache_creation_tokens)
    ?? readNumber(value.prompt_cache_write_tokens)
    ?? readNumber(value.cache_write_input_tokens);
  const explicitCacheMissTokens = readNumber(promptDetails.cache_miss_tokens)
    ?? readNumber(value.prompt_cache_miss_tokens)
    ?? readNumber(value.cache_miss_input_tokens);
  return {
    inputTokens,
    outputTokens: readNumber(value.completion_tokens),
    totalTokens: readNumber(value.total_tokens),
    reasoningTokens: isRecord(value.completion_tokens_details) ? readNumber(value.completion_tokens_details.reasoning_tokens) : undefined,
    cacheReadTokens,
    cacheWriteTokens,
    cacheMissTokens: explicitCacheMissTokens
      ?? (cacheCapability?.fullInputIncludesCachedTokens === true
        ? derivedCacheMissTokens(inputTokens, cacheReadTokens, cacheWriteTokens)
        : undefined)
  };
}

export function mapResponsesUsage(value: Record<string, any>, cacheCapability?: PromptCacheCapability): AgentUsage {
  const inputTokens = readNumber(value.input_tokens);
  const outputTokens = readNumber(value.output_tokens);
  const totalTokens = readNumber(value.total_tokens) ?? sumUsage({ inputTokens }, outputTokens);
  const outputDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : {};
  const inputDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : {};
  const cacheReadTokens = readNumber(inputDetails.cached_tokens)
    ?? readNumber(inputDetails.cache_read_tokens)
    ?? readNumber(value.prompt_cache_hit_tokens)
    ?? readNumber(value.cache_read_input_tokens);
  const cacheWriteTokens = readNumber(inputDetails.cache_write_tokens)
    ?? readNumber(inputDetails.cache_creation_tokens)
    ?? readNumber(value.prompt_cache_write_tokens)
    ?? readNumber(value.cache_write_input_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens: readNumber(outputDetails.reasoning_tokens),
    cacheReadTokens,
    cacheWriteTokens,
    cacheMissTokens: readNumber(inputDetails.cache_miss_tokens)
      ?? readNumber(value.prompt_cache_miss_tokens)
      ?? readNumber(value.cache_miss_input_tokens)
      ?? (cacheCapability?.fullInputIncludesCachedTokens === true
        ? derivedCacheMissTokens(inputTokens, cacheReadTokens, cacheWriteTokens)
        : undefined)
  };
}

/** 将 Anthropic 的未缓存输入与缓存读写输入归一化为 Biny 的完整 inputTokens。 */
export function mapAnthropicUsage(value: Record<string, any>): AgentUsage {
  const uncachedInputTokens = readNumber(value.input_tokens);
  const cacheReadTokens = readNumber(value.cache_read_input_tokens);
  const cacheWriteTokens = readNumber(value.cache_creation_input_tokens);
  const inputParts = [uncachedInputTokens, cacheReadTokens, cacheWriteTokens]
    .filter((token): token is number => token !== undefined);
  const inputTokens = inputParts.length ? inputParts.reduce((total, token) => total + token, 0) : undefined;
  const outputTokens = readNumber(value.output_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: readNumber(value.total_tokens) ?? sumUsage({ inputTokens }, outputTokens),
    cacheReadTokens,
    cacheWriteTokens,
    cacheMissTokens: uncachedInputTokens
  };
}

function derivedCacheMissTokens(
  inputTokens: number | undefined,
  cacheReadTokens: number | undefined,
  cacheWriteTokens: number | undefined
): number | undefined {
  if (inputTokens === undefined || cacheReadTokens === undefined) return undefined;
  return Math.max(0, inputTokens - cacheReadTokens - (cacheWriteTokens ?? 0));
}

export function sumUsage(usage: AgentUsage | undefined, outputTokens: number | undefined): number | undefined {
  if (usage?.inputTokens === undefined || outputTokens === undefined) return undefined;
  return usage.inputTokens + outputTokens;
}

export function removeUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function firstRecord(value: unknown): { value: Record<string, any> } | undefined {
  if (!Array.isArray(value)) return undefined;
  const item = value[0];
  return isRecord(item) ? { value: item } : undefined;
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function readText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((part) => isRecord(part) && typeof part.text === "string" ? [part.text] : []).join("");
  return text || undefined;
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function randomToolCallId(): string {
  return `tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
