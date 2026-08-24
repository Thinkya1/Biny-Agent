import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentModel } from "../src/agent/core/types.js";
import {
  LocalMemory,
  MemoryRevisionConflictError,
  type MemoryEntryInput
} from "../src/agent/context/LocalMemory.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { createStoredMemoryEntry, renderMemoryEntry } from "../src/agent/context/memoryFormat.js";
import { BINY_AGENT_DIR_ENV, projectMemoryDir } from "../src/config/paths.js";

async function main(): Promise<void> {
  await testSingleStoreCasOriginAndEdit();
  await testSharedLibraryAndLexicalFallbackBoundary();
  await testBoundedIndexConcurrentCasAndUsageProjection();
  await testV2ScopeMigrationIsLosslessAndIdempotent();
  await testV2MigrationResumesFromDurableOffset();
  await testCandidateOriginEligibilityAndRedaction();
  await testSingleRootSafetyBoundary();
  console.log("memory v3 tests passed");
}

async function testSingleStoreCasOriginAndEdit(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const overview = await memory.getOverview();
    assert.equal(overview.storeRevision, 0);
    assert.deepEqual(overview.origins, { user: 0, currentWorkspace: 0, otherWorkspaces: 0 });

    const universal = await memory.writeEntry({
      audience: "universal",
      kind: "working_style",
      topic: "working-style",
      title: "Concise updates",
      summary: "The user explicitly prefers concise progress updates during long coding tasks.",
      importance: 5,
      lineage: {
        source: "explicit",
        externalContext: false,
        userEvidence: "Please keep progress updates concise."
      }
    }, { expectedRevision: 0, now: new Date("2026-08-01T00:00:00.000Z") });
    assert.equal(universal.entry?.origin.kind, "user");
    assert.equal(universal.revision, 1);

    const workspace = await memory.writeEntry(projectEntry(
      "Weather source",
      "Use src/weather.ts for deterministic weather requests."
    ), { expectedRevision: 1, now: new Date("2026-08-01T01:00:00.000Z") });
    assert.equal(workspace.entry?.origin.kind, "workspace");
    assert.equal(workspace.revision, 2, "user and workspace writes must share one revision");

    await assert.rejects(memory.writeEntry(projectEntry(
      "Stale write",
      "This stale single-store CAS write must not overwrite newer entries."
    ), { expectedRevision: 1 }), MemoryRevisionConflictError);

    await assert.rejects(memory.writeEntry({
      audience: "universal",
      kind: "decision",
      topic: "decisions",
      title: "Repository decision",
      summary: "Use src/weather.ts as this repository's weather entry point.",
      paths: ["src/weather.ts"],
      lineage: { source: "explicit", externalContext: false, userEvidence: "Use src/weather.ts." }
    }, { expectedRevision: 2 }), /Universal memory|Project paths and decisions|Global memory/u);

    const created = workspace.entry;
    assert.ok(created);
    const updated = await memory.updateEntry(created.id, {
      title: "Deterministic weather source",
      summary: "Use src/weather.ts as the deterministic weather request entry point.",
      importance: 4
    }, { expectedRevision: 2, now: new Date("2026-08-02T00:00:00.000Z") });
    assert.equal(updated.entry?.id, created.id);
    assert.equal(updated.entry?.createdAt, created.createdAt);
    assert.deepEqual(updated.entry?.origin, created.origin);
    assert.equal(updated.entry?.lineage.at(-1)?.source, "explicit_edit");
    assert.equal(updated.revision, 3);

    const entriesDirectory = path.join(agentRoot, "memory", "entries");
    const files = (await fs.readdir(entriesDirectory)).filter((file) => file.endsWith(".md"));
    assert.equal(files.length, 2);
    const contents = await Promise.all(files.map(async (file) => await fs.readFile(path.join(entriesDirectory, file), "utf8")));
    assert.equal(contents.every((content) => /^---\nversion: 3\n/u.test(content)), true);
    assert.equal(contents.some((content) => /origin:\n {2}kind: user/u.test(content)), true);
    assert.equal(contents.some((content) => /workspaceId: [a-f0-9]{24}/u.test(content)), true);
    assert.equal(contents.some((content) => content.includes(path.resolve(workspaceRoot))), false, "origin must not persist an absolute workspace path");
    const index = await fs.readFile(path.join(agentRoot, "memory", "MEMORY.md"), "utf8");
    assert.match(index, /\]\(entries\//u);
  });
}

