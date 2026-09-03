import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HybridMemoryRetriever,
  memoryEntryContentHash,
  rankHybridMemory,
  type AutomaticMemoryStore,
  type MemoryVectorSearchIndex
} from "../src/agent/context/HybridMemoryRetriever.js";
import type { MemoryEntry, MemorySearchOptions, MemorySearchResult } from "../src/agent/context/memoryTypes.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

const currentWorkspaceId = "a".repeat(24);
const otherWorkspaceId = "b".repeat(24);

function testPureHybridRanking(): void {
  const current = memoryEntry("current", { kind: "workspace", workspaceId: currentWorkspaceId, workspaceName: "current" });
  const user = memoryEntry("user", { kind: "user" });
  const other = memoryEntry("other", { kind: "workspace", workspaceId: otherWorkspaceId, workspaceName: "other" });
  const semantic = rankHybridMemory({
    entries: [current, user, other],
    currentWorkspaceId,
    lexicalRankings: [[current.id, user.id, other.id]],
    vectorRanking: [
      { entryId: other.id, similarity: 0.9 },
      { entryId: current.id, similarity: 0.88 },
      { entryId: user.id, similarity: 0.87 }
    ],
    semanticAvailable: true,
    limit: 3,
    maxChars: 12_000
  });
  assert.deepEqual(semantic.matches.map(({ entry }) => entry.id), [current.id, user.id]);
  assert.deepEqual(semantic.report.origins.included, { user: 1, currentWorkspace: 1, otherWorkspaces: 0 });

  const filteredSemantic = rankHybridMemory({
    entries: [current, user, other],
    currentWorkspaceId,
    lexicalRankings: [[current.id, user.id, other.id]],
    vectorRanking: [{ entryId: other.id, similarity: 0.99 }],
    semanticAvailable: true,
    limit: 3,
    maxChars: 12_000
  });
  assert.deepEqual(new Set(filteredSemantic.matches.map(({ entry }) => entry.id)), new Set([current.id, user.id]),
    "过滤掉全部向量候选后必须回退到词法召回");

  const fallback = rankHybridMemory({
    entries: [current, user, other],
    currentWorkspaceId,
    lexicalRankings: [[other.id, current.id, user.id]],
    vectorRanking: [],
    semanticAvailable: false,
    limit: 3,
    maxChars: 12_000
  });
  assert.deepEqual(new Set(fallback.matches.map(({ entry }) => entry.id)), new Set([current.id, user.id]));
  assert.equal(fallback.matches.some(({ entry }) => entry.id === other.id), false);

}

function testWholeEntryBudget(): void {
  const entry = memoryEntry("large", { kind: "workspace", workspaceId: currentWorkspaceId, workspaceName: "current" }, "x".repeat(300));
  const result = rankHybridMemory({
    entries: [entry],
    currentWorkspaceId,
    lexicalRankings: [[entry.id]],
    vectorRanking: [],
    semanticAvailable: false,
    limit: 1,
    maxChars: 100
  });
  assert.equal(result.matches.length, 0);
  assert.equal(result.report.omitted[0]?.reason, "budget");
  assert.equal(result.report.budgetOmission?.maxChars, 100);
}

async function testLexicalFallbackAndRewrite(): Promise<void> {
  await withWorkspace(async (workspaceRoot) => {
    const current = memoryEntry("current", { kind: "workspace", workspaceId: workspaceId(workspaceRoot), workspaceName: "current" });
    const user = memoryEntry("user", { kind: "user" });
    const other = memoryEntry("other", { kind: "workspace", workspaceId: otherWorkspaceId, workspaceName: "other" });
    const store = new FakeMemoryStore([current, user, other]);
    const retriever = new HybridMemoryRetriever({
      localMemory: store,
      workspaceRoot,
      getEmbeddingRuntime: async () => undefined,
      getReadOnlyVectorIndex: () => undefined,
      getThresholds: (_fingerprint, recommended) => recommended,
    });
    const result = await retriever.retrieve("release workflow", [], { limit: 5 });
    assert.deepEqual(store.searches, ["release workflow"]);
    assert.deepEqual(new Set(result.matches.map(({ entry }) => entry.id)), new Set([current.id, user.id]));
    assert.equal(result.matches.some(({ entry }) => entry.id === other.id), false);
  });
}

