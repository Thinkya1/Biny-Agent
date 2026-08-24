/**
 * Runtime configuration schema.
 *
 * Providers own credentials and endpoints, while model aliases own model IDs and
 * capabilities. Only the canonical multi-model format is accepted.
 */
import { z } from "zod";
import { DEFAULT_PROJECT_SKILL_PATHS } from "../extensions/skillRoots.js";
import {
  memoryPolicySchema,
  personalizationSettingsSchema,
  type MemoryPolicy,
  type PersonalizationSettings
} from "../personalization/index.js";
import { GLOBAL_CONFIG_FORMAT, GLOBAL_CONFIG_VERSION } from "./migrations.js";

const agentSchema = z.object({
  softStepLimit: z.number().int().min(1).max(1_024).default(32),
  hardStepLimit: z.number().int().min(1).max(1_024).default(96),
  maxToolCalls: z.number().int().min(1).max(65_536).optional(),
  maxRepeatedActions: z.number().int().min(1).max(32).default(3),
  maxConcurrentTools: z.number().int().min(1).max(32).default(4),
  maxQueuedToolCalls: z.number().int().min(1).max(1_024).default(64)
}).strict().default({
  softStepLimit: 32,
  hardStepLimit: 96,
  maxToolCalls: undefined,
  maxRepeatedActions: 3,
  maxConcurrentTools: 4,
  maxQueuedToolCalls: 64
});

const permissionSchema = z.object({
  mode: z.enum(["ask", "read-only", "auto", "full-access"]).default("ask"),
  allowTools: z.array(z.string()).default(["read_file", "list_files", "search_files", "grep_search", "git_status", "git_diff", "web_search", "save_memory"]),
  allowPaths: z.array(z.string()).default([]),
  denyPaths: z.array(z.string()).default([".env", ".env.local", ".ssh/", "node_modules/"]),
  criticalAlwaysAsk: z.boolean().default(true)
}).default({
  mode: "ask",
  allowTools: ["read_file", "list_files", "search_files", "grep_search", "git_status", "git_diff", "web_search", "save_memory"],
  allowPaths: [],
  denyPaths: [".env", ".env.local", ".ssh/", "node_modules/"],
  criticalAlwaysAsk: true
});

const contextSchema = z.object({
  // 不配置时按当前模型的上下文窗口自动推导；配置了就作为额外上限。
  maxInputTokens: z.number().int().min(2_048).max(2_000_000).optional(),
  // A turn retains this much cumulative tool output in model context. Later
  // results are archived under .biny/tool-results with a bounded preview.
  maxTurnToolResultBytes: z.number().int().min(1_024).max(16 * 1024 * 1024).default(128 * 1024),
  instructionsMaxBytes: z.number().int().min(1_024).max(131_072).default(32 * 1024),
  compaction: z.object({
    enabled: z.boolean().default(true),
    // reserve/keep 缺省时按当前模型可用输入预算动态缩放；显式配置时作为额外上限。
    reserveTokens: z.number().int().min(256).max(262_144).optional(),
    keepRecentTokens: z.number().int().min(256).max(1_000_000).optional(),
    maxSummaryTokens: z.number().int().min(256).max(32_768).default(4_096)
  }).default({ enabled: true, reserveTokens: undefined, keepRecentTokens: undefined, maxSummaryTokens: 4_096 }),
  memory: memoryPolicySchema
}).default({
  maxTurnToolResultBytes: 128 * 1024,
  instructionsMaxBytes: 32 * 1024,
  compaction: { enabled: true, reserveTokens: undefined, keepRecentTokens: undefined, maxSummaryTokens: 4_096 },
  memory: {
    enabled: false,
    useMemories: true,
    generateMemories: true,
    queryRewrite: true,
    memoryModel: undefined,
    rewriteModel: undefined,
    extractModel: undefined,
    consolidationModel: undefined,
    embeddingModel: undefined,
    similarityThresholds: {},
    cloudEmbeddingConsents: {},
    excludeExternalContext: true,
    maxRecalled: 5
  }
});

const extensionIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

/** Provider 与 API ID 是扩展点，内置值只提供默认实现，不限制插件注册的新类型。 */
export const modelProviderSchema = extensionIdSchema;

export const providerProtocolSchema = z.enum(["anthropic", "openai-compatible"]);
export const reasoningEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
export const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const modelApiBackendSchema = extensionIdSchema;

export const modelCompatibilitySchema = z.object({
  supportsDeveloperRole: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional()
});

const thinkingLevelMapSchema = z.record(z.string(), z.string().min(1).nullable()).superRefine((map, context) => {
  for (const key of Object.keys(map)) {
    if (!thinkingLevelSchema.options.includes(key as z.infer<typeof thinkingLevelSchema>)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `Unknown thinking level: ${key}.`
      });
    }
  }
});

const thinkingSchema = z.object({
  enabled: z.boolean().default(true),
  effort: reasoningEffortSchema.default("high")
}).default({ enabled: true, effort: "high" });

const providerEmbeddingThresholdsSchema = z.object({
  currentWorkspace: z.number().min(0).max(1),
  crossWorkspace: z.number().min(0).max(1)
}).strict().superRefine((value, context) => {
  if (value.crossWorkspace >= value.currentWorkspace) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["crossWorkspace"],
    message: "Cross-workspace embedding threshold must be at least the current-workspace threshold."
  });
});

export const providerEmbeddingModelSchema = z.object({
  id: z.string().trim().min(1).max(256),
  displayName: z.string().trim().min(1).max(256),
  dimensions: z.number().int().min(1).max(65_536).optional(),
  recommendedThresholds: providerEmbeddingThresholdsSchema.optional()
}).strict();

const providerConfigSchema = z.object({
  type: modelProviderSchema,
  protocol: providerProtocolSchema.optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).optional(),
  requiresApiKey: z.boolean().optional(),
  authMode: z.enum(["api-key", "oauth-bearer"]).optional(),
  oauth: z.object({
    provider: extensionIdSchema,
    refreshToken: z.string().min(1).optional(),
    expiresAt: z.number().int().positive(),
    accountId: z.string().min(1).optional()
  }).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  retry: z.object({
    maxAttempts: z.number().int().min(1).max(6).default(3),
    initialDelayMs: z.number().int().min(0).max(30_000).default(250),
    maxDelayMs: z.number().int().min(0).max(120_000).default(4_000)
  }).optional(),
  modelsEndpoint: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  apiBackend: modelApiBackendSchema.optional(),
  compatibility: modelCompatibilitySchema.optional(),
  /** 仅显式声明的 provider embedding 型号会进入目录；不会从聊天模型或 ID 猜测。 */
  embeddingModels: z.array(providerEmbeddingModelSchema).max(64).optional()
}).superRefine((provider, context) => {
  const embeddingIds = new Set<string>();
  for (const [index, model] of (provider.embeddingModels ?? []).entries()) {
    if (embeddingIds.has(model.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["embeddingModels", index, "id"],
        message: `Duplicate embedding model id: ${model.id}`
      });
    }
    embeddingIds.add(model.id);
  }
  if (provider.type === "openai-compatible" && !provider.baseUrl) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baseUrl"],
      message: "openai-compatible requires a provider baseUrl."
    });
  }
  if (provider.authMode === "oauth-bearer" && !provider.oauth) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["oauth"],
      message: "oauth-bearer requires OAuth refresh metadata."
    });
  }
  if (provider.oauth?.provider === "claude-code" && provider.type !== "claude-subscription") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["type"],
      message: "Claude OAuth credentials require the claude-subscription provider."
    });
  }
  if (provider.oauth?.provider === "openai-codex" && provider.type !== "openai-codex") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["type"],
      message: "Codex OAuth credentials require the openai-codex provider."
    });
  }
});

