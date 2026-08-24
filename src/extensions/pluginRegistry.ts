/**
 * Biny 官方 Plugin Registry 与项目受管安装目录。
 *
 * 安装阶段只把经过来源、大小和 SHA-256 校验的 tar.gz 解包到 `.biny/plugins`，不会
 * import，也不会执行包内脚本。运行时只读取清单中显式启用的 entry；解包器只接受普通
 * 文件和目录，拒绝符号链接、硬链接、特殊文件以及任何越过目标目录的路径。
 */
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { z } from "zod";
import { projectBinyDir } from "../config/paths.js";

export const BINY_PLUGIN_REGISTRY_URL = "https://raw.githubusercontent.com/Thinkya1/Biny/main/plugins/registry.json";
const registryOrigin = new URL(BINY_PLUGIN_REGISTRY_URL).origin;
const maxPackageBytes = 32 * 1024 * 1024;
const maxExtractedBytes = 16 * 1024 * 1024;
const maxExtractedFiles = 512;
const maxFileBytes = 4 * 1024 * 1024;

const pluginMarketEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(64),
  category: z.string().trim().min(1).max(40),
  description: z.string().max(2_000),
  details: z.string().max(16_000),
  downloadUrl: z.string().url().max(2_000),
  sizeBytes: z.number().int().positive().max(maxPackageBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  archive: z.literal("tar.gz"),
  entry: z.string().trim().min(1).max(512).optional()
}).strict();

const pluginRegistrySchema = z.object({
  format: z.literal(1),
  plugins: z.array(pluginMarketEntrySchema).max(256)
}).strict();

const managedPluginSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
  name: z.string().min(1).max(120),
  version: z.string().min(1).max(64),
  category: z.string().min(1).max(40),
  description: z.string().max(2_000),
  directory: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
  entry: z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u),
  sizeBytes: z.number().int().positive().max(maxPackageBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  enabled: z.boolean(),
  installedAt: z.string().datetime(),
  error: z.string().max(2_000).optional()
}).strict();

const managedPluginManifestSchema = z.object({
  format: z.literal(1),
  plugins: z.array(managedPluginSchema).max(256)
}).strict();

export type PluginMarketEntry = z.infer<typeof pluginMarketEntrySchema>;
export type ManagedPlugin = z.infer<typeof managedPluginSchema>;
export interface PluginRegistryDocument {
  format: 1;
  plugins: PluginMarketEntry[];
}
export interface ProjectPluginManifest {
  format: 1;
  plugins: ManagedPlugin[];
}

export interface PluginRegistryCache {
  fetchedAt: string;
  document: PluginRegistryDocument;
}

export function parsePluginRegistry(value: unknown, sourceUrl = BINY_PLUGIN_REGISTRY_URL): PluginRegistryDocument {
  const document = pluginRegistrySchema.parse(value);
  for (const plugin of document.plugins) assertOfficialUrl(plugin.downloadUrl, sourceUrl);
  const ids = new Set<string>();
  for (const plugin of document.plugins) {
    if (ids.has(plugin.id)) throw new Error(`Plugin Registry 存在重复 id：${plugin.id}`);
    ids.add(plugin.id);
  }
  return document;
}

export function assertOfficialUrl(value: string, sourceUrl = BINY_PLUGIN_REGISTRY_URL): void {
  const url = new URL(value);
  const sourceOrigin = new URL(sourceUrl).origin;
  if (url.protocol !== "https:" || url.origin !== registryOrigin || sourceOrigin !== registryOrigin) {
    throw new Error("Plugin 只允许来自 Biny 官方 HTTPS Registry 的地址。");
  }
}

export async function readProjectPluginManifest(workspaceRoot: string): Promise<ProjectPluginManifest> {
  const root = await ensurePluginRoot(workspaceRoot, true);
  const target = path.join(root, "manifest.json");
  try {
    await assertRegularFile(target);
    const stat = await fs.stat(target);
    if (stat.size > 512 * 1024) throw new Error("Plugin 受管清单过大。");
    return managedPluginManifestSchema.parse(JSON.parse(await fs.readFile(target, "utf8")));
  } catch (error) {
    if (isNotFound(error)) return { format: 1, plugins: [] };
    throw new Error(`无法读取 Plugin 受管清单：${errorMessage(error)}`);
  }
}

