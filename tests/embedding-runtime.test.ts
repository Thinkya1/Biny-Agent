import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderDefinition } from "../src/ai/types.js";
import { providerDefinition } from "../src/ai/provider.js";
import { MemoryEmbeddingService } from "../src/agent/context/MemoryEmbeddingService.js";
import { MemoryVectorIndex, memoryVectorContentHash } from "../src/agent/context/MemoryVectorIndex.js";
import type { LocalMemory } from "../src/agent/context/LocalMemory.js";
import type { MemoryEntry } from "../src/agent/context/memoryTypes.js";
import { configSchema, defaultConfig, type ProviderConfig } from "../src/config/schema.js";
import {
  type EmbeddingModelDescriptor,
  type EmbeddingModelRuntime,
  embeddingModelFingerprint,
  embeddingProviderEndpointHash,
  listProviderEmbeddingModels,
  LocalEmbeddingManager,
  normalizeEmbedding,
  ProviderEmbeddingRuntime
} from "../src/llm/embedding/index.js";

await testVectorValidation();
testExplicitProviderCapabilities();
testConfiguredEmbeddingCatalog();
await testOpenAiEmbeddingWire();
await testGoogleEmbeddingWire();
await testLocalEmbeddingLifecycle();
await testMemoryVectorGenerations();
await testMemoryVectorEntryStatesPersist();
await testMemoryEmbeddingServiceLifecycle();
await testUnsafeIndexFile();

console.log("embedding runtime tests passed");

function testVectorValidation(): void {
  const normalized = normalizeEmbedding([3, 4]);
  assert.ok(Math.abs(normalized[0]! - 0.6) < 1e-6);
  assert.ok(Math.abs(normalized[1]! - 0.8) < 1e-6);
  assert.throws(() => normalizeEmbedding([0, 0]), /positive finite norm/u);
  assert.throws(() => normalizeEmbedding([1, Number.NaN]), /non-finite/u);
  const endpointFingerprint = embeddingModelFingerprint({
      ref: { kind: "provider", provider: "example", model: "embed" },
      wire: "openai-compatible",
      endpoint: "https://first:secret@example.com/v1?token=secret"
    });
  assert.notEqual(
    endpointFingerprint,
    embeddingModelFingerprint({
      ref: { kind: "provider", provider: "example", model: "embed" },
      wire: "openai-compatible",
      endpoint: "https://example.com/v1"
    })
  );
  assert.equal(endpointFingerprint.includes("secret"), false);
}

function testExplicitProviderCapabilities(): void {
  assert.equal(providerDefinition("openai").embedding?.wire, "openai-compatible");
  assert.equal(providerDefinition("gemini").embedding?.wire, "openai-compatible");
  assert.equal(providerDefinition("gemini").embedding?.models[0]?.id, "gemini-embedding-001");
  assert.equal(providerDefinition("google-native").embedding?.wire, "google-generative-ai");
  assert.equal(providerDefinition("anthropic").embedding, undefined);
  assert.equal(providerDefinition("unregistered-provider").embedding, undefined);
}

function testConfiguredEmbeddingCatalog(): void {
  const config = configSchema.parse({
    ...structuredClone(defaultConfig),
    providers: {
      compatible: {
        type: "openai-compatible",
        baseUrl: "https://compatible.example/v1",
        apiKey: "test-secret",
        embeddingModels: [{
          id: "multilingual-custom",
          displayName: "Multilingual Custom",
          dimensions: 1_024,
          recommendedThresholds: { currentWorkspace: 0.4, crossWorkspace: 0.6 }
        }]
      }
    },
    models: {
      chat: { provider: "compatible", model: "chat-only-model" }
    },
    defaultModel: "chat"
  });
  const descriptors = listProviderEmbeddingModels(
    "compatible",
    config.providers.compatible!,
    providerDefinition("openai-compatible")
  );
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0]?.displayName, "Multilingual Custom");
  assert.equal(descriptors[0]?.dimensions, 1_024);
  assert.equal(descriptors[0]?.endpoint, "https://compatible.example/v1");
  assert.equal(
    descriptors[0]?.privacyEndpointHash,
    embeddingProviderEndpointHash("compatible", "https://compatible.example/v1")
  );
  assert.equal(descriptors.some((descriptor) => descriptor.ref.model === "chat-only-model"), false);
  assert.throws(() => new ProviderEmbeddingRuntime(
    "compatible",
    config.providers.compatible!,
    providerDefinition("openai-compatible"),
    "chat-only-model",
    { fetcher: async () => Response.json({ data: [] }) }
  ), /not explicitly declared/u);
  assert.throws(() => configSchema.parse({
    ...structuredClone(config),
    providers: {
      compatible: {
        ...config.providers.compatible,
        embeddingModels: [
          { id: "duplicate", displayName: "First" },
          { id: "duplicate", displayName: "Second" }
        ]
      }
    }
  }), /Duplicate embedding model id/u);
}

