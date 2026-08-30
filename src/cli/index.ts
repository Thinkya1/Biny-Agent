#!/usr/bin/env node
/**
 * Biny 的命令行入口模块。
 *
 * 这里集中声明 `init`、`run`、`chat`、`tui` 等子命令，并把执行逻辑转交给
 * `commands/` 下的具体实现。入口层只处理参数拼接、默认 TUI 和异常展示，
 * 不直接承载 agent、工具或 TUI 的业务流程。
 */
import { createRequire } from "node:module";
import { Command, InvalidArgumentError } from "commander";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { runCommand, type RunCommandOptions } from "./commands/run.js";
import { chatCommand } from "./commands/chat.js";
import { evalCompareCommand, evalRunCommand } from "./commands/evals.js";
import { resumeCommand } from "./commands/resume.js";
import { sessionsCommand, type SessionsCommandOptions } from "./commands/sessions.js";
import { sessionExportCommand, sessionImportCommand } from "./commands/sessionTransfer.js";
import type { SessionTransferFormat } from "../session/transfer.js";
import { planCommand } from "./commands/plan.js";
import { tuiCommand } from "./commands/tui.js";
import { runtimeHostCommand } from "./commands/runtimeHost.js";
import {
  automationCreateCommand,
  automationDeleteCommand,
  automationListCommand,
  automationPauseCommand,
  automationResumeCommand,
  automationRunCommand,
  daemonInstallCommand,
  daemonRunCommand,
  daemonStatusCommand,
  daemonUninstallCommand,
  goalActionCommand,
  goalCreateCommand,
  graphActionCommand,
  graphCreateCommand,
  taskActionCommand,
  taskCreateCommand,
  taskEventsCommand,
  taskGetCommand,
  taskListCommand
} from "./commands/runtimeManagement.js";

const program = new Command();
// CLI 的工作区以用户执行 biny 时的当前目录为准。
const workspaceRoot = process.cwd();
// `pnpm dev -- <command>` 会把分隔符保留在 tsx 脚本的 argv 中；去掉它，保证开发入口和已安装的 biny 解析一致。
const cliArgv = process.argv[2] === "--"
  ? [...process.argv.slice(0, 2), ...process.argv.slice(3)]
  : process.argv;
// 版本号来自 package.json，界面头部和 `--version` 用同一个来源。
const { version: cliVersion } = createRequire(import.meta.url)("../../package.json") as { version: string };

program.name("biny").description("Biny local desktop assistant").version(cliVersion);

program.command("init").description("Initialize config and .biny directories").action(wrap(() => initCommand(workspaceRoot)));
program.command("doctor").description("Check local environment").action(wrap(() => doctorCommand(workspaceRoot)));
program
  .command("chat")
  .description("Start a new interactive chat")
  .action(() => wrap(() => chatCommand(workspaceRoot, cliVersion))());
program.command("tui").description("Start terminal UI mode").action(wrap(() => tuiCommand(workspaceRoot, cliVersion)));
program
  .command("runtime-host")
  .description("Run the shared Runtime Host process")
  .option("--workspace-root <path>", "workspace root")
  .option("--persistence-root <path>", "session and runtime persistence root")
  .option("--config-dir <path>", "global config directory")
  .option("--attachment-root <path>", "attachment directory")
  .option("--session-id <id>", "session to resume")
  .option("--resume-interrupted", "resume the latest interrupted turn")
  .allowUnknownOption()
  .action(() => wrap(runtimeHostCommand)());
const daemon = program.command("daemon").description("Manage the local resident Runtime Host");
daemon.command("install").description("Install and load a user LaunchAgent").action(wrap(() => daemonInstallCommand(workspaceRoot)));
daemon.command("uninstall").description("Unload and remove the user LaunchAgent").action(wrap(() => daemonUninstallCommand(workspaceRoot)));
daemon.command("status").description("Show LaunchAgent and Runtime Host status").action(wrap(() => daemonStatusCommand(workspaceRoot)));
daemon.command("run").description("Run the Runtime Host in the foreground").action(wrap(() => daemonRunCommand(workspaceRoot)));

