/** Model-facing tools for runtime-owned long-lived processes. */
import { z } from "zod";
import {
  ManagedProcessService,
  type LogReadinessProbe,
  type HttpReadinessProbe,
  type ManagedProcessLifecycle,
  type ManagedProcessOutput,
  type ManagedProcessReadinessProbe,
  type ManagedProcessSnapshot,
  type TcpReadinessProbe
} from "../../runtime/ManagedProcessService.js";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";
import { resolveWorkspaceDirectory } from "../../workspace/resolvePath.js";

export interface StartProcessArgs {
  command: string;
  cwd?: string;
  lifecycle?: ManagedProcessLifecycle;
  url?: string;
  readiness?: ManagedProcessReadinessProbe;
}

export interface ProcessIdArgs {
  processId: string;
}

export interface ReadProcessOutputArgs extends ProcessIdArgs {
  offset?: number;
  maxBytes?: number;
  fromEnd?: boolean;
}

export interface StopProcessArgs extends ProcessIdArgs {
  reason?: string;
}

export interface ProcessStatusArgs {
  /** 提供时只返回该进程；省略时列出全部受管进程。 */
  processId?: string;
  includeExited?: boolean;
}

export interface ProcessStatusResult {
  processes: ManagedProcessSnapshot[];
}

const commonProbeProperties = {
  timeoutMs: { type: "integer" as const, minimum: 1, maximum: 600_000, description: "Total time to wait for readiness." },
  intervalMs: { type: "integer" as const, minimum: 1, maximum: 60_000, description: "Delay between readiness attempts." }
};

const httpProbeSchema = z.object({
  type: z.literal("http"),
  url: z.string().url(),
  expectedStatus: z.number().int().min(100).max(599).optional(),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
  intervalMs: z.number().int().min(1).max(60_000).optional()
}) satisfies z.ZodType<HttpReadinessProbe>;

const tcpProbeSchema = z.object({
  type: z.literal("tcp"),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
  intervalMs: z.number().int().min(1).max(60_000).optional()
}) satisfies z.ZodType<TcpReadinessProbe>;

const logProbeSchema = z.object({
  type: z.literal("log"),
  pattern: z.string().min(1),
  regex: z.boolean().optional(),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
  intervalMs: z.number().int().min(1).max(60_000).optional()
}) satisfies z.ZodType<LogReadinessProbe>;

const startProcessArgsSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  lifecycle: z.enum(["cleanup", "retain"]).optional(),
  url: z.string().url().optional(),
  readiness: z.discriminatedUnion("type", [httpProbeSchema, tcpProbeSchema, logProbeSchema]).optional()
}) satisfies z.ZodType<StartProcessArgs>;

export function createManagedProcessTools(
  context: ToolContext,
  service: ManagedProcessService
): Array<Tool<unknown, unknown>> {
  return [
    createStartProcessTool(context, service),
    createProcessStatusTool(service),
    createReadProcessOutputTool(service),
    createStopProcessTool(service)
  ] as Array<Tool<unknown, unknown>>;
}

export function createStartProcessTool(
  context: ToolContext,
  service: ManagedProcessService
): Tool<StartProcessArgs, ManagedProcessSnapshot> {
  return {
    name: "start_process",
    description: "Start a long-running workspace process managed by Biny. Use this instead of run_command, &, nohup, or disown for servers. Optional HTTP, TCP, or log readiness is checked before the tool returns. Processes are cleaned up when the runtime closes unless lifecycle is explicitly set to retain.",
    promptSnippet: "Start and readiness-check a long-running managed workspace process",
    promptGuidelines: ["Use start_process for servers and other long-running commands; do not background them with &, nohup, or disown"],
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, description: "Foreground command that owns the long-running service." },
        cwd: { type: "string", minLength: 1, description: "Workspace-relative working directory." },
        lifecycle: { type: "string", enum: ["cleanup", "retain"], description: "cleanup (default) stops the process on runtime close; retain explicitly leaves it running." },
        url: { type: "string", description: "Optional user-facing service URL." },
        readiness: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["http", "tcp", "log"] },
            url: { type: "string", description: "HTTP readiness URL." },
            expectedStatus: { type: "integer", minimum: 100, maximum: 599, description: "Exact HTTP status required; defaults to 200." },
            host: { type: "string", description: "TCP readiness host." },
            port: { type: "integer", minimum: 1, maximum: 65_535, description: "TCP readiness port." },
            pattern: { type: "string", description: "Literal or regular-expression log pattern." },
            regex: { type: "boolean", description: "Interpret pattern as a regular expression." },
            ...commonProbeProperties
          },
          required: ["type"],
          additionalProperties: false,
          description: "Readiness probe. http requires url, tcp requires host and port, log requires pattern."
        }
      },
      required: ["command"],
      additionalProperties: false
    },
    schema: startProcessArgsSchema,
    capability: "process.start",
    risk: "execute",
    resolveExecution(args) {
      const preview = args.command.length > 80 ? `${args.command.slice(0, 80)}...` : args.command;
      const processCwd = resolveWorkspaceDirectory(context.workspaceRoot, args.cwd ?? ".", context.ignore);
      return {
        accesses: ToolAccesses.readWriteTree(processCwd),
        display: {
          kind: "generic",
          summary: `Start managed process: ${preview}`,
          detail: { command: args.command, cwd: processCwd, readiness: args.readiness }
        },
        description: `Start managed process: ${preview}`,
        approvalRule: `start_process(${args.command})`,
        async execute({ signal }) {
          const currentCwd = resolveWorkspaceDirectory(context.workspaceRoot, args.cwd ?? ".", context.ignore);
          if (currentCwd !== processCwd) throw new Error("The managed process working directory changed after the tool call was prepared.");
          return await service.start({
            command: args.command,
            cwd: processCwd,
            lifecycle: args.lifecycle,
            url: args.url,
            readiness: args.readiness,
            signal
          });
        }
      };
    }
  };
}