async function testSharedLibraryAndLexicalFallbackBoundary(): Promise<void> {
  await withSharedAgent(async (agentRoot) => {
    const firstWorkspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-first-"));
    const secondWorkspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-second-"));
    try {
      const first = new LocalMemory(firstWorkspace, unusedModel);
      await first.writeEntry({
        ...projectEntry("Release workflow", "Run pnpm test before publishing the first workspace."),
        topic: "release",
        keywords: ["release", "publish"]
      }, { expectedRevision: 0 });

      const second = new LocalMemory(secondWorkspace, unusedModel);
      const overview = await second.getOverview();
      assert.equal(overview.entryCount, 1);
      assert.deepEqual(overview.origins, { user: 0, currentWorkspace: 0, otherWorkspaces: 1 });
      assert.equal((await second.listMemoryEntries({ origins: ["other_workspaces"] })).entries.length, 1);
      assert.equal((await second.search("release publish", [], { origins: ["all"] })).matches.length, 1, "manual all-origin search can inspect shared memory");
      assert.equal((await second.search("release publish", [], { origins: ["user", "current_workspace"] })).matches.length, 0, "lexical fallback must not auto-inject another workspace");

      const own = await second.writeEntry({
        ...projectEntry("Second release", "Run typecheck before publishing the second workspace."),
        topic: "release",
        keywords: ["release", "publish"]
      }, { expectedRevision: overview.storeRevision });
      assert.equal(own.revision, 2);
      const filtered = await second.search("release publish", [], { origins: ["user", "current_workspace"] });
      assert.equal(filtered.matches.length, 1);
      assert.equal(filtered.matches[0]?.entry.origin.kind, "workspace");
      assert.equal((filtered.matches[0]?.entry.origin as { workspaceName?: string }).workspaceName, path.basename(secondWorkspace));
      assert.equal(await fs.realpath(path.join(agentRoot, "memory")), path.join(await fs.realpath(agentRoot), "memory"));
    } finally {
      await rm(firstWorkspace, { recursive: true, force: true });
      await rm(secondWorkspace, { recursive: true, force: true });
    }
  });
}

async function testBoundedIndexConcurrentCasAndUsageProjection(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const storage = new MemoryStorage(workspaceRoot, { maxIndexChars: 1_024 });
    let revision = 0;
    for (let index = 0; index < 18; index += 1) {
      revision = (await storage.writeEntry(projectEntry(
        `Long indexed title ${String(index)} ${"x".repeat(70)}`,
        `Durable indexed summary ${String(index)} ${"content ".repeat(20)}`
      ), { expectedRevision: revision })).revision;
    }
    const index = await storage.readIndex();
    assert.ok(index);
    assert.ok(index.length <= 1_024);
    assert.match(index, /omitted from this bounded index/u);

    const concurrent = await Promise.allSettled([
      storage.writeEntry(projectEntry("Concurrent A", "Concurrent A must win or conflict without overwriting another writer."), { expectedRevision: revision }),
      storage.writeEntry(projectEntry("Concurrent B", "Concurrent B must win or conflict without overwriting another writer."), { expectedRevision: revision })
    ]);
    assert.equal(concurrent.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(concurrent.some((result) => result.status === "rejected" && result.reason instanceof MemoryRevisionConflictError), true);

    const entry = (await storage.listEntries({ origins: ["current_workspace"] })).entries[0];
    assert.ok(entry);
    const beforeRevision = (await storage.getOverview()).storeRevision;
    await storage.recordInjectedRecall([entry.id, entry.id], { now: new Date("2026-08-03T00:00:00.000Z") });
    const recalled = (await storage.listEntries({ origins: ["current_workspace"] })).entries.find(({ id }) => id === entry.id);
    assert.equal(recalled?.recallCount, 1, "one injection call counts an id once");
    assert.equal(recalled?.lastRecalledAt, "2026-08-03T00:00:00.000Z");
    assert.equal((await storage.getOverview()).storeRevision, beforeRevision, "derived usage must not advance content revision");
    const markdown = await fs.readFile(path.join(agentRoot, "memory", "entries", `${entry.topic}.md`), "utf8");
    assert.doesNotMatch(markdown, /recallCount|lastRecalledAt/u);
  });
}

