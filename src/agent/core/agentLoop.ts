/**
 * Biny 自有的 Agent Loop。
 *
 * Provider 只负责输出归一化的 ModelStreamEvent；工具由 Loop 显式校验和执行，
 * 不再把多步控制权交给模型 SDK。这样权限、预算和审计都有明确的介入点，
 * 普通回合在模型自然停止且没有 follow-up 时直接结束。
 */
import { AsyncEventQueue } from "../../runtime/AsyncEventQueue.js";
import { validateJsonSchema } from "../../tools/schema.js";
import type {
  AgentAssistantMessage,
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentLoopTurnContext,
  AgentMessage,
  ModelStreamEvent,
  AgentToolCallContent,
  AgentToolResult,
  AgentToolResultMessage
} from "./types.js";

export async function* agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal
): AsyncGenerator<AgentEvent, AgentMessage[], void> {
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
    tools: [...config.tools]
  };
  const newMessages = [...prompts];
  yield { type: "agent_start" };
  for (const prompt of prompts) {
    yield { type: "message_start", message: prompt };
    yield { type: "message_end", message: prompt };
  }
  for await (const event of runLoop(currentContext, newMessages, config, signal)) yield event;
  yield { type: "agent_end", messages: newMessages, contextMessages: [...currentContext.messages] };
  return newMessages;
}

export async function* agentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal
): AsyncGenerator<AgentEvent, AgentMessage[], void> {
  if (!context.messages.length) throw new Error("Cannot continue an empty agent context.");
  const last = context.messages.at(-1);
  if (last?.role === "assistant") throw new Error("Cannot continue from an assistant message.");
  const currentContext: AgentContext = { ...context, messages: [...context.messages], tools: [...config.tools] };
  const newMessages: AgentMessage[] = [];
  yield { type: "agent_start" };
  for await (const event of runLoop(currentContext, newMessages, config, signal)) yield event;
  yield { type: "agent_end", messages: newMessages, contextMessages: [...currentContext.messages] };
  return newMessages;
}

async function* runLoop(
  context: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined
): AsyncGenerator<AgentEvent, void, void> {
  let steps = 0;
  let pendingMessages = await config.getSteeringMessages?.() ?? [];

  while (true) {
    let hasMoreToolCalls = true;
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      signal?.throwIfAborted();
      if (steps >= config.maxSteps) {
        yield {
          type: "error",
          error: `Agent reached its ${String(config.maxSteps)}-step limit.`,
          fatal: false,
          reason: "step_limit"
        };
        return;
      }
      yield { type: "turn_start" };

      for (const message of pendingMessages) {
        context.messages.push(message);
        newMessages.push(message);
        yield { type: "message_start", message };
        yield { type: "message_end", message };
      }
      pendingMessages = [];

      const assistantStream = streamAssistant(context, config, signal);
      let assistantNext = await assistantStream.next();
      while (!assistantNext.done) {
        // Provider 的每个分片在这里立即交给宿主；不能等完整 assistant
        // message 结束后再批量 yield，否则上层只能看到“伪流式”输出。
        yield assistantNext.value;
        assistantNext = await assistantStream.next();
      }
      const assistant = assistantNext.value;
      context.messages.push(assistant);
      newMessages.push(assistant);
      steps += 1;

      if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
        yield { type: "turn_end", message: assistant, toolResults: [], messages: [...context.messages] };
        return;
      }

      const calls = assistant.content.filter((part): part is AgentToolCallContent => part.type === "toolCall");
      let toolResults: AgentToolResultMessage[] = [];
      let fatalToolError = false;
      hasMoreToolCalls = calls.length > 0;
      if (calls.length > 0) {
        const truncated = assistant.stopReason === "length";
        const toolBatch = await executeToolCalls(context, assistant, calls, config, signal, truncated);
        toolResults = toolBatch.messages;
        yield* toolBatch.events;
        fatalToolError = toolBatch.events.some((event) => event.type === "error" && event.fatal);
        for (const result of toolResults) {
          context.messages.push(result);
          newMessages.push(result);
        }
        hasMoreToolCalls = !toolBatch.terminate;
      }

      yield { type: "turn_end", message: assistant, toolResults, messages: [...context.messages] };
      if (fatalToolError) return;
      const turnContext: AgentLoopTurnContext = { message: assistant, toolResults, context, newMessages };
      const nextTurn = await config.prepareNextTurn?.(turnContext);
      if (nextTurn) {
        context = nextTurn.context ?? context;
        if (nextTurn.tools) context.tools = [...nextTurn.tools];
        config = {
          ...config,
          model: nextTurn.model ?? config.model,
          modelOptions: nextTurn.modelOptions ?? config.modelOptions,
          tools: nextTurn.tools ?? config.tools
        };
      }
      const effectiveTurnContext: AgentLoopTurnContext = { ...turnContext, context };
      if (await config.shouldStopAfterTurn?.(effectiveTurnContext)) return;
      pendingMessages = await config.getSteeringMessages?.() ?? [];
    }

    const followUpMessages = await config.getFollowUpMessages?.() ?? [];
    if (!followUpMessages.length) return;
    pendingMessages = followUpMessages;
  }
}

