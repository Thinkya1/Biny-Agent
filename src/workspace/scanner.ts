/**
 * 工作区扫描模块。
 *
 * 这里递归遍历工作区并返回相对文件路径，同时应用 ignore 片段和数量上限。项目上下文、文件列表
 * 和搜索工具共用这套扫描逻辑，保证看到的文件范围一致。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { isIgnoredPath } from "./ignore.js";

export async function scanWorkspaceFiles(workspaceRoot: string, ignore: string[], limit = 200, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  // 递归扫描只收集文件相对路径；目录遍历过程会持续检查 limit。
  await walk(workspaceRoot, "");
  return files;

  async function walk(currentDir: string, relativeDir: string): Promise<void> {
    signal?.throwIfAborted();
    if (files.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      // 不可读（EACCES）或扫描过程中被删除的目录整棵跳过，与文件级读取失败的跳过策略一致。
      return;
    }
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (files.length >= limit) return;
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      // 在进入目录前先应用 ignore，避免不必要地读取大目录。
      if (isIgnoredPath(relativePath, ignore)) continue;
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }
}
