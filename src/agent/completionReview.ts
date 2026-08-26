/**
 * Agent 语义完成复核。
 *
 * 运行时 Gate 只判断工具和终态事实；这里单独调用一个无工具模型，让它根据任务和最近
 * 上下文判断是否有明确的完成证据。复核结果不能替代文件、测试或工具事实，只能决定是否
 * 继续把同一个任务交回工作模型。
 */
import type {
  AgentAssistantMessage,
  AgentMessage,
  AgentModel,
  AgentToolResultMessage,
  AgentUserMessage,
  ModelRequestContext,
  ModelRequestObserver
} from "./core/types.js";
import { redactSecrets } from "../utils/secrets.js";

const completionReviewOutputLimit = 1_024;
const completionReviewContextLimit = 24_000;
const completionReviewReasonLimit = 500;

const completionReviewSystemPrompt = `You are an external completion judge for a local coding agent.

Respond ONLY with valid JSON in this exact shape:
{"met": boolean, "impossible": boolean, "progress": boolean, "reason": "one concise sentence"}

Rules:
- met is true ONLY when the full user task has clear, concrete evidence of completion.
- Do not treat the model saying "done", a provider stop, an intention, or a partial change as proof.
- Match the verification scope to the user's requested scope; do not accept a narrower substitute.
- impossible is true only when the task is genuinely unachievable, not merely difficult.
- progress is true only when the latest work measurably moved toward the full task.
- When uncertain, use met=false and impossible=false.`;

export interface CompletionReviewInput {
  model: AgentModel;
  task: string;
  messages: readonly AgentMessage[];
  signal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
  timeoutMs?: number;
  onRequestMetrics?: ModelRequestObserver;
  requestContext?: ModelRequestContext;
}

export interface CompletionReviewResult {
  met: boolean;
  impossible: boolean;
  progress: boolean;
  evaluatorFailed: boolean;
  reason: string;
}

export async function evaluateCompletion(input: CompletionReviewInput): Promise<CompletionReviewResult> {
  input.signal?.throwIfAborted();
  const streamModel = input.model.streamSimple?.bind(input.model) ?? input.model.stream.bind(input.model);
  let raw = "";
  let finishReason: string | undefined;
  let toolCallSeen = false;
  try {
    const stream = await streamModel(
      {
        systemPrompt: completionReviewSystemPrompt,
        messages: [{ role: "user", content: buildCompletionReviewPrompt(input.task, input.messages) }],
        tools: []
      },
      {
        signal: input.signal,
        maxOutputTokens: completionReviewOutputLimit,
        reasoning: "off",
        providerOptions: input.providerOptions,
        timeoutMs: input.timeoutMs,
        onRequestMetrics: input.onRequestMetrics,
        requestContext: input.requestContext
      }
    );
    for await (const event of stream) {
      input.signal?.throwIfAborted();
      if (event.type === "text-delta") raw += event.text;
      else if (event.type === "tool-call") toolCallSeen = true;
      else if (event.type === "finish") finishReason = event.reason;
      else if (event.type === "error") throw event.error;
    }
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return evaluatorFailure(`Completion evaluator failed: ${safeReason(errorMessage(error))}`);
  }
  if (toolCallSeen) return evaluatorFailure("Completion evaluator attempted to use a tool.");
  if (finishReason !== "stop") {
    return evaluatorFailure(
      finishReason === undefined
        ? "Completion evaluator ended without a terminal response."
        : `Completion evaluator ended with ${finishReason}.`
    );
  }
  return parseCompletionReview(raw);
}

export function buildCompletionReviewPrompt(task: string, messages: readonly AgentMessage[]): string {
  const context = messages
    .slice(-40)
    .map(renderMessage)
    .filter(Boolean)
    .join("\n\n");
  return [
    "--- USER TASK ---",
    redactSecrets(task).slice(0, 4_000),
    "",
    "--- RECENT AGENT CONTEXT ---",
    redactSecrets(context).slice(-completionReviewContextLimit),
    "",
    "--- JUDGMENT (JSON ONLY) ---"
  ].join("\n");
}

export function parseCompletionReview(raw: string): CompletionReviewResult {
  const match = raw.match(/\{[\s\S]*\}/u);
  if (!match) return evaluatorFailure("Completion evaluator produced no JSON judgment.");
  try {
    const value: unknown = JSON.parse(match[0]);
    if (!isRecord(value)
      || typeof value.met !== "boolean"
      || typeof value.impossible !== "boolean"
      || typeof value.progress !== "boolean"
      || typeof value.reason !== "string"
    ) return evaluatorFailure("Completion evaluator returned an invalid judgment shape.");
    return {
      met: value.met,
      impossible: value.impossible,
      progress: value.progress,
      evaluatorFailed: false,
      reason: safeReason(value.reason)
    };
  } catch {
    return evaluatorFailure("Completion evaluator returned invalid JSON.");
  }
}

function renderMessage(message: AgentMessage): string {
  if (message.role === "user") return `USER: ${renderUserContent(message)}`;
  if (message.role === "assistant") return `ASSISTANT: ${renderAssistantContent(message)}`;
  return `TOOL_RESULT (${message.toolName}): ${renderToolResultContent(message)}`;
}

function renderUserContent(message: AgentUserMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.type === "text" ? part.text : `[${part.type}]`).join("\n");
}

function renderAssistantContent(message: AgentAssistantMessage): string {
  return message.content.map((part) => {
    if (part.type === "text" || part.type === "reasoning") return part.text;
    return `[tool call ${part.name}] ${safeJson(part.arguments)}`;
  }).join("\n");
}

function renderToolResultContent(message: AgentToolResultMessage): string {
  return message.content.map((part) => part.type === "text" ? part.text : `[${part.type}]`).join("\n");
}

function evaluatorFailure(reason: string): CompletionReviewResult {
  return {
    met: false,
    impossible: false,
    progress: false,
    evaluatorFailed: true,
    reason: safeReason(reason)
  };
}

function safeReason(value: string): string {
  return redactSecrets(value).replace(/\s+/gu, " ").trim().slice(0, completionReviewReasonLimit)
    || "No completion judgment was provided.";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable arguments]";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