async function* streamAssistant(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): AsyncGenerator<AgentEvent, AgentAssistantMessage, void> {
  let text = "";
  const reasoning = new Map<string, { text: string; providerMetadata?: Record<string, unknown> }>();
  const toolCalls: AgentToolCallContent[] = [];
  let stopReason: AgentAssistantMessage["stopReason"] = "stop";
  let usage: AgentAssistantMessage["usage"];
  const assistant: AgentAssistantMessage = { role: "assistant", content: [] };
  yield { type: "message_start", message: assistant };
  while (true) {
    try {
      const messages = config.transformContext
        ? await config.transformContext(context.messages, signal)
        : context.messages;
      const streamModel = config.model.streamSimple?.bind(config.model) ?? config.model.stream.bind(config.model);
      // Provider 通常会响应 AbortSignal，但第三方实现可能卡在下一次 next()。
      // 这里同时中断“拿到流”和“读取下一段流”，避免取消被 provider 的协作程度绑住。
      const streamPromise = streamModel({ ...context, messages, tools: context.tools }, { ...config.modelOptions, signal });
      let stream: AsyncIterable<ModelStreamEvent>;
      try {
        stream = await waitForAbort(streamPromise, signal);
      } catch (error) {
        // Abort 可能先于 provider 返回流对象。流稍后到达时也要尽力关闭，否则底层请求会继续占用连接和额度。
        if (signal?.aborted) closeAsyncIterableWhenReady(streamPromise);
        throw error;
      }
      let receivedFinish = false;
      for await (const event of streamWithAbort(stream, signal)) {
        signal?.throwIfAborted();
        if (event.type === "text-delta") {
          text += event.text;
        } else if (event.type === "reasoning-start") {
          reasoning.set(event.id, { text: "", providerMetadata: event.providerMetadata });
        } else if (event.type === "reasoning-delta") {
          const block = reasoning.get(event.id) ?? { text: "" };
          block.text += event.text;
          block.providerMetadata = event.providerMetadata ?? block.providerMetadata;
          reasoning.set(event.id, block);
        } else if (event.type === "tool-call") {
          toolCalls.push({ type: "toolCall", id: event.id, name: event.name, arguments: event.arguments, invalid: event.invalid });
        } else if (event.type === "finish") {
          stopReason = event.reason;
          usage = event.usage;
          receivedFinish = true;
        } else if (event.type === "error") {
          throw event.error;
        }
        if (event.type !== "start" && event.type !== "finish") {
          yield { type: "message_update", message: snapshotAssistant(text, reasoning, toolCalls, assistant), event };
        }
      }
      if (!receivedFinish) throw new Error("Model stream ended without a finish event.");
      break;
    } catch (error) {
      const message = errorMessage(error);
      const canRecover = !signal?.aborted && !text && reasoning.size === 0 && toolCalls.length === 0;
      const recovery = canRecover ? await config.recoverFromModelError?.(message, context, signal) : undefined;
      if (recovery) {
        yield { type: "model_retry", ...recovery };
        continue;
      }
      stopReason = signal?.aborted ? "aborted" : "error";
      assistant.errorMessage = message;
      yield { type: "error", error: message, fatal: !signal?.aborted };
      break;
    }
  }

  const duplicateToolCallIds = new Set<string>();
  const seenToolCallIds = new Set<string>();
  for (const call of toolCalls) {
    if (seenToolCallIds.has(call.id)) duplicateToolCallIds.add(call.id);
    seenToolCallIds.add(call.id);
  }
  if (duplicateToolCallIds.size > 0) {
    const message = `Duplicate tool call id received from the model: ${[...duplicateToolCallIds].join(", ")}. The turn was stopped before tool execution.`;
    assistant.stopReason = "error";
    assistant.errorMessage = message;
    yield { type: "error", error: message, fatal: true };
    yield { type: "message_end", message: assistant };
    return assistant;
  }

  if (text) assistant.content.push({ type: "text", text });
  for (const block of reasoning.values()) {
    if (block.text) assistant.content.push({ type: "reasoning", text: block.text, providerMetadata: block.providerMetadata });
  }
  assistant.content.push(...toolCalls);
  assistant.stopReason = stopReason;
  assistant.usage = usage;
  yield { type: "message_end", message: assistant };
  return assistant;
}

function snapshotAssistant(
  text: string,
  reasoning: Map<string, { text: string; providerMetadata?: Record<string, unknown> }>,
  toolCalls: AgentToolCallContent[],
  assistant: AgentAssistantMessage
): AgentAssistantMessage {
  const content: AgentAssistantMessage["content"] = [];
  if (text) content.push({ type: "text", text });
  for (const block of reasoning.values()) {
    if (block.text) content.push({ type: "reasoning", text: block.text, providerMetadata: block.providerMetadata });
  }
  content.push(...toolCalls);
  return { ...assistant, content };
}

