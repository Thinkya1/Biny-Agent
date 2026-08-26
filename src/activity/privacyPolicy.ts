import type { ActivityModelIdentity } from "./types.js";
import {
  activitySettingsSchema,
  defaultActivitySettings,
  type ActivityAnalysisPolicy,
  type ActivityExternalPolicy,
  type ActivitySettings
} from "./settings.js";

const effectiveActivityPolicy = "local_only" as const;

export type ActivityPrivacyDecisionStatus = "allowed" | "blocked";

export type ActivityPrivacyDecisionReason =
  | "trusted_local_model"
  | "external_model_blocked"
  | "unsupported_policy";

export interface ActivityPrivacyDecision {
  allowed: boolean;
  status: ActivityPrivacyDecisionStatus;
  reason: ActivityPrivacyDecisionReason;
  /** 配置中的值必须保留，便于设置页显示“当前版本暂不支持”。 */
  policy: ActivityExternalPolicy;
  /** v1 执行时始终按 local_only 处理。 */
  effectivePolicy: typeof effectiveActivityPolicy;
  unsupportedPolicy: boolean;
  trustedLocalModel: boolean;
  message: string;
}

export interface ActivityPrivacyRunResult<T> {
  status: ActivityPrivacyDecisionStatus;
  value: T | undefined;
  decision: ActivityPrivacyDecision;
  /** 策略层不接受备用模型参数，也不会自动 fallback。 */
  fallbackAttempted: false;
}

export type ActivityAnalysisDecisionReason =
  /** 受信任的本地模型：任何分析策略下都放行。 */
  | "trusted_local_model"
  /** analysisPolicy=external_allowed：明确允许外发。 */
  | "external_allowed"
  /** analysisPolicy=confirm_external 且用户已在设置页确认。 */
  | "external_confirmed"
  /** analysisPolicy=confirm_external 但用户尚未确认。 */
  | "external_needs_confirmation"
  /** analysisPolicy=local_only 而当前模型是外部模型。 */
  | "external_blocked";

export interface ActivityAnalysisDecision {
  allowed: boolean;
  status: ActivityPrivacyDecisionStatus;
  reason: ActivityAnalysisDecisionReason;
  policy: ActivityAnalysisPolicy;
  trustedLocalModel: boolean;
  message: string;
}

export interface ActivityAnalysisRunResult<T> {
  status: ActivityPrivacyDecisionStatus;
  value: T | undefined;
  decision: ActivityAnalysisDecision;
}

/**
 * Activity 外发的唯一判断入口。
 *
 * 这里是双维度策略：回忆（把 Activity 注入聊天上下文）走 `externalPolicy`，分析（把脱敏
 * 摘要聚合送分析模型）走 `analysisPolicy`。两个维度都遵守同一条底线：只有明确标记为
 * builtin-llama.cpp 的运行时算受信任本地模型；provider 名称、模型 ID、URL 和
 * dataResidency 声明都不能单独把一个模型提升为受信任本地模型。截图、OCR 原文在任何
 * 策略下都不出设备。
 */
export class ActivityPrivacyPolicy {
  private readonly settings: ActivitySettings;

  constructor(settings: ActivitySettings | Pick<ActivitySettings, "externalPolicy"> | ActivityExternalPolicy = defaultActivitySettings) {
    this.settings = activitySettingsSchema.parse(
      typeof settings === "string" ? { externalPolicy: settings } : settings
    );
  }

  get externalPolicy(): ActivityExternalPolicy {
    return this.settings.externalPolicy;
  }

  get analysisPolicy(): ActivityAnalysisPolicy {
    return this.settings.analysisPolicy;
  }

  canUseWithModel(model: ActivityModelIdentity): boolean {
    return this.evaluate(model).allowed;
  }