export async function writeProjectPluginManifest(workspaceRoot: string, manifest: ProjectPluginManifest): Promise<void> {
  const parsed = managedPluginManifestSchema.parse(manifest);
  const root = await ensurePluginRoot(workspaceRoot);
  await writeJsonAtomic(path.join(root, "manifest.json"), parsed);
}

export async function readPluginRegistryCache(workspaceRoot: string): Promise<PluginRegistryCache | undefined> {
  const target = path.join(await ensurePluginRoot(workspaceRoot, true), "registry-cache.json");
  try {
    await assertRegularFile(target);
    const stat = await fs.stat(target);
    if (stat.size > 2 * 1024 * 1024) throw new Error("Plugin Registry 缓存过大。");
    const value = JSON.parse(await fs.readFile(target, "utf8")) as { fetchedAt?: unknown; document?: unknown };
    if (typeof value.fetchedAt !== "string" || value.document === undefined) throw new Error("Plugin Registry 缓存格式无效。");
    return { fetchedAt: value.fetchedAt, document: parsePluginRegistry(value.document) };
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw new Error(`Plugin Registry 缓存无效：${errorMessage(error)}`);
  }
}

export async function writePluginRegistryCache(workspaceRoot: string, cache: PluginRegistryCache): Promise<void> {
  const root = await ensurePluginRoot(workspaceRoot);
  await writeJsonAtomic(path.join(root, "registry-cache.json"), {
    fetchedAt: cache.fetchedAt,
    document: parsePluginRegistry(cache.document)
  });
}

export async function listEnabledProjectPluginPaths(workspaceRoot: string): Promise<string[]> {
  const manifest = await readProjectPluginManifest(workspaceRoot);
  const root = await ensurePluginRoot(workspaceRoot, true);
  const canonicalWorkspace = await fs.realpath(path.resolve(workspaceRoot));
  const paths: string[] = [];
  for (const plugin of manifest.plugins) {
    if (!plugin.enabled) continue;
    try {
      const directory = await assertContainedDirectory(root, path.join(root, plugin.directory));
      const entry = await resolveContainedFile(directory, plugin.entry);
      paths.push(path.relative(canonicalWorkspace, entry).split(path.sep).join("/"));
    } catch {
      // 单个已启用 Plugin 损坏时跳过它，其他 Plugin 仍可继续加载。
    }
  }
  return paths;
}

