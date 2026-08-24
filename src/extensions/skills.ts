/**
 * Agent Skills 扩展模块（渐进式披露）。
 *
 * 新根回合开始前只扫描 YAML frontmatter 的 name/description 并按总预算拼进 system prompt；
 * 完整指令由显式 `/skill:name` 提交或 invoke_skill 按需读取，references/scripts/assets
 * 仍由 read_skill_resource 按需读取。
 * 默认发现 Biny 受管目录和各 Agent 的标准全局 Skill 根；全局入口中的已有软链会被保留，
 * 项目 Skill 根仍禁止越界软链，避免工作区配置意外扩大运行时读取范围。
 */
import { constants, promises as fs, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { ToolAccesses } from "../tools/access.js";
import type { Tool } from "../tools/types.js";
import { DEFAULT_PROJECT_SKILL_PATHS, defaultGlobalSkillRoots, GLOBAL_SKILL_ROOT_CONVENTIONS, type SkillRootSource } from "./skillRoots.js";
import { resolveSkillActivation } from "./skillActivation.js";
import { createSkillId, createSkillRef } from "./skillRef.js";
import type { SkillRef } from "./skillTypes.js";

const maxDiscoveredSkillCount = 256;
const maxSkillMetadataBytes = 64 * 1024;
const maxSkillInstructionBytes = 512 * 1024;
const maxSkillResourceBytes = 512 * 1024;
const maxSkillDescriptionChars = 1024;
const maxInitialSkillPromptChars = 8_000;
const maxListedSkillResources = 100;

export type SkillScope = "project" | "global";

export interface SkillDefinition {
  ref: SkillRef;
  id: string;
  name: string;
  description: string;
  /** Display path: project skills are workspace-relative, global skills use "~/". */
  path: string;
  /** Canonical absolute path of the skill markdown file. */
  filePath: string;
  /** Root the file must stay inside when it is re-read at invoke time. */
  rootPath: string;
  scope: SkillScope;
}

export interface SkillBundle {
  skills: SkillDefinition[];
  paths: string[];
  prompt: string;
  warnings: string[];
}

export interface LoadSkillsOptions {
  workspaceRoot: string;
  /** Workspace-relative paths from extensions.skills. */
  projectPaths: string[];
  /** Isolated global skill directory; omitted means official, legacy, and admin roots. */
  globalRoot?: string;
  globalDefaults?: Readonly<Record<string, boolean>>;
  projectOverrides?: Readonly<Record<string, boolean>>;
}

interface SkillFileSnapshot {
  device: bigint;
  inode: bigint;
  size: bigint;
  mode: bigint;
  links: bigint;
  modifiedAt: bigint;
  changedAt: bigint;
}

interface SkillFileCandidate {
  path: string;
  snapshot: SkillFileSnapshot;
}

export async function loadSkills(options: LoadSkillsOptions): Promise<SkillBundle> {
  const canonicalWorkspace = await fs.realpath(path.resolve(options.workspaceRoot));
  const skills: SkillDefinition[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const seenNames = new Set<string>();
  // 按根目录优先级扫描；同一 scope 内的同名 Skill 只保留先发现的版本。
  for (const configuredPath of [...new Set([...DEFAULT_PROJECT_SKILL_PATHS, ...options.projectPaths])]) {
    if (skills.length >= maxDiscoveredSkillCount) break;
    if (isOfficialProjectSkillPath(configuredPath)) {
      const repositoryRoot = await findRepositoryRoot(canonicalWorkspace);
      for (const target of officialProjectSkillTargets(canonicalWorkspace, repositoryRoot)) {
        const relative = path.relative(repositoryRoot, target);
        const absolutePath = await resolveRootedSkillPath(repositoryRoot, relative);
        if (!absolutePath) continue;
        const files: SkillFileCandidate[] = [];
        await collectSkillFiles(repositoryRoot, absolutePath, files, seen);
        await appendSkillDefinitions(skills, warnings, repositoryRoot, canonicalWorkspace, files, "project", seenNames, options, sourceForProjectSkill(files[0]?.path, canonicalWorkspace));
      }
      continue;
    }
    const absolutePath = await resolveRootedSkillPath(canonicalWorkspace, configuredPath);
    if (!absolutePath) continue;
    const files: SkillFileCandidate[] = [];
    await collectSkillFiles(canonicalWorkspace, absolutePath, files, seen);
    await appendSkillDefinitions(skills, warnings, canonicalWorkspace, canonicalWorkspace, files, "project", seenNames, options, sourceForProjectSkill(files[0]?.path, canonicalWorkspace));
  }

  // 显式传 globalRoot 时只扫描该目录（测试和嵌入方可隔离）；默认与 SkillHub 使用相同根目录。
  const globalRoots = options.globalRoot
    ? [options.globalRoot]
    : defaultGlobalSkillRoots(os.homedir());
  const resolvedGlobalRoots: Array<{ configuredPath: string; canonicalPath: string }> = [];
  for (const configuredPath of globalRoots) {
    try {
      const canonicalPath = await resolveGlobalSkillRoot(configuredPath);
      if (canonicalPath) resolvedGlobalRoots.push({ configuredPath, canonicalPath });
    } catch (error) {
      warnings.push(`Skipped skill root ${configuredPath}: ${errorMessage(error)}`);
    }
  }
  const allowedGlobalDirectories = [...new Set(resolvedGlobalRoots.map(({ canonicalPath }) => canonicalPath))];
  const globalSeen = new Set<string>();
  for (const { configuredPath, canonicalPath } of resolvedGlobalRoots) {
    if (skills.length >= maxDiscoveredSkillCount) break;
    try {
      const globalFiles: SkillFileCandidate[] = [];
      await collectSkillFiles(canonicalPath, canonicalPath, globalFiles, globalSeen, true, allowedGlobalDirectories);
      await appendSkillDefinitions(skills, warnings, canonicalPath, canonicalWorkspace, globalFiles, "global", seenNames, options, sourceForGlobalRoot(configuredPath));
    } catch (error) {
      warnings.push(`Skipped skill root ${canonicalPath}: ${errorMessage(error)}`);
    }
  }

  if (skills.length >= maxDiscoveredSkillCount) {
    warnings.push(`Only the first ${String(maxDiscoveredSkillCount)} skills were discovered.`);
  }
  return {
    skills,
    paths: skills.map((skill) => skill.path),
    prompt: buildSkillPrompt(skills),
    warnings
  };
}

function isOfficialProjectSkillPath(configuredPath: string): boolean {
  return path.normalize(configuredPath) === path.join(".agents", "skills");
}

/** Codex 从 CWD 逐层扫描到当前仓库根目录；非 Git 目录只扫描当前目录。 */
async function findRepositoryRoot(workspaceRoot: string): Promise<string> {
  let current = workspaceRoot;
  while (true) {
    try {
      await fs.lstat(path.join(current, ".git"));
      return current;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return workspaceRoot;
    current = parent;
  }
}

function officialProjectSkillTargets(workspaceRoot: string, repositoryRoot: string): string[] {
  const targets: string[] = [];
  let current = workspaceRoot;
  while (true) {
    targets.push(path.join(current, ".agents", "skills"));
    if (current === repositoryRoot) return targets;
    const parent = path.dirname(current);
    if (parent === current) return targets;
    current = parent;
  }
}

async function appendSkillDefinitions(
  skills: SkillDefinition[],
  warnings: string[],
  rootPath: string,
  projectRoot: string,
  files: SkillFileCandidate[],
  scope: SkillScope,
  seenNames: Set<string>,
  options: LoadSkillsOptions,
  source: SkillRootSource
): Promise<void> {
  for (const candidate of files.sort((left, right) => left.path.localeCompare(right.path))) {
    if (skills.length >= maxDiscoveredSkillCount) break;
    try {
      const skill = await readSkillMetadata(rootPath, projectRoot, candidate, scope, source);
      if (!resolveSkillActivation({
        ref: skill.ref,
        globalDefaults: options.globalDefaults,
        projectOverrides: options.projectOverrides
      }).enabled) continue;
      const nameKey = `${scope}:${skill.name.toLocaleLowerCase()}`;
      if (seenNames.has(nameKey)) {
        warnings.push(`Skipped duplicate skill ${skill.name} at ${candidate.path}.`);
        continue;
      }
      seenNames.add(nameKey);
      skills.push(skill);
    } catch (error) {
      warnings.push(`Skipped ${candidate.path}: ${errorMessage(error)}`);
    }
  }
}

function buildSkillPrompt(skills: SkillDefinition[]): string {
  if (!skills.length) return "";
  const header = "Available skills (metadata only; full instructions are not loaded yet):";
  const footer = "Before doing a task that matches a skill, call invoke_skill with its name. A $skill-name mention is an explicit invocation and must be honored. When names are duplicated, also pass the listed path. If a user submits /skill:name, its full instructions are already included in that message; follow them without loading the same Skill again.";
  const render = (descriptionLimit: number, limit = skills.length): string => {
    const lines = skills.slice(0, limit).map((skill) => {
      const description = truncateChars(skill.description, descriptionLimit);
      return `- ${skill.name} (${skill.scope}) [${skill.path}]: ${description}`;
    });
    const omitted = skills.length - limit;
    if (omitted > 0) lines.push(`Warning: ${String(omitted)} additional skills were omitted from the initial list. Use /skills to inspect all skills.`);
    return [header, ...lines, footer].join("\n");
  };
  for (const descriptionLimit of [maxSkillDescriptionChars, 300, 160, 80]) {
    const prompt = render(descriptionLimit);
    if (prompt.length <= maxInitialSkillPromptChars) return prompt;
  }
  let visible = skills.length;
  while (visible > 0 && render(80, visible).length > maxInitialSkillPromptChars) visible -= 1;
  return render(80, visible);
}

const invokeSkillArgsSchema = z.object({
  skill: z.string().trim().min(1),
  path: z.string().trim().min(1).optional()
});

type SkillBundleSource = SkillBundle | (() => SkillBundle);

/**
 * 按 Pi 的交互约定展开 `/skill:name args`。
 *
 * 补全阶段只需要元数据；用户提交后才在这里重新读取正文，避免把所有
 * Skill 指令提前塞进上下文。未知 Skill 保留原输入，让模型自行处理。
 */
export async function expandSkillCommand(bundle: SkillBundle, input: string): Promise<string> {
  if (!input.startsWith("/skill:")) return input;
  const spaceIndex = input.indexOf(" ");
  const skillName = spaceIndex === -1 ? input.slice("/skill:".length) : input.slice("/skill:".length, spaceIndex);
  const args = spaceIndex === -1 ? "" : input.slice(spaceIndex + 1).trim();
  const skill = bundle.skills.find((candidate) => candidate.name === skillName);
  if (!skill) return input;

  const content = await readSkillFileFresh(skill.rootPath, skill.filePath, maxSkillInstructionBytes);
  let body = content;
  try {
    const parsed = splitFrontmatter(content);
    if (path.basename(skill.filePath) === "SKILL.md" || parsed.frontmatter.name || parsed.frontmatter.description) {
      body = parsed.body;
    }
  } catch (error) {
    if (path.basename(skill.filePath) === "SKILL.md") throw error;
  }
  const skillBlock = [
    `<skill name="${skill.name}" location="${skill.filePath}">`,
    `References are relative to ${path.dirname(skill.filePath)}.`,
    "",
    body.trim(),
    "</skill>"
  ].join("\n");
  return args ? `${skillBlock}\n\n${args}` : skillBlock;
}

export function createSkillTool(source: SkillBundleSource): Tool {
  return {
    name: "invoke_skill",
    description: "Load the full instructions of an available skill by name. Call this before performing a task that a listed skill covers, then follow the returned instructions.",
    promptSnippet: "Load the full instructions for an available skill",
    parameters: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill name exactly as listed in the available skills." },
        path: { type: "string", description: "Listed skill path. Required only when multiple skills have the same name." }
      },
      required: ["skill"],
      additionalProperties: false
    },
    schema: invokeSkillArgsSchema,
    source: "skill",
    capability: "skills",
    risk: "read",
    resolveExecution(args: unknown) {
      const parsed = invokeSkillArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { isError: true as const, result: "invoke_skill requires a skill name.", errorMessage: "invoke_skill requires a skill name." };
      }
      const requested = parsed.data.skill;
      const bundle = currentBundle(source);
      const resolved = resolveSkill(bundle, requested, parsed.data.path);
      if (typeof resolved === "string") {
        const message = resolved;
        return { isError: true as const, result: message, errorMessage: message };
      }
      const definition = resolved;
      return {
        accesses: ToolAccesses.readFile(definition.filePath),
        display: { kind: "generic" as const, summary: `Skill ${definition.name}`, detail: { path: definition.path } },
        description: `Load skill instructions from ${definition.path}`,
        approvalRule: `invoke_skill:${definition.name}`,
        async execute(): Promise<unknown> {
          const content = await readSkillFileFresh(definition.rootPath, definition.filePath, maxSkillInstructionBytes);
          let body = content;
          try {
            const parsed = splitFrontmatter(content);
            if (path.basename(definition.filePath) === "SKILL.md" || parsed.frontmatter.name || parsed.frontmatter.description) {
              body = parsed.body;
            }
          } catch (error) {
            if (path.basename(definition.filePath) === "SKILL.md") throw error;
          }
          const resources = await listSkillResources(definition.filePath);
          const result: Record<string, unknown> = {
            skill: definition.name,
            scope: definition.scope,
            path: definition.path,
            instructions: body.trim() || content.trim(),
            resourceRoot: path.dirname(definition.filePath),
            resources
          };
          return result;
        }
      };
    }
  };
}

