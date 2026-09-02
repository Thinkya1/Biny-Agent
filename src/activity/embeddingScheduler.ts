/**
 * Activity 语义向量的后台调度器。
 *
 * 向量是 OCR/分析结果的本地派生缓存，不应把首次搜索变成一次不可预测的大任务。
 * 调度节奏与后台 sweep 一致：启动后延迟一次，之后固定周期检查；用户刚有
 * 输入时跳过本轮，下一轮再补。
 */

export const ACTIVITY_EMBEDDING_INITIAL_DELAY_MS = 120_000;
export const ACTIVITY_EMBEDDING_SWEEP_INTERVAL_MS = 10 * 60_000;

export type ActivityEmbeddingTimerHandle = ReturnType<typeof setTimeout>;

export interface ActivityEmbeddingSchedulerTimers {
  setTimeout: (callback: () => void, ms: number) => ActivityEmbeddingTimerHandle;
  clearTimeout: (handle: ActivityEmbeddingTimerHandle) => void;
}

export interface ActivityEmbeddingSchedulerOptions {
  run: () => void | Promise<void>;
  isUserActive?: () => boolean;
  initialDelayMs?: number;
  sweepIntervalMs?: number;
  timers?: ActivityEmbeddingSchedulerTimers;
}

const defaultTimers: ActivityEmbeddingSchedulerTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle)
};

export class ActivityEmbeddingScheduler {
  private readonly run: () => void | Promise<void>;
  private readonly isUserActive: (() => boolean) | undefined;
  private readonly initialDelayMs: number;
  private readonly sweepIntervalMs: number;
  private readonly timers: ActivityEmbeddingSchedulerTimers;
  private initialTimer?: ActivityEmbeddingTimerHandle;
  private sweepTimer?: ActivityEmbeddingTimerHandle;
  private running = false;
  private stopped = true;

  constructor(options: ActivityEmbeddingSchedulerOptions) {
    this.run = options.run;
    this.isUserActive = options.isUserActive;
    this.initialDelayMs = options.initialDelayMs ?? ACTIVITY_EMBEDDING_INITIAL_DELAY_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? ACTIVITY_EMBEDDING_SWEEP_INTERVAL_MS;
    this.timers = options.timers ?? defaultTimers;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.initialTimer = this.timers.setTimeout(() => {
      this.initialTimer = undefined;
      this.trigger();
    }, Math.max(0, this.initialDelayMs));
    this.scheduleSweep();
  }

  stop(): void {
    this.stopped = true;
    if (this.initialTimer !== undefined) this.timers.clearTimeout(this.initialTimer);
    if (this.sweepTimer !== undefined) this.timers.clearTimeout(this.sweepTimer);
    this.initialTimer = undefined;
    this.sweepTimer = undefined;
  }

  private scheduleSweep(): void {
    if (this.stopped || !Number.isFinite(this.sweepIntervalMs) || this.sweepIntervalMs <= 0) return;
    this.sweepTimer = this.timers.setTimeout(() => {
      this.sweepTimer = undefined;
      this.trigger();
      this.scheduleSweep();
    }, this.sweepIntervalMs);
  }

  private trigger(): void {
    if (this.stopped || this.running || this.isUserActive?.()) return;
    this.running = true;
    let result: void | Promise<void>;
    try {
      result = this.run();
    } catch {
      result = undefined;
    }
    void Promise.resolve(result).catch(() => undefined).finally(() => {
      this.running = false;
    });
  }
}
