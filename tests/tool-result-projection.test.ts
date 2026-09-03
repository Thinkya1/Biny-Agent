import assert from "node:assert/strict";
import { projectSingleToolResultForModel, projectToolResultsForModel } from "../src/agent/toolResultProjection.js";
import { runShellCommand } from "../src/tools/shell/runCommand.js";
import type { AgentMessage, AgentToolResultMessage } from "../src/agent/core/types.js";

await testFileAndCommandProjection();
await testSemanticReplacementAndParallelIsolation();
await testUnknownFailureIsNotMerged();
await testArchiveFailureKeepsOriginal();
await testRunCommandTruncationMetadata();

console.log("tool result projection tests passed");

async function testFileAndCommandProjection(): Promise<void> {
  const messages: AgentMessage[] = [
    { role: "user", content: "make the change" },
    assistantCall("write-1", "write_file", { path: "src/example.ts", content: "new\ncontent\n" }),
    toolResult("write-1", "write_file", {
      path: "src/example.ts",
      bytes: 12,
      diffPreview: "@@ -1 +1,2 @@\n-old\n+new\n+content",
      contentPreview: "new\ncontent",
      changeSummary: "Overwrite src/example.ts"
    }),
    assistantCall("command-1", "run_command", { command: "pnpm test" }),
    toolResult("command-1", "run_command", {
      status: "completed",
      exitCode: 0,
      stdout: "pnpm test\n" + "old output\n".repeat(1_000),
      stderr: "",
      stdoutBytes: 11_000,
      stdoutRetainedBytes: 11_000,
      stdoutTruncated: false,
      stderrBytes: 0,
      stderrRetainedBytes: 0,
      stderrTruncated: false
    }),
    assistantCall("recent", "unknown_tool", { value: 1 }),
    toolResult("recent", "unknown_tool", { ok: true }),
    assistantCall("recent-2", "unknown_tool", { value: 2 }),
    toolResult("recent-2", "unknown_tool", { ok: true })
  ];
  const archiveRequests: Array<{ sequence: number; output: string }> = [];
  const projected = await projectToolResultsForModel(messages, {
    thresholdBytes: 512,
    archiveResult: async (request) => {
      archiveRequests.push({ sequence: request.sequence, output: request.output });
      const suffix = request.sequence.toString(16).padStart(64, "0");
      return { archivePath: `.biny/tool-results/tool-result-${suffix}.json`, resultBytes: request.output.length };
    }
  });

  const write = resultDetails(projected[2]);
  assert.equal(write.path, "src/example.ts");
  assert.equal(write.changeSummary, "Overwrite src/example.ts");
  assert.equal(write.addedLines, 2);
  assert.equal(write.deletedLines, 1);
  assert.equal("diffPreview" in write, false);
  assert.equal("contentPreview" in write, false);

  const command = resultDetails(projected[4]);
  assert.equal(String(command.stdout).includes("pnpm test"), false, "the command already exists in the tool call");
  assert.equal(String(command.stdout).length < String(resultDetails(messages[4]).stdout).length, true);
  assert.equal(command.stdoutTruncated, true);
  assert.match(String(command.summary), /tail/i);
  assert.equal(archiveRequests.length, 1, "only the large command result needs an archive");
  assert.equal(messages[2]?.role, "toolResult");
  assert.equal((messages[2] as AgentToolResultMessage).details, (resultDetails(messages[2])));
  assert.equal(String((messages[4] as AgentToolResultMessage).details?.stdout).startsWith("pnpm test"), true);
}