async function testRewriteFailureUsesOriginalQuery(): Promise<void> {
  await withWorkspace(async (workspaceRoot) => {
    const current = memoryEntry("current", { kind: "workspace", workspaceId: workspaceId(workspaceRoot), workspaceName: "current" });
    const store = new FakeMemoryStore([current]);
    const retriever = new HybridMemoryRetriever({
      localMemory: store,
      workspaceRoot,
      getEmbeddingRuntime: async () => undefined,
      getReadOnlyVectorIndex: () => undefined,
      getThresholds: (_fingerprint, recommended) => recommended,
    });
    const result = await retriever.retrieve("original query", [], { limit: 1 });
    assert.deepEqual(store.searches, ["original query"]);
    assert.equal(result.matches[0]?.entry.id, current.id);
  });
}

async function testArchivedSearchFlagPropagates(): Promise<void> {
  await withWorkspace(async (workspaceRoot) => {
    const current = memoryEntry("current", { kind: "workspace", workspaceId: workspaceId(workspaceRoot), workspaceName: "current" });
    const store = new FakeMemoryStore([current]);
    const retriever = new HybridMemoryRetriever({
      localMemory: store,
      workspaceRoot,
      getEmbeddingRuntime: async () => undefined,
      getReadOnlyVectorIndex: () => undefined,
      getThresholds: (_fingerprint, recommended) => recommended
    });
    await retriever.retrieve("release", [], { limit: 1, includeArchived: true, automatic: false });
    assert.deepEqual(store.listArchivedFlags, [true]);
    assert.deepEqual(store.searchArchivedFlags, [true]);
  });
}

async function testFingerprintThresholdAndCrossWorkspaceGate(): Promise<void> {
  await withWorkspace(async (workspaceRoot) => {
    const current = memoryEntry("current", { kind: "workspace", workspaceId: workspaceId(workspaceRoot), workspaceName: "current" });
    const user = memoryEntry("user", { kind: "user" });
    const other = memoryEntry("other", { kind: "workspace", workspaceId: otherWorkspaceId, workspaceName: "other" });
    const store = new FakeMemoryStore([other, current, user]);
    const fingerprint = "active-fingerprint";
    const runtime: EmbeddingModelRuntime = {
      descriptor: {
        ref: { kind: "local", model: "multilingual-e5-small" },
        fingerprint,
        displayName: "test",
        dimensions: 2,
        recommendedThresholds: { currentWorkspace: 0.8, crossWorkspace: 0.86 },
        source: "local"
      },
      fingerprint,
      embed: async () => ({
        embeddings: [new Float32Array([1, 0])],
        dimensions: 2,
        fingerprint,
        model: { kind: "local", model: "multilingual-e5-small" }
      })
    };
    const index = new FakeVectorIndex(fingerprint, [
      { entryId: other.id, contentHash: memoryEntryContentHash(other), similarity: 0.85 },
      { entryId: current.id, contentHash: memoryEntryContentHash(current), similarity: 0.81 },
      { entryId: user.id, contentHash: memoryEntryContentHash(user), similarity: 0.82 }
    ]);
    let thresholdFingerprint: string | undefined;
    const retriever = new HybridMemoryRetriever({
      localMemory: store,
      workspaceRoot,
      getEmbeddingRuntime: async () => runtime,
      getReadOnlyVectorIndex: () => index,
      getThresholds: (resolvedFingerprint) => {
        thresholdFingerprint = resolvedFingerprint;
        return { currentWorkspace: 0.8, crossWorkspace: 0.86 };
      }
    });
    const result = await retriever.retrieve("release", [], { limit: 5 });
    assert.equal(thresholdFingerprint, fingerprint, "thresholds must be selected by the runtime fingerprint");
    assert.equal(result.matches.some(({ entry }) => entry.id === other.id), false, "lexical hits cannot bypass the cross-workspace vector threshold");
    assert.deepEqual(new Set(result.matches.map(({ entry }) => entry.id)), new Set([current.id, user.id]));

    await retriever.recordRecallUsage(result.matches.map(({ entry }) => entry.id), { now: new Date("2026-08-13T00:00:00.000Z") });
    assert.deepEqual(store.recalled, [current.id, user.id].sort());
    retriever.close();
    assert.equal(index.closed, true);
  });
}

