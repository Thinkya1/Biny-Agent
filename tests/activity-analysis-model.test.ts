/**
 * analysisModel 解析规则测试：别名/大小写/引用（provider/model-id 与 provider:model-id）、
 * 未配置回退聊天模型、未知引用视为「无可用分析模型」。模型构造走 createNativeModelForConfig，
 * 用带 apiKey 的假 provider，不触碰真实网络。
 */
import assert from "node:assert/strict";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import type { AgentConfig } from "../src/config/schema.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import {
  resolveActivityAnalysisModel,
  resolveConfiguredModelAlias
} from "../src/activity/analysisModel.js";

await testExactAndCaseInsensitiveAlias();
await testProviderModelIdReference();
await testProviderColonModelIdTolerance();
await testAnalysisModelFallsBackToDefaultModel();
await testUnknownAnalysisModelReferenceIsNoModel();
await testEmptyAnalysisModelFallsBackToDefault();
await testAnalysisModelUsesConfiguredModel();
await testSettingsSchemaCarriesAnalysisModel();

/** 别名精确匹配（含大小写不敏感）解析到 config.models 的现有别名。 */
async function testExactAndCaseInsensitiveAlias(): Promise<void> {
  const config = buildConfig();
  assert.equal(resolveConfiguredModelAlias(config, "cheap-analyzer"), "cheap-analyzer");
  assert.equal(resolveConfiguredModelAlias(config, "CHEAP-ANALYZER"), "cheap-analyzer", "别名应大小写不敏感");
  assert.equal(resolveConfiguredModelAlias(config, "chat-model"), "chat-model");
}

/** provider/model-id 引用按 provider+model 定位某个已配置模型。 */
async function testProviderModelIdReference(): Promise<void> {
  const config = buildConfig();
  assert.equal(resolveConfiguredModelAlias(config, "cheap/cheap-model-4x"), "cheap-analyzer");
  assert.equal(resolveConfiguredModelAlias(config, "openai/aliased-model"), "aliased");
  assert.equal(resolveConfiguredModelAlias(config, "nope/whatever"), undefined, "未知 provider/model-id 不应解析");
}

/** 容忍写成 provider:model-id（用户常把模型标识写成冒号分隔）。 */
async function testProviderColonModelIdTolerance(): Promise<void> {
  const config = buildConfig();
  assert.equal(resolveConfiguredModelAlias(config, "cheap:cheap-model-4x"), "cheap-analyzer");
  assert.equal(resolveConfiguredModelAlias(config, "nope:whatever"), undefined);
}

/** 未配置 analysisModel 时回退当前聊天模型 config.defaultModel。 */
async function testAnalysisModelFallsBackToDefaultModel(): Promise<void> {
  const config = buildConfig();
  const model = resolveActivityAnalysisModel(config);
  assert.ok(model, "回退 defaultModel 应能构造出模型");
  assert.equal(model?.provider, "openai");
  assert.equal(model?.modelId, "gpt-test");
}

/** 配置 analysisModel 时按其构造模型，而不是回退聊天模型。 */
async function testAnalysisModelUsesConfiguredModel(): Promise<void> {
  const config = buildConfig({ analysisModel: "cheap-analyzer" });
  const model = resolveActivityAnalysisModel(config);
  assert.ok(model);
  assert.equal(model?.modelId, "cheap-model-4x", "应使用配置的分析模型");

  const byReference = resolveActivityAnalysisModel(buildConfig({ analysisModel: "cheap:cheap-model-4x" }));
  assert.equal(byReference?.modelId, "cheap-model-4x", "provider:model-id 引用也应构造出对应模型");
}

/** 指向未知别名或未知引用的 analysisModel：视为无可用分析模型（返回 undefined，不抛错）。 */
async function testUnknownAnalysisModelReferenceIsNoModel(): Promise<void> {
  assert.equal(resolveConfiguredModelAlias(buildConfig(), "no-such-alias"), undefined);
  assert.equal(resolveActivityAnalysisModel(buildConfig({ analysisModel: "no-such-alias" })), undefined);
  assert.equal(resolveActivityAnalysisModel(buildConfig({ analysisModel: "nope/whatever" })), undefined);
}

/** 空白 analysisModel 与未配置等价：resolver 先 trim，空引用回退聊天模型（schema 层会把纯空白判为非法配置）。 */
async function testEmptyAnalysisModelFallsBackToDefault(): Promise<void> {
  const config = buildConfig();
  const whitespaceOnly: AgentConfig = { ...config, activity: { ...config.activity, analysisModel: "   " } };
  const model = resolveActivityAnalysisModel(whitespaceOnly);
  assert.equal(model?.modelId, "gpt-test");
}

/** settings schema 接受可选 analysisModel（provider:model-id 也作普通字符串通过），配置层透传。 */
async function testSettingsSchemaCarriesAnalysisModel(): Promise<void> {
  const parsed = configSchema.parse({
    ...defaultConfig,
    activity: { ...defaultActivitySettings, analysisModel: "cheap/cheap-model-4x" }
  });
  assert.equal(parsed.activity.analysisModel, "cheap/cheap-model-4x");
  const pending = configSchema.parse({
    ...defaultConfig,
    activity: { ...defaultActivitySettings, analysisModel: "cheap:cheap-model-4x" }
  });
  assert.equal(pending.activity.analysisModel, "cheap:cheap-model-4x");
}

function buildConfig(overrides?: { analysisModel?: string }): AgentConfig {
  return configSchema.parse({
    ...defaultConfig,
    defaultModel: "chat-model",
    providers: {
      openai: { type: "openai", apiKey: "test-key", baseUrl: "https://api.example.test/v1" },
      cheap: { type: "openai", apiKey: "test-key", baseUrl: "https://api.example.test/v1" }
    },
    models: {
      "chat-model": { provider: "openai", model: "gpt-test", capabilities: { tools: true, reasoning: true, streaming: true } },
      "cheap-analyzer": { provider: "cheap", model: "cheap-model-4x", capabilities: { tools: true, reasoning: true, streaming: true } },
      aliased: { provider: "openai", model: "aliased-model", capabilities: { tools: true, reasoning: true } }
    },
    activity: overrides?.analysisModel === undefined
      ? defaultActivitySettings
      : { ...defaultActivitySettings, analysisModel: overrides.analysisModel }
  });
}