async function testV2ScopeMigrationIsLosslessAndIdempotent(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const projectDirectory = projectMemoryDir(await fs.realpath(workspaceRoot));
    const globalDirectory = path.join(agentRoot, "memory", "global");
    await fs.mkdir(path.join(projectDirectory, "entries"), { recursive: true });
    await fs.mkdir(path.join(projectDirectory, ".candidates"), { recursive: true });
    await fs.mkdir(path.join(globalDirectory, "entries"), { recursive: true });
    const duplicateId = "11111111-1111-4111-8111-111111111111";
    const projectV2 = legacyV2Entry(duplicateId, "project", "workflow", "Project workflow", "The project uses a durable release workflow with focused tests.");
    const globalV2 = legacyV2Entry(duplicateId, "global", "working_style", "Concise replies", "The user explicitly prefers concise replies with the result first.", "Please keep replies concise.");
    const sameOriginEntryId = "66666666-6666-4666-8666-666666666666";
    const sameOriginEntrySummary = "Two legacy entries share their visible identity but preserve different structured facts.";
    const firstStructuredEntry = legacyV2Entry(
      sameOriginEntryId,
      "project",
      "decision",
      "Structured collision",
      sameOriginEntrySummary
    ).replace("decisions: []", "decisions:\n  - Keep the first decision");
    const secondStructuredEntry = legacyV2Entry(
      sameOriginEntryId,
      "project",
      "decision",
      "Structured collision",
      sameOriginEntrySummary
    ).replace("decisions: []", "decisions:\n  - Keep the second decision")
      .replace("paths: []", "paths:\n  - src/second.ts")
      .replace("keywords: []", "keywords:\n  - second");
    const candidateV2 = JSON.stringify({
      version: 2,
      id: "22222222-2222-4222-8222-222222222222",
      summary: "Completed root turn established a durable workspace workflow.",
      completed: true,
      lineage: { source: "completed_task", sessionId: "s", turnId: "t", runId: "r", externalContext: false },
      scopeHint: "project",
      kindHint: "workflow",
      createdAt: "2026-08-01T00:00:00.000Z",
      eligibleAt: "2026-08-01T06:00:00.000Z",
      revision: 1
    }, null, 2) + "\n";
    const sameCandidateId = "77777777-7777-4777-8777-777777777777";
    const sameCandidateSummary = "Candidates sharing their old identity retain every normalized source field.";
    const firstStructuredCandidate = legacyV2Candidate(sameCandidateId, sameCandidateSummary);
    const secondStructuredCandidate = `${JSON.stringify({
      ...JSON.parse(firstStructuredCandidate) as Record<string, unknown>,
      lineage: {
        source: "completed_task",
        sessionId: "session",
        turnId: sameCandidateId,
        runId: sameCandidateId,
        externalContext: true
      },
      kindHint: "gotcha",
      eligibleAt: "2026-08-01T07:00:00.000Z"
    }, null, 2)}\n`;
    await fs.writeFile(path.join(projectDirectory, "entries", "workflow.md"), projectV2, "utf8");
    await fs.writeFile(path.join(projectDirectory, "entries", "structured-a.md"), firstStructuredEntry, "utf8");
    await fs.writeFile(path.join(projectDirectory, "entries", "structured-b.md"), secondStructuredEntry, "utf8");
    await fs.writeFile(path.join(globalDirectory, "entries", "working-style.md"), globalV2, "utf8");
    await fs.writeFile(path.join(projectDirectory, ".candidates", "candidate.json"), candidateV2, "utf8");
    await fs.writeFile(path.join(projectDirectory, ".candidates", "structured-a.json"), firstStructuredCandidate, "utf8");
    await fs.writeFile(path.join(projectDirectory, ".candidates", "structured-b.json"), secondStructuredCandidate, "utf8");

    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const first = await memory.listMemoryEntries({ origins: ["all"] });
    assert.equal(first.entries.length, 4);
    assert.equal(new Set(first.entries.map(({ id }) => id)).size, 4, "cross-origin and same-origin id collisions must be resolved deterministically");
    assert.equal(first.entries.some(({ origin }) => origin.kind === "user"), true);
    assert.equal(first.entries.some(({ origin }) => origin.kind === "workspace"), true);
    const structuredEntries = first.entries.filter(({ title }) => title === "Structured collision");
    assert.equal(structuredEntries.length, 2, "different decisions/paths/keywords under one legacy id must both survive");
    assert.deepEqual(new Set(structuredEntries.flatMap(({ decisions }) => decisions)), new Set(["Keep the first decision", "Keep the second decision"]));
    assert.equal(structuredEntries.some(({ paths }) => paths.includes("src/second.ts")), true);
    const migratedCandidates = (await memory.scanEligibleCandidates({ now: new Date("2026-08-02T00:00:00.000Z") })).candidates;
    assert.equal(migratedCandidates.length, 3);
    assert.equal(new Set(migratedCandidates.map(({ id }) => id)).size, 3);
    const structuredCandidates = migratedCandidates.filter(({ summary }) => summary === sameCandidateSummary);
    assert.equal(structuredCandidates.length, 2, "candidate externalContext/kind/time differences must not be silently deduplicated");
    assert.equal(structuredCandidates.some(({ lineage }) => lineage.externalContext), true);
    assert.equal(structuredCandidates.some(({ kindHint }) => kindHint === "gotcha"), true);
    assert.equal(migratedCandidates[0]?.origin.kind, "workspace");
    assert.equal(await fs.readFile(path.join(projectDirectory, "entries", "workflow.md"), "utf8"), projectV2);
    assert.equal(await fs.readFile(path.join(globalDirectory, "entries", "working-style.md"), "utf8"), globalV2);
    assert.equal(await fs.readFile(path.join(projectDirectory, ".candidates", "candidate.json"), "utf8"), candidateV2);
    assert.equal(await fs.readFile(path.join(projectDirectory, "entries", "structured-a.md"), "utf8"), firstStructuredEntry);
    assert.equal(await fs.readFile(path.join(projectDirectory, "entries", "structured-b.md"), "utf8"), secondStructuredEntry);
    assert.equal(await fs.readFile(path.join(projectDirectory, ".candidates", "structured-a.json"), "utf8"), firstStructuredCandidate);
    assert.equal(await fs.readFile(path.join(projectDirectory, ".candidates", "structured-b.json"), "utf8"), secondStructuredCandidate);
    assert.equal((await fs.readdir(path.join(agentRoot, "memory"))).includes("global"), true, "legacy directories remain as cold backup");
    assert.equal((await fs.readdir(path.join(agentRoot, "memory"))).includes(path.basename(projectDirectory)), true);
    assert.equal((await fs.readdir(path.join(agentRoot, "memory"))).includes(".migration-v2.json"), false);
    const state = JSON.parse(await fs.readFile(path.join(agentRoot, "memory", ".memory-state.json"), "utf8")) as { version: number; migratedV2At?: string };
    assert.equal(state.version, 3);
    assert.ok(state.migratedV2At);

    const second = await new LocalMemory(workspaceRoot, unusedModel).listMemoryEntries({ origins: ["all"] });
    assert.deepEqual(second.entries.map(({ id }) => id).sort(), first.entries.map(({ id }) => id).sort());
    assert.equal(second.storeRevision, first.storeRevision);
  });
}