async function testOpenAiEmbeddingWire(): Promise<void> {
  let captured: { url: string; init?: RequestInit } | undefined;
  const runtime = new ProviderEmbeddingRuntime(
    "cloud",
    providerConfig("openai-compatible", "https://embeddings.example/v1", "secret"),
    embeddingDefinition("openai-compatible", 3),
    "embed-v1",
    {
      fetcher: async (input, init) => {
        captured = { url: String(input), init };
        return Response.json({
          data: [
            { index: 1, embedding: [0, 2, 0] },
            { index: 0, embedding: [3, 0, 0] }
          ]
        });
      }
    }
  );
  const result = await runtime.embed({ texts: ["first", "second"], inputType: "passage" });
  assert.equal(captured?.url, "https://embeddings.example/v1/embeddings");
  assert.equal(new Headers(captured?.init?.headers).get("authorization"), "Bearer secret");
  assert.deepEqual(JSON.parse(String(captured?.init?.body)), {
    model: "embed-v1",
    input: ["first", "second"],
    encoding_format: "float",
    dimensions: 3
  });
  assert.deepEqual([...result.embeddings[0]!], [1, 0, 0]);
  assert.deepEqual([...result.embeddings[1]!], [0, 1, 0]);

  const malformed = new ProviderEmbeddingRuntime(
    "cloud",
    providerConfig("openai-compatible", "https://embeddings.example/v1", "secret"),
    embeddingDefinition("openai-compatible", 3),
    "embed-v1",
    { fetcher: async () => Response.json({ data: [{ index: 0, embedding: [1, Number.NaN, 0] }] }) }
  );
  await assert.rejects(
    malformed.embed({ texts: ["bad"], inputType: "query" }),
    /non-finite/u
  );
}

async function testGoogleEmbeddingWire(): Promise<void> {
  const bodies: unknown[] = [];
  const runtime = new ProviderEmbeddingRuntime(
    "google",
    providerConfig("google-native", "https://generativelanguage.googleapis.com/v1beta", "google-secret"),
    embeddingDefinition("google-generative-ai", 3),
    "gemini-embedding-test",
    {
      fetcher: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ embedding: { values: [1, 1, 0] } });
      }
    }
  );
  const result = await runtime.embed({ texts: ["one", "two"], inputType: "query" });
  assert.equal(result.embeddings.length, 2);
  assert.equal((bodies[0] as { taskType?: unknown }).taskType, "RETRIEVAL_QUERY");
  assert.equal((bodies[0] as { outputDimensionality?: unknown }).outputDimensionality, 3);
}

