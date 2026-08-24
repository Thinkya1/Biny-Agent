/**
 * 单次 Agent run 的持久化生命周期。
 *
 * 它是运行控制面的 ledger，不替代 session JSONL，也不保存 prompt、工具参数或模型消息。
 * JSONL 负责事实与恢复；ledger 只回答“这次运行何时开始、以什么终态结束、是否可继续”。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { readSessionEvents } from "./events.js";
import { runtimeEventsForRun, type RuntimeHighWater } from "./runtimeEvent.js";
import { resolveSessionFile, agentDir, ensureAgentDirs } from "./store.js";
import type { SessionEvent } from "./recorder.js";

const ledgerVersion = 1 as const;

export type SessionRunStatus =
  | "running"
  | "completed"
  | "incomplete"
  | "blocked"
  | "cancelled"
  | "aborted"
  | "failed";

export interface SessionRunRecord {
  version: typeof ledgerVersion;
  runId: string;
  sessionId: string;
  messageId?: string;
  runtimeId?: string;
  turnId?: string;
  pid: number;
  status: SessionRunStatus;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  durationMs?: number;
  stopReason?: string;
  finishReason?: string;
  steps?: number;
  resumable?: boolean;
  blockedReason?: string;
  requiredAction?: string;
  error?: string;
  terminalEventId?: string;
  terminalEventSeq?: number;
}

export interface StartSessionRunOptions {
  runId: string;
  sessionId: string;
  messageId?: string;
  runtimeId?: string;
  turnId?: string;
  pid?: number;
  startedAt?: string;
}

export interface FinishSessionRunOptions {
  status: Exclude<SessionRunStatus, "running">;
  durationMs?: number;
  stopReason?: string;
  finishReason?: string;
  steps?: number;
  resumable?: boolean;
  blockedReason?: string;
  requiredAction?: string;
  error?: string;
  endedAt?: string;
  terminal?: RuntimeHighWater;
}

export class SessionRunLedger {
  constructor(private readonly persistenceRoot: string) {}

  async start(options: StartSessionRunOptions): Promise<SessionRunRecord> {
    assertId(options.runId, "run");
    assertId(options.sessionId, "session");
    const existing = await this.read(options.runId);
    if (existing) {
      if (existing.sessionId !== options.sessionId
        || existing.turnId !== undefined && options.turnId !== undefined && existing.turnId !== options.turnId) {
        throw new Error(`Run ${options.runId} is already bound to another session or turn.`);
      }
      return existing;
    }
    const startedAt = options.startedAt ?? new Date().toISOString();
    const record: SessionRunRecord = {
      version: ledgerVersion,
      runId: options.runId,
      sessionId: options.sessionId,
      messageId: options.messageId,
      runtimeId: options.runtimeId,
      turnId: options.turnId,
      pid: options.pid ?? process.pid,
      status: "running",
      startedAt,
      updatedAt: startedAt
    };
    await this.write(record);
    return record;
  }

  async finish(runId: string, options: FinishSessionRunOptions): Promise<SessionRunRecord | undefined> {
    assertId(runId, "run");
    const existing = await this.read(runId);
    if (!existing) return undefined;
    if (options.terminal?.runId !== undefined && options.terminal.runId !== runId) {
      throw new Error(`Terminal event ${options.terminal.eventId} belongs to another run.`);
    }
    if (
      existing.turnId !== undefined
      && options.terminal?.turnId !== undefined
      && existing.turnId !== options.terminal.turnId
    ) {
      throw new Error(`Terminal event ${options.terminal.eventId} belongs to another turn.`);
    }
    if (existing.status !== "running") {
      if (sameTerminal(existing, options)) return existing;
      throw new Error(`Run ${runId} already has a different terminal outcome.`);
    }
    const { terminal, ...projection } = options;
    const endedAt = options.endedAt ?? new Date().toISOString();
    const record: SessionRunRecord = {
      ...existing,
      ...projection,
      status: options.status,
      endedAt,
      updatedAt: endedAt,
      terminalEventId: terminal?.eventId,
      terminalEventSeq: terminal?.eventSeq,
      turnId: terminal?.turnId ?? existing.turnId
    };
    await this.write(record);
    return record;
  }

  async read(runId: string): Promise<SessionRunRecord | undefined> {
    assertId(runId, "run");
    const directory = await this.ensureDirectory();
    const filePath = path.join(directory, runFileName(runId));
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
      return isSessionRunRecord(parsed) ? parsed : undefined;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      return undefined;
    }
  }

  async listSessionRuns(sessionId: string): Promise<SessionRunRecord[]> {
    assertId(sessionId, "session");
    const directory = await this.ensureDirectory();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const records: SessionRunRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(directory, entry.name);
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
        if (!isSessionRunRecord(parsed) || parsed.sessionId !== sessionId) continue;
        const reconciled = await this.reconcileStale(parsed, filePath);
        records.push(reconciled);
      } catch {
        // 一个坏 ledger 条目不能让整个 session 列表不可用；JSONL 仍是恢复真相。
      }
    }
    return records.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt) || right.runId.localeCompare(left.runId));
  }

  async latestSessionRun(sessionId: string): Promise<SessionRunRecord | undefined> {
    return (await this.latestSessionRuns([sessionId])).get(sessionId);
  }

  /** 一次读取 ledger 目录并返回指定 session 的最新 run，避免列表按 session 重复 readdir。 */
  async latestSessionRuns(sessionIds: readonly string[]): Promise<Map<string, SessionRunRecord>> {
    const wanted = new Set(sessionIds);
    const latest = new Map<string, SessionRunRecord>();
    if (!wanted.size) return latest;
    const directory = await this.ensureDirectory();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(directory, entry.name);
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
        if (!isSessionRunRecord(parsed) || !wanted.has(parsed.sessionId)) continue;
        const reconciled = await this.reconcileStale(parsed, filePath);
        const current = latest.get(reconciled.sessionId);
        if (current === undefined || compareRunStart(reconciled, current) < 0) {
          latest.set(reconciled.sessionId, reconciled);
        }
      } catch {
        // 一个坏 ledger 条目不能让整个 session 列表不可用；JSONL 仍是恢复真相。
      }
    }
    return latest;
  }

  /** 删除某个 session 的所有运行投影；其它 session 的 ledger 不受影响。 */
  async deleteSessionRuns(sessionId: string): Promise<void> {
    assertId(sessionId, "session");
    const directory = await this.ensureDirectory();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
        if (isSessionRunRecord(parsed) && parsed.sessionId === sessionId) await fs.unlink(filePath);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }));
  }

  private async reconcileStale(record: SessionRunRecord, filePath: string): Promise<SessionRunRecord> {
    if (record.status !== "running" || isProcessAlive(record.pid)) return record;
    const terminal = await this.readCanonicalTerminal(record);
    if (terminal) {
      const endedAt = new Date().toISOString();
      const repaired: SessionRunRecord = {
        ...record,
        status: terminal.status,
        stopReason: terminal.stopReason,
        finishReason: terminal.finishReason,
        steps: terminal.steps,
        resumable: terminal.resumable,
        blockedReason: terminal.blockedReason,
        requiredAction: terminal.requiredAction,
        error: terminal.summary,
        endedAt,
        updatedAt: endedAt,
        terminalEventId: terminal.runtime?.eventId,
        terminalEventSeq: terminal.runtime?.eventSeq,
        turnId: terminal.runtime?.turnId ?? record.turnId
      };
      await this.writeAt(filePath, repaired).catch(() => undefined);
      return repaired;
    }
    const endedAt = new Date().toISOString();
    const reconciled: SessionRunRecord = {
      ...record,
      status: "aborted",
      stopReason: "process_exit",
      error: record.error ?? "The process that owned this run exited before it reached a terminal state.",
      endedAt,
      updatedAt: endedAt
    };
    await this.writeAt(filePath, reconciled).catch(() => undefined);
    return reconciled;
  }

  private async readCanonicalTerminal(record: SessionRunRecord): Promise<Extract<SessionEvent, { type: "turn_status" }> | undefined> {
    const filePath = await resolveSessionFile(this.persistenceRoot, record.sessionId).catch(() => undefined);
    if (!filePath) return undefined;
    const events = await readSessionEvents(filePath).catch(() => [] as SessionEvent[]);
    const terminals = runtimeEventsForRun(events, record.runId)
      .filter((event): event is Extract<SessionEvent, { type: "turn_status" }> =>
        event.type === "turn_status"
        && (record.turnId === undefined || event.runtime?.turnId === record.turnId)
      );
    return terminals.length === 1 ? terminals[0] : undefined;
  }

  private async write(record: SessionRunRecord): Promise<void> {
    const directory = await this.ensureDirectory();
    await this.writeAt(path.join(directory, runFileName(record.runId)), record);
  }

  private async writeAt(filePath: string, record: SessionRunRecord): Promise<void> {
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "w" });
      await fs.chmod(temporary, 0o600);
      const handle = await fs.open(temporary, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, filePath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async ensureDirectory(): Promise<string> {
    await ensureAgentDirs(this.persistenceRoot);
    const canonicalRoot = await fs.realpath(path.resolve(this.persistenceRoot));
    const runsDirectory = path.join(agentDir(canonicalRoot), "runs");
    const canonicalRuns = await fs.realpath(runsDirectory);
    if (canonicalRuns !== path.resolve(runsDirectory)) {
      throw new Error("Run ledger directory resolves outside .biny/runs.");
    }
    const directory = path.join(canonicalRuns, "ledger");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(directory) !== directory) {
      throw new Error("Run ledger directory must be a real directory.");
    }
    await fs.chmod(directory, 0o700);
    return directory;
  }
}