const readSkillResourceArgsSchema = z.object({
  skill: z.string().trim().min(1),
  path: z.string().trim().min(1),
  skillPath: z.string().trim().min(1).optional()
});

/** 第三级渐进式披露：只在 SKILL.md 明确需要时读取 references/scripts/assets。 */
export function createSkillResourceTool(source: SkillBundleSource): Tool {
  return {
    name: "read_skill_resource",
    description: "Read a text resource from an activated skill. Use a relative path listed by invoke_skill.",
    promptSnippet: "Read a referenced text resource from an activated skill",
    parameters: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Activated skill name." },
        path: { type: "string", description: "Resource path relative to the skill directory." },
        skillPath: { type: "string", description: "Listed skill path when the name is ambiguous." }
      },
      required: ["skill", "path"],
      additionalProperties: false
    },
    schema: readSkillResourceArgsSchema,
    source: "skill",
    capability: "skills",
    risk: "read",
    async resolveExecution(args: unknown) {
      const parsed = readSkillResourceArgsSchema.safeParse(args);
      if (!parsed.success) {
        const message = "read_skill_resource requires a skill name and relative resource path.";
        return { isError: true as const, result: message, errorMessage: message };
      }
      const resolved = resolveSkill(currentBundle(source), parsed.data.skill, parsed.data.skillPath);
      if (typeof resolved === "string") return { isError: true as const, result: resolved, errorMessage: resolved };
      let resourcePath: string;
      try {
        resourcePath = resolveSkillResourcePath(resolved, parsed.data.path);
        await assertReadableSkillResource(resolved, resourcePath);
      } catch (error) {
        const message = errorMessage(error);
        return { isError: true as const, result: message, errorMessage: message };
      }
      return {
        accesses: ToolAccesses.readFile(resourcePath),
        display: { kind: "file_io" as const, operation: "read" as const, path: parsed.data.path },
        description: `Read ${parsed.data.path} from skill ${resolved.name}`,
        approvalRule: `read_skill_resource:${resolved.name}:${parsed.data.path}`,
        async execute(): Promise<unknown> {
          return {
            skill: resolved.name,
            skillPath: resolved.path,
            path: parsed.data.path,
            content: await readSkillResourceFresh(resolved, resourcePath)
          };
        }
      };
    }
  };
}