async function testLocalEmbeddingLifecycle(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-local-embedding-"));
  let installed = false;
  let disposed = 0;
  let cleared = 0;
  const seenTexts: string[][] = [];
  const modelCache = path.join(root, "Xenova", "multilingual-e5-small", "761b726dd34fb83930e26aab4e9ac3899aa1fa78");
  const manager = new LocalEmbeddingManager(root, {
    moduleLoader: async () => ({
      pipeline: async (_task, _model, options) => {
        options.progress_callback?.({
          status: "progress_total",
          name: "model",
          progress: 50,
          loaded: 50,
          total: 100,
          files: {}
        });
        installed = true;
        const extractor = async (texts: string[]) => {
          seenTexts.push(texts);
          const data = new Float32Array(texts.length * 384);
          for (let row = 0; row < texts.length; row += 1) data[row * 384] = 1;
          return { data, dims: [texts.length, 384] };
        };
        extractor.dispose = async () => { disposed += 1; };
        return extractor;
      },
      ModelRegistry: {
        is_pipeline_cached: async () => installed,
        clear_pipeline_cache: async () => {
          installed = false;
          cleared += 1;
          await fs.rm(modelCache, { recursive: true, force: true });
          return { filesDeleted: 3 };
        }
      }
    })
  });
  try {
    const progress: number[] = [];
    await manager.download("multilingual-e5-small", { onProgress: (event) => {
      if (event.progress !== undefined) progress.push(event.progress);
    } });
    await fs.mkdir(modelCache, { recursive: true });
    await fs.writeFile(path.join(modelCache, "model.bin"), Buffer.alloc(100));
    assert.deepEqual(progress, [0, 0.5, 1]);
    assert.equal(disposed, 1);
    const runtime = await manager.createRuntime("multilingual-e5-small");
    const result = await runtime.embed({ texts: ["天气"], inputType: "query" });
    assert.equal(result.dimensions, 384);
    assert.deepEqual(seenTexts.at(-1), ["query: 天气"]);
    await assert.rejects(
      manager.remove("multilingual-e5-small", { activeModel: "multilingual-e5-small" }),
      /active embedding model/u
    );
    await manager.close();
    const removed = await manager.remove("multilingual-e5-small");
    assert.equal(cleared, 1);
    assert.equal(removed.bytesFreed, 100);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testMemoryVectorGenerations(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-vector-index-"));
  const index = new MemoryVectorIndex(root);
  try {
    const first = index.beginGeneration("model-one", 3, "generation-one");
    index.putVectors(first, [
      { entryId: "alpha", contentHash: memoryVectorContentHash("alpha"), embedding: [1, 0, 0] },
      { entryId: "beta", contentHash: memoryVectorContentHash("beta"), embedding: [0, 1, 0] }
    ]);
    assert.deepEqual(index.search([1, 0, 0], { modelFingerprint: "model-one" }), []);
    index.completeGeneration(first);
    assert.deepEqual(
      index.search([0.9, 0.1, 0], { modelFingerprint: "model-one", minimumSimilarity: 0.5 }).map((item) => item.entryId),
      ["alpha"]
    );

    const failed = index.beginGeneration("model-two", 3, "generation-failed");
    index.putVectors(failed, [{ entryId: "gamma", contentHash: memoryVectorContentHash("gamma"), embedding: [0, 0, 1] }]);
    index.failGeneration(failed, new Error("network unavailable"));
    assert.equal(index.status().active?.modelFingerprint, "model-one");
    assert.equal(index.upsertActiveVectors("model-two", []), false);
    assert.equal(index.upsertActiveVectors("model-one", [
      { entryId: "alpha", contentHash: memoryVectorContentHash("alpha-2"), embedding: [0, 0, 1] }
    ]), true);
    assert.equal(index.search([0, 0, 1], { modelFingerprint: "model-one" })[0]?.entryId, "alpha");

    index.recordRecall(["alpha", "alpha", "beta"], "2026-08-13T00:00:00.000Z");
    index.recordRecall(["alpha"], "2026-08-13T00:01:00.000Z");
    assert.deepEqual(index.usage(), [
      { entryId: "alpha", recallCount: 2, lastRecalledAt: "2026-08-13T00:01:00.000Z" },
      { entryId: "beta", recallCount: 1, lastRecalledAt: "2026-08-13T00:00:00.000Z" }
    ]);

    const second = index.beginGeneration("model-two", 2, "generation-two");
    index.putVectors(second, [{ entryId: "gamma", contentHash: memoryVectorContentHash("gamma"), embedding: [1, 1] }]);
    index.completeGeneration(second);
    assert.deepEqual(index.search([1, 0, 0], { modelFingerprint: "model-one" }), []);
    assert.equal(index.status().active?.vectorCount, 1);
  } finally {
    index.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testMemoryVectorEntryStatesPersist(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-vector-entry-states-"));
  const originalHash = memoryVectorContentHash("alpha-original");
  const updatedHash = memoryVectorContentHash("alpha-updated");
  const betaHash = memoryVectorContentHash("beta");
  let index = new MemoryVectorIndex(root);
  try {
    const generation = index.beginGeneration("model-persistent", 2, "generation-persistent");
    index.putVectors(generation, [
      { entryId: "alpha", contentHash: originalHash, embedding: [1, 0] },
      { entryId: "beta", contentHash: betaHash, embedding: [0, 1] }
    ]);
    index.completeGeneration(generation);
    index.markEntriesFailed(
      "model-persistent",
      [{ entryId: "alpha", contentHash: updatedHash }],
      new Error("provider unavailable")
    );
    index.markEntriesPending(
      "model-persistent",
      [{ entryId: "gamma", contentHash: memoryVectorContentHash("gamma") }]
    );
    assert.equal(index.status().active?.vectorCount, 1, "failed edit must invalidate the old indexed vector");
    assert.deepEqual(
      index.search([1, 0], { modelFingerprint: "model-persistent" }).map(({ entryId }) => entryId),
      ["beta"]
    );

    index.close();
    index = new MemoryVectorIndex(root);
    const states = index.entryStates("model-persistent", [
      { entryId: "alpha", contentHash: updatedHash },
      { entryId: "beta", contentHash: betaHash },
      { entryId: "gamma", contentHash: memoryVectorContentHash("gamma") }
    ]);
    assert.deepEqual(states.map(({ entryId, status }) => ({ entryId, status })), [
      { entryId: "alpha", status: "failed" },
      { entryId: "beta", status: "indexed" },
      { entryId: "gamma", status: "pending" }
    ]);
    assert.equal(states[0]?.error, "provider unavailable");
    assert.equal(index.status().active?.vectorCount, 1);

    const betaUpdatedHash = memoryVectorContentHash("beta-updated-after-crash");
    assert.equal(
      index.entryStates("model-persistent", [{ entryId: "beta", contentHash: betaUpdatedHash }])[0]?.status,
      "pending",
      "a content hash first seen after restart must be persisted as pending"
    );
    assert.equal(index.status().active?.vectorCount, 0);
    index.close();
    index = new MemoryVectorIndex(root);
    assert.equal(
      index.entryStates("model-persistent", [{ entryId: "beta", contentHash: betaUpdatedHash }])[0]?.status,
      "pending"
    );
  } finally {
    index.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testMemoryEmbeddingServiceLifecycle(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-memory-embedding-service-"));
  const descriptor: EmbeddingModelDescriptor = {
    ref: { kind: "local", model: "multilingual-e5-small" },
    fingerprint: "memory-service-test",
    displayName: "Memory service test",
    dimensions: 3,
    recommendedThresholds: { currentWorkspace: 0.8, crossWorkspace: 0.86 },
    source: "local",
    installed: true
  };
  const entries = [memoryEntry("alpha", "Alpha memory"), memoryEntry("beta", "Beta memory")];
  let vectorDimensions = 3;
  let embeddingFailure: Error | undefined;
  const runtime: EmbeddingModelRuntime = {
    descriptor,
    fingerprint: descriptor.fingerprint,
    embed: async ({ texts }) => {
      if (embeddingFailure) throw embeddingFailure;
      return {
        embeddings: texts.map((text) => {
          const vector = new Float32Array(vectorDimensions);
          vector[text.includes("updated") ? Math.min(2, vectorDimensions - 1) : text.includes("Beta") ? 1 : 0] = 1;
          return vector;
        }),
        dimensions: vectorDimensions,
        fingerprint: descriptor.fingerprint,
        model: descriptor.ref
      };
    }
  };
  let downloadSignal: AbortSignal | undefined;
  let activeModelPassedToRemove: string | undefined;
  const localManager = {
    list: async () => [{ descriptor, installed: true }],
    download: async (_model: string, options: { signal?: AbortSignal }) => {
      downloadSignal = options.signal;
      await new Promise<void>((resolve, reject) => {
        const aborted = (): void => reject(options.signal?.reason);
        options.signal?.addEventListener("abort", aborted, { once: true });
        if (options.signal?.aborted) aborted();
        void resolve;
      });
      return { descriptor, installed: true };
    },
    remove: async (_model: string, options: { activeModel?: string }) => {
      activeModelPassedToRemove = options.activeModel;
      if (options.activeModel) throw new Error("The active embedding model cannot be deleted.");
      return { filesDeleted: 1, bytesFreed: 10 };
    }
  } as unknown as LocalEmbeddingManager;
  const localMemory = {
    listMemoryEntries: async () => ({
      entries: [...entries],
      storeRevision: 1,
      revision: { global: 1, project: 1 }
    })
  } as unknown as LocalMemory;
  const service = new MemoryEmbeddingService({
    localMemory,
    localManager,
    getVectorIndex: () => new MemoryVectorIndex(root),
    getActiveModel: () => descriptor.ref,
    getProviderModels: () => [],
    getRuntime: async () => runtime
  });
  let restartedService: MemoryEmbeddingService | undefined;
  try {
    await service.rebuild();
    const rebuilt = await service.status();
    assert.equal(rebuilt.index.active?.modelFingerprint, descriptor.fingerprint);
    assert.equal(rebuilt.indexedEntries, 2);
    assert.equal(rebuilt.pendingEntries, 0);
    assert.equal(rebuilt.operation?.kind, "rebuild");
    assert.equal(rebuilt.operation?.state, "completed");

    embeddingFailure = new Error("injected rebuild failure");
    await assert.rejects(service.rebuild(), /injected rebuild failure/u);
    const preserved = await service.status();
    assert.equal(preserved.index.active?.modelFingerprint, descriptor.fingerprint);
    assert.equal(preserved.indexedEntries, 2, "failed same-model rebuild must retain the old active generation");
    assert.equal(preserved.failedEntries, 0);
    assert.equal(
      service.vectorIndex().search([1, 0, 0], { modelFingerprint: descriptor.fingerprint })[0]?.entryId,
      "alpha",
      "old active vectors remain searchable until a new generation is atomically activated"
    );
    embeddingFailure = undefined;

    entries[0] = { ...entries[0]!, summary: "Alpha updated memory", revision: 2 };
    await service.indexEntry(entries[0]);
    assert.equal(
      service.vectorIndex().search([0, 0, 1], { modelFingerprint: descriptor.fingerprint })[0]?.entryId,
      "alpha"
    );

    vectorDimensions = 2;
    await service.indexEntry(entries[0]);
    const failed = await service.status();
    assert.equal(failed.indexedEntries, 1);
    assert.equal(failed.pendingEntries, 0);
    assert.equal(failed.failedEntries, 1, "dimension mismatch must stay retryable instead of rolling back Markdown");
    assert.equal(
      service.vectorIndex().search([1, 0, 0], { modelFingerprint: descriptor.fingerprint }).some(({ entryId }) => entryId === "alpha"),
      false,
      "the stale vector must be excluded after an incremental indexing failure"
    );

    service.close();
    restartedService = new MemoryEmbeddingService({
      localMemory,
      localManager,
      getVectorIndex: () => new MemoryVectorIndex(root),
      getActiveModel: () => descriptor.ref,
      getProviderModels: () => [],
      getRuntime: async () => runtime
    });
    const persisted = await restartedService.status();
    assert.equal(persisted.indexedEntries, 1);
    assert.equal(persisted.pendingEntries, 0);
    assert.equal(persisted.failedEntries, 1, "failed entry state must survive service restart");

    vectorDimensions = 3;
    await restartedService.rebuild();
    assert.equal((await restartedService.status()).failedEntries, 0);

    entries.splice(1, 1);
    restartedService.removeEntries(["beta"]);
    assert.equal(restartedService.vectorIndex().status().active?.vectorCount, 1);

    const downloading = restartedService.download("multilingual-e5-small");
    assert.ok(downloadSignal);
    assert.equal(restartedService.cancelDownload("multilingual-e5-small"), true);
    await assert.rejects(downloading, /cancel/u);
    assert.equal((await restartedService.status()).operation?.state, "cancelled");

    await assert.rejects(restartedService.removeLocalModel("multilingual-e5-small"), /active embedding model/u);
    assert.equal(activeModelPassedToRemove, "multilingual-e5-small");
  } finally {
    restartedService?.close();
    service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testUnsafeIndexFile(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-vector-symlink-"));
  const target = path.join(root, "target.sqlite");
  await fs.writeFile(target, "not sqlite");
  await fs.symlink(target, path.join(root, ".memory-index.sqlite"));
  try {
    assert.throws(() => new MemoryVectorIndex(root), /regular file/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function providerConfig(type: string, baseUrl: string, apiKey: string): ProviderConfig {
  return { type, baseUrl, apiKey };
}

function embeddingDefinition(
  wire: "openai-compatible" | "google-generative-ai",
  dimensions: number
): ProviderDefinition {
  return {
    type: "test-provider",
    protocol: "openai-compatible",
    baseUrl: "https://unused.example/v1",
    requiresApiKey: true,
    authModes: ["api-key"],
    embedding: {
      wire,
      models: [{
        id: wire === "google-generative-ai" ? "gemini-embedding-test" : "embed-v1",
        displayName: "Embedding Test",
        dimensions,
        recommendedThresholds: { currentWorkspace: 0.3, crossWorkspace: 0.5 }
      }]
    }
  };
}

function memoryEntry(id: string, summary: string): MemoryEntry {
  return {
    id,
    origin: { kind: "workspace", workspaceId: "0123456789abcdef01234567", workspaceName: "workspace" },
    scope: "project",
    kind: "fact",
    topic: "embedding",
    title: `${id} title`,
    summary,
    decisions: [],
    paths: [],
    keywords: [id],
    importance: 3,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    revision: 1,
    lineage: [{ source: "explicit", externalContext: false }],
    recallCount: 0,
    lastRecalledAt: undefined
  };
}
