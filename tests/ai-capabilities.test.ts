import assert from "node:assert/strict";
import { inferReasoningEfforts, modelCapabilities, modelContextBudget, modelReasoningConfig, modelThinkingLevelMap, nativeReasoningEffort, reasoningBudgetTokens, thinkingLevelMapForModel } from "../src/ai/capabilities.js";
import { builtinProviderModels } from "../src/ai/builtinModels.js";
import { openAiCodexCatalogModels } from "../src/ai/codexModels.js";
import { parseModelCatalog } from "../src/ai/modelCatalog.js";
import { lookupModelMetadata } from "../src/ai/modelMetadata.js";
import { createRetryFetch } from "../src/ai/retry.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ModelRegistry } from "../src/llm/ModelRegistry.js";
import { ModelResolver } from "../src/llm/ModelResolver.js";
import { ModelRuntime } from "../src/llm/ModelRuntime.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import { thinkingSelectionForModel } from "../src/llm/modelThinking.js";

const config = configSchema.parse({
  ...structuredClone(defaultConfig),
  defaultModel: "small",
  models: {
    small: {
      provider: "deepseek",
      model: "small-model",
      contextWindow: 16_384,
      maxOutputTokens: 4_096,
      capabilities: { tools: true, reasoning: true, vision: true, streaming: true },
      reasoning: {
        efforts: ["low", "high"],
        defaultEffort: "high",
        mapping: { low: "low", high: "high" },
        budgetTokens: { low: 1_024, high: 3_072 }
      }
    }
  },
  thinking: { enabled: false, effort: "high" }
});

const model = config.models.small!;
assert.equal(thinkingSelectionForModel("high", {
  efforts: ["low", "high"],
  defaultThinking: "high"
}), "high");
assert.equal(thinkingSelectionForModel("max", {
  efforts: ["low", "high"],
  defaultThinking: "high"
}), "high");
assert.equal(thinkingSelectionForModel("off", {
  efforts: [],
  defaultThinking: "off"
}), undefined);
assert.equal(thinkingSelectionForModel("off", {
  efforts: ["high", "max"],
  defaultThinking: "high",
  thinkingLevelMap: { off: "none", high: "high", max: "max" }
}), "off");
const budget = modelContextBudget(model, config.context.maxInputTokens, "small");
assert.equal(budget.contextWindow, 16_384);
assert.equal(budget.maxInputTokens, 9_728);
assert.equal(budget.maxOutputTokens, 4_096);
assert.equal(budget.reasoningReserveTokens, 0);
assert.equal(budget.toolSchemaReserveTokens, 1_024);
assert.equal(budget.systemPromptReserveTokens, 1_024);
assert.equal(budget.protocolSafetyMarginTokens, 512);
assert.equal(budget.modelAlias, "small");
assert.equal(modelCapabilities(model).vision, true);
assert.equal(nativeReasoningEffort(model, "high"), "high");
assert.equal(reasoningBudgetTokens(model, "high"), 3_072);

const reasoningBudget = modelContextBudget(model, undefined, "small", { reasoning: "high" });
assert.equal(reasoningBudget.maxInputTokens, 6_656);
assert.equal(reasoningBudget.reasoningReserveTokens, 3_072);

const deepseekUnknownAliasConfig = configSchema.parse({
  ...defaultConfig,
  defaultModel: "flash-alias",
  models: { "flash-alias": { provider: "deepseek", model: "deepseek-v4-flash" } }
});
const deepseekRuntime = new ProviderRegistry(deepseekUnknownAliasConfig);
const normalizedFlash = deepseekRuntime.forModel("flash-alias").model;
assert.deepEqual(modelReasoningConfig(normalizedFlash)?.efforts, ["low", "high", "max"]);
assert.deepEqual(modelThinkingLevelMap(normalizedFlash), { low: "low", high: "high", max: "max" });
assert.equal(modelCapabilities(normalizedFlash).reasoningStream, true);
assert.equal(normalizedFlash.contextWindow, 1_000_000);

const explicitContextConfig = configSchema.parse({
  ...deepseekUnknownAliasConfig,
  models: { "flash-alias": { ...deepseekUnknownAliasConfig.models["flash-alias"], contextWindow: 128_000 } }
});
assert.equal(new ProviderRegistry(explicitContextConfig).forModel("flash-alias").model.contextWindow, 128_000);

