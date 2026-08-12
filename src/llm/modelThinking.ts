/** 模型选择器共用的思考档位计算；这里保持纯函数，避免 UI 引入后端运行时依赖。 */
import type { ReasoningEffort, ThinkingLevelMap } from "../config/schema.js";

export type ThinkingSelection = "off" | ReasoningEffort;

export interface ModelThinkingSelectionSource {
  efforts: readonly ReasoningEffort[];
  thinkingLevelMap: ThinkingLevelMap;
}

const thinkingLabels: Record<ThinkingSelection, string> = {
  off: "标准",
  minimal: "极低",
  low: "轻度",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高"
};

export function thinkingLabel(value: ThinkingSelection): string {
  return thinkingLabels[value] ?? value;
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