const automation = program.command("automation").description("Manage durable local automations");
automation.command("list").option("--json", "print JSON").action((options: { json?: boolean }) => wrap(() => automationListCommand(workspaceRoot, options))());
automation
  .command("create")
  .argument("<name>", "automation name")
  .requiredOption("--prompt <text>", "prompt to execute")
  .requiredOption("--trigger <type>", "heartbeat, cron, interval, or once")
  .option("--cron <expression>", "five-field cron expression")
  .option("--interval-ms <milliseconds>", "interval in milliseconds", parsePositiveInteger)
  .option("--at <timestamp>", "ISO timestamp for once")
  .option("--jitter-ms <milliseconds>", "maximum schedule jitter", parseNonNegativeInteger)
  .option("--session <id>", "heartbeat target session")
  .option("--mode <mode>", "chat or plan", "chat")
  .option("--max-fires <count>", "maximum fire count", parsePositiveInteger)
  .option("--expires-at <timestamp>", "ISO expiry timestamp")
  .option("--json", "print JSON")
  .action((name: string, options: { prompt: string; trigger: string; cron?: string; intervalMs?: number; at?: string; jitterMs?: number; session?: string; mode: "chat" | "plan"; maxFires?: number; expiresAt?: string; json?: boolean }) => wrap(() => automationCreateCommand(workspaceRoot, {
    name,
    triggerType: options.trigger as "heartbeat" | "cron" | "interval" | "once",
    schedule: { cron: options.cron, intervalMs: options.intervalMs, at: options.at, jitterMs: options.jitterMs },
    executionTemplate: { prompt: options.prompt, sessionId: options.session, mode: options.mode },
    maxFires: options.maxFires,
    expiresAt: options.expiresAt
  }, options))());
for (const [name, action] of [["pause", automationPauseCommand], ["resume", automationResumeCommand], ["run", automationRunCommand], ["delete", automationDeleteCommand]] as const) {
  automation.command(name).argument("<automationId>", "automation id").option("--json", "print JSON").action((automationId: string, options: { json?: boolean }) => wrap(() => action(workspaceRoot, automationId, options))());
}

const task = program.command("task").description("Manage durable TaskRuns");
task
  .command("create")
  .argument("<task...>", "task text")
  .option("--session <id>", "session id")
  .option("--parent-run <id>", "parent AgentRun id")
  .option("--json", "print JSON")
  .action((input: string[], options: { session?: string; parentRun?: string; json?: boolean }) => wrap(() => taskCreateCommand(workspaceRoot, input.join(" "), { json: options.json, sessionId: options.session, parentRunId: options.parentRun }))());
for (const [name, action] of [["start", "start"], ["cancel", "cancel"], ["approve", "approve"], ["resume", "resume"], ["retry", "retry"]] as const) {
  task
    .command(name)
    .argument("<taskRunId>", "TaskRun id")
    .option("--reason <text>", "cancellation reason")
    .option("--json", "print JSON")
    .action((taskRunId: string, options: { reason?: string; json?: boolean }) => wrap(() => taskActionCommand(workspaceRoot, action, taskRunId, options))());
}
task.command("get").argument("<taskRunId>", "TaskRun id").option("--json", "print JSON").action((taskRunId: string, options: { json?: boolean }) => wrap(() => taskGetCommand(workspaceRoot, taskRunId, options))());
task.command("list").option("--status <status>", "TaskRun status").option("--limit <count>", "maximum rows", parsePositiveInteger).option("--json", "print JSON").action((options: { status?: string; limit?: number; json?: boolean }) => wrap(() => taskListCommand(workspaceRoot, options))());
task.command("events").argument("<taskRunId>", "TaskRun id").option("--limit <count>", "maximum events", parsePositiveInteger).option("--json", "print JSON").action((taskRunId: string, options: { limit?: number; json?: boolean }) => wrap(() => taskEventsCommand(workspaceRoot, taskRunId, options))());

const goal = program.command("goal").description("Manage durable goals");
goal.command("create").argument("<title>", "goal title").option("--payload <json>", "JSON payload").option("--goal-id <id>", "explicit goal id").option("--json", "print JSON").action((title: string, options: { payload?: string; goalId?: string; json?: boolean }) => wrap(() => goalCreateCommand(workspaceRoot, title, options))());
for (const [name, action] of [["get", "get"], ["pause", "pause"], ["resume", "resume"], ["cancel", "cancel"]] as const) {
  goal.command(name).argument("<goalId>", "goal id").option("--json", "print JSON").action((goalId: string, options: { json?: boolean }) => wrap(() => goalActionCommand(workspaceRoot, action, goalId, options))());
}

const graph = program.command("graph").description("Manage durable Agent Graphs");
graph.command("create").requiredOption("--nodes <json>", "JSON node array").option("--goal-id <id>", "goal id").option("--graph-id <id>", "explicit graph id").option("--payload <json>", "JSON payload").option("--json", "print JSON").action((options: { nodes: string; goalId?: string; graphId?: string; payload?: string; json?: boolean }) => wrap(() => graphCreateCommand(workspaceRoot, options))());
for (const [name, action] of [["start", "start"], ["pause", "pause"], ["resume", "resume"], ["cancel", "cancel"], ["inspect", "inspect"], ["events", "events"]] as const) {
  graph.command(name).argument("<graphId>", "graph id").option("--json", "print JSON").action((graphId: string, options: { json?: boolean }) => wrap(() => graphActionCommand(workspaceRoot, action, graphId, options))());
}
program
  .command("sessions")
  .description("List recorded sessions")
  .option("--limit <count>", "maximum sessions in one page", parsePositiveInteger)
  .option("--cursor <cursor>", "continue from a previous page")
  .option("--parent <session-id>", "only list direct children of a session")
  .option("--json", "print the page as JSON")
  .action((options: SessionsCommandOptions) => wrap(() => sessionsCommand(workspaceRoot, options))());
