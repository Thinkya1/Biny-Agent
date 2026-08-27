import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import { access, chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createEditFileTool } from "../src/tools/file/editFile.js";
import { createDeleteFileTool } from "../src/tools/file/deleteFile.js";
import { createMultiEditTool } from "../src/tools/file/multiEdit.js";
import { createReadFileTool } from "../src/tools/file/readFile.js";
import { atomicWriteUtf8File, maxEditFileBytes, maxReadFileBytes, maxSearchFileBytes, readUtf8FileForEdit } from "../src/tools/file/safeFileIo.js";
import { createWriteFileTool } from "../src/tools/file/writeFile.js";
import { createToolPermissionRequest } from "../src/tools/display/ToolDisplay.js";
import { collectProjectContext } from "../src/project/ProjectContext.js";
import { createGitDiffTool } from "../src/tools/git/diff.js";
import { createGitStatusTool } from "../src/tools/git/status.js";
import { createSearchFilesTool } from "../src/tools/search/searchFiles.js";
import { runShellCommand } from "../src/tools/shell/runCommand.js";
import type { RunnableToolExecution, ToolExecution } from "../src/tools/types.js";
import { resolveWorkspacePath } from "../src/workspace/resolvePath.js";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-tool-cancel-"));
  try {
    await testReadFileRejectsOversizeInput(workspaceRoot);
    await testEditFileRejectsOversizeInput(workspaceRoot);
    await testPermissionPreviewRejectsOversizeExistingFile(workspaceRoot);
    await testSearchReportsTruncatedFiles(workspaceRoot);
    await testPreAbortedWriteHasNoSideEffect(workspaceRoot);
    await testWriteCreatesMissingParents(workspaceRoot);
    await testWriteRejectsSymlinkedMissingParent(workspaceRoot);
    await testPreAbortedEditHasNoSideEffect(workspaceRoot);
    await testCancellationBeforeAtomicCommitPreservesTargets(workspaceRoot);
    await testAtomicWriteAndEditCommitCleanly(workspaceRoot);
    await testMultiEditIsAtomic(workspaceRoot);
    await testDeleteFileBindsPreparedTarget(workspaceRoot);
    await testAtomicWriteDetachesExistingHardlink(workspaceRoot);
    await testAtomicWriteRejectsChangedSnapshot(workspaceRoot);
    await testApprovedFileSnapshotCannotBeOverwritten(workspaceRoot);
    await testAtomicCommitWindowPreservesExternalChanges(workspaceRoot);
    await testPreparedCanonicalTargetCannotBeRedirected(workspaceRoot);
    await testPreAbortedShellDoesNotSpawn(workspaceRoot);
    await testAbortKillsStubbornProcessGroup(workspaceRoot);
    await testAbortKillsDetachedDescendant(workspaceRoot);
    await testCommandExitStatus(workspaceRoot);
    await testCommandTimeoutHardSettles(workspaceRoot);
    await testGitInspectionDisablesConfiguredHelpers(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testEditFileRejectsOversizeInput(workspaceRoot: string): Promise<void> {
  const target = path.join(workspaceRoot, "oversize-edit.txt");
  const content = `old-text${"x".repeat(maxEditFileBytes)}`;
  await writeFile(target, content, "utf8");
  const execution = runnable(createEditFileTool({ workspaceRoot, ignore: [] }).resolveExecution({
    path: "oversize-edit.txt",
    oldText: "old-text",
    newText: "new-text"
  }));

  await assert.rejects(
    execution.execute({ toolCallId: "edit-oversize" }),
    new RegExp(`exceeding the ${String(maxEditFileBytes)}-byte read limit`, "i")
  );
  assert.equal(await readFile(target, "utf8"), content);
}

async function testReadFileRejectsOversizeInput(workspaceRoot: string): Promise<void> {
  const target = path.join(workspaceRoot, "oversize-read.txt");
  await writeFile(target, "x".repeat(maxReadFileBytes + 1), "utf8");
  const execution = runnable(createReadFileTool({ workspaceRoot, ignore: [] }).resolveExecution({ path: "oversize-read.txt" }));

  await assert.rejects(
    execution.execute({ toolCallId: "read-oversize" }),
    new RegExp(`exceeding the ${String(maxReadFileBytes)}-byte read limit`, "i")
  );
}

async function testPermissionPreviewRejectsOversizeExistingFile(workspaceRoot: string): Promise<void> {
  await assert.rejects(
    createToolPermissionRequest({
      id: "oversize-preview",
      name: "write_file",
      args: { path: "oversize-edit.txt", content: "replacement" }
    }, {
      workspaceRoot,
      ignore: [],
      sessionId: "tool-io-test"
    }),
    new RegExp(`exceeding the ${String(maxEditFileBytes)}-byte read limit`, "i")
  );
}

async function testSearchReportsTruncatedFiles(workspaceRoot: string): Promise<void> {
  const relativePath = "oversize-search.txt";
  const prefixQuery = "bounded-prefix-hit";
  const suffixQuery = "must-not-be-read-past-limit";
  await writeFile(
    path.join(workspaceRoot, relativePath),
    `${prefixQuery}\n${"x".repeat(maxSearchFileBytes)}\n${suffixQuery}\n`,
    "utf8"
  );

  const search = runnable(createSearchFilesTool({ workspaceRoot, ignore: [] }).resolveExecution({ query: prefixQuery }));
  const searchResult = await search.execute({ toolCallId: "search-bounded" });
  assert.equal(searchResult.matches.some((match) => match.path === relativePath && match.text === prefixQuery), true);
  assert.equal(searchResult.truncatedFiles?.includes(relativePath), true);

  const grep = runnable(createSearchFilesTool({ workspaceRoot, ignore: [] }).resolveExecution({ query: suffixQuery }));
  const grepResult = await grep.execute({ toolCallId: "grep-bounded" });
  assert.equal(grepResult.matches.some((match) => match.path === relativePath), false);
  assert.equal(grepResult.truncatedFiles?.includes(relativePath), true);
}

async function testPreAbortedWriteHasNoSideEffect(workspaceRoot: string): Promise<void> {
  const execution = runnable(createWriteFileTool({ workspaceRoot, ignore: [] }).resolveExecution({
    path: "created/by-tool.txt",
    content: "unexpected"
  }));
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(execution.execute({ toolCallId: "write-1", signal: controller.signal }), isAbortError);
  await assert.rejects(access(path.join(workspaceRoot, "created")));
}

async function testWriteCreatesMissingParents(workspaceRoot: string): Promise<void> {
  const execution = runnable(createWriteFileTool({ workspaceRoot, ignore: [] }).resolveExecution({
    path: "missing-parent/nested/file.txt",
    content: "content"
  }));

  assert.deepEqual(await execution.execute({ toolCallId: "missing-parent" }), {
    path: "missing-parent/nested/file.txt",
    bytes: Buffer.byteLength("content")
  });
  assert.equal(await readFile(path.join(workspaceRoot, "missing-parent", "nested", "file.txt"), "utf8"), "content");
}

async function testWriteRejectsSymlinkedMissingParent(workspaceRoot: string): Promise<void> {
  if (process.platform === "win32") return;
  const outside = await mkdtemp(path.join(os.tmpdir(), "biny-write-parent-outside-"));
  const alias = path.join(workspaceRoot, "parent-alias");
  try {
    await symlink(outside, alias, "dir");
    assert.throws(
      () => createWriteFileTool({ workspaceRoot, ignore: [] }).resolveExecution({ path: "parent-alias/new/file.txt", content: "blocked" }),
      /escapes workspace through a symbolic link/i
    );
    await assert.rejects(access(path.join(outside, "new", "file.txt")));
  } finally {
    await unlink(alias).catch(() => undefined);
    await rm(outside, { recursive: true, force: true });
  }
}

async function testPreAbortedEditHasNoSideEffect(workspaceRoot: string): Promise<void> {
  const target = path.join(workspaceRoot, "edit.txt");
  await writeFile(target, "before", "utf8");
  const execution = runnable(createEditFileTool({ workspaceRoot, ignore: [] }).resolveExecution({
    path: "edit.txt",
    oldText: "before",
    newText: "after"
  }));
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(execution.execute({ toolCallId: "edit-1", signal: controller.signal }), isAbortError);
  assert.equal(await readFile(target, "utf8"), "before");
}

async function testCancellationBeforeAtomicCommitPreservesTargets(workspaceRoot: string): Promise<void> {
  const writeTarget = path.join(workspaceRoot, "cancel-during-write.txt");
  await writeFile(writeTarget, "before-write", "utf8");
  const writeExecution = runnable(createWriteFileTool({ workspaceRoot, ignore: [] }).resolveExecution({
    path: "cancel-during-write.txt",
    content: "after-write"
  }));
  const writeController = new AbortController();
  const writeOperation = writeExecution.execute({ toolCallId: "write-during-cancel", signal: writeController.signal });
  writeController.abort();
  await assert.rejects(writeOperation, isAbortError);
  assert.equal(await readFile(writeTarget, "utf8"), "before-write");

  const editTarget = path.join(workspaceRoot, "cancel-during-edit.txt");
  await writeFile(editTarget, "before-edit", "utf8");
  const editExecution = runnable(createEditFileTool({ workspaceRoot, ignore: [] }).resolveExecution({
    path: "cancel-during-edit.txt",
    oldText: "before",
    newText: "after"
  }));
  const editController = new AbortController();
  const editOperation = editExecution.execute({ toolCallId: "edit-during-cancel", signal: editController.signal });
  editController.abort();
  await assert.rejects(editOperation, isAbortError);
  assert.equal(await readFile(editTarget, "utf8"), "before-edit");
  assert.deepEqual((await readdir(workspaceRoot)).filter((entry) => entry.startsWith(".biny-write-")), []);
}

async function testAtomicWriteAndEditCommitCleanly(workspaceRoot: string): Promise<void> {
  const target = path.join(workspaceRoot, "atomic-success.txt");
  await writeFile(target, "before", { encoding: "utf8", mode: 0o640 });
  const before = await lstat(target);
  const writeExecution = runnable(createWriteFileTool({ workspaceRoot, ignore: [] }).resolveExecution({
    path: "atomic-success.txt",
    content: "middle"
  }));
  assert.deepEqual(await writeExecution.execute({ toolCallId: "atomic-write" }), {
    path: "atomic-success.txt",
    bytes: Buffer.byteLength("middle")
  });
  const afterWrite = await lstat(target);
  assert.equal(await readFile(target, "utf8"), "middle");
  assert.notEqual(afterWrite.ino, before.ino);
  if (process.platform !== "win32") assert.equal(afterWrite.mode & 0o777, before.mode & 0o777);

  const editExecution = runnable(createEditFileTool({ workspaceRoot, ignore: [] }).resolveExecution({
    path: "atomic-success.txt",
    oldText: "middle",
    newText: "after"
  }));
  assert.deepEqual(await editExecution.execute({ toolCallId: "atomic-edit" }), {
    path: "atomic-success.txt",
    replacements: 1
  });
  assert.equal(await readFile(target, "utf8"), "after");
  assert.deepEqual((await readdir(workspaceRoot)).filter((entry) => entry.startsWith(".biny-write-")), []);
}

async function testMultiEditIsAtomic(workspaceRoot: string): Promise<void> {
  const target = path.join(workspaceRoot, "multi-edit.txt");
  await writeFile(target, "alpha beta beta\n", "utf8");
  const tool = createMultiEditTool({ workspaceRoot, ignore: [] });
  const execution = runnable(await tool.resolveExecution({
    path: "multi-edit.txt",
    edits: [
      { oldText: "alpha", newText: "first" },
      { oldText: "beta", newText: "second", replaceAll: true }
    ]
  }));
  assert.deepEqual(await execution.execute({ toolCallId: "multi-edit" }), {
    path: "multi-edit.txt",
    edits: 2,
    replacements: 3,
    bytes: Buffer.byteLength("first second second\n")
  });
  assert.equal(await readFile(target, "utf8"), "first second second\n");

  await assert.rejects(
    tool.resolveExecution({
      path: "multi-edit.txt",
      edits: [
        { oldText: "first", newText: "changed" },
        { oldText: "missing", newText: "never" }
      ]
    }),
    /edit 2.*not found/i
  );
  assert.equal(await readFile(target, "utf8"), "first second second\n");
}

async function testDeleteFileBindsPreparedTarget(workspaceRoot: string): Promise<void> {
  const target = path.join(workspaceRoot, "delete-bound.txt");
  await writeFile(target, "approved", "utf8");
  const tool = createDeleteFileTool({ workspaceRoot, ignore: [] });
  const staleExecution = runnable(await tool.resolveExecution({ path: "delete-bound.txt" }));
  await writeFile(target, "replacement", "utf8");
  await assert.rejects(staleExecution.execute({ toolCallId: "delete-stale" }), /changed after the tool call was prepared/i);
  assert.equal(await readFile(target, "utf8"), "replacement");

  const execution = runnable(await tool.resolveExecution({ path: "delete-bound.txt" }));
  assert.deepEqual(await execution.execute({ toolCallId: "delete-current" }), { path: "delete-bound.txt", deleted: true });
  await assert.rejects(access(target));
  assert.deepEqual((await readdir(workspaceRoot)).filter((entry) => entry.startsWith(".biny-delete-")), []);
}

async function testAtomicWriteRejectsChangedSnapshot(workspaceRoot: string): Promise<void> {
  const target = resolveWorkspacePath(workspaceRoot, "stale-atomic-target.txt", []);
  await writeFile(target, "approved-content", "utf8");
  const { snapshot } = await readUtf8FileForEdit(target);
  await writeFile(target, "changed-content", "utf8");

  await assert.rejects(
    atomicWriteUtf8File(target, "agent-content", snapshot),
    /target file changed before the atomic write started/i
  );
  assert.equal(await readFile(target, "utf8"), "changed-content");
  assert.deepEqual((await readdir(workspaceRoot)).filter((entry) => entry.startsWith(".biny-write-")), []);
}

async function testApprovedFileSnapshotCannotBeOverwritten(workspaceRoot: string): Promise<void> {
  const writeTarget = resolveWorkspacePath(workspaceRoot, "approved-write-target.txt", []);
  await writeFile(writeTarget, "approved-write-content", "utf8");
  const { snapshot: approvedWriteSnapshot } = await readUtf8FileForEdit(writeTarget);
  const writeExecution = runnable(createWriteFileTool({ workspaceRoot, ignore: [] }).resolveExecution({
    path: "approved-write-target.txt",
    content: "agent-write-content"
  }));
  await writeFile(writeTarget, "external-write-content-that-must-survive", "utf8");

  await assert.rejects(
    writeExecution.execute({
      toolCallId: "approved-write-race",
      approvedFile: { path: writeTarget, snapshot: approvedWriteSnapshot }
    }),
    /target file changed before the atomic write started/i
  );
  assert.equal(await readFile(writeTarget, "utf8"), "external-write-content-that-must-survive");

  const editTarget = resolveWorkspacePath(workspaceRoot, "approved-edit-target.txt", []);
  await writeFile(editTarget, "approved-before", "utf8");
  const { snapshot: approvedEditSnapshot } = await readUtf8FileForEdit(editTarget);
  const editExecution = runnable(createEditFileTool({ workspaceRoot, ignore: [] }).resolveExecution({
    path: "approved-edit-target.txt",
    oldText: "approved-before",
    newText: "agent-after"
  }));
  await writeFile(editTarget, "approved-before plus external change", "utf8");

  await assert.rejects(
    editExecution.execute({
      toolCallId: "approved-edit-race",
      approvedFile: { path: editTarget, snapshot: approvedEditSnapshot }
    }),
    /edit target changed after permission approval/i
  );
  assert.equal(await readFile(editTarget, "utf8"), "approved-before plus external change");
}

async function testAtomicCommitWindowPreservesExternalChanges(workspaceRoot: string): Promise<void> {
  const newTarget = resolveWorkspacePath(workspaceRoot, "commit-window-new.txt", []);
  const originalLink = fsPromises.link;
  let injectedCreate = false;
  fsPromises.link = async (existingPath, newPath) => {
    if (!injectedCreate && path.resolve(String(newPath)) === newTarget) {
      injectedCreate = true;
      await writeFile(newTarget, "external-created-during-commit", "utf8");
    }
    return await originalLink(existingPath, newPath);
  };
  try {
    await assert.rejects(
      atomicWriteUtf8File(newTarget, "agent-content", null),
      /target file appeared before the atomic write could be committed/i
    );
  } finally {
    fsPromises.link = originalLink;
  }
  assert.equal(await readFile(newTarget, "utf8"), "external-created-during-commit");

  const existingTarget = resolveWorkspacePath(workspaceRoot, "commit-window-existing.txt", []);
  await writeFile(existingTarget, "approved-before-commit", "utf8");
  const { snapshot } = await readUtf8FileForEdit(existingTarget);
  const originalRename = fsPromises.rename;
  let injectedWrite = false;
  fsPromises.rename = async (oldPath, newPath) => {
    if (
      !injectedWrite
      && path.resolve(String(newPath)) === existingTarget
      && path.basename(String(oldPath)).startsWith(".biny-write-")
    ) {
      injectedWrite = true;
      await writeFile(existingTarget, "external-write-during-commit-that-must-survive", "utf8");
    }
    return await originalRename(oldPath, newPath);
  };
  try {
    await assert.rejects(
      atomicWriteUtf8File(existingTarget, "agent-content", snapshot),
      /external version was restored/i
    );
  } finally {
    fsPromises.rename = originalRename;
  }
  assert.equal(await readFile(existingTarget, "utf8"), "external-write-during-commit-that-must-survive");
  assert.deepEqual(
    (await readdir(workspaceRoot)).filter((entry) => entry.startsWith(".biny-write-") || entry.startsWith(".biny-backup-")),
    []
  );
}

async function testAtomicWriteDetachesExistingHardlink(workspaceRoot: string): Promise<void> {
  const outsideDirectory = await mkdtemp(path.join(os.tmpdir(), "biny-hardlink-outside-"));
  const outsideTarget = path.join(outsideDirectory, "outside.txt");
  const workspaceTarget = path.join(workspaceRoot, "workspace-hardlink.txt");
  try {
    await writeFile(outsideTarget, "shared-before", "utf8");
    await link(outsideTarget, workspaceTarget);
    const execution = runnable(createWriteFileTool({ workspaceRoot, ignore: [] }).resolveExecution({
      path: "workspace-hardlink.txt",
      content: "workspace-after"
    }));

    await execution.execute({ toolCallId: "write-hardlink" });
    assert.equal(await readFile(workspaceTarget, "utf8"), "workspace-after");
    assert.equal(await readFile(outsideTarget, "utf8"), "shared-before");
  } finally {
    await rm(outsideDirectory, { recursive: true, force: true });
  }
}

async function testPreparedCanonicalTargetCannotBeRedirected(workspaceRoot: string): Promise<void> {
  if (process.platform === "win32") return;
  const safeDirectory = path.join(workspaceRoot, "canonical-safe");
  const outsideDirectory = await mkdtemp(path.join(os.tmpdir(), "biny-tool-outside-"));
  const alias = path.join(workspaceRoot, "canonical-alias");
  try {
    await mkdir(safeDirectory);
    await writeFile(path.join(safeDirectory, "target.txt"), "safe-before", "utf8");
    await symlink(safeDirectory, alias, "dir");
    const execution = runnable(createWriteFileTool({ workspaceRoot, ignore: [] }).resolveExecution({
      path: "canonical-alias/target.txt",
      content: "redirected"
    }));
    await unlink(alias);
    await symlink(outsideDirectory, alias, "dir");

    await assert.rejects(execution.execute({ toolCallId: "canonical-race" }), /escapes workspace|target changed/i);
    assert.equal(await readFile(path.join(safeDirectory, "target.txt"), "utf8"), "safe-before");
    await assert.rejects(access(path.join(outsideDirectory, "target.txt")));
  } finally {
    await unlink(alias).catch(() => undefined);
    await rm(outsideDirectory, { recursive: true, force: true });
  }
}

async function testPreAbortedShellDoesNotSpawn(workspaceRoot: string): Promise<void> {
  const target = path.join(workspaceRoot, "pre-abort-shell.txt");
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    runShellCommand(workspaceRoot, `touch ${shellQuote(target)}`, { signal: controller.signal }),
    isAbortError
  );
  await assert.rejects(access(target));
}

async function testAbortKillsStubbornProcessGroup(workspaceRoot: string): Promise<void> {
  if (process.platform === "win32") return;
  const readyPath = path.join(workspaceRoot, "abort-ready");
  const lateWritePath = path.join(workspaceRoot, "late-write.txt");
  const scriptPath = path.join(workspaceRoot, "stubborn-abort.mjs");
  await writeFile(scriptPath, [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
    "process.on('SIGTERM', () => undefined);",
    `setTimeout(() => writeFileSync(${JSON.stringify(lateWritePath)}, 'unexpected'), 500);`,
    "setInterval(() => undefined, 1000);"
  ].join("\n"), "utf8");

  const controller = new AbortController();
  const command = `${shellQuote(process.execPath)} ${shellQuote(scriptPath)} & wait`;
  const result = runShellCommand(workspaceRoot, command, {
    signal: controller.signal,
    timeoutMs: 5_000,
    terminationGraceMs: 50,
    killSettleMs: 50
  });
  await waitForFile(readyPath);
  controller.abort();

  await assert.rejects(result, isAbortError);
  await delay(650);
  await assert.rejects(access(lateWritePath));
}

async function testAbortKillsDetachedDescendant(workspaceRoot: string): Promise<void> {
  if (process.platform === "win32") return;
  const readyPath = path.join(workspaceRoot, "detached-ready");
  const pidPath = path.join(workspaceRoot, "detached-child.pid");
  const lateWritePath = path.join(workspaceRoot, "detached-late-write.txt");
  const childScriptPath = path.join(workspaceRoot, "detached-child.mjs");
  const parentScriptPath = path.join(workspaceRoot, "detached-parent.mjs");
  await writeFile(childScriptPath, [
    "import { writeFileSync } from 'node:fs';",
    `setTimeout(() => writeFileSync(${JSON.stringify(lateWritePath)}, 'unexpected'), 500);`,
    "setInterval(() => undefined, 1000);"
  ].join("\n"), "utf8");
  await writeFile(parentScriptPath, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    `const child = spawn(process.execPath, [${JSON.stringify(childScriptPath)}], { detached: true, stdio: 'ignore' });`,
    "child.unref();",
    `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
    `writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
    "setInterval(() => undefined, 1000);"
  ].join("\n"), "utf8");

  const controller = new AbortController();
  const result = runShellCommand(workspaceRoot, `${shellQuote(process.execPath)} ${shellQuote(parentScriptPath)}`, {
    signal: controller.signal,
    timeoutMs: 5_000,
    terminationGraceMs: 50,
    killSettleMs: 100
  });
  await waitForFile(readyPath);
  controller.abort();
  try {
    await assert.rejects(result, isAbortError);
    await delay(650);
    await assert.rejects(access(lateWritePath));
  } finally {
    const pid = Number(await readFile(pidPath, "utf8").catch(() => ""));
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The expected path already terminated the detached child.
      }
    }
  }
}

