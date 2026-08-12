/**
 * 工作区状态指纹。
 *
 * 用来判断一次任务尝试到底改没改文件：把工作区所有受管文件的「相对路径 + 大小 + 内容
 * 哈希」拼起来再哈希一次。目录项按名字排序，保证同样的文件树一定得到同样的指纹。
 */
import { createHash } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { isIgnoredPath } from "../workspace/ignore.js";

// 运行时目录和构建产物会频繁变化，纳入指纹会让「有没有改动」永远为真。
const ignoredDirectoryNames = new Set([".biny", ".agent", ".git", "node_modules", "dist", "build", "out", "target", "coverage"]);
const maxEntries = 20_000;
const maxContentBytes = 64 * 1024 * 1024;

export interface WorkspaceFileState {
  path: string;
  size: number;
  contentDigest?: string;
  contentBudgetExhausted: boolean;
}

export interface WorkspaceStateSnapshot {
  digest: string;
  files: WorkspaceFileState[];
}

export interface WorkspaceStateDiff {
  beforeDigest: string;
  afterDigest: string;
  changedFiles: string[];
  addedFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
}

/** 计算工作区指纹，排除运行时和构建产物；条目数超限直接报错而不是悄悄截断。 */
export async function workspaceStateDigest(workspaceRoot: string, ignore: string[] = []): Promise<string> {
  return (await captureWorkspaceState(workspaceRoot, ignore)).digest;
}

/**
 * 捕获可比较的工作区文件快照。
 *
 * 路径、大小和内容摘要同时保留，独立验收 harness 因此既能判断“工作区是否变化”，也能拿到
 * 具体 changedFiles。内容总量超过预算后沿用旧指纹行为：继续记录路径和大小，但不再读取内容。
 */
export async function captureWorkspaceState(
  workspaceRoot: string,
  ignore: string[] = []
): Promise<WorkspaceStateSnapshot> {
  const root = await fs.realpath(path.resolve(workspaceRoot));
  const files: WorkspaceFileState[] = [];
  let visited = 0;
  let contentBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    let children: Dirent[];
    try {
      children = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Unable to inspect workspace state at ${directory}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      visited += 1;
      if (visited > maxEntries) throw new Error(`Workspace state exceeds ${String(maxEntries)} entries.`);
      // 跳过符号链接：跟随可能走出工作区，也可能形成环。
      if (child.isSymbolicLink()) continue;
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute);
      if (!relative || isIgnoredPath(relative, ignore)) continue;
      if (child.isDirectory()) {
        if (!ignoredDirectoryNames.has(child.name)) await visit(absolute);
        continue;
      }
      if (!child.isFile()) continue;
      const stat = await fs.stat(absolute);
      // 内容预算用完后不再读文件，但仍把路径和大小计入指纹：大小变化依然能被发现，
      // 只是内容级改动看不出来，比整体失败更实用。
      if (contentBytes + stat.size > maxContentBytes) {
        files.push({
          path: relative,
          size: stat.size,
          contentDigest: undefined,
          contentBudgetExhausted: true
        });
        continue;
      }
      const content = await fs.readFile(absolute);
      contentBytes += content.length;
      files.push({
        path: relative,
        size: stat.size,
        contentDigest: createHash("sha256").update(content).digest("hex"),
        contentBudgetExhausted: false
      });
    }
  };
  await visit(root);
  const entries = files.map((file) =>
    `${file.path}\0${String(file.size)}\0${file.contentDigest ?? "content-budget-exhausted"}`
  );
  return {
    digest: `sha256:${createHash("sha256").update(entries.join("\n")).digest("hex")}`,
    files
  };
}

/** 比较两份快照；各列表按路径排序，便于持久化、指纹和测试保持稳定。 */
export function diffWorkspaceStates(
  before: WorkspaceStateSnapshot,
  after: WorkspaceStateSnapshot
): WorkspaceStateDiff {
  const beforeFiles = new Map(before.files.map((file) => [file.path, file]));
  const afterFiles = new Map(after.files.map((file) => [file.path, file]));
  const addedFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (const [filePath, file] of afterFiles) {
    const previous = beforeFiles.get(filePath);
    if (!previous) {
      addedFiles.push(filePath);
      continue;
    }
    if (!sameFileState(previous, file)) modifiedFiles.push(filePath);
  }
  for (const filePath of beforeFiles.keys()) {
    if (!afterFiles.has(filePath)) deletedFiles.push(filePath);
  }
  addedFiles.sort();
  modifiedFiles.sort();
  deletedFiles.sort();
  return {
    beforeDigest: before.digest,
    afterDigest: after.digest,
    changedFiles: [...addedFiles, ...modifiedFiles, ...deletedFiles].sort(),
    addedFiles,
    modifiedFiles,
    deletedFiles
  };
}

function sameFileState(left: WorkspaceFileState, right: WorkspaceFileState): boolean {
  return left.size === right.size
    && left.contentDigest === right.contentDigest
    && left.contentBudgetExhausted === right.contentBudgetExhausted;
}