async function testSemanticReplacementAndParallelIsolation(): Promise<void> {
  const messages: AgentMessage[] = [
    { role: "user", content: "inspect the workspace" },
    assistantCall("read-old", "read_file", { path: "src/index.ts" }),
    toolResult("read-old", "read_file", { path: "src/index.ts", content: "old contents" }),
    assistantCall("read-new", "read_file", { path: "src/index.ts" }),
    toolResult("read-new", "read_file", { path: "src/index.ts", content: "new contents" }),
    assistantCall("status-old", "git_status", {}),
    toolResult("status-old", "git_status", { output: " M old.ts" }),
    assistantCall("status-new", "git_status", {}),
    toolResult("status-new", "git_status", { output: " M new.ts" }),
    assistantCall("unknown-old", "opaque_tool", { value: 7 }),
    toolResult("unknown-old", "opaque_tool", { result: "same" }),
    assistantCall("unknown-new", "opaque_tool", { value: 7 }),
    toolResult("unknown-new", "opaque_tool", { result: "same" }),
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "parallel-a", name: "opaque_tool", arguments: { value: 9 } },
        { type: "toolCall", id: "parallel-b", name: "opaque_tool", arguments: { value: 9 } }
      ]
    },
    toolResult("parallel-a", "opaque_tool", { result: "parallel" }),
    toolResult("parallel-b", "opaque_tool", { result: "parallel" }),
    assistantCall("failure", "run_command", { command: "pnpm check" }),
    toolResult("failure", "run_command", { status: "failed", exitCode: 1, error: "failed" }),
    assistantCall("success", "run_command", { command: "pnpm check" }),
    toolResult("success", "run_command", { status: "completed", exitCode: 0, stdout: "passed" })
  ];
  const projected = await projectToolResultsForModel(messages, {
    archiveResult: async ({ sequence }) => ({
      archivePath: `.biny/tool-results/tool-result-${sequence.toString(16).padStart(64, "0")}.json`,
      resultBytes: sequence
    })
  });

  assert.match(resultText(projected[2]), /read covers/i);
  assert.match(resultText(projected[6]), /Git snapshot/i);
  assert.match(resultText(projected[10]), /identical tool call and result/i);
  assert.equal(resultText(projected[14]).includes("model projection"), false);
  assert.equal(resultText(projected[15]).includes("model projection"), false);
  assert.match(resultText(projected[17]), /resolved this earlier failure/i);
  assert.equal(resultText(projected[19]).includes("model projection"), false, "the successful replacement is retained");
}

async function testRunCommandTruncationMetadata(): Promise<void> {
  const script = "process.stdout.write('字'.repeat(400000)); process.stderr.write('界'.repeat(400000))";
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
  const capped = await runShellCommand(process.cwd(), command);
  assert.equal(capped.status, "completed");
  assert.equal(capped.stdoutBytes, 1_200_000);
  assert.equal(capped.stderrBytes, 1_200_000);
  assert.equal(capped.stdoutTruncated, true);
  assert.equal(capped.stderrTruncated, true);
  assert.equal(capped.stdoutTruncationDirection, "tail");
  assert.equal(capped.stderrTruncationDirection, "tail");
  assert.equal(capped.stdout.includes("�"), false);
  assert.equal(capped.stderr.includes("�"), false);
  assert.equal(capped.stdoutRetainedBytes <= 1024 * 1024, true);
  assert.equal(capped.stderrRetainedBytes <= 1024 * 1024, true);

  const captured = await runShellCommand(process.cwd(), command, { captureFullOutput: true });
  assert.equal(captured.stdoutTruncated, false);
  assert.equal(captured.stderrTruncated, false);
  assert.equal(captured.stdoutBytes, captured.stdoutRetainedBytes);
  assert.equal(captured.stderrBytes, captured.stderrRetainedBytes);
  assert.equal(captured.stdout.length, 400_000);
  assert.equal(captured.stderr.length, 400_000);
}

async function testArchiveFailureKeepsOriginal(): Promise<void> {
  const original = {
    path: "failure.ts",
    diffPreview: "x".repeat(20_000)
  };
  const projected = await projectSingleToolResultForModel("write", { path: original.path }, original, {
    toolCallId: "archive-failure",
    archiveResult: async () => { throw new Error("archive unavailable"); }
  }) as Record<string, unknown>;
  assert.deepEqual(projected.result, original);
  assert.equal(projected.archivePath, undefined);
  assert.equal(projected.archiveError, "archive unavailable");
  assert.match(String(projected.summary), /complete result remains in session history/i);
}

async function testUnknownFailureIsNotMerged(): Promise<void> {
  const messages: AgentMessage[] = [
    { role: "user", content: "run opaque tool" },
    assistantCall("opaque-failure", "opaque_tool", { value: 3 }),
    toolResult("opaque-failure", "opaque_tool", { error: "temporary failure" }),
    assistantCall("opaque-success", "opaque_tool", { value: 3 }),
    toolResult("opaque-success", "opaque_tool", { ok: true })
  ];
  const projected = await projectToolResultsForModel(messages);
  assert.equal(resultText(projected[2]).includes("model projection"), false);
}

function assistantCall(id: string, name: string, args: Record<string, unknown>): AgentMessage {
  return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] };
}

function toolResult(id: string, toolName: string, details: unknown): AgentToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [{ type: "text", text: JSON.stringify(details) }],
    details
  };
}

function resultDetails(message: AgentMessage | undefined): Record<string, unknown> {
  if (!message || message.role !== "toolResult" || typeof message.details !== "object" || message.details === null) {
    throw new Error("Expected structured tool result.");
  }
  return message.details as Record<string, unknown>;
}

function resultText(message: AgentMessage | undefined): string {
  if (!message || message.role !== "toolResult") return "";
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}
