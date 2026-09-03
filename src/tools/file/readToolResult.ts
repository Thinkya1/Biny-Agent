/**
 * 归档工具结果读取模块。
 *
 * 工具输出因回合预算或模型投影被移出对话时，只在上下文里留下 `.biny/tool-results` 引用。
 * 该目录被 workspace ignore 规则挡在 `read_file` 之外，因此按需取回必须走这个受限入口：
 * 它只接受归档引用形态的路径，不接受任意工作区路径。
 */
import { z } from "zod";
import { readToolResultArchive, resolveToolResultArchivePath } from "../../session/toolResultArchive.js";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";

const defaultLength = 16_000;
const maxLength = 200_000;

/**
 * Retrieving an archived result is the one tool output the turn budget must not
 * archive again: the model asked for this content explicitly, and re-archiving
 * it would answer an archive reference with another archive reference. The
 * `length` cap above is what bounds it instead.
 */
export const readToolResultToolName = "read_tool_result";

export interface ReadToolResultArgs {
  archivePath: string;
  offset?: number;
  length?: number;
}

export interface ReadToolResultResult {
  archivePath: string;
  tool: string;
  archivedAt: string;
  totalCharacters: number;
  offset: number;
  content: string;
  hasMore: boolean;
}

export function createReadToolResultTool(context: ToolContext): Tool<ReadToolResultArgs, ReadToolResultResult> {
  return {
    name: readToolResultToolName,
    description: `Read a tool result archived out of the model context because it was large or superseded. Pass the archivePath reported in the result. Returns at most ${String(maxLength)} characters; page through longer results with offset.`,
    promptSnippet: "Read a paginated tool result archived outside the conversation",
    promptGuidelines: ["When a tool result reports an archivePath, use read_tool_result and continue paging until enough evidence is available"],
    parameters: {
      type: "object",
      properties: {
        archivePath: { type: "string", minLength: 1, description: "The .biny/tool-results reference reported by an archived tool result." },
        offset: { type: "integer", minimum: 0, description: "Character offset to start from. Defaults to 0." },
        length: { type: "integer", minimum: 1, maximum: maxLength, description: `Characters to return. Defaults to ${String(defaultLength)}.` }
      },
      required: ["archivePath"],
      additionalProperties: false
    },
    schema: z.object({
      archivePath: z.string().min(1),
      offset: z.number().int().min(0).optional(),
      length: z.number().int().min(1).max(maxLength).optional()
    }),
    // 与 filesystem.* 分开：subagent 的能力白名单不包含它，子 agent 不会意外读到父会话归档。
    capability: "toolresult.read",
    risk: "read",
    resolveExecution(args) {
      // 解析失败要在权限询问之前暴露，而不是等到执行阶段。
      resolveToolResultArchivePath(context.workspaceRoot, args.archivePath);
      return {
        accesses: ToolAccesses.readFile(resolveToolResultArchivePath(context.workspaceRoot, args.archivePath)),
        display: { kind: "generic", summary: "Read archived tool result", detail: args.archivePath },
        description: `Read archived tool result ${args.archivePath}`,
        approvalRule: `read_tool_result(${args.archivePath})`,
        async execute({ signal }) {
          const envelope = await readToolResultArchive(context.workspaceRoot, args.archivePath, signal);
          const offset = Math.min(args.offset ?? 0, envelope.output.length);
          const length = args.length ?? defaultLength;
          const content = envelope.output.slice(offset, offset + length);
          return {
            archivePath: args.archivePath,
            tool: envelope.tool,
            archivedAt: envelope.archivedAt,
            totalCharacters: envelope.output.length,
            offset,
            content,
            hasMore: offset + content.length < envelope.output.length
          };
        }
      };
    }
  };
}
