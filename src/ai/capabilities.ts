/**
 * 模型能力与上下文预算推导。
 *
 * 配置里能力字段大多是可选的，这里负责把「配置 + 模型 ID 启发式 + 默认值」收敛成确定的
 * 能力集合、上下文预算和思考档位，让上层不必到处写兜底判断。
 */
import type { ModelAliasConfig, ModelThinkingConfig, ReasoningEffort, ThinkingLevelMap } from "../config/schema.js";
import type { ModelCapabilities, ModelContextBudget, ModelLimits, ProviderModelDefaults } from "./types.js";

export const defaultModelContextWindow = 32_768;
export const defaultModelOutputTokens = 8_192;
const defaultToolSchemaReserveTokens = 1_024;
const defaultSystemPromptReserveTokens = 1_024;
const defaultProtocolSafetyMarginTokens = 512;
const minimumUsableInputTokens = 2_048;

/**
 * 模型级 canonical map。它表达的是 provider 可接受的参数，而不是模型真实“思考程度”。
 * `reasoning` 未显式声明时，再按模型能力推导可用档位。
 */
export function modelThinkingLevelMap(model: ModelAliasConfig): ThinkingLevelMap {
  if (model.thinkingLevelMap) return { ...model.thinkingLevelMap };
  const reasoning = model.reasoning;
  if (!reasoning) return {};
  const map: ThinkingLevelMap = { off: "none" };
  for (const effort of reasoning.efforts) map[effort] = reasoning.mapping?.[effort] ?? effort;
  return map;
}

/** 从 canonical `reasoning` 配置推导 UI 和 provider 使用的档位。 */
export function modelReasoningConfig(model: ModelAliasConfig): ModelThinkingConfig | undefined {
  if (model.capabilities?.reasoning === false || model.compatibility?.supportsReasoning === false) return undefined;
  const map = modelThinkingLevelMap(model);
  const efforts = Object.entries(map)
    .filter(([level, native]) => level !== "off" && native !== null)
    .map(([level]) => level as ReasoningEffort);
  if (!efforts.length) return undefined;

  const reasoning = model.reasoning;
  const defaultEffort = reasoning?.defaultEffort && efforts.includes(reasoning.defaultEffort)
    ? reasoning.defaultEffort
    : efforts.includes("high") ? "high" : efforts[0]!;
  const mapping: Partial<Record<ReasoningEffort, string>> = {};
  for (const effort of efforts) mapping[effort] = map[effort] ?? effort;
  return {
    efforts,
    defaultEffort,
    mapping,
    budgetTokens: reasoning?.budgetTokens
  };
}

/**
 * 把跨模型保存的思考偏好投影成当前模型真正可执行的档位。
 * 不支持关闭的模型遇到旧的 `enabled: false` 配置时使用默认档位，避免状态与请求分裂。
 */
export function effectiveThinkingSelection(
  model: ModelAliasConfig,
  thinking: { enabled: boolean; effort: ReasoningEffort }
): "off" | ReasoningEffort {
  const reasoning = modelReasoningConfig(model);
  if (!reasoning) return "off";
  if (thinking.enabled && reasoning.efforts.includes(thinking.effort)) return thinking.effort;
  const off = modelThinkingLevelMap(model).off;
  return off !== undefined && off !== null ? "off" : reasoning.defaultEffort;
}

/**
 * 已知具备可调推理档位的模型家族。
 *
 * OpenAI 兼容端点（尤其是中转站和自建网关）几乎都不返回 `reasoning_efforts`，
 * 只按响应字段判断的话，grok-4.5、GPT-5、Claude 4 这类模型都会被当成不支持
 * 思考，界面上只剩一个「默认」档。所以在服务商没有声明时按模型 ID 兜底推断。
 *
 * 这是一张需要维护的启发式清单：宁可漏判（退回单一默认档，行为与今天一致），
 * 也不要误判（给不支持的模型发 reasoning 参数，严格的服务端会直接报错）。
 */
