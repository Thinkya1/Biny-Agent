import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { forkSession } from "../src/session/fork.js";
import { createSessionId, SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { replaySession, replaySessionEvents } from "../src/session/replay.js";
import { ensureAgentDirs, sessionFilePath } from "../src/session/store.js";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-fork-"));
  try {
    await ensureAgentDirs(root);
    testSessionIdsAreTimeSortable();
    testMessageVersionReplay();
    const source = await seedSession(root);
    await testFullForkIsIndependent(root, source);
    await testTruncatedForkNeverSplitsAToolCall(root, source);
    await testRejectsEmptyAndBadBounds(root);
    console.log("session fork tests passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 重新生成保留在同一消息槽；回放默认只把最新版本交给模型，切换标记可回到旧版本。 */
function testMessageVersionReplay(): void {
  const assistant = (messageId: string, text: string): Extract<SessionEvent, { type: "agent_message" }> => ({
    type: "agent_message",
    message: { role: "assistant", content: [{ type: "text", text }] },
    messageId,
    parentMessageId: "user-1",
    slotId: "slot-1"
  });
  const flat = (messageId: string, content: string, retryOfMessageId?: string): Extract<SessionEvent, { type: "assistant_message" }> => ({
    type: "assistant_message",
    content,
    messageId,
    parentMessageId: "user-1",
    slotId: "slot-1",
    replyToMessageId: "user-1",
    retryOfMessageId
  });
  const events: SessionEvent[] = [
    { type: "user_message", content: "same prompt", messageId: "user-1", slotId: "user-1" },
    assistant("assistant-1", "first answer"),
    flat("assistant-1", "first answer"),
    assistant("assistant-2", "second answer"),
    flat("assistant-2", "second answer", "assistant-1")
  ];

  const latest = replaySessionEvents(events, { sessionId: "versioned" });
  assert.deepEqual(latest.messageReferences.map((reference) => reference.id), ["user-1", "assistant-2"]);
  assert.equal(latest.messages.at(-1)?.role === "assistant" ? latest.messages.at(-1)?.content[0]?.type === "text" ? latest.messages.at(-1)?.content[0]?.text : undefined : undefined, "second answer");

  const selected = replaySessionEvents([
    ...events,
    { type: "message_version_selected", messageId: "assistant-1", slotId: "slot-1" }
  ], { sessionId: "versioned" });
  assert.deepEqual(selected.messageReferences.map((reference) => reference.id), ["user-1", "assistant-1"]);

  const retryFromPrevious = replaySessionEvents([
    ...events,
    { type: "message_version_selected", messageId: "assistant-1", slotId: "slot-1" },
    assistant("assistant-3", "third answer"),
    flat("assistant-3", "third answer", "assistant-1"),
    { type: "message_version_selected", messageId: "assistant-3", slotId: "slot-1" }
  ], { sessionId: "versioned" });
  assert.deepEqual(retryFromPrevious.messageReferences.map((reference) => reference.id), ["user-1", "assistant-3"]);
}

function testSessionIdsAreTimeSortable(): void {
  const earlier = createSessionId(Date.UTC(2026, 0, 1, 0, 0, 0, 1));
  const later = createSessionId(Date.UTC(2026, 0, 1, 0, 0, 0, 2));
  assert.match(earlier, /^\d{8}-\d{6}-\d{3}-[0-9a-f]{8}$/u);
  assert.equal(earlier < later, true);
  assert.notEqual(createSessionId(Date.UTC(2026, 0, 1, 0, 0, 0, 1)), earlier);
}

async function seedSession(root: string): Promise<string> {
  const recorder = new SessionRecorder(root);
  const events: SessionEvent[] = [
    { type: "user_message", content: "first request" },
    { type: "assistant_message", content: "first answer" },
    { type: "user_message", content: "second request" },
    { type: "tool_call", tool: "read_file", args: { path: "a.ts" }, toolCallId: "c1", sequence: 1 },
    { type: "tool_result", tool: "read_file", result: { content: "body" }, toolCallId: "c1", sequence: 1 },
    { type: "assistant_message", content: "second answer" }
  ];
  for (const event of events) recorder.record(event);
  await recorder.close();
  return recorder.sessionId;
}

/** 分叉出来的会话必须完全独立：写它不能影响原会话。 */
async function testFullForkIsIndependent(root: string, source: string): Promise<void> {
  const seededAuthority = await RuntimeEventAuthority.open(root);
  seededAuthority.close();
  const forked = await forkSession(root, source);
  assert.notEqual(forked.sessionId, source);
  assert.equal(forked.sourceSessionId, source);
  assert.equal(forked.events, 6);

  const replayed = await replaySession(forked.filePath);
  const originalEvents = await replaySession(sessionFilePath(root, source));
  assert.notEqual(originalEvents.events[0]?.runtime?.eventId, replayed.events[0]?.runtime?.eventId);
  assert.deepEqual(replayed.events.map((event) => event.runtime?.eventSeq), [1, 2, 3, 4, 5, 6]);
  assert.equal(replayed.recoveredToolResults.length, 0, "a clean fork must not carry a synthetic interrupted result");
  assert.equal(replayed.messageTree.length, 2);
  assert.equal(replayed.messageTree[1]?.parentId, replayed.messageTree[0]?.id);

  const reopenedAuthority = await RuntimeEventAuthority.open(root);
  reopenedAuthority.close();

  const appended = new SessionRecorder(root, forked.sessionId, forked.filePath);
  appended.repairTailForAppend();
  appended.record({ type: "user_message", content: "only in the fork" });
  await appended.close();

  const original = await readFile(sessionFilePath(root, source), "utf8");
  assert.equal(original.includes("only in the fork"), false, "writing the fork must not touch the source session");
  const appendedTree = (await replaySession(forked.filePath)).messageTree;
  assert.equal(appendedTree.at(-1)?.parentId, appendedTree.at(-2)?.id);
}

/**
 * 停在 tool_call 和它的 tool_result 中间，重放会补一条"已中断"的假结果 —— 分叉出来的会话
 * 从第一步起就带着一个从未发生过的失败。截断点必须向前对齐。
 */
async function testTruncatedForkNeverSplitsAToolCall(root: string, source: string): Promise<void> {
  // 第 4 条正好是 tool_call，它的结果在第 5 条。
  const forked = await forkSession(root, source, { upToEvent: 4 });
  assert.equal(forked.events, 3, `expected the cut to move back before the tool call, got ${String(forked.events)} events`);

  const replayed = await replaySession(forked.filePath);
  assert.equal(replayed.recoveredToolResults.length, 0, "a truncated fork must not invent an interrupted tool result");
  assert.equal(replayed.messages.at(-1)?.role, "user");

  // 包含配对结果的截断点则原样保留。
  const withResult = await forkSession(root, source, { upToEvent: 5 });
  assert.equal(withResult.events, 5);
  assert.equal((await replaySession(withResult.filePath)).recoveredToolResults.length, 0);
}

async function testRejectsEmptyAndBadBounds(root: string): Promise<void> {
  const empty = new SessionRecorder(root);
  const emptyId = empty.sessionId;
  empty.record({ type: "user_message", content: "x" });
  await empty.close();
  await assert.rejects(forkSession(root, emptyId, { upToEvent: 0 }), /positive integer/);
  await assert.rejects(forkSession(root, "no-such-session"), /.+/);
}

await main();
