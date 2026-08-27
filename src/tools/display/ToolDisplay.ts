/**
 * 工具展示规则模块。
 *
 * 这里只负责把工具调用参数转换成权限确认所需的标题、摘要和 diff。它不执行工具、不记录 session，
 * 也不决定是否允许调用，保证 UI 展示格式不会影响工具协议。
 */
import { analyzePermissionRequest, commandSafetyWarnings } from "../../permission/policy.js";
import type { PermissionPrompt, PermissionRequestContext } from "../../permission/PermissionManager.js";
import { createUnifiedDiff } from "../../utils/diff.js";
import { redactSecrets, redactSensitiveValue } from "../../utils/secrets.js";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import { maxEditFileBytes, readBoundedUtf8File } from "../file/safeFileIo.js";
import { applyMultiEdits, type MultiEditOperation } from "../file/multiEdit.js";
import { applyUnifiedPatch } from "../file/applyPatch.js";
export interface ToolCallInput {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolDisplayContext {
  workspaceRoot: string;
  ignore: string[];
  sessionId?: string;
}

export interface ToolDisplayRule {
  title: string;
  summarize(args: unknown, context: ToolDisplayContext): Promise<ToolDisplaySummary>;
}

export interface ToolDisplaySummary {
  details: string;
  diff?: string;
  preview?: string;
  requireFullYes?: boolean;
  changeSummary?: string;
}

export async function createToolPermissionRequest(
  call: ToolCallInput,
  context: ToolDisplayContext,
  permissionContext?: PermissionRequestContext
): Promise<PermissionPrompt> {
  const requestContext = permissionContext ?? analyzePermissionRequest({
    toolName: call.name,
    args: call.args,
    sessionId: context.sessionId ?? "",
    projectRoot: context.workspaceRoot
  });
  const rule = toolDisplayRules[call.name] ?? defaultDisplayRule;
  const summary = await rule.summarize(call.args, context);
  const diff = summary.diff === undefined ? undefined : redactSecrets(summary.diff);
  const preview = summary.preview === undefined ? undefined : redactSecrets(summary.preview);
  return {
    ...requestContext,
    command: requestContext.command === undefined ? undefined : redactSecrets(requestContext.command),
    reason: requestContext.reason === undefined ? undefined : redactSecrets(requestContext.reason),
    toolCallId: call.id,
    tool: call.name,
    title: rule.title,
    details: redactSecrets(summary.details),
    requireFullYes: summary.requireFullYes ?? requestContext.riskLevel === "critical",
    diff,
    preview,
    diffPreview: diff,
    changeSummary: summary.changeSummary === undefined ? undefined : redactSecrets(summary.changeSummary)
  };
}

export const toolDisplayRules: Record<string, ToolDisplayRule> = {
  run_command: {
    title: "Command execution request",
    async summarize(args) {
      const command = getStringField(args, "command");
      const warnings = commandSafetyWarnings(command);
      return {
        details: [command, warnings.length ? `\nSensitive command warning: ${warnings.join(", ")}` : ""].join(""),
        changeSummary: `Run command: ${command}`,
        requireFullYes: warnings.length > 0
      };
    }
  },
  start_process: {
    title: "Managed process start request",
    async summarize(args) {
      const command = getStringField(args, "command");
      const warnings = commandSafetyWarnings(command);
      return {
        details: [command, warnings.length ? `\nSensitive command warning: ${warnings.join(", ")}` : ""].join(""),
        changeSummary: `Start managed process: ${command}`,
        requireFullYes: warnings.length > 0
      };
    }
  },
  write_file: {
    title: "File write request",
    async summarize(args, context) {
      const filePath = getStringField(args, "path");
      const content = getStringField(args, "content");
      const oldContent = await readExistingFileForDiff(filePath, context);
      const diff = oldContent ? createUnifiedDiff(filePath, oldContent, content) : undefined;
      const preview = oldContent
        ? formatUnifiedDiffPreview(filePath, diff ?? "", 16)
        : formatFileContentPreview(filePath, content, 16);
      return {
        details: `File: ${filePath}\nBytes: ${Buffer.byteLength(content, "utf8")}`,
        diff,
        preview,
        changeSummary: oldContent ? `Overwrite ${filePath}` : `Create ${filePath}`
      };
    }
  },
  edit_file: {
    title: "File edit request",
    async summarize(args, context) {
      const filePath = getStringField(args, "path");
      const oldText = getStringField(args, "oldText");
      const newText = getStringField(args, "newText");
      const oldContent = await readExistingFileForDiff(filePath, context);
      // 函数形式的替换值才会被原样插入；字符串形式会把 newText 里的 $$、$& 等序列当成模式解释，
      // 导致预览 diff 与实际落盘内容不一致。
      const nextContent = oldContent.includes(oldText) ? oldContent.replace(oldText, () => newText) : oldContent;
      const diff = createUnifiedDiff(filePath, oldContent, nextContent);
      const preview = formatUnifiedDiffPreview(filePath, diff, 16);
      return {
        details: `File: ${filePath}\nReplace bytes: ${Buffer.byteLength(oldText, "utf8")} -> ${Buffer.byteLength(newText, "utf8")}`,
        diff,
        preview,
        changeSummary: `Edit ${filePath}`
      };
    }
  },
  multi_edit: {
    title: "Multi-edit request",
    async summarize(args, context) {
      const filePath = getStringField(args, "path");
      const edits = getMultiEditOperations(args);
      const oldContent = await readExistingFileForDiff(filePath, context);
      const applied = applyMultiEdits(oldContent, edits, filePath);
      const diff = createUnifiedDiff(filePath, oldContent, applied.content);
      const preview = formatUnifiedDiffPreview(filePath, diff, 20);
      return {
        details: `File: ${filePath}\nEdits: ${String(edits.length)}\nReplacements: ${String(applied.replacements)}`,
        diff,
        preview,
        changeSummary: `Apply ${String(edits.length)} edits to ${filePath}`
      };
    }
  },
  apply_patch: {
    title: "Patch application request",
    async summarize(args, context) {
      const filePath = getStringField(args, "path");
      const patch = getStringField(args, "patch");
      const oldContent = await readExistingFileForDiff(filePath, context);
      const applied = applyUnifiedPatch(oldContent, patch, filePath);
      const diff = createUnifiedDiff(filePath, oldContent, applied.content);
      const preview = formatUnifiedDiffPreview(filePath, diff, 24);
      return {
        details: `File: ${filePath}\nHunks: ${String(applied.hunks)}\nChanged lines: ${String(applied.changedLines)}`,
        diff,
        preview,
        changeSummary: `Apply patch to ${filePath}`
      };
    }
  },
  move_file: {
    title: "File move request",
    async summarize(args, context) {
      const from = getStringField(args, "from");
      const to = getStringField(args, "to");
      const oldContent = await readExistingFileForDiff(from, context);
      const preview = formatFileContentPreview(from, oldContent, 12);
      return {
        details: `Move ${from} -> ${to}\nBytes: ${Buffer.byteLength(oldContent, "utf8")}`,
        preview,
        changeSummary: `Move ${from} to ${to}`,
        requireFullYes: true
      };
    }
  },
  delete_file: {
    title: "File deletion request",
    async summarize(args, context) {
      const filePath = getStringField(args, "path");
      const oldContent = await readExistingFileForDiff(filePath, context);
      const diff = createUnifiedDiff(filePath, oldContent, "");
      const preview = formatUnifiedDiffPreview(filePath, diff, 16);
      return {
        details: `File: ${filePath}\nBytes: ${Buffer.byteLength(oldContent, "utf8")}`,
        diff,
        preview,
        changeSummary: `Delete ${filePath}`,
        requireFullYes: true
      };
    }
  }
};

const defaultDisplayRule: ToolDisplayRule = {
  title: "Tool permission request",
  async summarize(args) {
    return { details: JSON.stringify(redactSensitiveValue(args), null, 2) };
  }
};

async function readExistingFileForDiff(filePath: string, context: ToolDisplayContext): Promise<string> {
  const absolutePath = resolveWorkspacePath(context.workspaceRoot, filePath, context.ignore);
  try {
    return (await readBoundedUtf8File(absolutePath, maxEditFileBytes, "reject")).content;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

function getStringField(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

function getMultiEditOperations(value: unknown): MultiEditOperation[] {
  if (typeof value !== "object" || value === null || !("edits" in value) || !Array.isArray(value.edits)) return [];
  return value.edits.flatMap((entry): MultiEditOperation[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const oldText = "oldText" in entry && typeof entry.oldText === "string" ? entry.oldText : undefined;
    const newText = "newText" in entry && typeof entry.newText === "string" ? entry.newText : undefined;
    if (oldText === undefined || newText === undefined) return [];
    const replaceAll = "replaceAll" in entry && typeof entry.replaceAll === "boolean" ? entry.replaceAll : undefined;
    return [{ oldText, newText, replaceAll }];
  });
}

// Permission previews are plain text shared by CLI and TUI. They deliberately
// stay in the tool domain so a core tool never imports a TUI rendering module.
function formatFileContentPreview(filePath: string, content: string, maxLines: number): string {
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = normalized ? normalized.split("\n") : [];
  const shown = lines.slice(0, maxLines);
  return [
    `Write ${filePath}`,
    ...shown.map((line, index) => `${String(index + 1).padStart(4, " ")}   ${line}`),
    ...(lines.length > shown.length ? [`     … ${String(lines.length - shown.length)} more line${lines.length - shown.length > 1 ? "s" : ""} hidden`] : [])
  ].join("\n");
}

function formatUnifiedDiffPreview(filePath: string, diff: string, maxLines: number): string {
  const body: string[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const line of diff.split("\n")) {
    const range = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (range) {
      oldLine = Number.parseInt(range[1] ?? "1", 10);
      newLine = Number.parseInt(range[2] ?? "1", 10);
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("-")) {
      body.push(`${String(oldLine).padStart(4, " ")} - ${line.slice(1)}`);
      oldLine += 1;
      continue;
    }
    if (line.startsWith("+")) {
      body.push(`${String(newLine).padStart(4, " ")} + ${line.slice(1)}`);
      newLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      body.push(`${String(newLine).padStart(4, " ")}   ${line.slice(1)}`);
      oldLine += 1;
      newLine += 1;
    }
  }

  return [
    `Edit ${filePath}`,
    ...body.slice(0, maxLines),
    ...(body.length > maxLines ? [`     … ${String(body.length - maxLines)} more line${body.length - maxLines > 1 ? "s" : ""} hidden`] : [])
  ].join("\n");
}
