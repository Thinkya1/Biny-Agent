import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyUnifiedPatch, createApplyPatchTool } from "../src/tools/file/applyPatch.js";
import { createEditFileTool } from "../src/tools/file/editFile.js";
import { createMultiEditTool } from "../src/tools/file/multiEdit.js";
import { createMoveFileTool } from "../src/tools/file/moveFile.js";
import type { RunnableToolExecution, ToolExecution } from "../src/tools/types.js";
import { createToolPermissionRequest } from "../src/tools/display/ToolDisplay.js";

const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-file-tools-"));
try {
  testPatchParser();
  await testApplyPatchTool();
  await testEditToolsKeepDollarSequences();
  await testMoveFileTool();
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}

function testPatchParser(): void {
  const source = "one\ntwo\nthree\n";
  assert.equal(applyUnifiedPatch(source, "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n", "a.txt").content, "one\nTWO\nthree\n");
  assert.equal(applyUnifiedPatch(source, "--- a.txt\n+++ a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n", "a.txt").content, "one\nTWO\nthree\n");
  assert.equal(applyUnifiedPatch("alpha\nbeta", [
    "*** Begin Patch",
    "*** Update File: a.txt",
    "@@ -1,2 +1,2 @@",
    " alpha",
    "-beta",
    "+BETA",
    "*** End Patch"
  ].join("\n"), "a.txt").content, "alpha\nBETA");
  assert.throws(() => applyUnifiedPatch(source, "@@ -1,1 +1,1 @@\n-missing\n+new\n", "a.txt"), /did not match/);
  // 前序 hunk 增加的行数必须计入后续 hunk 的定位：纯新增 hunk 没有 oldLines 可匹配，
  // 完全按 hint 落位，不补偿就会插进前一个 hunk 的新增区域中间。
  assert.equal(applyUnifiedPatch("one\ntwo\nthree\nfour\n", [
    "@@ -1,1 +1,4 @@",
    "-one",
    "+ONE",
    "+ONE-B",
    "+ONE-C",
    "+ONE-D",
    "@@ -3,0 +6,1 @@",
    "+TWO-B"
  ].join("\n"), "a.txt").content, "ONE\nONE-B\nONE-C\nONE-D\ntwo\nTWO-B\nthree\nfour\n");
  // 前序 hunk 删除行时同样要补偿，否则纯新增 hunk 会落到被删区域之后。
  assert.equal(applyUnifiedPatch("a\nb\nc\nd\ne\n", [
    "@@ -1,2 +1,0 @@",
    "-a",
    "-b",
    "@@ -5,0 +3,1 @@",
    "+BEFORE-E"
  ].join("\n"), "a.txt").content, "c\nd\nBEFORE-E\ne\n");
}

async function testApplyPatchTool(): Promise<void> {
  await writeFile(path.join(workspaceRoot, "src.txt"), "before\nafter\n", "utf8");
  const tool = createApplyPatchTool({ workspaceRoot, ignore: [] });
  const execution = runnable(await tool.resolveExecution({
    path: "src.txt",
    patch: "@@ -1,2 +1,2 @@\n-before\n+changed\n after\n"
  }));
  const result = await execution.execute({ toolCallId: "patch-1" });
  assert.deepEqual(result, { path: "src.txt", hunks: 1, changedLines: 1, bytes: Buffer.byteLength("changed\nafter\n") });
  assert.equal(await readFile(path.join(workspaceRoot, "src.txt"), "utf8"), "changed\nafter\n");
  const request = await createToolPermissionRequest({ id: "patch-preview", name: "apply_patch", args: {
    path: "src.txt", patch: "@@ -1,2 +1,2 @@\n-changed\n+again\n after\n"
  } }, { workspaceRoot, ignore: [], sessionId: "file-tools" });
  assert.equal(request.actionType, "write");
  assert.match(request.details, /Hunks: 1/);
}

async function testEditToolsKeepDollarSequences(): Promise<void> {
  // String.replace 的字符串替换值会解释 $$、$&、$'、$` 等序列，替换值必须走函数形式。
  await writeFile(path.join(workspaceRoot, "dollar.txt"), "price: 10\n", "utf8");
  const edit = runnable(createEditFileTool({ workspaceRoot, ignore: [] }).resolveExecution({
    path: "dollar.txt",
    oldText: "10",
    newText: "$$ & $& $' $` $1"
  }));
  assert.deepEqual(await edit.execute({ toolCallId: "edit-dollar" }), { path: "dollar.txt", replacements: 1 });
  assert.equal(await readFile(path.join(workspaceRoot, "dollar.txt"), "utf8"), "price: $$ & $& $' $` $1\n");

  // 权限预览与落盘共用同一语义，diff 里也必须原样保留 $ 序列。
  const request = await createToolPermissionRequest({ id: "edit-dollar-preview", name: "edit_file", args: {
    path: "dollar.txt", oldText: "$1", newText: "$2 $$"
  } }, { workspaceRoot, ignore: [], sessionId: "file-tools" });
  assert.equal(request.diff?.includes("$2 $$"), true);

  const multi = runnable(await createMultiEditTool({ workspaceRoot, ignore: [] }).resolveExecution({
    path: "dollar.txt",
    edits: [{ oldText: "$1", newText: "$2 $$" }]
  }));
  await multi.execute({ toolCallId: "multi-dollar" });
  assert.equal(await readFile(path.join(workspaceRoot, "dollar.txt"), "utf8"), "price: $$ & $& $' $` $2 $$\n");
}

async function testMoveFileTool(): Promise<void> {
  await writeFile(path.join(workspaceRoot, "from.txt"), "move me\n", "utf8");
  const tool = createMoveFileTool({ workspaceRoot, ignore: [] });
  const execution = runnable(await tool.resolveExecution({ from: "from.txt", to: "nested/to.txt" }));
  await assert.rejects(execution.execute({ toolCallId: "move-missing-parent" }), /parent directory|ENOENT/i);
  await mkdir(path.join(workspaceRoot, "nested"));
  const retry = runnable(await tool.resolveExecution({ from: "from.txt", to: "nested/to.txt" }));
  assert.deepEqual(await retry.execute({ toolCallId: "move-1" }), { from: "from.txt", to: "nested/to.txt", moved: true });
  await assert.rejects(access(path.join(workspaceRoot, "from.txt")));
  assert.equal(await readFile(path.join(workspaceRoot, "nested/to.txt"), "utf8"), "move me\n");
  await writeFile(path.join(workspaceRoot, "again.txt"), "again\n", "utf8");
  const destinationExists = runnable(await tool.resolveExecution({ from: "again.txt", to: "nested/to.txt" }));
  await assert.rejects(destinationExists.execute({ toolCallId: "move-existing" }), /destination already exists/i);
}

function runnable<TResult>(execution: ToolExecution<TResult>): RunnableToolExecution<TResult> {
  if ("isError" in execution) throw new Error(execution.errorMessage);
  return execution;
}
