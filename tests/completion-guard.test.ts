import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CompletionGuard,
  parseCompletionGuardSnapshot,
  type CompletionGuardInput
} from "../src/agent/completionGuard.js";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel } from "../src/agent/core/types.js";
import { defaultConfig, configSchema } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createWriteFileTool } from "../src/tools/file/writeFile.js";
import { createAttemptCompletionTool } from "../src/tools/completion.js";

async function main(): Promise<void> {
  testTodoDoesNotDriveRuntimeGate();
  testMutationMarksIndependentReview();
  testFailedToolCannotBecomeCompletion();
  testUnknownToolOperationBlocksAfterReview();
  testDeclarationNudgeFiresOnceThenReleases();
  testReadOnlyNeutralAnswerStopsFreely();
  testDeclarationSatisfiesGateAndTriggersReview();
  testPureQuestionTurnSkipsNudge();
  testDefaultModeSkipsNudgeWhenNotExpected();
  testTextClaimEscalatesToReview();
  testDeclarationSnapshotRoundTrip();
  await testAgentDoesNotFinishImmediatelyAfterMutation();
  await testEvaluatorFailureReleasesRun();
  console.log("completion guard tests passed");
}

function baseInput(overrides: Partial<CompletionGuardInput> = {}): CompletionGuardInput {
  return {
    steps: 1,
    hardStepLimit: 10,
    accountedToolCalls: 0,
    maxToolCalls: 20,
    maxRepeatedActionCount: 0,
    maxRepeatedActions: 3,
    finishReason: "stop",
    ...overrides
  };
}

function testTodoDoesNotDriveRuntimeGate(): void {
  const guard = new CompletionGuard();
  assert.deepEqual(guard.decide(baseInput()), { kind: "complete" });
}

function testMutationMarksIndependentReview(): void {
  const guard = new CompletionGuard();
  guard.observeToolEvent({ type: "tool.started", toolCallId: "write-1", tool: "write_file", args: { path: "a.ts" } });
  guard.observeToolEvent({ type: "tool.completed", toolCallId: "write-1", tool: "write_file", result: { path: "a.ts" }, executionStatus: "succeeded" });
  assert.equal(guard.requiresSemanticReview(), true);
  assert.deepEqual(guard.decide(baseInput()), { kind: "complete" });
}

function testFailedToolCannotBecomeCompletion(): void {
  const guard = new CompletionGuard();
  guard.observeToolEvent({ type: "tool.started", toolCallId: "command-1", tool: "run_command", args: { command: "pnpm test" } });
  guard.observeToolEvent({ type: "tool.failed", toolCallId: "command-1", tool: "run_command", error: "exit code 1", result: { exitCode: 1 }, executionStatus: "failed" });
  assert.equal(guard.decide(baseInput()).kind, "continue");
  assert.equal(guard.decide(baseInput()).kind, "continue");
  const final = guard.decide(baseInput());
  assert.equal(final.kind, "incomplete");
}

function testUnknownToolOperationBlocksAfterReview(): void {
  const guard = new CompletionGuard();
  guard.observeToolEvent({ type: "tool.started", toolCallId: "external-1", tool: "external_write", args: {} });
  guard.observeToolEvent({ type: "tool.completed", toolCallId: "external-1", tool: "external_write", result: { executionStatus: "unknown" }, executionStatus: "unknown" });
  assert.equal(guard.decide(baseInput()).kind, "continue");
  const blocked = guard.decide(baseInput());
  assert.equal(blocked.kind, "blocked");
  if (blocked.kind === "blocked") assert.equal(blocked.blockedReason, "unsafe_action_required");

  const restored = parseCompletionGuardSnapshot(guard.snapshot());
  assert.equal(restored?.unknownToolCalls.includes("external_write"), true);
}


function guardWithReadOnlyWork(): CompletionGuard {
  const guard = new CompletionGuard();
  guard.observeToolEvent({ type: "tool.started", toolCallId: "read-1", tool: "read_file", args: { path: "a.ts" } });
  guard.observeToolEvent({ type: "tool.completed", toolCallId: "read-1", tool: "read_file", result: { content: "x" }, executionStatus: "succeeded" });
  return guard;
}

function guardWithMutatingWork(): CompletionGuard {
  const guard = new CompletionGuard();
  guard.observeToolEvent({ type: "tool.started", toolCallId: "write-1", tool: "write_file", args: { path: "a.ts" } });
  guard.observeToolEvent({ type: "tool.completed", toolCallId: "write-1", tool: "write_file", result: { path: "a.ts" }, executionStatus: "succeeded" });
  return guard;
}