const openCodeFlashConfig = configSchema.parse({
  ...defaultConfig,
  defaultModel: "opencode-flash",
  providers: {
    "opencode-ai": {
      type: "openai-compatible",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "test-key"
    }
  },
  models: {
    "opencode-flash": { provider: "opencode-ai", model: "deepseek-v4-flash" }
  }
});
const normalizedOpenCodeFlash = new ProviderRegistry(openCodeFlashConfig, [[
  "opencode-ai",
  [{
    id: "deepseek-v4-flash",
    displayName: "deepseek-v4-flash",
    provider: "opencode-ai",
    capabilities: { tools: true, reasoning: false, streaming: true },
    reasoningEfforts: [],
    thinkingLevelMap: {}
  }]
]]).forModel("opencode-flash").model;
assert.equal(normalizedOpenCodeFlash.contextWindow, 1_000_000);
assert.equal(modelCapabilities(normalizedOpenCodeFlash).reasoning, true);
assert.deepEqual(modelReasoningConfig(normalizedOpenCodeFlash)?.efforts, ["low", "high", "max"]);

const geminiFlashConfig = configSchema.parse({
  ...defaultConfig,
  defaultModel: "gemini-flash",
  providers: { gemini: { type: "gemini", apiKey: "test-key" } },
  models: { "gemini-flash": { provider: "gemini", model: "gemini-3.5-flash" } }
});
const normalizedGeminiFlash = new ProviderRegistry(geminiFlashConfig).forModel("gemini-flash").model;
assert.equal(modelCapabilities(normalizedGeminiFlash).reasoning, true);

const generatedConfig = configSchema.parse({
  ...defaultConfig,
  defaultModel: "generated-coder",
  providers: { deepseek: { type: "deepseek", apiKey: "test-key" } },
  models: { "generated-coder": { provider: "deepseek", model: "deepseek-v4-pro" } }
});
const generatedRuntime = new ModelRuntime(generatedConfig);
const generatedChoice = generatedRuntime.listModels().find((choice) => choice.alias === "deepseek/deepseek-v4-flash");
assert.equal(generatedChoice?.source, "catalog");
assert.ok(generatedChoice?.description);
assert.equal(typeof generatedChoice?.pricing?.inputPerMillionTokens, "number");
assert.equal(generatedRuntime.resolve("deepseek/deepseek-v4-flash").model.baseUrl, undefined);
assert.equal(typeof lookupModelMetadata("deepseek", "deepseek-v4-flash")?.contextWindow, "number");

const codexModelIds = openAiCodexCatalogModels.map((entry) => entry.id);
assert.deepEqual(builtinProviderModels["openai-codex"]?.map((entry) => entry.id), codexModelIds);
assert.equal(lookupModelMetadata("openai-codex", "gpt-5.6-sol")?.contextWindow, 372_000);
assert.notEqual(lookupModelMetadata("openai", "gpt-5.6-sol")?.contextWindow, 372_000);

const codexConfig = configSchema.parse({
  ...defaultConfig,
  defaultModel: "codex-sol",
  providers: { "openai-codex": { type: "openai-codex" } },
  models: { "codex-sol": { provider: "openai-codex", model: "gpt-5.6-sol" } }
});
const normalizedCodex = new ProviderRegistry(codexConfig).forModel("codex-sol").model;
assert.equal(normalizedCodex.contextWindow, 372_000);
assert.equal(modelCapabilities(normalizedCodex).reasoning, true);

const codexLunaConfig = configSchema.parse({
  ...defaultConfig,
  defaultModel: "codex-luna",
  providers: { "openai-codex": { type: "openai-codex" } },
  models: { "codex-luna": { provider: "openai-codex", model: "gpt-5.6-luna" } }
});
const normalizedCodexLuna = new ProviderRegistry(codexLunaConfig).forModel("codex-luna").model;
assert.deepEqual(modelReasoningConfig(normalizedCodexLuna)?.efforts, ["low", "medium", "high", "xhigh", "max"]);
assert.deepEqual(modelThinkingLevelMap(normalizedCodexLuna), {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max"
});

const userReasoningOverride = configSchema.parse({
  ...codexLunaConfig,
  models: {
    "codex-luna": {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      reasoning: { efforts: ["low"], defaultEffort: "low", mapping: { low: "provider-low" } }
    }
  }
});
assert.deepEqual(modelThinkingLevelMap(new ProviderRegistry(userReasoningOverride).forModel("codex-luna").model), { low: "provider-low" });

