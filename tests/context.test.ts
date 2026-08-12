import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage, AgentModel, ModelStreamContext, ModelStreamEvent } from "../src/agent/core/types.js";
import { AgentSession } from "../src/agent/AgentSession.js";
import { ContextMemory, estimateMessageTokens } from "../src/agent/context/ContextMemory.js";
import { LocalMemory, redactSecrets } from "../src/agent/context/LocalMemory.js";
import { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";
import { cloneAgentMessages, messageReasoning, messageText } from "../src/agent/modelMessages.js";
import { selectPlanTools } from "../src/agent/planMode.js";
import { buildSystemPrompt, refreshRuntimeSystemPrompt, stableSystemPromptForCache, withActiveRunCompactionSummary } from "../src/agent/prompts.js";
import { BINY_AGENT_DIR_ENV, projectMemoryDir, projectSessionsDir } from "../src/config/paths.js";
import type { AgentConfig } from "../src/config/schema.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { recordNativeTelemetry } from "../src/observability/telemetry.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { maxSessionEventLineBytes, maxSessionEvents, maxSessionFileBytes } from "../src/session/limits.js";
import { replaySession, sessionEventsToConversation } from "../src/session/replay.js";
import {
  deleteSessionFile,
  duplicateSessionFile,
  ensureAgentDirs,
  listSessionFiles,
  readSessionSnapshot,
  resolveSessionFile,
  sessionFilePath
} from "../src/session/store.js";
import { listSessionSummaries, parseSessionEvents, readSessionEvents, readStoredSessionEvents, repairSessionTailForAppend } from "../src/session/events.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";
import { createToolPermissionRequest } from "../src/tools/display/ToolDisplay.js";
import { appendInputHistory, loadInputHistory } from "../src/tui/inputHistory.js";
import { resolveWorkspacePath } from "../src/workspace/resolvePath.js";

class ContextTestModel {
  readonly requests: AgentMessage[][] = [];
  readonly systemPrompts: Array<string | undefined> = [];
  readonly model: AgentModel = createContextTestModel(this);

  respond(messages: AgentMessage[], systemPrompt?: string): string {
    this.requests.push(cloneAgentMessages(messages));
    this.systemPrompts.push(systemPrompt);
    const prompt = messageText(messages.at(-1) ?? { role: "user", content: "" });
    if (prompt.includes("Extract one durable")) {
      return JSON.stringify({
        topic: "workflows",
        title: "Context refresh workflow",
        summary: "Refresh the workspace snapshot and RepoMap after a successful workspace write before the next turn.",
        decisions: ["Use deterministic paths instead of vector retrieval."],
        paths: ["src/agent/context/ContextMemory.ts"],
        keywords: ["context", "refresh", "workflow"]
      });
    }
    if (prompt.includes("Consolidate this project memory topic file")) {
      return JSON.stringify({
        entries: [{
          title: "Weather workflow",
          summary: "使用 wttr.in 获取天气，请求失败时最多重试三次并渲染 Markdown 表格。",
          decisions: [],
          paths: [],
          keywords: ["weather", "retry"]
        }]
      });
    }
    if (prompt.includes("durable context checkpoint")) {
      return [
        "## Goal",
        "- Keep context bounded.",
        "",
        "## Constraints & Preferences",
        "- Preserve grounded session facts.",
        "",
        "## Progress",
        "### Done",
        "- [x] Created a structured handoff.",
        "### In Progress",
        "- [ ] Continue the requested change.",
        "### Blocked",
        "- (none)",
        "",
        "## Key Decisions",
        "- **Checkpoint**: Keep a stable compaction boundary.",
        "",
        "## Next Steps",
        "1. Continue from retained history.",
        "",
        "## Critical Context",
        "- Tests passed."
      ].join("\n");
    }
    return "ok";
  }
}

function createContextTestModel(provider: ContextTestModel): AgentModel {
  return {
    provider: "context-test",
    modelId: "context-test",
    async stream(context: ModelStreamContext, options): Promise<AsyncIterable<ModelStreamEvent>> {
      const text = provider.respond(context.messages, context.systemPrompt);
      return (async function* () {
        options?.signal?.throwIfAborted();
        yield { type: "start" as const };
        if (text) yield { type: "text-delta" as const, text };
        yield { type: "finish" as const, reason: "stop" as const, usage: { inputTokens: 0, outputTokens: 1, totalTokens: 1 } };
      })();
    }
  };
}

async function main(): Promise<void> {
  const globalRoot = await mkdtemp(path.join(os.tmpdir(), "biny-context-global-"));
  const previousGlobalRoot = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = globalRoot;
  try {
    testConversationBoundaryPrompt();
    testPlanModePolicy();
    await testPromptEpochAndCanonicalPrefix();
    await testInstructionHierarchyAndCap();
    await testInstructionLoadingUsesExplicitPaths();
    await testRepoMapExactCandidate();
    await testAutomaticContextRejectsExternalSymlinks();
    await testAutomaticContextSupportsSymlinkedWorkspaceRoot();
    await testBudgetAndCompaction();
    await testMidTurnToolResultPruning();
    await testActiveRunCompactionPreservesToolBatches();
    await testIncrementalSplitTurnCompaction();
    await testContextPreparationAbortStopsAutoCompaction();
    await testRestoreWithoutPersistedBudgetUsesHistoryEstimate();
    await testSessionReplayAndAgentResume();
    await testCheckpointIsResumeTruthSource();
    await testLegacyAgentStateIsIgnored();
    await testSessionPathBoundaries();
    await testGlobalSessionsStayProjectScoped();
    await testSessionSummariesSortByUpdatedAt();
    await testSessionReadLimits();
    await testDeleteSessionReplacementRace();
    await testFailedCurrentSessionResumeKeepsRecorderUsable();
    await testTruncatedSessionTailAndDanglingToolRecovery();
    await testTurnStatusPersistence();
    await testSessionAndToolDisplayRedaction();
    await testMemoryRedactionDedupAndWriter();
    await testMemoryQueueLifecycleAndUsagePersistence();
    await testMemoryStorageBoundaries();
    await testMemoryEntryManagementAndCjkSearch();
    await testCredentialAndSymlinkBoundaries();
    await testToolWriteMarksSnapshotAndRepoMapDirty();
  } finally {
    if (previousGlobalRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previousGlobalRoot;
    await rm(globalRoot, { recursive: true, force: true });
  }
}

function testConversationBoundaryPrompt(): void {
  const prompt = buildSystemPrompt({ mode: "qa", cwd: "/workspace" });
  assert.match(prompt, /expert coding assistant operating inside Biny/u);
  assert.match(prompt, /Available tools:\n\(none\)/u);
  assert.match(prompt, /only the latest user message as the active task/u);
  assert.match(prompt, /desired outcome, constraints, and explicit success criteria/u);
  assert.match(prompt, /external side effects, destructive or costly actions/u);
  assert.match(prompt, /Current permission mode: runtime-managed/u);
  assert.match(prompt, /Current working directory: \/workspace/u);
  assert.doesNotMatch(prompt, /Search the public web/u);
  const webTool = {
    name: "web_search",
    promptSnippet: "Search the public web",
    promptGuidelines: ["Use web_search for current public information"]
  };
  assert.match(buildSystemPrompt({ mode: "qa", cwd: "/workspace", tools: [webTool] }), /Use web_search for current public information/u);
  assert.doesNotMatch(
    buildSystemPrompt({ mode: "qa", cwd: "/workspace", tools: [{ name: "custom_tool" }] }),
    /- custom_tool:/u
  );
  const compacted = withActiveRunCompactionSummary(
    buildSystemPrompt({ mode: "qa", cwd: "/workspace", extensionPrompt: "old dynamic capability", tools: [webTool] }),
    "first overflow summary"
  );
  const refreshed = refreshRuntimeSystemPrompt(compacted, "new dynamic capability", [{
    name: "run_command",
    promptSnippet: "Run a finite command",
    promptGuidelines: ["Use run_command only for finite commands"]
  }]);
  const recoveredAgain = withActiveRunCompactionSummary(refreshed, "second overflow summary");
  assert.match(recoveredAgain, /new dynamic capability/u);
  assert.match(recoveredAgain, /Use run_command/u);
  assert.match(recoveredAgain, /second overflow summary/u);
  assert.doesNotMatch(recoveredAgain, /old dynamic capability|first overflow summary/u);
}

function testPlanModePolicy(): void {
  const tool = (name: string, risk?: Tool["risk"], source?: Tool["source"]): Tool => ({ name, risk, source } as Tool);
  const tools = [
    tool("read_file", "read"),
    tool("write_file", "write"),
    tool("run_command", "execute"),
    tool("delegate_task", "execute", "subagent"),
    tool("custom_tool")
  ];

  assert.deepEqual(
    selectPlanTools(tools, "ask").map((candidate) => candidate.name),
    ["read_file"]
  );
  assert.deepEqual(
    selectPlanTools(tools, "full-access").map((candidate) => candidate.name),
    ["read_file", "write_file", "run_command", "custom_tool"]
  );

  const readPrompt = buildSystemPrompt({ mode: "plan", permissionMode: "ask", cwd: "/workspace" });
  assert.match(readPrompt, /Plan mode is a collaboration workflow, not a permission mode/u);
  assert.match(readPrompt, /only exposes read and inspection tools/u);
  assert.doesNotMatch(readPrompt, /Full access is active/u);

  const fullAccessPrompt = buildSystemPrompt({ mode: "plan", permissionMode: "full-access", cwd: "/workspace" });
  assert.match(fullAccessPrompt, /Full access is active/u);
  assert.match(fullAccessPrompt, /only when the current user request explicitly asks/u);
  assert.doesNotMatch(fullAccessPrompt, /Never write or edit files/u);
}

async function testPromptEpochAndCanonicalPrefix(): Promise<void> {
  const toolA = { name: "alpha", description: "Alpha", parameters: { type: "object" as const } };
  const toolB = { name: "beta", description: "Beta", parameters: { type: "object" as const } };
  const first = buildSystemPrompt({ mode: "qa", cwd: "/workspace", extensionPrompt: "project-a", tools: [toolB, toolA] });
  const second = buildSystemPrompt({ mode: "qa", cwd: "/workspace", extensionPrompt: "project-b", tools: [toolA, toolB] });
  assert.equal(stableSystemPromptForCache(first), stableSystemPromptForCache(second));

  await withTempWorkspace(async (workspaceRoot) => {
    const provider = new ContextTestModel();
    const memory = new ContextMemory(
      () => provider.model,
      new WorkspaceContext(workspaceRoot, [], 32 * 1024),
      undefined,
      4_000,
      32 * 1024,
      undefined,
      undefined,
      { keepRecentTokens: 50, maxSummaryTokens: 512 }
    );
    memory.recordToolSchema([toolA]);
    const initialEpoch = memory.getPromptEpoch();
    memory.recordToolSchema([toolB]);
    assert.equal(memory.getPromptEpoch(), initialEpoch + 1);
    memory.replaceHistory([
      { role: "user", content: "old request ".repeat(700) },
      { role: "assistant", content: [{ type: "text", text: "old response ".repeat(700) }] },
      { role: "user", content: "recent request" }
    ]);
    const beforeCompaction = memory.getPromptEpoch();
    assert.equal((await memory.compact()).compacted, true);
    assert.equal(memory.getPromptEpoch(), beforeCompaction + 1);
    const state = memory.snapshot();
    const restored = new ContextMemory(
      () => provider.model,
      new WorkspaceContext(workspaceRoot, [], 32 * 1024),
      undefined,
      4_000,
      32 * 1024
    );
    restored.restore(memory.getHistory(), state);
    assert.equal(restored.getPromptEpoch(), memory.getPromptEpoch());
    assert.equal(restored.snapshot().promptEpochReason, "compaction");
  });
}

async function testInstructionHierarchyAndCap(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "AGENTS.md"), "root rule\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "AGENTS.md"), "ignored by override\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "AGENTS.override.md"), "nested override rule\n", "utf8");

    const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
    await workspace.initialize();
    assert.deepEqual(workspace.status().loadedInstructions, ["AGENTS.md"]);

    workspace.observeToolResult("read_file", { path: "src/example.ts" }, { path: "src/example.ts", content: "export {};" });
    await workspace.prepareTurn("explain the file");
    assert.deepEqual(workspace.status().loadedInstructions, ["AGENTS.md", "src/AGENTS.override.md"]);
    const memory = new ContextMemory(() => new ContextTestModel().model, workspace, undefined, 8_000, 32 * 1024);
    const prepared = await memory.prepareTurn("explain the file", "base prompt");
    assert.match(prepared.systemPrompt ?? "", /<project_context>/u);
    assert.match(prepared.systemPrompt ?? "", /<project_instructions path="AGENTS\.md">\nroot rule/u);
    assert.match(prepared.systemPrompt ?? "", /<project_instructions path="src\/AGENTS\.override\.md">\nnested override rule/u);

    const capped = new WorkspaceContext(workspaceRoot, [], 10);
    await capped.initialize();
    assert.equal(capped.status().instructionBytes <= 10, true);
  });
}

