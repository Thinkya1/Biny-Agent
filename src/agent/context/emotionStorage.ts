/**
 * Agent 情绪的本地 Markdown 存储。
 *
 * 只保存当前 base/context 快照，不维护历史曲线。frontmatter 使用固定的单行字段，trigger
 * 放在正文中，便于人工查看，也和 Alma 的情绪文件形状保持一致。
 */
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { globalAgentDir } from "../../config/paths.js";
import { blendEmotion, type BlendedEmotion, type EmotionState } from "./emotionTypes.js";

const baseFileName = "base.md";
const contextDirectoryName = "context";

export interface EmotionStorageOptions {
  agentDir?: string;
  now?: () => Date;
}

export class EmotionStorage {
  private readonly root: string;
  private readonly now: () => Date;

  constructor(options: EmotionStorageOptions = {}) {
    this.root = path.join(path.resolve(options.agentDir ?? globalAgentDir()), "emotions");
    this.now = options.now ?? (() => new Date());
  }

  get directory(): string {
    return this.root;
  }

  async readBase(): Promise<EmotionState | undefined> {
    return await this.readState(path.join(this.root, baseFileName));
  }

  async writeBase(state: EmotionState): Promise<void> {
    await this.writeState(path.join(this.root, baseFileName), state);
  }

  async readContext(sessionId: string): Promise<EmotionState | undefined> {
    return await this.readState(path.join(this.root, contextDirectoryName, `${safeFileName(sessionId)}.md`));
  }

  async writeContext(sessionId: string, state: EmotionState): Promise<void> {
    await this.writeState(
      path.join(this.root, contextDirectoryName, `${safeFileName(sessionId)}.md`),
      state
    );
  }

  async readBlended(sessionId: string | undefined, fatigue: number): Promise<BlendedEmotion> {
    const [base, context] = await Promise.all([
      this.readBase(),
      sessionId === undefined ? Promise.resolve(undefined) : this.readContext(sessionId)
    ]);
    return blendEmotion(base, context, fatigue, this.now());
  }

  private async readState(filePath: string): Promise<EmotionState | undefined> {
    try {
      return parseEmotionDocument(await fs.readFile(filePath, "utf8"));
    } catch {
      // 情绪是表达层的可选状态，缺失或损坏都应降级到默认情绪，不阻断主回合。
      return undefined;
    }
  }

  private async writeState(filePath: string, state: EmotionState): Promise<void> {
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporary, "w", 0o600);
      await handle.writeFile(renderEmotionDocument(state), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, filePath);
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
    }
  }
}

function renderEmotionDocument(state: EmotionState): string {
  const trigger = state.trigger?.trim();
  const frontmatter = [
    "---",
    `mood: ${state.mood.trim()}`,
    `valence: ${String(state.valence)}`,
    `energy: ${String(state.energy)}`,
    `updated: ${state.updatedAt}`,
    "---"
  ].join("\n");
  return trigger ? `${frontmatter}\n\n${trigger}\n` : `${frontmatter}\n`;
}

function parseEmotionDocument(content: string): EmotionState | undefined {
  const normalized = content.replace(/\r\n?/gu, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/u);
  if (!match) return undefined;
  const fields: Record<string, string> = {};
  for (const line of match[1]?.split("\n") ?? []) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) return undefined;
    const key = line.slice(0, separator).trim();
    if (!(key === "mood" || key === "valence" || key === "energy" || key === "updated")) return undefined;
    fields[key] = line.slice(separator + 1).trim();
  }

  const mood = fields.mood;
  const valence = Number(fields.valence);
  const energy = Number(fields.energy);
  const updatedAt = fields.updated;
  if (
    !mood
    || Array.from(mood).length > 32
    || !Number.isFinite(valence)
    || !Number.isFinite(energy)
    || valence < 0
    || valence > 10
    || energy < 0
    || energy > 10
    || !updatedAt
    || !Number.isFinite(Date.parse(updatedAt))
  ) return undefined;

  const trigger = match[2]?.trim() || undefined;
  if (trigger !== undefined && Array.from(trigger).length > 200) return undefined;
  return { mood, valence, energy, updatedAt, trigger };
}

function safeFileName(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 180);
  return safe || randomUUID();
}
