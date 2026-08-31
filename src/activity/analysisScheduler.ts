/**
 * Activity 分析的触发调度器（触发式，采用已验证的触发窗口）。
 *
 * 两条触发路径共用一个「跑一轮 pending 分析」的回调：
 * - session 结束触发：endSession 后防抖 ~60s（落在已验证的结束后 43-77s 触发窗口内），
 *   防抖窗口内又有 session 结束就重置计时合并成一次，避免快速连续 session 各烧一次模型。
 * - 周期 sweep 兜底：每 ~15min 扫一次「已结束但还没分析」的 session 补分析。模型瞬时失败
 *   保持 pending 的现状正好让 sweep 充当自然重试，无需 attempt 计数。
 *
 * 调度器只管时机，不碰数据与策略：是否放行由回调内部过 ActivityPrivacyPolicy 的
 * analysisPolicy 门禁决定；门禁未放行时定时器照常跑、分析不执行（session 保持 pending，
 * 策略放开后下一轮 sweep 自然补上）。进程退出/服务停止时 stop() 清理两个定时器。
 */

/** session 结束后自动分析的防抖延迟；落在已验证的 43-77s 触发窗口内。 */
export const ACTIVITY_ANALYSIS_DEBOUNCE_MS = 60_000;
/** 周期 sweep 兜底间隔。 */
export const ACTIVITY_ANALYSIS_SWEEP_INTERVAL_MS = 15 * 60_000;

export type ActivityAnalysisTimerHandle = ReturnType<typeof setTimeout>;

/** 可注入的定时器，便于测试用假时钟驱动；默认用真实 setTimeout/clearTimeout。 */
export interface ActivityAnalysisSchedulerTimers {
  setTimeout: (callback: () => void, ms: number) => ActivityAnalysisTimerHandle;
  clearTimeout: (handle: ActivityAnalysisTimerHandle) => void;
}

export interface ActivityAnalysisSchedulerOptions {
  /**
   * 跑一轮 pending 分析。由调用方（ActivityRecorderService）提供：开独立 store 连接、
   * 构造 policy 与模型、调 analyzePendingActivitySessions。调度器只在时机成熟时调用它，
   * 并保证不并发重入（运行期间又有触发会记一轮，结束后补跑）。
   */
  run: () => void | Promise<void>;
  debounceMs?: number;
  sweepIntervalMs?: number;
  timers?: ActivityAnalysisSchedulerTimers;
}

const defaultTimers: ActivityAnalysisSchedulerTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle)
};

export class ActivityAnalysisScheduler {
  private readonly run: () => void | Promise<void>;
  private readonly debounceMs: number;
  private readonly sweepIntervalMs: number;
  private readonly timers: ActivityAnalysisSchedulerTimers;
  private debounceTimer?: ActivityAnalysisTimerHandle;
  private sweepTimer?: ActivityAnalysisTimerHandle;
  private running = false;
  private queued = false;
  private stopped = true;

  constructor(options: ActivityAnalysisSchedulerOptions) {
    this.run = options.run;
    this.debounceMs = options.debounceMs ?? ACTIVITY_ANALYSIS_DEBOUNCE_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? ACTIVITY_ANALYSIS_SWEEP_INTERVAL_MS;
    this.timers = options.timers ?? defaultTimers;
  }

  /** 启动周期 sweep 兜底。幂等：已启动时不重置既有节奏。 */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleSweep();
  }

  /** session 结束触发：防抖合并，窗口内再次结束就重置计时。停止后不再排期。 */
  notifySessionEnded(): void {
    if (this.stopped) return;
    this.clearDebounce();
    this.debounceTimer = this.timers.setTimeout(() => {
      this.debounceTimer = undefined;
      this.trigger();
    }, this.debounceMs);
  }

  /** 停止并清理防抖与 sweep 定时器；在途的一轮跑完后不再续排。 */
  stop(): void {
    this.stopped = true;
    this.clearDebounce();
    this.clearSweep();
  }

  private scheduleSweep(): void {
    if (this.stopped) return;
    this.clearSweep();
    this.sweepTimer = this.timers.setTimeout(() => {
      this.sweepTimer = undefined;
      this.trigger();
    }, this.sweepIntervalMs);
  }

  private trigger(): void {
    if (this.stopped) return;
    if (this.running) {
      // 正在跑（例如 sweep 进行中又来了 session 结束防抖）：记一轮，结束后补跑，
      // 避免两条路径并发重入、对同一批 pending session 重复烧模型。
      this.queued = true;
      return;
    }
    this.running = true;
    let result: void | Promise<void>;
    try {
      result = this.run();
    } catch {
      result = undefined;
    }
    void Promise.resolve(result).catch(() => undefined).finally(() => {
      this.running = false;
      if (this.queued && !this.stopped) {
        this.queued = false;
        this.trigger();
        return;
      }
      // sweep 自我延续：无论这轮由谁触发，跑完都重排下一次周期 sweep，维持兜底节奏。
      this.scheduleSweep();
    });
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== undefined) this.timers.clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  private clearSweep(): void {
    if (this.sweepTimer !== undefined) this.timers.clearTimeout(this.sweepTimer);
    this.sweepTimer = undefined;
  }
}