async function testInstructionLoadingUsesExplicitPaths(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.mkdir(path.join(workspaceRoot, "src", "feature"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "AGENTS.md"), "root rule\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "feature", "AGENTS.md"), "feature rule\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "feature", "entry.ts"), "export const entry = true;\n", "utf8");

    const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
    await workspace.prepareTurn("inspect src/feature/entry.ts");
    assert.deepEqual(workspace.status().loadedInstructions, ["AGENTS.md", "src/feature/AGENTS.md"]);

    workspace.observeToolResult("read_file", { path: "src/feature/entry.ts" }, { path: "src/feature/entry.ts", content: "export const entry = true;" });
    await workspace.prepareTurn("explain the file");
    assert.deepEqual(workspace.status().loadedInstructions, ["AGENTS.md", "src/feature/AGENTS.md"]);
  });
}

async function testRepoMapExactCandidate(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "tests"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "index.ts"), "import { createWorker } from './worker.js';\nexport function startAgent() { return createWorker(); }\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "worker.ts"), "export class Worker {}\nexport function createWorker() { return new Worker(); }\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "tests", "worker.test.ts"), "export function testWorker() {}\n", "utf8");

    const workspace = new WorkspaceContext(workspaceRoot, [".biny"], 32 * 1024);
    const turn = await workspace.prepareTurn("startAgent");
    assert.equal(turn.repoMapCandidates[0]?.path, "src/index.ts");
    assert.equal(turn.repoMapCandidates[0]?.symbols.includes("startAgent"), true);
    assert.equal("content" in (turn.repoMapCandidates[0] ?? {}), false);
  });
}

async function testAutomaticContextRejectsExternalSymlinks(): Promise<void> {
  if (process.platform === "win32") return;
  await withTempWorkspace(async (workspaceRoot) => {
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "biny-context-external-"));
    try {
      await fs.mkdir(path.join(externalRoot, "src"), { recursive: true });
      await fs.writeFile(path.join(externalRoot, "AGENTS.md"), "EXTERNAL_INSTRUCTION_SECRET\n", "utf8");
      await fs.writeFile(path.join(externalRoot, "entry.ts"), "export const ExternalRepoMapSecret = true;\n", "utf8");
      await fs.writeFile(path.join(externalRoot, "README.md"), "EXTERNAL_README_SECRET\n", "utf8");
      await fs.writeFile(path.join(externalRoot, "package.json"), JSON.stringify({ name: "external-package-secret" }), "utf8");
      await fs.writeFile(path.join(externalRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { externalSecret: true } }), "utf8");
      await fs.writeFile(path.join(externalRoot, "pnpm-lock.yaml"), "external-lock-secret\n", "utf8");
      await fs.writeFile(path.join(externalRoot, "src", "leak.ts"), "export const ExternalSrcTreeSecret = true;\n", "utf8");

      await fs.writeFile(path.join(workspaceRoot, "AGENTS.md"), "safe workspace rule\n", "utf8");
      await fs.symlink(externalRoot, path.join(workspaceRoot, "linked"), "dir");
      await fs.symlink(path.join(externalRoot, "src"), path.join(workspaceRoot, "src"), "dir");
      for (const fileName of ["README.md", "package.json", "tsconfig.json", "pnpm-lock.yaml"]) {
        await fs.symlink(path.join(externalRoot, fileName), path.join(workspaceRoot, fileName), "file");
      }

      const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
      const turn = await workspace.prepareTurn("inspect linked/entry.ts ExternalRepoMapSecret");
      assert.deepEqual(workspace.status().loadedInstructions, ["AGENTS.md"]);
      assert.equal(turn.instructions.some((instruction) => instruction.content.includes("EXTERNAL_INSTRUCTION_SECRET")), false);
      assert.equal(turn.repoMapCandidates.some((entry) => entry.symbols.includes("ExternalRepoMapSecret")), false);
      assert.equal(turn.snapshot.context.packageManager, "unknown");
      assert.equal(turn.snapshot.context.packageJson, undefined);
      assert.equal(turn.snapshot.context.tsconfig, undefined);
      assert.equal(turn.snapshot.context.readme, undefined);
      assert.deepEqual(turn.snapshot.context.srcTree, []);
    } finally {
      await rm(externalRoot, { recursive: true, force: true });
    }
  });
}

async function testAutomaticContextSupportsSymlinkedWorkspaceRoot(): Promise<void> {
  if (process.platform === "win32") return;
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "AGENTS.md"), "alias root rule\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "alias root readme\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "alias-root" }), "utf8");
    await fs.writeFile(path.join(workspaceRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }), "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "index.ts"), "export const AliasRootSymbol = true;\n", "utf8");
    const aliasRoot = path.join(workspaceRoot, "workspace-link");
    await fs.symlink(workspaceRoot, aliasRoot, "dir");

    const workspace = new WorkspaceContext(aliasRoot, [], 32 * 1024);
    const turn = await workspace.prepareTurn("find AliasRootSymbol in src/index.ts");
    assert.deepEqual(workspace.status().loadedInstructions, ["AGENTS.md"]);
    assert.equal(turn.instructions[0]?.content, "alias root rule\n");
    assert.equal(turn.snapshot.context.packageJson?.name, "alias-root");
    assert.equal(turn.snapshot.context.tsconfig?.compilerOptions.strict, true);
    assert.equal(turn.snapshot.context.readme, "alias root readme\n");
    assert.equal(turn.snapshot.context.srcTree.includes("[f] src/index.ts"), true);
    assert.equal(turn.repoMapCandidates.some((entry) => entry.symbols.includes("AliasRootSymbol")), true);
  });
}

/**
 * 回合内剪枝：只把较早的 tool result 正文换成占位符，消息条数、角色和 toolCallId 都不动，
 * tool-call / tool-result 的配对不能被破坏。
 */
async function testMidTurnToolResultPruning(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const provider = new ContextTestModel();
    const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
    const memory = new ContextMemory(() => provider.model, workspace, undefined, 200, 32 * 1024);

    const messages: AgentMessage[] = [{ role: "user", content: "inspect the repo" }];
    const archivedPath = `.biny/tool-results/tool-result-${"a".repeat(64)}.json`;
    for (let index = 0; index < 5; index += 1) {
      messages.push({
        role: "assistant",
        content: [{ type: "toolCall", id: `call-${String(index)}`, name: "read_file", arguments: { path: `f${String(index)}.ts` } }]
      });
      messages.push({
        role: "toolResult",
        toolCallId: `call-${String(index)}`,
        toolName: "read_file",
        content: [{
          type: "text",
          text: index === 0
            ? JSON.stringify({ archived: true, archivePath: archivedPath, preview: "body ".repeat(200) })
            : "body ".repeat(200)
        }]
      });
    }

    const before = estimateMessageTokens(messages);
    const pruned = memory.pruneToolResultsForStep(messages);
    assert.equal(pruned.length, messages.length, "pruning must not drop messages");
    assert.equal(estimateMessageTokens(pruned) < before, true, "pruning must shrink the estimate");

    // 每个 tool-call 仍然有配对的 tool-result，且 toolCallId 一一对应。
    const callIds = pruned.flatMap((message) => message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "toolCall").map((part) => part.id)
      : []);
    const resultIds = pruned.flatMap((message) => message.role === "toolResult"
      ? [message.toolCallId]
      : []);
    assert.deepEqual(callIds, resultIds);

    // 最近的工具结果保持原样：模型当下要用的就是它们。
    const lastResult = pruned.at(-1);
    assert.equal(lastResult?.role, "toolResult");
    assert.equal(String(toolResultValue(lastResult)).startsWith("body "), true);
    // 最早的已被换成可重新读取的归档引用，普通旧结果则保留一个小预览。
    assert.equal(/compacted for this model step/.test(String(toolResultValue(pruned[2]))), true);
    assert.equal(String(toolResultValue(pruned[2])).includes(archivedPath), true);
    assert.equal(/Preview: body/.test(String(toolResultValue(pruned[4]))), true);

    // 预算充裕时不动任何东西，且剪枝是幂等的。
    const roomy = new ContextMemory(() => provider.model, workspace, undefined, 1_000_000, 32 * 1024);
    assert.equal(roomy.pruneToolResultsForStep(messages), messages);
    assert.equal(estimateMessageTokens(memory.pruneToolResultsForStep(pruned)), estimateMessageTokens(pruned));
  });
}

