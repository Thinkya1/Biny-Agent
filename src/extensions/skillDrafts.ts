/** 自动 Skill 抽取草稿的项目级存储与审核动作。 */
import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseSkillDocument } from "./skillCatalog.js";
import { projectBinyDir } from "../config/paths.js";

const maxDrafts = 128;
const maxDraftBytes = 512 * 1024;
const draftSchema = z.object({
  id: z.string().uuid(),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
  description: z.string().min(1).max(1_024),
  content: z.string().min(1).max(maxDraftBytes),
  status: z.enum(["pending", "approved", "rejected", "failed"]),
  toolCalls: z.number().int().nonnegative().max(65_536),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  error: z.string().max(2_000).optional(),
  installedPath: z.string().max(2_000).optional()
}).strict();
const draftsFileSchema = z.object({ format: z.literal(1), drafts: z.array(draftSchema).max(maxDrafts) }).strict();

export type SkillDraft = z.infer<typeof draftSchema>;

export async function listSkillDrafts(workspaceRoot: string): Promise<SkillDraft[]> {
  return (await readDocument(workspaceRoot)).drafts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function createSkillDraft(options: {
  workspaceRoot: string;
  name: string;
  description: string;
  content: string;
  toolCalls: number;
  status?: SkillDraft["status"];
  error?: string;
}): Promise<SkillDraft> {
  const content = validateDraftContent(options.content, options.name, options.description);
  const now = new Date().toISOString();
  const draft: SkillDraft = {
    id: randomUUID(),
    name: options.name,
    description: options.description,
    content,
    status: options.status ?? "pending",
    toolCalls: options.toolCalls,
    createdAt: now,
    updatedAt: now,
    error: options.error,
    installedPath: undefined
  };
  const document = await readDocument(options.workspaceRoot);
  await writeDocument(options.workspaceRoot, { format: 1, drafts: [draft, ...document.drafts].slice(0, maxDrafts) });
  return draft;
}

export async function markSkillDraftFailed(workspaceRoot: string, draftId: string, message: string): Promise<SkillDraft> {
  return await updateDraft(workspaceRoot, draftId, (draft) => ({
    ...draft,
    status: "failed",
    error: message.slice(0, 2_000),
    updatedAt: new Date().toISOString()
  }));
}

export async function rejectSkillDraft(workspaceRoot: string, draftId: string): Promise<SkillDraft> {
  return await updateDraft(workspaceRoot, draftId, (draft) => ({
    ...draft,
    status: "rejected",
    error: undefined,
    updatedAt: new Date().toISOString()
  }));
}

export async function retrySkillDraft(workspaceRoot: string, draftId: string): Promise<SkillDraft> {
  return await updateDraft(workspaceRoot, draftId, (draft) => ({
    ...draft,
    status: "pending",
    error: undefined,
    updatedAt: new Date().toISOString()
  }));
}

export async function editSkillDraft(workspaceRoot: string, draftId: string, content: string): Promise<SkillDraft> {
  return await updateDraft(workspaceRoot, draftId, (draft) => ({
    ...draft,
    content: validateDraftContent(content, draft.name, draft.description),
    status: "pending",
    error: undefined,
    updatedAt: new Date().toISOString()
  }));
}

export async function approveSkillDraft(workspaceRoot: string, draftId: string): Promise<SkillDraft> {
  const document = await readDocument(workspaceRoot);
  const draft = document.drafts.find((candidate) => candidate.id === draftId);
  if (!draft) throw new Error("Skill 草稿不存在。");
  if (draft.status === "approved") return draft;
  const content = validateDraftContent(draft.content, draft.name, draft.description);
  const skillsRoot = path.join(projectBinyDir(workspaceRoot), "skills");
  await ensureRealDirectory(path.dirname(skillsRoot));
  await ensureRealDirectory(skillsRoot);
  const targetDirectory = path.join(skillsRoot, draft.name);
  try {
    const stat = await fs.lstat(targetDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("目标 Skill 目录不安全。");
    throw new Error(`当前项目已存在同名 Skill：${draft.name}`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await fs.mkdir(targetDirectory, { mode: 0o700 });
  try {
    await writeAtomic(path.join(targetDirectory, "SKILL.md"), content);
  } catch (error) {
    await fs.rm(targetDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return await updateDraft(workspaceRoot, draftId, (current) => ({
    ...current,
    content,
    status: "approved",
    error: undefined,
    installedPath: path.relative(path.resolve(workspaceRoot), path.join(targetDirectory, "SKILL.md")).split(path.sep).join("/"),
    updatedAt: new Date().toISOString()
  }));
}

export function validateDraftContent(content: string, expectedName: string, expectedDescription: string): string {
  if (Buffer.byteLength(content, "utf8") > maxDraftBytes) throw new Error("Skill 草稿正文过大。");
  const parsed = parseSkillDocument(content);
  if (parsed.frontmatter.name !== expectedName || parsed.frontmatter.description !== expectedDescription) {
    throw new Error("Skill 草稿的 frontmatter 与审核字段不一致。");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(expectedName)) throw new Error("Skill 草稿名称无效。");
  return content;
}

async function readDocument(workspaceRoot: string): Promise<{ format: 1; drafts: SkillDraft[] }> {
  const target = draftsPath(workspaceRoot);
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > maxDrafts * maxDraftBytes) {
      throw new Error("Skill 草稿文件不安全或过大。");
    }
    return draftsFileSchema.parse(JSON.parse(await fs.readFile(target, "utf8")));
  } catch (error) {
    if (isNotFound(error)) return { format: 1, drafts: [] };
    throw new Error(`无法读取 Skill 草稿：${errorMessage(error)}`);
  }
}

async function writeDocument(workspaceRoot: string, document: { format: 1; drafts: SkillDraft[] }): Promise<void> {
  const root = path.dirname(draftsPath(workspaceRoot));
  await ensureRealDirectory(root);
  await writeAtomic(draftsPath(workspaceRoot), JSON.stringify(draftsFileSchema.parse(document), null, 2) + "\n");
}

async function updateDraft(workspaceRoot: string, draftId: string, update: (draft: SkillDraft) => SkillDraft): Promise<SkillDraft> {
  const document = await readDocument(workspaceRoot);
  const current = document.drafts.find((draft) => draft.id === draftId);
  if (!current) throw new Error("Skill 草稿不存在。");
  const next = draftSchema.parse(update(structuredClone(current)));
  await writeDocument(workspaceRoot, { format: 1, drafts: document.drafts.map((draft) => draft.id === draftId ? next : draft) });
  return next;
}

function draftsPath(workspaceRoot: string): string {
  return path.join(projectBinyDir(workspaceRoot), "skill-drafts.json");
}

async function ensureRealDirectory(directory: string): Promise<void> {
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`目录不是安全的真实目录：${directory}`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
}

async function writeAtomic(target: string, content: string): Promise<void> {
  try {
    const existing = await fs.lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) throw new Error(`目标文件不安全：${target}`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
  } finally {
    // 写入或 rename 失败时清理残留临时文件；成功后 rename 已消费掉它，force 删除是空操作。
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
