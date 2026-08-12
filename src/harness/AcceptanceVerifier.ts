/**
 * 独立验收器。
 *
 * 只认可观测的事实：文件是否存在、工作区指纹有没有变、命令能不能自己跑通、HTTP/TCP 探针
 * 是否可达、受管进程是否真在运行。模型的说法和 Agent 自己执行命令的结果都不算证据——命令
 * 类条件会在这里重新独立执行一遍。
 */
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { redactSensitiveValue } from "../utils/secrets.js";
import {
  resolveWorkspaceDirectory,
  resolveWorkspacePath,
  toWorkspaceRelative
} from "../workspace/resolvePath.js";
import type { AcceptanceCommandExecutor } from "./AcceptanceCommandExecutor.js";
import { workspaceStateDigest } from "./WorkspaceState.js";
import type { AcceptanceCriterion, AcceptanceEvidence } from "./acceptanceTypes.js";

export interface ManagedProcessInspection {
  processId: string;
  state: string;
  command?: string;
  cwd?: string;
  url?: string;
  readiness?: unknown;
}

export interface ManagedProcessInspector {
  listProcesses(): ManagedProcessInspection[] | Promise<ManagedProcessInspection[]>;
}

export interface AcceptanceVerificationResult {
  passed: boolean;
  summary: string;
  evidence: AcceptanceEvidence[];
}

export interface AcceptanceCriteriaVerificationOptions {
  /** 用户取消或上层硬预算终止时，独立检查必须一起停止。 */
  signal?: AbortSignal;
  /** 需要确定性验证时，空条件不能利用 `every([])` 误判为通过。 */
  requireCriteria?: boolean;
}

export interface AcceptanceVerifierOptions {
  workspaceRoot: string;
  ignore?: string[];
  managedProcesses?: ManagedProcessInspector;
  /** 命令条件只能通过宿主注入的受控边界执行；未注入时该条件安全失败。 */
  commandExecutor?: AcceptanceCommandExecutor;
  defaultProbeTimeoutMs?: number;
  defaultCommandTimeoutMs?: number;
}

/** 校验可观测的验收条件；命令独立执行，服务类条件探测实时运行状态。 */
export class AcceptanceVerifier {
  private readonly defaultProbeTimeoutMs: number;
  private readonly defaultCommandTimeoutMs: number;