async function testActiveRunCompactionPreservesToolBatches(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const provider = new ContextTestModel();
    const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
    const memory = new ContextMemory(() => provider.model, workspace, undefined, 4_000, 32 * 1024);
    const messages: AgentMessage[] = [
      { role: "user", content: `old request ${"detail ".repeat(1_600)}` },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "old-call", name: "read_file", arguments: { path: "old.ts" } }]
      },
      {
        role: "toolResult",
        toolCallId: "old-call",
        toolName: "read_file",
        content: [{ type: "text", text: "old result ".repeat(1_600) }]
      },
      { role: "user", content: "continue with the recent file" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "recent-call", name: "read_file", arguments: { path: "recent.ts" } }]
      },
      {
        role: "toolResult",
        toolCallId: "recent-call",
        toolName: "read_file",
        content: [{ type: "text", text: "recent result" }]
      }
    ];

    const compacted = await memory.compactRunContext(messages);
    assert.ok(compacted);
    assert.equal(compacted.compactedMessageCount > 0, true);
    assert.equal(compacted.messages.some((message) => message.role === "toolResult" && message.toolCallId === "recent-call"), true);
    const retainedCallIds = compacted.messages.flatMap((message) => message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "toolCall").map((part) => part.id)
      : []);
    const retainedResultIds = compacted.messages.flatMap((message) => message.role === "toolResult" ? [message.toolCallId] : []);
    assert.deepEqual(retainedCallIds, retainedResultIds);
  });
}

async function testIncrementalSplitTurnCompaction(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const provider = new ContextTestModel();
    const memory = new ContextMemory(
      () => provider.model,
      new WorkspaceContext(workspaceRoot, [], 32 * 1024),
      undefined,
      4_000,
      32 * 1024,
      undefined,
      undefined,
      { keepRecentTokens: 50, maxSummaryTokens: 512 }
    );
    const initialHistory: AgentMessage[] = [];
    for (let index = 0; index < 6; index += 1) {
      initialHistory.push(
        { role: "user", content: `initial request ${String(index)} ${"detail ".repeat(700)}` },
        {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: `initial-call-${String(index)}`,
            name: "read_file",
            arguments: { path: `src/read-${String(index)}.ts`, detail: "detail ".repeat(700) }
          }]
        },
        {
          role: "toolResult",
          toolCallId: `initial-call-${String(index)}`,
          toolName: "read_file",
          content: [{ type: "text", text: `initial result ${String(index)} ${"detail ".repeat(700)}` }]
        }
      );
    }
    memory.replaceHistory(initialHistory);
    assert.equal((await memory.compact()).compacted, true);
    const initialSummaryRequest = provider.requests.at(-1) ?? [];
    const initialStatus = await memory.status();
    assert.equal(
      estimateMessageTokens(initialSummaryRequest) <= initialStatus.budget.maxTokens - (initialStatus.budget.reserveTokens ?? 0),
      true,
      "the compaction request must fit its own input budget"
    );

    const split = await memory.compactRunContext([
      { role: "user", content: "preserve the beginning of this long active turn in the checkpoint" },
      {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "split-call",
          name: "read_file",
          arguments: { path: "src/large.ts", detail: "large argument ".repeat(120) }
        }]
      },
      {
        role: "toolResult",
        toolCallId: "split-call",
        toolName: "read_file",
        content: [{ type: "text", text: "recent result" }]
      }
    ]);
    assert.ok(split);
    assert.equal(split.compactedMessageCount, 1, "long turns may split only at a safe assistant boundary");
    assert.deepEqual(split.messages.map((message) => message.role), ["assistant", "toolResult"]);
    assert.match(split.summary, /src\/read-0\.ts/u, "incremental summaries must retain the cumulative file list");
    const updatePrompt = messageText(provider.requests.at(-1)?.at(-1) ?? { role: "user", content: "" });
    assert.match(updatePrompt, /<previous-summary>/u);
    assert.match(updatePrompt, /ends inside a long user turn/u);
  });
}

function toolResultValue(message: AgentMessage | undefined): unknown {
  if (!message || message.role !== "toolResult") return undefined;
  return message.content.find((entry) => entry.type === "text")?.text;
}

async function testBudgetAndCompaction(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const provider = new ContextTestModel();
    const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
    const memory = new ContextMemory(() => provider.model, workspace, undefined, 120, 32 * 1024);
    memory.replaceHistory([
      { role: "user", content: "old request ".repeat(40) },
      { role: "assistant", content: [{ type: "text", text: "old response ".repeat(40) }] }
    ]);
    const { messages } = await memory.prepareTurn("current task ".repeat(20), "system rule ".repeat(30));
    assert.equal(estimateMessageTokens(messages) <= 120, true);
    assert.equal(messages.at(-1)?.role, "user");
    assert.equal(messages.at(-1)?.content.includes("current task"), true);
    const preparedStatus = await memory.status();
    assert.equal(
      preparedStatus.budget.usedTokens <= preparedStatus.budget.maxTokens - (preparedStatus.budget.reserveTokens ?? 0),
      true,
      "assembled prompt must leave the configured compaction reserve unused"
    );
    const componentIds = new Set(preparedStatus.budget.components?.map((component) => component.id));
    assert.equal(componentIds.has("task"), true);
    assert.equal(componentIds.has("history"), true);
    assert.equal(componentIds.has("system rules"), true);
    assert.equal(preparedStatus.budget.components?.every((component) => component.requestedTokens >= component.usedTokens), true);
    assert.equal(estimateMessageTokens([{ role: "assistant", content: [{ type: "reasoning", text: "reason ".repeat(20) }] }]) > 4, true);

    memory.replaceHistory(Array.from({ length: 8 }, (_, index): AgentMessage => index % 2
      ? { role: "assistant", content: [{ type: "text", text: `message ${String(index)} ${"detail ".repeat(180)}` }] }
      : { role: "user", content: `message ${String(index)} ${"detail ".repeat(180)}` }));
    await memory.prepareTurn("continue", "system");
    const compactedStatus = await memory.status();
    assert.equal(compactedStatus.compaction.summaryPresent, true);
    assert.equal(compactedStatus.budget.autoCompacted, true);

    memory.replaceHistory([{ role: "user", content: "manual compact request" }]);
    const manual = await memory.compact("retain next steps");
    assert.equal(manual.compacted, true);
  });
}

async function testContextPreparationAbortStopsAutoCompaction(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const started = deferred<void>();
    const aborted = deferred<void>();
    const model: AgentModel = {
      provider: "context-test-abort",
      modelId: "context-test-abort",
      async stream(_context, options) {
        return (async function* () {
          started.resolve(undefined);
          await new Promise<void>((_resolve, reject) => {
            const stop = (): void => {
              aborted.resolve(undefined);
              reject(options?.signal?.reason ?? new Error("aborted"));
            };
            if (options?.signal?.aborted) stop();
            else options?.signal?.addEventListener("abort", stop, { once: true });
          });
          yield { type: "start" as const };
        })();
      }
    };
    const memory = new ContextMemory(
      () => model,
      new WorkspaceContext(workspaceRoot, [], 32 * 1024),
      undefined,
      120,
      32 * 1024
    );
    memory.replaceHistory([
      { role: "user", content: "old request ".repeat(80) },
      { role: "assistant", content: [{ type: "text", text: "old response ".repeat(80) }] }
    ]);

    const controller = new AbortController();
    const pending = memory.prepareTurn("continue", "system", controller.signal);
    await started.promise;
    controller.abort();
    await assert.rejects(pending, /abort/i);
    await aborted.promise;
    const status = await memory.status();
    assert.equal(status.compaction.summaryPresent, false);
    assert.equal(status.compaction.compactedMessages, 0);
  });
}

async function testRestoreWithoutPersistedBudgetUsesHistoryEstimate(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const provider = new ContextTestModel();
    const memory = new ContextMemory(
      () => provider.model,
      new WorkspaceContext(workspaceRoot, [], 32 * 1024),
      undefined,
      120,
      32 * 1024
    );
    memory.restore([
      { role: "user", content: "historical request ".repeat(4) },
      { role: "assistant", content: [{ type: "text", text: "historical answer ".repeat(4) }] }
    ]);
    const status = await memory.status();
    assert.equal(status.budget.usedTokens > 0, true);
    assert.equal(status.budget.maxTokens, 120);
    memory.recordProviderUsage({ inputTokens: 119, outputTokens: 1, totalTokens: 120 });
    memory.setCheckpoint({
      summary: "## Goal\n- Continue from a restored checkpoint.",
      firstKeptMessageIndex: 1,
      tokensBefore: 119,
      compactedMessages: 1,
      createdAt: "2026-08-02T00:00:00.000Z"
    });
    const checkpointed = await memory.status();
    assert.equal(checkpointed.budget.source, "estimated", "provider usage before a checkpoint is stale");
  });
}

