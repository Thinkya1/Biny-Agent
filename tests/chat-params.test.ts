// 聊天参数回归：schema 默认值与边界、四个 adapter 的 temperature 透传/抑制规则。
import assert from "node:assert/strict";
import type { AgentMessage, ModelStreamContext, ModelStreamOptions } from "../src/agent/core/types.js";
import { chatParamsSchema, configSchema, defaultConfig } from "../src/config/schema.js";
import type { ApiAdapterRequest } from "../src/llm/ApiAdapterRegistry.js";
import { streamOpenAi } from "../src/llm/apiAdapters/openAiChat.js";
import { streamOpenAiResponses } from "../src/llm/apiAdapters/openAiResponses.js";
import { streamAnthropic } from "../src/llm/apiAdapters/anthropicMessages.js";
import { googleGenerativeAiAdapter } from "../src/llm/apiAdapters/googleGenerativeAi.js";

const baseContext: ModelStreamContext = {
  messages: [{ role: "user", content: "你好" } satisfies AgentMessage],
  tools: []
};

/** 捕获请求体的 fetch：body 拿到后返回一个最小 SSE 流，解析失败也无所谓。 */
function captureFetch(captured: { body?: Record<string, unknown> }): typeof globalThis.fetch {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    captured.body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  }) as typeof globalThis.fetch;
}

function makeRequest(captured: { body?: Record<string, unknown> }, provider = "openai"): ApiAdapterRequest {
  return {
    provider,
    modelId: "test-model",
    baseUrl: "https://example.test",
    fetch: captureFetch(captured)
  };
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  try {
    for await (const _ of iterable) { /* 只关心请求体 */ }
  } catch {
    // SSE 解析失败不影响 body 断言
  }
}

function testSchemaDefaults(): void {
  const parsed = chatParamsSchema.parse(undefined);
  assert.equal(parsed.temperature, undefined);
  assert.equal(parsed.maxOutputTokens, undefined);
  // 全量配置默认也不带聊天参数（不落盘、不下发）
  assert.equal(defaultConfig.chat.temperature, undefined);
  assert.equal(defaultConfig.chat.maxOutputTokens, undefined);
}

function testSchemaRoundTrip(): void {
  const config = configSchema.parse({
    ...defaultConfig,
    chat: { temperature: 0.7, maxOutputTokens: 2_048 }
  });
  assert.equal(config.chat.temperature, 0.7);
  assert.equal(config.chat.maxOutputTokens, 2_048);
}

function testSchemaRejectsOutOfRange(): void {
  assert.throws(() => configSchema.parse({ ...defaultConfig, chat: { temperature: 2.5 } }));
  assert.throws(() => configSchema.parse({ ...defaultConfig, chat: { temperature: -0.1 } }));
  assert.throws(() => configSchema.parse({ ...defaultConfig, chat: { maxOutputTokens: 100 } }));
  assert.throws(() => configSchema.parse({ ...defaultConfig, chat: { maxOutputTokens: 200_000 } }));
}

async function testOpenAiChatTemperature(): Promise<void> {
  const withTemp = { body: undefined } as { body?: Record<string, unknown> };
  const reqWithTemp = makeRequest(withTemp);
  await drain(streamOpenAi(reqWithTemp, reqWithTemp.fetch, baseContext, { temperature: 0.7 } satisfies ModelStreamOptions));
  assert.equal(withTemp.body?.temperature, 0.7);

  const withoutTemp = { body: undefined } as { body?: Record<string, unknown> };
  const reqWithoutTemp = makeRequest(withoutTemp);
  await drain(streamOpenAi(reqWithoutTemp, reqWithoutTemp.fetch, baseContext, {}));
  assert.equal("temperature" in (withoutTemp.body ?? {}), false);
}

async function testOpenAiResponsesCodexSkipsTemperature(): Promise<void> {
  const official = { body: undefined } as { body?: Record<string, unknown> };
  const reqOfficial = makeRequest(official, "openai");
  await drain(streamOpenAiResponses(reqOfficial, reqOfficial.fetch, baseContext, { temperature: 0.7 }));
  assert.equal(official.body?.temperature, 0.7);

  const codex = { body: undefined } as { body?: Record<string, unknown> };
  const reqCodex = makeRequest(codex, "openai-codex");
  await drain(streamOpenAiResponses(reqCodex, reqCodex.fetch, baseContext, { temperature: 0.7 }));
  assert.equal("temperature" in (codex.body ?? {}), false);
}

async function testAnthropicThinkingSuppressesTemperature(): Promise<void> {
  const thinkingOn = { body: undefined } as { body?: Record<string, unknown> };
  const reqOn = makeRequest(thinkingOn, "anthropic");
  await drain(streamAnthropic(reqOn, reqOn.fetch, baseContext, {
    temperature: 0.7,
    providerOptions: { anthropic: { thinking: { type: "enabled" } } }
  }));
  assert.equal("temperature" in (thinkingOn.body ?? {}), false);
  assert.equal((thinkingOn.body?.thinking as { type?: string } | undefined)?.type, "enabled");

  const thinkingOff = { body: undefined } as { body?: Record<string, unknown> };
  const reqOff = makeRequest(thinkingOff, "anthropic");
  await drain(streamAnthropic(reqOff, reqOff.fetch, baseContext, { temperature: 0.7 }));
  assert.equal(thinkingOff.body?.temperature, 0.7);
}

async function testGoogleTemperatureInGenerationConfig(): Promise<void> {
  const captured = { body: undefined } as { body?: Record<string, unknown> };
  await drain(googleGenerativeAiAdapter.stream(makeRequest(captured, "google"), baseContext, { temperature: 0.7 }));
  const generationConfig = captured.body?.generationConfig as { temperature?: number } | undefined;
  assert.equal(generationConfig?.temperature, 0.7);
}

const tests: Array<[string, () => void | Promise<void>]> = [
  ["schema 默认不下发聊天参数", testSchemaDefaults],
  ["schema 解析显式温度与输出上限", testSchemaRoundTrip],
  ["schema 拒绝越界温度与令牌数", testSchemaRejectsOutOfRange],
  ["openai chat 按配置透传/省略 temperature", testOpenAiChatTemperature],
  ["openai responses 官方下发、codex 抑制 temperature", testOpenAiResponsesCodexSkipsTemperature],
  ["anthropic 扩展思考开启时抑制 temperature", testAnthropicThinkingSuppressesTemperature],
  ["google 在 generationConfig 透传 temperature", testGoogleTemperatureInGenerationConfig]
];

for (const [name, fn] of tests) {
  await fn();
  console.log(`✔ ${name}`);
}
console.log("chat-params tests passed");

console.log("chat-params tests passed");