async function testCommandTimeoutHardSettles(workspaceRoot: string): Promise<void> {
  const scriptPath = path.join(workspaceRoot, "stubborn-timeout.mjs");
  await writeFile(scriptPath, [
    "process.on('SIGTERM', () => undefined);",
    "setInterval(() => undefined, 1000);"
  ].join("\n"), "utf8");
  const startedAt = Date.now();
  const result = await runShellCommand(workspaceRoot, `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`, {
    timeoutMs: 200,
    terminationGraceMs: 50,
    killSettleMs: 50
  });

  assert.equal(result.status, "timed_out");
  assert.equal(result.exitCode, 124);
  assert.match(result.error ?? "", /timed out after 200ms/i);
  assert.match(result.stderr, /timed out after 200ms/i);
  assert.ok(Date.now() - startedAt < 1_500, "hard timeout should settle even when SIGTERM is ignored");
}

async function testCommandExitStatus(workspaceRoot: string): Promise<void> {
  const completed = await runShellCommand(workspaceRoot, `${shellQuote(process.execPath)} -e ${shellQuote("process.exit(0)")}`);
  assert.equal(completed.status, "completed");
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.error, undefined);

  const failed = await runShellCommand(workspaceRoot, `${shellQuote(process.execPath)} -e ${shellQuote("process.exit(1)")}`);
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 1);
  assert.match(failed.error ?? "", /exited with code 1/i);

  const explicit124 = await runShellCommand(workspaceRoot, `${shellQuote(process.execPath)} -e ${shellQuote("process.exit(124)")}`);
  assert.equal(explicit124.status, "failed", "an explicit exit 124 must not be mistaken for the tool timeout");
  assert.equal(explicit124.exitCode, 124);
}