function currentBundle(source: SkillBundleSource): SkillBundle {
  return typeof source === "function" ? source() : source;
}

function resolveSkill(bundle: SkillBundle, requested: string, requestedPath?: string): SkillDefinition | string {
  const matches = bundle.skills.filter((skill) => skill.name.toLowerCase() === requested.toLowerCase());
  const selected = requestedPath ? matches.find((skill) => skill.path === requestedPath) : matches[0];
  if (!matches.length || !selected) {
    const known = bundle.skills.map((skill) => `${skill.name} [${skill.path}]`).join(", ") || "none";
    return `Unknown skill: ${requested}${requestedPath ? ` at ${requestedPath}` : ""}. Available skills: ${known}.`;
  }
  if (!requestedPath && matches.length > 1) {
    return `Skill name is ambiguous: ${requested}. Pass one of these paths: ${matches.map((skill) => skill.path).join(", ")}.`;
  }
  return selected;
}

async function readSkillMetadata(rootPath: string, projectRoot: string, candidate: SkillFileCandidate, scope: SkillScope, source: SkillRootSource): Promise<SkillDefinition> {
  const content = await readBoundedSkillFile(rootPath, candidate, maxSkillMetadataBytes);
  const standardSkill = path.basename(candidate.path) === "SKILL.md";
  let frontmatter: SkillFrontmatter = {};
  let body = content;
  try {
    ({ frontmatter, body } = splitFrontmatter(content));
    if (!standardSkill && !frontmatter.name && !frontmatter.description) body = content;
  } catch (error) {
    if (standardSkill) throw error;
  }
  const fallbackName = deriveSkillName(candidate.path);
  const name = frontmatter.name ?? (standardSkill ? undefined : fallbackName);
  if (!name) throw new Error("SKILL.md frontmatter must include name.");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error(`Invalid skill name: ${name}. Use 1-64 lowercase letters, numbers, and single hyphens.`);
  }
  if (standardSkill && path.basename(path.dirname(candidate.path)) !== name) {
    throw new Error(`Skill name ${name} must match its directory name.`);
  }
  if (standardSkill && !frontmatter.description) throw new Error("SKILL.md frontmatter must include description.");
  const rawDescription = (frontmatter.description ?? firstDescriptiveLine(body) ?? "No description provided.").trim();
  if (standardSkill && rawDescription.length > maxSkillDescriptionChars) {
    throw new Error(`Skill description exceeds ${String(maxSkillDescriptionChars)} characters.`);
  }
  const description = truncateChars(rawDescription, maxSkillDescriptionChars);
  if (!description) throw new Error("Skill description cannot be empty.");
  const relative = path.relative(rootPath, candidate.path);
  const ref = createSkillRef({ scope, name, projectRoot: scope === "project" ? projectRoot : undefined, source });
  return {
    ref,
    id: createSkillId(ref),
    name,
    description,
    path: scope === "global" ? globalDisplayPath(rootPath, relative) : relative,
    filePath: candidate.path,
    rootPath,
    scope
  };
}

