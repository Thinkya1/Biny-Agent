/**
 * 显式完成声明工具。
 *
 * 模型认为任务完成时调用它提交完成摘要与证据。运行时把这次调用当作收口信号:声明会进入
 * CompletionGuard,触发一次独立的语义复核;用过工具却只用纯文本收尾的运行会被打回要求补一次
 * 声明(软强制,最多提醒一次)。
 */
import { z } from "zod";
import { ToolAccesses } from "./access.js";
import type { Tool } from "./types.js";

export const attemptCompletionToolName = "attempt_completion";

const attemptCompletionSchema = z.object({
  summary: z.string().min(1).max(2_000),
  evidence: z.string().min(1).max(2_000).optional()
});

export type AttemptCompletionArgs = z.infer<typeof attemptCompletionSchema>;

export interface AttemptCompletionResult {
  declared: true;
  summary: string;
}

export function createAttemptCompletionTool(): Tool<AttemptCompletionArgs, AttemptCompletionResult> {
  return {
    name: attemptCompletionToolName,
    description: [
      "Declare that the user's task is complete. Pass a concise summary of the outcome and the concrete evidence backing it (files changed, commands run, checks that passed).",
      "Call it once, only when everything requested is actually done; the runtime independently reviews the declaration and may hand the task back if the evidence does not hold.",
      "Skip it for pure question-answering turns that used no tools."
    ].join(" "),
    promptSnippet: "Declare the task complete with a summary and concrete evidence",
    promptGuidelines: [
      "After using tools, close out a finished task with attempt_completion (summary plus evidence) instead of an unstructured stop"
    ],
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          minLength: 1,
          maxLength: 2_000,
          description: "What was accomplished, in one or two sentences."
        },
        evidence: {
          type: "string",
          minLength: 1,
          maxLength: 2_000,
          description: "Concrete proof: files changed, commands run, checks that passed."
        }
      },
      required: ["summary"],
      additionalProperties: false
    },
    schema: attemptCompletionSchema,
    // 只记录声明本身,不碰工作区;真正的验收由 completion review 负责。
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: "Declare completion", detail: args.summary },
        description: "Declare task completion",
        approvalRule: "attempt_completion",
        async execute() {
          return { declared: true, summary: args.summary };
        }
      };
    }
  };
}