async function testSessionReplayAndAgentResume(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const events: SessionEvent[] = [
      {
        type: "user_message",
        content: "inspect src/index.ts",
        contextUsage: { maxTokens: 24_000, usedTokens: 1_234, omitted: [], autoCompacted: false }
      },
      {
        type: "tool_call",
        tool: "read_file",
        args: { path: "src/index.ts" },
        toolCallId: "call-7",
        sequence: 7,
        assistantContent: "I will inspect the entry.",
        reasoningContent: "The entry file is the first target.",
        reasoningProviderOptions: { anthropic: { signature: "signed-entry-reasoning" } }
      },
      { type: "tool_result", tool: "read_file", result: { path: "src/index.ts", content: "export {}" }, toolCallId: "call-7", sequence: 7 },
      {
        type: "tool_call",
        tool: "read_file",
        args: { path: "src/worker.ts" },
        toolCallId: "call-8",
        sequence: 8,
        assistantContent: "I will inspect the worker.",
        reasoningContent: "The worker is the second target.",
        reasoningProviderOptions: { anthropic: { signature: "signed-worker-reasoning" } }
      },
      { type: "tool_result", tool: "read_file", result: { path: "src/worker.ts", content: "export class Worker {}" }, toolCallId: "call-8", sequence: 8 },
      {
        type: "assistant_message",
        content: "The files define the entry and worker.",
        reasoningContent: "Both requested files were inspected.",
        reasoningProviderOptions: { anthropic: { signature: "signed-final-reasoning" } },
        usage: {
          operation: "agent",
          modelAlias: "deepseek-v4-flash",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          inputTokens: 1_234,
          outputTokens: 40,
          totalTokens: 1_274,
          pricingKnown: false
        },
        contextState: {
          summary: "Persisted handoff summary.",
          compactedMessages: 4,
          memoryTopics: ["context"],
          budget: { maxTokens: 24_000, usedTokens: 1_234, omitted: [], autoCompacted: false, source: "provider" }
        }
      }
    ];
    const filePath = sessionFilePath(workspaceRoot, "saved-session");
    await fs.writeFile(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

    const replay = await replaySession(filePath);
    assert.equal(replay.messages[1]?.role, "assistant");
    assert.equal(hasToolCall(replay.messages[1], "call-7"), true);
    assert.equal(messageReasoning(replay.messages[1]!), "The entry file is the first target.");
    assert.equal(hasToolResult(replay.messages[2], "call-7"), true);
    assert.equal(hasToolCall(replay.messages[3], "call-8"), true);
    assert.equal(messageReasoning(replay.messages[3]!), "The worker is the second target.");
    assert.equal(messageReasoning(replay.messages[5]!), "Both requested files were inspected.");
    assert.equal(sessionEventsToConversation(events).length, 6);
    assert.equal(replay.contextState?.summary, "Persisted handoff summary.");
    assert.equal(replay.usage[0]?.inputTokens, 1_234);

    const config = testConfig();
    config.context.memory.useMemories = false;
    config.context.memory.generateMemories = false;
    const provider = new ContextTestModel();
    const agent = new AgentSession({
      workspaceRoot,
      config,
      model: provider.model,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
      recorder: new SessionRecorder(workspaceRoot)
    });
    await agent.initialize();
    assert.equal(agent.getInfo().modelLabel, "deepseek-v4-flash");
    assert.equal(agent.getInfo().reasoningLabel, "Off");
    const resumed = await agent.resume("saved-session");
    assert.equal(resumed.sessionId, "saved-session");
    assert.equal(agent.getInfo().sessionId, "saved-session");
    const restoredContext = await agent.contextStatus();
    assert.equal(restoredContext.activePaths.includes("src/index.ts"), true);
    assert.equal(restoredContext.budget.usedTokens, 1_234);
    assert.equal(restoredContext.compaction.summaryPresent, true);
    await agent.runTask("continue the review");
    assert.equal(provider.requests.at(-1)?.some((message) => hasToolCall(message, "call-7")), true);
    assert.equal(provider.requests.at(-1)?.some((message) => messageReasoning(message) === "The worker is the second target."), true);
    const pendingPlan = agent.runTask("plan the next review", { mode: "plan" });
    await assert.rejects(agent.compactConversation(), /while agent turn is running/);
    await pendingPlan;
    const savedBeforeSwitch = await fs.readFile(filePath, "utf8");
    const secondFile = sessionFilePath(workspaceRoot, "second-session");
    await fs.writeFile(secondFile, `${JSON.stringify({ type: "user_message", content: "second session" })}\n`, "utf8");
    await agent.resume("second-session");
    const eventsBeforeSwitch = parseSessionEvents(savedBeforeSwitch);
    const eventsAfterSwitch = parseSessionEvents(await fs.readFile(filePath, "utf8"));
    assert.deepEqual(eventsAfterSwitch.slice(0, eventsBeforeSwitch.length), eventsBeforeSwitch);
    assert.equal(
      eventsAfterSwitch.slice(eventsBeforeSwitch.length).every((event) => event.type === "turn_status"),
      true
    );
    await agent.close();
  });
}

async function testCheckpointIsResumeTruthSource(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const config = testConfig();
    config.context.memory.useMemories = false;
    config.context.memory.generateMemories = false;
    const firstProvider = new ContextTestModel();
    const firstRecorder = new SessionRecorder(workspaceRoot, "checkpoint-resume");
    const firstAgent = new AgentSession({
      workspaceRoot,
      config,
      model: firstProvider.model,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
      recorder: firstRecorder
    });
    await firstAgent.initialize();
    await firstAgent.runTask("old checkpoint payload that must not be replayed verbatim");
    assert.match(await firstAgent.compactConversation(), /Compacted 2 messages/u);
    await firstAgent.close();

    const compactedReplay = await replaySession(firstRecorder.filePath);
    assert.equal(compactedReplay.messages.length, 0, "checkpoint boundary must exclude compacted messages on replay");
    assert.equal(compactedReplay.messageTree.length, 2, "compacted messages remain available for audit and branching");
    assert.equal(compactedReplay.contextCheckpoint?.firstKeptMessageIndex, 2);
    assert.match(compactedReplay.contextCheckpoint?.summary ?? "", /## Goal/u);

    const resumedProvider = new ContextTestModel();
    const resumedAgent = new AgentSession({
      workspaceRoot,
      config,
      model: resumedProvider.model,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
      recorder: new SessionRecorder(workspaceRoot)
    });
    await resumedAgent.initialize();
    await resumedAgent.resume("checkpoint-resume");
    await resumedAgent.runTask("continue only from the durable checkpoint");
    const resumedMessages = resumedProvider.requests.at(-1) ?? [];
    assert.equal(
      resumedMessages.some((message) => messageText(message).includes("old checkpoint payload")),
      false,
      "resume must not reintroduce pre-checkpoint messages"
    );
    assert.match(resumedProvider.systemPrompts.at(-1) ?? "", /Conversation handoff summary:[\s\S]*Keep context bounded/u);
    await resumedAgent.close();
  });
}

async function testTruncatedSessionTailAndDanglingToolRecovery(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    assert.throws(
      () => parseSessionEvents(JSON.stringify({ type: "user_message", content: 42 })),
      /Invalid session event at line 1.*content/u
    );
    const filePath = sessionFilePath(workspaceRoot, "interrupted-session");
    const events: SessionEvent[] = [
      { type: "user_message", content: "inspect the project" },
      { type: "tool_call", tool: "read_file", args: { path: "src/index.ts" }, toolCallId: "dangling-1", sequence: 1 }
    ];
    await fs.writeFile(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n{"type":"assistant`, "utf8");

    const readable = await readSessionEvents(filePath);
    assert.equal(readable.length, 2);
    const replay = await replaySession(filePath);
    assert.equal(replay.recoveredToolResults.length, 1);
    assert.equal(replay.recoveredToolResults[0]?.toolCallId, "dangling-1");
    assert.equal(replay.messages.some((message) => message.role === "toolResult"), true);

    await repairSessionTailForAppend(filePath);
    const recorder = new SessionRecorder(workspaceRoot, "interrupted-session");
    for (const event of replay.recoveredToolResults) recorder.record(event);
    await recorder.close();
    const repaired = await readSessionEvents(filePath);
    assert.equal(repaired.length, 3);
    assert.equal((await replaySession(filePath)).recoveredToolResults.length, 0);

    const supersededFile = sessionFilePath(workspaceRoot, "superseded-tool-call");
    await fs.writeFile(supersededFile, [
      JSON.stringify({ type: "user_message", content: "first turn" }),
      JSON.stringify({ type: "tool_call", tool: "read_file", args: { path: "old.ts" }, toolCallId: "old-call", sequence: 1 }),
      JSON.stringify({ type: "assistant_message", content: "continued without that result" }),
      JSON.stringify({ type: "user_message", content: "later turn" })
    ].join("\n") + "\n", "utf8");
    const supersededReplay = await replaySession(supersededFile);
    assert.equal(supersededReplay.recoveredToolResults.length, 1);
    assert.equal(supersededReplay.recoveredToolResults[0]?.executionStatus, "unknown");
    assert.equal(supersededReplay.messages.some((message) => hasToolResult(message, "old-call")), true);

    const healthyListFile = sessionFilePath(workspaceRoot, "healthy-list-session");
    const corruptListFile = sessionFilePath(workspaceRoot, "corrupt-list-session");
    await fs.writeFile(healthyListFile, `${JSON.stringify({ type: "user_message", content: "healthy list entry" })}\n`, "utf8");
    await fs.writeFile(corruptListFile, "{not-json}\n", "utf8");
    const summaries = await listSessionSummaries(workspaceRoot);
    assert.equal(summaries.some((summary) => summary.fileName === path.basename(healthyListFile)), true);
    assert.equal(summaries.some((summary) => summary.fileName === path.basename(corruptListFile)), false);
  });
}

