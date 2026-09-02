import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { globalAgentDir } from "../config/paths.js";

/**
 * 每日记忆笔记：给人和 agent 看的可读叙事，不属于 durable memory entries。
 * 文件是可重建的派生结果，写入失败不应影响 Activity 采集或对话。
 */
export async function writeDailyMemoryNote(
  dateKey: string,
  content: string,
  options: { agentDir?: string } = {}
): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateKey)) throw new Error(`Invalid daily memory date: ${dateKey}`);
  const root = path.resolve(options.agentDir ?? globalAgentDir());
  const memoryDir = path.join(root, "memory");
  await mkdir(memoryDir, { recursive: true, mode: 0o700 });
  const target = path.join(memoryDir, `${dateKey}.md`);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  const note = content.trim()
    ? `${content.trim()}\n`
    : `# ${dateKey}\n\n（这一天没有可写入的活动记录。）\n`;
  try {
    await writeFile(temporary, note, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await import("node:fs/promises").then(({ rm }) => rm(temporary, { force: true })).catch(() => undefined);
    throw error;
  }
  return target;
}
