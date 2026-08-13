import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_URL = "https://models.dev/api.json";
const DEFAULT_OUTPUT = "src/ai/modelMetadata.generated.ts";

/**
 * Biny 的 provider type 到 models.dev source id 的显式映射。
 *
 * 这里只同步模型事实，不同步 models.dev 的 api、npm 或 env 字段；请求地址、协议和凭据
 * 仍由 Biny 的 ProviderDefinition 与用户配置决定。access path 复用同一份 metadata，但订阅
 * provider 不会把 API provider 的完整目录伪装成本地可用目录。
 */
export const PROVIDERS = {
  deepseek: { source: "deepseek", catalog: true },
  openai: { source: "openai", catalog: true },
  anthropic: { source: "anthropic", catalog: true },
  "claude-subscription": { source: "anthropic", aliasOf: "anthropic", catalog: false },
  "openai-codex": { source: "openai", aliasOf: "openai", catalog: false },
  gemini: { source: "google", catalog: true },
  "google-native": { source: "google", aliasOf: "gemini", catalog: true },
  kimi: { source: "moonshotai", catalog: true },
  qwen: { source: "alibaba", catalog: true },
  xai: { source: "xai", catalog: true },
  mistral: { source: "mistral", catalog: true },
  groq: { source: "groq", catalog: true },
  openrouter: { source: "openrouter", catalog: true },
  cerebras: { source: "cerebras", catalog: true },
  togetherai: { source: "togetherai", catalog: true },
  "fireworks-ai": { source: "fireworks-ai", catalog: true },
  nvidia: { source: "nvidia", catalog: true },
  deepinfra: { source: "deepinfra", catalog: true },
  siliconflow: { source: "siliconflow-cn", catalog: true },
  zai: { source: "zai", catalog: true },
  minimax: { source: "minimax", catalog: true },
  "minimax-cn": { source: "minimax-cn", catalog: true },
  stepfun: { source: "stepfun", catalog: true },
  cohere: { source: "cohere", catalog: true },
  huggingface: { source: "huggingface", catalog: true }
};

const supportedEfforts = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const ignoredEfforts = new Set(["default"]);

/** 将 models.dev 的单个模型转换为 Biny 使用的元数据。不可用于文本 agent 的模型会被跳过。 */
export function toMetadata(providerId, modelId, model) {
  assertModelShape(providerId, modelId, model);
  const contextWindow = model.limit.context;
  const maxOutputTokens = model.limit.output;
  const modalities = model.modalities;
  if (contextWindow <= 0 || maxOutputTokens <= 0) return undefined;
  if (modalities && !modalities.output.includes("text")) return undefined;

  const reasoning = parseReasoningOptions(providerId, modelId, model.reasoning_options);
  const pricing = toPricing(providerId, modelId, model.cost);
  const capabilities = {
    tools: model.tool_call,
    reasoning: model.reasoning,
    streaming: true
  };
  if (modalities) {
    capabilities.vision = modalities.input.some((modality) => modality === "image" || modality === "pdf");
    capabilities.audio = modalities.input.includes("audio");
  }

  const metadata = {
    displayName: model.name,
    ...(typeof model.description === "string" ? { description: model.description } : {}),
    contextWindow,
    ...(positiveNumber(model.limit.input) ? { maxInputTokens: model.limit.input } : {}),
    maxOutputTokens,
    capabilities,
    reasoningEfforts: reasoning.efforts,
    ...(reasoning.thinkingLevelMap ? { thinkingLevelMap: reasoning.thinkingLevelMap } : {}),
    ...(typeof model.knowledge === "string" ? { knowledgeCutoff: model.knowledge } : {}),
    ...(typeof model.structured_output === "boolean" ? { structuredOutput: model.structured_output } : {}),
    ...(typeof model.last_updated === "string" ? { lastUpdated: model.last_updated } : {}),
    ...(modalities ? { modalities } : {}),
    ...(pricing ? { pricing } : {})
  };
  return metadata;
}

