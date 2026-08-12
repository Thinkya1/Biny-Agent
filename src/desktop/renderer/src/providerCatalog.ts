/**
 * Provider catalog for the desktop renderer: the built-in vendor list plus the
 * helpers that map a *saved* connection back onto a catalog entry.
 *
 * This lives outside `components/settings/SettingsOverlay.tsx` because two surfaces need the
 * same answer — the settings model page and the composer's model menu. When
 * the composer resolved branding on its own (from `providerType`) every
 * `openai-compatible` vendor rendered the same placeholder glyph, because
 * brand marks are keyed by `iconTone`, not by provider type.
 */
import type { DesktopModelConfigurationInput, DesktopModelLoginProvider } from "../../protocol.js";
import { openAiCodexCatalogModels } from "../../../ai/codexModels.js";
import type { ModelLimits } from "../../../config/schema.js";
import type { ModelChoice } from "../../../llm/ModelManager.js";

export type ProviderCategory = "推荐" | "账号" | "模型计划" | "API" | "聚合服务" | "本地";

export interface CatalogModel {
  id: string;
  displayName: string;
  supportsThinking: boolean;
  parallelToolCalls?: boolean;
  reasoningStream?: boolean;
  reasoningSummary?: boolean;
  supportsVision?: boolean;
  supportsAudio?: boolean;
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  limits?: ModelLimits;
  thinkingLevelMap?: DesktopModelConfigurationInput["thinkingLevelMap"];
  apiBackend?: DesktopModelConfigurationInput["apiBackend"];
}

export interface ProviderCatalogItem {
  id: string;
  value: DesktopModelConfigurationInput["providerType"];
  label: string;
  description: string;
  badge: string;
  categories: ProviderCategory[];
  connectionMode: "api" | "login";
  loginProvider?: DesktopModelLoginProvider;
  baseUrl: string;
  requiresApiKey: boolean;
  models: CatalogModel[];
  protocol?: DesktopModelConfigurationInput["protocol"];
  iconTone: string;
  apiKeyUrl?: string;
}

interface ApiProviderDefinition {
  id: string;
  value: DesktopModelConfigurationInput["providerType"];
  label: string;
  description: string;
  badge: string;
  categories: ProviderCategory[];
  baseUrl: string;
  requiresApiKey: boolean;
  iconTone: string;
  modelId: string;
  modelDisplayName: string;
  supportsThinking: boolean;
  supportsVision?: boolean;
  supportsAudio?: boolean;
  protocol?: DesktopModelConfigurationInput["protocol"];
  apiKeyUrl?: string;
}

function apiProvider(definition: ApiProviderDefinition): ProviderCatalogItem {
  const { modelId, modelDisplayName, supportsThinking, supportsVision, supportsAudio, apiKeyUrl, ...provider } = definition;
  return {
    ...provider,
    connectionMode: "api",
    models: modelId ? [{ id: modelId, displayName: modelDisplayName, supportsThinking, supportsVision, supportsAudio }] : [],
    apiKeyUrl: apiKeyUrl ?? providerApiKeyUrl(definition.id)
  };
}

function providerApiKeyUrl(providerId: string): string | undefined {
  const urls: Record<string, string | undefined> = {
    deepseek: "https://platform.deepseek.com/api_keys",
    moonshot: "https://platform.moonshot.cn/console/api-keys",
    anthropic: "https://platform.claude.com/settings/keys",
    openai: "https://platform.openai.com/api-keys",
    google: "https://aistudio.google.com/app/apikey",
    siliconflow: "https://cloud.siliconflow.cn/account/ak",
    "MiniMax": "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    "MiniMax-cn": "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    mistral: "https://console.mistral.ai/api-keys",
    togetherai: "https://api.together.ai/settings/api-keys",
    "openrouter": "https://openrouter.ai/settings/keys",
    huggingface: "https://huggingface.co/settings/tokens",
    "deepinfra": "https://deepinfra.com/dash/api_keys",
    cohere: "https://dashboard.cohere.com/api-keys",
    "fireworks-ai": "https://fireworks.ai/account/api-keys",
    nvidia: "https://build.nvidia.com/settings/api-keys",
    groq: "https://console.groq.com/keys",
    alibaba: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    qwen: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    "ollama-cloud": "https://ollama.com/settings/keys"
  };
  return urls[providerId];
}

