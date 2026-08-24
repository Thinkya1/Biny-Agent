/**
 * Electron 主进程里的 Activity 编排服务。
 *
 * Swift sidecar 只提供系统采集能力；这里负责启动/停止、JSONL IPC、JPEG/SQLite/FTS5 落盘、
 * 存储上限和运行态广播。默认配置关闭采集，sidecar 不会因为应用启动而自动截屏。
 */
import { access } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { AgentConfigStore } from "../../../config/store.js";
import type { ActivitySettings } from "../../../activity/settings.js";
import { ActivityStore, type ActivitySearchResult } from "../../../activity/store.js";
import type { ActivityRuntimeSnapshot, ActivityServiceState } from "../../../activity/types.js";

interface SidecarCaptureMessage {
  type: "capture";
  occurredAt: string;
  application?: string;
  bundleId?: string;
  jpegBase64: string;
  ocrText?: string;
  inputEventCount: number;
}

interface SidecarStatusMessage {
  type: "status";
  status: string;
  screenRecordingGranted: boolean;
  accessibilityGranted: boolean;
  currentApplication?: string;
  inputEventCount: number;
  error?: string;
}

interface SidecarErrorMessage {
  type: "error";
  message: string;
}

export interface ActivityRecorderServiceOptions {
  configStore: AgentConfigStore;
  sidecarPath: string | undefined;
  emit?: (snapshot: ActivityRuntimeSnapshot) => void;
}

export class ActivityRecorderService {
  private readonly store = new ActivityStore();
  private readonly configStore: AgentConfigStore;
  private readonly sidecarPath: string | undefined;
  private readonly emit: ((snapshot: ActivityRuntimeSnapshot) => void) | undefined;
  private child?: ChildProcessWithoutNullStreams;
  private output?: Interface;
  private sessionId?: string;
  private settings?: ActivitySettings;
  private currentApplication?: string;
  private state: ActivityServiceState = "stopped";
  private error?: string;
  private screenRecordingGranted = false;
  private accessibilityGranted = false;
  private operationTail = Promise.resolve();
  private snapshotCache: ActivityRuntimeSnapshot = this.createSnapshot();