/** 全局技能展示路径：在 home 下时用 "~" 缩写，否则用实际绝对路径。 */
function globalDisplayPath(rootPath: string, relative: string): string {
  const fromHome = path.relative(os.homedir(), rootPath);
  if (fromHome && !fromHome.startsWith("..") && !path.isAbsolute(fromHome)) return path.join("~", fromHome, relative);
  return path.join(rootPath, relative);
}

function sourceForProjectSkill(candidatePath: string | undefined, projectRoot: string): SkillRootSource {
  if (candidatePath === undefined) return "biny";
  const relative = path.relative(projectRoot, candidatePath).split(path.sep).join("/");
  return relative.startsWith(".agents/skills/") || relative === ".agents/skills" ? "agents" : "biny";
}

function sourceForGlobalRoot(configuredPath: string): SkillRootSource {
  const relative = path.relative(os.homedir(), path.resolve(configuredPath)).split(path.sep).join("/");
  return GLOBAL_SKILL_ROOT_CONVENTIONS.find((convention) => convention.relativePath === relative)?.source ?? "agents";
}

/** SKILL.md 用上级目录名作为技能名，普通 .md 用文件名主干。 */
function deriveSkillName(filePath: string): string {
  const stem = path.basename(filePath, path.extname(filePath));
  if (path.basename(filePath) === "SKILL.md") return path.basename(path.dirname(filePath));
  return stem;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
}

function splitFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const opening = /^---[ \t]*\r?\n/.exec(content);
  if (!opening) return { frontmatter: {}, body: content };
  const closingPattern = /^---[ \t]*\r?$/gm;
  closingPattern.lastIndex = opening[0].length;
  const closing = closingPattern.exec(content);
  if (!closing) return { frontmatter: {}, body: content };
  const raw = content.slice(opening[0].length, closing.index);
  const document = parseDocument(raw, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`Invalid SKILL.md YAML: ${document.errors[0]?.message ?? "unknown error"}`);
  const value = document.toJS({ maxAliasCount: 0 });
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("SKILL.md frontmatter must be a YAML mapping.");
  const record = value as Record<string, unknown>;
  const name = stringMetadata(record.name, "name");
  const description = stringMetadata(record.description, "description");
  let bodyStart = closing.index + closing[0].length;
  if (content.startsWith("\r\n", bodyStart)) bodyStart += 2;
  else if (content.startsWith("\n", bodyStart)) bodyStart += 1;
  return { frontmatter: { name, description }, body: content.slice(bodyStart) };
}

function stringMetadata(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`SKILL.md ${field} must be a string.`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function firstDescriptiveLine(body: string): string | undefined {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed === "---") continue;
    return trimmed;
  }
  return undefined;
}

