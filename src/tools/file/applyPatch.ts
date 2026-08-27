/**
 * Applies one exact unified-diff update to one existing workspace file and
 * commits the result through the same snapshot-bound atomic writer as edit_file.
 * Add/delete/move operations have dedicated tools so this parser cannot
 * silently replace an unrelated path.
 */
import { z } from "zod";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";
import {
  atomicWriteUtf8File,
  readUtf8FileForEdit,
  sameFileSnapshot,
  sameOptionalFileSnapshot
} from "./safeFileIo.js";

export interface ApplyPatchArgs {
  path: string;
  patch: string;
}

export interface ApplyPatchResult {
  path: string;
  hunks: number;
  changedLines: number;
  bytes: number;
}

interface ParsedHunk {
  oldStart: number;
  oldLines: string[];
  newLines: string[];
}

export function createApplyPatchTool(context: ToolContext): Tool<ApplyPatchArgs, ApplyPatchResult> {
  return {
    name: "apply_patch",
    description: "Apply exact unified-diff hunks to one existing UTF-8 workspace file atomically. Use write_file for new files and delete_file/move_file for path changes.",
    promptSnippet: "Apply exact unified-diff hunks to one existing file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Workspace-relative existing file path to patch." },
        patch: { type: "string", minLength: 1, description: "Unified diff hunks beginning with @@; context lines start with a space, removals with -, additions with +." }
      },
      required: ["path", "patch"],
      additionalProperties: false
    },
    schema: z.object({ path: z.string().min(1), patch: z.string().min(1) }),
    capability: "filesystem.edit",
    risk: "write",
    async resolveExecution(args) {
      const absolutePath = resolveWorkspacePath(context.workspaceRoot, args.path, context.ignore);
      const prepared = await readUtf8FileForEdit(absolutePath);
      const preview = applyUnifiedPatch(prepared.content, args.patch, args.path);
      return {
        accesses: ToolAccesses.readWriteFile(absolutePath),
        display: {
          kind: "file_io",
          operation: "edit",
          path: args.path,
          before: prepared.content,
          after: preview.content,
          detail: `${String(preview.hunks)} patch hunk(s)`
        },
        description: `Apply patch to ${args.path}`,
        retrySafety: "unsafe",
        approvalRule: `apply_patch(${args.path})`,
        async execute({ signal, approvedFile, onExecutionState }) {
          signal?.throwIfAborted();
          const currentPath = resolveWorkspacePath(context.workspaceRoot, args.path, context.ignore);
          if (currentPath !== absolutePath) throw new Error("The patch target changed after the tool call was prepared.");
          if (approvedFile && approvedFile.path !== absolutePath) {
            throw new Error("The approved patch target does not match the prepared target.");
          }
          if (approvedFile && !sameOptionalFileSnapshot(approvedFile.snapshot, prepared.snapshot)) {
            throw new Error("The patch target changed before permission approval.");
          }
          const current = await readUtf8FileForEdit(absolutePath, signal);
          if (!sameFileSnapshot(current.snapshot, prepared.snapshot)) {
            throw new Error("The patch target changed after the tool call was prepared.");
          }
          const applied = applyUnifiedPatch(current.content, args.patch, args.path);
          const bytes = await atomicWriteUtf8File(absolutePath, applied.content, current.snapshot, signal, (evidence) => onExecutionState?.("side_effect_committed", evidence));
          return { path: args.path, hunks: applied.hunks, changedLines: applied.changedLines, bytes };
        }
      };
    }
  };
}

export interface AppliedUnifiedPatch {
  content: string;
  hunks: number;
  changedLines: number;
}

export function applyUnifiedPatch(content: string, patch: string, filePath = "file"): AppliedUnifiedPatch {
  const parsed = parsePatch(patch, filePath);
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  let lines = content.split(/\r\n|\n/u);
  let cursor = 0;
  // hunk 头里的 oldStart 针对原始文件；每应用一个 hunk 都会平移后续位置，这里累计净行数变化，
  // 否则纯新增 hunk（没有 oldLines 可匹配，直接按 hint 落位）会被贴到错误的位置。
  let lineOffset = 0;
  let changedLines = 0;

  for (const [index, hunk] of parsed.entries()) {
    const hint = Math.max(0, Math.min(lines.length, hunk.oldStart - 1 + lineOffset));
    const match = findHunkMatch(lines, hunk.oldLines, hint, cursor, filePath, index + 1);
    const replacement = hunk.newLines;
    lines = [...lines.slice(0, match), ...replacement, ...lines.slice(match + hunk.oldLines.length)];
    cursor = match + replacement.length;
    lineOffset += replacement.length - hunk.oldLines.length;
    changedLines += hunk.oldLines.filter((line, lineIndex) => line !== replacement[lineIndex]).length
      + Math.max(0, replacement.length - hunk.oldLines.length);
  }

  return { content: lines.join(lineEnding), hunks: parsed.length, changedLines };
}

function parsePatch(patch: string, filePath: string): ParsedHunk[] {
  let lines = patch.split(/\r\n|\n/u);
  if (lines[0]?.trim() === "*** Begin Patch") {
    if (lines.at(-1)?.trim() !== "*** End Patch") throw new Error(`Patch wrapper is incomplete for ${filePath}.`);
    lines = lines.slice(1, -1);
    const updates = lines.filter((line) => line.startsWith("*** Update File: "));
    if (updates.length !== 1 || updates[0] !== `*** Update File: ${filePath}`) {
      throw new Error(`apply_patch only accepts one Update File matching ${filePath}.`);
    }
    lines = lines.slice(lines.indexOf(updates[0]) + 1);
  }

  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | undefined;
  for (const [lineIndex, line] of lines.entries()) {
    if (line.startsWith("@@")) {
      const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u);
      if (!header) throw new Error(`Invalid patch hunk header in ${filePath}: ${line}`);
      current = {
        oldStart: Number(header[1]),
        oldLines: [],
        newLines: []
      };
      hunks.push(current);
      continue;
    }
    if (!current) {
      if (line.startsWith("*** ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.trim() === "") continue;
      throw new Error(`Patch content appeared before a hunk in ${filePath}.`);
    }
    if (line === "" && lineIndex === lines.length - 1) continue;
    if (line.startsWith("\\ No newline at end of file")) continue;
    const prefix = line[0];
    if (prefix === " " || prefix === "-") current.oldLines.push(line.slice(1));
    if (prefix === " " || prefix === "+") current.newLines.push(line.slice(1));
    if (prefix !== " " && prefix !== "-" && prefix !== "+") {
      throw new Error(`Invalid patch line in ${filePath}: ${line}`);
    }
  }
  if (!hunks.length) throw new Error(`Patch contains no hunks for ${filePath}.`);
  return hunks;
}

function findHunkMatch(
  lines: string[],
  oldLines: string[],
  hint: number,
  minimum: number,
  filePath: string,
  hunkNumber: number
): number {
  if (!oldLines.length) return hint;
  if (matchesAt(lines, oldLines, hint) && hint >= minimum) return hint;
  const matches: number[] = [];
  for (let index = minimum; index <= lines.length - oldLines.length; index += 1) {
    if (matchesAt(lines, oldLines, index)) matches.push(index);
  }
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `Patch hunk ${String(hunkNumber)} did not match ${filePath}.`
      : `Patch hunk ${String(hunkNumber)} matched multiple locations in ${filePath}.`);
  }
  return matches[0] as number;
}

function matchesAt(lines: string[], expected: string[], start: number): boolean {
  if (start < 0 || start + expected.length > lines.length) return false;
  return expected.every((line, index) => lines[start + index] === line);
}
