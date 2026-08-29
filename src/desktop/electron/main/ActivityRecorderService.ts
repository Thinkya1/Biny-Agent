/**
 * Electron 主进程里的 Activity 编排服务。
 *
 * sidecar 优先发送事件和最小 AX 语义；只有 sidecar 明确要求视觉 fallback 时才发送 JPEG。
 * 这里负责 JSONL IPC、事件/截图落盘、事件驱动的 Session 生命周期、容量淘汰和运行态广播。
 */
import { access } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { AgentConfigStore } from "../../../config/store.js";
import type { ActivitySettings } from "../../../activity/settings.js";
import { ActivityStore, type ActivityRecentSessionRow, type ActivitySearchResult } from "../../../activity/store.js";
import { ActivityPrivacyPolicy } from "../../../activity/privacyPolicy.js";
import {
  analyzePendingActivitySessions,
  buildActivityReport,
  type ActivityReportResult
} from "../../../activity/analyzer.js";
import { resolveActivityAnalysisModel } from "../../../activity/analysisModel.js";
import { ActivityAnalysisScheduler } from "../../../activity/analysisScheduler.js";
import type { ActivityRuntimeSnapshot, ActivityServiceState } from "../../../activity/types.js";
import type { DesktopQuickChatScreenContext, DesktopSystemSettingsPane } from "../../protocol.js";

/** QuickChat 注入用：OCR 文本片段的最大长度，避免把整屏文字塞进 prompt。 */
const SCREEN_CONTEXT_OCR_LIMIT = 400;
/** 屏幕上下文里保留的最近会话标题条数。 */
const SCREEN_CONTEXT_SESSION_LIMIT = 5;

interface SidecarEventMessage {
  type: "event";
  occurredAt: string;
  eventType: string;
  application?: string;
  bundleId?: string;
  windowTitle?: string;
  axRole?: string;
  axTitle?: string;
  /** 浏览器标签页标题（sidecar 通过 AppleScript 采集，优先于窗口标题）。 */
  tabTitle?: string;
  /** 浏览器标签页 URL。 */
  url?: string;
  text?: string;
  mouseEventType?: string;
  mouseButton?: number;
  inputEventCount?: number;
  axAvailable?: boolean;
  fallbackReason?: string;
}

interface SidecarCaptureMessage {
  type: "capture";
  occurredAt: string;
  eventType?: string;
  application?: string;
  bundleId?: string;
  windowTitle?: string;
  axRole?: string;
  axTitle?: string;
  text?: string;
  jpegBase64: string;
  ocrText?: string;
  inputEventCount?: number;
  fallbackReason?: string;
}

interface SidecarStatusMessage {
  type: "status";
  status: string;
  screenRecordingGranted: boolean;
  accessibilityGranted: boolean;
  inputMonitoringGranted?: boolean;
  axAvailable?: boolean;
  fallbackAvailable?: boolean;
  currentApplication?: string;
  error?: string;
}

interface SidecarErrorMessage {
  type: "error";
  message: string;
}