  constructor(private readonly options: AcceptanceVerifierOptions) {
    this.defaultProbeTimeoutMs = options.defaultProbeTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.defaultProbeTimeoutMs) || this.defaultProbeTimeoutMs < 1) {
      throw new RangeError("defaultProbeTimeoutMs must be a positive safe integer.");
    }
    this.defaultCommandTimeoutMs = options.defaultCommandTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.defaultCommandTimeoutMs) || this.defaultCommandTimeoutMs < 1) {
      throw new RangeError("defaultCommandTimeoutMs must be a positive safe integer.");
    }
  }

  /**
   * 只验证可执行条件，不依赖 Agent 是否已经被上层标成 completed。
   * 该 verifier 只返回检查证据，不改变 AgentSession 的终态。
   */
  async verifyCriteria(
    criteria: readonly AcceptanceCriterion[],
    options: AcceptanceCriteriaVerificationOptions = {}
  ): Promise<AcceptanceVerificationResult> {
    options.signal?.throwIfAborted();
    const evidence: AcceptanceEvidence[] = [];
    for (const criterion of criteria) {
      options.signal?.throwIfAborted();
      evidence.push(await this.verifyCriterion(criterion, options.signal));
    }
    // 声明了要做确定性验收却没有任何可执行条件时直接失败，避免空数组全通过。
    if (options.requireCriteria === true && criteria.length === 0) {
      evidence.push(this.evidence(
        "deterministic_verification",
        false,
        "This task requires deterministic verification, but no executable acceptance criteria were generated."
      ));
    }
    const failures = evidence.filter((item) => !item.passed);
    if (!failures.length) {
      return {
        passed: true,
        summary: criteria.length
          ? `All ${String(criteria.length)} acceptance criteria passed.`
          : "No deterministic verification was required.",
        evidence
      };
    }
    return {
      passed: false,
      summary: `${String(failures.length)} acceptance ${failures.length === 1 ? "criterion" : "criteria"} failed: ${failures.map((item) => item.summary).join("; ")}`,
      evidence
    };
  }

  /** 单条条件的分发；任何异常都转成「该条不通过」的证据，不让一条检查炸掉整轮验收。 */
  private async verifyCriterion(
    criterion: AcceptanceCriterion,
    signal?: AbortSignal
  ): Promise<AcceptanceEvidence> {
    try {
      signal?.throwIfAborted();
      if (criterion.kind === "file_exists") return await this.verifyFile(criterion);
      if (criterion.kind === "workspace_changed") return await this.verifyWorkspaceChanged(criterion);
      if (criterion.kind === "command_succeeded") return await this.verifyCommand(criterion, signal);
      if (criterion.kind === "http") return await this.verifyHttp(criterion, signal);
      if (criterion.kind === "tcp") return await this.verifyTcp(criterion, signal);
      return await this.verifyManagedProcess(criterion, signal);
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      return this.evidence(
        criterion.id,
        false,
        `${criterion.description ?? criterion.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async verifyFile(criterion: Extract<AcceptanceCriterion, { kind: "file_exists" }>): Promise<AcceptanceEvidence> {
    const absolutePath = resolveWorkspacePath(
      this.options.workspaceRoot,
      criterion.path,
      this.options.ignore ?? []
    );
    const stat = await fs.stat(absolutePath);
    // 目录也算「存在」：产物可能是一个目录（如构建输出），但设备/管道之类不算。
    const passed = stat.isFile() || stat.isDirectory();
    return this.evidence(
      criterion.id,
      passed,
      passed
        ? `${criterion.description ?? criterion.path} exists.`
        : `${criterion.description ?? criterion.path} is not a regular file or directory.`,
      { path: path.relative(this.options.workspaceRoot, absolutePath), type: stat.isDirectory() ? "directory" : "file" }
    );
  }

  /** 拿当前指纹和任务开始时的基线比：只要不一样就说明工作区确实被改过。 */
  private async verifyWorkspaceChanged(
    criterion: Extract<AcceptanceCriterion, { kind: "workspace_changed" }>
  ): Promise<AcceptanceEvidence> {
    const digest = await workspaceStateDigest(this.options.workspaceRoot, this.options.ignore ?? []);
    const passed = digest !== criterion.baselineDigest;
    return this.evidence(
      criterion.id,
      passed,
      passed
        ? `${criterion.description ?? criterion.id} changed from its task baseline.`
        : `${criterion.description ?? criterion.id} did not change from its task baseline.`,
      { baselineDigest: criterion.baselineDigest, digest }
    );
  }

  /**
   * 由验收器自己重新执行命令，不复用 Agent 跑过的结果（证据里也标了
   * `execution: independent_verifier`），这样「测试通过」是这里跑出来的结论。
   */
  private async verifyCommand(
    criterion: Extract<AcceptanceCriterion, { kind: "command_succeeded" }>,
    signal?: AbortSignal
  ): Promise<AcceptanceEvidence> {
    const cwd = resolveWorkspaceDirectory(
      this.options.workspaceRoot,
      criterion.cwd ?? ".",
      this.options.ignore ?? []
    );
    if (!this.options.commandExecutor) {
      throw new Error(
        "A controlled command executor is required for command verification."
      );
    }
    const result = await this.options.commandExecutor.execute({
      criterionId: criterion.id,
      command: criterion.command,
      cwd: toWorkspaceRelative(this.options.workspaceRoot, cwd),
      timeoutMs: criterion.timeoutMs ?? this.defaultCommandTimeoutMs,
      signal,
      description: criterion.description
    });
    const passed = result.status === "completed" && result.exitCode === 0;
    const stdout = compactOutput(result.stdout);
    const stderr = compactOutput(result.stderr);
    return this.evidence(
      criterion.id,
      passed,
      passed
        ? `${criterion.description ?? criterion.command} succeeded in an independent verifier run.`
        : `${criterion.description ?? criterion.command} failed in an independent verifier run (exit ${String(result.exitCode)}, ${result.status}).`,
      {
        execution: "independent_verifier",
        command: criterion.command,
        cwd: toWorkspaceRelative(this.options.workspaceRoot, cwd),
        status: result.status,
        exitCode: result.exitCode,
        sandbox: result.sandbox,
        stdout: stdout.preview,
        stderr: stderr.preview,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        stdoutChars: stdout.totalChars,
        stderrChars: stderr.totalChars,
        fullEvidenceToolCallId: result.evidenceToolCallId
      }
    );
  }

  private async verifyHttp(
    criterion: Extract<AcceptanceCriterion, { kind: "http" }>,
    signal?: AbortSignal
  ): Promise<AcceptanceEvidence> {
    const timeoutMs = criterion.timeoutMs ?? this.defaultProbeTimeoutMs;
    const response = await fetch(criterion.url, {
      method: "GET",
      // 不跟随重定向：期望的是这个地址本身的状态码，跟随之后就分不清了。
      redirect: "manual",
      signal: combinedTimeoutSignal(timeoutMs, signal)
    });
    // 只关心状态码，主动取消响应体，避免占着连接不放。
    await response.body?.cancel();
    const expectedStatus = criterion.expectedStatus ?? 200;
    const passed = response.status === expectedStatus;
    return this.evidence(
      criterion.id,
      passed,
      passed
        ? `${criterion.description ?? criterion.url} returned HTTP ${String(response.status)}.`
        : `${criterion.description ?? criterion.url} returned HTTP ${String(response.status)}; expected ${String(expectedStatus)}.`,
      { url: criterion.url, status: response.status, expectedStatus }
    );
  }

  private async verifyTcp(
    criterion: Extract<AcceptanceCriterion, { kind: "tcp" }>,
    signal?: AbortSignal
  ): Promise<AcceptanceEvidence> {
    const timeoutMs = criterion.timeoutMs ?? this.defaultProbeTimeoutMs;
    await connectTcp(criterion.host, criterion.port, timeoutMs, signal);
    return this.evidence(
      criterion.id,
      true,
      `${criterion.description ?? `${criterion.host}:${String(criterion.port)}`} accepted a TCP connection.`,
      { host: criterion.host, port: criterion.port }
    );
  }

  /**
   * 受管进程验收：先按条件筛出候选进程，优先取「运行中且探针通过」的那个，都不满足时
   * 退回最后一个候选——这样证据里能说明它当前到底是什么状态，而不是笼统的「没找到」。
   *
   * 即使进程自报 ready，只要有 URL 仍会现场再发一次 HTTP 请求：进程活着不等于服务可用。
   */
  private async verifyManagedProcess(
    criterion: Extract<AcceptanceCriterion, { kind: "managed_process" }>,
    signal?: AbortSignal
  ): Promise<AcceptanceEvidence> {
    signal?.throwIfAborted();
    if (!this.options.managedProcesses) {
      return this.evidence(criterion.id, false, `${criterion.description ?? criterion.id}: managed process runtime is unavailable.`);
    }
    const processes = await this.options.managedProcesses.listProcesses();
    signal?.throwIfAborted();
    const matchingProcesses = processes.filter((candidate) => {
      if (criterion.processId !== undefined && candidate.processId !== criterion.processId) return false;
      if (criterion.url !== undefined && candidate.url !== criterion.url) return false;
      if (criterion.cwd !== undefined && path.resolve(this.options.workspaceRoot, criterion.cwd) !== path.resolve(candidate.cwd ?? "")) return false;
      return true;
    });
    const process = matchingProcesses.find((candidate) =>
      (candidate.state === "running" || candidate.state === "ready")
      && (readBoolean(candidate.readiness, "passed")
        ?? readBoolean(candidate.readiness, "ready")
        ?? (typeof candidate.readiness === "boolean" ? candidate.readiness : false))
      && (!criterion.requireHttpReadiness || readString(candidate.readiness, "type") === "http" && Boolean(candidate.url))
    ) ?? matchingProcesses.at(-1);
    if (!process) {
      return this.evidence(criterion.id, false, `${criterion.description ?? criterion.processId ?? criterion.url ?? criterion.id}: managed process was not found.`);
    }
    // readiness 的形状不固定：可能是 { passed } / { ready } / 布尔值，逐种尝试。
    const readiness = readBoolean(process.readiness, "passed")
      ?? readBoolean(process.readiness, "ready")
      ?? (typeof process.readiness === "boolean" ? process.readiness : undefined);
    const readinessType = readString(process.readiness, "type");
    let passed = (process.state === "running" || process.state === "ready") && readiness === true;
    let liveHttpStatus: number | undefined;
    const liveUrl = criterion.url ?? process.url;
    if (criterion.requireHttpReadiness && (readinessType !== "http" || !liveUrl)) passed = false;
    if (passed && liveUrl) {
      try {
        const response = await fetch(liveUrl, {
          method: "GET",
          redirect: "manual",
          signal: combinedTimeoutSignal(this.defaultProbeTimeoutMs, signal)
        });
        liveHttpStatus = response.status;
        await response.body?.cancel();
        passed = response.status === 200;
      } catch {
        if (signal?.aborted) throw abortReason(signal);
        passed = false;
      }
    }
    return this.evidence(
      criterion.id,
      passed,
      passed
        ? `${criterion.description ?? process.processId} is managed, ready, and running${liveHttpStatus === 200 ? " (HTTP 200)" : ""}.`
        : `${criterion.description ?? process.processId} is ${process.state}${readiness === false ? " and its readiness probe failed" : readiness === undefined ? " without a successful readiness probe" : criterion.requireHttpReadiness && readinessType !== "http" ? " without required HTTP readiness" : criterion.requireHttpReadiness && !liveUrl ? " without a readiness URL" : liveUrl ? ` but live HTTP readiness returned ${String(liveHttpStatus ?? "no response")}` : ""}.`,
      { processId: process.processId, state: process.state, command: process.command, cwd: process.cwd, url: process.url, readiness, readinessType, liveHttpStatus }
    );
  }

  private evidence(
    criterionId: string,
    passed: boolean,
    summary: string,
    details?: Record<string, unknown>
  ): AcceptanceEvidence {
    const publicDetails = details === undefined ? undefined : redactSensitiveValue(details);
    return {
      criterionId,
      passed,
      summary,
      observedAt: new Date().toISOString(),
      details: isRecord(publicDetails) ? publicDetails : undefined
    };
  }
}

/** 只探测「端口能不能连上」，连上即断；超时和错误都要清掉定时器与监听器再销毁 socket。 */
async function connectTcp(
  host: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("TCP port must be between 1 and 65535.");
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      finish(new Error(`TCP readiness timed out after ${String(timeoutMs)}ms.`));
    }, timeoutMs);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => {
      const reason = abortReason(signal);
      finish(reason instanceof Error ? reason : new Error(String(reason)));
    };
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(error));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function combinedTimeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function readString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function compactOutput(value: string): {
  preview?: string;
  truncated: boolean;
  totalChars: number;
} {
  if (!value) return { preview: undefined, truncated: false, totalChars: 0 };
  const maxChars = 4_000;
  return {
    preview: value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`,
    truncated: value.length > maxChars,
    totalChars: value.length
  };
}

function readBoolean(value: unknown, key: string): boolean | undefined {
  return isRecord(value) && typeof value[key] === "boolean" ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