async function testGitInspectionDisablesConfiguredHelpers(workspaceRoot: string): Promise<void> {
  if (process.platform === "win32") return;
  const repository = path.join(workspaceRoot, "git-helper");
  const sentinel = path.join(workspaceRoot, "helper-ran.txt");
  const helper = path.join(workspaceRoot, "git-helper.mjs");
  await mkdir(repository);
  await mkdir(path.join(repository, ".ssh"));
  await mkdir(path.join(repository, "nested"));
  await writeFile(helper, [
    "#!/usr/bin/env node",
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(sentinel)}, 'unexpected');`
  ].join("\n"), "utf8");
  await chmod(helper, 0o755);
  await execFileAsync("git", ["init", "--quiet"], { cwd: repository });
  await writeFile(path.join(repository, "tracked.txt"), "before\n", "utf8");
  await writeFile(path.join(repository, ".ssh", "id_rsa"), "private-before\n", "utf8");
  await writeFile(path.join(repository, "nested", ".npmrc"), "//registry.example/:_authToken=before\n", "utf8");
  await writeFile(path.join(repository, "config.json"), "config-before\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: repository });
  await execFileAsync("git", ["-c", "user.name=Biny Test", "-c", "user.email=biny@example.invalid", "commit", "--quiet", "-m", "initial"], { cwd: repository });
  await execFileAsync("git", ["config", "diff.external", helper], { cwd: repository });
  await execFileAsync("git", ["config", "core.fsmonitor", helper], { cwd: repository });
  await writeFile(path.join(repository, "tracked.txt"), "after\n", "utf8");
  await writeFile(path.join(repository, ".ssh", "id_rsa"), "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n", "utf8");
  await writeFile(path.join(repository, "nested", ".npmrc"), "//registry.example/:_authToken=not-a-real-token\n", "utf8");
  await writeFile(path.join(repository, "config.json"), "not-a-real-config-secret\n", "utf8");

  const diff = await runnable(createGitDiffTool({ workspaceRoot: repository, ignore: [] }).resolveExecution({})).execute({ toolCallId: "git-diff" });
  assert.match(diff.output, /tracked\.txt/);
  assert.doesNotMatch(diff.output, /PRIVATE KEY|_authToken|config-secret|id_rsa|agent\.config/);
  await runnable(createGitStatusTool({ workspaceRoot: repository, ignore: [] }).resolveExecution({})).execute({ toolCallId: "git-status" });
  await collectProjectContext(repository, []);
  await assert.rejects(access(sentinel));
}

function runnable<TResult>(execution: ToolExecution<TResult>): RunnableToolExecution<TResult> {
  if ("isError" in execution) throw new Error(execution.errorMessage);
  return execution;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

await main();
