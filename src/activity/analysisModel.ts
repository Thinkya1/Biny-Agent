/**
 * Activity 分析所用模型的解析。
 *
 * 隐私前提不变：这里只决定「用哪个模型」，是否放行仍由 ActivityPrivacyPolicy 的
 * analysisPolicy 维度统一判定。截图、OCR 原文任何策略下都不出设备。
 *
 * 选择规则（参考仓库现有模型标识方式）：
 * - 未配置 activity.analysisModel 时回退当前聊天模型 config.defaultModel；
 * - 配置后按 config.models 的别名解析，也接受 provider/model-id（容忍 provider:model-id）
 *   指向某个已配置模型，便于给分析单配一个便宜模型；
 * - 指向未知别名或构造失败（缺凭据/端点）时返回 undefined，由调用方按「无可用分析模型」
 *   处理——对应 session 保持待分析，等周期 sweep 在配置修正后补跑，而不是悄悄退回烧
 *   默认聊天模型。
 */
import type { AgentModel } from "../agent/core/types.js";
import type { AgentConfig } from "../config/schema.js";
import { createNativeModelForConfig } from "../llm/nativeFactory.js";

/**
 * 解析出分析用模型。构造失败（未知别名、缺 API key/endpoint）返回 undefined，
 * 让需要模型的 session 保持「待分析」，不抛给调用方。
 */
export function resolveActivityAnalysisModel(config: AgentConfig): AgentModel | undefined {
  const reference = config.activity.analysisModel?.trim();
  const alias = reference ? resolveConfiguredModelAlias(config, reference) : config.defaultModel;
  if (!alias) return undefined;
  try {
    return createNativeModelForConfig(config, alias);
  } catch {
    return undefined;
  }
}

/**
 * 把 analysisModel 引用解析成 config.models 的别名：先按别名（含大小写不敏感）精确匹配，
 * 再按 provider/model-id（也容忍 provider:model-id）匹配某个已配置模型。找不到返回 undefined。
 * 只解析到 config.models 里的已配置模型——分析模型必须有 provider 与凭据才能真正跑起来。
 */
export function resolveConfiguredModelAlias(config: AgentConfig, reference: string): string | undefined {
  const trimmed = reference.trim();
  if (!trimmed) return undefined;
  if (config.models[trimmed]) return trimmed;
  const lower = trimmed.toLowerCase();
  if (config.models[lower]) return lower;
  const separator = trimmed.search(/[:/]/u);
  if (separator > 0) {
    const provider = trimmed.slice(0, separator);
    const modelId = trimmed.slice(separator + 1);
    const match = Object.entries(config.models).find(([, model]) => (
      model.provider === provider && model.model === modelId
    ));
    if (match) return match[0];
  }
  return undefined;
}