const modelPricingSchema = z.object({
  inputPerMillionTokens: z.number().nonnegative().optional(),
  outputPerMillionTokens: z.number().nonnegative().optional(),
  cacheReadPerMillionTokens: z.number().nonnegative().optional(),
  cacheWritePerMillionTokens: z.number().nonnegative().optional()
});

const mcpServerSchema = z.object({
  /** 用于凭据 account 稳定关联；旧配置没有该字段时在下一次桌面保存时补齐。 */
  id: z.string().uuid().optional(),
  description: z.string().trim().max(2_000).optional(),
  type: z.enum(["stdio", "http"]).optional(),
  /** Remote 新配置可显式选择协议；缺省时保留 streamable HTTP -> SSE 回退。 */
  transportProtocol: z.enum(["streamable-http", "sse"]).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  /** env/header 的值保存在 Keychain；这里仅保存 account 引用。 */
  credentialRefs: z.object({
    env: z.record(z.string().min(1).max(512)).optional(),
    headers: z.record(z.string().min(1).max(512)).optional()
  }).optional(),
  cwd: z.string().min(1).optional(),
  stderr: z.enum(["ignore", "inherit", "pipe"]).default("ignore"),
  url: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  enabled: z.boolean().default(true)
}).superRefine((server, context) => {
  // type 省略时按字段推断：有 url 走 http，否则走 stdio。
  const transport = server.type ?? (server.url ? "http" : "stdio");
  if (transport === "stdio" && !server.command) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["command"], message: "stdio MCP server requires a command" });
  }
  if (transport === "http" && !server.url) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "http MCP server requires a url" });
  }
});

export const defaultSubagentAllowedTools = [
  "read_file",
  "list_files",
  "search_files",
  "grep_search",
  "git_status",
  "git_diff",
  "write_file",
  "edit_file",
  "multi_edit",
  "delete_file",
  "apply_patch",
  "move_file",
  "run_command"
] as const;

const subagentToolNameSchema = z.enum(defaultSubagentAllowedTools);

const extensionsSchema = z.object({
  mcp: z.record(mcpServerSchema).default({}),
  skills: z.array(z.string().trim().min(1)).max(32).default([...DEFAULT_PROJECT_SKILL_PATHS]),
  plugins: z.array(z.string().trim().min(1)).max(32).default([]),
  subagent: z.object({
    enabled: z.boolean().default(false),
    maxSteps: z.number().int().min(1).max(32).default(16),
    maxOutputTokens: z.number().int().min(256).max(32_768).default(8_000),
    maxConcurrentSubagents: z.number().int().min(1).max(8).default(2),
    maxPendingSubagents: z.number().int().min(0).max(128).default(16),
    timeoutMs: z.number().int().min(1_000).max(600_000).default(300_000),
    model: z.string().min(1).optional(),
    maxCostUsd: z.number().positive().max(100).optional(),
    allowedTools: z.array(subagentToolNameSchema).min(1).default([...defaultSubagentAllowedTools]),
    // 具名子代理定义目录（workspace 相对路径）；全局 ~/.biny/agents 始终生效。
    agentPaths: z.array(z.string().trim().min(1)).max(32).default([".biny/agents"])
  }).default({
    enabled: false,
    maxSteps: 16,
    maxOutputTokens: 8_000,
    maxConcurrentSubagents: 2,
    maxPendingSubagents: 16,
    timeoutMs: 300_000,
    model: undefined,
    maxCostUsd: undefined,
    allowedTools: [...defaultSubagentAllowedTools],
    agentPaths: [".biny/agents"]
  })
}).default({
  mcp: {},
  skills: [".agents/skills", ".biny/skills"],
  plugins: [],
  subagent: {
    enabled: false,
    maxSteps: 16,
    maxOutputTokens: 8_000,
    maxConcurrentSubagents: 2,
    maxPendingSubagents: 16,
    timeoutMs: 300_000,
    model: undefined,
    maxCostUsd: undefined,
    allowedTools: [...defaultSubagentAllowedTools],
    agentPaths: [".biny/agents"]
  }
});

const webSearchSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(["duckduckgo", "google", "tavily", "brave", "anysearch"]).default("anysearch"),
  apiKey: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1_000).max(60_000).default(10_000),
  maxResults: z.number().int().min(1).max(10).default(5)
}).default({
  enabled: false,
  provider: "anysearch",
  apiKey: undefined,
  apiKeyEnv: undefined,
  timeoutMs: 10_000,
  maxResults: 5
});

/**
 * 共享 cookie jar：桌面端内嵌浏览器登录后写入，`web_search` 的 Google provider 和
 * `web_fetch` 读取，用来访问需要登录态的页面。
 *
 * 打开它意味着模型选定的 URL 会带上真实登录凭据（只发给域名匹配的站点）。`web_fetch`
 * 默认不在免确认工具白名单里，每次抓取仍要用户确认，这是这项能力的主要约束。
 */
const webCookiesSchema = z.object({
  enabled: z.boolean().default(false),
  /** jar 文件位置；留空用桌面端 userData 下的共享路径，桌面端与 CLI 因此读到同一份。 */
  path: z.string().min(1).optional()
}).default({ enabled: false, path: undefined });

const webFetchSchema = z.object({
  enabled: z.boolean().default(false),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
  maxBytes: z.number().int().min(1_024).max(32 * 1024 * 1024).default(2 * 1024 * 1024),
  maxRedirects: z.number().int().min(0).max(10).default(5),
  // 只在用户明确要抓本机开发服务时开启：关掉的是私网/环回/云元数据地址的防线。
  allowPrivateNetwork: z.boolean().default(false)
}).default({
  enabled: false,
  timeoutMs: 15_000,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 5,
  allowPrivateNetwork: false
});

const hookSchema = z.object({
  command: z.string().min(1),
  /** 只对这些工具触发；留空表示全部。 */
  tools: z.array(z.string().min(1)).max(32).default([]),
  /** 只对这些扩展名的目标路径触发；留空表示不按扩展名过滤。 */
  extensions: z.array(z.string().min(1).startsWith(".")).max(32).default([]),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(60_000)
});

const hooksSchema = z.object({
  /** 工具执行前触发；非零退出会阻止这次调用。 */
  beforeTool: z.array(hookSchema).max(16).default([]),
  /** 工具执行后触发；输出附在结果上，退出码不影响调用结果。 */
  afterTool: z.array(hookSchema).max(16).default([])
}).default({ beforeTool: [], afterTool: [] });

const sandboxSchema = z.object({
  /**
   * `workspace-write`：命令仍以当前用户权限运行，但内核层面只允许写工作区、临时目录和常见
   * 缓存目录。这是独立于命令字符串判定的第二道边界。目前只有 macOS 有实现。
   */
  mode: z.enum(["off", "workspace-write"]).default("off"),
  allowNetwork: z.boolean().default(true)
}).default({ mode: "off", allowNetwork: true });

const checkpointsSchema = z.object({
  /** 每个回合首次改动工作区前自动建一个快照，供 /undo 回退。仅在 git 仓库内生效。 */
  enabled: z.boolean().default(true)
}).default({ enabled: true });

const diagnosticsSchema = z.object({
  enabled: z.boolean().default(false),
  /** 自动识别项目本地已安装的检查工具（目前是 TypeScript）；只用本地二进制，不联网安装。 */
  autoDetect: z.boolean().default(false),
  autoDetectTimeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
  maxOutputBytes: z.number().int().min(256).max(1024 * 1024).default(8 * 1024),
  commands: z.array(z.object({
    extensions: z.array(z.string().min(1).startsWith(".")).min(1).max(16),
    command: z.string().min(1),
    timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000)
  })).max(8).default([])
}).default({
  enabled: false,
  autoDetect: false,
  autoDetectTimeoutMs: 120_000,
  maxOutputBytes: 8 * 1024,
  commands: []
});

