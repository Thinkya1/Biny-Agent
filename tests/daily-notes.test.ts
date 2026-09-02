import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeDailyMemoryNote } from "../src/activity/dailyNotes.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-daily-note-"));
try {
  const target = await writeDailyMemoryNote("2026-09-01", "# 今日\n\n完成记忆系统对齐。", { agentDir: root });
  assert.equal(target, path.join(root, "memory", "2026-09-01.md"));
  assert.equal(await readFile(target, "utf8"), "# 今日\n\n完成记忆系统对齐。\n");
  await assert.rejects(
    writeDailyMemoryNote("2026-9-1", "invalid", { agentDir: root }),
    /Invalid daily memory date/u
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("daily notes tests passed");
