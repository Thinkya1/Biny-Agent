/**
 * 内嵌终端管理器。
 *
 * 每个项目复用一个 PTY 会话：关闭右侧面板不杀 shell，重新打开时回放最近输出接着用。
 * node-pty 是原生模块，惰性加载并把失败转成可展示的错误，避免缺少编译产物时拖垮主进程。
 */
import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";

// 回放缓冲上限。够恢复可视区域和一段回滚历史，又不会让长跑任务无限占内存。
const maxReplayBytes = 256 * 1024;

interface TerminalSession {
  id: string;
  projectId: string;
  pty: IPty;
  replay: string;
}

export interface DesktopTerminalCreation {
  terminalId: string;
  replay: string;
}

export class DesktopTerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly byProject = new Map<string, string>();
  /** node-pty 是异步 import，创建期间先在项目维度占位，并发 create 复用同一次创建。 */
  private readonly pendingByProject = new Map<string, Promise<DesktopTerminalCreation>>();

  constructor(private readonly emit: (event: { terminalId: string; type: "data"; data: string } | { terminalId: string; type: "exit"; exitCode: number }) => void) {}

  async create(projectId: string, cwd: string, cols: number, rows: number): Promise<DesktopTerminalCreation> {
    const existingId = this.byProject.get(projectId);
    const existing = existingId ? this.sessions.get(existingId) : undefined;
    if (existing) {
      existing.pty.resize(sanitizeSize(cols, 80), sanitizeSize(rows, 24));
      return { terminalId: existing.id, replay: existing.replay };
    }
    const pending = this.pendingByProject.get(projectId);
    if (pending) return await pending;
    const creation = this.spawnSession(projectId, cwd, cols, rows);
    this.pendingByProject.set(projectId, creation);
    try {
      return await creation;
    } finally {
      if (this.pendingByProject.get(projectId) === creation) this.pendingByProject.delete(projectId);
    }
  }

  private async spawnSession(projectId: string, cwd: string, cols: number, rows: number): Promise<DesktopTerminalCreation> {
    const { spawn } = await import("node-pty");
    const shell = process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL : "/bin/zsh";
    const pty = spawn(shell, ["-l"], {
      name: "xterm-256color",
      cwd,
      cols: sanitizeSize(cols, 80),
      rows: sanitizeSize(rows, 24),
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" }
    });
    const session: TerminalSession = { id: randomUUID(), projectId, pty, replay: "" };
    this.sessions.set(session.id, session);
    this.byProject.set(projectId, session.id);
    pty.onData((data) => {
      session.replay = (session.replay + data).slice(-maxReplayBytes);
      this.emit({ terminalId: session.id, type: "data", data });
    });
    pty.onExit(({ exitCode }) => {
      this.sessions.delete(session.id);
      if (this.byProject.get(projectId) === session.id) this.byProject.delete(projectId);
      this.emit({ terminalId: session.id, type: "exit", exitCode });
    });
    return { terminalId: session.id, replay: "" };
  }

  write(terminalId: string, data: string): void {
    this.sessions.get(terminalId)?.pty.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.sessions.get(terminalId)?.pty.resize(sanitizeSize(cols, 80), sanitizeSize(rows, 24));
  }

  dispose(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    this.sessions.delete(terminalId);
    if (this.byProject.get(session.projectId) === terminalId) this.byProject.delete(session.projectId);
    session.pty.kill();
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) session.pty.kill();
    this.sessions.clear();
    this.byProject.clear();
  }
}

function sanitizeSize(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 2 && value <= 1_000 ? Math.floor(value) : fallback;
}