export async function installPluginPackage(options: {
  workspaceRoot: string;
  plugin: PluginMarketEntry;
  fetcher?: typeof globalThis.fetch;
}): Promise<ManagedPlugin> {
  assertOfficialUrl(options.plugin.downloadUrl);
  const fetcher = options.fetcher ?? globalThis.fetch;
  const response = await fetcher(options.plugin.downloadUrl);
  if (!response.ok) throw new Error(`Plugin 下载失败：HTTP ${String(response.status)}。`);
  if (response.url) assertOfficialUrl(response.url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== options.plugin.sizeBytes) {
    throw new Error(`Plugin 包大小不匹配：期望 ${String(options.plugin.sizeBytes)}，实际 ${String(bytes.byteLength)}。`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== options.plugin.sha256) throw new Error("Plugin 包 SHA-256 校验失败。");

  const pluginsRoot = await ensurePluginRoot(options.workspaceRoot);
  const tempDirectory = path.join(pluginsRoot, `.install-${randomUUID()}`);
  const targetDirectory = path.join(pluginsRoot, options.plugin.id);
  await fs.mkdir(tempDirectory, { recursive: false, mode: 0o700 });
  try {
    const extracted = await extractTarGz(bytes, tempDirectory);
    const entry = options.plugin.entry ?? chooseEntry(extracted);
    assertSafeRelativePath(entry);
    const entryPath = await resolveContainedFile(tempDirectory, entry);
    const relativeEntry = path.relative(tempDirectory, entryPath).split(path.sep).join("/");
    const manifestEntry: ManagedPlugin = {
      id: options.plugin.id,
      name: options.plugin.name,
      version: options.plugin.version,
      category: options.plugin.category,
      description: options.plugin.description,
      directory: options.plugin.id,
      entry: relativeEntry,
      sizeBytes: options.plugin.sizeBytes,
      sha256: options.plugin.sha256,
      enabled: false,
      installedAt: new Date().toISOString(),
      error: undefined
    };
    const existing = await readProjectPluginManifest(options.workspaceRoot);
    const old = existing.plugins.find((plugin) => plugin.id === options.plugin.id);
    if (old?.enabled) manifestEntry.enabled = true;
    const backupDirectory = path.join(pluginsRoot, `.backup-${options.plugin.id}-${randomUUID()}`);
    let hadOldDirectory = false;
    try {
      try {
        const oldStat = await fs.lstat(targetDirectory);
        if (oldStat.isSymbolicLink() || !oldStat.isDirectory()) throw new Error("现有 Plugin 目录不安全。");
        await fs.rename(targetDirectory, backupDirectory);
        hadOldDirectory = true;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      await fs.rename(tempDirectory, targetDirectory);
      await writeProjectPluginManifest(options.workspaceRoot, {
        format: 1,
        plugins: [...existing.plugins.filter((plugin) => plugin.id !== options.plugin.id), manifestEntry]
      });
      if (hadOldDirectory) await fs.rm(backupDirectory, { recursive: true, force: true });
    } catch (error) {
      await fs.rm(targetDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (hadOldDirectory) await fs.rename(backupDirectory, targetDirectory).catch(() => undefined);
      throw error;
    }
    return manifestEntry;
  } catch (error) {
    await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function setProjectPluginEnabled(workspaceRoot: string, pluginId: string, enabled: boolean): Promise<ManagedPlugin> {
  const manifest = await readProjectPluginManifest(workspaceRoot);
  const plugin = manifest.plugins.find((candidate) => candidate.id === pluginId);
  if (!plugin) throw new Error(`Plugin 不存在：${pluginId}`);
  const root = await ensurePluginRoot(workspaceRoot, true);
  await assertContainedDirectory(root, path.join(root, plugin.directory));
  const next = { ...plugin, enabled, error: undefined };
  await writeProjectPluginManifest(workspaceRoot, {
    format: 1,
    plugins: manifest.plugins.map((candidate) => candidate.id === pluginId ? next : candidate)
  });
  return next;
}

export async function uninstallProjectPlugin(workspaceRoot: string, pluginId: string): Promise<void> {
  const manifest = await readProjectPluginManifest(workspaceRoot);
  const plugin = manifest.plugins.find((candidate) => candidate.id === pluginId);
  if (!plugin) throw new Error(`Plugin 不存在：${pluginId}`);
  const root = await ensurePluginRoot(workspaceRoot, true);
  const directory = await assertContainedDirectory(root, path.join(root, plugin.directory));
  await fs.rm(directory, { recursive: true, force: true });
  await writeProjectPluginManifest(workspaceRoot, {
    format: 1,
    plugins: manifest.plugins.filter((candidate) => candidate.id !== pluginId)
  });
}

export function projectPluginRoot(workspaceRoot: string): string {
  return path.join(projectBinyDir(workspaceRoot), "plugins");
}

export function projectPluginManifestPath(workspaceRoot: string): string {
  return path.join(projectPluginRoot(workspaceRoot), "manifest.json");
}

async function extractTarGz(bytes: Uint8Array, destination: string): Promise<string[]> {
  const archive = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  const files: string[] = [];
  let offset = 0;
  let totalBytes = 0;
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    verifyTarChecksum(header);
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const relative = prefix ? `${prefix}/${name}` : name;
    assertSafeRelativePath(relative);
    const type = header[156] ?? 0;
    const size = parseTarOctal(header.subarray(124, 136));
    if (size > maxFileBytes || totalBytes + size > maxExtractedBytes) throw new Error("Plugin 解包后超过文件大小限制。");
    const end = offset + Math.ceil(size / 512) * 512;
    if (end > archive.byteLength) throw new Error("Plugin tar 包被截断。");
    const target = path.resolve(destination, relative);
    if (type === 5) {
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
    } else if (type === 0 || type === 48) {
      if (files.length >= maxExtractedFiles) throw new Error("Plugin 文件数量超过限制。");
      await assertParentDirectories(destination, path.dirname(target));
      const handle = await fs.open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        await handle.writeFile(archive.subarray(offset, offset + size));
      } finally {
        await handle.close();
      }
      files.push(relative);
      totalBytes += size;
    } else {
      throw new Error("Plugin tar 包包含不允许的符号链接、硬链接或特殊文件。");
    }
    offset = end;
  }
  if (!files.length) throw new Error("Plugin tar 包没有可执行模块。");
  return files;
}

function chooseEntry(files: string[]): string {
  const candidates = files.filter((file) => [".js", ".mjs", ".cjs"].includes(path.posix.extname(file).toLowerCase()));
  if (candidates.length !== 1) throw new Error("Plugin 必须明确提供 entry，或包内只能有一个 JavaScript 模块。");
  return candidates[0]!;
}

function verifyTarChecksum(header: Uint8Array): void {
  const declared = parseTarOctal(header.subarray(148, 156));
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) actual += index >= 148 && index < 156 ? 0x20 : header[index]!;
  if (declared !== actual) throw new Error("Plugin tar 包校验和无效。");
}

function parseTarOctal(value: Uint8Array): number {
  const text = tarString(value).trim();
  if (!/^[0-7]+$/u.test(text)) throw new Error("Plugin tar 包包含无效文件大小。");
  const parsed = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Plugin tar 包文件大小无效。");
  return parsed;
}

function tarString(value: Uint8Array): string {
  const end = value.indexOf(0);
  return new TextDecoder().decode(end === -1 ? value : value.subarray(0, end)).trim();
}

function assertSafeRelativePath(value: string): void {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === "" || part === ".")) {
    throw new Error(`Plugin 包路径无效或越界：${value}`);
  }
}