const webSchema = z.object({
  search: webSearchSchema,
  fetch: webFetchSchema,
  cookies: webCookiesSchema
}).default({
  search: {
    enabled: false,
    provider: "anysearch",
    apiKey: undefined,
    apiKeyEnv: undefined,
    timeoutMs: 10_000,
    maxResults: 5
  },
  fetch: {
    enabled: false,
    timeoutMs: 15_000,
    maxBytes: 2 * 1024 * 1024,
    maxRedirects: 5,
    allowPrivateNetwork: false
  },
  cookies: { enabled: false, path: undefined }
});

const modelThinkingSchema = z.object({
  efforts: z.array(reasoningEffortSchema).min(1).default(["high", "max"]),
  defaultEffort: reasoningEffortSchema.default("high"),
  mapping: z.record(reasoningEffortSchema, z.string().min(1)).optional(),
  budgetTokens: z.record(reasoningEffortSchema, z.number().int().min(256).max(131_072)).optional()
}).superRefine((thinking, context) => {
  if (!thinking.efforts.includes(thinking.defaultEffort)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaultEffort"],
      message: "defaultEffort must be included in efforts."
    });
  }
});

export const modelLimitsSchema = z.object({
  maxInputTokens: z.number().int().min(2_048).max(2_000_000).optional(),
  reasoningReserveTokens: z.number().int().min(0).max(131_072).optional(),
  toolSchemaReserveTokens: z.number().int().min(0).max(131_072).optional(),
  systemPromptReserveTokens: z.number().int().min(0).max(131_072).optional(),
  protocolSafetyMarginTokens: z.number().int().min(0).max(131_072).optional()
}).strict();

const modelAliasSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  displayName: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  supportsTools: z.boolean().optional(),
  capabilities: z.object({
    tools: z.boolean().optional(),
    parallelToolCalls: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    reasoningStream: z.boolean().optional(),
    reasoningSummary: z.boolean().optional(),
    vision: z.boolean().optional(),
    audio: z.boolean().optional(),
    streaming: z.boolean().optional()
  }).optional(),
  contextWindow: z.number().int().min(4_096).max(2_000_000).optional(),
  maxInputTokens: z.number().int().min(2_048).max(2_000_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(384_000).optional(),
  limits: modelLimitsSchema.optional(),
  /** Model-level API and compatibility override the provider defaults. */
  apiBackend: modelApiBackendSchema.optional(),
  baseUrl: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  compatibility: modelCompatibilitySchema.optional(),
  /** Canonical capability map. Missing/null levels are unsupported. */
  thinkingLevelMap: thinkingLevelMapSchema.optional(),
  reasoning: modelThinkingSchema.optional(),
  pricing: modelPricingSchema.optional()
});