async function testV2MigrationResumesFromDurableOffset(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const canonicalWorkspace = await fs.realpath(workspaceRoot);
    const sourceDirectory = projectMemoryDir(canonicalWorkspace);
    const sourceName = path.basename(sourceDirectory);
    const memoryRoot = path.join(agentRoot, "memory");
    await fs.mkdir(path.join(sourceDirectory, "entries"), { recursive: true });
    await fs.mkdir(path.join(sourceDirectory, ".candidates"), { recursive: true });
    await fs.mkdir(path.join(memoryRoot, "entries"), { recursive: true });
    await fs.mkdir(path.join(memoryRoot, ".candidates"), { recursive: true });

    const entryId = "33333333-3333-4333-8333-333333333333";
    const entryContent = legacyV2Entry(
      entryId,
      "project",
      "workflow",
      "Resumable migration",
      "The memory migration resumes from a durable offset after an interrupted copy."
    );
    await fs.writeFile(path.join(sourceDirectory, "entries", "resume.md"), entryContent, "utf8");

    const firstCandidate = legacyV2Candidate(
      "44444444-4444-4444-8444-444444444444",
      "The first migrated candidate was durably copied before the interruption."
    );
    const secondCandidate = legacyV2Candidate(
      "55555555-5555-4555-8555-555555555555",
      "The second migrated candidate must be copied after resuming from offset one."
    );
    await fs.writeFile(path.join(sourceDirectory, ".candidates", "a.json"), firstCandidate, "utf8");
    await fs.writeFile(path.join(sourceDirectory, ".candidates", "b.json"), secondCandidate, "utf8");

    const origin = {
      kind: "workspace" as const,
      workspaceId: createHash("sha256").update(canonicalWorkspace).digest("hex").slice(0, 24),
      workspaceName: path.basename(canonicalWorkspace)
    };
    const migratedEntry = createStoredMemoryEntry({
      origin,
      kind: "workflow",
      topic: "project",
      title: "Resumable migration",
      summary: "The memory migration resumes from a durable offset after an interrupted copy.",
      decisions: [],
      paths: [],
      keywords: [],
      importance: 3,
      lineage: [
        { source: "explicit", externalContext: false },
        { source: "migration", externalContext: false, sourceEntryIds: [entryId], legacyPath: `${sourceName}/entries/resume.md` }
      ]
    }, {
      id: entryId,
      revision: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z"
    });
    await fs.writeFile(path.join(memoryRoot, "entries", "project-resume.md"), renderMemoryEntry(migratedEntry), "utf8");
    await fs.writeFile(path.join(memoryRoot, ".migration-v2.json"), `${JSON.stringify({
      version: 3,
      status: "copying",
      sourceDirectories: [sourceName],
      sourceIndex: 0,
      phase: "candidates",
      offset: 1,
      updatedAt: "2026-08-02T00:00:00.000Z"
    }, null, 2)}\n`, "utf8");

    await assert.rejects(
      new LocalMemory(workspaceRoot, unusedModel).listMemoryEntries({ origins: ["all"] }),
      /progress references a missing candidate/u
    );
    await fs.writeFile(path.join(memoryRoot, ".candidates", "44444444-4444-4444-8444-444444444444.json"), `${JSON.stringify({
      ...JSON.parse(firstCandidate) as Record<string, unknown>,
      version: 3,
      origin,
      audienceHint: "workspace",
      revision: 1
    }, null, 2)}\n`, "utf8");

    const memory = new LocalMemory(workspaceRoot, unusedModel);
    assert.equal((await memory.listMemoryEntries({ origins: ["all"] })).entries.length, 1);
    assert.equal((await memory.scanEligibleCandidates({ now: new Date("2026-08-03T00:00:00.000Z") })).candidates.length, 2);
    await assert.rejects(fs.access(path.join(memoryRoot, ".migration-v2.json")), /ENOENT/u);
    assert.equal(await fs.readFile(path.join(sourceDirectory, ".candidates", "a.json"), "utf8"), firstCandidate);
    assert.equal(await fs.readFile(path.join(sourceDirectory, ".candidates", "b.json"), "utf8"), secondCandidate);
  });
}