export function createProcessStatusTool(
  service: ManagedProcessService
): Tool<ProcessStatusArgs, ProcessStatusResult> {
  const schema = z.object({
    processId: z.string().uuid().optional(),
    includeExited: z.boolean().optional()
  }) satisfies z.ZodType<ProcessStatusArgs>;
  return {
    name: "process_status",
    description: "List Biny-managed processes with current state, readiness evidence, PID/process group, URLs, log paths, and cleanup policy; or inspect one process in full when processId is given (exactly one entry).",
    promptSnippet: "List managed processes, or inspect one and its readiness evidence",
    parameters: {
      type: "object",
      properties: {
        processId: { type: "string", description: "Opaque runtime process ID returned by start_process. Omit to list all managed processes instead." },
        includeExited: { type: "boolean", description: "When listing, include stopped, failed, and naturally exited processes; defaults to true. Ignored when processId is given." }
      },
      additionalProperties: false
    },
    schema,
    capability: "process.status",
    risk: "read",
    resolveExecution(args) {
      const inspecting = args.processId !== undefined;
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: inspecting ? `Inspect managed process ${args.processId}` : "List managed processes" },
        description: inspecting ? `Inspect managed process ${args.processId}` : "List managed processes",
        approvalRule: inspecting ? `process_status(${args.processId})` : "list_processes",
        async execute() {
          if (args.processId !== undefined) {
            return { processes: [await service.status(args.processId)] };
          }
          return { processes: await service.list({ includeExited: args.includeExited }) };
        }
      };
    }
  };
}

export function createReadProcessOutputTool(
  service: ManagedProcessService
): Tool<ReadProcessOutputArgs, ManagedProcessOutput> {
  const schema = z.object({
    processId: z.string().uuid(),
    offset: z.number().int().min(0).optional(),
    maxBytes: z.number().int().min(1).max(256 * 1024).optional(),
    fromEnd: z.boolean().optional()
  }) satisfies z.ZodType<ReadProcessOutputArgs>;
  return {
    name: "read_process_output",
    description: "Read bounded output from a Biny-managed process log. Use nextOffset for incremental reads or fromEnd for a bounded tail.",
    promptSnippet: "Read bounded output from a managed process",
    parameters: {
      type: "object",
      properties: {
        processId: { type: "string", description: "Opaque runtime process ID returned by start_process." },
        offset: { type: "integer", minimum: 0, description: "Byte offset for incremental reading; defaults to 0." },
        maxBytes: { type: "integer", minimum: 1, maximum: 256 * 1024, description: "Maximum bytes to return; defaults to 65536." },
        fromEnd: { type: "boolean", description: "Read the last maxBytes instead of using offset." }
      },
      required: ["processId"],
      additionalProperties: false
    },
    schema,
    capability: "process.output.read",
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: `Read managed process output ${args.processId}` },
        description: `Read managed process output ${args.processId}`,
        approvalRule: `read_process_output(${args.processId})`,
        async execute() {
          return await service.readOutput(args.processId, {
            offset: args.offset,
            maxBytes: args.maxBytes,
            fromEnd: args.fromEnd
          });
        }
      };
    }
  };
}

export function createStopProcessTool(
  service: ManagedProcessService
): Tool<StopProcessArgs, ManagedProcessSnapshot> {
  const schema = z.object({
    processId: z.string().uuid(),
    reason: z.string().min(1).max(500).optional()
  }) satisfies z.ZodType<StopProcessArgs>;
  return {
    name: "stop_process",
    description: "Stop an entire Biny-managed process group and record the cleanup result.",
    promptSnippet: "Stop a managed process group",
    parameters: {
      type: "object",
      properties: {
        processId: { type: "string", description: "Opaque runtime process ID returned by start_process." },
        reason: { type: "string", minLength: 1, maxLength: 500, description: "Optional cleanup reason." }
      },
      required: ["processId"],
      additionalProperties: false
    },
    schema,
    capability: "process.stop",
    risk: "execute",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: `Stop managed process ${args.processId}`, detail: args.reason },
        description: `Stop managed process ${args.processId}`,
        approvalRule: `stop_process(${args.processId})`,
        async execute() {
          return await service.stop(args.processId, args.reason);
        }
      };
    }
  };
}
