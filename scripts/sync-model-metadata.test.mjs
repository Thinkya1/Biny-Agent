import assert from "node:assert/strict";
import test from "node:test";

import { toMetadata, toPricing } from "./sync-model-metadata.mjs";

const model = {
  name: "Example Agent",
  description: "A tool-capable model.",
  reasoning: true,
  reasoning_options: [{ type: "effort", values: ["low", "high", "none"] }],
  tool_call: true,
  structured_output: true,
  knowledge: "2025-01",
  last_updated: "2026-01-01",
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 128_000, input: 100_000, output: 16_000 },
  cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 }
};

test("toMetadata converts model facts and preserves explicit off support", () => {
  assert.deepEqual(toMetadata("example", "example-agent", model), {
    displayName: "Example Agent",
    description: "A tool-capable model.",
    contextWindow: 128_000,
    maxInputTokens: 100_000,
    maxOutputTokens: 16_000,
    capabilities: {
      tools: true,
      reasoning: true,
      streaming: true,
      vision: true,
      audio: false
    },
    reasoningEfforts: ["low", "high"],
    thinkingLevelMap: { off: "none", low: "low", high: "high" },
    knowledgeCutoff: "2025-01",
    structuredOutput: true,
    lastUpdated: "2026-01-01",
    modalities: { input: ["text", "image"], output: ["text"] },
    pricing: {
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
      cacheReadPerMillionTokens: 0.1,
      cacheWritePerMillionTokens: 0.2
    }
  });
});

test("toMetadata skips image-only and unusable models", () => {
  assert.equal(toMetadata("example", "image", {
    ...model,
    modalities: { input: ["text"], output: ["image"] }
  }), undefined);
  assert.equal(toMetadata("example", "empty", {
    ...model,
    limit: { context: 0, output: 0 }
  }), undefined);
});

test("toPricing rejects malformed numeric facts", () => {
  assert.deepEqual(toPricing("example", "free", { input: 0, output: 0 }), {
    inputPerMillionTokens: 0,
    outputPerMillionTokens: 0
  });
  assert.throws(() => toPricing("example", "bad", { input: "1" }), /unsupported cost\.input/);
});