const reasoningModelPatterns: RegExp[] = [
  /^o[1341](?![a-z0-9])/iu,                       // OpenAI o1 / o3 / o4
  /\bgpt-5/iu,
  /\bgrok-(?:3-mini|[4-9])/iu,
  /\bclaude-(?:sonnet-|opus-|haiku-)?(?:[4-9]|3[.-]7)/iu,
  /\bdeepseek-(?:r1|reasoner)/iu,
  /\bdeepseek-v(?:[4-9]|3[.-][1-9])/iu,
  /\bqw[qe]n?3/iu,                                // Qwen3 / QwQ
  /\bglm-(?:[5-9]|4[.-][5-9]|z1)/iu,
  /\bkimi-k(?:[2-9]|1[.-]5)/iu,
  /\bminimax-m[1-9]/iu,
  /\bgemini-(?:[3-9]|2[.-]5)/iu,
  /\bhunyuan-t[1-9]|\bhy[1-9]|\btc-code/iu,
  /\bstep-[3-9]/iu,
  /\bmimo-v?[2-9]/iu,
  /\bernie-x[1-9]/iu,
  /\bnemotron/iu,
  /\bgpt-oss/iu,
  /(?:^|[-/])(?:thinking|reasoner|reasoning)(?:$|[-.])/iu
];

function modelIdentifier(modelId: string): string {
  const normalized = modelId.trim();
  return normalized.split("/").pop() ?? normalized;
}

/** Kimi K3 always reasons and exposes only low/high/max via reasoning_effort. */
export function isKimiK3Model(modelId: string): boolean {
  return /^kimi-k3(?:$|[-.])/iu.test(modelIdentifier(modelId));
}

/**
 * 服务商没有声明推理档位时，按模型 ID 推断。返回空数组表示按不支持处理。
 */
export function inferReasoningEfforts(modelId: string): ReasoningEffort[] {
  const identifier = modelIdentifier(modelId);
  if (!identifier) return [];
  if (/^deepseek-v4-(?:flash|pro)$/iu.test(identifier)) return ["high", "max"];
  if (isKimiK3Model(identifier)) return ["low", "high", "max"];
  return reasoningModelPatterns.some((pattern) => pattern.test(identifier)) ? ["high", "max"] : [];
}

/** 把目录/桌面配置里的支持提示转换成模型级 canonical map。 */
export function thinkingLevelMapForModel(
  modelId: string,
  supportsThinking = true,
  declaredEfforts: ReasoningEffort[] = []
): ThinkingLevelMap {
  if (!supportsThinking) {
    return { off: "none" };
  }
  if (isKimiK3Model(modelId)) {
    return { low: "low", high: "high", max: "max" };
  }
  const efforts = declaredEfforts.length ? declaredEfforts : inferReasoningEfforts(modelId);
  const resolved = efforts.length ? efforts : ["high", "max"] as ReasoningEffort[];
  return {
    off: "none",
    ...Object.fromEntries(resolved.map((effort) => [effort, effort]))
  };
}

/**
 * 汇总模型能力。默认按「支持工具、支持流式」处理，因为绝大多数模型都支持，配置里显式
 * 关掉才当作不支持；reasoning 则以是否配了思考参数为准。
 */
export function modelCapabilities(model: ModelAliasConfig): ModelCapabilities {
  const reasoning = modelReasoningConfig(model);
  const reasoningEnabled = model.capabilities?.reasoning ?? reasoning !== undefined;
  return {
    tools: model.capabilities?.tools ?? model.supportsTools ?? true,
    parallelToolCalls: model.capabilities?.parallelToolCalls ?? false,
    reasoning: reasoningEnabled,
    reasoningStream: reasoningEnabled ? model.capabilities?.reasoningStream ?? true : false,
    reasoningSummary: reasoningEnabled ? model.capabilities?.reasoningSummary ?? false : false,
    vision: model.capabilities?.vision ?? false,
    audio: model.capabilities?.audio ?? false,
    streaming: model.capabilities?.streaming ?? true
  };
}

/**
 * 在 ProviderRuntime 边界把用户、内置、插件和动态目录的缺省字段合并成一份模型元数据。
 * 只有 Provider 明确允许按 ID 推断时才启用 reasoning 家族规则；未知模型保持保守关闭。
 */