function testDeclarationNudgeFiresOnceThenReleases(): void {
  const guard = guardWithMutatingWork();
  const input = baseInput({ explicitCompletionExpected: true });
  const first = guard.decide(input);
  assert.equal(first.kind, "continue", "mutated without declaring completion must be nudged");
  // 只提醒一次:模型坚持纯文本收尾也放行,交给复核兜底,不无限纠缠。
  assert.equal(guard.decide(input).kind, "complete");
}

function testReadOnlyNeutralAnswerStopsFreely(): void {
  // 控制度:只读调查后给出中性回答(没宣称完成)不触发打回,问答型回合不受打扰。
  const guard = guardWithReadOnlyWork();
  assert.equal(guard.decide(baseInput({ explicitCompletionExpected: true })).kind, "complete");
}

function testDeclarationSatisfiesGateAndTriggersReview(): void {
  const guard = guardWithReadOnlyWork();
  guard.observeToolEvent({ type: "tool.started", toolCallId: "decl-1", tool: "attempt_completion", args: { summary: "done" } });
  guard.observeToolEvent({ type: "tool.completed", toolCallId: "decl-1", tool: "attempt_completion", result: { declared: true }, executionStatus: "succeeded" });
  assert.equal(guard.decide(baseInput({ explicitCompletionExpected: true })).kind, "complete");
  // 声明完成即主动要求验收:即使没用过变更工具也要独立复核。
  assert.equal(guard.requiresSemanticReview(), true);
}

function testPureQuestionTurnSkipsNudge(): void {
  const guard = new CompletionGuard();
  assert.equal(guard.decide(baseInput({ explicitCompletionExpected: true })).kind, "complete");
}

function testDefaultModeSkipsNudgeWhenNotExpected(): void {
  const guard = guardWithMutatingWork();
  // plan 等模式不传 explicitCompletionExpected,保持旧的直接收口行为。
  assert.equal(guard.decide(baseInput()).kind, "complete");
}

function testTextClaimEscalatesToReview(): void {
  const guard = guardWithReadOnlyWork();
  guard.noteTextCompletionClaim("修好了,问题已解决。");
  assert.equal(guard.requiresSemanticReview(), true, "read-only run claiming completion in text must be reviewed");

  const pureChat = new CompletionGuard();
  pureChat.noteTextCompletionClaim("完成了!");
  assert.equal(pureChat.requiresSemanticReview(), false, "pure chat without tools must not be escalated");

  const nonClaim = guardWithReadOnlyWork();
  nonClaim.noteTextCompletionClaim("还有一个地方需要确认。");
  assert.equal(nonClaim.requiresSemanticReview(), false);
}

function testDeclarationSnapshotRoundTrip(): void {
  const guard = guardWithReadOnlyWork();
  guard.observeToolEvent({ type: "tool.started", toolCallId: "decl-1", tool: "attempt_completion", args: { summary: "done" } });
  const restored = new CompletionGuard(parseCompletionGuardSnapshot(guard.snapshot()));
  assert.equal(restored.decide(baseInput({ explicitCompletionExpected: true })).kind, "complete", "declaration state must survive snapshot round-trip");
  assert.equal(restored.requiresSemanticReview(), true);

  // 旧版本快照没有新字段,按未声明/未用工具/未提醒解析。
  const legacy = parseCompletionGuardSnapshot({
    version: 1,
    reviewRequired: false,
    continuationAttempts: 0,
    stagnantAttempts: 0,
    lastBlockFingerprint: "",
    failedToolCalls: [],
    unknownToolCalls: []
  });
  assert.equal(legacy?.completionDeclared, false);
  assert.equal(legacy?.sawAnyTool, false);
  assert.equal(legacy?.missingDeclarationNudges, 0);
}

