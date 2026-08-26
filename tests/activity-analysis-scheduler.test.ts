/**
 * ActivityAnalysisScheduler 的时机层测试：防抖触发、窗口内重置、sweep 周期、stop 清理、
 * 并发防重入。全部用假时钟驱动，不依赖真实 60s/15min 等待；run 回调由测试注入记录调用。
 */
import assert from "node:assert/strict";
import {
  ACTIVITY_ANALYSIS_DEBOUNCE_MS,
  ACTIVITY_ANALYSIS_SWEEP_INTERVAL_MS,
  ActivityAnalysisScheduler,
  type ActivityAnalysisSchedulerTimers
} from "../src/activity/analysisScheduler.js";

/** 假时钟：mock setTimeout/clearTimeout，用 advance 推进并触发到期回调（含触发期间新排的、仍在窗口内的）。 */
class FakeTimers implements ActivityAnalysisSchedulerTimers {
  private nextId = 1;
  private time = 0;
  private timers = new Map<number, { deadline: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { deadline: this.time + ms, callback });
    return id;
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    while (true) {
      let next: { id: number; deadline: number; callback: () => void } | undefined;
      for (const [id, timer] of this.timers) {
        const candidate = { id, deadline: timer.deadline, callback: timer.callback };
        if (candidate.deadline <= target
          && (next === undefined || candidate.deadline < next.deadline
            || (candidate.deadline === next.deadline && candidate.id < next.id))) {
          next = candidate;
        }
      }
      if (!next) break;
      this.timers.delete(next.id);
      this.time = next.deadline;
      await next.callback();
    }
    this.time = target;
  }

  pendingCount(): number {
    return this.timers.size;
  }
}

/** 记录 run 调用并按真实时间短暂等待，让调度器在途的异步 run 与 .finally 链走完。 */
function makeRunRecorder(): { runs: number[]; maxInFlight: () => number; run: () => Promise<void> } {
  const runs: number[] = [];
  let inFlight = 0;
  let peakInFlight = 0;
  const run = async (): Promise<void> => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    runs.push(runs.length + 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
  };
  return { runs, maxInFlight: () => peakInFlight, run };
}

/** 等真实事件循环把调度器在途的 run/finally 走完（run 内部用真实 setTimeout 等 5ms）。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

await testDebounceFiresOnceAfterWindow();
await testDebounceResetsOnNewSessionEnd();
await testStopClearsTimers();
await testStopDuringInFlightRunDoesNotReschedule();
await testSweepFiresPeriodicallyAndSelfPerpetuates();
await testNotifyBeforeStartIsNoopAndStartIsIdempotent();
await testConcurrentTriggerQueuesSingleFollowUpRun();

/** session 结束 → 防抖 60s 后触发一轮；触发后窗口内不再重复。 */
async function testDebounceFiresOnceAfterWindow(): Promise<void> {
  const timers = new FakeTimers();
  const { runs, run } = makeRunRecorder();
  const scheduler = new ActivityAnalysisScheduler({
    run,
    debounceMs: ACTIVITY_ANALYSIS_DEBOUNCE_MS,
    sweepIntervalMs: Number.POSITIVE_INFINITY,
    timers
  });
  scheduler.start();
  scheduler.notifySessionEnded();
  await timers.advance(ACTIVITY_ANALYSIS_DEBOUNCE_MS - 1);
  assert.equal(runs.length, 0, "防抖窗口内不应触发");
  await timers.advance(1);
  await flush();
  assert.equal(runs.length, 1, "窗口结束应恰好触发一轮");
  await timers.advance(ACTIVITY_ANALYSIS_DEBOUNCE_MS * 10);
  await flush();
  assert.equal(runs.length, 1, "防抖触发后不应重复触发");
  scheduler.stop();
}

/** 防抖窗口内又有 session 结束会重置计时：两次结束合并成一轮，且按最后一次结束起算。 */
async function testDebounceResetsOnNewSessionEnd(): Promise<void> {
  const timers = new FakeTimers();
  const { runs, run } = makeRunRecorder();
  const scheduler = new ActivityAnalysisScheduler({
    run,
    debounceMs: ACTIVITY_ANALYSIS_DEBOUNCE_MS,
    sweepIntervalMs: Number.POSITIVE_INFINITY,
    timers
  });
  scheduler.start();
  scheduler.notifySessionEnded(); // t=0：预定 t=60s
  await timers.advance(30_000);
  scheduler.notifySessionEnded(); // 重置：预定 t=90s
  await timers.advance(30_000);   // t=60s：第一次的窗口已过，但被重置
  assert.equal(runs.length, 0, "重置后应按最后一次结束重新计时");
  await timers.advance(30_000);   // t=90s
  await flush();
  assert.equal(runs.length, 1, "两次结束应合并成一轮");
  await timers.advance(120_000);
  assert.equal(runs.length, 1);
  scheduler.stop();
}