export const providerCatalog: ProviderCatalogItem[] = [
  apiProvider({ id: "kimi-coding-plan", value: "kimi", label: "Kimi Coding Plan", description: "月之暗面 · Anthropic 兼容", badge: "Coding", categories: ["推荐", "模型计划"], baseUrl: "https://api.kimi.com/coding/v1", requiresApiKey: true, iconTone: "moonshot", modelId: "kimi-k2.5", modelDisplayName: "Kimi K2.5", supportsThinking: true, protocol: "anthropic" }),
  apiProvider({ id: "minimax-coding-plan", value: "openai-compatible", label: "MiniMax Coding Plan", description: "MiniMax Coding 套餐 · Anthropic 兼容", badge: "Coding", categories: ["模型计划"], baseUrl: "https://api.minimax.io/anthropic", requiresApiKey: true, iconTone: "minimax", modelId: "MiniMax-M3", modelDisplayName: "MiniMax M3", supportsThinking: true, protocol: "anthropic" }),
  apiProvider({ id: "deepseek", value: "deepseek", label: "DeepSeek", description: "DeepSeek 官方接入", badge: "API", categories: ["推荐", "API"], baseUrl: "https://api.deepseek.com", requiresApiKey: true, iconTone: "deepseek", modelId: "deepseek-v4-flash", modelDisplayName: "DeepSeek V4 Flash", supportsThinking: true }),
  apiProvider({ id: "moonshot", value: "kimi", label: "Moonshot", description: "Moonshot 官方接入", badge: "API", categories: ["API"], baseUrl: "https://api.moonshot.ai/v1", requiresApiKey: true, iconTone: "moonshot", modelId: "kimi-k3", modelDisplayName: "Kimi K3", supportsThinking: true }),
  apiProvider({ id: "zai-coding-plan", value: "openai-compatible", label: "Z.AI Coding Plan", description: "智谱 · OpenAI 兼容", badge: "Coding", categories: ["模型计划"], baseUrl: "https://api.z.ai/api/coding/paas/v4", requiresApiKey: true, iconTone: "zai", modelId: "glm-5", modelDisplayName: "GLM-5", supportsThinking: true }),
  apiProvider({ id: "MiniMax", value: "openai-compatible", label: "MiniMax", description: "MiniMax · Anthropic 兼容", badge: "API", categories: ["API"], baseUrl: "https://api.minimax.io/anthropic/v1", requiresApiKey: true, iconTone: "minimax", modelId: "MiniMax-M3", modelDisplayName: "MiniMax M3", supportsThinking: true, protocol: "anthropic" }),
  apiProvider({ id: "MiniMax-cn", value: "openai-compatible", label: "MiniMax 中国站", description: "MiniMax 中国站 · Anthropic 兼容", badge: "API", categories: ["API"], baseUrl: "https://api.minimaxi.com/anthropic/v1", requiresApiKey: true, iconTone: "minimax", modelId: "MiniMax-M3", modelDisplayName: "MiniMax M3", supportsThinking: true, protocol: "anthropic" }),
  apiProvider({ id: "siliconflow", value: "openai-compatible", label: "SiliconFlow", description: "硅基流动多模型 API，支持精确模型 ID。", badge: "聚合", categories: ["推荐", "聚合服务"], baseUrl: "https://api.siliconflow.cn/v1", requiresApiKey: true, iconTone: "siliconflow", modelId: "deepseek-ai/DeepSeek-V3", modelDisplayName: "DeepSeek V3", supportsThinking: false }),
  apiProvider({ id: "anthropic", value: "anthropic", label: "Anthropic", description: "Anthropic 官方接入", badge: "API", categories: ["推荐", "API"], baseUrl: "https://api.anthropic.com", requiresApiKey: true, iconTone: "anthropic", modelId: "claude-sonnet-4-5", modelDisplayName: "Claude Sonnet 4.5", supportsThinking: true, supportsVision: true }),
  apiProvider({ id: "openai", value: "openai", label: "OpenAI", description: "OpenAI 官方接入", badge: "API", categories: ["推荐", "API"], baseUrl: "https://api.openai.com/v1", requiresApiKey: true, iconTone: "openai", modelId: "gpt-5.2", modelDisplayName: "GPT-5.2", supportsThinking: true, supportsVision: true }),
  apiProvider({ id: "google", value: "gemini", label: "Google Gemini", description: "Google AI Studio 接入", badge: "API", categories: ["推荐", "API"], baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", requiresApiKey: true, iconTone: "gemini", modelId: "gemini-3.5-flash", modelDisplayName: "Gemini 3.5 Flash", supportsThinking: false, supportsVision: true }),
  apiProvider({ id: "xai", value: "openai-compatible", label: "xAI", description: "xAI 官方接入，Grok 系列模型", badge: "API", categories: ["API"], baseUrl: "https://api.x.ai/v1", requiresApiKey: true, iconTone: "xai", modelId: "grok-4.5", modelDisplayName: "Grok 4.5", supportsThinking: true }),
  apiProvider({ id: "zai", value: "openai-compatible", label: "Z.AI", description: "智谱官方接入，GLM 系列模型", badge: "API", categories: ["API"], baseUrl: "https://api.z.ai/api/paas/v4", requiresApiKey: true, iconTone: "zai", modelId: "glm-5.2", modelDisplayName: "GLM-5.2", supportsThinking: true }),
  apiProvider({ id: "xiaomi", value: "openai-compatible", label: "Xiaomi", description: "小米官方接入，MiMo 系列模型", badge: "API", categories: ["API"], baseUrl: "https://api.xiaomimimo.com/v1", requiresApiKey: true, iconTone: "xiaomi", modelId: "mimo-v2.5", modelDisplayName: "MiMo-V2.5", supportsThinking: true }),
  apiProvider({ id: "xiaomi-token-plan-cn", value: "openai-compatible", label: "Xiaomi Token Plan 中国", description: "小米 MiMo Token Plan 订阅 · 中国 · 编码工具", badge: "Token", categories: ["模型计划"], baseUrl: "https://api.xiaomimimo.com/v1", requiresApiKey: true, iconTone: "xiaomi", modelId: "mimo-v2.5-pro", modelDisplayName: "MiMo-V2.5-Pro", supportsThinking: true }),
  apiProvider({ id: "xiaomi-token-plan-sgp", value: "openai-compatible", label: "Xiaomi Token Plan 新加坡", description: "小米 MiMo Token Plan 订阅 · 新加坡 · 编码工具", badge: "Token", categories: ["模型计划"], baseUrl: "https://api.xiaomimimo.com/v1", requiresApiKey: true, iconTone: "xiaomi", modelId: "mimo-v2.5-pro", modelDisplayName: "MiMo-V2.5-Pro", supportsThinking: true }),
  apiProvider({ id: "xiaomi-token-plan-ams", value: "openai-compatible", label: "Xiaomi Token Plan 欧洲", description: "小米 MiMo Token Plan 订阅 · 欧洲 · 编码工具", badge: "Token", categories: ["模型计划"], baseUrl: "https://api.xiaomimimo.com/v1", requiresApiKey: true, iconTone: "xiaomi", modelId: "mimo-v2.5-pro", modelDisplayName: "MiMo-V2.5-Pro", supportsThinking: true }),
  apiProvider({ id: "cerebras", value: "openai-compatible", label: "Cerebras", description: "高速推理托管开源模型", badge: "API", categories: ["API"], baseUrl: "https://api.cerebras.ai/v1", requiresApiKey: true, iconTone: "cerebras", modelId: "gpt-oss-120b", modelDisplayName: "GPT OSS 120B", supportsThinking: true }),
  apiProvider({ id: "mistral", value: "openai-compatible", label: "Mistral", description: "Mistral 官方接入", badge: "API", categories: ["API"], baseUrl: "https://api.mistral.ai/v1", requiresApiKey: true, iconTone: "mistral", modelId: "mistral-large-latest", modelDisplayName: "Mistral Large", supportsThinking: true }),
  apiProvider({ id: "togetherai", value: "openai-compatible", label: "Together AI", description: "托管开源模型 API", badge: "API", categories: ["API"], baseUrl: "https://api.together.ai/v1", requiresApiKey: true, iconTone: "together", modelId: "meta-llama/Llama-3.3-70B-Instruct", modelDisplayName: "Llama 3.3 70B", supportsThinking: false }),
  apiProvider({ id: "ollama", value: "ollama", label: "Ollama", description: "本机运行 · 离线可用", badge: "Local", categories: ["推荐", "本地"], baseUrl: "http://127.0.0.1:11434/v1", requiresApiKey: false, iconTone: "ollama", modelId: "llama3.2", modelDisplayName: "Llama 3.2", supportsThinking: false }),
  apiProvider({ id: "lm-studio", value: "openai-compatible", label: "LM Studio", description: "本机 LM Studio 服务 · 离线可用", badge: "Local", categories: ["本地"], baseUrl: "http://localhost:1234/v1", requiresApiKey: false, iconTone: "lm-studio", modelId: "", modelDisplayName: "", supportsThinking: false }),
  apiProvider({ id: "localai", value: "openai-compatible", label: "LocalAI", description: "本机 LocalAI 服务，可选密钥保护", badge: "Local", categories: ["本地"], baseUrl: "http://localhost:8080/v1", requiresApiKey: false, iconTone: "localai", modelId: "qwen3-8b", modelDisplayName: "Qwen3 8B", supportsThinking: false }),
  apiProvider({ id: "openai-compatible", value: "openai-compatible", label: "自定义 OpenAI 兼容接口", description: "中转站、代理服务或自部署网关。", badge: "Custom", categories: ["API", "聚合服务"], baseUrl: "", requiresApiKey: true, iconTone: "compatible", modelId: "", modelDisplayName: "", supportsThinking: false }),
  apiProvider({ id: "fireworks-ai", value: "openai-compatible", label: "Fireworks AI", description: "Serverless 开源模型托管", badge: "API", categories: ["API"], baseUrl: "https://api.fireworks.ai/inference/v1", requiresApiKey: true, iconTone: "fireworks", modelId: "accounts/fireworks/models/kimi-k2p6", modelDisplayName: "Kimi K2.6", supportsThinking: true }),
  apiProvider({ id: "nvidia", value: "openai-compatible", label: "NVIDIA", description: "NVIDIA 官方托管模型接入", badge: "API", categories: ["API"], baseUrl: "https://integrate.api.nvidia.com/v1", requiresApiKey: true, iconTone: "nvidia", modelId: "nvidia/nemotron-3-super-120b-a12b", modelDisplayName: "NVIDIA Nemotron", supportsThinking: true }),
  apiProvider({ id: "tencent-tokenhub", value: "openai-compatible", label: "Tencent TokenHub", description: "腾讯云 TokenHub 按量接入，混元等模型", badge: "API", categories: ["API"], baseUrl: "https://tokenhub.tencentmaas.com/v1", requiresApiKey: true, iconTone: "tencent", modelId: "hy3", modelDisplayName: "混元 HY 3", supportsThinking: true }),
  apiProvider({ id: "stepfun", value: "openai-compatible", label: "StepFun 中国站", description: "阶跃星辰官方接入 · 中国站", badge: "API", categories: ["API"], baseUrl: "https://api.stepfun.com/v1", requiresApiKey: true, iconTone: "stepfun", modelId: "step-3.7-flash", modelDisplayName: "Step 3.7 Flash", supportsThinking: true }),
  apiProvider({ id: "tencent-coding-plan", value: "openai-compatible", label: "Tencent Coding Plan", description: "腾讯云 Coding 套餐 · OpenAI 兼容", badge: "Coding", categories: ["模型计划"], baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", requiresApiKey: true, iconTone: "tencent", modelId: "tc-code-latest", modelDisplayName: "TC Code", supportsThinking: true }),
  apiProvider({ id: "stepfun-ai", value: "openai-compatible", label: "StepFun 国际站", description: "阶跃星辰官方接入 · 国际站", badge: "API", categories: ["API"], baseUrl: "https://api.stepfun.ai/v1", requiresApiKey: true, iconTone: "stepfun", modelId: "step-3.7-flash", modelDisplayName: "Step 3.7 Flash", supportsThinking: true }),
  apiProvider({ id: "volcengine-ark", value: "openai-compatible", label: "火山方舟", description: "火山引擎官方接入，豆包等模型", badge: "API", categories: ["API"], baseUrl: "https://ark.cn-beijing.volces.com/api/v3", requiresApiKey: true, iconTone: "volcengine", modelId: "doubao-seed-2-0-pro-260215", modelDisplayName: "Doubao Seed 2.0 Pro", supportsThinking: true }),
  apiProvider({ id: "volcengine-coding-plan", value: "openai-compatible", label: "火山方舟 Coding Plan", description: "火山引擎 Coding 订阅 · OpenAI 兼容", badge: "Coding", categories: ["模型计划"], baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", requiresApiKey: true, iconTone: "volcengine", modelId: "ark-code-latest", modelDisplayName: "Ark Code", supportsThinking: true }),
  apiProvider({ id: "tencent-token-plan", value: "openai-compatible", label: "Tencent Token Plan", description: "腾讯云 Token 套餐，个人智能体与编码工具", badge: "Token", categories: ["模型计划"], baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", requiresApiKey: true, iconTone: "tencent", modelId: "tc-code-latest", modelDisplayName: "TC Code", supportsThinking: true }),
  apiProvider({ id: "stepfun-step-plan", value: "openai-compatible", label: "StepFun Step Plan 中国站", description: "阶跃星辰订阅套餐 · 中国站", badge: "Plan", categories: ["模型计划"], baseUrl: "https://api.stepfun.com/step_plan/v1", requiresApiKey: true, iconTone: "stepfun", modelId: "step-3.7-flash", modelDisplayName: "Step 3.7 Flash", supportsThinking: true }),
  apiProvider({ id: "deepinfra", value: "openai-compatible", label: "DeepInfra", description: "开源模型托管推理 · OpenAI 兼容", badge: "API", categories: ["API"], baseUrl: "https://api.deepinfra.com/v1/openai", requiresApiKey: true, iconTone: "deepinfra", modelId: "meta-llama/Llama-3.3-70B-Instruct", modelDisplayName: "Llama 3.3 70B", supportsThinking: false }),
  apiProvider({ id: "cohere", value: "openai-compatible", label: "Cohere", description: "Cohere 官方接入", badge: "API", categories: ["API"], baseUrl: "https://api.cohere.com/v2", requiresApiKey: true, iconTone: "cohere", modelId: "command-a-plus-05-2026", modelDisplayName: "Command A", supportsThinking: true }),
  apiProvider({ id: "vercel", value: "openai-compatible", label: "Vercel AI Gateway", description: "一个密钥接入多家托管模型", badge: "网关", categories: ["聚合服务"], baseUrl: "https://ai-gateway.vercel.sh/v1", requiresApiKey: true, iconTone: "vercel", modelId: "openai/gpt-5.4", modelDisplayName: "OpenAI GPT-5.4", supportsThinking: true }),
  apiProvider({ id: "stepfun-ai-step-plan", value: "openai-compatible", label: "StepFun Step Plan 国际站", description: "阶跃星辰订阅套餐 · 国际站", badge: "Plan", categories: ["模型计划"], baseUrl: "https://api.stepfun.ai/step_plan/v1", requiresApiKey: true, iconTone: "stepfun", modelId: "step-3.7-flash", modelDisplayName: "Step 3.7 Flash", supportsThinking: true }),
  apiProvider({ id: "cloudflare-workers-ai", value: "openai-compatible", label: "Cloudflare Workers AI", description: "Cloudflare 托管模型，账户级接入", badge: "API", categories: ["API"], baseUrl: "", requiresApiKey: true, iconTone: "cloudflare", modelId: "@cf/meta/llama-3.1-8b-instruct", modelDisplayName: "Llama 3.1 8B", supportsThinking: false }),
  apiProvider({ id: "huggingface", value: "openai-compatible", label: "Hugging Face", description: "Inference Providers 路由，聚合多家托管模型", badge: "路由", categories: ["聚合服务"], baseUrl: "https://router.huggingface.co/v1", requiresApiKey: true, iconTone: "huggingface", modelId: "openai/gpt-oss-120b", modelDisplayName: "GPT OSS 120B", supportsThinking: true }),
  apiProvider({ id: "ollama-cloud", value: "openai-compatible", label: "Ollama Cloud", description: "Ollama 官方云端托管模型", badge: "API", categories: ["API"], baseUrl: "https://ollama.com/v1", requiresApiKey: true, iconTone: "ollama", modelId: "qwen3.5:397b", modelDisplayName: "Qwen 3.5 397B", supportsThinking: true }),
  apiProvider({ id: "zenmux", value: "openai-compatible", label: "ZenMux", description: "模型路由网关，一个密钥接入多家模型", badge: "网关", categories: ["聚合服务"], baseUrl: "https://zenmux.ai/api/v1", requiresApiKey: true, iconTone: "zenmux", modelId: "moonshotai/kimi-k2.5", modelDisplayName: "Kimi K2.5", supportsThinking: true }),
  apiProvider({ id: "opencode", value: "openai-compatible", label: "OpenCode Zen", description: "面向编码智能体的按量模型精选", badge: "Plan", categories: ["模型计划"], baseUrl: "https://opencode.ai/zen/v1", requiresApiKey: true, iconTone: "opencode", modelId: "claude-sonnet-4.6", modelDisplayName: "Claude Sonnet 4.6", supportsThinking: true }),
  apiProvider({ id: "opencode-go", value: "openai-compatible", label: "OpenCode Go", description: "低价订阅制的开源编码模型精选", badge: "Plan", categories: ["模型计划"], baseUrl: "https://opencode.ai/zen/go/v1", requiresApiKey: true, iconTone: "opencode", modelId: "qwen3-coder-plus", modelDisplayName: "Qwen3 Coder Plus", supportsThinking: true }),
  apiProvider({ id: "groq", value: "openai-compatible", label: "Groq", description: "LPU 高速推理托管开源模型", badge: "API", categories: ["API"], baseUrl: "https://api.groq.com/openai/v1", requiresApiKey: true, iconTone: "groq", modelId: "llama-3.3-70b-versatile", modelDisplayName: "Llama 3.3 70B", supportsThinking: false }),
  apiProvider({ id: "openrouter", value: "openai-compatible", label: "OpenRouter", description: "一个密钥接入各大模型厂商 · OpenAI 兼容", badge: "聚合", categories: ["聚合服务"], baseUrl: "https://openrouter.ai/api/v1", requiresApiKey: true, iconTone: "openrouter", modelId: "openai/gpt-4o", modelDisplayName: "OpenAI GPT-4o", supportsThinking: true }),
  apiProvider({ id: "alibaba", value: "openai-compatible", label: "Alibaba", description: "阿里云百炼接入，通义千问 Qwen 模型", badge: "API", categories: ["API"], baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", requiresApiKey: true, iconTone: "alibaba", modelId: "qwen-max", modelDisplayName: "Qwen Max", supportsThinking: true }),
  apiProvider({ id: "alibaba-coding-plan-cn", value: "openai-compatible", label: "Alibaba Coding Plan 中国站", description: "阿里云百炼 Coding Plan 订阅 · 中国站", badge: "Plan", categories: ["模型计划"], baseUrl: "https://coding.dashscope.aliyuncs.com/v1", requiresApiKey: true, iconTone: "alibaba", modelId: "qwen3-coder-plus", modelDisplayName: "Qwen3 Coder Plus", supportsThinking: true }),
  apiProvider({ id: "alibaba-coding-plan", value: "openai-compatible", label: "Alibaba Coding Plan 国际站", description: "阿里云百炼 Coding Plan 订阅 · 国际站", badge: "Plan", categories: ["模型计划"], baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1", requiresApiKey: true, iconTone: "alibaba", modelId: "qwen3-coder-plus", modelDisplayName: "Qwen3 Coder Plus", supportsThinking: true }),
  apiProvider({ id: "alibaba-token-plan-cn", value: "openai-compatible", label: "Alibaba Token Plan（团队版）", description: "阿里云百炼 Token Plan 订阅，交互式智能体与编码工具 · 北京", badge: "Token", categories: ["模型计划"], baseUrl: "https://coding.dashscope.aliyuncs.com/v1", requiresApiKey: true, iconTone: "alibaba", modelId: "qwen3-coder-plus", modelDisplayName: "Qwen3 Coder Plus", supportsThinking: true }),
  apiProvider({ id: "alibaba-token-plan", value: "openai-compatible", label: "Alibaba Token Plan（团队版）", description: "阿里云百炼 Token Plan 订阅，交互式智能体与编码工具 · 新加坡", badge: "Token", categories: ["模型计划"], baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1", requiresApiKey: true, iconTone: "alibaba", modelId: "qwen3-coder-plus", modelDisplayName: "Qwen3 Coder Plus", supportsThinking: true }),
  apiProvider({ id: "qwen", value: "qwen", label: "Qwen", description: "通义千问官方接入", badge: "API", categories: [], baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", requiresApiKey: true, iconTone: "qwen", modelId: "qwen3.5-plus", modelDisplayName: "Qwen 3.5 Plus", supportsThinking: true }),
  {
    id: "claude-code",
    value: "claude-subscription",
    label: "Claude Code",
    description: "Claude Pro / Max 订阅账号登录。",
    badge: "可用",
    categories: ["推荐", "账号"],
    connectionMode: "login",
    loginProvider: "claude-code",
    baseUrl: "https://api.anthropic.com",
    requiresApiKey: false,
    iconTone: "anthropic",
    models: []
  },
  {
    id: "openai-codex",
    value: "openai-codex",
    label: "OpenAI Codex",
    description: "ChatGPT Plus / Pro 订阅账号登录。",
    badge: "可用",
    categories: ["推荐", "账号"],
    connectionMode: "login",
    loginProvider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    requiresApiKey: false,
    iconTone: "openai",
    models: openAiCodexCatalogModels.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      supportsThinking: true,
      supportsVision: true,
      contextWindow: model.contextWindow
    }))
  },
];

export const providerCatalogOrder: Record<ProviderCategory, string[]> = {
  推荐: ["claude-code", "openai-codex", "siliconflow", "anthropic", "openai", "google", "kimi-coding-plan", "deepseek", "ollama"],
  账号: ["claude-code", "openai-codex"],
  模型计划: ["kimi-coding-plan", "minimax-coding-plan", "zai-coding-plan", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "xiaomi-token-plan-ams", "tencent-coding-plan", "volcengine-coding-plan", "tencent-token-plan", "stepfun-step-plan", "opencode", "opencode-go", "stepfun-ai-step-plan", "alibaba-coding-plan-cn", "alibaba-coding-plan", "alibaba-token-plan-cn", "alibaba-token-plan"],
  API: ["deepseek", "moonshot", "MiniMax", "MiniMax-cn", "anthropic", "openai", "google", "xai", "zai", "xiaomi", "cerebras", "mistral", "togetherai", "openai-compatible", "fireworks-ai", "nvidia", "tencent-tokenhub", "stepfun", "stepfun-ai", "volcengine-ark", "deepinfra", "cohere", "cloudflare-workers-ai", "ollama-cloud", "groq", "alibaba"],
  聚合服务: ["siliconflow", "vercel", "openai-compatible", "huggingface", "zenmux", "openrouter"],
  本地: ["ollama", "lm-studio", "localai"]
};

type ProviderOption = ProviderCatalogItem;

export function providerAliasFor(option: ProviderOption, baseUrl: string): string {
  if (option.value !== "openai-compatible") return option.value;
  try {
    const hostname = new URL(baseUrl).hostname.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
    return hostname || "custom";
  } catch {
    return "custom";
  }
}

export function modelAliasFor(providerAlias: string, model: string): string {
  const normalizedProvider = providerAlias.toLowerCase();
  const normalizedModel = model.toLowerCase();
  const alias = normalizedModel === normalizedProvider || normalizedModel.startsWith(`${normalizedProvider}-`)
    ? model
    : `${providerAlias}-${model}`;
  return alias.replace(/[^a-z0-9.-]+/gi, "-");
}

function normalizedEndpoint(url: string | undefined): string {
  return (url ?? "").trim().replace(/\/+$/u, "").toLowerCase();
}

/**
 * Resolves the catalog entry that a saved connection was created from.
 *
 * Matching is deliberately strict. `openai-compatible` is a shared provider
 * *type* covering dozens of unrelated vendors plus arbitrary relays, so
 * "first entry with this type" is not a usable fallback — it used to brand
 * every custom endpoint as MiniMax Coding Plan (the first such entry) and
 * offered MiniMax M3 as a candidate model. Returning undefined instead lets
 * the caller render a neutral custom-endpoint entry.
 */
export function catalogForConnection(
  connection: { provider: string; providerType: string },
  baseUrl?: string
): ProviderCatalogItem | undefined {
  const sameType = providerCatalog.filter((item) => item.value === connection.providerType);
  // Endpoint first: two entries can share a hostname (Z.AI vs Z.AI Coding Plan),
  // and only the full URL tells them apart.
  const byEndpoint = baseUrl ? sameType.find((item) => normalizedEndpoint(item.baseUrl) === normalizedEndpoint(baseUrl)) : undefined;
  if (byEndpoint) return byEndpoint;
  const byAlias = sameType.find((item) => providerAliasFor(item, item.baseUrl) === connection.provider);
  if (byAlias) return byAlias;
  // Only a type that maps to exactly one vendor can be identified by type alone.
  return sameType.length === 1 ? sameType[0] : undefined;
}

/** Neutral entry for a relay / self-hosted endpoint that matches no known vendor. */
export function customCatalogEntry(
  connection: { provider: string; providerType: string; models: ModelChoice[] },
  baseUrl: string | undefined
): ProviderCatalogItem {
  return {
    id: "custom",
    value: connection.providerType as ProviderCatalogItem["value"],
    protocol: undefined,
    label: endpointLabel(baseUrl) ?? connection.provider,
    description: baseUrl ?? connection.providerType,
    badge: "自定义",
    categories: ["API"],
    connectionMode: "api",
    baseUrl: baseUrl ?? "",
    requiresApiKey: true,
    iconTone: "compatible",
    models: connection.models.map((model) => ({
      id: model.model,
      displayName: model.displayName,
      supportsThinking: model.efforts.length > 0,
      parallelToolCalls: model.capabilities?.parallelToolCalls,
      reasoningStream: model.capabilities?.reasoningStream,
      reasoningSummary: model.capabilities?.reasoningSummary,
      supportsVision: model.capabilities?.vision,
      supportsAudio: model.capabilities?.audio,
      contextWindow: model.contextWindow,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      limits: model.limits
    }))
  };
}

function endpointLabel(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}
