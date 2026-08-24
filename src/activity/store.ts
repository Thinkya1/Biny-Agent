/**
 * Activity 的全局 SQLite/FTS5 存储。
 *
 * 该模块只接收已经通过规则脱敏的文本和 sidecar 生成的 JPEG 字节，不把 Activity 写入
 * 项目 session、LocalMemory 或 TELOS。原图目录与数据库目录都固定为 0700。
 */
import { randomUUID } from "node:crypto";
import { mkdir, chmod, writeFile, rename, unlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { activitySummary, redactActivityText } from "./redaction.js";

export interface ActivityCaptureInput {
  sessionId: string;
  occurredAt: string;
  application?: string;
  bundleId?: string;
  rawOcrText?: string;
  jpeg: Uint8Array;
  inputEventCount: number;
}

export interface ActivitySessionRecord {
  id: string;
  startedAt: string;
  endedAt?: string;
  eventCount: number;
  applications: string[];
}

export interface ActivityStoreSnapshot {
  sessions: number;
  captures: number;
  storageBytes: number;
  recentSessions: ActivitySessionRecord[];
}

export interface ActivitySearchResult {
  id: number;
  sessionId: string;
  occurredAt: string;
  application?: string;
  summary: string;
  snapshotPath?: string;
}

export interface ActivityStoredCapture {
  id: number;
  sessionId: string;
  occurredAt: string;
  application?: string;
  summary: string;
  snapshotPath: string;
}

export function resolveActivityDirectory(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

export class ActivityStore {
  private database?: DatabaseSync;
  private root?: string;

  async open(directory: string): Promise<void> {
    await this.close();
    const root = resolveActivityDirectory(directory);
    const snapshots = path.join(root, "snapshots");
    await mkdir(snapshots, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await chmod(snapshots, 0o700);
    const databasePath = path.join(root, "activity.sqlite");
    const database = new DatabaseSync(databasePath);
    await chmod(databasePath, 0o600);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS activity_sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        event_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS activity_events (
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
      CREATE VIRTUAL TABLE IF NOT EXISTS activity_fts USING fts5(
        event_id UNINDEXED,
        summary,
        application,
        occurred_at
      );
      CREATE INDEX IF NOT EXISTS activity_events_time_idx ON activity_events(occurred_at);
      CREATE INDEX IF NOT EXISTS activity_events_session_idx ON activity_events(session_id);
    `);
    this.database = database;
    this.root = root;
  }

  async close(): Promise<void> {
    this.database?.close();
    this.database = undefined;
    this.root = undefined;
  }

  startSession(startedAt: string): string {
    const database = this.requireDatabase();
    const id = randomUUID();
    database.prepare("INSERT INTO activity_sessions (id, started_at) VALUES (?, ?)").run(id, startedAt);
    return id;
  }

  endSession(sessionId: string, endedAt: string): void {
    this.requireDatabase().prepare("UPDATE activity_sessions SET ended_at = ? WHERE id = ?").run(endedAt, sessionId);
  }

  async recordCapture(input: ActivityCaptureInput, maxStorageMb: number): Promise<ActivityStoredCapture> {
    const database = this.requireDatabase();
    const root = this.requireRoot();
    const filename = `${input.occurredAt.replace(/[^0-9]/gu, "").slice(0, 17)}-${randomUUID()}.jpg`;
    const relativeSnapshotPath = path.join("snapshots", filename);
    const snapshotPath = path.join(root, relativeSnapshotPath);
    const temporaryPath = `${snapshotPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, input.jpeg, { mode: 0o600 });
    await rename(temporaryPath, snapshotPath);
    await chmod(snapshotPath, 0o600);

    const safeOcrText = redactActivityText(input.rawOcrText);
    const summary = activitySummary(input.application, safeOcrText);
    const result = database.prepare(`
      INSERT INTO activity_events (
        session_id, occurred_at, application, bundle_id, summary, ocr_text,
        input_event_count, snapshot_path, snapshot_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sessionId,
      input.occurredAt,
      input.application ?? null,
      input.bundleId ?? null,
      summary,
      safeOcrText ?? null,
      input.inputEventCount,
      relativeSnapshotPath,
      input.jpeg.byteLength
    );
    const eventId = Number(result.lastInsertRowid);
    database.prepare("INSERT INTO activity_fts (event_id, summary, application, occurred_at) VALUES (?, ?, ?, ?)").run(
      eventId,
      summary,
      input.application ?? "",
      input.occurredAt
    );
    database.prepare("UPDATE activity_sessions SET event_count = event_count + 1 WHERE id = ?").run(input.sessionId);
    await this.enforceStorageLimit(maxStorageMb);
    return {
      id: eventId,
      sessionId: input.sessionId,
      occurredAt: input.occurredAt,
      application: input.application,
      summary,
      snapshotPath: relativeSnapshotPath
    };
  }

  snapshot(limit = 10): ActivityStoreSnapshot {
    const database = this.requireDatabase();
    const counts = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM activity_sessions) AS sessions,
        (SELECT COUNT(*) FROM activity_events) AS captures,
        COALESCE((SELECT SUM(snapshot_bytes) FROM activity_events), 0) AS storage_bytes
    `).get() as { sessions: number; captures: number; storage_bytes: number };
    const rows = database.prepare(`
      SELECT s.id, s.started_at, s.ended_at, s.event_count,
        GROUP_CONCAT(DISTINCT e.application) AS applications
      FROM activity_sessions s
      LEFT JOIN activity_events e ON e.session_id = s.id
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return {
      sessions: Number(counts.sessions),
      captures: Number(counts.captures),
      storageBytes: Number(counts.storage_bytes),
      recentSessions: rows.map((row) => ({
        id: String(row.id),
        startedAt: String(row.started_at),
        endedAt: row.ended_at === null ? undefined : String(row.ended_at),
        eventCount: Number(row.event_count),
        applications: row.applications === null ? [] : String(row.applications).split(",")
      }))
    };
  }

  search(query: string, limit = 20): ActivitySearchResult[] {
    const normalized = query.trim();
    if (!normalized) return [];
    const match = normalized.split(/\s+/u).map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
    const rows = this.requireDatabase().prepare(`
      SELECT e.id, e.session_id, e.occurred_at, e.application, e.summary, e.snapshot_path
      FROM activity_fts f
      JOIN activity_events e ON e.id = CAST(f.event_id AS INTEGER)
      WHERE activity_fts MATCH ?
      ORDER BY e.occurred_at DESC
      LIMIT ?
    `).all(match, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      sessionId: String(row.session_id),
      occurredAt: String(row.occurred_at),
      application: row.application === null ? undefined : String(row.application),
      summary: String(row.summary),
      snapshotPath: row.snapshot_path === null ? undefined : String(row.snapshot_path)
    }));
  }

  async clear(): Promise<void> {
    const database = this.requireDatabase();
    const root = this.requireRoot();
    const paths = database.prepare("SELECT snapshot_path FROM activity_events").all() as Array<{ snapshot_path: string }>;
    database.exec("DELETE FROM activity_fts; DELETE FROM activity_events; DELETE FROM activity_sessions;");
    for (const row of paths) await unlink(path.join(root, row.snapshot_path)).catch(() => undefined);
    const snapshots = path.join(root, "snapshots");
    await rm(snapshots, { recursive: true, force: true });
    await mkdir(snapshots, { recursive: true, mode: 0o700 });
    await chmod(snapshots, 0o700);
  }

  private async enforceStorageLimit(maxStorageMb: number): Promise<void> {
    const database = this.requireDatabase();
    const maxBytes = Math.max(1, maxStorageMb) * 1024 * 1024;
    while (true) {
      const row = database.prepare("SELECT COALESCE(SUM(snapshot_bytes), 0) AS bytes FROM activity_events").get() as { bytes: number };
      if (Number(row.bytes) <= maxBytes) return;
      const oldest = database.prepare(`
        SELECT id, session_id, snapshot_path FROM activity_events ORDER BY occurred_at ASC, id ASC LIMIT 1
      `).get() as { id: number; session_id: string; snapshot_path: string } | undefined;
      if (!oldest) return;
      database.prepare("DELETE FROM activity_fts WHERE CAST(event_id AS INTEGER) = ?").run(oldest.id);
      database.prepare("DELETE FROM activity_events WHERE id = ?").run(oldest.id);
      database.prepare("UPDATE activity_sessions SET event_count = MAX(0, event_count - 1) WHERE id = ?").run(oldest.session_id);
      await unlink(path.join(this.requireRoot(), oldest.snapshot_path)).catch(() => undefined);
    }
  }

  private requireDatabase(): DatabaseSync {
    if (!this.database) throw new Error("Activity 存储尚未初始化。");
    return this.database;
  }

  private requireRoot(): string {
    if (!this.root) throw new Error("Activity 存储目录尚未初始化。");
    return this.root;
  }
}