/** 将 models.dev 的美元/百万 token 价格转换为 Biny 的费用字段。 */
export function toPricing(providerId, modelId, cost) {
  if (cost === undefined) return undefined;
  if (!isRecord(cost)) throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported cost shape`);
  const pricing = {
    ...(cost.input === undefined ? {} : { inputPerMillionTokens: priceNumber(providerId, modelId, cost.input, "input") }),
    ...(cost.output === undefined ? {} : { outputPerMillionTokens: priceNumber(providerId, modelId, cost.output, "output") }),
    ...(cost.cache_read === undefined ? {} : { cacheReadPerMillionTokens: priceNumber(providerId, modelId, cost.cache_read, "cache_read") }),
    ...(cost.cache_write === undefined ? {} : { cacheWritePerMillionTokens: priceNumber(providerId, modelId, cost.cache_write, "cache_write") })
  };
  return Object.keys(pricing).length ? pricing : undefined;
}

export async function main(argv = process.argv) {
  const inputPath = option("--input", argv);
  const outputPath = option("--output", argv) ?? DEFAULT_OUTPUT;
  const source = inputPath
    ? await readFile(inputPath, "utf8")
    : await fetch(SOURCE_URL, { signal: AbortSignal.timeout(15_000) }).then((response) => {
      if (!response.ok) throw new Error(`models.dev returned HTTP ${String(response.status)}`);
      return response.text();
    });
  const catalog = JSON.parse(source);
  if (!isRecord(catalog)) throw new Error("models.dev returned an unsupported top-level shape");

  const generated = {};
  const aliases = {};
  const catalogProviders = [];
  const canonicalSources = new Set();

  for (const [providerType, definition] of Object.entries(PROVIDERS)) {
    const provider = catalog[definition.source];
    assertProviderShape(definition.source, provider);
    if (definition.aliasOf) {
      aliases[providerType] = definition.aliasOf;
    } else {
      const models = Object.fromEntries(
        Object.entries(provider.models)
          .sort(([left], [right]) => left.localeCompare(right))
          .flatMap(([modelId, model]) => {
            const metadata = toMetadata(definition.source, modelId, model);
            return metadata ? [[modelId, metadata]] : [];
          })
      );
      generated[providerType] = models;
      canonicalSources.add(providerType);
    }
    if (definition.catalog) catalogProviders.push(providerType);
  }

  // Alias provider 的 metadata 通过 aliases 解析，避免把同一份上游快照复制多份。
  for (const [providerType, alias] of Object.entries(aliases)) {
    if (!canonicalSources.has(alias)) throw new Error(`models.dev alias ${providerType} points to missing provider ${alias}`);
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buildGeneratedModule(generated, aliases, catalogProviders));
  return {
    outputPath,
    providerCount: Object.keys(generated).length,
    modelCount: Object.values(generated).reduce((total, models) => total + Object.keys(models).length, 0)
  };
}

export function buildGeneratedModule(generated, aliases, catalogProviders) {
  return [
    "// Generated by scripts/sync-model-metadata.mjs from https://models.dev/api.json.",
    "// Do not edit by hand; change the provider mapping or runtime policy in source files.",
    'import type { ModelMetadata } from "./modelMetadata.js";',
    "",
    "export const GENERATED_MODELS_DEV_METADATA: Record<string, Record<string, ModelMetadata>> =",
    JSON.stringify(generated, null, 2),
    ";",
    "",
    "export const GENERATED_MODELS_DEV_PROVIDER_ALIASES: Record<string, string> =",
    JSON.stringify(aliases, null, 2),
    ";",
    "",
    "export const GENERATED_MODELS_DEV_CATALOG_PROVIDERS: readonly string[] =",
    JSON.stringify(catalogProviders, null, 2),
    ";",
    ""
  ].join("\n");
}

function assertProviderShape(providerId, provider) {
  if (!isRecord(provider) || typeof provider.id !== "string" || typeof provider.name !== "string" || !isRecord(provider.models)) {
    throw new Error(`models.dev provider ${providerId} has an unsupported shape`);
  }
}

function assertModelShape(providerId, modelId, model) {
  if (!isRecord(model) || typeof model.name !== "string" || typeof model.reasoning !== "boolean" || typeof model.tool_call !== "boolean") {
    throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported shape`);
  }
  if (!isRecord(model.limit) || !finiteNumber(model.limit.context) || !finiteNumber(model.limit.output)) {
    throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported limit shape`);
  }
  if (model.limit.input !== undefined && !finiteNumber(model.limit.input)) {
    throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported limit.input`);
  }
  if (model.modalities !== undefined) {
    if (!isRecord(model.modalities) || !Array.isArray(model.modalities.input) || !Array.isArray(model.modalities.output)) {
      throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported modalities shape`);
    }
    if (model.modalities.input.some((value) => typeof value !== "string") || model.modalities.output.some((value) => typeof value !== "string")) {
      throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported modality value`);
    }
  }
  if (model.reasoning_options !== undefined && !Array.isArray(model.reasoning_options)) {
    throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported reasoning_options shape`);
  }
  if (model.description !== undefined && typeof model.description !== "string") {
    throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported description`);
  }
  if (model.knowledge !== undefined && typeof model.knowledge !== "string") {
    throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported knowledge field`);
  }
  if (model.structured_output !== undefined && typeof model.structured_output !== "boolean") {
    throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported structured_output`);
  }
  if (model.last_updated !== undefined && typeof model.last_updated !== "string") {
    throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported last_updated`);
  }
}

function parseReasoningOptions(providerId, modelId, options = []) {
  const efforts = new Set();
  let supportsOff = false;
  for (const option of options) {
    if (!isRecord(option) || typeof option.type !== "string") {
      throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported reasoning option`);
    }
    if (option.type === "budget_tokens" || option.type === "toggle") continue;
    if (option.type !== "effort" || !Array.isArray(option.values)) {
      throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported reasoning option type`);
    }
    for (const value of option.values) {
      if (value === null || ignoredEfforts.has(value)) continue;
      if (value === "none") {
        supportsOff = true;
        continue;
      }
      if (typeof value !== "string" || !supportedEfforts.has(value)) {
        throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported reasoning effort`);
      }
      efforts.add(value);
    }
  }
  const resolved = [...efforts];
  return {
    efforts: resolved,
    thinkingLevelMap: resolved.length
      ? Object.fromEntries([
        ...(supportsOff ? [["off", "none"]] : []),
        ...resolved.map((effort) => [effort, effort])
      ])
      : undefined
  };
}

function priceNumber(providerId, modelId, value, field) {
  if (!finiteNumber(value) || value < 0) throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported cost.${field}`);
  return value;
}

function positiveNumber(value) {
  return finiteNumber(value) && value > 0;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function option(name, argv) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await main();
  console.log(`Generated ${String(result.modelCount)} models for ${String(result.providerCount)} providers at ${result.outputPath}.`);
}