async function testTurnStatusPersistence(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const secret = "not-a-real-turn-status-secret";
    const recorder = new SessionRecorder(workspaceRoot, "turn-status-session");
    recorder.record({ type: "user_message", content: "finish the project" });
    recorder.record({ type: "assistant_message", content: "I made partial progress." });
    recorder.record({
      type: "turn_status",
      status: "incomplete",
      stopReason: "hard_step_limit",
      steps: 96,
      summary: `Authorization: Bearer ${secret}`,
      resumable: true,
      blockedReason: undefined,
      requiredAction: `apiKey=${secret}`,
      affectedTodoIds: ["todo-1"]
    });
    await recorder.close();

    const raw = await fs.readFile(recorder.filePath, "utf8");
    assert.equal(raw.includes(secret), false);
    const events = parseSessionEvents(raw);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "turn_status");
    if (terminal?.type !== "turn_status") throw new Error("Expected a persisted turn_status event.");
    assert.equal(terminal.status, "incomplete");
    assert.equal(terminal.stopReason, "hard_step_limit");
    assert.equal(terminal.steps, 96);
    assert.equal(terminal.resumable, true);
    assert.deepEqual(terminal.affectedTodoIds, ["todo-1"]);

    const summary = (await listSessionSummaries(workspaceRoot)).find((item) => item.fileName === "turn-status-session.jsonl");
    assert.equal(summary?.lastTurnStatus?.status, "incomplete");
    assert.equal(summary?.lastTurnStatus?.resumable, true);
    assert.equal(summary?.lastAssistantMessage, "I made partial progress.");

    const replay = await replaySession(recorder.filePath);
    assert.deepEqual(replay.messages.map((message) => message.role), ["user", "assistant"]);
    assert.throws(
      () => parseSessionEvents(JSON.stringify({
        type: "turn_status",
        status: "unknown",
        stopReason: "test",
        steps: -1
      })),
      /Invalid session event at line 1/u
    );
  });
}

async function testSessionAndToolDisplayRedaction(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const toolCallId = "sk-test-tool-call-12345678";
    const userSecret = "not-a-real-user-bearer-value";
    const argumentSecret = "opaque-argument-value";
    const resultSecret = "opaque-result-value";
    const checkpointSecret = "not-a-real-checkpoint-bearer-value";
    const recorder = new SessionRecorder(workspaceRoot, "redacted-session");
    recorder.record({ type: "user_message", content: `Authorization: Bearer ${userSecret}` });
    recorder.record({
      type: "tool_call",
      tool: "external_probe",
      args: {
        apiKey: argumentSecret,
        webhookSecret: argumentSecret,
        nested: { authorization: `Bearer ${argumentSecret}` },
        safe: "visible"
      },
      toolCallId,
      sequence: 1
    });
    recorder.record({
      type: "tool_result",
      tool: "external_probe",
      result: {
        stdout: `token=${resultSecret}`,
        diffPreview: `+ refresh_token=${resultSecret}`,
        safe: "visible"
      },
      toolCallId,
      sequence: 1
    });
    recorder.record({
      type: "context_checkpoint",
      reason: "manual",
      summary: `## Goal\n- Authorization: Bearer ${checkpointSecret}`,
      firstKeptMessageIndex: 1,
      tokensBefore: 1_000,
      compactedMessages: 1,
      createdAt: "2026-08-02T00:00:00.000Z"
    });
    await recorder.close();

    const raw = await fs.readFile(recorder.filePath, "utf8");
    for (const secret of [userSecret, argumentSecret, resultSecret, checkpointSecret]) assert.equal(raw.includes(secret), false);
    assert.match(raw, /\[redacted\]/);
    const events = parseSessionEvents(raw);
    const call = events.find((event): event is Extract<SessionEvent, { type: "tool_call" }> => event.type === "tool_call");
    const result = events.find((event): event is Extract<SessionEvent, { type: "tool_result" }> => event.type === "tool_result");
    const checkpoint = events.find((event): event is Extract<SessionEvent, { type: "context_checkpoint" }> => event.type === "context_checkpoint");
    assert.equal(call?.toolCallId, toolCallId);
    assert.equal((call?.args as { apiKey?: string } | undefined)?.apiKey, "[redacted]");
    assert.equal((call?.args as { webhookSecret?: string } | undefined)?.webhookSecret, "[redacted]");
    assert.equal((result?.result as { safe?: string } | undefined)?.safe, "visible");
    assert.match(checkpoint?.summary ?? "", /\[redacted\]/u);

    const genericSecret = "opaque-generic-value";
    const generic = await createToolPermissionRequest({
      id: "generic-secret",
      name: "mcp_demo_probe",
      args: { apiKey: genericSecret, nested: { password: genericSecret }, safe: "visible" }
    }, { workspaceRoot, ignore: [], sessionId: "test" });
    assert.equal(JSON.stringify(generic).includes(genericSecret), false);
    assert.match(generic.details, /\[redacted\]/);

    const commandSecret = "not-a-real-command-bearer-value";
    const command = await createToolPermissionRequest({
      id: "command-secret",
      name: "run_command",
      args: { command: `curl -H 'Authorization: Bearer ${commandSecret}' https://example.invalid` }
    }, { workspaceRoot, ignore: [], sessionId: "test" });
    assert.equal(JSON.stringify(command).includes(commandSecret), false);

    const previewSecret = "not-a-real-preview-value";
    const write = await createToolPermissionRequest({
      id: "preview-secret",
      name: "write_file",
      args: { path: "safe-preview.txt", content: `apiKey=${previewSecret}\n` }
    }, { workspaceRoot, ignore: [], sessionId: "test" });
    assert.equal(JSON.stringify(write).includes(previewSecret), false);
    assert.match(write.preview ?? "", /\[redacted\]/);

    const defaultHiddenBody = "this file body stays behind ctrl+o";
    const conciseWrite = await createToolPermissionRequest({
      id: "concise-write",
      name: "write_file",
      args: { path: "concise.txt", content: defaultHiddenBody }
    }, { workspaceRoot, ignore: [], sessionId: "test" });
    assert.match(conciseWrite.details, /File: concise\.txt/u);
    assert.equal(conciseWrite.details.includes(defaultHiddenBody), false);
    assert.match(conciseWrite.preview ?? "", /this file body stays behind ctrl\+o/u);
  });
}

async function testLegacyAgentStateIsIgnored(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const legacyRoot = path.join(workspaceRoot, ".agent");
    await fs.mkdir(path.join(legacyRoot, "sessions"), { recursive: true });
    await fs.mkdir(path.join(legacyRoot, "attachments"), { recursive: true });
    await fs.writeFile(path.join(legacyRoot, "sessions", "legacy.jsonl"), `${JSON.stringify({ type: "user_message", content: "legacy history" })}\n`, "utf8");
    await fs.writeFile(path.join(legacyRoot, "attachments", "legacy.png"), "legacy image", "utf8");

    await ensureAgentDirs(workspaceRoot);
    await assert.rejects(fs.access(path.join(workspaceRoot, ".biny", "attachments", "legacy.png")));
    assert.equal(await fs.readFile(path.join(legacyRoot, "attachments", "legacy.png"), "utf8"), "legacy image");
    await assert.rejects(resolveSessionFile(workspaceRoot, "legacy"), /Session not found/u);
  });
}