const session = program.command("session").description("Export and import sessions");
session
  .command("export")
  .description("Export a session to a Biny bundle (.json) or Claude Code (.jsonl) file")
  .argument("<session>", "session id or .jsonl path")
  .option("--format <format>", "biny (default) or claude", "biny")
  .option("--out <path>", "output file path; defaults to ./<sessionId>.<ext>")
  .option("--json", "print the result as JSON")
  .action((sessionRef: string, options: { format?: string; out?: string; json?: boolean }) => {
    const format = options.format === "claude" ? "claude" : "biny";
    return wrap(() => sessionExportCommand(workspaceRoot, sessionRef, { format, out: options.out, json: options.json }))();
  });
session
  .command("import")
  .description("Import a Biny, Claude Code, or Codex session file as a new session")
  .argument("<file>", "path to the session file to import")
  .option("--format <format>", "source format: biny, claude, or codex (auto-detected by default)")
  .option("--json", "print the result as JSON")
  .action((file: string, options: { format?: string; json?: boolean }) => {
    const format: SessionTransferFormat | undefined = options.format === "biny" || options.format === "claude" || options.format === "codex" ? options.format : undefined;
    return wrap(() => sessionImportCommand(workspaceRoot, file, { format, json: options.json }))();
  });
program
  .command("plan")
  .description("Create a plan without executing write, edit, or command tools")
  .argument("<task...>", "task text")
  // Commander 对可变参数返回数组，这里统一拼回自然语言任务文本。
  .action((task: string[]) => wrap(() => planCommand(workspaceRoot, task.join(" ")))());
program
  .command("run")
  .description("Run a one-shot agent task")
  .option("--model <alias>", "override the configured model alias for this run")
  .option("--max-steps <steps>", "override the hard step limit", parsePositiveInteger)
  .option("--soft-steps <steps>", "override the soft step limit", parsePositiveInteger)
  .option("--permission-mode <mode>", "override permission mode: ask, read-only, auto, full-access")
  .option("--headless", "run without interactive permission prompts")
  .option("--isolated", "run in a dedicated git worktree session")
  .option("--json", "print one machine-readable JSON result")
  .argument("<input...>", "task text")
  .action((input: string[], options: RunCommandOptions) => wrap(async () => { await runCommand(workspaceRoot, input.join(" "), options); })());
const evals = program.command("eval").description("Run and compare agent evaluations");
evals
  .command("run")
  .description("Run the built-in eval suite and write a report")
  .option("--label <label>", "label for this run, used in the report and comparisons")
  .option("--out <path>", "where to write the JSON report")
  .option("--task <id...>", "only run these task ids")
  .action((options: { label?: string; out?: string; task?: string[] }) => wrap(() => evalRunCommand(workspaceRoot, {
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.out === undefined ? {} : { out: options.out }),
    ...(options.task === undefined ? {} : { tasks: options.task })
  }))());
evals
  .command("compare")
  .description("Compare two eval reports")
  .argument("<baseline>", "baseline report path")
  .argument("<candidate>", "candidate report path")
  .action((baseline: string, candidate: string) => wrap(() => evalCompareCommand(baseline, candidate))());

program
  .command("resume")
  .description("Resume an existing session in the TUI")
  .argument("[session]", "session id or .jsonl path; omit to choose from the session picker")
  .action((session: string | undefined) => wrap(() => resumeCommand(workspaceRoot, cliVersion, session))());


if (cliArgv.length <= 2) {
  await wrap(() => tuiCommand(workspaceRoot, cliVersion))();
} else {
  await program.parseAsync(cliArgv);
}

function wrap(fn: () => Promise<void>): () => Promise<void> {
  // 所有命令都经过 wrap，保证异步异常不会打印冗长堆栈到普通用户界面。
  return async () => {
    try {
      await fn();
    } catch (error) {
      // CLI 层只负责把错误展示给用户，详细事件记录由 runtime / agent 层处理。
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  };
}

// commander 只接管 InvalidArgumentError（打印单行错误后退出）；普通 Error 会穿透
// parseAsync 变成未处理异常，把堆栈打到终端，绕过 wrap() 的干净错误展示。
function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError(`Expected a positive integer, got: ${value}`);
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new InvalidArgumentError(`Expected a non-negative integer, got: ${value}`);
  return parsed;
}