async function testAgentDoesNotFinishImmediatelyAfterMutation(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-completion-guard-"));
  await ensureAgentDirs(workspaceRoot);
  let requests = 0;
  let agentRequests = 0;
  let reviews = 0;
  const requestKinds: string[] = [];
  const model: AgentModel = {
    provider: "test",
    modelId: "completion-guard-model",
    supportsTools: true,
    stream: async (context) => {
      requests += 1;
      const evaluator = context.tools.length === 0;
      requestKinds.push(evaluator ? "completion-review" : "agent");
      if (evaluator) reviews += 1;
      else agentRequests += 1;
      const response = evaluator
        ? [
          { type: "text-delta" as const, text: reviews === 1
            ? '{"met":false,"impossible":false,"progress":false,"reason":"The response does not prove the requested file state was checked."}'
            : '{"met":true,"impossible":false,"progress":true,"reason":"The requested file write is confirmed by the tool result."}' },
          { type: "finish" as const, reason: "stop" as const }
        ]
        : agentRequests === 1
          ? [
            { type: "tool-call" as const, id: "write-1", name: "write_file", arguments: { path: "result.txt", content: "written" } },
            { type: "finish" as const, reason: "tool-calls" as const }
          ]
          : agentRequests === 2
            ? [
              { type: "tool-call" as const, id: "declare-1", name: "attempt_completion", arguments: { summary: "result.txt 已创建", evidence: "write_file 返回成功" } },
              { type: "finish" as const, reason: "tool-calls" as const }
            ]
            : [
              { type: "text-delta" as const, text: agentRequests === 3 ? "我已经完成了。" : "复核后确认文件已写入，任务完成。" },
              { type: "finish" as const, reason: "stop" as const }
            ];
      return (async function* () {
        for (const event of response) yield event;
      })();
    }
  };
  const config = configSchema.parse({
    ...defaultConfig,
    context: {
      ...defaultConfig.context,
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
    }
  });
  const recorder = new SessionRecorder(workspaceRoot);
  const registry = new ToolRegistry();
  registry.registerBuiltinTool(createWriteFileTool({ workspaceRoot, ignore: [] }));
  registry.registerBuiltinTool(createAttemptCompletionTool());
  const agent = new AgentSession({
    workspaceRoot,
    config,
    model,
    toolRegistry: registry,
    permissionManager: new PermissionManager(config.permission),
    recorder
  });
  await agent.initialize();
  try {
    const outcome = await agent.runTask("create result.txt and finish the task", {
      confirmPermission: async () => ({ approved: true, scope: "once" })
    });
    assert.equal(requests, 6, "a mutating task declares completion and still passes a separate bounded completion evaluator");
    assert.deepEqual(requestKinds, ["agent", "agent", "agent", "completion-review", "agent", "completion-review"]);
    assert.equal(outcome.status, "completed");
    assert.equal(await readFile(path.join(workspaceRoot, "result.txt"), "utf8"), "written");
  } finally {
    await agent.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

/**
 * 评审器基础设施故障（如模型不支持关 thinking、网络错误）必须放行：
 * 结构性检查已过 + 完成已声明，评审崩了不能烧 continuation 预算，更不能把回合判成 incomplete。
 */
async function testEvaluatorFailureReleasesRun(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-completion-guard-"));
  await ensureAgentDirs(workspaceRoot);
  let agentRequests = 0;
  let reviews = 0;
  const model: AgentModel = {
    provider: "test",
    modelId: "completion-guard-model",
    supportsTools: true,
    stream: async (context) => {
      const evaluator = context.tools.length === 0;
      if (evaluator) reviews += 1;
      else agentRequests += 1;
      const response = evaluator
        ? [
          // 模拟 provider 侧参数错误：评审请求直接以 error 事件崩掉。
          { type: "error" as const, error: new Error("deepseek-v4-flash does not support disabling thinking") }
        ]
        : agentRequests === 1
          ? [
            { type: "tool-call" as const, id: "write-1", name: "write_file", arguments: { path: "result.txt", content: "written" } },
            { type: "finish" as const, reason: "tool-calls" as const }
          ]
          : agentRequests === 2
            ? [
              { type: "tool-call" as const, id: "declare-1", name: "attempt_completion", arguments: { summary: "result.txt 已创建", evidence: "write_file 返回成功" } },
              { type: "finish" as const, reason: "tool-calls" as const }
            ]
            : [
              { type: "text-delta" as const, text: "文件已写入，任务完成。" },
              { type: "finish" as const, reason: "stop" as const }
            ];
      return (async function* () {
        for (const event of response) yield event;
      })();
    }
  };
  const config = configSchema.parse({
    ...defaultConfig,
    context: {
      ...defaultConfig.context,
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
    }
  });
  const recorder = new SessionRecorder(workspaceRoot);
  const registry = new ToolRegistry();
  registry.registerBuiltinTool(createWriteFileTool({ workspaceRoot, ignore: [] }));
  registry.registerBuiltinTool(createAttemptCompletionTool());
  const agent = new AgentSession({
    workspaceRoot,
    config,
    model,
    toolRegistry: registry,
    permissionManager: new PermissionManager(config.permission),
    recorder
  });
  await agent.initialize();
  try {
    const outcome = await agent.runTask("create result.txt and finish the task", {
      confirmPermission: async () => ({ approved: true, scope: "once" })
    });
    assert.equal(outcome.status, "completed", "evaluator infrastructure failure must fail open, not mark the run incomplete");
    assert.equal(reviews, 1, "a crashed evaluator must not burn continuation attempts");
    assert.equal(agentRequests, 3, "no extra continuation turns after evaluator failure");
  } finally {
    await agent.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

await main();