async function testSessionPathBoundaries(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const safeFile = sessionFilePath(workspaceRoot, "2026-07-18-safe");
    const sessionsRoot = projectSessionsDir(await fs.realpath(workspaceRoot));
    assert.equal(path.relative(sessionsRoot, path.dirname(safeFile)), path.join("2026", "07", "18"));
    await fs.writeFile(safeFile, `${JSON.stringify({ type: "user_message", content: "safe session" })}\n`, "utf8");
    const canonicalSafeFile = await fs.realpath(safeFile);

    assert.equal(await resolveSessionFile(workspaceRoot, "2026-07-18-safe"), canonicalSafeFile);
    assert.equal(await resolveSessionFile(workspaceRoot, "2026-07"), canonicalSafeFile);
    assert.equal(await resolveSessionFile(workspaceRoot, "2026-07-18-safe.jsonl"), canonicalSafeFile);
    await assert.rejects(resolveSessionFile(workspaceRoot, ".biny/sessions/2026-07-18-safe.jsonl"), /Invalid session reference/u);
    assert.equal(await resolveSessionFile(workspaceRoot, "latest"), canonicalSafeFile);
    assert.match((await readSessionSnapshot(workspaceRoot, "2026-07-18-safe")).bytes.toString("utf8"), /safe session/);
    assert.equal((await readStoredSessionEvents(workspaceRoot, "2026-07-18-safe")).events[0]?.type, "user_message");
    const duplicatePath = await duplicateSessionFile(workspaceRoot, "2026-07-18-safe", "safe-copy");
    assert.equal(await fs.readFile(duplicatePath, "utf8"), await fs.readFile(safeFile, "utf8"));
    await deleteSessionFile(workspaceRoot, "safe-copy");
    await assert.rejects(fs.access(duplicatePath));
    const deleteTombstones = (await fs.readdir(path.dirname(duplicatePath)))
      .filter((fileName) => fileName.startsWith(".session-delete-") && fileName.endsWith(".delete"));
    assert.equal(deleteTombstones.length, 1);
    assert.equal((await fs.stat(path.join(path.dirname(duplicatePath), deleteTombstones[0] ?? "missing"))).size, 0);
    assert.equal((await listSessionFiles(workspaceRoot)).some((fileName) => fileName.endsWith(".delete")), false);

    assert.throws(() => sessionFilePath(workspaceRoot, "../outside"), /Invalid session id/);
    assert.throws(() => sessionFilePath(workspaceRoot, "nested/outside"), /Invalid session id/);
    assert.throws(() => sessionFilePath(workspaceRoot, "nested\\outside"), /Invalid session id/);
    assert.throws(() => sessionFilePath(workspaceRoot, "."), /Invalid session id/);
    assert.throws(() => sessionFilePath(workspaceRoot, ".."), /Invalid session id/);
    await assert.rejects(resolveSessionFile(workspaceRoot, safeFile), /Invalid session reference/);
    await assert.rejects(resolveSessionFile(workspaceRoot, "../outside.jsonl"), /Invalid session reference/);
    await assert.rejects(resolveSessionFile(workspaceRoot, ".biny/sessions/../outside.jsonl"), /Invalid session reference/);

    const sessionsDir = path.dirname(safeFile);
    await fs.mkdir(path.join(sessionsDir, "directory.jsonl"));
    await assert.rejects(resolveSessionFile(workspaceRoot, "directory.jsonl"), /regular \.jsonl file/);

    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "biny-session-outside-"));
    try {
      const outsideFile = path.join(outsideRoot, "outside.jsonl");
      const outsideContent = '{"type":"user_message"';
      await fs.writeFile(outsideFile, outsideContent, "utf8");
      await fs.symlink(outsideFile, path.join(sessionsDir, "linked.jsonl"));
      await assert.rejects(resolveSessionFile(workspaceRoot, "linked"), /regular \.jsonl file/);
      await assert.rejects(readSessionSnapshot(workspaceRoot, "linked"), /regular \.jsonl file/);
      await assert.rejects(duplicateSessionFile(workspaceRoot, "linked", "linked-copy"), /regular \.jsonl file/);
      await assert.rejects(deleteSessionFile(workspaceRoot, "linked"), /regular \.jsonl file/);

      const hardlinkedFile = path.join(sessionsDir, "hardlinked.jsonl");
      await fs.link(outsideFile, hardlinkedFile);
      await assert.rejects(resolveSessionFile(workspaceRoot, "hardlinked"), /single-link regular \.jsonl file/);
      await assert.rejects(readSessionSnapshot(workspaceRoot, "hardlinked"), /single-link regular \.jsonl file/);
      await assert.rejects(duplicateSessionFile(workspaceRoot, "2026-07-18-safe", "hardlinked"), /EEXIST/);
      await assert.rejects(deleteSessionFile(workspaceRoot, "hardlinked"), /single-link regular \.jsonl file/);
      await assert.rejects(repairSessionTailForAppend(hardlinkedFile), /single-link regular \.jsonl file/);
      assert.throws(() => new SessionRecorder(workspaceRoot, "hardlinked"), /single-link regular \.jsonl file/);
      assert.equal(await fs.readFile(outsideFile, "utf8"), outsideContent);

      const workspaceAlias = path.join(outsideRoot, "workspace-alias");
      await fs.symlink(workspaceRoot, workspaceAlias);
      assert.match((await readSessionSnapshot(workspaceAlias, "2026-07-18-safe")).bytes.toString("utf8"), /safe session/);

      const pinnedRecorder = new SessionRecorder(workspaceRoot, "pinned-before-parent-swap");
      const originalSessionsRoot = `${sessionsRoot}-original`;
      await fs.rename(sessionsRoot, originalSessionsRoot);
      await fs.symlink(outsideRoot, sessionsRoot);
      assert.throws(
        () => pinnedRecorder.record({ type: "user_message", content: "must not escape" }),
        /changed while it was being opened|ENOENT/
      );
      await pinnedRecorder.close();
      await assert.rejects(fs.access(path.join(outsideRoot, "pinned-before-parent-swap.jsonl")));
      await fs.rm(sessionsRoot, { force: true });
      await fs.rename(originalSessionsRoot, sessionsRoot);

      const config = testConfig();
      config.context.memory.useMemories = false;
      config.context.memory.generateMemories = false;
      const provider = new ContextTestModel();
      const agent = new AgentSession({
        workspaceRoot,
        config,
        model: provider.model,
        toolRegistry: new ToolRegistry(),
        permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
        recorder: new SessionRecorder(workspaceRoot)
      });
      await agent.initialize();
      await assert.rejects(agent.resume("linked.jsonl"), /regular \.jsonl file/);
      assert.equal(await fs.readFile(outsideFile, "utf8"), outsideContent);
      await agent.close();

      const outsideSessionsDir = path.dirname(sessionFilePath(workspaceRoot, "outside"));
      await fs.rm(outsideSessionsDir, { recursive: true, force: true });
      await fs.symlink(outsideRoot, outsideSessionsDir);
      await assert.rejects(resolveSessionFile(workspaceRoot, "outside"), /real directory, not a symbolic link/);
      await assert.rejects(readSessionSnapshot(workspaceRoot, "outside"), /real directory, not a symbolic link/);
      await assert.rejects(duplicateSessionFile(workspaceRoot, "outside", "must-not-copy"), /real directory, not a symbolic link/);
      await assert.rejects(deleteSessionFile(workspaceRoot, "outside"), /real directory, not a symbolic link/);
      await assert.rejects(ensureAgentDirs(workspaceRoot), /real directory, not a symbolic link/);
      assert.throws(() => new SessionRecorder(workspaceRoot, "must-not-escape"), /real directory, not a symbolic link/);
      await assert.rejects(fs.access(path.join(outsideRoot, "must-not-escape.jsonl")));

      await fs.rm(outsideSessionsDir, { force: true });
      await fs.rm(path.join(workspaceRoot, ".biny"), { recursive: true, force: true });
      await fs.symlink(outsideRoot, path.join(workspaceRoot, ".biny"));
      await assert.rejects(ensureAgentDirs(workspaceRoot), /real directory, not a symbolic link/);
      await assert.rejects(fs.access(path.join(outsideRoot, "sessions")));
      assert.equal(await fs.readFile(outsideFile, "utf8"), outsideContent);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
}

async function testGlobalSessionsStayProjectScoped(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const otherWorkspace = await mkdtemp(path.join(os.tmpdir(), "biny-context-other-"));
    try {
      await Promise.all([ensureAgentDirs(workspaceRoot), ensureAgentDirs(otherWorkspace)]);
      const firstPath = sessionFilePath(workspaceRoot, "shared-id");
      const secondPath = sessionFilePath(otherWorkspace, "shared-id");
      assert.notEqual(path.dirname(firstPath), path.dirname(secondPath));
      await Promise.all([
        fs.writeFile(firstPath, `${JSON.stringify({ type: "user_message", content: "first project" })}\n`, "utf8"),
        fs.writeFile(secondPath, `${JSON.stringify({ type: "user_message", content: "second project" })}\n`, "utf8")
      ]);
      assert.match((await readSessionSnapshot(workspaceRoot, "latest")).bytes.toString("utf8"), /first project/u);
      assert.match((await readSessionSnapshot(otherWorkspace, "latest")).bytes.toString("utf8"), /second project/u);
    } finally {
      await rm(otherWorkspace, { recursive: true, force: true });
    }
  });
}

async function testSessionReadLimits(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const healthyFile = sessionFilePath(workspaceRoot, "bounded-healthy");
    await fs.writeFile(healthyFile, `${JSON.stringify({ type: "user_message", content: "healthy bounded session" })}\n`, "utf8");
    const oversizedFile = sessionFilePath(workspaceRoot, "oversized-session");
    await fs.writeFile(oversizedFile, "", "utf8");
    await fs.truncate(oversizedFile, maxSessionFileBytes + 1);

    // 校验与写入路径保持严格：这些地方发现超限就该停下。
    await assert.rejects(readSessionEvents(oversizedFile), /maximum size/u);
    await assert.rejects(repairSessionTailForAppend(oversizedFile), /maximum size/u);
    // 打开路径改为读尾部并标注截断。超限就整条会话打不开，而用户是在想恢复它的时候才发现，
    // 这个失败模式比只拿到最近历史糟糕得多。
    const oversizedSnapshot = await readSessionSnapshot(workspaceRoot, "oversized-session");
    assert.equal(oversizedSnapshot.truncated, true);
    const oversizedRecorder = new SessionRecorder(workspaceRoot, "oversized-session");
    assert.throws(() => oversizedRecorder.readText(), /maximum size/u);
    await oversizedRecorder.close();

    const summaries = await listSessionSummaries(workspaceRoot);
    assert.equal(summaries.some((summary) => summary.fileName === path.basename(healthyFile)), true);
    assert.equal(summaries.some((summary) => summary.fileName === path.basename(oversizedFile)), false);

    const oversizedLine = JSON.stringify({ type: "user_message", content: "x".repeat(maxSessionEventLineBytes) });
    assert.throws(() => parseSessionEvents(`${oversizedLine}\n`), /event line 1 exceeds the maximum size/u);
    const eventLine = JSON.stringify({ type: "user_message", content: "bounded event" });
    const tooManyEvents = `${Array.from({ length: maxSessionEvents + 1 }, () => eventLine).join("\n")}\n`;
    assert.throws(() => parseSessionEvents(tooManyEvents), /cannot contain more than/u);
  });
}

async function testDeleteSessionReplacementRace(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const targetPath = sessionFilePath(workspaceRoot, "delete-race");
    const pinnedBackupPath = path.join(path.dirname(targetPath), "delete-race.pinned-backup");
    const originalContent = `${JSON.stringify({ type: "user_message", content: "original target" })}\n`;
    const replacementContent = `${JSON.stringify({ type: "user_message", content: "replacement must survive" })}\n`;
    await fs.writeFile(targetPath, originalContent, "utf8");

    let injected = false;
    await assert.rejects(deleteSessionFile(workspaceRoot, "delete-race", {
      beforeTombstoneMove: async ({ filePath }) => {
        injected = true;
        await fs.rename(filePath, pinnedBackupPath);
        await fs.writeFile(targetPath, replacementContent, "utf8");
      }
    }), /changed during deletion/u);

    assert.equal(injected, true);
    assert.equal(await fs.readFile(pinnedBackupPath, "utf8"), originalContent);
    assert.equal(await fs.readFile(targetPath, "utf8"), replacementContent);
    const tombstones = (await fs.readdir(path.dirname(targetPath)))
      .filter((fileName) => fileName.startsWith(".session-delete-") && fileName.endsWith(".delete"));
    assert.equal(tombstones.length, 1);
    assert.equal(await fs.readFile(path.join(path.dirname(targetPath), tombstones[0] ?? "missing"), "utf8"), replacementContent);

    const lateTargetPath = sessionFilePath(workspaceRoot, "delete-late-race");
    const pinnedAfterVerificationPath = path.join(path.dirname(lateTargetPath), "delete-late-race.pinned-after-verification");
    const lateOriginalContent = `${JSON.stringify({ type: "user_message", content: "late original" })}\n`;
    const lateReplacementContent = `${JSON.stringify({ type: "user_message", content: "late replacement must survive" })}\n`;
    await fs.writeFile(lateTargetPath, lateOriginalContent, "utf8");
    let replacedTombstonePath = "";
    await deleteSessionFile(workspaceRoot, "delete-late-race", {
      afterTombstoneVerified: async ({ tombstonePath }) => {
        replacedTombstonePath = tombstonePath;
        await fs.rename(tombstonePath, pinnedAfterVerificationPath);
        await fs.writeFile(tombstonePath, lateReplacementContent, "utf8");
      }
    });
    await assert.rejects(fs.access(lateTargetPath));
    assert.equal((await fs.stat(pinnedAfterVerificationPath)).size, 0);
    assert.equal(await fs.readFile(replacedTombstonePath, "utf8"), lateReplacementContent);
  });
}

