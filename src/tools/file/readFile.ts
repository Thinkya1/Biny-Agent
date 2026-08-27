/**
 * 文件读取工具模块。
 *
 * `read_file` 读取工作区内通过路径校验的 UTF-8 文本文件；桌面端还可读取由应用保存的
 * `@attachments/` 虚拟路径，但不能借此访问任意用户目录。
 */
import { z } from "zod";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";
import { maxReadFileBytes, readBoundedUtf8File } from "./safeFileIo.js";

export interface ReadFileArgs {
  // 工具层只接受相对路径；resolveWorkspacePath 会拒绝 ../ 和被忽略的目录。
  path: string;
}

export interface ReadFileResult {
  path: string;
  content: string;
}

export function createReadFileTool(context: ToolContext): Tool<ReadFileArgs, ReadFileResult> {
  // read_file 是最小只读工具：解析路径、读 utf8、按原路径返回内容。
  return {
    name: "read_file",
    description: `Read a UTF-8 file inside the workspace or a supplied attachment, up to ${String(maxReadFileBytes)} bytes. Larger files are rejected; use search_files to inspect their bounded prefix.`,
    promptSnippet: "Read UTF-8 file contents from the workspace or supplied attachments",
    promptGuidelines: ["Use read_file instead of shell commands to read a file when its path is known"],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Workspace-relative UTF-8 text file path to read." }
      },
      required: ["path"],
      additionalProperties: false
    },
    schema: z.object({ path: z.string().min(1) }),
    capability: "filesystem.read",
    risk: "read",
    resolveExecution(args) {
      const absolutePath = resolveReadablePath(context, args.path);
      return {
        accesses: ToolAccesses.readFile(absolutePath),
        display: { kind: "file_io", operation: "read", path: args.path },
        description: `Read ${args.path}`,
        approvalRule: `read_file(${args.path})`,
        async execute({ signal }) {
          signal?.throwIfAborted();
          const currentPath = resolveReadablePath(context, args.path);
          if (currentPath !== absolutePath) throw new Error("The read target changed after the tool call was prepared.");
          const result = await readBoundedUtf8File(absolutePath, maxReadFileBytes, "reject", signal);
          return { path: args.path, content: result.content };
        }
      };
    }
  };
}

function resolveReadablePath(context: ToolContext, requestedPath: string): string {
  const attachmentPrefix = "@attachments/";
  if (!requestedPath.startsWith(attachmentPrefix)) {
    return resolveWorkspacePath(context.workspaceRoot, requestedPath, context.ignore);
  }
  if (!context.attachmentRoot) throw new Error("No attachments are available for this session.");
  const relativePath = requestedPath.slice(attachmentPrefix.length);
  return resolveWorkspacePath(context.attachmentRoot, relativePath, []);
}