async function assertParentDirectories(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Plugin 解包路径越过目标目录。");
  let current = root;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Plugin 解包目录不能是符号链接。");
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await fs.mkdir(current, { mode: 0o700 });
    }
  }
}

async function ensurePluginRoot(workspaceRoot: string, optional = false): Promise<string> {
  const biny = projectBinyDir(workspaceRoot);
  try {
    const binyStat = await fs.lstat(biny);
    if (binyStat.isSymbolicLink() || !binyStat.isDirectory()) throw new Error("项目 .biny 必须是真实目录。");
  } catch (error) {
    if (isNotFound(error) && !optional) await fs.mkdir(biny, { recursive: true, mode: 0o700 });
    else if (!isNotFound(error)) throw error;
    else return path.join(biny, "plugins");
  }
  const root = projectPluginRoot(workspaceRoot);
  try {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("项目 Plugin 目录必须是真实目录。");
  } catch (error) {
    if (isNotFound(error) && !optional) await fs.mkdir(root, { recursive: false, mode: 0o700 });
    else if (!isNotFound(error)) throw error;
  }
  return root;
}

async function assertContainedDirectory(root: string, target: string): Promise<string> {
  const rootReal = await fs.realpath(root);
  const targetStat = await fs.lstat(target);
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) throw new Error("Plugin 目录不能是符号链接或非目录。");
  const targetReal = await fs.realpath(target);
  const relative = path.relative(rootReal, targetReal);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Plugin 路径越过受管目录。");
  return targetReal;
}

async function resolveContainedFile(root: string, relative: string): Promise<string> {
  assertSafeRelativePath(relative);
  const target = path.resolve(root, relative);
  const relativeTarget = path.relative(root, target);
  if (relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) throw new Error("Plugin entry 越过受管目录。");
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error("Plugin entry 必须是单链接普通文件。");
  return target;
}

async function assertRegularFile(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error("Plugin 清单必须是单链接普通文件。");
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  try {
    const existing = await fs.lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) throw new Error(`目标文件不安全：${target}`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, target);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
