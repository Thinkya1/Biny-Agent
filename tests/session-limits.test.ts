import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { updateSessionCatalogMetadata } from "../src/session/catalog.js";
import { listSessionSummaries, parseSessionEvents, readSessionSummary, readStoredSessionEvents } from "../src/session/events.js";
import { forkSession } from "../src/session/fork.js";
import { isSessionNearLimit, maxSessionEvents, maxSessionFileBytes } from "../src/session/limits.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replayStoredSession } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";

async function main(): Promise<void> {
  testNearLimitDetection();
  testStrictModeStillRejects();
  testTruncateModeKeepsTheTail();
  await testOversizedSessionStillOpens();
  await testEventCountTruncationDegradesConsistently();
  console.log("session limits tests passed");
}

function testNearLimitDetection(): void {
  assert.equal(isSessionNearLimit(1_000, 10), false);
  assert.equal(isSessionNearLimit(maxSessionFileBytes * 0.9, 10), true);
  assert.equal(isSessionNearLimit(1_000, Math.floor(maxSessionEvents * 0.9)), true);
}

/** 校验和写入路径必须保持严格：那里发现异常就该停下。 */
function testStrictModeStillRejects(): void {
  const line = `${JSON.stringify({ type: "user_message", content: "x" })}\n`;
  assert.throws(() => parseSessionEvents("x".repeat(maxSessionFileBytes + 1)), /maximum size/);
  assert.throws(() => parseSessionEvents(line.repeat(maxSessionEvents + 1)), /more than/);
}

/** 读取路径保留最近的事件：恢复会话时有用的是尾部，不是开头。 */
function testTruncateModeKeepsTheTail(): void {
  const lines = Array.from({ length: maxSessionEvents + 10 }, (_, index) =>
    JSON.stringify({ type: "user_message", content: `message-${String(index)}` })).join("\n");
  const events = parseSessionEvents(`${lines}\n`, { overflow: "truncate" });
  assert.equal(events.length, maxSessionEvents);
  const last = events.at(-1);
  assert.equal(last?.type === "user_message" && last.content, `message-${String(maxSessionEvents + 9)}`);
  const first = events[0];
  assert.equal(first?.type === "user_message" && first.content, "message-10", "the oldest events are the ones dropped");
}

/**
 * 关键回归：超过大小上限的会话以前是**打不开**的，而用户是在想恢复它的时候才发现。
 * 现在必须能打开，并如实标注只拿到了最近的部分。
 */
async function testOversizedSessionStillOpens(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-session-limits-"));
  try {
    await ensureAgentDirs(root);
    const recorder = new SessionRecorder(root);
    recorder.record({ type: "user_message", content: "first" });
    await recorder.close();

    // 撑到超过上限：一堆大事件加一条结尾标记。
    const filler = `${JSON.stringify({ type: "user_message", content: "f".repeat(64 * 1024) })}\n`;
    const rounds = Math.ceil(maxSessionFileBytes / filler.length) + 2;
    for (let index = 0; index < rounds; index += 1) await appendFile(recorder.filePath, filler);
    await appendFile(recorder.filePath, `${JSON.stringify({ type: "user_message", content: "final marker" })}\n`);

    const stored = await readStoredSessionEvents(root, recorder.sessionId);
    assert.equal(stored.truncated, true, "an oversized session must report that it was truncated");
    assert.equal(stored.events.length > 0, true, "an oversized session must still open");
    const last = stored.events.at(-1);
    assert.equal(last?.type === "user_message" && last.content, "final marker", "the most recent history must survive");

    const replayed = await replayStoredSession(root, recorder.sessionId);
    assert.equal(replayed.truncated, true);
    assert.equal(replayed.messages.length > 0, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * 字节未超限但事件数超限的会话：打开、列表、改元数据、回放必须行为一致 —— 都按尾部
 * 降级并如实上报截断，而不是打开正常、列表里消失、改标题报错。分叉则必须拒绝：不能把
 * 残缺视角固化进新文件。
 */
async function testEventCountTruncationDegradesConsistently(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-session-event-limit-"));
  try {
    await ensureAgentDirs(root);
    const recorder = new SessionRecorder(root);
    recorder.record({ type: "user_message", content: "first" });
    await recorder.close();

    // 一条写入追加到 maxSessionEvents + 1 条小事件：字节远未超限，只有事件数超限。
    const lines = Array.from({ length: maxSessionEvents }, (_, index) =>
      JSON.stringify({ type: "user_message", content: `message-${String(index)}` })).join("\n");
    await appendFile(recorder.filePath, `${lines}\n`);

    const stored = await readStoredSessionEvents(root, recorder.sessionId);
    assert.equal(stored.truncated, true, "event-count truncation must be reported, not just byte truncation");
    assert.equal(stored.events.length, maxSessionEvents);
    const firstKept = stored.events[0];
    assert.equal(firstKept?.type === "user_message" && firstKept.content, "message-0", "the oldest event is the one dropped");

    const summaries = await listSessionSummaries(root);
    assert.equal(summaries.some((summary) => summary.fileName === `${recorder.sessionId}.jsonl`), true, "an over-limit session must stay in the list");
    const summary = await readSessionSummary(root, recorder.sessionId);
    assert.equal(summary?.eventCount, maxSessionEvents);
    await updateSessionCatalogMetadata(root, recorder.sessionId, { title: "truncated" });

    const replayed = await replayStoredSession(root, recorder.sessionId);
    assert.equal(replayed.truncated, true);

    await assert.rejects(forkSession(root, recorder.sessionId), /exceeds the session limits/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