export function normalizeModelMetadata(
  model: ModelAliasConfig,
  defaults: ProviderModelDefaults = { capabilities: {} }
): ModelAliasConfig {
  const explicitCapabilities = model.capabilities ?? {};
  const reasoningDisabled = explicitCapabilities.reasoning === false || model.compatibility?.supportsReasoning === false;
  const declaredEfforts = modelReasoningConfigWithoutCapabilityGate(model)?.efforts ?? [];
  const inferredEfforts = !reasoningDisabled && defaults.inferReasoningFromId === true
    ? inferReasoningEfforts(model.model)
    : [];
  const defaultEfforts = !reasoningDisabled
    ? defaults.reasoningEfforts ?? []
    : [];
  const fallbackEfforts: ReasoningEffort[] = ["high", "max"];
  const reasoningEfforts: ReasoningEffort[] = declaredEfforts.length
    ? declaredEfforts
    : inferredEfforts.length
      ? inferredEfforts
      : explicitCapabilities.reasoning === true
        ? defaultEfforts.length ? defaultEfforts : fallbackEfforts
        : [];
  const reasoning = reasoningDisabled
    ? undefined
    : model.reasoning ?? createReasoningConfig(reasoningEfforts, defaults.thinkingLevelMap);
  const hasReasoning = !reasoningDisabled && (reasoning !== undefined || explicitCapabilities.reasoning === true);
  const capabilities: ModelCapabilities = {
    tools: explicitCapabilities.tools ?? model.supportsTools ?? defaults.capabilities.tools ?? true,
    parallelToolCalls: explicitCapabilities.parallelToolCalls ?? defaults.capabilities.parallelToolCalls ?? false,
    reasoning: explicitCapabilities.reasoning ?? hasReasoning,
    reasoningStream: (explicitCapabilities.reasoning ?? hasReasoning)
      ? explicitCapabilities.reasoningStream ?? (hasReasoning ? defaults.capabilities.reasoningStream ?? true : true)
      : false,
    reasoningSummary: (explicitCapabilities.reasoning ?? hasReasoning)
      ? explicitCapabilities.reasoningSummary ?? (hasReasoning ? defaults.capabilities.reasoningSummary ?? false : false)
      : false,
    vision: explicitCapabilities.vision ?? defaults.capabilities.vision ?? false,
    audio: explicitCapabilities.audio ?? defaults.capabilities.audio ?? false,
    streaming: explicitCapabilities.streaming ?? defaults.capabilities.streaming ?? true
  };
  const limits = mergeLimits(defaults.limits, model.limits);
  const thinkingLevelMap = reasoningDisabled
    ? { off: "none" }
    : model.thinkingLevelMap
      ?? (reasoning ? reasoningConfigToMap(reasoning, model.model) : defaults.thinkingLevelMap);
  return {
    ...model,
    capabilities,
    contextWindow: model.contextWindow ?? defaults.contextWindow,
    maxInputTokens: model.maxInputTokens ?? defaults.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens ?? defaults.maxOutputTokens,
    limits,
    thinkingLevelMap,
    reasoning
  };
}

/**
 * 上下文预算以模型自身窗口为基准，再扣除输出、reasoning、工具 schema、system prompt
 * 和协议安全边界；`configuredMaxInputTokens` 只是用户额外设置的输入上限。
 */
export function modelContextBudget(
  model: ModelAliasConfig,
  configuredMaxInputTokens: number | undefined,
  modelAlias?: string,
  options: {
    reasoning?: "off" | ReasoningEffort;
    toolSchemaTokens?: number;
    systemPromptTokens?: number;
  } = {}
): ModelContextBudget {
  const capabilities = modelCapabilities(model);
  const maxOutputTokens = model.maxOutputTokens;
  const modelLimits = model.limits;
  const outputReserveTokens = Math.min(
    maxOutputTokens ?? defaultModelOutputTokens,
    Math.max(2_048, Math.floor((model.contextWindow ?? defaultModelContextWindow) * 0.25))
  );
  const reasoningReserveTokens = options.reasoning !== undefined && options.reasoning !== "off" && capabilities.reasoning
    ? Math.max(
      modelLimits?.reasoningReserveTokens ?? 0,
      reasoningBudgetTokens(model, options.reasoning)
    )
    : 0;
  const toolSchemaReserveTokens = options.toolSchemaTokens
    ?? modelLimits?.toolSchemaReserveTokens
    ?? (capabilities.tools ? defaultToolSchemaReserveTokens : 0);
  const systemPromptReserveTokens = options.systemPromptTokens
    ?? modelLimits?.systemPromptReserveTokens
    ?? defaultSystemPromptReserveTokens;
  const protocolSafetyMarginTokens = modelLimits?.protocolSafetyMarginTokens ?? defaultProtocolSafetyMarginTokens;
  const fixedReserveTokens = outputReserveTokens
    + reasoningReserveTokens
    + toolSchemaReserveTokens
    + systemPromptReserveTokens
    + protocolSafetyMarginTokens;
  // 没声明窗口时按「输入上限 + 输出预留」反推，至少给到默认窗口。
  const contextWindow = model.contextWindow
    ?? Math.max(
      defaultModelContextWindow,
      (model.maxInputTokens ?? configuredMaxInputTokens ?? 0) + fixedReserveTokens
    );
  // maxInputTokens 是 provider 的硬上限；configuredMaxInputTokens 是用户额外上限，
  // 两者都要在扣除输出、reasoning、工具 schema、system prompt 和协议安全边界后再取最小值。
  const availableInputTokens = Math.max(minimumUsableInputTokens, contextWindow - fixedReserveTokens);
  const providerInputLimit = model.maxInputTokens ?? modelLimits?.maxInputTokens;
  const cappedInputTokens = Math.min(
    availableInputTokens,
    providerInputLimit ?? Number.MAX_SAFE_INTEGER,
    configuredMaxInputTokens ?? Number.MAX_SAFE_INTEGER
  );
  const inputFloor = Math.min(
    minimumUsableInputTokens,
    contextWindow,
    providerInputLimit ?? Number.MAX_SAFE_INTEGER,
    configuredMaxInputTokens ?? Number.MAX_SAFE_INTEGER
  );
  return {
    modelAlias,
    contextWindow,
    maxInputTokens: Math.min(contextWindow, Math.max(inputFloor, cappedInputTokens)),
    maxOutputTokens,
    outputReserveTokens,
    reasoningReserveTokens,
    toolSchemaReserveTokens,
    systemPromptReserveTokens,
    protocolSafetyMarginTokens
  };
}