async function executeToolCalls(
  context: AgentContext,
  assistant: AgentAssistantMessage,
  calls: AgentToolCallContent[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  truncated: boolean
): Promise<{ messages: AgentToolResultMessage[]; events: AgentEvent[]; terminate: boolean }> {
  const sequential = config.toolExecution === "sequential"
    || calls.some((call) => context.tools.find((tool) => tool.name === call.name)?.executionMode === "sequential");
  if (sequential) {
    const results: Array<{ message: AgentToolResultMessage; events: AgentEvent[]; terminate: boolean }> = [];
    for (const call of calls) results.push(await executeOneTool(context, assistant, call, config, signal, truncated));
    return {
      messages: results.map((result) => result.message),
      events: results.flatMap((result) => result.events),
      terminate: results.length > 0 && results.every((result) => result.terminate)
    };
  }
  const results = await Promise.all(calls.map(async (call) => await executeOneTool(context, assistant, call, config, signal, truncated)));
  return {
    messages: results.map((result) => result.message),
    events: results.flatMap((result) => result.events),
    terminate: results.length > 0 && results.every((result) => result.terminate)
  };
}

async function executeOneTool(
  context: AgentContext,
  assistant: AgentAssistantMessage,
  call: AgentToolCallContent,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  truncated: boolean
): Promise<{ message: AgentToolResultMessage; events: AgentEvent[]; terminate: boolean }> {
  const events: AgentEvent[] = [{ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments }];
  const tool = context.tools.find((candidate) => candidate.name === call.name);
  const unknownTool = tool === undefined;
  let result: AgentToolResult;
  let syntheticFailure = false;
  if (unknownTool) {
    const message = call.name.trim()
      ? `Tool ${call.name} not found.`
      : "Tool call is missing a function name.";
    result = { ...errorResult(message), terminate: true };
    syntheticFailure = true;
  } else if (truncated) {
    result = errorResult(`Tool call "${call.name}" was not executed because the model output was truncated.`);
    syntheticFailure = true;
  } else if (call.invalid) {
    result = errorResult(`Invalid tool arguments for ${call.name}: the provider returned malformed JSON.`);
    syntheticFailure = true;
  } else {
    const validation = validateJsonSchema(tool.parameters, call.arguments);
    if (!validation.ok) {
      result = errorResult(`Invalid tool arguments for ${call.name}: ${validation.errors.join("; ")}`);
      syntheticFailure = true;
    } else {
      const before = await config.beforeToolCall?.({ assistantMessage: assistant, toolCall: call, args: call.arguments, context }, signal);
      if (before?.block) {
        result = errorResult(before.reason ?? `Tool ${call.name} was blocked.`);
      } else {
        try {
          result = await tool.execute(call.id, call.arguments, signal, (update) => {
            events.push({ type: "tool_execution_update", toolCallId: call.id, toolName: call.name, update });
          });
        } catch (error) {
          result = errorResult(errorMessage(error));
        }
        const after = await config.afterToolCall?.({ assistantMessage: assistant, toolCall: call, args: call.arguments, result, context }, signal);
        if (after) result = { ...result, ...after };
      }
    }
  }
  events.push({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result });
  if (syntheticFailure) {
    const message = result.content.find((part) => part.type === "text")?.text ?? `Tool ${call.name} failed.`;
    events.push({ type: "error", error: message, fatal: unknownTool });
  }
  return {
    message: {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: result.content,
    details: result.details,
    isError: result.isError === true,
    timestamp: Date.now()
    },
    events,
    terminate: result.terminate === true || unknownTool
  };
}

function errorResult(message: string): AgentToolResult {
  return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 保留给后续 Provider/宿主直接使用的异步事件队列工厂。 */
export function createAgentEventQueue<T>(): AsyncEventQueue<T> {
  return new AsyncEventQueue<T>();
}

async function* streamWithAbort<T>(
  stream: AsyncIterable<T>,
  signal: AbortSignal | undefined
): AsyncGenerator<T, void, void> {
  const iterator = stream[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      const next = await waitForAbort(
        Promise.resolve().then(() => iterator.next()),
        signal
      );
      if (next.done) {
        completed = true;
        return;
      }
      yield next.value;
    }
  } finally {
    // Provider 的 return() 也可能和 next() 一样不合作。无论是取消还是 provider 报错，
    // 都不能让资源清理反过来阻塞 message_end / turn_end；关闭动作只在后台尽力执行。
    if (!completed) closeAsyncIterator(iterator);
  }
}

/** 流对象在取消后才到达时，仍需回收它的底层 reader。 */
function closeAsyncIterableWhenReady<T>(streamPromise: Promise<AsyncIterable<T>>): void {
  void streamPromise.then(closeAsyncIterable, () => undefined);
}

function closeAsyncIterable<T>(stream: AsyncIterable<T>): void {
  try {
    closeAsyncIterator(stream[Symbol.asyncIterator]());
  } catch {
    // 创建 iterator 的失败不能覆盖已确定的取消或 provider 错误。
  }
}

function closeAsyncIterator<T>(iterator: AsyncIterator<T>): void {
  if (!iterator.return) return;
  try {
    void Promise.resolve(iterator.return()).catch(() => undefined);
  } catch {
    // 清理失败不能覆盖模型错误或用户取消的主结果。
  }
}

async function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return await promise;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