class FakeMemoryStore implements AutomaticMemoryStore {
  readonly searches: string[] = [];
  readonly listArchivedFlags: Array<boolean | undefined> = [];
  readonly searchArchivedFlags: Array<boolean | undefined> = [];
  recalled: string[] = [];

  constructor(private readonly entries: MemoryEntry[]) {}

  async listMemoryEntries(options?: { includeArchived?: boolean }): Promise<{ entries: MemoryEntry[]; storeRevision: number }> {
    this.listArchivedFlags.push(options?.includeArchived);
    return { entries: this.entries, storeRevision: 7 };
  }

  async search(query: string, _paths: string[], options?: MemorySearchOptions): Promise<MemorySearchResult> {
    this.searches.push(query);
    this.searchArchivedFlags.push(options?.includeArchived);
    return {
      matches: this.entries.map((entry, index) => ({
        entry,
        topic: entry.topic,
        path: "memory://" + entry.id,
        excerpt: entry.summary,
        score: this.entries.length - index
      })),
      storeRevision: 7,
      report: {
        origins: { included: { user: 0, currentWorkspace: 0, otherWorkspaces: 0 }, trimmed: { user: 0, currentWorkspace: 0, otherWorkspaces: 0 } },
        omitted: []
      }
    };
  }

  async recordRecallUsage(ids: string[]): Promise<void> {
    this.recalled = [...ids].sort();
  }
}

class FakeVectorIndex implements MemoryVectorSearchIndex {
  closed = false;

  constructor(
    private readonly fingerprint: string,
    private readonly results: Array<{ entryId: string; contentHash: string; similarity: number }>
  ) {}

  status() {
    return {
      active: {
        generationId: "generation",
        modelFingerprint: this.fingerprint,
        dimensions: 2,
        vectorCount: this.results.length,
        createdAt: "2026-08-13T00:00:00.000Z",
        completedAt: "2026-08-13T00:00:01.000Z"
      },
      building: 0,
      failed: 0
    };
  }

  search(): Array<{ entryId: string; contentHash: string; similarity: number }> {
    return this.results;
  }

  close(): void {
    this.closed = true;
  }
}

function memoryEntry(id: string, origin: MemoryEntry["origin"], summary = `Durable memory summary for ${id}.`): MemoryEntry {
  return {
    id,
    origin,
    kind: origin.kind === "user" ? "working_style" : "workflow",
    topic: "release",
    title: `${id} title`,
    summary,
    decisions: [],
    paths: [],
    keywords: ["release"],
    importance: 3,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    revision: 1,
    lineage: [{ source: "explicit", externalContext: false, userEvidence: origin.kind === "user" ? "explicit" : undefined }],
    durability: "permanent",
    recallCount: 0,
    lastRecalledAt: undefined
  };
}

async function withWorkspace(operation: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-hybrid-memory-"));
  try {
    await operation(await realpath(workspaceRoot));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function workspaceId(workspaceRoot: string): string {
  // mkdtemp 返回的就是 canonical path；测试无需触发额外 I/O。
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 24);
}

testPureHybridRanking();
testWholeEntryBudget();
await testLexicalFallbackAndRewrite();
await testRewriteFailureUsesOriginalQuery();
await testArchivedSearchFlagPropagates();
await testFingerprintThresholdAndCrossWorkspaceGate();

console.log("hybrid memory retriever tests passed");
