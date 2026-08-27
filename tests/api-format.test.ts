import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fetchModelCatalogSnapshot, parseModelCatalog } from "../src/ai/modelCatalog.js";
import { providerDefinition } from "../src/ai/provider.js";
import type { CatalogProviderRequest } from "../src/ai/types.js";
import { apiFormatForConnection, apiFormatOption, apiFormatOptions } from "../src/desktop/renderer/src/providerCatalog.js";
import { createFileConfigStore } from "../src/config/store.js";
import { defaultConfig } from "../src/config/schema.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";

// ---------- 渲染层：格式选项与回显折回 ----------

test("apiFormatOptions: 四种格式各自绑定 (protocol, apiBackend) 对", () => {
  const byId = new Map(apiFormatOptions.map((option) => [option.id, option]));
  assert.equal(apiFormatOptions.length, 4);
  assert.equal(byId.get("chat_completions")?.protocol, "openai-compatible");
  assert.equal(byId.get("chat_completions")?.apiBackend, "chat_completions");
  assert.equal(byId.get("responses")?.apiBackend, "responses");
  assert.equal(byId.get("anthropic_messages")?.protocol, "anthropic");
  assert.equal(byId.get("anthropic_messages")?.apiBackend, "anthropic_messages");
  assert.equal(byId.get("google_generative_ai")?.apiBackend, "google_generative_ai");
  // Gemini 格式带官方默认端点，其余格式靠用户填中转地址。
  assert.equal(byId.get("google_generative_ai")?.defaultBaseUrl, "https://generativelanguage.googleapis.com/v1beta");
  assert.equal(byId.get("chat_completions")?.defaultBaseUrl, undefined);
});

test("apiFormatForConnection: apiBackend 优先，老配置按 protocol 折回", () => {
  assert.equal(apiFormatForConnection("openai-compatible", "responses"), "responses");
  assert.equal(apiFormatForConnection("openai-compatible", "google_generative_ai"), "google_generative_ai");
  assert.equal(apiFormatForConnection("openai-compatible", "anthropic_messages"), "anthropic_messages");
  // 老的 anthropic 连接只存了 protocol，没有 apiBackend，也要回显成 Anthropic Messages。
  assert.equal(apiFormatForConnection("anthropic", undefined), "anthropic_messages");
  assert.equal(apiFormatForConnection("openai-compatible", undefined), "chat_completions");
  assert.equal(apiFormatForConnection("openai-compatible", "chat_completions"), "chat_completions");
  // 未知格式 id 兜底到 chat_completions。
  assert.equal(apiFormatOption("nonsense" as never).id, "chat_completions");
});

// ---------- 主进程：目录拉取的鉴权与 id 形状 ----------

test("parseModelCatalog: 从 name 取 id 时剥掉 models/ 资源前缀", () => {
  const entries = parseModelCatalog(
    {
      data: [
        { id: "gpt-4o" },
        { name: "models/gemini-2.5-pro" },
        { id: "models/claude-x", name: "models/claude-x" },
        { other: true }
      ]
    },
    "test",
    "openai-compatible"
  );
  // 有显式 id 时原样保留（id 本来就应是请求用形状）；只有 name 时剥前缀。
  assert.deepEqual(entries.map((entry) => entry.id), ["gpt-4o", "gemini-2.5-pro", "models/claude-x"]);
});

function catalogRequest(apiBackend?: string): CatalogProviderRequest {
  return {
    alias: "custom",
    config: {
      type: "openai-compatible",
      baseUrl: "https://gateway.example/v1beta",
      apiKey: "test-key",
      ...(apiBackend ? { apiBackend } : {})
    },
    definition: providerDefinition("openai-compatible")
  };
}

test("fetchModelCatalogSnapshot: google_generative_ai 用 x-goog-api-key，默认走 Bearer", async () => {
  const seen: Array<{ url: string; auth?: string; goog?: string }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url: String(input), auth: headers.Authorization, goog: headers["x-goog-api-key"] });
    return new Response(JSON.stringify({ data: [{ name: "models/gemini-2.5-pro" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const google = await fetchModelCatalogSnapshot(catalogRequest("google_generative_ai"), undefined, {}, fetcher);
  assert.equal(seen[0]?.goog, "test-key");
  assert.equal(seen[0]?.auth, undefined);
  assert.equal(seen[0]?.url, "https://gateway.example/v1beta/models");
  // 目录里的资源名剥掉 models/ 前缀后才是可请求的模型 id。
  assert.deepEqual(google.models?.map((model) => model.id), ["gemini-2.5-pro"]);

  seen.length = 0;
  await fetchModelCatalogSnapshot(catalogRequest(), undefined, {}, fetcher);
  assert.equal(seen[0]?.auth, "Bearer test-key");
  assert.equal(seen[0]?.goog, undefined);
});

// ---------- 桌面端：连接回显携带 apiBackend ----------

test("workspaceSnapshot connections 携带 apiBackend（provider 级优先，老配置从模型折回）", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "biny-api-format-data-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-api-format-workspace-"));
  try {
    const storage = new DesktopUserDataStore(dataRoot);
    await storage.initialize();
    const state = new DesktopStateStore(path.join(dataRoot, "desktop-state.json"));
    await state.load();
    const credentials = new Map<string, string>();
    const configStore = createFileConfigStore(dataRoot, {
      globalDir: dataRoot,
      credentialStore: {
        persistent: true,
        get: async (account) => credentials.get(account),
        set: async (account, value) => { credentials.set(account, value); },
        delete: async (account) => { credentials.delete(account); }
      }
    });
    await configStore.save({
      ...defaultConfig,
      defaultModel: "gemini-pro",
      providers: {
        gemini: {
          type: "openai-compatible",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "g-key",
          apiBackend: "google_generative_ai"
        },
        legacy: {
          type: "openai-compatible",
          baseUrl: "https://legacy.example/v1",
          apiKey: "l-key"
        }
      },
      models: {
        "gemini-pro": { provider: "gemini", model: "gemini-2.5-pro" },
        "legacy-claude": { provider: "legacy", model: "claude-sonnet", apiBackend: "anthropic_messages" }
      }
    });
    const projects = new DesktopProjectService(state, storage, configStore);
    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const project = await projects.createProject(workspaceRoot);
    const snapshot = await agents.workspaceSnapshot(project.id);
    const gemini = snapshot.connections.find((connection) => connection.providerAlias === "gemini");
    const legacy = snapshot.connections.find((connection) => connection.providerAlias === "legacy");
    assert.equal(gemini?.apiBackend, "google_generative_ai");
    // legacy 连接自身没存 apiBackend，从它名下模型的 apiBackend 折回，保证回显不丢。
    assert.equal(legacy?.apiBackend, "anthropic_messages");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
