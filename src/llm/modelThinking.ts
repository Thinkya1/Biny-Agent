/** 模型选择器共用的思考档位计算；这里保持纯函数，避免 UI 引入后端运行时依赖。 */
import type { ReasoningEffort, ThinkingLevelMap } from "../config/schema.js";

export type ThinkingSelection = "off" | ReasoningEffort;

export interface ModelThinkingSelectionSource {
  efforts: readonly ReasoningEffort[];
  thinkingLevelMap: ThinkingLevelMap;
}

export function thinkingLabel(value: ThinkingSelection): string {
  // 与 Pi Agent 一致，直接展示模型声明的 canonical 英文 token。
  return value;
}

/**
 * `off` 是否可用由模型的 canonical map 决定，Desktop Composer 和 TUI 共用同一顺序。
 */
export function modelThinkingSelections(model: ModelThinkingSelectionSource): ThinkingSelection[] {
  return [
    ...(model.thinkingLevelMap.off !== undefined && model.thinkingLevelMap.off !== null ? ["off" as const] : []),
    ...model.efforts
  ];
}