async function testCandidateOriginEligibilityAndRedaction(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const queued = await memory.enqueueCandidate({
      summary: "Completed root turn established a durable workflow. apiKey=sk-candidate-secret-value",
      completed: true,
      lineage: { source: "completed_task", sessionId: "session-1", turnId: "turn-1", runId: "run-1", externalContext: false },
      audienceHint: "workspace",
      kindHint: "workflow"
    }, { expectedRevision: 0, excludeExternalContext: true, now: new Date("2026-08-10T00:00:00.000Z") });
    assert.equal(queued.queued, true);
    assert.equal(queued.candidate?.origin.kind, "workspace");
    assert.equal(queued.candidate?.summary.includes("sk-candidate-secret-value"), false);
    assert.equal((await memory.scanEligibleCandidates({ now: new Date("2026-08-10T05:59:59.999Z") })).candidates.length, 0);
    assert.equal((await memory.scanEligibleCandidates({ now: new Date("2026-08-10T06:00:00.000Z") })).candidates.length, 1);
  });
}

async function testSingleRootSafetyBoundary(): Promise<void> {
  const agentRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-agent-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-workspace-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-outside-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = agentRoot;
  try {
    await fs.symlink(outside, path.join(agentRoot, "memory"), "dir");
    await assert.rejects(new LocalMemory(workspaceRoot, unusedModel).writeEntry(projectEntry(
      "Unsafe root",
      "This entry must never be written through a symbolic memory root."
    ), { expectedRevision: 0 }), /real directory, not a symbolic link/u);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    restoreAgentRoot(previous);
    await rm(agentRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

function projectEntry(title: string, summary: string): MemoryEntryInput {
  return {
    audience: "workspace",
    kind: "fact",
    topic: "project",
    title,
    summary,
    decisions: [],
    paths: [],
    keywords: [],
    importance: 3,
    lineage: { source: "explicit", externalContext: false }
  };
}

function legacyV2Entry(id: string, scope: "global" | "project", kind: string, title: string, summary: string, userEvidence?: string): string {
  return [
    "---",
    "version: 2",
    `id: ${id}`,
    `scope: ${scope}`,
    `kind: ${kind}`,
    "topic: project",
    `title: ${title}`,
    `summary: ${summary}`,
    "decisions: []",
    "paths: []",
    "keywords: []",
    "importance: 3",
    "createdAt: 2026-08-01T00:00:00.000Z",
    "updatedAt: 2026-08-01T00:00:00.000Z",
    "revision: 1",
    "lineage:",
    "  - source: explicit",
    "    externalContext: false",
    ...(userEvidence ? [`    userEvidence: ${userEvidence}`] : []),
    "---",
    "",
    `# ${title}`,
    "",
    summary,
    ""
  ].join("\n");
}

function legacyV2Candidate(id: string, summary: string): string {
  return `${JSON.stringify({
    version: 2,
    id,
    summary,
    completed: true,
    lineage: { source: "completed_task", sessionId: "session", turnId: id, runId: id, externalContext: false },
    scopeHint: "project",
    kindHint: "workflow",
    createdAt: "2026-08-01T00:00:00.000Z",
    eligibleAt: "2026-08-01T06:00:00.000Z",
    revision: 1
  }, null, 2)}\n`;
}

function unusedModel(): AgentModel {
  return {
    provider: "test",
    modelId: "unused",
    async stream() {
      return (async function* () { /* storage-only tests do not call the model */ })();
    }
  };
}

async function withIsolatedMemory(run: (workspaceRoot: string, agentRoot: string) => Promise<void>): Promise<void> {
  await withSharedAgent(async (agentRoot) => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-workspace-"));
    try {
      await run(workspaceRoot, agentRoot);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
}

async function withSharedAgent(run: (agentRoot: string) => Promise<void>): Promise<void> {
  const agentRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v3-agent-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = agentRoot;
  try {
    await run(agentRoot);
  } finally {
    restoreAgentRoot(previous);
    await rm(agentRoot, { recursive: true, force: true });
  }
}

function restoreAgentRoot(previous: string | undefined): void {
  if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previous;
}

await main();
