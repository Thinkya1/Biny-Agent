/**
 * 多段精确编辑工具。
 *
 * `multi_edit` 在一个文件内顺序应用多段精确替换，并只做一次原子提交。任意替换找不到时整次
 * 调用失败，避免项目级修改因中途落盘而留下半成品。
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

export interface MultiEditOperation {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface MultiEditArgs {
  path: string;
  edits: MultiEditOperation[];
}

export interface MultiEditResult {
  path: string;
  edits: number;
  replacements: number;
  bytes: number;
}

export interface AppliedMultiEdits {
  content: string;
  replacements: number;
}

const operationSchema = z.object({
  oldText: z.string().min(1),
  newText: z.string(),
  replaceAll: z.boolean().optional()
});

export function createMultiEditTool(context: ToolContext): Tool<MultiEditArgs, MultiEditResult> {
  return {
    name: "multi_edit",
    description: "Atomically apply an ordered batch of exact text replacements to one UTF-8 workspace file.",
    promptSnippet: "Apply an ordered batch of exact replacements to one file",
    promptGuidelines: ["Use multi_edit for multiple localized replacements in the same file; edits must be ordered and non-overlapping"],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Workspace-relative file path to edit." },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          description: "Ordered exact replacements. The whole batch fails if any oldText is absent.",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", minLength: 1 },
              newText: { type: "string" },
              replaceAll: { type: "boolean", description: "Replace every non-overlapping match instead of only the first." }
            },
            required: ["oldText", "newText"],
            additionalProperties: false
          }
        }
      },
      required: ["path", "edits"],
      additionalProperties: false
    },
    schema: z.object({ path: z.string().min(1), edits: z.array(operationSchema).min(1).max(100) }),
    capability: "filesystem.edit",
    risk: "write",
    async resolveExecution(args) {
      const absolutePath = resolveWorkspacePath(context.workspaceRoot, args.path, context.ignore);
      const prepared = await readUtf8FileForEdit(absolutePath);
      // Validate the complete batch before asking for permission so an invalid
      // call can never produce a misleading partial-change preview.
      applyMultiEdits(prepared.content, args.edits, args.path);
      return {
        accesses: ToolAccesses.readWriteFile(absolutePath),
        display: { kind: "file_io", operation: "edit", path: args.path, detail: `${String(args.edits.length)} exact edits` },
        description: `Apply ${String(args.edits.length)} edits to ${args.path}`,
        retrySafety: "unsafe",
        approvalRule: `multi_edit(${args.path})`,
        async execute({ signal, approvedFile, onExecutionState }) {
          signal?.throwIfAborted();
          const currentPath = resolveWorkspacePath(context.workspaceRoot, args.path, context.ignore);
          if (currentPath !== absolutePath) throw new Error("The multi-edit target changed after the tool call was prepared.");
          if (approvedFile && approvedFile.path !== absolutePath) {
            throw new Error("The approved multi-edit target does not match the prepared tool target.");
          }
          if (approvedFile && !sameOptionalFileSnapshot(approvedFile.snapshot, prepared.snapshot)) {
            throw new Error("The multi-edit target changed before permission approval.");
          }
          const current = await readUtf8FileForEdit(absolutePath, signal);
          if (!sameFileSnapshot(current.snapshot, prepared.snapshot)) {
            throw new Error("The multi-edit target changed after the tool call was prepared.");
          }
          const applied = applyMultiEdits(current.content, args.edits, args.path);
          signal?.throwIfAborted();
          const bytes = await atomicWriteUtf8File(absolutePath, applied.content, current.snapshot, signal, (evidence) => onExecutionState?.("side_effect_committed", evidence));
          return { path: args.path, edits: args.edits.length, replacements: applied.replacements, bytes };
        }
      };
    }
  };
}

export function applyMultiEdits(content: string, edits: readonly MultiEditOperation[], filePath = "file"): AppliedMultiEdits {
  let next = content;
  let replacements = 0;
  for (const [index, edit] of edits.entries()) {
    if (!edit.oldText) throw new Error(`Edit ${String(index + 1)} for ${filePath} has an empty oldText.`);
    const matches = countOccurrences(next, edit.oldText);
    if (matches === 0) throw new Error(`oldText for edit ${String(index + 1)} was not found in ${filePath}`);
    if (edit.replaceAll) {
      next = next.split(edit.oldText).join(edit.newText);
      replacements += matches;
    } else {
      // 函数形式的替换值才会被原样插入；字符串形式会把 newText 里的 $$、$& 等序列当成模式解释。
      next = next.replace(edit.oldText, () => edit.newText);
      replacements += 1;
    }
  }
  return { content: next, replacements };
}

function countOccurrences(content: string, query: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= content.length - query.length) {
    const index = content.indexOf(query, offset);
    if (index === -1) break;
    count += 1;
    offset = index + query.length;
  }
  return count;
}