type SidecarMessage = SidecarEventMessage | SidecarCaptureMessage | SidecarStatusMessage | SidecarErrorMessage;

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
  /** QuickChat 屏幕上下文的小型内存缓存：只存文本片段，从 sidecar 事件流滚动更新，不落盘。 */
  private lastWindowTitle?: string;
  private lastBrowserUrl?: string;
  private lastOcrExcerpt?: string;
  private lastContextAt?: string;
  private sessionId?: string;
  private sessionIdleTimer?: ReturnType<typeof setTimeout>;
  private lastActivityAt?: number;
  private settings?: ActivitySettings;
  private currentApplication?: string;
  private state: ActivityServiceState = "stopped";
  private error?: string;
  private screenRecordingGranted = false;
  private accessibilityGranted = false;
  private inputMonitoringGranted = false;
  private axAvailable = false;
  private fallbackAvailable = false;
  private operationTail = Promise.resolve();
  private snapshotCache: ActivityRuntimeSnapshot = this.createSnapshot();
  /** 退出时中止在途的一轮分析，避免 quit 被未完成的模型请求拖住。 */
  private readonly analysisAbort = new AbortController();
  private readonly analysisScheduler: ActivityAnalysisScheduler;

  constructor(options: ActivityRecorderServiceOptions) {
    this.configStore = options.configStore;
    this.sidecarPath = options.sidecarPath;
    this.emit = options.emit;
    // 触发式分析：session 结束防抖 + 周期 sweep 共用这一个入口；调度器只管时机，
    // 门禁与模型选择在 runAnalysisSweep 里每次新鲜加载。
    this.analysisScheduler = new ActivityAnalysisScheduler({
      run: () => this.runAnalysisSweep()
    });
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
    // 先停调度并中止在途分析，再停采集：stopInternal 会结束当前 session，
    // 提前 stop() 让那次 endCurrentSession 不再排出「60s 后才跑」的分析（进程已在退出）。
    this.analysisScheduler.stop();
    this.analysisAbort.abort();
    await this.enqueue(async () => await this.stopInternal());
  }

  snapshot(): ActivityRuntimeSnapshot {
    this.snapshotCache = this.createSnapshot();
    return structuredClone(this.snapshotCache);
  }

  /** 读取全局活动设置；QuickChat 不应借用需要 projectId 的设置事务快照。 */
  async settingsSnapshot(): Promise<ActivitySettings> {
    return structuredClone((await this.configStore.load()).activity);
  }

  /**
   * QuickChat 注入用的实时屏幕上下文。只回文本片段（前台应用、窗口标题、URL、OCR 截取、
   * 最近会话标题），绝不携带截图字节——这是用户对「原文不出设备」策略的显式例外，但仍只放行文本。
   * 数据来自 sidecar 事件流滚动更新的内存缓存，不查库、不触发新的采集。
   */
  screenContextSnapshot(): DesktopQuickChatScreenContext {
    const recording = this.state === "running";
    return {
      recording,
      frontmostApplication: this.currentApplication,
      windowTitle: this.lastWindowTitle,
      browserUrl: this.lastBrowserUrl,
      ocrExcerpt: this.lastOcrExcerpt,
      recentSessionTitles: this.recentSessionTitles(),
      capturedAt: this.lastContextAt
    };
  }

  async search(query: string, limit = 20): Promise<ActivitySearchResult[]> {
    return await this.enqueue(async () => this.store.search(query, limit));
  }

  /**
   * 最近分析出的会话标题（取分析摘要首行，截断）。同步直读采集 store，只命中
   * activity_session_analysis 的 summary 文本列——不读事件原文、不碰截图，符合隐私红线。
   * store 未打开（首次启动前）或查询失败时静默回空，宁缺毋滥。
   */
  private recentSessionTitles(): string[] {
    try {
      const sinceIso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      return this.store
        .listRecentSessionsWithAnalysis(sinceIso, 30)
        .map((row: ActivityRecentSessionRow) => firstLine(row.analysis?.summary, 80))
        .filter((title): title is string => title !== undefined)
        .slice(0, SCREEN_CONTEXT_SESSION_LIMIT);
    } catch {
      return [];
    }
  }

  /**
   * 生成指定日期的打工日记。刻意不走 enqueue、也不用采集器自己的 store：补分析要做多次模型
   * 调用，占用采集器那条写连接会把事件落盘队列堵住。这里开一条独立连接读分析表、补分析。
   */
  async buildReport(date?: string): Promise<ActivityReportResult> {
    const config = await this.configStore.load();
    const policy = new ActivityPrivacyPolicy(config.activity);
    const model = resolveActivityAnalysisModel(config);
    const store = new ActivityStore();
    await store.open(config.activity.outputDirectory);
    try {
      return await buildActivityReport({ store, policy, model }, date ?? "today");
    } finally {
      await store.close();
    }
  }

  /**
   * 触发式分析的统一入口：session 结束防抖与周期 sweep 都跑这一个。
   * 与 buildReport 同理开一条独立 store 连接，避免多次模型调用堵住采集写队列。
   * 每次新鲜加载 config，因此 analysisPolicy/analysisModel 的改动下一轮即生效；
   * 策略未放行或无可用模型时由 analyzePendingActivitySessions 逐项跳过，session 保持待分析。
   */
  private async runAnalysisSweep(): Promise<void> {
    const config = await this.configStore.load();
    const policy = new ActivityPrivacyPolicy(config.activity);
    const model = resolveActivityAnalysisModel(config);
    const store = new ActivityStore();
    await store.open(config.activity.outputDirectory);
    try {
      await analyzePendingActivitySessions({ store, policy, model, signal: this.analysisAbort.signal });
    } finally {
      await store.close();
    }
  }

  async requestPermission(permission: DesktopSystemSettingsPane): Promise<void> {
    await this.enqueue(async () => {
      this.send({ type: "request_permission", permission });
    });
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
    await this.stopInternal();
    this.settings = nextSettings;
    try {
      await this.store.open(nextSettings.outputDirectory);
    } catch (error) {
      this.analysisScheduler.stop();
      this.setState("error", safeError(error));
      return;
    }
    if (!nextSettings.enabled) {
      // 采集关停时分析也不再排期；待分析 session 留在库里，重新启用后由 sweep 补。
      this.analysisScheduler.stop();
      this.setState("paused");
      return;
    }
    // 分析作用于已落库的数据，不依赖 sidecar 是否可用，因此 enabled 即启动触发调度。
    this.analysisScheduler.start();
    if (this.sidecarPath === undefined) {
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
      if (this.child !== child) return;
      this.output?.close();
      this.output = undefined;
      this.child = undefined;
      this.endCurrentSession(new Date().toISOString());
      if (this.state !== "stopped" && this.settings?.enabled) {
        this.setState("error", `Activity sidecar 已退出（code=${code ?? "-"}, signal=${signal ?? "-"}）。`);
      }
    });
    const sessionStartedAt = new Date().toISOString();
    this.sessionId = this.store.startSession(sessionStartedAt);
    this.lastActivityAt = Date.parse(sessionStartedAt);
    this.scheduleSessionIdleClose();
    this.send({ type: "start", settings });
    this.setState("running");
  }

  private async stopInternal(): Promise<void> {
    this.clearSessionIdleTimer();
    const child = this.child;
    this.output?.close();
    this.output = undefined;
    this.child = undefined;
    this.state = "stopped";
    this.error = undefined;
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
    this.endCurrentSession(new Date().toISOString());
  }

  private handleSidecarLine(line: string): void {
    let message: SidecarMessage;
    try {
      message = JSON.parse(line) as SidecarMessage;
    } catch {
      this.setState("error", "Activity sidecar 返回了无效 JSON。");
      return;
    }
    if (message.type === "event") {
      void this.enqueue(async () => await this.persistEvent(message));
      return;
    }
    if (message.type === "capture") {
      void this.enqueue(async () => await this.persistFallbackCapture(message));
      return;
    }
    if (message.type === "status") {
      this.screenRecordingGranted = message.screenRecordingGranted;
      this.accessibilityGranted = message.accessibilityGranted;
      this.inputMonitoringGranted = message.inputMonitoringGranted ?? message.accessibilityGranted;
      this.axAvailable = message.axAvailable ?? false;
      this.fallbackAvailable = message.fallbackAvailable ?? message.screenRecordingGranted;
      this.currentApplication = message.currentApplication ?? undefined;
      if (message.status === "paused") this.setState("paused", message.error);
      else if (message.status === "stopped") this.setState("stopped", message.error);
      else if (message.status === "unavailable") this.setState("unavailable", message.error);
      else if (message.status === "running" || message.status === "permission_required") this.setState("running", message.error);
      else this.publish();
      return;
    }
    this.setState("error", message.message);
  }

  private async persistEvent(message: SidecarEventMessage): Promise<void> {
    if (!this.settings || !this.child) return;
    try {
      const sessionId = this.ensureSession(message.occurredAt);
      this.store.recordEvent({
        sessionId,
        occurredAt: message.occurredAt,
        eventType: message.eventType,
        application: message.application,
        bundleId: message.bundleId,
        windowTitle: message.tabTitle ?? message.windowTitle,
        axRole: message.axRole,
        axTitle: message.axTitle,
        url: message.url,
        rawText: message.text,
        mouseEventType: message.mouseEventType,
        mouseButton: message.mouseButton,
        fallbackReason: message.fallbackReason,
        inputEventCount: message.inputEventCount
      });
      this.axAvailable = message.axAvailable ?? this.axAvailable;
      this.currentApplication = message.application ?? this.currentApplication;
      // 事件是高频流，OCR 只认 capture；这里滚动记下窗口标题与浏览器 URL 供 QuickChat 注入。
      this.updateScreenContextCache({
        occurredAt: message.occurredAt,
        windowTitle: message.tabTitle ?? message.windowTitle,
        url: message.url
      });
      this.publish();
    } catch (error) {
      this.setState("error", safeError(error));
    }
  }

  private async persistFallbackCapture(message: SidecarCaptureMessage): Promise<void> {
    if (!this.settings || !this.child) return;
    try {
      const jpeg = Buffer.from(message.jpegBase64, "base64");
      if (!jpeg.byteLength) throw new Error("Activity fallback 返回了空 JPEG。");
      const sessionId = this.ensureSession(message.occurredAt);
      await this.store.recordFallbackCapture({
        sessionId,
        occurredAt: message.occurredAt,
        eventType: message.eventType ?? "fallback_capture",
        application: message.application,
        bundleId: message.bundleId,
        windowTitle: message.windowTitle,
        axRole: message.axRole,
        axTitle: message.axTitle,
        rawText: message.text,
        rawOcrText: message.ocrText,
        fallbackReason: message.fallbackReason,
        inputEventCount: message.inputEventCount,
        jpeg
      }, this.settings.maxStorageMb);
      this.currentApplication = message.application ?? this.currentApplication;
      // 视觉 fallback 携带 OCR 文本；截断到注入上限后滚动缓存，截图字节绝不进缓存。
      this.updateScreenContextCache({
        occurredAt: message.occurredAt,
        windowTitle: message.windowTitle,
        ocrText: message.ocrText
      });
      this.publish();
    } catch (error) {
      this.setState("error", safeError(error));
    }
  }

  /**
   * 滚动更新 QuickChat 注入用的屏幕文本缓存。只有非空文本才覆盖对应槽位，避免心跳事件
   * 把刚采集到的内容冲掉；OCR 截断到注入上限。全程只碰文本，不接触截图字节。
   */
  private updateScreenContextCache(update: { occurredAt?: string; windowTitle?: string; url?: string; ocrText?: string }): void {
    const windowTitle = update.windowTitle?.trim();
    if (windowTitle) this.lastWindowTitle = windowTitle;
    const url = update.url?.trim();
    if (url) this.lastBrowserUrl = url;
    const ocr = update.ocrText?.trim();
    if (ocr) this.lastOcrExcerpt = ocr.slice(0, SCREEN_CONTEXT_OCR_LIMIT);
    if (update.occurredAt) this.lastContextAt = update.occurredAt;
  }

  private ensureSession(occurredAt: string): string {
    const occurredAtMs = parseTimestamp(occurredAt);
    const idleTimeoutMs = this.settings?.idleTimeoutMs ?? 30_000;
    if (this.sessionId && this.lastActivityAt !== undefined && occurredAtMs - this.lastActivityAt >= idleTimeoutMs) {
      this.endCurrentSession(toIso(this.lastActivityAt + idleTimeoutMs));
    }
    if (!this.sessionId) this.sessionId = this.store.startSession(occurredAt);
    this.lastActivityAt = Math.max(this.lastActivityAt ?? occurredAtMs, occurredAtMs);
    this.scheduleSessionIdleClose();
    return this.sessionId;
  }

  private scheduleSessionIdleClose(): void {
    this.clearSessionIdleTimer();
    const idleTimeoutMs = Math.max(1_000, this.settings?.idleTimeoutMs ?? 30_000);
    this.sessionIdleTimer = setTimeout(() => {
      void this.enqueue(async () => {
        if (!this.sessionId || this.lastActivityAt === undefined) return;
        const now = Date.now();
        if (now - this.lastActivityAt < idleTimeoutMs) {
          this.scheduleSessionIdleClose();
          return;
        }
        this.endCurrentSession(toIso(this.lastActivityAt + idleTimeoutMs));
        this.publish();
      });
    }, idleTimeoutMs);
  }

  private clearSessionIdleTimer(): void {
    if (this.sessionIdleTimer !== undefined) clearTimeout(this.sessionIdleTimer);
    this.sessionIdleTimer = undefined;
  }

  private endCurrentSession(endedAt: string): void {
    this.clearSessionIdleTimer();
    if (this.sessionId) {
      this.store.endSession(this.sessionId, endedAt);
      // session 结束 → 防抖触发分析；调度器未启动（采集停用/已退出）时 notify 为空操作。
      this.analysisScheduler.notifySessionEnded();
    }
    this.sessionId = undefined;
    this.lastActivityAt = undefined;
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
      inputMonitoringGranted: this.inputMonitoringGranted,
      axAvailable: this.axAvailable,
      fallbackAvailable: this.fallbackAvailable,
      sessions: storeSnapshot.sessions,
      events: storeSnapshot.events,
      fallbackCaptures: storeSnapshot.fallbackCaptures,
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
      return { sessions: 0, events: 0, fallbackCaptures: 0, storageBytes: 0, recentSessions: [] };
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

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 取一段文本的首个非空行并截断；空输入返回 undefined（供过滤掉无标题的分析行）。 */
function firstLine(text: string | undefined, maxLength: number): string | undefined {
  const line = text?.split("\n").map((part) => part.trim()).find((part) => part.length > 0);
  if (!line) return undefined;
  return line.length > maxLength ? `${line.slice(0, maxLength)}…` : line;
}