async function testFailedCurrentSessionResumeKeepsRecorderUsable(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const brokenSessionId = "broken-current";
    const brokenFile = sessionFilePath(workspaceRoot, brokenSessionId);
    await fs.writeFile(brokenFile, [
      JSON.stringify({ type: "user_message", content: "valid prefix" }),
      "{not-json}",
      JSON.stringify({ type: "assistant_message", content: "valid suffix" })
    ].join("\n") + "\n", "utf8");
    const config = testConfig();
    config.context.memory.useMemories = false;
    config.context.memory.generateMemories = false;
    const provider = new ContextTestModel();
    const agent = new AgentSession({
      workspaceRoot,
      config,
      model: provider.model,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
      recorder: new SessionRecorder(workspaceRoot, brokenSessionId)
    });
    await agent.initialize();

    await assert.rejects(agent.resume(brokenSessionId), /Invalid JSONL event at line 2/);
    const fallbackSession = agent.getInfo();
    assert.notEqual(fallbackSession.sessionId, brokenSessionId);
    assert.equal((await agent.runTask("continue in a healthy session")).output, "ok");
    await agent.close();
    const fallbackEvents = await readSessionEvents(fallbackSession.sessionFile);
    assert.deepEqual(fallbackEvents.map((event) => event.type), ["user_message", "agent_message", "assistant_message", "turn_status"]);
    assert.equal(fallbackEvents.at(-1)?.type === "turn_status" ? fallbackEvents.at(-1).status : undefined, "completed");
  });
}

async function testCredentialAndSymlinkBoundaries(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.writeFile(path.join(workspaceRoot, "config.json"), JSON.stringify({ providers: { demo: { apiKey: "test-secret-value" } } }), "utf8");
    assert.throws(() => resolveWorkspacePath(workspaceRoot, "config.json", []), /ignored by workspace policy/);
    assert.throws(() => resolveWorkspacePath(workspaceRoot, ".env.local", []), /ignored by workspace policy/);
    assert.throws(() => resolveWorkspacePath(workspaceRoot, ".envrc", []), /ignored by workspace policy/);
    assert.equal(redactSecrets('{"apiKey":"test-secret-value"}'), '{"apiKey":"[redacted]"}');
    await fs.symlink(path.join(workspaceRoot, "config.json"), path.join(workspaceRoot, "config-link.json"));
    assert.throws(() => resolveWorkspacePath(workspaceRoot, "config-link.json", []), /resolves to a location ignored/);
    const criticalWrite = await createToolPermissionRequest({
      id: "critical-write",
      name: "write_file",
      args: { path: ".zshrc", content: "export SAFE_TEST=1\n" }
    }, { workspaceRoot, ignore: [], sessionId: "test-session" });
    assert.equal(criticalWrite.riskLevel, "critical");
    assert.equal(criticalWrite.requireFullYes, true);

    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "biny-outside-"));
    try {
      await fs.writeFile(path.join(outsideRoot, "secret.txt"), "outside", "utf8");
      await fs.symlink(path.join(outsideRoot, "secret.txt"), path.join(workspaceRoot, "linked-secret.txt"));
      await fs.symlink(outsideRoot, path.join(workspaceRoot, "linked-directory"));
      await fs.symlink(path.join(outsideRoot, "future.txt"), path.join(workspaceRoot, "dangling-secret.txt"));
      assert.throws(() => resolveWorkspacePath(workspaceRoot, "linked-secret.txt", []), /symbolic link/);
      assert.throws(() => resolveWorkspacePath(workspaceRoot, "linked-directory/new.txt", []), /symbolic link/);
      assert.throws(() => resolveWorkspacePath(workspaceRoot, "dangling-secret.txt", []), /dangling symbolic link/);

      await ensureAgentDirs(workspaceRoot);
      const telemetryPath = path.join(workspaceRoot, ".biny", "telemetry.jsonl");
      const telemetryConfig = {
        ...defaultConfig,
        telemetry: { enabled: true, recordInputs: false, recordOutputs: true }
      };
      await recordNativeTelemetry(telemetryConfig, workspaceRoot, {
        type: "start",
        provider: "test",
        modelId: "test",
        input: "must-not-be-recorded"
      });
      await recordNativeTelemetry(telemetryConfig, workspaceRoot, {
        type: "step",
        provider: "test",
        modelId: "test",
        step: 1,
        finishReason: "stop",
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        output: "visible-output"
      });
      await recordNativeTelemetry(telemetryConfig, workspaceRoot, {
        type: "end",
        provider: "test",
        modelId: "test",
        steps: 1,
        output: "visible-output"
      });
      await recordNativeTelemetry(telemetryConfig, workspaceRoot, {
        type: "request",
        provider: "test",
        modelId: "test",
        metrics: {
          requestId: "request-1",
          provider: "test",
          modelId: "test",
          startedAt: "2026-08-06T00:00:00.000Z",
          durationMs: 120,
          timeToFirstEventMs: 20,
          timeToFirstOutputMs: 40,
          attempts: [{ attempt: 1, durationMs: 100, status: 200, willRetry: false }],
          status: 200,
          finishReason: "stop",
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
          eventCount: 4,
          requestContext: {
            sessionId: "session-1",
            runId: "run-1",
            turnId: "turn-1",
            step: 2,
            operation: "agent",
            relatedToolCallIds: ["call-1"]
          }
        }
      });
      const telemetryEvents = (await fs.readFile(telemetryPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(telemetryEvents.map((event) => event.type), ["start", "step", "end", "request"]);
      assert.equal(telemetryEvents[0]?.input, undefined);
      assert.equal(telemetryEvents[1]?.output, '"visible-output"');
      assert.equal(telemetryEvents[3]?.requestId, "request-1");
      assert.equal(telemetryEvents[3]?.durationMs, 120);
      assert.deepEqual(telemetryEvents[3]?.requestContext, {
        sessionId: "session-1",
        runId: "run-1",
        turnId: "turn-1",
        step: 2,
        operation: "agent",
        relatedToolCallIds: ["call-1"]
      });
      await fs.rm(telemetryPath);
      const telemetryVictim = path.join(outsideRoot, "telemetry-victim.txt");
      await fs.writeFile(telemetryVictim, "telemetry-victim-unchanged", "utf8");
      await fs.symlink(telemetryVictim, telemetryPath);
      await recordNativeTelemetry(telemetryConfig, workspaceRoot, { type: "end", provider: "test", modelId: "test", steps: 1 });
      assert.equal(await fs.readFile(telemetryVictim, "utf8"), "telemetry-victim-unchanged");
      await fs.rm(telemetryPath);
      await fs.link(telemetryVictim, telemetryPath);
      await recordNativeTelemetry(telemetryConfig, workspaceRoot, { type: "end", provider: "test", modelId: "test", steps: 1 });
      assert.equal(await fs.readFile(telemetryVictim, "utf8"), "telemetry-victim-unchanged");

      const historyPath = path.join(workspaceRoot, ".biny", "input-history.jsonl");
      const historyVictim = path.join(outsideRoot, "history-victim.txt");
      await fs.writeFile(historyVictim, "history-victim-unchanged", "utf8");
      await fs.symlink(historyVictim, historyPath);
      await assert.rejects(appendInputHistory(workspaceRoot, "must not escape"), /single-link regular file/);
      await assert.rejects(loadInputHistory(workspaceRoot), /single-link regular file/);
      assert.equal(await fs.readFile(historyVictim, "utf8"), "history-victim-unchanged");
      await fs.rm(historyPath);
      await fs.link(historyVictim, historyPath);
      await assert.rejects(appendInputHistory(workspaceRoot, "must not escape"), /single-link regular file/);
      assert.equal(await fs.readFile(historyVictim, "utf8"), "history-victim-unchanged");
      await fs.rm(historyPath);
      const agentPath = path.join(workspaceRoot, ".biny");
      const originalAgentPath = path.join(workspaceRoot, ".biny-original");
      await fs.rename(agentPath, originalAgentPath);
      await fs.symlink(outsideRoot, agentPath);
      await assert.rejects(appendInputHistory(workspaceRoot, "must not escape through parent"), /real directory/);
      await assert.rejects(loadInputHistory(workspaceRoot), /real canonical directory/);
      await assert.rejects(fs.access(path.join(outsideRoot, "input-history.jsonl")));
      await fs.rm(agentPath);
      await fs.rename(originalAgentPath, agentPath);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
}

async function testMemoryRedactionDedupAndWriter(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const storeProvider = new ContextTestModel();
    const store = new LocalMemory(workspaceRoot, () => storeProvider.model);
    const oldMemoryDir = path.join(workspaceRoot, ".biny", "memory");
    await fs.mkdir(oldMemoryDir, { recursive: true });
    await fs.writeFile(path.join(oldMemoryDir, "old.md"), "This old project-local memory must not be loaded.", "utf8");
    assert.deepEqual(await store.listTopics(), []);
    const first = await store.write({
      topic: "debugging",
      title: "Context refresh result",
      summary: "Refresh src/agent/context/ContextMemory.ts after write_file. apiKey=sk-supersecretvalue123.",
      decisions: ["Use deterministic Markdown memory."],
      paths: ["src/agent/context/ContextMemory.ts"],
      keywords: ["context", "refresh"]
    });
    assert.equal(first.written, true);
    const duplicate = await store.write({
      topic: "debugging",
      title: "Context refresh result",
      summary: "Refresh src/agent/context/ContextMemory.ts after write_file. apiKey=sk-supersecretvalue123.",
      decisions: ["Use deterministic Markdown memory."],
      paths: ["src/agent/context/ContextMemory.ts"],
      keywords: ["context", "refresh"]
    });
    assert.equal(duplicate.written, false);

    const debugFile = path.join(projectMemoryDir(await fs.realpath(workspaceRoot)), "entries", "debugging.md");
    const stored = await fs.readFile(debugFile, "utf8");
    assert.equal(stored.includes("sk-supersecretvalue123"), false);
    assert.match(stored, /\[redacted\]/);
    assert.match(redactSecrets("Authorization: Bearer abcdefghijklmnop"), /\[redacted\]/);
    assert.equal(redactSecrets("aws_secret_access_key=not-a-real-value"), "aws_secret_access_key=[redacted]");
    assert.equal(redactSecrets("-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----"), "[redacted private key]");
    assert.equal((await store.findRelevant("context refresh", ["src/agent/context/ContextMemory.ts"])).length > 0, true);
    const abortedLookup = new AbortController();
    abortedLookup.abort();
    await assert.rejects(store.findRelevant("context refresh", [], 3, abortedLookup.signal), /abort/i);

    await store.rememberSuccessfulTask(
      "Implement a deterministic context refresh workflow for tool writes. ".repeat(4),
      "The runtime now refreshes the snapshot and RepoMap after write_file before the next turn. ".repeat(4)
    );
    assert.equal((await store.listTopics()).includes("workflows"), true);
  });
}

