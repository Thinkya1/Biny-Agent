import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActivityEmbeddingScheduler } from "../src/activity/embeddingScheduler.js";
import { precomputeActivityEmbeddings } from "../src/activity/semanticSearch.js";
import { ActivityStore } from "../src/activity/store.js";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";
import type { ActivityAnalysisSchedulerTimers } from "../src/activity/analysisScheduler.js";

async function testEmbeddingSchedulerRunsOnceAndStops(): Promise<void> {
  const timers = new FakeTimers();
  let runs = 0;
  const scheduler = new ActivityEmbeddingScheduler({
    run: () => { runs += 1; },
    initialDelayMs: 10,
    sweepIntervalMs: 20,
    timers
  });
  scheduler.start();
  timers.advance(9);
  assert.equal(runs, 0);
  timers.advance(1);
  await flush();
  assert.equal(runs, 1);
  timers.advance(20);
  await flush();
  assert.equal(runs, 2);
  scheduler.stop();
  timers.advance(100);
  assert.equal(runs, 2);
}

async function testBackgroundEmbeddingPrecomputesOcr(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-background-"));
  const store = new ActivityStore();
  try {
    await store.open(root);
    const sessionId = store.startSession("2026-08-31T09:00:00.000Z");
    await store.recordFallbackCapture({
      sessionId,
      occurredAt: "2026-08-31T09:00:01.000Z",
      eventType: "fallback_capture",
      application: "Editor",
      rawOcrText: "修复登录崩溃",
      jpeg: Buffer.from("jpeg")
    });
    const runtime = fakeEmbeddingRuntime();
    const result = await precomputeActivityEmbeddings({
      store,
      getEmbeddingRuntime: async () => runtime,
      now: () => new Date("2026-08-31T09:01:00.000Z")
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.embedded, 1);
    assert.equal(store.listOcrEmbeddingRows(runtime.fingerprint).length, 1);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testDailySummaryTimerPersistsSummary(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-daily-timer-"));
  const sidecarPath = path.join(root, "fake-sidecar");
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayIso = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 9, 0, 0).toISOString();
  const yesterdayKey = [
    String(yesterday.getFullYear()),
    String(yesterday.getMonth() + 1).padStart(2, "0"),
    String(yesterday.getDate()).padStart(2, "0")
  ].join("-");
  await writeFile(sidecarPath, `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"type":"start"'*)
      printf '%s\\n' '{"type":"event","occurredAt":"${yesterdayIso}","eventType":"app_focus","application":"Editor"}'
      ;;
    *'"type":"stop"'*)
      exit 0
      ;;
  esac
done
`, { mode: 0o700 });
  await chmod(sidecarPath, 0o700);
  const config = {
    ...defaultConfig,
    activity: { ...defaultActivitySettings, outputDirectory: root }
  };
  const configStore = { load: async () => config } as AgentConfigStore;
  const timers = new FakeTimers();
  let notes = 0;
  const service = new ActivityRecorderService({
    configStore,
    sidecarPath,
    dailySummaryTimers: timers,
    dailySummaryInitialDelayMs: 10,
    dailySummaryIntervalMs: 20,
    embeddingInitialDelayMs: 60_000,
    embeddingSweepIntervalMs: 0,
    writeDailyNote: async () => {
      notes += 1;
      return path.join(root, "daily.md");
    }
  });
  try {
    await service.initialize();
    await waitFor(() => service.snapshot().sessions === 1);
    timers.advance(10);
    await waitForSummary(root, yesterdayKey);
    assert.equal(notes, 1);
    timers.advance(20);
    await waitFor(() => notes === 2);
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
}

function fakeEmbeddingRuntime(): EmbeddingModelRuntime {
  return {
    fingerprint: "activity-background-test",
    descriptor: {
      ref: { kind: "local", model: "multilingual-e5-small" },
      fingerprint: "activity-background-test",
      displayName: "test",
      dimensions: 2,
      recommendedThresholds: { currentWorkspace: 0.3, crossWorkspace: 0.2 },
      source: "local",
      installed: true,
      available: true
    },
    embed: async (request) => ({
      embeddings: request.texts.map(() => new Float32Array([1, 0])),
      dimensions: 2,
      fingerprint: "activity-background-test",
      model: { kind: "local", model: "multilingual-e5-small" }
    })
  };
}

class FakeTimers implements ActivityAnalysisSchedulerTimers {
  private now = 0;
  private nextId = 0;
  private readonly pending = new Map<ReturnType<typeof setTimeout>, { due: number; callback: () => void }>();

  setTimeout = (callback: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const handle = { id: this.nextId += 1 } as unknown as ReturnType<typeof setTimeout>;
    this.pending.set(handle, { due: this.now + Math.max(0, ms), callback });
    return handle;
  };

  clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
    this.pending.delete(handle);
  };

  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const next = [...this.pending.entries()]
        .filter(([, entry]) => entry.due <= target)
        .sort((left, right) => left[1].due - right[1].due)[0];
      if (!next) break;
      this.pending.delete(next[0]);
      this.now = next[1].due;
      next[1].callback();
    }
    this.now = target;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Activity 后台状态未在预期时间内到达。");
}

async function waitForSummary(root: string, dateKey: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const verifier = new ActivityStore();
    await verifier.open(root);
    const summary = verifier.getSummary("daily", dateKey);
    await verifier.close();
    if (summary) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("日报没有在定时触发后写入 SQLite。");
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

await testEmbeddingSchedulerRunsOnceAndStops();
await testBackgroundEmbeddingPrecomputesOcr();
await testDailySummaryTimerPersistsSummary();
