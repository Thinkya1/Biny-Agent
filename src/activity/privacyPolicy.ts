import type { ActivityModelIdentity } from "./types.js";
import {
  activitySettingsSchema,
  defaultActivitySettings,
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

/**
 * Activity 外发的唯一判断入口。
 *
 * v1 只信任明确标记为 builtin-llama.cpp 的运行时。provider 名称、模型 ID、URL 和
 * dataResidency 声明都不能单独把一个模型提升为受信任本地模型；后续加入 Ollama 等运行时
 * 时，应在这里增加明确的白名单规则和对应审计，而不是让调用方各自判断。
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
}

export function isTrustedLocalActivityModel(model: ActivityModelIdentity): boolean {
  // 不能用 provider、modelId、URL 或 dataResidency 推断本地性；只有内置 runtime 标记有效。
  return model.runtime === "builtin-llama.cpp" && model.dataResidency !== "external";
}
