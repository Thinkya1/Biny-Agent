import assert from "node:assert/strict";
import type { AgentMessage } from "../src/agent/core/types.js";
import { replaySessionEvents, sessionEventsToConversation } from "../src/session/replay.js";
import type { SessionEvent } from "../src/session/recorder.js";

function main(): void {
  const signedReasoning = { anthropic: { signature: "opaque-signature" } };
  const events: SessionEvent[] = [
    { type: "user_message", content: "inspect the workspace" },
    {
      type: "tool_call",
      tool: "read_file",
      args: { path: "src/index.ts" },
      toolCallId: "read-1",
      sequence: 1,
      reasoningContent: "Start with the entry point.",
      reasoningProviderOptions: signedReasoning
    },
    { type: "tool_result", tool: "read_file", toolCallId: "read-1", sequence: 1, result: { path: "src/index.ts", content: "export {};" } },
    { type: "tool_call", tool: "run_command", args: { command: "pnpm typecheck" }, toolCallId: "check-1", sequence: 2 }
  ];
  const replay = replaySessionEvents(events);

  assert.equal(replay.recoveredToolResults.length, 1);
  assert.deepEqual(replay.recoveredToolResults[0]?.result, {
    error: "Tool call was interrupted; completion status is unknown.",
    interrupted: true,
    recovered: true,
    executionStatus: "unknown",
    operationId: replay.recoveredToolResults[0]?.operationId
  });
  const toolCall = replay.messages.find((message) => hasToolCall(message, "read-1"));
  assert.deepEqual(reasoningProviderOptions(toolCall), signedReasoning);
  assert.equal(replay.messages.some((message) => hasToolResult(message, "check-1")), true);

  const notStarted = replaySessionEvents([
    { type: "user_message", content: "cancel before admission" },
    { type: "tool_call", tool: "write_file", args: { path: "a.txt" }, toolCallId: "not-started", sequence: 1 },
    { type: "tool_execution", tool: "write_file", toolCallId: "not-started", sequence: 1, operationId: "op-not-started", state: "not_started" }
  ]);
  assert.equal(notStarted.recoveredToolResults[0]?.auditOnly, true);
  assert.equal(notStarted.discardedToolCalls[0]?.state, "not_started");
  assert.equal(notStarted.messages.some((message) => hasToolCall(message, "not-started")), false);

  const admitted = replaySessionEvents([
    { type: "user_message", content: "crash after admission" },
    { type: "tool_call", tool: "write_file", args: { path: "a.txt" }, toolCallId: "admitted-1", sequence: 1 },
    { type: "tool_execution", tool: "write_file", toolCallId: "admitted-1", sequence: 1, operationId: "op-admitted-1", state: "admitted" }
  ]);
  assert.equal(admitted.recoveredToolResults[0]?.executionStatus, "unknown");
  assert.equal(admitted.recoveredToolResults[0]?.auditOnly, undefined);
  assert.equal(admitted.messages.some((message) => hasToolResult(message, "admitted-1")), true);

  const sideEffectCommitted = replaySessionEvents([
    { type: "user_message", content: "write once" },
    { type: "tool_call", tool: "write_file", args: { path: "a.txt" }, toolCallId: "write-1", sequence: 1 },
    { type: "tool_execution", tool: "write_file", toolCallId: "write-1", sequence: 1, operationId: "op-write-1", state: "side_effect_committed", evidence: "rename committed" }
  ]);
  assert.equal(sideEffectCommitted.recoveredToolResults[0]?.result && typeof sideEffectCommitted.recoveredToolResults[0].result === "object"
    ? (sideEffectCommitted.recoveredToolResults[0].result as Record<string, unknown>).status
    : undefined, "recovered-success");
  assert.equal(sideEffectCommitted.messages.some((message) => hasToolResult(message, "write-1")), true);
  const replayedRecovery = replaySessionEvents([...sideEffectCommitted.events]);
  assert.equal(replayedRecovery.recoveredToolResults.length, 0, "replay must not append a second recovery result");

  const legacyBoundary = replaySessionEvents([
    { type: "user_message", content: "run two checks" },
    { type: "tool_call", tool: "check_a", args: {}, toolCallId: "legacy-a", sequence: 1 },
    { type: "tool_call", tool: "check_b", args: {}, toolCallId: "legacy-b", sequence: 2 },
    { type: "user_message", content: "new request" }
  ]);
  assert.deepEqual(legacyBoundary.messages.map((message) => message.role), ["user", "assistant", "toolResult", "toolResult", "user"]);

  const unsigned = sessionEventsToConversation([
    { type: "user_message", content: "old session" },
    { type: "assistant_message", content: "answer", reasoningContent: "unsigned legacy reasoning" }
  ]);
  assert.equal(reasoningProviderOptions(unsigned[1]), undefined);

  const emptyAfterReasoningDrop = sessionEventsToConversation([
    { type: "user_message", content: "resume after interrupted output" },
    {
      type: "assistant_message",
      content: "",
      reasoningContent: "unsigned reasoning only",
      reasoningBlocks: [{ text: "unsigned reasoning only" }]
    }
  ]);
  assert.deepEqual(emptyAfterReasoningDrop, [{ role: "user", content: "resume after interrupted output" }]);

  const emptyCanonicalAssistant = sessionEventsToConversation([
    { type: "user_message", content: "resume after empty canonical message" },
    { type: "agent_message", message: { role: "assistant", content: [] } }
  ]);
  assert.deepEqual(emptyCanonicalAssistant, [{ role: "user", content: "resume after empty canonical message" }]);

  // 一步里的多个 reasoning block 各自签名，必须逐块回放，不能拼成一个块共用最后一个签名。
  const firstSignature = { anthropic: { signature: "first-signature" } };
  const secondSignature = { anthropic: { signature: "second-signature" } };
  const multiBlock = sessionEventsToConversation([
    { type: "user_message", content: "think twice" },
    {
      type: "assistant_message",
      content: "answer",
      reasoningContent: "first thoughtsecond thought",
      reasoningProviderOptions: secondSignature,
      reasoningBlocks: [
        { text: "first thought", providerOptions: firstSignature },
        { text: "second thought", providerOptions: secondSignature }
      ]
    }
  ]);
  assert.deepEqual(reasoningParts(multiBlock[1]).map((part) => part.text), ["first thought", "second thought"]);
  assert.deepEqual(reasoningParts(multiBlock[1]).map((part) => part.providerMetadata), [firstSignature, secondSignature]);

  // 签名丢失的块不能靠回合级 providerOptions 蒙混过关，只能整块丢弃。
  const partiallySigned = sessionEventsToConversation([
    { type: "user_message", content: "think twice" },
    {
      type: "assistant_message",
      content: "answer",
      reasoningProviderOptions: secondSignature,
      reasoningBlocks: [
        { text: "redacted block" },
        { text: "second thought", providerOptions: secondSignature }
      ]
    }
  ]);
  assert.deepEqual(reasoningParts(partiallySigned[1]).map((part) => part.text), ["second thought"]);

  const canonicalAssistant = {
    role: "assistant" as const,
    content: [
      { type: "reasoning" as const, text: "signed thought", providerMetadata: { signature: "sig-1" } },
      { type: "toolCall" as const, id: "call-1", name: "read_file", arguments: { path: "a.ts" } }
    ],
    stopReason: "tool-calls" as const
  };
  const canonicalResult = {
    role: "toolResult" as const,
    toolCallId: "call-1",
    toolName: "read_file",
    content: [{ type: "text" as const, text: "file body" }],
    details: { content: "file body" }
  };
  assert.deepEqual(replaySessionEvents([
    { type: "user_message", content: "read it" },
    { type: "agent_message", message: canonicalAssistant },
    { type: "tool_call", tool: "read_file", args: { path: "a.ts" }, toolCallId: "call-1" },
    { type: "tool_result", tool: "read_file", result: { content: "legacy projection" }, toolCallId: "call-1" },
    { type: "agent_message", message: canonicalResult },
    { type: "assistant_message", content: "legacy projection" },
    { type: "user_message", content: "continue" },
    { type: "assistant_message", content: "legacy-only fallback" }
  ]).messages, [
    { role: "user", content: "read it" },
    canonicalAssistant,
    canonicalResult,
    { role: "user", content: "continue" },
    { role: "assistant", content: [{ type: "text", text: "legacy-only fallback" }] }
  ]);

  const tree = replaySessionEvents([
    { type: "user_message", content: "root", messageId: "u1" },
    { type: "agent_message", message: canonicalAssistant, messageId: "a1", parentMessageId: "u1" },
    { type: "agent_message", message: canonicalResult, messageId: "t1", parentMessageId: "a1" }
  ]).messageTree;
  assert.deepEqual(tree.map((node) => [node.id, node.parentId, node.message.role]), [
    ["u1", undefined, "user"],
    ["a1", "u1", "assistant"],
    ["t1", "a1", "toolResult"]
  ]);

  const checkpointed = replaySessionEvents([
    { type: "user_message", content: "old request", messageId: "u-old" },
    { type: "agent_message", message: { role: "assistant", content: [{ type: "text", text: "old answer" }] }, messageId: "a-old", parentMessageId: "u-old" },
    { type: "user_message", content: "kept request", messageId: "u-kept", parentMessageId: "a-old" },
    {
      type: "context_checkpoint",
      reason: "threshold",
      summary: "## Goal\n- Continue the kept request.",
      firstKeptMessageId: "u-kept",
      firstKeptMessageIndex: 2,
      tokensBefore: 12_000,
      compactedMessages: 2,
      createdAt: "2026-08-02T00:00:00.000Z"
    },
    { type: "agent_message", message: { role: "assistant", content: [{ type: "text", text: "kept answer" }] }, messageId: "a-kept", parentMessageId: "u-kept" }
  ]);
  assert.deepEqual(checkpointed.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal((checkpointed.messages[0] as { content?: unknown }).content, "kept request");
  assert.deepEqual(checkpointed.messageReferences.map((reference) => [reference.id, reference.index]), [
    ["u-kept", 2],
    ["a-kept", 3]
  ]);
  assert.equal(checkpointed.contextCheckpoint?.summary.includes("Continue the kept request"), true);
  assert.equal(checkpointed.messageTree.length, 4, "checkpoint must not delete the auditable message tree");

  const legacyCheckpoint = replaySessionEvents([
    { type: "user_message", content: "legacy old" },
    { type: "assistant_message", content: "legacy answer" },
    {
      type: "context_checkpoint",
      reason: "manual",
      summary: "legacy checkpoint",
      firstKeptMessageIndex: 2,
      tokensBefore: 1_000,
      compactedMessages: 2,
      createdAt: "2026-08-02T00:00:00.000Z"
    },
    { type: "user_message", content: "legacy kept" }
  ]);
  assert.deepEqual(legacyCheckpoint.messages, [{ role: "user", content: "legacy kept" }]);

  assert.throws(() => replaySessionEvents([
    { type: "user_message", content: "duplicate", runtime: { eventId: "event-1", eventSeq: 1 } },
    { type: "user_message", content: "duplicate again", runtime: { eventId: "event-1", eventSeq: 2 } }
  ]), /Duplicate runtime event id/u);
  assert.throws(() => replaySessionEvents([
    { type: "user_message", content: "gap", runtime: { eventId: "event-1", eventSeq: 1 } },
    { type: "user_message", content: "gap again", runtime: { eventId: "event-2", eventSeq: 3 } }
  ]), /not continuous/u);
  assert.throws(() => replaySessionEvents([
    { type: "user_message", content: "pairing", runtime: { eventId: "event-1", eventSeq: 1 } },
    { type: "tool_call", tool: "write_file", args: {}, toolCallId: "call-1", runtime: { eventId: "event-2", eventSeq: 2 } },
    { type: "tool_execution", tool: "write_file", toolCallId: "call-1", sequence: 1, operationId: "operation-1", state: "running", runtime: { eventId: "event-3", eventSeq: 3 } },
    { type: "tool_result", tool: "write_file", toolCallId: "call-1", sequence: 1, operationId: "operation-2", result: {}, runtime: { eventId: "event-4", eventSeq: 4 } }
  ]), /mismatched operation identity/u);
}

function hasToolCall(message: AgentMessage, toolCallId: string): boolean {
  return message.role === "assistant"
    && message.content.some((part) => part.type === "toolCall" && part.id === toolCallId);
}

function hasToolResult(message: AgentMessage, toolCallId: string): boolean {
  return message.role === "toolResult" && message.toolCallId === toolCallId;
}

function reasoningProviderOptions(message: AgentMessage | undefined): unknown {
  if (!message || message.role !== "assistant") return undefined;
  return message.content.find((part) => part.type === "reasoning")?.providerMetadata;
}

function reasoningParts(message: AgentMessage | undefined): Array<{ text: string; providerMetadata?: unknown }> {
  if (!message || message.role !== "assistant") return [];
  return message.content.filter((part) => part.type === "reasoning");
}

main();