const inferredCodexLuna = parseModelCatalog({ models: [{ slug: "gpt-5.6-luna" }] }, "openai-codex", "openai-compatible", true)[0]!;
assert.equal(inferredCodexLuna.reasoningEffortsSource, "inferred");
const inferredCodexRuntime = new ModelRuntime(codexConfig, [["openai-codex", [inferredCodexLuna]]]);
assert.deepEqual(
  modelReasoningConfig(inferredCodexRuntime.resolve("openai-codex/gpt-5.6-luna").model)?.efforts,
  ["low", "medium", "high", "xhigh", "max"]
);

const declaredCodexLuna = parseModelCatalog({
  models: [{ slug: "gpt-5.6-luna", reasoning_efforts: ["high", "max"] }]
}, "openai-codex", "openai-compatible", true)[0]!;
assert.equal(declaredCodexLuna.reasoningEffortsSource, "declared");
assert.deepEqual(
  modelReasoningConfig(new ProviderRegistry(codexLunaConfig, [["openai-codex", [declaredCodexLuna]]]).forModel("codex-luna").model)?.efforts,
  ["high", "max"]
);

const unknownModelConfig = configSchema.parse({
  ...defaultConfig,
  defaultModel: "unknown",
  providers: { relay: { type: "openai-compatible", baseUrl: "https://relay.example/v1", apiKey: "test-key" } },
  models: { unknown: { provider: "relay", model: "future-model" } },
  thinking: { enabled: true, effort: "high" }
});
const unknownRuntime = new ProviderRegistry(unknownModelConfig);
const unknownModel = unknownRuntime.forModel("unknown").model;
assert.equal(modelCapabilities(unknownModel).reasoning, false);
assert.equal(unknownRuntime.createModelSettings().providerOptions, undefined);

assert.deepEqual(modelThinkingLevelMap(defaultConfig.models["deepseek-v4-flash"]!), { off: "none", high: "high", max: "max" });
assert.deepEqual(modelThinkingLevelMap(defaultConfig.models["deepseek-v4-pro"]!), { off: "none", high: "high", max: "max" });
assert.deepEqual(thinkingLevelMapForModel("deepseek-v4-pro"), { off: "none", high: "high", max: "max" });
assert.deepEqual(thinkingLevelMapForModel("deepseek-v4-flash"), { off: "none", high: "high", max: "max" });
assert.deepEqual(thinkingLevelMapForModel("kimi-k3"), { low: "low", high: "high", max: "max" });

const registry = new ModelRegistry(structuredClone(defaultConfig));
registry.registerCatalog("deepseek", [{
  id: "deepseek-v4-pro-preview",
  displayName: "DeepSeek V4 Pro Preview",
  provider: "deepseek",
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  capabilities: { tools: true, reasoning: true, streaming: true },
  reasoningEfforts: ["low", "medium", "high"]
}]);
const catalogChoice = registry.listModels().find((choice) => choice.alias === "deepseek/deepseek-v4-pro-preview");
assert.equal(catalogChoice?.source, "catalog");
assert.deepEqual(catalogChoice?.efforts, ["low", "medium", "high"]);
assert.equal(new ModelResolver(registry).resolve("deepseek/deepseek-v4-pro-preview").source, "catalog");

const catalog = parseModelCatalog({
  data: [{
    id: "catalog-model",
    display_name: "Catalog Model",
    context_window: 131_072,
    max_tokens: 16_384,
    supports_tools: true,
    supports_vision: true,
    reasoning_efforts: ["low", "high"]
  }]
}, "gateway", "openai-compatible");
assert.deepEqual(catalog[0], {
  id: "catalog-model",
  displayName: "Catalog Model",
  provider: "gateway",
  contextWindow: 131_072,
  maxOutputTokens: 16_384,
  capabilities: { tools: true, reasoning: undefined, vision: true, audio: undefined, streaming: true },
  reasoningEfforts: ["low", "high"],
  reasoningEffortsSource: "declared"
});

const codexCatalog = parseModelCatalog({
  models: [
    { slug: "gpt-5.6-sol" },
    { slug: "hidden-model", visibility: "hidden" }
  ]
}, "openai-codex", "openai-compatible", true);
assert.deepEqual(codexCatalog.map((entry) => entry.id), ["gpt-5.6-sol"]);

