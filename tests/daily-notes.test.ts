import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendDailyMemoryEntry, writeDailyActivityNote, writeDailyMemoryNote } from "../src/activity/dailyNotes.js";
import { appendCompletedChatDiaryEntry } from "../src/agent/context/chatDiary.js";
import { buildSystemPrompt, systemPromptForTelemetry } from "../src/agent/prompts.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-daily-note-"));
try {
  const target = await writeDailyMemoryNote("2026-09-01", "# 今日\n\n完成记忆系统对齐。", { agentDir: root });
  assert.equal(target, path.join(root, "memory", "2026-09-01.md"));
  assert.equal(await readFile(target, "utf8"), "# 今日\n\n完成记忆系统对齐。\n");
  const chatTarget = await appendCompletedChatDiaryEntry({
    sessionId: "session-1",
    turnId: "turn-1",
    workspaceRoot: "/tmp/biny",
    userMessage: "整理日报",
    assistantMessage: "已完成聊天摘要。",
    occurredAt: new Date("2026-09-02T10:20:00.000Z")
  }, { agentDir: root });
  const chatNote = await readFile(chatTarget, "utf8");
  assert.match(chatNote, /## 聊天摘要/u);
  assert.match(chatNote, /整理日报/u);
  await appendCompletedChatDiaryEntry({
    sessionId: "session-1",
    turnId: "turn-1",
    workspaceRoot: "/tmp/biny",
    userMessage: "整理日报",
    assistantMessage: "已完成聊天摘要。",
    occurredAt: new Date("2026-09-02T10:20:00.000Z")
  }, { agentDir: root });
  const dedupedNote = await readFile(chatTarget, "utf8");
  assert.equal(dedupedNote.match(/整理日报/gu)?.length, 1, "同一聊天回合重试不应重复写入日报");

  await Promise.all([
    appendDailyMemoryEntry("2026-09-03", "聊天摘要", "session-2\0turn-1", "### 第一条", { agentDir: root }),
    appendDailyMemoryEntry("2026-09-03", "聊天摘要", "session-3\0turn-1", "### 第二条", { agentDir: root })
  ]);
  const concurrentNote = await readFile(path.join(root, "memory", "2026-09-03.md"), "utf8");
  assert.match(concurrentNote, /第一条/u);
  assert.match(concurrentNote, /第二条/u);

  const activityTarget = await writeDailyActivityNote(
    "2026-09-02",
    "# 2026-09-02 每日摘要\n\n## 2026-09-02 工作日记\n\n### biny\n- 活动日报",
    { agentDir: root }
  );
  const mergedNote = await readFile(activityTarget, "utf8");
  assert.match(mergedNote, /## 聊天摘要/u);
  assert.match(mergedNote, /## 活动记录/u);
  assert.match(mergedNote, /活动日报/u);
  const prompt = buildSystemPrompt({
    mode: "qa",
    cwd: "/tmp/biny",
    dailyNotesPrompt: "# 2026-09-02 每日摘要\n\n## 聊天摘要\n\n完成记忆系统对齐。"
  });
  assert.match(prompt, /完成记忆系统对齐/u);
  assert.doesNotMatch(systemPromptForTelemetry(prompt) ?? "", /完成记忆系统对齐/u);
  await assert.rejects(
    writeDailyMemoryNote("2026-9-1", "invalid", { agentDir: root }),
    /Invalid daily memory date/u
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("daily notes tests passed");