function truncateChars(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

interface SkillResourceEntry {
  path: string;
  kind: "script" | "reference" | "asset" | "file";
  size: number;
}

/** 枚举标准资源目录，内容仍由 read_skill_resource 第三级按需读取。 */
async function listSkillResources(skillFilePath: string): Promise<SkillResourceEntry[]> {
  if (path.basename(skillFilePath) !== "SKILL.md") return [];
  const skillRoot = path.dirname(skillFilePath);
  const resources: SkillResourceEntry[] = [];
  const visit = async (directory: string): Promise<void> => {
    if (resources.length >= maxListedSkillResources) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (resources.length >= maxListedSkillResources) return;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(target);
        continue;
      }
      if (!entry.isFile() || target === skillFilePath) continue;
      try {
        const stat = await fs.lstat(target, { bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || await escapesRoot(skillRoot, target)) continue;
        const relative = path.relative(skillRoot, target);
        const top = relative.split(path.sep, 1)[0]?.toLowerCase();
        resources.push({
          path: relative,
          kind: top === "scripts" ? "script" : top === "references" ? "reference" : top === "assets" ? "asset" : "file",
          size: Number(stat.size)
        });
      } catch {
        // 单个资源异常不影响 Skill 正文。
      }
    }
  };
  await visit(skillRoot);
  return resources;
}