const completeCatalog = parseModelCatalog({
  data: [{
    id: "complete-model",
    context_window: 262_144,
    max_input_tokens: 240_000,
    output_token_limit: 32_768,
    supports_thinking: true,
    supports_reasoning_stream: true,
    supports_reasoning_summary: true,
    supports_parallel_tool_calls: true,
    tool_schema_reserve_tokens: 2_048,
    base_url: "http://127.0.0.1:9/private",
    apiBackend: "responses",
    headers: { Authorization: "Bearer catalog-key", "x-catalog": "untrusted" },
    compatibility: { supportsDeveloperRole: true, maxTokensField: "max_completion_tokens" }
  }]
}, "gateway", "openai-compatible", false);
assert.equal(completeCatalog[0]?.maxInputTokens, 240_000);
assert.equal(completeCatalog[0]?.maxOutputTokens, 32_768);
assert.equal(completeCatalog[0]?.capabilities.reasoning, true);
assert.equal(completeCatalog[0]?.capabilities.reasoningStream, true);
assert.equal(completeCatalog[0]?.capabilities.reasoningSummary, true);
assert.equal(completeCatalog[0]?.capabilities.parallelToolCalls, true);
assert.equal(completeCatalog[0]?.limits?.toolSchemaReserveTokens, 2_048);
assert.equal(completeCatalog[0]?.baseUrl, undefined);
assert.equal(completeCatalog[0]?.apiBackend, undefined);
assert.equal(completeCatalog[0]?.headers, undefined);
assert.equal(completeCatalog[0]?.compatibility, undefined);

let attempts = 0;
const retryMetrics: Array<{ attempt: number; status?: number; willRetry: boolean }> = [];
const retryingFetch = createRetryFetch({ maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0 }, async () => {
  attempts += 1;
  return new Response("ok", { status: attempts === 1 ? 503 : 200 });
}, (event) => retryMetrics.push({ attempt: event.attempt, status: event.status, willRetry: event.willRetry }));
assert.equal((await retryingFetch("https://example.test")).status, 200);
assert.equal(attempts, 2);
assert.deepEqual(retryMetrics, [
  { attempt: 1, status: 503, willRetry: true },
  { attempt: 2, status: 200, willRetry: false }
]);

// Relays and self-hosted gateways almost never declare reasoning_efforts, so
// well-known reasoning models must still surface thinking controls via the
// ID-based fallback — otherwise they silently show only a "default" level.
assert.deepEqual(inferReasoningEfforts("grok-4.5"), ["high", "max"]);
assert.deepEqual(inferReasoningEfforts("gpt-5.4"), ["high", "max"]);
assert.deepEqual(inferReasoningEfforts("claude-sonnet-4.6"), ["high", "max"]);
assert.deepEqual(inferReasoningEfforts("deepseek-v4-flash"), ["high", "max"]);
assert.deepEqual(inferReasoningEfforts("deepseek-v4-pro"), ["high", "max"]);
assert.deepEqual(inferReasoningEfforts("kimi-k3"), ["low", "high", "max"]);
assert.deepEqual(inferReasoningEfforts("openai/gpt-5.4"), ["high", "max"]); // aggregator vendor prefix
assert.deepEqual(inferReasoningEfforts("grok-3-mini"), ["high", "max"]);
assert.deepEqual(inferReasoningEfforts("gpt-4o-mini"), []);
assert.deepEqual(inferReasoningEfforts("llama-3.3-70b-instruct"), []);
assert.deepEqual(inferReasoningEfforts(""), []);

const relayCatalog = parseModelCatalog({
  data: [{ id: "grok-4.5" }]
}, "relay", "openai-compatible");
assert.deepEqual(relayCatalog[0]?.reasoningEfforts, ["high", "max"]);
const relayCatalogNonReasoning = parseModelCatalog({
  data: [{ id: "gpt-5.4", supports_reasoning: false }]
}, "relay", "openai-compatible");
assert.deepEqual(relayCatalogNonReasoning[0]?.reasoningEfforts, []);
assert.equal(relayCatalogNonReasoning[0]?.reasoningEffortsSource, "declared");

const alternateCatalogShape = parseModelCatalog({
  models: [{ model: "hosted-model", displayName: "Hosted Model", contextLength: 65_536 }]
}, "hosted", "openai-compatible");
assert.deepEqual(alternateCatalogShape[0], {
  id: "hosted-model",
  displayName: "Hosted Model",
  provider: "hosted",
  contextWindow: 65_536,
  maxOutputTokens: undefined,
  capabilities: { tools: undefined, reasoning: undefined, vision: undefined, audio: undefined, streaming: true },
  reasoningEfforts: [],
  reasoningEffortsSource: undefined
});
