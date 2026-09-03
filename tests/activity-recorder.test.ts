import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentModel } from "../src/agent/core/types.js";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { ActivityPrivacyPolicy } from "../src/activity/privacyPolicy.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { ActivityStore } from "../src/activity/store.js";
import { refreshActivitySummary, refreshActivitySummaryWithNarrative } from "../src/activity/summary.js";
import { ActivityRecorderService, defaultActivitySidecarPath } from "../src/desktop/electron/main/ActivityRecorderService.js";

testDefaultActivitySidecarPath();
await testActivityServiceLifecycleQueue();
await testActivitySettingsRestartSidecar();
await testSidecarPersistsCaptureBeforeOcr();
await testEventAndFallbackStorage();
await testKeyBurstFirstTimestamp();
await testLegacyScreenshotMigration();
await testSessionClosePersistsDuration();
await testStorageLimitKeepsEventSemantics();
await testBrowserTabUrlStructuredStorageAndSearch();
await testFtsRebuildIncludesBrowserUrl();
await testRecordEventRollsBackWhenFtsInsertFails();
await testDailySummaryAggregation();
await testDailySummarySkipsPlaceholderAnalyses();
await testActivitySummaryNarrativePersistence();

function testDefaultActivitySidecarPath(): void {
  assert.equal(
    defaultActivitySidecarPath({
      packaged: false,
      resourcesPath: "/tmp/biny-resources",
      appPath: "/tmp/biny-project/out/main"
    }),
    "/tmp/biny-project/out/native/activity-recorder"
  );
  assert.equal(
    defaultActivitySidecarPath({
      packaged: false,
      resourcesPath: "/tmp/biny-resources",
      appPath: "/tmp/biny-project"
    }),
    "/tmp/biny-project/out/native/activity-recorder"
  );
}

