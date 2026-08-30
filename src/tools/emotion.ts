/**
 * 模型维护 Agent 情绪快照的内置工具。
 *
 * 情绪写入只影响后续回复的表达层；真正的 session 状态、疲劳值和存储位置由 AgentSession
 * 通过依赖注入提供，工具本身不持有跨会话的运行时状态。
 */
import { z } from "zod";
import { EmotionStorage } from "../agent/context/emotionStorage.js";
import type { BlendedEmotion, EmotionScope, EmotionState } from "../agent/context/emotionTypes.js";
import { ToolAccesses } from "./access.js";
import type { Tool } from "./types.js";

const updateEmotionSchema = z.object({
  scope: z.enum(["base", "context"]),
  mood: z.string().trim().min(1).max(32),
  valence: z.number().finite(),
  energy: z.number().finite(),
  trigger: z.string().trim().max(200).optional()
}).strict();

type UpdateEmotionArgs = z.infer<typeof updateEmotionSchema>;

export interface EmotionToolOptions {
  getStorage: () => EmotionStorage | undefined;
  getFatigue: () => number;
  now?: () => Date;
}

export interface UpdateEmotionResult {
  updated: true;
  scope: EmotionScope;
  state: EmotionState;
  blended: BlendedEmotion;
}

export function createEmotionTool(options: EmotionToolOptions): Tool<UpdateEmotionArgs, UpdateEmotionResult | string> {
  const now = options.now ?? (() => new Date());
  return {
    name: "update_emotion",
    description: "Update the agent's local expression state for this session or as a durable base mood. Emotion only affects tone and initiative, never task goals, permissions, safety rules or verified facts.",
    promptSnippet: "Update the agent's bounded expression state when the conversation meaningfully changes",
    promptGuidelines: [
      "Use update_emotion when the conversation causes a meaningful change in tone or energy; do not update on every message.",
      "Use context for a session-specific shift and keep its valence within three points of the base mood; use base only for a significant persistent change.",
      "Keep mood and trigger in Chinese, use valence and energy on a 0-10 scale, and describe only the cause relevant to the expression state."
    ],
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["base", "context"], description: "Use context for this session; use base only for a significant persistent change." },
        mood: { type: "string", maxLength: 32, description: "Short Chinese mood label, at most 32 characters." },
        valence: { type: "number", description: "Expression valence from 0 to 10; values outside the range are clamped." },
        energy: { type: "number", description: "Expression energy from 0 to 10; values outside the range are clamped." },
        trigger: { type: "string", maxLength: 200, description: "Optional concise Chinese reason, at most 200 characters." }
      },
      required: ["scope", "mood", "valence", "energy"],
      additionalProperties: false
    },
    schema: updateEmotionSchema,
    source: "builtin",
    capability: "emotion.write",
    risk: "write",
    resolveExecution(args: UpdateEmotionArgs) {
      const storage = options.getStorage();
      if (!storage) {
        const message = "Agent emotion storage is unavailable.";
        return { isError: true as const, result: message, errorMessage: message };
      }
      const mood = args.mood.replace(/\s+/gu, " ").trim();
      const trigger = args.trigger?.replace(/\s+/gu, " ").trim() || undefined;
      return {
        accesses: ToolAccesses.writeTree(storage.directory),
        display: { kind: "generic" as const, summary: `Update ${args.scope} emotion`, detail: { mood } },
        description: `Update the ${args.scope} emotion snapshot`,
        retrySafety: "idempotent" as const,
        approvalRule: "update_emotion",
        async execute(context): Promise<UpdateEmotionResult> {
          const state: EmotionState = {
            mood,
            valence: clamp(args.valence),
            energy: clamp(args.energy),
            updatedAt: now().toISOString(),
            trigger
          };
          if (args.scope === "context") {
            if (context.sessionId === undefined) throw new Error("A session is required to update context emotion.");
            await storage.writeContext(context.sessionId, state);
          } else {
            await storage.writeBase(state);
          }
          return {
            updated: true,
            scope: args.scope,
            state,
            blended: await storage.readBlended(context.sessionId, options.getFatigue())
          };
        }
      };
    }
  };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(10, Math.max(0, value));
}
