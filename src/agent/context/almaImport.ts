/**
 * Alma/OpenSquilla 工作区的只读导入适配器。
 *
 * 适配器只允许读取身份 Markdown 和每日记忆 Markdown，不启动 Alma、不访问 chat_threads.db、
 * 不读取 embedding，也不把源文件写回原目录。源文件正文只在当前导入预览和本地提案中流转。
 */
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { IdentityStorage } from "./identityStorage.js";
import type {
  IdentityDocumentInput,
  IdentityImportFile,
  IdentityImportSource,
  IdentityProposal
} from "./identityTypes.js";
import { detectIdentitySecretWarning, identityContentHash, normalizeIdentityContent } from "./identityFormat.js";

type IdentitySourceFile = IdentityImportFile & {
  content: string;
  contentHash: string;
  kind: "soul" | "identity" | "style" | "user";
};

const maxImportFileBytes = 128 * 1024;
const maxDailyMemoryFiles = 366;
const identitySourceFiles: Array<{ relativePath: string; kind: IdentityImportFile["kind"] }> = [
  { relativePath: "SOUL.md", kind: "soul" },
  { relativePath: "IDENTITY.md", kind: "identity" },
  { relativePath: "STYLE.md", kind: "style" },
  { relativePath: "USER.md", kind: "user" },
  { relativePath: "MEMORY.md", kind: "memory" }
];

export interface AlmaImportScanResult {
  source: IdentityImportSource;
  proposals: IdentityProposal[];
  identityFiles: IdentityImportFile[];
  memoryFiles: IdentityImportFile[];
  warnings: string[];
}

export function almaWorkspaceCandidates(homeDir = os.homedir()): string[] {
  return [
    path.join(homeDir, "Library", "Application Support", "@opensquilla", "desktop-electron", "opensquilla", "workspace"),
    path.join(homeDir, ".config", "alma")
  ];
}

export async function discoverAlmaWorkspace(homeDir = os.homedir()): Promise<string | undefined> {
  for (const candidate of almaWorkspaceCandidates(homeDir)) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // 候选不存在时继续检查下一个已知位置。
    }
  }
  return undefined;
}

export async function scanAlmaWorkspace(root: string): Promise<AlmaImportScanResult> {
  const resolvedRoot = await resolveDirectory(root);
  const identityFiles: IdentityImportFile[] = [];
  const memoryFiles: IdentityImportFile[] = [];
  const warnings: string[] = [];

  for (const sourceFile of identitySourceFiles) {
    const file = await readSourceFile(resolvedRoot, sourceFile.relativePath, sourceFile.kind);
    identityFiles.push(file);
    if (file.error) warnings.push(`${sourceFile.relativePath}：${file.error}`);
  }

  const memoryDirectory = await readDirectoryNames(resolvedRoot, "memory");
  const dailyNames = memoryDirectory
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/u.test(name))
    .sort()
    .slice(-maxDailyMemoryFiles);
  for (const name of dailyNames) {
    const relativePath = path.posix.join("memory", name);
    const file = await readSourceFile(resolvedRoot, relativePath, "daily_memory");
    memoryFiles.push(file);
    if (file.error) warnings.push(`${relativePath}：${file.error}`);
  }

  const files = [...identityFiles, ...memoryFiles];
  const fingerprint = createHash("sha256")
    .update(files.map((file) => `${file.relativePath}\0${file.contentHash ?? "missing"}`).join("\n"), "utf8")
    .digest("hex");
  const source: IdentityImportSource = {
    provider: "alma",
    root: resolvedRoot,
    fingerprint,
    files: files.map((file) => ({ ...file }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    importedAt: new Date().toISOString()
  };
  return { source, proposals: [], identityFiles, memoryFiles, warnings };
}

export async function importAlmaWorkspace(
  storage: IdentityStorage,
  root: string,
  options: { recordSource?: boolean } = {}
): Promise<AlmaImportScanResult> {
  const scan = await scanAlmaWorkspace(root);
  const inputs: IdentityDocumentInput[] = scan.identityFiles
    .filter((file): file is IdentitySourceFile => (
      file.content !== undefined && file.contentHash !== undefined && file.exists
      && (file.kind === "soul" || file.kind === "identity" || file.kind === "style" || file.kind === "user")
    ))
    .map((file) => ({
      document: file.kind,
      content: file.content,
      reason: `从 Alma 导入 ${file.relativePath}`,
      source: {
        kind: "alma",
        relativePath: file.relativePath,
        contentHash: file.contentHash
      },
      evidence: [`源文件：${file.relativePath}`],
      secretWarning: file.secretWarning
    }));
  scan.proposals = await storage.createProposals(inputs);
  if (options.recordSource !== false) await storage.recordImportSource(scan.source);
  return {
    ...scan,
    source: {
      ...scan.source,
      files: scan.source.files.map(stripImportContent)
    },
    identityFiles: scan.identityFiles.map(stripImportContent),
    memoryFiles: scan.memoryFiles.map(stripImportContent)
  };
}

async function resolveDirectory(root: string): Promise<string> {
  const resolved = await fs.realpath(path.resolve(root));
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory()) throw new Error("Alma 身份源必须是目录。");
  return resolved;
}

async function readSourceFile(
  root: string,
  relativePath: string,
  kind: IdentityImportFile["kind"]
): Promise<IdentityImportFile> {
  const base = {
    relativePath,
    kind,
    exists: false,
    bytes: 0
  } satisfies IdentityImportFile;
  const candidate = safeChildPath(root, relativePath);
  try {
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) return { ...base, error: "不是普通文件。" };
    if (stat.size > maxImportFileBytes) return { ...base, error: `超过 ${String(maxImportFileBytes)} 字节上限。` };
    const real = await fs.realpath(candidate);
    if (!isWithin(root, real)) return { ...base, error: "文件解析后越过了导入目录。" };
    const content = await fs.readFile(candidate, "utf8");
    const normalized = kind === "daily_memory" || kind === "memory"
      ? content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim()
      : normalizeIdentityContent(content, kind);
    const contentHash = identityContentHash(normalized);
    const secretWarning = detectIdentitySecretWarning(normalized);
    return {
      ...base,
      exists: true,
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      contentHash,
      content,
      secretWarning
    };
  } catch (error) {
    if (isNotFound(error)) return base;
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readDirectoryNames(root: string, relativePath: string): Promise<string[]> {
  const directory = safeChildPath(root, relativePath);
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return [];
    return await fs.readdir(directory);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

function safeChildPath(root: string, relativePath: string): string {
  const candidate = path.resolve(root, relativePath);
  if (!isWithin(root, candidate)) throw new Error(`导入路径越界：${relativePath}`);
  return candidate;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function stripImportContent(file: IdentityImportFile): IdentityImportFile {
  const { content: _content, ...metadata } = file;
  return metadata;
}
