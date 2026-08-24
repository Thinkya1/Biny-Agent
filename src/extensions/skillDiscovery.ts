/**
 * SkillHub 的远程发现能力。
 *
 * 仓库扫描和 skills.sh 请求都在主进程执行；Renderer 只拿经过字段、URL 和大小限制的
 * 元数据。安装时重新解析 GitHub tree，并把技能目录原子写入 `~/.biny/skills`。
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { globalConfigDir } from "../config/paths.js";
import { parseSkillDocument } from "./skillCatalog.js";

const githubApiBase = "https://api.github.com";
const skillsShApi = "https://skills.sh/api/search";
const maxRepositories = 32;
const maxDiscoveredSkills = 256;
const maxTreeEntries = 4_096;
const maxSkillFiles = 512;
const maxSkillBytes = 32 * 1024 * 1024;
const maxMetadataBytes = 512 * 1024;
const maxResponseBytes = 12 * 1024 * 1024;
const skillRepositoryFile = "skill-repositories.json";

export interface SkillRepository {
  owner: string;
  name: string;
  branch: string;
  enabled: boolean;
}

export interface DiscoverableSkill {
  key: string;
  name: string;
  description: string;
  directory: string;
  readmeUrl?: string;
  repoOwner: string;
  repoName: string;
  repoBranch: string;
  installed: boolean;
}

export interface SkillsShDiscoverableSkill {
  key: string;
  name: string;
  directory: string;
  repoOwner: string;
  repoName: string;
  repoBranch: string;
  installs: number;
  readmeUrl?: string;
  installed: boolean;
}

export interface SkillsShSearchResult {
  skills: SkillsShDiscoverableSkill[];
  totalCount: number;
  query: string;
}

export interface SkillDiscoverySnapshot {
  repositories: SkillRepository[];
  skills: DiscoverableSkill[];
  warnings: string[];
}

export interface SkillInstallResult {
  name: string;
  directory: string;
  installedPath: string;
}

interface GitTreeEntry {
  path: string;
  mode?: string;
  type?: string;
  size?: number;
}

interface GitTreeResponse {
  tree?: GitTreeEntry[];
  truncated?: boolean;
}

interface SkillsShResponse {
  query?: string;
  skills?: Array<{
    id?: string;
    skillId?: string;
    name?: string;
    installs?: number;
    source?: string;
  }>;
  count?: number;
}

interface SkillRepositoryFile {
  repositories: SkillRepository[];
}

const defaultSkillRepositories: readonly SkillRepository[] = [
  { owner: "anthropics", name: "skills", branch: "main", enabled: true },
  { owner: "ComposioHQ", name: "awesome-claude-skills", branch: "master", enabled: true },
  { owner: "cexll", name: "myclaude", branch: "master", enabled: true },
  { owner: "JimLiu", name: "baoyu-skills", branch: "main", enabled: true }
];

export function defaultSkillRepos(): SkillRepository[] {
  return defaultSkillRepositories.map((repo) => ({ ...repo }));
}

export function skillRepositoriesPath(homeDir = os.homedir()): string {
  return path.join(globalConfigDir({ homeDir }), skillRepositoryFile);
}

export async function listSkillRepositories(homeDir = os.homedir()): Promise<{ repositories: SkillRepository[]; warnings: string[] }> {
  const filePath = skillRepositoriesPath(homeDir);
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 128 * 1024) {
      return { repositories: defaultSkillRepos(), warnings: [`跳过不安全的 Skill 仓库配置：${filePath}`] };
    }
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!isRepositoryList(parsed)) {
      return { repositories: defaultSkillRepos(), warnings: [`Skill 仓库配置格式无效，已使用默认仓库：${filePath}`] };
    }
    return { repositories: parsed.repositories, warnings: [] };
  } catch (error) {
    if (isNotFound(error)) return { repositories: defaultSkillRepos(), warnings: [] };
    return { repositories: defaultSkillRepos(), warnings: [`无法读取 Skill 仓库配置：${errorMessage(error)}`] };
  }
}

export async function addSkillRepository(repository: SkillRepository, homeDir = os.homedir()): Promise<SkillRepository[]> {
  assertRepository(repository);
  const current = await listSkillRepositories(homeDir);
  const next = [...current.repositories];
  const index = next.findIndex((item) => item.owner.toLowerCase() === repository.owner.toLowerCase() && item.name.toLowerCase() === repository.name.toLowerCase());
  if (index === -1) next.push({ ...repository });
  else next[index] = { ...repository };
  await writeRepositories(homeDir, next);
  return next;
}

export async function removeSkillRepository(owner: string, name: string, homeDir = os.homedir()): Promise<SkillRepository[]> {
  assertRepository({ owner, name, branch: "main", enabled: true });
  const current = await listSkillRepositories(homeDir);
  const next = current.repositories.filter((item) => item.owner.toLowerCase() !== owner.toLowerCase() || item.name.toLowerCase() !== name.toLowerCase());
  await writeRepositories(homeDir, next);
  return next;
}

export async function discoverSkillRepositories(options: {
  repositories: SkillRepository[];
  fetcher?: typeof globalThis.fetch;
  installedNames?: ReadonlySet<string>;
}): Promise<{ skills: DiscoverableSkill[]; warnings: string[] }> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const repositories = options.repositories.filter((repo) => repo.enabled).slice(0, maxRepositories);
  const results = await mapWithConcurrency(repositories, 4, async (repository) => {
    try {
      return await discoverRepository(repository, fetcher, options.installedNames ?? new Set<string>());
    } catch (error) {
      return { skills: [], warning: `无法读取仓库 ${repository.owner}/${repository.name}：${errorMessage(error)}` };
    }
  });
  const skills = deduplicateSkills(results.flatMap((result) => result.skills)).slice(0, maxDiscoveredSkills);
  return {
    skills,
    warnings: results.flatMap((result) => result.warning === undefined ? [] : [result.warning])
  };
}

export async function searchSkillsSh(options: {
  query: string;
  limit?: number;
  offset?: number;
  fetcher?: typeof globalThis.fetch;
  installedNames?: ReadonlySet<string>;
}): Promise<SkillsShSearchResult> {
  const query = options.query.trim();
  if (query.length < 2) throw new Error("skills.sh 搜索词至少需要 2 个字符。");
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const offset = Math.min(Math.max(options.offset ?? 0, 0), 10_000);
  const url = new URL(skillsShApi);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  const response = await fetchJson<SkillsShResponse>(options.fetcher ?? globalThis.fetch, url.toString(), maxResponseBytes);
  const installedNames = options.installedNames ?? new Set<string>();
  const skills = (response.skills ?? []).flatMap((item) => {
    if (typeof item.source !== "string" || typeof item.skillId !== "string" || typeof item.name !== "string") return [];
    const [owner, repo] = item.source.split("/");
    if (!owner || !repo || !isValidOwner(owner) || !isValidRepoName(repo) || !isSafeSkillPath(item.skillId)) return [];
    const directory = item.skillId;
    const installName = lastPathSegment(directory);
    return [{
      key: typeof item.id === "string" && item.id ? item.id : `${owner}/${repo}:${directory}`,
      name: item.name,
      directory,
      repoOwner: owner,
      repoName: repo,
      repoBranch: "main",
      installs: typeof item.installs === "number" && Number.isFinite(item.installs) ? Math.max(0, Math.floor(item.installs)) : 0,
      readmeUrl: `https://github.com/${owner}/${repo}`,
      installed: isInstalledName(installedNames, item.name, installName)
    } satisfies SkillsShDiscoverableSkill];
  });
  return { skills, totalCount: typeof response.count === "number" ? Math.max(0, Math.floor(response.count)) : skills.length, query: typeof response.query === "string" ? response.query : query };
}

export async function installDiscoveredSkill(options: {
  skill: Pick<DiscoverableSkill, "name" | "directory" | "repoOwner" | "repoName" | "repoBranch">;
  homeDir?: string;
  fetcher?: typeof globalThis.fetch;
}): Promise<SkillInstallResult> {
  const { skill } = options;
  const repository: SkillRepository = { owner: skill.repoOwner, name: skill.repoName, branch: skill.repoBranch, enabled: true };
  assertRepository(repository);
  if (!isSafeSkillPath(skill.directory)) throw new Error("Skill 目录路径无效。");
  const fetcher = options.fetcher ?? globalThis.fetch;
  const { tree, branch } = await fetchRepositoryTreeWithFallback(repository, fetcher);
  const sourceDirectory = resolveSkillDirectory(tree, skill.directory);
  if (sourceDirectory === undefined) throw new Error(`仓库中找不到 Skill 目录：${skill.directory}`);
  const files = tree.filter((entry) => entry.type === "blob" && entry.mode !== "120000" && isInsideRepoDirectory(sourceDirectory, entry.path));
  if (!files.some((entry) => path.posix.basename(entry.path).toLowerCase() === "skill.md")) throw new Error("仓库 Skill 目录缺少 SKILL.md。");
  if (files.length > maxSkillFiles) throw new Error(`Skill 文件数量超过 ${String(maxSkillFiles)} 个。`);
  const expectedBytes = files.reduce((total, entry) => total + (typeof entry.size === "number" ? entry.size : 0), 0);
  if (expectedBytes > maxSkillBytes) throw new Error(`Skill 总大小超过 ${String(maxSkillBytes)} 字节。`);

  const homeDir = options.homeDir ?? os.homedir();
  const managedRoot = path.join(homeDir, ".biny", "skills");
  await ensureDirectory(managedRoot);
  const installName = lastPathSegment(sourceDirectory === "." ? skill.directory : sourceDirectory);
  assertSafeDirectoryName(installName);
  const target = path.join(managedRoot, installName);
  if (await pathExists(target)) throw new Error(`Skill 已安装：${installName}`);
  const temporary = path.join(managedRoot, `.${installName}.biny-discovery-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    await fs.mkdir(temporary);
    const downloaded = await mapWithConcurrency(files, 6, async (entry) => ({
      entry,
      content: await fetchBytes(fetcher, githubRawUrl({ ...repository, branch }, entry.path), maxSkillBytes)
    }));
    let totalBytes = 0;
    for (const item of downloaded) {
      totalBytes += item.content.byteLength;
      if (totalBytes > maxSkillBytes) throw new Error(`Skill 总大小超过 ${String(maxSkillBytes)} 字节。`);
      const relative = sourceDirectory === "." ? item.entry.path : item.entry.path.slice(`${sourceDirectory}/`.length);
      if (!isSafeSkillPath(relative)) throw new Error(`仓库文件路径无效：${item.entry.path}`);
      const targetFile = path.join(temporary, ...relative.split("/"));
      await fs.mkdir(path.dirname(targetFile), { recursive: true });
      await fs.writeFile(targetFile, item.content, { flag: "wx", mode: 0o644 });
    }
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { name: skill.name, directory: sourceDirectory, installedPath: target };
}

async function discoverRepository(repository: SkillRepository, fetcher: typeof globalThis.fetch, installedNames: ReadonlySet<string>): Promise<{ skills: DiscoverableSkill[]; warning?: string }> {
  const tree = await fetchRepositoryTree(repository, fetcher);
  const skillDocuments = tree.filter((entry) => entry.type === "blob" && entry.mode !== "120000" && path.posix.basename(entry.path).toLowerCase() === "skill.md").slice(0, maxDiscoveredSkills);
  const skills = await mapWithConcurrency(skillDocuments, 8, async (entry) => {
    try {
      const raw = await fetchText(fetcher, githubRawUrl(repository, entry.path), maxMetadataBytes);
      const parsed = parseSkillDocument(raw);
      const directory = path.posix.dirname(entry.path) === "." ? repository.name : path.posix.dirname(entry.path);
      const name = typeof parsed.frontmatter.name === "string" && parsed.frontmatter.name.trim() ? parsed.frontmatter.name.trim() : lastPathSegment(directory);
      const descriptionValue = parsed.frontmatter.description;
      const description = typeof descriptionValue === "string" && descriptionValue.trim() ? descriptionValue.trim() : firstDescriptionLine(parsed.body) ?? "暂无描述";
      return {
        key: `${repository.owner}/${repository.name}:${directory}`,
        name,
        description: truncate(description, 500),
        directory,
        readmeUrl: `https://github.com/${repository.owner}/${repository.name}/tree/${encodeBranch(repository.branch)}/${directory === repository.name ? "" : directory}`,
        repoOwner: repository.owner,
        repoName: repository.name,
        repoBranch: repository.branch,
        installed: isInstalledName(installedNames, name, lastPathSegment(directory))
      } satisfies DiscoverableSkill;
    } catch {
      return undefined;
    }
  });
  return { skills: skills.flatMap((skill) => skill === undefined ? [] : [skill]) };
}

async function fetchRepositoryTree(repository: SkillRepository, fetcher: typeof globalThis.fetch): Promise<GitTreeEntry[]> {
  assertRepository(repository);
  const url = `${githubApiBase}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/trees/${encodeBranch(repository.branch)}?recursive=1`;
  const response = await fetchJson<GitTreeResponse>(fetcher, url, maxResponseBytes);
  if (!Array.isArray(response.tree)) throw new Error("GitHub 返回的仓库目录格式无效。");
  if (response.truncated || response.tree.length > maxTreeEntries) throw new Error(`仓库目录超过 ${String(maxTreeEntries)} 个条目。`);
  return response.tree.filter((entry) => typeof entry.path === "string" && isSafeSkillPath(entry.path));
}

async function fetchRepositoryTreeWithFallback(repository: SkillRepository, fetcher: typeof globalThis.fetch): Promise<{ tree: GitTreeEntry[]; branch: string }> {
  const branches = [...new Set([repository.branch, "main", "master"])];
  let lastError: unknown;
  for (const branch of branches) {
    try {
      return { tree: await fetchRepositoryTree({ ...repository, branch }, fetcher), branch };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("无法读取 Skill 仓库。");
}

function resolveSkillDirectory(tree: readonly GitTreeEntry[], directory: string): string | undefined {
  const normalized = directory.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  const directories = [...new Set(tree
    .filter((entry) => entry.type === "blob" && path.posix.basename(entry.path).toLowerCase() === "skill.md")
    .map((entry) => path.posix.dirname(entry.path)))];
  const direct = directories.find((candidate) => candidate === normalized);
  if (direct !== undefined) return direct;
  const name = lastPathSegment(normalized);
  const byName = directories.find((candidate) => lastPathSegment(candidate).toLocaleLowerCase() === name.toLocaleLowerCase());
  if (byName !== undefined) return byName;
  return directories.includes(".") ? "." : undefined;
}

function isInsideRepoDirectory(directory: string, filePath: string): boolean {
  return directory === "." || filePath.startsWith(`${directory}/`);
}

function githubRawUrl(repository: SkillRepository, filePath: string): string {
  const encodedPath = filePath.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/${encodeBranch(repository.branch)}/${encodedPath}`;
}

function encodeBranch(branch: string): string {
  return branch.split("/").map((part) => encodeURIComponent(part)).join("/");
}

async function fetchJson<T>(fetcher: typeof globalThis.fetch, url: string, maxBytes: number): Promise<T> {
  const response = await fetcher(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "Biny SkillHub" },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`远程服务返回 HTTP ${String(response.status)}。`);
  const text = await boundedResponseText(response, maxBytes);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error("远程服务返回的 JSON 无法解析。", { cause: error });
  }
}

async function fetchText(fetcher: typeof globalThis.fetch, url: string, maxBytes: number): Promise<string> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "Biny SkillHub" } });
  if (!response.ok) throw new Error(`远程文件返回 HTTP ${String(response.status)}。`);
  return await boundedResponseText(response, maxBytes);
}

async function fetchBytes(fetcher: typeof globalThis.fetch, url: string, maxBytes: number): Promise<Uint8Array> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "Biny SkillHub" } });
  if (!response.ok) throw new Error(`远程文件返回 HTTP ${String(response.status)}。`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error(`远程文件超过 ${String(maxBytes)} 字节。`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error(`远程文件超过 ${String(maxBytes)} 字节。`);
  return bytes;
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error(`远程响应超过 ${String(maxBytes)} 字节。`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`远程响应超过 ${String(maxBytes)} 字节。`);
  return text;
}

async function writeRepositories(homeDir: string, repositories: SkillRepository[]): Promise<void> {
  const filePath = skillRepositoriesPath(homeDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.biny-tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ repositories }, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Biny Skill 目录必须是真实目录：${directory}`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isRepositoryList(value: unknown): value is SkillRepositoryFile {
  if (!value || typeof value !== "object" || !("repositories" in value)) return false;
  const repositories = value.repositories;
  return Array.isArray(repositories) && repositories.length <= maxRepositories && repositories.every((repository) => {
    if (!repository || typeof repository !== "object") return false;
    const item = repository as Record<string, unknown>;
    return typeof item.owner === "string" && typeof item.name === "string" && typeof item.branch === "string" && typeof item.enabled === "boolean" && isValidOwner(item.owner) && isValidRepoName(item.name) && isValidBranch(item.branch);
  });
}

function assertRepository(repository: SkillRepository): void {
  if (!isValidOwner(repository.owner) || !isValidRepoName(repository.name) || !isValidBranch(repository.branch)) throw new Error("Skill 仓库地址无效。");
}

function isValidOwner(value: string): boolean {
  return /^[A-Za-z0-9-]{1,39}$/u.test(value);
}

function isValidRepoName(value: string): boolean {
  return /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/u.test(value);
}

function isValidBranch(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !value.startsWith("/") && !value.endsWith("/") && !value.includes("..") && !value.includes("//") && !/[\\#%?*^ ~:]/u.test(value) && value.split("/").every((part) => part.length > 0 && !part.startsWith("."));
}

function isSafeSkillPath(value: string): boolean {
  return value.length > 0 && value.length <= 1_000 && !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && !part.includes("\0"));
}

function assertSafeDirectoryName(value: string): void {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0") || value.startsWith(".") || value.length > 128) throw new Error(`Skill 目录名无效：${value}`);
}

function lastPathSegment(value: string): string {
  return value.split("/").filter(Boolean).at(-1) ?? value;
}

function firstDescriptionLine(body: string): string | undefined {
  return body.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#") && line !== "---");
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function isInstalledName(installedNames: ReadonlySet<string>, name: string, directory: string): boolean {
  return installedNames.has(name.toLocaleLowerCase()) || installedNames.has(directory.toLocaleLowerCase());
}

function deduplicateSkills(skills: DiscoverableSkill[]): DiscoverableSkill[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    const key = skill.key.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: Array<R | undefined> = new Array(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await mapper(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), Math.max(items.length, 1)) }, () => worker()));
  return results.filter((result): result is R => result !== undefined);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
