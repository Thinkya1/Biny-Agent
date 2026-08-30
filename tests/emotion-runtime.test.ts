import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { EmotionStorage } from "../src/agent/context/emotionStorage.js";
import { spawnRuntimeHost, type SpawnedRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";

await testRuntimeHostUpdatesEmotion();
console.log("emotion runtime tests passed");

async function testRuntimeHostUpdatesEmotion(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-emotion-runtime-"));
  const agentDir = path.join(root, "agent");
  const configDir = path.join(root, "config");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  let provider: ProviderServer | undefined;
  let spawned: SpawnedRuntimeHost | undefined;
  process.env.BINY_AGENT_DIR = agentDir;

  try {
    provider = await startProviderServer();
    await saveConfig(root, testConfig(provider.endpoint), { globalDir: configDir });
    spawned = await spawnRuntimeHost(root, {
      workspaceRoot: root,
      configDir,
      resumeInterrupted: false,
      clientId: "emotion-runtime-test",
      surface: "cli"
    });

    const sessionId = spawned.client.getSnapshot().info.sessionId;
    const outcome = await withTimeout(
      spawned.client.submitPrompt("记录一次情绪变化，然后正常回复。", "chat").completion,
      15_000,
      "Runtime Host emotion completion"
    );
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    assert.equal(outcome.output, "情绪状态已更新。");
    assert.equal(provider.requestCount, 2, "the provider should receive the tool step and the final step");

    const storage = new EmotionStorage({ agentDir });
    const context = await storage.readContext(sessionId);
    assert.deepEqual(context && {
      mood: context.mood,
      valence: context.valence,
      energy: context.energy,
      trigger: context.trigger
    }, {
      mood: "专注",
      valence: 8,
      energy: 6,
      trigger: "完成一次 Host smoke"
    });

    await spawned.client.close();
    const events = await readSessionEvents(sessionFilePath(root, sessionId));
    assert.ok(events.some((event) => event.type === "tool_call" && event.tool === "update_emotion"));
    assert.ok(events.some((event) => event.type === "tool_result" && event.tool === "update_emotion"));
  } finally {
    await spawned?.client.close().catch(() => undefined);
    await stopHost(spawned?.process.pid);
    await provider?.close();
    restoreAgentDir(previousAgentDir);
    await rm(root, { recursive: true, force: true });
  }
}

interface ProviderServer {
  endpoint: string;
  requestCount: number;
  close(): Promise<void>;
}

async function startProviderServer(): Promise<ProviderServer> {
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    await drainRequest(request);
    requestCount += 1;
    if (requestCount === 1) sendEmotionToolCall(response);
    else sendProviderText(response, "情绪状态已更新。");
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Emotion provider did not bind a TCP port.");
  return {
    endpoint: `http://127.0.0.1:${String(address.port)}/v1`,
    get requestCount(): number { return requestCount; },
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

function testConfig(endpoint: string): AgentConfig {
  return configSchema.parse({
    ...defaultConfig,
    defaultModel: "local-test",
    providers: {
      local: {
        type: "openai-compatible",
        baseUrl: endpoint,
        requiresApiKey: false,
        retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 }
      }
    },
    models: {
      "local-test": {
        ...defaultConfig.models["deepseek-v4-flash"],
        provider: "local",
        model: "local-test",
        displayName: "Local Emotion Provider",
        capabilities: { tools: true, reasoning: false, streaming: true }
      }
    },
    permission: { ...defaultConfig.permission, mode: "full-access", criticalAlwaysAsk: false },
    context: {
      ...defaultConfig.context,
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
    }
  });
}

function sendEmotionToolCall(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "emotion-runtime-call", type: "function", function: { name: "update_emotion", arguments: JSON.stringify({ scope: "context", mood: "专注", valence: 8, energy: 6, trigger: "完成一次 Host smoke" }) } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
    "data: [DONE]\n\n"
  ].join(""));
}

function sendProviderText(response: ServerResponse, text: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n"
  ].join(""));
}

async function drainRequest(request: IncomingMessage): Promise<void> {
  for await (const _chunk of request) {
    // 读取完整请求体，确保 provider response 在客户端请求结束后再发送。
  }
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function stopHost(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Host 可能已经在优雅退出期间完成清理。
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${String(timeoutMs)}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function restoreAgentDir(previous: string | undefined): void {
  if (previous === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previous;
}