function resolveSkillResourcePath(skill: SkillDefinition, resource: string): string {
  if (path.isAbsolute(resource)) throw new Error("Skill resource path must be relative.");
  const skillRoot = path.dirname(skill.filePath);
  const target = path.resolve(skillRoot, resource);
  const relative = path.relative(skillRoot, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Skill resource escapes its skill directory: ${resource}`);
  }
  return target;
}

async function assertReadableSkillResource(skill: SkillDefinition, resourcePath: string): Promise<void> {
  const stat = await fs.lstat(resourcePath, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error(`Skill resource cannot be a symbolic link: ${resourcePath}`);
  if (!stat.isFile()) throw new Error(`Skill resource is not a file: ${resourcePath}`);
  if (stat.nlink !== 1n) throw new Error(`Skill resources cannot be hardlinks: ${resourcePath}`);
  if (await escapesRoot(path.dirname(skill.filePath), resourcePath)) throw new Error(`Skill resource escapes its skill directory: ${resourcePath}`);
  if (stat.size > BigInt(maxSkillResourceBytes)) {
    throw new Error(`Skill resource exceeds ${String(maxSkillResourceBytes)} bytes: ${resourcePath}`);
  }
}

async function readSkillResourceFresh(skill: SkillDefinition, resourcePath: string): Promise<string> {
  await assertReadableSkillResource(skill, resourcePath);
  const stat = await fs.lstat(resourcePath, { bigint: true });
  const content = await readBoundedSkillFile(
    path.dirname(skill.filePath),
    { path: resourcePath, snapshot: skillSnapshot(stat) },
    maxSkillResourceBytes,
    true
  );
  if (content.includes("\0")) throw new Error(`Skill resource is binary and cannot be read as text: ${resourcePath}`);
  return content;
}

/** invoke 时重新校验并读取，允许文件在会话期间被正常编辑，但保持符号链接/硬链接/越界防御。 */
async function readSkillFileFresh(rootPath: string, filePath: string, maxBytes: number): Promise<string> {
  const stat = await fs.lstat(filePath, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error(`Skill file cannot be a symbolic link: ${filePath}`);
  if (!stat.isFile()) throw new Error(`Skill path is not a file: ${filePath}`);
  if (stat.nlink !== 1n) throw new Error(`Skill files cannot be hardlinks: ${filePath}`);
  if (await escapesRoot(rootPath, filePath)) throw new Error(`Skill file escapes its root: ${filePath}`);
  return await readBoundedSkillFile(rootPath, { path: filePath, snapshot: skillSnapshot(stat) }, maxBytes, true);
}

async function collectSkillFiles(
  rootPath: string,
  target: string,
  files: SkillFileCandidate[],
  seen: Set<string>,
  allowDirectDirectorySymlink = false,
  allowedDirectorySymlinks: readonly string[] = []
): Promise<void> {
  if (files.length >= maxDiscoveredSkillCount) return;
  let stat;
  try {
    stat = await fs.lstat(target, { bigint: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return;
  }
  if (stat.isSymbolicLink()) {
    // 全局 Skill 根本身是用户主动登记的入口，允许其第一层目录软链指向
    // Claude/Codex/Cindy 等已有技能；进入技能目录后仍禁止内部软链。
    if (!allowDirectDirectorySymlink || path.dirname(target) !== rootPath) return;
    const canonical = await fs.realpath(target);
    if (!allowedDirectorySymlinks.some((directory) => isPathInside(directory, canonical))) return;
    const linkedStat = await fs.lstat(canonical, { bigint: true });
    if (!linkedStat.isDirectory()) return;
    await collectSkillFiles(canonical, canonical, files, seen);
    return;
  }
  if (await escapesRoot(rootPath, target)) throw new Error(`Skill path escapes workspace: ${target}`);
  if (stat.isFile()) {
    if (stat.nlink !== 1n) throw new Error(`Skill files cannot be hardlinks: ${target}`);
    if (path.extname(target).toLowerCase() === ".md" && !seen.has(target)) {
      seen.add(target);
      files.push({ path: target, snapshot: skillSnapshot(stat) });
    }
    return;
  }
  if (!stat.isDirectory()) return;
  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch {
    return;
  }
  // 目录式技能只认 SKILL.md，避免把技能附带的文档一起当成独立技能。
  const skillEntry = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md");
  if (skillEntry) {
    await collectSkillFiles(rootPath, path.join(target, skillEntry.name), files, seen);
    return;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === ".git") continue;
    await collectSkillFiles(rootPath, path.join(target, entry.name), files, seen);
    if (files.length >= maxDiscoveredSkillCount) return;
  }
}

async function resolveRootedSkillPath(rootPath: string, configuredPath: string): Promise<string | undefined> {
  const absolutePath = path.resolve(rootPath, configuredPath);
  const relative = path.relative(rootPath, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Skill path must stay inside workspace: ${configuredPath}`);
  }
  try {
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) return undefined;
    const canonical = await fs.realpath(absolutePath);
    if (path.relative(rootPath, canonical).startsWith(`..${path.sep}`) || path.isAbsolute(path.relative(rootPath, canonical))) {
      throw new Error(`Skill path escapes workspace: ${configuredPath}`);
    }
    if (canonical !== absolutePath) throw new Error(`Skill paths cannot contain symbolic links: ${configuredPath}`);
    return canonical;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** 全局技能根目录允许通过符号链接到达（如 macOS 的 /tmp），但内部仍禁止软链。 */
