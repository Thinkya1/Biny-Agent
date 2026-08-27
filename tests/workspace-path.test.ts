import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveWorkspaceDirectory, resolveWorkspacePath, toWorkspaceRelative } from "../src/workspace/resolvePath.js";
import { scanWorkspaceFiles } from "../src/workspace/scanner.js";

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-workspace-path-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "biny-workspace-outside-"));
  try {
    await mkdir(path.join(workspaceRoot, "src"));
    await mkdir(path.join(workspaceRoot, "ignored"));
    await writeFile(path.join(workspaceRoot, "src", "entry.ts"), "export {};\n");
    await writeFile(path.join(outsideRoot, "secret.txt"), "outside\n");
    await symlink(path.join(workspaceRoot, "src"), path.join(workspaceRoot, "inside"));
    await symlink(outsideRoot, path.join(workspaceRoot, "outside"));
    await symlink(path.join(outsideRoot, "missing.txt"), path.join(workspaceRoot, "dangling"));
    await symlink(path.join(workspaceRoot, "ignored"), path.join(workspaceRoot, "aliased-ignored"));
    const canonicalWorkspace = await realpath(workspaceRoot);

    assert.equal(resolveWorkspacePath(workspaceRoot, "src/entry.ts", ["ignored"]), path.join(canonicalWorkspace, "src", "entry.ts"));
    assert.equal(resolveWorkspacePath(workspaceRoot, "inside/entry.ts", ["ignored"]), path.join(canonicalWorkspace, "src", "entry.ts"));
    assert.equal(resolveWorkspaceDirectory(workspaceRoot, ".", ["ignored"]), canonicalWorkspace);
    assert.equal(toWorkspaceRelative(workspaceRoot, path.join(workspaceRoot, "inside", "entry.ts")), "src/entry.ts");

    assert.throws(() => resolveWorkspacePath(workspaceRoot, ".", []), /escapes workspace/);
    assert.throws(() => resolveWorkspacePath(workspaceRoot, "../secret.txt", []), /escapes workspace/);
    assert.throws(() => resolveWorkspacePath(workspaceRoot, "outside/secret.txt", []), /symbolic link/);
    assert.throws(() => resolveWorkspacePath(workspaceRoot, "dangling", []), /dangling symbolic link/);
    assert.throws(() => resolveWorkspacePath(workspaceRoot, "ignored/file.ts", ["ignored"]), /ignored by workspace policy/);
    assert.throws(() => resolveWorkspacePath(workspaceRoot, "aliased-ignored/file.ts", ["ignored"]), /resolves to a location ignored/);

    await testScannerSkipsUnreadableDirectories(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
}

/** 不可读的子目录必须整棵跳过，不能让一个 EACCES 拖垮整个工作区扫描。 */
async function testScannerSkipsUnreadableDirectories(workspaceRoot: string): Promise<void> {
  if (process.platform === "win32") return;
  const sealed = path.join(workspaceRoot, "sealed");
  await mkdir(sealed);
  await writeFile(path.join(sealed, "hidden.txt"), "hidden\n");
  await chmod(sealed, 0o000);
  try {
    const files = await scanWorkspaceFiles(workspaceRoot, ["ignored"], 100);
    assert.equal(files.includes(path.join("src", "entry.ts")), true);
    assert.equal(files.some((entry) => entry.startsWith("sealed")), false);
  } finally {
    // 恢复权限，否则最后的 rm 清理不掉这个目录。
    await chmod(sealed, 0o700);
  }
}

await main();