  constructor(options: ActivityRecorderServiceOptions) {
    this.configStore = options.configStore;
    this.sidecarPath = options.sidecarPath;
    this.emit = options.emit;
  }

  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      const config = await this.configStore.load();
      await this.applySettings(config.activity);
    });
  }

  async refresh(): Promise<void> {
    await this.enqueue(async () => {
      const config = await this.configStore.load();
      await this.applySettings(config.activity);
    });
  }

  async stop(): Promise<void> {
    await this.enqueue(async () => await this.stopInternal());
  }

  snapshot(): ActivityRuntimeSnapshot {
    this.snapshotCache = this.createSnapshot();
    return structuredClone(this.snapshotCache);
  }

  async search(query: string, limit = 20): Promise<ActivitySearchResult[]> {
    return await this.enqueue(async () => this.store.search(query, limit));
  }

  async clear(): Promise<ActivityRuntimeSnapshot> {
    await this.enqueue(async () => {
      const shouldRestart = this.settings?.enabled === true;
      await this.stopInternal();
      await this.store.clear();
      if (shouldRestart && this.settings) await this.startSidecar(this.settings);
    });
    this.publish();
    return this.snapshot();
  }

  private async applySettings(nextSettings: ActivitySettings): Promise<void> {
    this.settings = nextSettings;
    try {
      await this.store.open(nextSettings.outputDirectory);
    } catch (error) {
      await this.stopInternal();
      this.setState("error", safeError(error));
      return;
    }
    if (!nextSettings.enabled) {
      await this.stopInternal();
      this.setState("paused");
      return;
    }
    if (this.sidecarPath === undefined) {
      await this.stopInternal();
      this.setState("unavailable", "当前平台没有可用的 macOS Activity sidecar。");
      return;
    }
    try {
      await access(this.sidecarPath);
      await this.startSidecar(nextSettings);
    } catch (error) {
      await this.stopInternal();
      this.setState("unavailable", safeError(error));
    }
  }

  private async startSidecar(settings: ActivitySettings): Promise<void> {
    await this.stopInternal();
    const child = spawn(this.sidecarPath!, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.output = createInterface({ input: child.stdout });
    this.output.on("line", (line) => this.handleSidecarLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) this.error = message.slice(0, 500);
    });
    child.once("error", (error) => {
      this.setState("error", safeError(error));
    });
    child.once("exit", (code, signal) => {
      this.output?.close();
      this.output = undefined;
      this.child = undefined;
      if (this.sessionId) {
        this.store.endSession(this.sessionId, new Date().toISOString());
        this.sessionId = undefined;
      }
      if (this.state !== "stopped" && this.settings?.enabled) {
        this.setState("error", `Activity sidecar 已退出（code=${code ?? "-"}, signal=${signal ?? "-"}）。`);
      }
    });
    this.sessionId = this.store.startSession(new Date().toISOString());
    this.send({ type: "start", settings });
    this.setState("running");
  }

  private async stopInternal(): Promise<void> {
    const child = this.child;
    this.output?.close();
    this.output = undefined;
    this.child = undefined;
    if (child && !child.killed) {
      this.send({ type: "stop" }, child);
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (!child.killed) child.kill("SIGTERM");
          resolve();
        }, 1_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    if (this.sessionId) {
      this.store.endSession(this.sessionId, new Date().toISOString());
      this.sessionId = undefined;
    }
    this.state = "stopped";
  }

  private handleSidecarLine(line: string): void {
    let message: SidecarCaptureMessage | SidecarStatusMessage | SidecarErrorMessage;
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      this.setState("error", "Activity sidecar 返回了无效 JSON。");
      return;
    }
    if (message.type === "capture") {
      void this.persistCapture(message);
      return;
    }
    if (message.type === "status") {
      this.screenRecordingGranted = message.screenRecordingGranted;
      this.accessibilityGranted = message.accessibilityGranted;
      this.currentApplication = message.currentApplication;
      if (message.status === "permission_required") this.setState("permission_required", message.error);
      else if (message.status === "paused") this.setState("paused");
      else if (message.status === "running") this.setState("running", message.error);
      else if (message.status === "sensitive_application") this.publish();
      return;
    }
    this.setState("error", message.message);
  }

  private async persistCapture(message: SidecarCaptureMessage): Promise<void> {
    if (!this.sessionId || !this.settings) return;
    try {
      const jpeg = Buffer.from(message.jpegBase64, "base64");
      await this.store.recordCapture({
        sessionId: this.sessionId,
        occurredAt: message.occurredAt,
        application: message.application,
        bundleId: message.bundleId,
        rawOcrText: message.ocrText,
        jpeg,
        inputEventCount: message.inputEventCount
      }, this.settings.maxStorageMb);
      this.currentApplication = message.application;
      this.publish();
    } catch (error) {
      this.setState("error", safeError(error));
    }
  }

  private send(command: Record<string, unknown>, target = this.child): void {
    if (!target || !target.stdin.writable) return;
    target.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private setState(state: ActivityServiceState, error?: string): void {
    this.state = state;
    this.error = error;
    this.publish();
  }

  private publish(): void {
    this.snapshotCache = this.createSnapshot();
    this.emit?.(structuredClone(this.snapshotCache));
  }

  private createSnapshot(): ActivityRuntimeSnapshot {
    const storeSnapshot = this.storeSnapshot();
    return {
      state: this.state,
      collectorAvailable: this.sidecarPath !== undefined,
      screenRecordingGranted: this.screenRecordingGranted,
      accessibilityGranted: this.accessibilityGranted,
      sessions: storeSnapshot.sessions,
      captures: storeSnapshot.captures,
      storageBytes: storeSnapshot.storageBytes,
      recentSessions: storeSnapshot.recentSessions,
      currentSessionId: this.sessionId,
      currentApplication: this.currentApplication,
      error: this.error
    };
  }

  private storeSnapshot(): ReturnType<ActivityStore["snapshot"]> {
    try {
      return this.store.snapshot();
    } catch {
      return { sessions: 0, captures: 0, storageBytes: 0, recentSessions: [] };
    }
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationTail.then(operation, operation);
    this.operationTail = next.then(() => undefined, () => undefined);
    return await next;
  }
}

export function defaultActivitySidecarPath(options: { packaged: boolean; resourcesPath: string; appPath: string }): string | undefined {
  if (process.platform !== "darwin") return undefined;
  return options.packaged
    ? path.join(options.resourcesPath, "native/activity-recorder")
    : path.join(options.appPath, "out/native/activity-recorder");
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