const canonicalConfigSchema = z.object({
  format: z.literal(GLOBAL_CONFIG_FORMAT),
  configVersion: z.literal(GLOBAL_CONFIG_VERSION),
  defaultModel: z.string().min(1),
  providers: z.record(providerConfigSchema),
  /** 凭据正文保存在 Keychain；这里仅保存并发 CAS 使用的非机密版本 nonce。 */
  credentialRevisions: z.record(z.string().min(1).max(128)).optional(),
  models: z.record(modelAliasSchema),
  thinking: thinkingSchema,
  agent: agentSchema,
  permission: permissionSchema,
  workspace: z.object({
    ignore: z.array(z.string())
  }),
  personalization: personalizationSettingsSchema,
  context: contextSchema,
  diagnostics: diagnosticsSchema,
  checkpoints: checkpointsSchema,
  sandbox: sandboxSchema,
  hooks: hooksSchema,
  web: webSchema,
  telemetry: z.object({
    enabled: z.boolean().default(false),
    recordInputs: z.boolean().default(false),
    recordOutputs: z.boolean().default(false)
  }).default({ enabled: false, recordInputs: false, recordOutputs: false }),
  extensions: extensionsSchema
}).strict().superRefine((config, context) => {
  const activeModel = config.models[config.defaultModel];
  if (!activeModel) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaultModel"],
      message: `Unknown default model alias: ${config.defaultModel}`
    });
  }

  for (const [alias, model] of Object.entries(config.models)) {
    const provider = config.providers[model.provider];
    if (!provider) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["models", alias, "provider"],
        message: `Unknown provider alias: ${model.provider}`
      });
      continue;
    }
    // Reasoning is opt-in per model. The native provider transport maps the
    // configured effort to the provider's request fields.
  }

  const activeReasoning = activeModel?.reasoning;
  const activeThinkingLevels = activeModel?.thinkingLevelMap;
  const activeSupportsReasoning = activeThinkingLevels
    ? Object.entries(activeThinkingLevels).some(([level, native]) => level !== "off" && native !== null)
    : activeReasoning !== undefined;
  // ProviderRuntime 还会根据 provider 默认值补齐动态目录/未知模型的能力；配置层不能因为
  // alias 没有携带完整 metadata 就提前拒绝。只有明确声明不支持时才在这里报错。
  const activeReasoningDisabled = activeModel?.capabilities?.reasoning === false
    || activeModel?.compatibility?.supportsReasoning === false;
  if (config.thinking.enabled && activeReasoningDisabled) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["thinking", "enabled"],
      message: `Model ${config.defaultModel} explicitly disables thinking controls.`
    });
  }
  const activeEfforts = activeThinkingLevels
    ? Object.entries(activeThinkingLevels)
      .filter(([level, native]) => level !== "off" && native !== null)
      .map(([level]) => level)
    : activeReasoning?.efforts ?? [];
  if (config.thinking.enabled && activeSupportsReasoning && !activeEfforts.includes(config.thinking.effort)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["thinking", "effort"],
      message: `Model ${config.defaultModel} does not support ${config.thinking.effort} effort.`
    });
  }

  for (const field of ["memoryModel", "rewriteModel", "extractModel", "consolidationModel"] as const) {
    const memoryAlias = config.context.memory[field];
    if (memoryAlias && !config.models[memoryAlias]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["context", "memory", field],
        message: `Unknown memory model alias: ${memoryAlias}`
      });
    }
  }

  const subagentAlias = config.extensions.subagent.model;
  if (subagentAlias) {
    const subagentModel = config.models[subagentAlias];
    if (!subagentModel) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["extensions", "subagent", "model"],
        message: `Unknown subagent model alias: ${subagentAlias}`
      });
    } else if (subagentModel.supportsTools === false) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["extensions", "subagent", "model"],
        message: `Subagent model ${subagentAlias} does not support tools.`
      });
    }
  }

  if (config.extensions.subagent.maxCostUsd !== undefined) {
    const budgetAlias = subagentAlias ?? config.defaultModel;
    const pricing = config.models[budgetAlias]?.pricing;
    if (
      pricing?.inputPerMillionTokens === undefined
      || pricing.outputPerMillionTokens === undefined
      || pricing.cacheReadPerMillionTokens === undefined
      || pricing.cacheWritePerMillionTokens === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["extensions", "subagent", "maxCostUsd"],
        message: `Subagent cost stop thresholds require input, output, cache-read, and cache-write pricing for model ${budgetAlias}.`
      });
    }
  }
});

export const configSchema = z.preprocess(rejectLegacyModelConfig, canonicalConfigSchema);