/** stop 清理防抖与 sweep 定时器：stop 后不再触发、不再残留句柄。 */
async function testStopClearsTimers(): Promise<void> {
  const timers = new FakeTimers();
  const { runs, run } = makeRunRecorder();
  const scheduler = new ActivityAnalysisScheduler({
    run,
    debounceMs: ACTIVITY_ANALYSIS_DEBOUNCE_MS,
    sweepIntervalMs: ACTIVITY_ANALYSIS_SWEEP_INTERVAL_MS,
    timers
  });
  scheduler.start();
  scheduler.notifySessionEnded();
  scheduler.stop();
  assert.equal(timers.pendingCount(), 0, "stop 应清空防抖与 sweep 定时器");
  await timers.advance(ACTIVITY_ANALYSIS_SWEEP_INTERVAL_MS * 2);
  await flush();
  assert.equal(runs.length, 0, "stop 后任何触发路径都不应再运行");
}

/** 在途一轮未结束时 stop：这轮跑完即止，不再续排 sweep、不再补跑。 */
async function testStopDuringInFlightRunDoesNotReschedule(): Promise<void> {
  const timers = new FakeTimers();
  const { runs, run } = makeRunRecorder();
  const scheduler = new ActivityAnalysisScheduler({
    run,
    debounceMs: ACTIVITY_ANALYSIS_DEBOUNCE_MS,
    sweepIntervalMs: ACTIVITY_ANALYSIS_SWEEP_INTERVAL_MS,
    timers
  });
  scheduler.start();
  scheduler.notifySessionEnded();
  await timers.advance(ACTIVITY_ANALYSIS_DEBOUNCE_MS); // run 已在途
  scheduler.stop();
  await flush();
  assert.equal(runs.length, 1, "在途的最后一轮应跑完");
  await timers.advance(ACTIVITY_ANALYSIS_SWEEP_INTERVAL_MS * 2);
  await flush();
  assert.equal(runs.length, 1, "stop 后在途轮结束后不应续排");
}

/** 周期 sweep 每 15min 跑一轮 pendings，且自我延续成固定节奏。 */
async function testSweepFiresPeriodicallyAndSelfPerpetuates(): Promise<void> {
  const timers = new FakeTimers();
  const { runs, run } = makeRunRecorder();
  const scheduler = new ActivityAnalysisScheduler({
    run,
    debounceMs: ACTIVITY_ANALYSIS_DEBOUNCE_MS,
    sweepIntervalMs: ACTIVITY_ANALYSIS_SWEEP_INTERVAL_MS,
    timers
  });
  scheduler.start();
  await timers.advance(ACTIVITY_ANALYSIS_SWEEP_INTERVAL_MS - 1);
  assert.equal(runs.length, 0, "sweep 间隔未到不应触发");
  await timers.advance(1);
  await flush();
  assert.equal(runs.length, 1);
  await timers.advance(ACTIVITY_ANALYSIS_SWEEP_INTERVAL_MS);
  await flush();
  assert.equal(runs.length, 2, "sweep 跑完应续排下一轮");
  scheduler.stop();
}

/** 未 start 时的 notify 是空操作；start 幂等，重复 start 不重置已有节奏。 */
async function testNotifyBeforeStartIsNoopAndStartIsIdempotent(): Promise<void> {
  const timers = new FakeTimers();
  const { runs, run } = makeRunRecorder();
  const scheduler = new ActivityAnalysisScheduler({
    run,
    debounceMs: ACTIVITY_ANALYSIS_DEBOUNCE_MS,
    sweepIntervalMs: ACTIVITY_ANALYSIS_SWEEP_INTERVAL_MS,
    timers
  });
  scheduler.notifySessionEnded();
  await timers.advance(ACTIVITY_ANALYSIS_DEBOUNCE_MS);
  await flush();
  assert.equal(runs.length, 0, "未启动时 notify 不应排期");
  scheduler.start();
  scheduler.start(); // 幂等：不应重置/重排 sweep 节奏
  const pendingBefore = timers.pendingCount();
  scheduler.start();
  assert.equal(timers.pendingCount(), pendingBefore, "重复 start 不应新增定时器");
  await timers.advance(ACTIVITY_ANALYSIS_SWEEP_INTERVAL_MS);
  await flush();
  assert.equal(runs.length, 1);
  scheduler.stop();
}

/** 运行中又有 session 结束/到点：不并发重入，记一轮 queued 在结束后补跑；多次只补一轮。 */
async function testConcurrentTriggerQueuesSingleFollowUpRun(): Promise<void> {
  const timers = new FakeTimers();
  const { runs, maxInFlight, run } = makeRunRecorder();
  const scheduler = new ActivityAnalysisScheduler({
    run,
    debounceMs: ACTIVITY_ANALYSIS_DEBOUNCE_MS,
    sweepIntervalMs: Number.POSITIVE_INFINITY,
    timers
  });
  scheduler.start();
  scheduler.notifySessionEnded();
  await timers.advance(ACTIVITY_ANALYSIS_DEBOUNCE_MS); // run1 启动，在途
  assert.equal(runs.length, 1);
  scheduler.notifySessionEnded();
  scheduler.notifySessionEnded(); // 运行中多次结束：只应记一轮补跑
  await timers.advance(ACTIVITY_ANALYSIS_DEBOUNCE_MS); // 防抖到点 → running → 记 queued
  await flush();
  assert.equal(runs.length, 2, "在途结束后应补跑一轮");
  assert.equal(maxInFlight(), 1, "任何时刻都不得有两轮并发重入");
  await timers.advance(600_000);
  await flush();
  assert.equal(runs.length, 2, "补跑后不应再额外触发");
  scheduler.stop();
}