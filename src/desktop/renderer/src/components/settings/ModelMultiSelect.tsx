/**
 * 连接详情「模型」区的启用选择器：
 * astryx MultiSelector，trigger 显示已选模型名（labels 而非"N 个已选"），
 * 点开后是 搜索（搜索模型）+ 全部启用 + 勾选列表。
 *
 * biny 的启停是逐模型立即落盘（enableModel/disableModel 各自一次写），而
 * MultiSelector 的 onChange 给整组 id —— 这里做集合 diff：新增的串行启用、
 * 移除的串行停用。串行而不是并发：每次启用都会 applySettings 刷新草稿，
 * 并发写会互相覆盖（设置页保存链路已踩过一次）。
 */
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import type { ModelChoice } from "../../../../../llm/ModelManager.js";
import { modelAliasFor, type CatalogModel } from "../../providerCatalog.js";

export function ModelMultiSelect(props: {
  busy: boolean;
  /** 连接标识：已启用但不在目录里的模型（手动添加）回推导 alias 用。 */
  provider: string;
  /** 已启用的模型（连接内）。 */
  enabled: ModelChoice[];
  /** 候选目录（内置静态或实时拉取）。 */
  models: CatalogModel[];
  onEnableModel(model: CatalogModel): Promise<void> | void;
  onDisableModel(alias: string): Promise<void> | void;
}): React.JSX.Element {
  const byId = new Map(props.models.map((model) => [model.id, model]));
  // 目录优先；已启用但目录里没有的（手动添加、目录滞后）补在最后，
  // 保证 MultiSelector 的每个 value 都能解析到 label。
  const options: { value: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const model of props.models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    options.push({ value: model.id, label: model.displayName.trim() || model.id });
  }
  for (const choice of props.enabled) {
    if (seen.has(choice.model)) continue;
    seen.add(choice.model);
    options.push({ value: choice.model, label: choice.displayName.trim() || choice.model });
  }
  const value = props.enabled.map((choice) => choice.model);

  const handleChange = (next: string[]): void => {
    const prev = new Set(value);
    const nextSet = new Set(next);
    void (async () => {
      for (const id of next) {
        if (prev.has(id)) continue;
        const model = byId.get(id);
        // 新增项一定来自目录（目录外的项都已启用，不会再被"新增"）。
        if (model) await props.onEnableModel(model);
      }
      for (const id of prev) {
        if (nextSet.has(id)) continue;
        const alias = props.enabled.find((choice) => choice.model === id)?.alias ?? modelAliasFor(props.provider, id);
        await props.onDisableModel(alias);
      }
    })();
  };

  return (
    <MultiSelector
      // 区块标题「模型」+ 说明已经讲了这列是什么；可见 label 再写一遍就是第三种字重的重复。
      // 保留为无障碍名，trigger 仍能报出它选的是什么。
      label="启用的模型"
      isLabelHidden
      options={options}
      value={value}
      onChange={handleChange}
      isDisabled={props.busy || options.length === 0}
      disabledMessage={options.length === 0 ? "暂无可选模型，请先更新模型目录。" : undefined}
      placeholder="暂无可选模型，请先更新模型目录。"
      triggerDisplay="labels"
      hasSearch
      searchPlaceholder="搜索模型"
      hasSelectAll
      selectAllLabel="全部启用"
      width="100%"
    />
  );
}