export type AgentConfig = z.infer<typeof canonicalConfigSchema>;
export type ModelProvider = z.infer<typeof modelProviderSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ProviderEmbeddingModelConfig = z.infer<typeof providerEmbeddingModelSchema>;
export type ModelAliasConfig = z.infer<typeof modelAliasSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
export type ThinkingLevelMap = z.infer<typeof thinkingLevelMapSchema>;
export type ModelApiBackend = z.infer<typeof modelApiBackendSchema>;
export type ModelCompatibility = z.infer<typeof modelCompatibilitySchema>;
export type ModelThinkingConfig = z.infer<typeof modelThinkingSchema>;
export type ModelReasoningConfig = z.infer<typeof thinkingSchema>;
export type ModelPricing = z.infer<typeof modelPricingSchema>;
export type ModelLimits = z.infer<typeof modelLimitsSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type ExtensionsConfig = z.infer<typeof extensionsSchema>;
export type HookConfig = z.infer<typeof hookSchema>;
export type HooksConfig = z.infer<typeof hooksSchema>;
export type SandboxConfig = z.infer<typeof sandboxSchema>;
export type CheckpointsConfig = z.infer<typeof checkpointsSchema>;
export type DiagnosticsConfig = z.infer<typeof diagnosticsSchema>;
export type WebFetchConfig = z.infer<typeof webFetchSchema>;
export type WebSearchConfig = z.infer<typeof webSearchSchema>;
export type WebCookiesConfig = z.infer<typeof webCookiesSchema>;
export type WebConfig = z.infer<typeof webSchema>;
export type { MemoryPolicy, PersonalizationSettings };

const defaultWorkspaceIgnore = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".env",
  ".biny",
  ".agent",
  ".DS_Store",
  "PROJECT_DESCRIPTION.local.md",
  "TODO.local.md",
  "ARCHITECTURE.local.md"
];

export const defaultConfig: AgentConfig = {
  format: GLOBAL_CONFIG_FORMAT,
  configVersion: GLOBAL_CONFIG_VERSION,
  defaultModel: "deepseek-v4-flash",
  providers: {
    deepseek: {
      type: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY"
    }
  },
  models: {
    "deepseek-v4-flash": {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      description: "Fast and affordable model for everyday work.",
      supportsTools: true,
      capabilities: { tools: true, reasoning: true, streaming: true },
      thinkingLevelMap: { off: "none", high: "high", max: "max" },
      reasoning: { efforts: ["high", "max"], defaultEffort: "high", mapping: { high: "high", max: "max" } }
    },
    "deepseek-v4-pro": {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      description: "Frontier model for complex coding, research, and real-world work.",
      supportsTools: true,
      capabilities: { tools: true, reasoning: true, streaming: true },
      thinkingLevelMap: { off: "none", high: "high", max: "max" },
      reasoning: { efforts: ["high", "max"], defaultEffort: "high", mapping: { high: "high", max: "max" } }
    }
  },
  thinking: { enabled: false, effort: "high" },
  agent: {
    softStepLimit: 32,
    hardStepLimit: 96,
    maxToolCalls: undefined,
    maxRepeatedActions: 3,
    maxConcurrentTools: 4,
    maxQueuedToolCalls: 64
  },
  permission: {
    mode: "ask",
    allowTools: ["read_file", "list_files", "search_files", "grep_search", "git_status", "git_diff", "web_search", "save_memory"],
    allowPaths: [],
    denyPaths: [".env", ".env.local", ".ssh/", "node_modules/"],
    criticalAlwaysAsk: true
  },
  workspace: {
    ignore: defaultWorkspaceIgnore
  },
  personalization: { enabled: true, personality: "none", customInstructions: "" },
  checkpoints: { enabled: true },
  sandbox: { mode: "off", allowNetwork: true },
  hooks: { beforeTool: [], afterTool: [] },
  diagnostics: {
    enabled: false,
    autoDetect: false,
    autoDetectTimeoutMs: 120_000,
    maxOutputBytes: 8 * 1024,
    commands: []
  },
  context: {
    maxTurnToolResultBytes: 128 * 1024,
    instructionsMaxBytes: 32 * 1024,
    compaction: { enabled: true, reserveTokens: undefined, keepRecentTokens: undefined, maxSummaryTokens: 4_096 },
    memory: {
      enabled: false,
      useMemories: true,
      generateMemories: true,
      queryRewrite: true,
      memoryModel: undefined,
      rewriteModel: undefined,
      extractModel: undefined,
      consolidationModel: undefined,
      embeddingModel: undefined,
      similarityThresholds: {},
      cloudEmbeddingConsents: {},
      excludeExternalContext: true,
      maxRecalled: 5
    }
  },
  web: {
    search: {
      enabled: false,
      provider: "anysearch",
      apiKey: undefined,
      apiKeyEnv: undefined,
      timeoutMs: 10_000,
      maxResults: 5
    },
    fetch: {
      enabled: false,
      timeoutMs: 15_000,
      maxBytes: 2 * 1024 * 1024,
      maxRedirects: 5,
      allowPrivateNetwork: false
    },
    cookies: { enabled: false, path: undefined }
  },
  telemetry: { enabled: false, recordInputs: false, recordOutputs: false },
  extensions: {
    mcp: {},
    skills: [...DEFAULT_PROJECT_SKILL_PATHS],
    plugins: [],
    subagent: {
      enabled: false,
      maxSteps: 16,
      maxOutputTokens: 8_000,
      maxConcurrentSubagents: 2,
      maxPendingSubagents: 16,
      timeoutMs: 300_000,
      model: undefined,
      maxCostUsd: undefined,
      allowedTools: [...defaultSubagentAllowedTools],
      agentPaths: [".biny/agents"]
    }
  }
};