/** 把内部档位名映射成服务商认识的取值；没配映射就原样下发。 */
export function nativeReasoningEffort(
  model: ModelAliasConfig,
  effort: ReasoningEffort
): string {
  const native = modelThinkingLevelMap(model)[effort];
  return native ?? modelReasoningConfig(model)?.mapping?.[effort] ?? effort;
}

/** 按思考预算 token 计费的协议（如 Anthropic）需要具体数值，这里给出各档默认值。 */
export function reasoningBudgetTokens(
  model: ModelAliasConfig,
  effort: ReasoningEffort
): number {
  return modelReasoningConfig(model)?.budgetTokens?.[effort]
    ?? (effort === "max" || effort === "xhigh" ? 8_192 : effort === "high" ? 4_096 : 2_048);
}

function modelReasoningConfigWithoutCapabilityGate(model: ModelAliasConfig): ModelThinkingConfig | undefined {
  const map = model.thinkingLevelMap ?? (model.reasoning ? modelThinkingLevelMap(model) : {});
  const efforts = Object.entries(map)
    .filter(([level, native]) => level !== "off" && native !== null)
    .map(([level]) => level)
    .filter(isReasoningEffort);
  if (!efforts.length && !model.reasoning) return undefined;
  const defaultEffort = model.reasoning?.defaultEffort && efforts.includes(model.reasoning.defaultEffort)
    ? model.reasoning.defaultEffort
    : efforts.includes("high") ? "high" : efforts[0];
  if (!defaultEffort) return undefined;
  const mapping: Partial<Record<ReasoningEffort, string>> = {};
  for (const effort of efforts) mapping[effort] = map[effort] ?? effort;
  return {
    efforts,
    defaultEffort,
    mapping,
    budgetTokens: model.reasoning?.budgetTokens
  };
}

function createReasoningConfig(
  efforts: ReasoningEffort[],
  defaultMap: ThinkingLevelMap | undefined
): ModelThinkingConfig | undefined {
  if (!efforts.length) return undefined;
  const mapping: Partial<Record<ReasoningEffort, string>> = {};
  for (const effort of efforts) mapping[effort] = defaultMap?.[effort] ?? effort;
  const defaultEffort = efforts.includes("high") ? "high" : efforts[0]!;
  return { efforts, defaultEffort, mapping, budgetTokens: undefined };
}

function reasoningConfigToMap(reasoning: ModelThinkingConfig, modelId: string): ThinkingLevelMap {
  const map: ThinkingLevelMap = isKimiK3Model(modelId) ? {} : { off: "none" };
  for (const effort of reasoning.efforts) map[effort] = reasoning.mapping?.[effort] ?? effort;
  return map;
}

function mergeLimits(base: ModelLimits | undefined, override: ModelLimits | undefined): ModelLimits | undefined {
  if (!base && !override) return undefined;
  return {
    maxInputTokens: override?.maxInputTokens ?? base?.maxInputTokens,
    reasoningReserveTokens: override?.reasoningReserveTokens ?? base?.reasoningReserveTokens,
    toolSchemaReserveTokens: override?.toolSchemaReserveTokens ?? base?.toolSchemaReserveTokens,
    systemPromptReserveTokens: override?.systemPromptReserveTokens ?? base?.systemPromptReserveTokens,
    protocolSafetyMarginTokens: override?.protocolSafetyMarginTokens ?? base?.protocolSafetyMarginTokens
  };
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}
