import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ActivityStore } from "../src/activity/store.js";

await testEventAndFallbackStorage();
await testLegacyScreenshotMigration();
await testStorageLimitKeepsEventSemantics();
await testBrowserTabUrlStructuredStorageAndSearch();
await testFtsRebuildIncludesBrowserUrl();
await testRecordEventRollsBackWhenFtsInsertFails();

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
      rawOcrText: "secret=ocr-secret user@example.com",
      jpeg: Buffer.from("jpeg"),
      inputEventCount: 4
    }, 10);
    assert.equal(capture.source, "screenshot_fallback");
    assert.ok(capture.snapshotPath);
    assert.deepEqual(await readFile(path.join(root, capture.snapshotPath)), Buffer.from("jpeg"));
    assert.equal((await stat(path.join(root, capture.snapshotPath))).mode & 0o777, 0o600);
    assert.equal(store.search("Test App").length, 2);
    assert.equal(store.search("ocr-secret").length, 0);
    assert.equal(store.search("window-secret").length, 0);
    assert.deepEqual(store.snapshot(), {
      sessions: 1,
      events: 2,
      fallbackCaptures: 1,
      storageBytes: 4,
      recentSessions: [{
        id: sessionId,
        startedAt: "2026-08-24T00:00:00.000Z",
        endedAt: undefined,
        snapshotCount: 1,
        eventCount: 2,
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
    assert.equal(store.snapshot().events, 1);
    assert.equal(store.snapshot().fallbackCaptures, 1);
    assert.equal(store.snapshot().storageBytes, 8);
    await store.clear();
    await assert.rejects(stat(snapshotPath));
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
    }, 1);
    assert.deepEqual(store.snapshot(), {
      sessions: 1,
      events: 1,
      fallbackCaptures: 0,
      storageBytes: 0,
      recentSessions: [{
        id: sessionId,
        startedAt: "2026-08-25T00:00:00.000Z",
        endedAt: undefined,
        snapshotCount: 1,
        eventCount: 1,
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
      eventType: "browser_tab_changed",
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
      eventType: "browser_tab_changed",
      application: "Safari",
      url: "https://example.com/ok\u0000\npayload",
      windowTitle: "Dirty URL"
    });
    assert.equal(dirty.url, "https://example.com/ok payload");
    const longUrl = `https://example.com/${"x".repeat(4_000)}`;
    const long = store.recordEvent({
      sessionId,
      occurredAt: "2026-08-26T00:00:03.000Z",
      eventType: "browser_tab_changed",
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