const removedModelIds = new Set(["deepseek-chat", "deepseek-reasoner"]);

/** 目录仍可能返回已下线模型，但它们不应进入普通模型选择器。 */
export function isRemovedModelId(modelId: string): boolean {
  return removedModelIds.has(modelId.toLowerCase());
}

function rejectLegacyModelConfig(value: unknown): unknown {
  if (!isRecord(value)) return value;

  const legacyModel = isRecord(value.model) ? value.model : undefined;
  if (legacyModel && typeof legacyModel.provider === "string" && typeof legacyModel.model === "string") {
    throw new Error(formatRemovedModelConfigPrompt({
      provider: legacyModel.provider,
      model: legacyModel.model,
      reason: "the single `model.provider` / `model.model` configuration shape was removed"
    }));
  }

  const models = isRecord(value.models) ? value.models : {};
  for (const [alias, candidate] of Object.entries(models)) {
    if (!isRecord(candidate) || typeof candidate.model !== "string") continue;
    if (isRemovedModelId(candidate.model) || isRemovedModelId(alias)) {
      throw new Error(formatRemovedModelConfigPrompt({
        alias,
        model: candidate.model,
        reason: `the model ID \`${candidate.model}\` was removed`
      }));
    }
    if ("thinking" in candidate) {
      throw new Error(formatRemovedModelConfigPrompt({
        alias,
        model: candidate.model,
        reason: "the model-level `thinking` field was removed; use `reasoning`"
      }));
    }
  }
  return value;
}

function formatRemovedModelConfigPrompt(details: {
  provider?: string;
  alias?: string;
  model: string;
  reason: string;
}): string {
  const detected = [
    details.provider ? `provider=${JSON.stringify(details.provider)}` : undefined,
    details.alias ? `alias=${JSON.stringify(details.alias)}` : undefined,
    `model=${JSON.stringify(details.model)}`
  ].filter(Boolean).join(", ");
  return [
    "Unsupported model configuration.",
    `Detected: ${detected}.`,
    `Reason: ${details.reason}.`,
    "Biny no longer auto-migrates removed model formats. Update the file manually and retry.",
    "",
    "Required shape:",
    JSON.stringify({
      defaultModel: "coder",
      providers: {
        deepseek: { type: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" }
      },
      models: {
        coder: {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          reasoning: { efforts: ["high", "max"], defaultEffort: "high" }
        }
      }
    }, null, 2),
    "",
    "After editing, run `biny doctor` to validate the configuration."
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