async function testMemoryQueueLifecycleAndUsagePersistence(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    let active = 0;
    let peak = 0;
    let started = 0;
    const queuedMemory = {
      rememberSuccessfulTask: async (): Promise<void> => {
        const index = started;
        started += 1;
        active += 1;
        peak = Math.max(peak, active);
        await (index === 0 ? firstGate.promise : secondGate.promise);
        active -= 1;
      }
    } as unknown as LocalMemory;
    const memory = new ContextMemory(
      () => new ContextTestModel().model,
      new WorkspaceContext(workspaceRoot, [], 32 * 1024),
      queuedMemory,
      24_000,
      32 * 1024
    );
    memory.queueSuccessfulTask("first", "answer");
    memory.queueSuccessfulTask("second", "answer");
    await waitUntil(() => started === 1);
    assert.equal(peak, 1);
    firstGate.resolve(undefined);
    await waitUntil(() => started === 2);
    assert.equal(peak, 1);
    secondGate.resolve(undefined);
    await memory.flush();

    let stuckStarted = false;
    const stuckMemory = {
      rememberSuccessfulTask: async (): Promise<void> => {
        stuckStarted = true;
        await new Promise<void>(() => undefined);
      }
    } as unknown as LocalMemory;
    const bounded = new ContextMemory(
      () => new ContextTestModel().model,
      new WorkspaceContext(workspaceRoot, [], 32 * 1024),
      stuckMemory,
      24_000,
      32 * 1024
    );
    bounded.queueSuccessfulTask("stuck", "answer");
    await waitUntil(() => stuckStarted);
    const shutdownStartedAt = Date.now();
    await bounded.shutdownMemory(20);
    assert.ok(Date.now() - shutdownStartedAt < 800);

    const config = testConfig();
    config.context.memory.useMemories = true;
    config.context.memory.generateMemories = true;
    const provider = new ContextTestModel();
    await ensureAgentDirs(workspaceRoot);
    const recorder = new SessionRecorder(workspaceRoot, "memory-usage");
    const agent = new AgentSession({
      workspaceRoot,
      config,
      model: provider.model,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
      recorder
    });
    await agent.initialize();
    await agent.runTask(`Remember this successful context workflow: ${"grounded details ".repeat(20)}`);
    const overview = await agent.getLocalMemory().getOverview();
    await agent.close();
    const replay = await replaySession(recorder.filePath);
    assert.equal(overview.scopes.project.candidateCount, 1);
    assert.equal(replay.usage.some((usage) => usage.operation === "memory"), false);

    const shortAgent = new AgentSession({
      workspaceRoot,
      config,
      model: new ContextTestModel().model,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
      recorder: new SessionRecorder(workspaceRoot, "short-memory-usage")
    });
    await shortAgent.initialize();
    await shortAgent.runTask("hi");
    const afterShortTurn = await shortAgent.getLocalMemory().getOverview();
    await shortAgent.close();
    assert.equal(afterShortTurn.scopes.project.candidateCount, 1);
  });
}

async function testMemoryEntryManagementAndCjkSearch(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const provider = new ContextTestModel();
    const store = new LocalMemory(workspaceRoot, () => provider.model);
    await store.write({
      topic: "project",
      title: "Weather workflow",
      summary: "使用 wttr.in 获取天气并渲染 Markdown 表格。",
      decisions: [],
      paths: [],
      keywords: ["weather"]
    });
    await store.write({
      topic: "project",
      title: "Weather retries",
      summary: "wttr.in 请求失败时最多重试三次并按指数退避。",
      decisions: [],
      paths: [],
      keywords: ["retry"]
    });

    // 中文查询没有空格分界，必须靠 bigram 命中记忆内容。
    const matches = await store.findRelevant("天气怎么获取", []);
    assert.equal(matches.length > 0, true);
    assert.equal(matches[0]?.topic, "project");

    const entries = await store.listEntries();
    assert.equal(entries.length, 2);
    assert.equal(entries.every((entry) => entry.topic === "project"), true);
    assert.equal(entries.some((entry) => entry.title === "Weather retries"), true);

    const compaction = await store.compactTopics(["project"]);
    assert.equal(compaction[0]?.before, 2);
    assert.equal(compaction[0]?.after, 1);
    assert.equal(compaction[0]?.error, undefined);
    assert.equal((await store.listEntries()).length, 1);

    // 删掉最后一条后，话题文件与索引行应一起消失。
    assert.equal(await store.deleteEntry("project", 0), true);
    assert.equal((await store.listTopics()).includes("project"), false);
    assert.equal((await store.readIndex())?.includes("project.md") ?? false, false);
    assert.equal(await store.deleteEntry("project", 0), false);
  });
}

async function testMemoryStorageBoundaries(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-outside-"));
    const store = new LocalMemory(workspaceRoot, () => new ContextTestModel().model);
    const entry = {
      topic: "debugging",
      title: "Safe local memory boundary",
      summary: "This sufficiently long test summary must never be written through an unsafe memory link.",
      decisions: [],
      paths: [],
      keywords: ["boundary"]
    };
    try {
      const victim = path.join(outsideRoot, "victim.md");
      const victimContent = "outside-memory-must-stay-unchanged";
      await fs.writeFile(victim, victimContent, "utf8");
      const memoryDir = projectMemoryDir(await fs.realpath(workspaceRoot));
      await fs.mkdir(path.dirname(memoryDir), { recursive: true });

      await fs.symlink(outsideRoot, memoryDir);
      await assert.rejects(store.findRelevant("outside-memory", []), /real directory, not a symbolic link/);
      await assert.rejects(store.write(entry), /real directory, not a symbolic link/);
      assert.equal(await fs.readFile(victim, "utf8"), victimContent);

      await fs.rm(memoryDir, { force: true });
      await fs.mkdir(memoryDir);
      await fs.symlink(victim, path.join(memoryDir, "MEMORY.md"));
      await assert.rejects(store.findRelevant("outside-memory", []), /single regular file/);
      await assert.rejects(store.write(entry), /single regular file/);
      assert.equal(await fs.readFile(victim, "utf8"), victimContent);

      await fs.rm(path.join(memoryDir, "MEMORY.md"), { force: true });
      const entriesDir = path.join(memoryDir, "entries");
      await fs.mkdir(entriesDir);
      await fs.link(victim, path.join(entriesDir, "debugging.md"));
      await assert.rejects(store.listTopics(), /single regular file/);
      await assert.rejects(store.write(entry), /single regular file/);
      assert.equal(await fs.readFile(victim, "utf8"), victimContent);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
}

async function testToolWriteMarksSnapshotAndRepoMapDirty(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "context-test" }), "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "existing.ts"), "export const existing = true;\n", "utf8");

    const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
    const memoryProvider = new ContextTestModel();
    const memory = new ContextMemory(() => memoryProvider.model, workspace, undefined, 24_000, 32 * 1024);
    await memory.initialize();
    assert.equal((await memory.status()).snapshotDirty, false);

    await fs.writeFile(path.join(workspaceRoot, "src", "new.ts"), "export const created = true;\n", "utf8");
    memory.observeToolResult("write_file", { path: "src/new.ts" }, { path: "src/new.ts", bytes: 28 });
    const dirty = await memory.status();
    assert.equal(dirty.snapshotDirty, true);
    assert.equal(dirty.repoMapDirty, true);
    assert.equal(dirty.activePaths.includes("src/new.ts"), true);

    const { messages } = await memory.prepareTurn("review src/new.ts", "system");
    assert.equal(messages.at(-1)?.content, "review src/new.ts");
    const refreshed = await memory.status();
    assert.equal(refreshed.snapshotDirty, false);
    assert.equal(refreshed.repoMapDirty, false);
  });
}

async function testSessionSummariesSortByUpdatedAt(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const older = new SessionRecorder(workspaceRoot, "older-summary");
    older.record({ type: "user_message", content: "older", time: "2026-01-01T00:00:00.000Z" });
    await older.close();

    const newer = new SessionRecorder(workspaceRoot, "newer-summary");
    newer.record({ type: "user_message", content: "newer", time: "2026-01-02T00:00:00.000Z" });
    await newer.close();

    assert.deepEqual(
      (await listSessionSummaries(workspaceRoot)).map((summary) => summary.fileName),
      ["newer-summary.jsonl", "older-summary.jsonl"]
    );
  });
}

function hasToolCall(message: AgentMessage | undefined, toolCallId: string): boolean {
  return Boolean(message?.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.id === toolCallId));
}

function hasToolResult(message: AgentMessage | undefined, toolCallId: string): boolean {
  return message?.role === "toolResult" && message.toolCallId === toolCallId;
}

function testConfig(): AgentConfig {
  return JSON.parse(JSON.stringify(defaultConfig)) as AgentConfig;
}

async function withTempWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-context-"));
  try {
    await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for context test condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

await main();
