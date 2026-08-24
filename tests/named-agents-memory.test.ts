import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { runMemoryCommand } from "../src/agent/context/memoryCommands.js";
import { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";
import { BINY_AGENT_DIR_ENV, globalAgentDir } from "../src/config/paths.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import {
  buildSubagentDefinitionsPrompt,
  findSubagentDefinition,
  loadSubagentDefinitions
} from "../src/extensions/agents.js";
import { createMemoryTools } from "../src/extensions/memory.js";
import { runSubagentTask, type SubagentOptions } from "../src/extensions/subagent.js";
import { createNativeModelSettings } from "../src/llm/nativeFactory.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";
import { SubagentTaskManager } from "../src/runtime/SubagentTaskManager.js";
import type { AgentModel } from "../src/agent/core/types.js";

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-named-agents-"));
  const globalRoot = await mkdtemp(path.join(os.tmpdir(), "biny-named-agents-global-"));
  const previousGlobalRoot = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = globalRoot;
  try {
    await testSubagentDefinitionLoading(workspaceRoot);
    await testSubagentDefinitionBoundaries(workspaceRoot);
    await testSubagentTaskManagerAgentThreading();
    await testSubagentBudgetExhaustionReturnsPartialFindings();
    await testMemoryTopicLifecycle();
    await testMemoryTools();
    await testMaintenanceDerivedIndexSync();
    await testGlobalInstructionFile();
  } finally {
    if (previousGlobalRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previousGlobalRoot;
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(globalRoot, { recursive: true, force: true });
  }
}

async function testSubagentDefinitionLoading(workspaceRoot: string): Promise<void> {
  const projectDir = path.join(workspaceRoot, ".biny", "agents");
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, "scout.md"), [
    "---",
    "name: scout",
    "description: Read-only reconnaissance over the repository.",
    "tools: read_file, grep_search, read_file",
    "model: deepseek-v4-flash",
    "---",
    "Locate relevant files and report exact paths with line ranges."
  ].join("\n"), "utf8");
  // 文件名兜底命名 + 无 tools/model。
  await writeFile(path.join(projectDir, "Reviewer Agent.md"), [
    "---",
    "description: Reviews diffs for regressions.",
    "---",
    "Review the change set and report concrete risks."
  ].join("\n"), "utf8");
  // 缺 description 的定义应被跳过。
  await writeFile(path.join(projectDir, "invalid.md"), "---\nname: broken\n---\nBody only.", "utf8");

  const globalRoot = await mkdtemp(path.join(os.tmpdir(), "biny-global-agents-"));
  try {
    // 全局同名 scout 应被项目级覆盖；独有的 planner 应保留。
    await writeFile(path.join(globalRoot, "scout.md"), "---\ndescription: global scout\n---\nGlobal scout body.", "utf8");
    await writeFile(path.join(globalRoot, "planner.md"), "---\ndescription: Plans implementation steps.\n---\nProduce a step-by-step plan.", "utf8");

    const definitions = await loadSubagentDefinitions({
      workspaceRoot,
      projectPaths: [".biny/agents"],
      globalRoot
    });
    assert.deepEqual(definitions.map((definition) => definition.name).sort(), ["planner", "reviewer-agent", "scout"]);

    const scout = findSubagentDefinition(definitions, "Scout");
    assert.ok(scout);
    assert.equal(scout.scope, "project");
    assert.equal(scout.model, "deepseek-v4-flash");
    assert.deepEqual(scout.tools, ["read_file", "grep_search"]);
    assert.match(scout.prompt, /exact paths with line ranges/);
    assert.equal(scout.path, path.join(".biny", "agents", "scout.md"));

    const planner = findSubagentDefinition(definitions, "planner");
    assert.equal(planner?.scope, "global");
    assert.equal(planner?.tools, undefined);

    const prompt = buildSubagentDefinitionsPrompt(definitions);
    assert.match(prompt, /Named subagents/);
    assert.match(prompt, /scout \(project, model deepseek-v4-flash, tools read_file\/grep_search\)/);
    assert.match(prompt, /delegate_task/);
    assert.equal(buildSubagentDefinitionsPrompt([]), "");
  } finally {
    await rm(globalRoot, { recursive: true, force: true });
  }
}