async function resolveGlobalSkillRoot(globalRoot: string): Promise<string | undefined> {
  try {
    const canonical = await fs.realpath(path.resolve(globalRoot));
    const stat = await fs.lstat(canonical);
    return stat.isDirectory() ? canonical : undefined;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
  return value.slice(0, end);
}

async function readBoundedSkillFile(
  rootPath: string,
  candidate: SkillFileCandidate,
  maxBytes: number,
  rejectOverflow = false
): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await fs.open(candidate.path, constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (isSymbolicLinkError(error)) throw new Error(`Skill file changed to a symbolic link before it could be read: ${candidate.path}`);
    throw error;
  }

  try {
    const initial = await assertSkillFileBinding(rootPath, candidate, handle);
    const chunks: Buffer[] = [];
    const readLimit = maxBytes + 4;
    let bytesRead = 0;
    while (bytesRead < readLimit) {
      const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, readLimit - bytesRead));
      const result = await handle.read(chunk, 0, chunk.length, bytesRead);
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      bytesRead += result.bytesRead;
    }
    const current = await assertSkillFileBinding(rootPath, candidate, handle);
    if (!sameSkillSnapshot(initial, current)) throw new Error(`Skill file changed while it was being read: ${candidate.path}`);
    if (rejectOverflow && bytesRead > maxBytes) {
      throw new Error(`Skill file exceeds ${String(maxBytes)} bytes: ${candidate.path}`);
    }
    return truncateUtf8(Buffer.concat(chunks, bytesRead).toString("utf8"), maxBytes);
  } finally {
    await handle.close();
  }
}

async function assertSkillFileBinding(
  rootPath: string,
  candidate: SkillFileCandidate,
  handle: FileHandle
): Promise<SkillFileSnapshot> {
  const descriptorStat = await handle.stat({ bigint: true });
  const pathStat = await fs.lstat(candidate.path, { bigint: true });
  const canonical = await fs.realpath(candidate.path);
  const relative = path.relative(rootPath, canonical);
  const snapshot = skillSnapshot(descriptorStat);
  if (
    !descriptorStat.isFile()
    || descriptorStat.nlink !== 1n
    || pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || pathStat.nlink !== 1n
    || descriptorStat.dev !== pathStat.dev
    || descriptorStat.ino !== pathStat.ino
    || canonical !== candidate.path
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
    || !sameSkillSnapshot(candidate.snapshot, snapshot)
  ) {
    throw new Error(`Skill file changed after validation: ${candidate.path}`);
  }
  return snapshot;
}

function skillSnapshot(stat: BigIntStats): SkillFileSnapshot {
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mode: stat.mode,
    links: stat.nlink,
    modifiedAt: stat.mtimeNs,
    changedAt: stat.ctimeNs
  };
}

function sameSkillSnapshot(left: SkillFileSnapshot, right: SkillFileSnapshot): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mode === right.mode
    && left.links === right.links
    && left.modifiedAt === right.modifiedAt
    && left.changedAt === right.changedAt;
}

async function escapesRoot(rootPath: string, target: string): Promise<boolean> {
  const canonical = await fs.realpath(target);
  const relative = path.relative(rootPath, canonical);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function isSymbolicLinkError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ELOOP" || error.code === "EMLINK");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