async function testActivityServiceLifecycleQueue(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-service-"));
  const config = {
    ...defaultConfig,
    activity: { ...defaultActivitySettings, outputDirectory: root }
  };
  const configStore = {
    load: async () => config,
    save: async () => undefined
  } as AgentConfigStore;
  const service = new ActivityRecorderService({ configStore, sidecarPath: undefined });
  try {
    // stopInternal 会在 initialize/stop 的 operation queue 内执行；这个生命周期测试
    // 防止收口逻辑再次等待包含自身的 operationTail。
    await service.initialize();
    assert.equal(service.snapshot().state, "unavailable");
    await service.stop();
    assert.equal(service.snapshot().state, "stopped");
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function testActivitySettingsRestartSidecar(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-restart-"));
  const sidecarPath = path.join(root, "fake-sidecar");
  await writeFile(sidecarPath, `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"type":"start"'*)
      printf '%s\\n' '{"type":"event","occurredAt":"2026-08-31T01:00:00.000Z","eventType":"app_focus","application":"Fake App"}'
      ;;
    *'"type":"stop"'*)
      printf '%s\\n' '{"type":"event","occurredAt":"2026-08-31T01:00:01.000Z","eventType":"keypress","application":"Fake App","inputEventCount":1}'
      exit 0
      ;;
  esac
done
`, { mode: 0o700 });
  await chmod(sidecarPath, 0o700);
  let config = {
    ...defaultConfig,
    activity: { ...defaultActivitySettings, outputDirectory: root }
  };
  let revision = "1";
  const configStore = {
    load: async () => config,
    save: async (next: typeof config) => { config = next; },
    loadVersioned: async () => ({ config, revision }),
    saveVersioned: async (next: typeof config, expectedRevision: string) => {
      assert.equal(expectedRevision, revision);
      config = next;
      revision = String(Number(revision) + 1);
      return { config, revision };
    }
  } as AgentConfigStore;
  const service = new ActivityRecorderService({ configStore, sidecarPath });
  try {
    await service.initialize();
    await waitForActivitySnapshot(service, (snapshot) => snapshot.sessions === 1);
    await service.updateSettings({ captureDebounceMs: 6_000 }, revision);
    await waitForActivitySnapshot(service, (snapshot) => snapshot.sessions === 2);
    assert.equal(config.activity.captureDebounceMs, 6_000);
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function testSidecarPersistsCaptureBeforeOcr(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-ocr-order-"));
  const sidecarPath = path.join(root, "fake-sidecar");
  await writeFile(sidecarPath, `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"type":"start"'*)
      printf '%s\\n' '{"type":"capture","occurredAt":"2026-08-31T02:00:00.000Z","application":"Fake App","jpegBase64":"anBn","captureId":"capture-1","width":160,"height":90,"captureTrigger":"visual_change","fallbackReason":"visual_change"}'
      printf '%s\\n' '{"type":"ocr","captureId":"capture-1","ocrText":"late OCR"}'
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
  const service = new ActivityRecorderService({ configStore, sidecarPath });
  try {
    await service.initialize();
    await waitForActivitySnapshot(service, (snapshot) => snapshot.fallbackCaptures === 1);
    await service.stop();

    const verifier = new ActivityStore();
    try {
      await verifier.open(root);
      const frames = verifier.listRecentOcrFrames("2026-08-31T00:00:00.000Z", 10);
      assert.equal(frames.length, 1);
      assert.equal(frames[0]?.text, "late OCR");
    } finally {
      await verifier.close();
    }
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function waitForActivitySnapshot(
  service: ActivityRecorderService,
  predicate: (snapshot: ReturnType<ActivityRecorderService["snapshot"]>) => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate(service.snapshot())) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Activity service 状态未在预期时间内到达。");
}

async function testEventAndFallbackStorage(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-events-"));
  const store = new ActivityStore();
  try {
    await store.open(root);
    const sessionId = store.startSession("2026-08-24T00:00:00.000Z");
    const event = store.recordEvent({
      sessionId,
      occurredAt: "2026-08-24T00:00:01.000Z",
      eventType: "focus_changed",
      application: "Test App",
      windowTitle: "token=window-secret",
      axRole: "AXTextField",
      rawText: "token=secret user@example.com /Users/think/private.txt",
      inputEventCount: 3
    });
    assert.equal(event.source, "event");
    assert.equal(event.snapshotPath, undefined);
    assert.match(event.summary, /\[redacted\]/u);
    assert.doesNotMatch(event.summary, /secret|user@example\.com|\/Users\/think/iu);
    assert.equal(store.snapshot().events, 1);
    assert.equal(store.snapshot().fallbackCaptures, 0);
    assert.equal(store.snapshot().storageBytes, 0);
    assert.equal((await stat(path.join(root, "snapshots"))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(root, "activity.sqlite"))).mode & 0o777, 0o600);

    const capture = await store.recordFallbackCapture({
      sessionId,
      occurredAt: "2026-08-24T00:00:02.000Z",
      eventType: "fallback_capture",
      application: "Test App",
      bundleId: "com.example.test",
      fallbackReason: "missing_window_or_focus_semantics",
      rawOcrText: "secret=ocr-secret user@example.com\n第二行 OCR",
      jpeg: Buffer.from("jpeg"),
      inputEventCount: 4
    });
    assert.equal(capture.source, "screenshot_fallback");
    assert.ok(capture.snapshotPath);
    assert.match(capture.ocrText ?? "", /\n第二行 OCR/u);
    assert.deepEqual(await readFile(path.join(root, capture.snapshotPath)), Buffer.from("jpeg"));
    assert.equal((await stat(path.join(root, capture.snapshotPath))).mode & 0o777, 0o600);
    assert.equal(store.search("Test App").length, 2);
    assert.equal(store.search("ocr-secret").length, 0);
    assert.equal(store.search("window-secret").length, 0);
    const deferredCapture = await store.recordFallbackCapture({
      sessionId,
      occurredAt: "2026-08-24T00:00:03.000Z",
      eventType: "fallback_capture",
      application: "Test App",
      jpeg: Buffer.from("jpeg-2"),
      inputEventCount: 5
    });
    assert.equal(deferredCapture.ocrText, undefined);
    store.updateSnapshotOcr(deferredCapture.snapshotId!, "late-secret=hidden\nlate OCR");
    const ocrSummaries = store.listSessionEventSummaries(sessionId).filter((event) => event.eventType === "screenshot_ocr");
    assert.equal(ocrSummaries.some((event) => event.ocrText?.includes("late OCR") === true), true);
    assert.equal(store.search("late").some((event) => event.ocrText?.includes("late OCR") === true), true);
    assert.deepEqual(store.snapshot(), {
      sessions: 1,
      events: 1,
      fallbackCaptures: 2,
      storageBytes: 10,
      recentSessions: [{
        id: sessionId,
        startedAt: "2026-08-24T00:00:00.000Z",
        endedAt: undefined,
        snapshotCount: 2,
        eventCount: 1,
        applications: ["Test App"]
      }]
    });
    await store.clear();
    assert.deepEqual(store.snapshot(), { sessions: 0, events: 0, fallbackCaptures: 0, storageBytes: 0, recentSessions: [] });
    assert.equal((await stat(path.join(root, "snapshots"))).mode & 0o777, 0o700);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testLegacyScreenshotMigration(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-legacy-"));
  const snapshots = path.join(root, "snapshots");
  await mkdir(snapshots, { recursive: true });
  const snapshotPath = path.join(snapshots, "legacy.jpg");
  await writeFile(snapshotPath, Buffer.from("old-jpeg"));
  const database = new DatabaseSync(path.join(root, "activity.sqlite"));
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE activity_sessions (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      event_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,
      occurred_at TEXT NOT NULL,
      application TEXT,
      bundle_id TEXT,
      summary TEXT NOT NULL,
      ocr_text TEXT,
      input_event_count INTEGER NOT NULL DEFAULT 0,
      snapshot_path TEXT NOT NULL,
      snapshot_bytes INTEGER NOT NULL
    );
  `);
  database.prepare("INSERT INTO activity_sessions (id, started_at, event_count) VALUES (?, ?, ?)").run("legacy-session", "2026-08-23T00:00:00.000Z", 1);
  database.prepare("INSERT INTO activity_events (session_id, occurred_at, application, summary, snapshot_path, snapshot_bytes) VALUES (?, ?, ?, ?, ?, ?)").run(
    "legacy-session",
    "2026-08-23T00:00:01.000Z",
    "Legacy App",
    "前台应用：Legacy App；检测到屏幕活动",
    "snapshots/legacy.jpg",
    8
  );
  database.close();

  const store = new ActivityStore();
  try {
    await store.open(root);
    const result = store.search("Legacy App");
    assert.equal(result.length, 1);
    assert.equal(result[0]?.source, "screenshot_fallback");
    assert.equal(result[0]?.eventType, "fallback_capture");
    assert.equal(store.snapshot().events, 0);
    assert.equal(store.snapshot().fallbackCaptures, 1);
    assert.equal(store.snapshot().storageBytes, 8);
    await store.clear();
    await assert.rejects(stat(snapshotPath));
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testKeyBurstFirstTimestamp(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-keyburst-"));
  const store = new ActivityStore();
  try {
    await store.open(root);
    const sessionId = store.startSession("2026-08-25T10:00:00.000Z");
    store.recordEvent({
      sessionId,
      occurredAt: "2026-08-25T10:00:01.250Z",
      eventType: "keypress",
      application: "Editor",
      keyCode: 36,
      inputEventCount: 4,
      inputEventFirstAt: "2026-08-25T10:00:00.100Z"
    });
    const detail = store.getSessionDetail(sessionId);
    assert.equal(detail?.events[0]?.inputEventFirstAt, "2026-08-25T10:00:00.100Z");
    assert.equal(detail?.events[0]?.inputEventCount, 4);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testSessionClosePersistsDuration(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-session-fields-"));
  const store = new ActivityStore();
  try {
    await store.open(root);
    const sessionId = store.startSession("2026-08-25T10:00:00.000Z");
    store.endSession(sessionId, "2026-08-25T10:01:02.345Z");
    const database = new DatabaseSync(path.join(root, "activity.sqlite"));
    const row = database.prepare("SELECT duration_ms, updated_at FROM activity_sessions WHERE id = ?").get(sessionId) as {
      duration_ms: number;
      updated_at: string;
    };
    assert.equal(row.duration_ms, 62_345);
    assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T/u);
    database.close();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testStorageLimitKeepsEventSemantics(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-limit-"));
  const store = new ActivityStore();
  try {
    await store.open(root);
    const sessionId = store.startSession("2026-08-25T00:00:00.000Z");
    await store.recordFallbackCapture({
      sessionId,
      occurredAt: "2026-08-25T00:00:01.000Z",
      eventType: "fallback_capture",
      application: "Canvas App",
      jpeg: Buffer.alloc(1_100_000, 1)
    });
    assert.deepEqual(store.snapshot(), {
      sessions: 1,
      events: 0,
      fallbackCaptures: 1,
      storageBytes: 1_100_000,
      recentSessions: [{
        id: sessionId,
        startedAt: "2026-08-25T00:00:00.000Z",
        endedAt: undefined,
        snapshotCount: 1,
        eventCount: 0,
        applications: ["Canvas App"]
      }]
    });
    await store.rotateSnapshots(1);
    assert.deepEqual(store.snapshot(), {
      sessions: 1,
      events: 0,
      fallbackCaptures: 0,
      storageBytes: 0,
      recentSessions: [{
        id: sessionId,
        startedAt: "2026-08-25T00:00:00.000Z",
        endedAt: undefined,
        snapshotCount: 0,
        eventCount: 0,
        applications: ["Canvas App"]
      }]
    });
    const result = store.search("Canvas App");
    assert.equal(result.length, 1);
    assert.equal(result[0]?.snapshotPath, undefined);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testBrowserTabUrlStructuredStorageAndSearch(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-browser-"));
  const store = new ActivityStore();
  try {
    await store.open(root);
    const sessionId = store.startSession("2026-08-26T00:00:00.000Z");
    const event = store.recordEvent({
      sessionId,
      occurredAt: "2026-08-26T00:00:01.000Z",
      eventType: "browser_visit",
      application: "Google Chrome",
      bundleId: "com.google.Chrome",
      url: "https://chat.openai.com/c/abc-123",
      windowTitle: "ChatGPT — writing a design doc",
      inputEventCount: 2
    });
    // 结构化 URL 列原样保留（不经过内容脱敏），且不进入送分析的 summary。
    assert.equal(event.url, "https://chat.openai.com/c/abc-123");
    assert.equal(event.windowTitle, "ChatGPT — writing a design doc");
    assert.doesNotMatch(event.summary, /chat\.openai\.com/u);
    assert.match(event.summary, /ChatGPT/u);

    // URL 与标签标题都进入 FTS 可搜索范围。
    assert.equal(store.search("openai").length, 1);
    assert.equal(store.search("design doc").length, 1);
    assert.equal(store.search("chat.openai.com")[0]?.url, "https://chat.openai.com/c/abc-123");
    assert.equal(store.search("https://chat.openai.com/c/abc-123").length, 1);

    // 控制字符清理 + 限长：URL 列不落 NUL，超长截断到 2048。
    const dirty = store.recordEvent({
      sessionId,
      occurredAt: "2026-08-26T00:00:02.000Z",
      eventType: "browser_visit",
      application: "Safari",
      url: "https://example.com/ok\u0000\npayload",
      windowTitle: "Dirty URL"
    });
    assert.equal(dirty.url, "https://example.com/ok payload");
    const longUrl = `https://example.com/${"x".repeat(4_000)}`;
    const long = store.recordEvent({
      sessionId,
      occurredAt: "2026-08-26T00:00:03.000Z",
      eventType: "browser_visit",
      application: "Safari",
      url: longUrl,
      windowTitle: "Long URL"
    });
    assert.equal(long.url?.length, 2_048);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testFtsRebuildIncludesBrowserUrl(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-fts-rebuild-"));
  const database = new DatabaseSync(path.join(root, "activity.sqlite"));
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE activity_sessions (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      event_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,
      occurred_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'event',
      event_type TEXT NOT NULL DEFAULT 'activity',
      application TEXT,
      bundle_id TEXT,
      window_title TEXT,
      ax_role TEXT,
      ax_title TEXT,
      url TEXT,
      redacted_text TEXT,
      mouse_event_type TEXT,
      mouse_button INTEGER,
      summary TEXT NOT NULL,
      ocr_text TEXT,
      input_event_count INTEGER NOT NULL DEFAULT 0,
      fallback_reason TEXT,
      snapshot_path TEXT,
      snapshot_bytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE activity_fts USING fts5(
      event_id UNINDEXED,
      summary,
      application,
      window_title,
      event_type,
      ax_role,
      ax_title,
      redacted_text,
      ocr_text,
      occurred_at
    );
  `);
  database.prepare("INSERT INTO activity_sessions (id, started_at, event_count) VALUES (?, ?, ?)").run("browser-session", "2026-08-26T00:00:00.000Z", 1);
  database.prepare(`
    INSERT INTO activity_events (
      session_id, occurred_at, source, event_type, application,
      window_title, url, summary
    ) VALUES (?, ?, 'event', 'browser_tab_changed', ?, ?, ?, ?)
  `).run(
    "browser-session",
    "2026-08-26T00:00:01.000Z",
    "Google Chrome",
    "ChatGPT — writing a design doc",
    "https://chat.openai.com/c/abc-123",
    "前台应用：Google Chrome；窗口：ChatGPT — writing a design doc；事件：浏览器标签变化；检测到活动"
  );
  database.prepare(`
    INSERT INTO activity_fts (
      event_id, summary, application, window_title, event_type,
      ax_role, ax_title, redacted_text, ocr_text, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    1,
    "前台应用：Google Chrome；窗口：ChatGPT — writing a design doc；事件：浏览器标签变化；检测到活动",
    "Google Chrome",
    "ChatGPT — writing a design doc",
    "browser_tab_changed",
    "",
    "",
    "",
    "",
    "2026-08-26T00:00:01.000Z"
  );
  database.close();

  const store = new ActivityStore();
  try {
    await store.open(root);
    // 旧库 FTS 缺 url 列：open 时自动重建索引，URL 进入可搜索范围。
    const rows = store.search("openai");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.url, "https://chat.openai.com/c/abc-123");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** insertEvent 的事务性：FTS 写入失败时事件行与 session 计数必须整体回滚，不留半截数据。 */
async function testRecordEventRollsBackWhenFtsInsertFails(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-txn-"));
  const store = new ActivityStore();
  try {
    await store.open(root);
    const sessionId = store.startSession("2026-08-26T00:00:00.000Z");
    // 用第二个连接拆掉 FTS 表，迫使 recordEvent 在事件行写入之后才失败。
    const saboteur = new DatabaseSync(path.join(root, "activity.sqlite"));
    saboteur.exec("DROP TABLE activity_fts;");
    saboteur.close();
    assert.throws(
      () => store.recordEvent({
        sessionId,
        occurredAt: "2026-08-26T00:00:01.000Z",
        eventType: "focus_changed",
        application: "Test App"
      }),
      /activity_fts/u
    );
    assert.equal(store.snapshot().events, 0, "事件行必须随事务回滚");
    assert.equal(store.snapshot().recentSessions[0]?.eventCount, 0, "session 计数必须随事务回滚");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testDailySummaryAggregation(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-summary-"));
  const store = new ActivityStore();
  try {
    await store.open(root);
    const startedAt = new Date(2026, 7, 28, 9, 0, 0).toISOString();
    const focusAt = new Date(2026, 7, 28, 10, 0, 0).toISOString();
    const endedAt = new Date(2026, 7, 28, 11, 0, 0).toISOString();
    const firstSession = store.startSession(startedAt);
    store.recordEvent({ sessionId: firstSession, occurredAt: startedAt, eventType: "app_focus", application: "Editor" });
    store.recordEvent({ sessionId: firstSession, occurredAt: focusAt, eventType: "app_focus", application: "Browser" });
    await store.recordFallbackCapture({
      sessionId: firstSession,
      occurredAt: new Date(2026, 7, 28, 9, 30, 0).toISOString(),
      eventType: "fallback_capture",
      application: "Editor",
      rawOcrText: "hello",
      jpeg: Buffer.from("jpeg")
    });
    store.endSession(firstSession, endedAt);
    store.recordAnalysis(makeAnalysis(firstSession, "完成编辑器与浏览器切换"));

    const secondSession = store.startSession(new Date(2026, 7, 28, 13, 0, 0).toISOString());
    store.recordEvent({ sessionId: secondSession, occurredAt: new Date(2026, 7, 28, 13, 1, 0).toISOString(), eventType: "click", application: "Terminal" });
    store.recordEvent({ sessionId: secondSession, occurredAt: new Date(2026, 7, 28, 13, 2, 0).toISOString(), eventType: "keypress", application: "Docs" });
    store.endSession(secondSession, new Date(2026, 7, 28, 15, 0, 0).toISOString());
    store.recordAnalysis({ ...makeAnalysis(secondSession), worthKnowledge: true });

    // 只与当天重叠、但从前一天开始的 session 不应进入日报。
    const spanningSession = store.startSession(new Date(2026, 7, 27, 23, 0, 0).toISOString());
    store.endSession(spanningSession, new Date(2026, 7, 28, 2, 0, 0).toISOString());

    const summary = refreshActivitySummary(
      store,
      "daily",
      "2026-08-28",
      new Date(2026, 7, 30, 12, 0, 0)
    );
    assert.equal(summary.stats.sessionCount, 2);
    assert.equal(summary.stats.totalActiveMs, 4 * 60 * 60 * 1_000);
    assert.equal(summary.stats.analyzedCount, 2);
    assert.equal(summary.stats.notWorthCount, 1);
    assert.equal(summary.stats.snapshotCount, 1);
    assert.equal(summary.stats.ocrCharCount, 5);
    assert.deepEqual(summary.stats.hours.filter((item) => item.count > 0), [
      { hour: 9, count: 1 },
      { hour: 13, count: 1 }
    ]);
    assert.deepEqual(summary.stats.apps, [
      { app: "Browser", durationMs: 3_600_000 },
      { app: "Docs", durationMs: 3_600_000 },
      { app: "Editor", durationMs: 3_600_000 },
      { app: "Terminal", durationMs: 3_600_000 }
    ]);
    assert.deepEqual(summary.stats.keyMoments, [{
      sessionId: firstSession,
      title: "完成编辑器与浏览器切换",
      startedAt,
      durationMs: 2 * 60 * 60 * 1_000
    }]);
    assert.equal(summary.isPartial, false);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testDailySummarySkipsPlaceholderAnalyses(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-summary-placeholders-"));
  const store = new ActivityStore();
  try {
    await store.open(root);
    const sessionId = store.startSession("2026-08-28T09:00:00.000Z");
    store.endSession(sessionId, "2026-08-28T09:00:00.000Z");
    store.recordAnalysis({ ...makeAnalysis(sessionId), summary: "零星活动", title: "零星活动" });
    const failedSessionId = store.startSession("2026-08-28T10:00:00.000Z");
    store.endSession(failedSessionId, "2026-08-28T10:00:00.000Z");
    store.recordAnalysis({ ...makeAnalysis(failedSessionId), summary: "活动分析失败", title: "活动分析失败" });

    const summary = refreshActivitySummary(
      store,
      "daily",
      "2026-08-28",
      new Date("2026-08-30T12:00:00.000Z")
    );
    assert.equal(summary.stats.sessionCount, 2);
    assert.equal(summary.stats.analyzedCount, 0);
    assert.equal(summary.stats.notWorthCount, 0);
    assert.deepEqual(summary.stats.keyMoments, []);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testActivitySummaryNarrativePersistence(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-summary-narrative-"));
  const store = new ActivityStore();
  try {
    await store.open(root);
    const model: AgentModel = {
      provider: "test",
      modelId: "summary-model",
      runtime: "provider",
      stream: async () => (async function* () {
        yield { type: "text-delta" as const, text: "今天完成了编辑器和浏览器之间的工作切换。" };
        yield { type: "finish" as const, reason: "stop" as const };
      })()
    };
    const settings = { ...defaultActivitySettings, analysisPolicy: "external_allowed" as const };
    const summary = await refreshActivitySummaryWithNarrative(
      store,
      "daily",
      "2026-08-28",
      {
        model,
        policy: new ActivityPrivacyPolicy(settings),
        withNarrative: true,
        now: new Date("2026-08-30T12:00:00.000Z")
      }
    );
    assert.equal(summary.summary, "今天完成了编辑器和浏览器之间的工作切换。");
    assert.equal(summary.model, "summary-model");
    assert.equal(store.getSummary("daily", "2026-08-28")?.model, "summary-model");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function makeAnalysis(sessionId: string, title?: string) {
  return {
    sessionId,
    analyzedAt: "2026-08-30T00:00:00.000Z",
    analyzerModel: "test",
    title,
    description: title,
    summary: title ?? "测试活动",
    topics: [],
    prs: [],
    issues: [],
    people: [],
    versions: [],
    decisions: [],
    entities: [],
    highlights: [],
    commits: [],
    identifiers: [],
    repos: [],
    events: [],
    urls: [],
    worthMemory: false,
    worthKnowledge: false,
    isMeeting: false,
    storageTier: "standard" as const,
    confidence: 1,
    sourceEventCount: 1,
    inputHash: `hash-${sessionId}`
  };
}