async function testSubagentDefinitionBoundaries(workspaceRoot: string): Promise<void> {
  const outside = await mkdtemp(path.join(os.tmpdir(), "biny-agents-outside-"));
  try {
    await writeFile(path.join(outside, "evil.md"), "---\ndescription: escaped\n---\nEscaped body.", "utf8");
    // 指向 workspace 外的软链文件应被跳过，不成为定义。
    const projectDir = path.join(workspaceRoot, ".biny", "agents");
    await symlink(path.join(outside, "evil.md"), path.join(projectDir, "evil.md"));
    const definitions = await loadSubagentDefinitions({
      workspaceRoot,
      projectPaths: [".biny/agents"],
      globalRoot: path.join(outside, "missing-global")
    });
    assert.ok(!definitions.some((definition) => definition.name === "evil"));

    // 配置目录本身是软链时必须硬失败。
    await symlink(outside, path.join(workspaceRoot, "linked-agents"));
    await assert.rejects(
      loadSubagentDefinitions({ workspaceRoot, projectPaths: ["linked-agents"], globalRoot: path.join(outside, "missing-global") }),
      /symbolic link/
    );
    // 越界路径同样拒绝。
    await assert.rejects(
      loadSubagentDefinitions({ workspaceRoot, projectPaths: ["../escape"], globalRoot: path.join(outside, "missing-global") }),
      /inside workspace/
    );
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
}

async function testSubagentTaskManagerAgentThreading(): Promise<void> {
  const seenAgents: Array<string | undefined> = [];
  const manager = new SubagentTaskManager({
    maxConcurrentSubagents: 1,
    timeoutMs: 5_000,
    execute: async (_task, context) => {
      seenAgents.push(context.agent);
      return "done";
    }
  });
  try {
    const withAgent = await manager.run("inspect the repo", { agent: "scout" });
    assert.equal(withAgent, "done");
    const withoutAgent = await manager.run("inspect the repo again");
    assert.equal(withoutAgent, "done");
    assert.deepEqual(seenAgents, ["scout", undefined]);
    const snapshots = manager.listSnapshots();
    assert.equal(snapshots.find((snapshot) => snapshot.agent === "scout")?.status, "completed");
  } finally {
    await manager.close();
  }
}

/** 模型每步都继续请求工具，验证步数预算截停时返回带标注的部分结论而不是抛错。 */
async function testSubagentBudgetExhaustionReturnsPartialFindings(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-subagent-partial-"));
  const originalFetch = globalThis.fetch;
  try {
    await ensureAgentDirs(workspaceRoot);
    let requestCount = 0;
    // 子代理走非流式 generate，返回 JSON chat completion；每步都继续请求工具。
    globalThis.fetch = (async (): Promise<Response> => {
      requestCount += 1;
      return jsonCompletionResponse({
        id: `cmpl-${String(requestCount)}`,
        object: "chat.completion",
        created: 0,
        model: "test-model",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: `Inspect round ${String(requestCount)}.`,
            tool_calls: [{ id: `list-${String(requestCount)}`, type: "function", function: { name: "list_files", arguments: "{}" } }]
          },
          finish_reason: "tool_calls"
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });
    }) as typeof fetch;

    const config = configSchema.parse({
      ...defaultConfig,
      defaultModel: "test-model",
      providers: { active: { type: "openai", apiKey: "test-key", baseUrl: "https://api.openai.com/v1" } },
      models: { "test-model": { provider: "active", model: "test-model" } },
      thinking: { enabled: false, effort: "high" },
      permission: defaultConfig.permission,
      workspace: defaultConfig.workspace,
      context: {
        ...defaultConfig.context,
        memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
      }
    });
    const registry = new ToolRegistry();
    registry.registerBuiltinTool(listFilesTool());
    const options: SubagentOptions = {
      workspaceRoot,
      config,
      getModelSettings: () => createNativeModelSettings(config),
      getAccessMode: () => "read-only",
      toolRegistry: registry
    };

    // "review …" 不含实现/调查关键词，命中最小 8 步预算。
    const output = await runSubagentTask(options, "review the current repository state");
    assert.match(output, /\[Partial result: the bounded subagent budget ran out after 8 steps/);
    assert.match(output, /Inspect round 1\./);
    assert.equal(requestCount, 8);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function listFilesTool(): Tool {
  return {
    name: "list_files",
    description: "List workspace files.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: z.object({}),
    capability: "filesystem.list",
    risk: "read",
    resolveExecution() {
      return { approvalRule: "list_files", async execute() { return { files: ["src/index.ts"] }; } };
    }
  } as Tool;
}

function jsonCompletionResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function unusedModel(): AgentModel {
  return {
    provider: "test",
    modelId: "unused",
    async stream() {
      return (async function* () { /* explicit memory operations do not call the model */ })();
    }
  };
}

async function testMemoryTopicLifecycle(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-cmd-"));
  try {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const oldMemoryDir = path.join(workspaceRoot, ".biny", "memory");
    await mkdir(oldMemoryDir, { recursive: true });
    await writeFile(path.join(oldMemoryDir, "old.md"), "Old project-local memory must remain ignored.", "utf8");

    const disabled = await runMemoryCommand(undefined, []);
    assert.match(disabled, /unavailable/);

    const empty = await runMemoryCommand(memory, ["list"]);
    assert.match(empty, /empty/);
    assert.deepEqual((await memory.listMemoryEntries()).entries, []);

    const added = await runMemoryCommand(memory, ["add", "decisions", "Always run pnpm typecheck before committing changes."]);
    assert.match(added, /Saved workspace\/fact memory/);

    const tooShort = await runMemoryCommand(memory, ["add", "decisions", "too short"]);
    assert.match(tooShort, /Skipped/);

    const listed = await runMemoryCommand(memory, ["list"]);
    assert.match(listed, /decisions/);

    const shown = await runMemoryCommand(memory, ["show", "decisions"]);
    assert.match(shown, /pnpm typecheck/);

    const searchCalls: Array<{ query: string; paths: string[]; origins: string[] | undefined; limit: number | undefined }> = [];
    const searchMemory = async (query: string, paths: string[], options: Parameters<LocalMemory["search"]>[2]) => {
      searchCalls.push({ query, paths, origins: options.origins, limit: options.limit });
      return await memory.search(query, paths, options);
    };
    const searched = await runMemoryCommand(memory, ["search", "typecheck"], searchMemory);
    assert.match(searched, /pnpm typecheck/);
    await runMemoryCommand(memory, ["search", "other", "typecheck"], searchMemory);
    assert.deepEqual(searchCalls, [
      { query: "typecheck", paths: [], origins: ["all"], limit: 8 },
      { query: "typecheck", paths: [], origins: ["other_workspaces"], limit: 8 }
    ]);

    const forgotten = await runMemoryCommand(memory, ["forget", "decisions"]);
    assert.match(forgotten, /Deleted 1 memory entry/);
    assert.deepEqual((await memory.listMemoryEntries()).entries, []);
    // 索引中的话题行也要被清掉。
    assert.equal((await memory.listMemoryEntries({ topic: "decisions" })).entries.length, 0);

    const missing = await runMemoryCommand(memory, ["forget", "decisions"]);
    assert.match(missing, /No memory entry or topic/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testMemoryTools(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-tools-"));
  try {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    let indexedEntryId: string | undefined;
    const [saveTool, recallTool] = createMemoryTools(
      () => memory,
      {
        indexEntry: async (entry) => {
          indexedEntryId = entry.id;
          throw new Error("injected derived index failure");
        }
      }
    );
    assert.equal(saveTool?.name, "save_memory");
    assert.equal(recallTool?.name, "recall_memory");
    assert.equal(saveTool.risk, "write");
    assert.equal(recallTool.risk, "read");

    const saveExecution = await saveTool.resolveExecution({
      topic: "workflows",
      title: "Release flow",
      summary: "Releases are cut from main after pnpm test and pnpm typecheck pass.",
      keywords: ["release", "main"]
    });
    assert.ok(!("isError" in saveExecution));
    const saved = await saveExecution.execute({ toolCallId: "save-1" }) as { saved: boolean; id?: string; path?: string };
    assert.equal(saved.saved, true);
    assert.equal(indexedEntryId, saved.id, "save_memory must notify the incremental index after committing Markdown");
    assert.equal(saved.path, path.relative(
      await realpath(globalAgentDir()),
      path.join(await realpath(globalAgentDir()), "memory", "entries", "workflows.md")
    ));

    // 无效参数走 isError 分支而不是抛异常。
    const invalid = await saveTool.resolveExecution({ topic: "x", title: "y", summary: "short" });
    assert.ok("isError" in invalid);

    const recallExecution = await recallTool.resolveExecution({ query: "release main" });
    assert.ok(!("isError" in recallExecution));
    const recalled = await recallExecution.execute({ toolCallId: "recall-1" }) as { matches: Array<{ topic: string }> };
    assert.equal(recalled.matches[0]?.topic, "workflows");

    const topicExecution = await recallTool.resolveExecution({ query: "anything", topic: "workflows" });
    assert.ok(!("isError" in topicExecution));
    const topicResult = await topicExecution.execute({ toolCallId: "recall-2" }) as {
      entries: Array<{ title: string }>;
    };
    assert.equal(topicResult.entries[0]?.title, "Release flow");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testMaintenanceDerivedIndexSync(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-maintenance-"));
  const agentRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-maintenance-agent-"));
  const previousAgentRoot = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = agentRoot;
  try {
    const memory = new LocalMemory(workspaceRoot, maintenanceModel);
    const existing = await memory.writeEntry({
      audience: "workspace",
      kind: "workflow",
      topic: "maintenance",
      title: "Existing maintenance rule",
      summary: "The existing durable workflow is kept before candidate consolidation.",
      lineage: { source: "explicit", externalContext: false }
    }, { expectedRevision: 0, now: new Date("2026-08-01T00:00:00.000Z") });
    await memory.enqueueCandidate({
      summary: "A completed task added another durable maintenance workflow for this workspace.",
      completed: true,
      lineage: {
        source: "completed_task",
        sessionId: "session-maintenance",
        turnId: "turn-maintenance",
        runId: "run-maintenance",
        externalContext: false
      },
      audienceHint: "workspace",
      kindHint: "workflow"
    }, {
      expectedRevision: existing.revision,
      excludeExternalContext: true,
      now: new Date("2026-08-01T01:00:00.000Z")
    });

    const indexedIds: string[] = [];
    let rebuildRequests = 0;
    const result = await memory.processEligibleCandidates(
      { now: new Date("2026-08-01T07:00:00.000Z") },
      {
        indexEntry: async (entry) => {
          indexedIds.push(entry.id);
          throw new Error("injected incremental index failure");
        },
        requestRebuild: () => { rebuildRequests += 1; }
      }
    );
    assert.equal(result.written, 1);
    assert.equal(result.failed, 0, "derived index failure must not roll back or fail Markdown maintenance");
    assert.equal(indexedIds.length, 1, "candidate promotion must first notify the incremental index");
    assert.equal(rebuildRequests, 1, "a consolidation replacement must invalidate the full derived generation");
    const entries = (await memory.listMemoryEntries({ origins: ["current_workspace"] })).entries;
    assert.equal(entries.length, 1);
    assert.notEqual(entries[0]?.id, indexedIds[0], "consolidation replaces IDs, so the earlier incremental vector is stale");
  } finally {
    if (previousAgentRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previousAgentRoot;
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(agentRoot, { recursive: true, force: true });
  }
}

function maintenanceModel(): AgentModel {
  return {
    provider: "test",
    modelId: "memory-maintenance",
    async stream(context) {
      const prompt = context.messages.flatMap((message) => (
        typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((content) => content.type === "text" ? [content.text] : [])
      )).join("\n");
      const text = prompt.includes("Consolidate this project memory topic file")
        ? JSON.stringify({
          entries: [{
            sourceEntryIds: [...prompt.matchAll(/"id":"([^"]+)"/gu)].map((match) => match[1]),
            kind: "workflow",
            topic: "maintenance",
            title: "Consolidated maintenance rules",
            summary: "Both durable maintenance workflows remain represented after consolidation.",
            decisions: [],
            paths: [],
            keywords: ["maintenance"],
            importance: 3
          }]
        })
        : JSON.stringify({
          memory: {
            audience: "workspace",
            kind: "workflow",
            topic: "maintenance",
            title: "Candidate maintenance rule",
            summary: "The completed task established another durable workspace maintenance workflow.",
            decisions: [],
            paths: [],
            keywords: ["maintenance"],
            importance: 3
          }
        });
      return (async function* () {
        yield { type: "text-delta" as const, text };
        yield { type: "finish" as const, reason: "stop" as const };
      })();
    }
  };
}

async function testGlobalInstructionFile(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-global-instructions-"));
  const globalDir = await mkdtemp(path.join(os.tmpdir(), "biny-global-home-"));
  try {
    await writeFile(path.join(workspaceRoot, "AGENTS.md"), "Project instructions.", "utf8");
    const globalFile = path.join(globalDir, "AGENTS.md");
    await writeFile(globalFile, "Global instructions baseline.", "utf8");

    const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024, globalFile);
    await workspace.initialize();
    const status = workspace.status();
    // 全局指令在项目指令之前加载。
    assert.equal(status.loadedInstructions[0], globalFile);
    assert.equal(status.loadedInstructions[1], "AGENTS.md");

    // 软链全局文件应被忽略。
    const linkedWorkspace = await mkdtemp(path.join(os.tmpdir(), "biny-global-linked-"));
    try {
      const linkPath = path.join(linkedWorkspace, "AGENTS.link.md");
      await symlink(globalFile, linkPath);
      const linked = new WorkspaceContext(linkedWorkspace, [], 32 * 1024, linkPath);
      await linked.initialize();
      assert.deepEqual(linked.status().loadedInstructions, []);
    } finally {
      await rm(linkedWorkspace, { recursive: true, force: true });
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(globalDir, { recursive: true, force: true });
  }
}

await main();
