import { modelThinkingSelections, thinkingLabel, type ThinkingSelection } from "../llm/modelThinking.js";
import type { ModelChoice } from "../llm/ModelRegistry.js";

export interface ModelThinkingOption {
  value: ThinkingSelection;
  label: string;
}

/**
 * 选择器只展示当前模型声明的 canonical thinking level；这些名称是模型/Provider
 * 的能力 token，不是跨模型可比较的真实推理程度。
 */
export function modelThinkingOptions(model: Pick<ModelChoice, "efforts" | "thinkingLevelMap">): ModelThinkingOption[] {
  return modelThinkingSelections(model).map((value) => ({
    value,
    label: thinkingLabel(value)
  }));
}

/** 当前模型的 `off` 也是显式选择，不能回退成该模型的默认 effort。 */
export function selectedThinkingForModel(
  currentModelAlias: string,
  currentThinking: ThinkingSelection,
  model: Pick<ModelChoice, "alias" | "defaultThinking">
): ThinkingSelection {
  return currentModelAlias === model.alias ? currentThinking : model.defaultThinking;
}