  evaluate(model: ActivityModelIdentity): ActivityPrivacyDecision {
    const unsupportedPolicy = this.settings.externalPolicy !== effectiveActivityPolicy;
    const trustedLocalModel = isTrustedLocalActivityModel(model);
    if (trustedLocalModel) {
      return {
        allowed: true,
        status: "allowed",
        reason: unsupportedPolicy ? "unsupported_policy" : "trusted_local_model",
        policy: this.settings.externalPolicy,
        effectivePolicy: effectiveActivityPolicy,
        unsupportedPolicy,
        trustedLocalModel: true,
        message: unsupportedPolicy
          ? `当前版本暂不支持 Activity 外发策略“${this.settings.externalPolicy}”，已按 local_only 执行。`
          : "Activity 仅在受信任的本地 llama.cpp 模型中可用。"
      };
    }

    return {
      allowed: false,
      status: "blocked",
      reason: "external_model_blocked",
      policy: this.settings.externalPolicy,
      effectivePolicy: effectiveActivityPolicy,
      unsupportedPolicy,
      trustedLocalModel: false,
      message: unsupportedPolicy
        ? `当前版本暂不支持 Activity 外发策略“${this.settings.externalPolicy}”；已阻止向当前模型外发 Activity。`
        : "当前模型不是受信任的本地 llama.cpp 模型，已阻止注入 Activity。"
    };
  }

  /**
   * 分析维度的判定：决定能不能把脱敏后的事件摘要聚合送到当前聊天模型做 session 分析。
   *
   * 与 evaluate（回忆维度）相互独立；未放行时调用方必须完全不运行分析，而不是降级成
   * 别的模型。原始截图/OCR 不在这条链路上，无论判定结果如何都不出设备。
   */
  evaluateAnalysis(model: ActivityModelIdentity): ActivityAnalysisDecision {
    const policy = this.settings.analysisPolicy;
    if (isTrustedLocalActivityModel(model)) {
      return {
        allowed: true,
        status: "allowed",
        reason: "trusted_local_model",
        policy,
        trustedLocalModel: true,
        message: "Activity 分析使用受信任的本地模型。"
      };
    }
    if (policy === "external_allowed") {
      return {
        allowed: true,
        status: "allowed",
        reason: "external_allowed",
        policy,
        trustedLocalModel: false,
        message: "analysisPolicy=external_allowed，允许把脱敏摘要送到外部模型分析。"
      };
    }
    if (policy === "confirm_external") {
      const confirmed = this.settings.analysisExternalConfirmed;
      return {
        allowed: confirmed,
        status: confirmed ? "allowed" : "blocked",
        reason: confirmed ? "external_confirmed" : "external_needs_confirmation",
        policy,
        trustedLocalModel: false,
        message: confirmed
          ? "用户已在设置页确认放行外部模型分析。"
          : "外部模型分析需要用户在设置页确认后才运行；当前已跳过。"
      };
    }
    return {
      allowed: false,
      status: "blocked",
      reason: "external_blocked",
      policy,
      trustedLocalModel: false,
      message: "analysisPolicy=local_only，当前模型不是受信任的本地模型，已跳过分析。"
    };
  }

  canAnalyzeWithModel(model: ActivityModelIdentity): boolean {
    return this.evaluateAnalysis(model).allowed;
  }

  /**
   * 执行查询、摘要或上下文注入前的统一门禁。
   *
   * operation 只在获准时执行；调用方没有传入备用模型的入口，因此策略拒绝时不会悄悄
   * 把 Activity 转交给云模型。
   */
  async run<T>(
    model: ActivityModelIdentity,
    operation: () => T | Promise<T>
  ): Promise<ActivityPrivacyRunResult<T>> {
    const decision = this.evaluate(model);
    if (!decision.allowed) {
      return {
        status: "blocked",
        value: undefined,
        decision,
        fallbackAttempted: false
      };
    }
    return {
      status: "allowed",
      value: await operation(),
      decision,
      fallbackAttempted: false
    };
  }

  /** 分析维度的统一门禁：未放行时 operation 完全不执行。 */
  async runAnalysis<T>(
    model: ActivityModelIdentity,
    operation: () => T | Promise<T>
  ): Promise<ActivityAnalysisRunResult<T>> {
    const decision = this.evaluateAnalysis(model);
    if (!decision.allowed) {
      return { status: "blocked", value: undefined, decision };
    }
    return { status: "allowed", value: await operation(), decision };
  }
}

export function isTrustedLocalActivityModel(model: ActivityModelIdentity): boolean {
  // 不能用 provider、modelId、URL 或 dataResidency 推断本地性；只有内置 runtime 标记有效。
  return model.runtime === "builtin-llama.cpp" && model.dataResidency !== "external";
}