function runFileName(runId: string): string {
  return `${encodeURIComponent(runId)}.json`;
}

function compareRunStart(left: SessionRunRecord, right: SessionRunRecord): number {
  return Date.parse(right.startedAt) - Date.parse(left.startedAt) || right.runId.localeCompare(left.runId);
}

function isSessionRunRecord(value: unknown): value is SessionRunRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<SessionRunRecord>;
  return candidate.version === ledgerVersion
    && typeof candidate.runId === "string"
    && typeof candidate.sessionId === "string"
    && typeof candidate.pid === "number"
    && Number.isSafeInteger(candidate.pid)
    && isSessionRunStatus(candidate.status)
    && typeof candidate.startedAt === "string"
    && typeof candidate.updatedAt === "string"
    && (candidate.turnId === undefined || typeof candidate.turnId === "string")
    && (candidate.terminalEventId === undefined || typeof candidate.terminalEventId === "string")
    && (candidate.terminalEventSeq === undefined || Number.isSafeInteger(candidate.terminalEventSeq) && candidate.terminalEventSeq > 0);
}

function sameTerminal(existing: SessionRunRecord, options: FinishSessionRunOptions): boolean {
  return existing.status === options.status
    && (options.stopReason === undefined || existing.stopReason === options.stopReason)
    && (options.finishReason === undefined || existing.finishReason === options.finishReason)
    && (options.steps === undefined || existing.steps === options.steps)
    && (options.resumable === undefined || existing.resumable === options.resumable)
    && (options.blockedReason === undefined || existing.blockedReason === options.blockedReason)
    && (options.requiredAction === undefined || existing.requiredAction === options.requiredAction)
    && (options.error === undefined || existing.error === options.error)
    && (options.terminal === undefined
      || existing.terminalEventId === options.terminal.eventId
      && existing.terminalEventSeq === options.terminal.eventSeq
      && (existing.turnId === undefined || options.terminal.turnId === undefined || existing.turnId === options.terminal.turnId));
}

function isSessionRunStatus(value: unknown): value is SessionRunStatus {
  return value === "running"
    || value === "completed"
    || value === "incomplete"
    || value === "blocked"
    || value === "cancelled"
    || value === "aborted"
    || value === "failed";
}

function assertId(value: string, kind: string): void {
  if (!value || value === "." || value === ".." || value.includes("\0") || value.includes("/") || value.includes("\\")) {
    throw new Error(`Invalid ${kind} id: ${value}`);
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
