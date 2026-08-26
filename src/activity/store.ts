/**
 * Activity 的全局 SQLite/FTS5 存储。
 *
 * 事件本身不依赖截图即可落盘；只有视觉 fallback 才会写 JPEG。所有进入数据库的文本
 * 都先经过规则脱敏，原始截图和 SQLite 继续保存在全局 0700 目录，不进入项目 Session、
 * LocalMemory 或 TELOS。
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ActivityEventType, ActivitySource, ActivityStorageTier } from "./types.js";
import { activitySummary, redactActivityText } from "./redaction.js";

export interface ActivityEventInput {
  sessionId: string;
  occurredAt: string;
  eventType: ActivityEventType | string;
  source?: ActivitySource;
  application?: string;
  bundleId?: string;
  windowTitle?: string;
  axRole?: string;
  axTitle?: string;
  rawText?: string;
  rawOcrText?: string;
  /** 结构化 URL 列（浏览器标签采集 P4）：只清理控制字符并限长，不做内容脱敏。 */
  url?: string;
  mouseEventType?: string;
  mouseButton?: number;
  fallbackReason?: string;
  inputEventCount?: number;
}

export interface ActivityFallbackCaptureInput extends ActivityEventInput {
  jpeg: Uint8Array;
}

export interface ActivitySessionRecord {
  id: string;
  startedAt: string;
  endedAt?: string;
  snapshotCount: number;
  eventCount: number;
  applications: string[];
}

export interface ActivityStoreSnapshot {
  sessions: number;
  events: number;
  fallbackCaptures: number;
  storageBytes: number;
  recentSessions: ActivitySessionRecord[];
}

export interface ActivitySearchResult {
  id: number;
  sessionId: string;
  occurredAt: string;
  source: ActivitySource;
  eventType: string;
  application?: string;
  windowTitle?: string;
  axRole?: string;
  axTitle?: string;
  summary: string;
  url?: string;
  fallbackReason?: string;
  snapshotPath?: string;
}

export interface ActivityStoredEvent extends ActivitySearchResult {
  inputEventCount: number;
}

/** 分析结果里的结构化引用（PR / issue）。字段全部可选，由模型按可见证据填写。 */
export interface ActivityAnalysisReference {
  repo?: string;
  number?: number;
  url?: string;
  title?: string;
}

/** 落库的单个 session 分析结果（activity_session_analysis 一行的内存形态）。 */
export interface ActivitySessionAnalysis {
  sessionId: string;
  analyzedAt: string;
  analyzerModel: string;
  project?: string;
  summary: string;
  topics: string[];
  prs: ActivityAnalysisReference[];
  issues: ActivityAnalysisReference[];
  people: string[];
  versions: string[];
  decisions: string[];
  /** 提到的具体实体（项目、库、服务、文件/页面名等），用于语义检索与实体回溯。 */
  entities: string[];
  /** 值得记住的高光/产出，短句列表；worthMemory 为真时优先写进记忆。 */
  highlights: string[];
  /** 该 session 是否值得写入长期记忆。 */
  worthMemory: boolean;
  /** 该 session 是否值得沉淀为知识（报告/摘要里单独标注，供知识层消费）。 */
  worthKnowledge: boolean;
  /** 该 session 是否是会议/沟通（视频/语音/聊天）。 */
  isMeeting: boolean;
  /** 存储档位，默认 standard。 */
  storageTier: ActivityStorageTier;
  confidence: number;
  sourceEventCount: number;
  inputHash: string;
}

/** 报告渲染所需的分析行：关联上 session 的开始时间用于排序与按日过滤。 */
export interface ActivityAnalysisReportRow extends ActivitySessionAnalysis {
  sessionStartedAt: string;
}

/** 兜底 sweep 找出的「已结束但还没分析」的 session。 */
export interface ActivityPendingAnalysisSession {
  id: string;
  startedAt: string;
  endedAt: string;
  eventCount: number;
}

/**
 * 组装分析输入时只读取这三个字段。快照路径、OCR 原文、输入事件计数都不在这条查询里，
 * 从源头保证敏感列不会进入送给分析模型的文本。
 */
export interface ActivityEventSummary {
  occurredAt: string;
  summary: string;
  application?: string;
}

/** digest / sessions 工具的近期 session 行：session 元数据 + 已落库的分析（可缺）。 */
export interface ActivityRecentSessionRow {
  id: string;
  startedAt: string;
  endedAt?: string;
  eventCount: number;
  analysis?: ActivitySessionAnalysis;
}

/** session 详情：元数据 + 事件摘要 + 分析结果。 */
export interface ActivitySessionDetail {
  id: string;
  startedAt: string;
  endedAt?: string;
  eventCount: number;
  events: ActivityEventSummary[];
  analysis?: ActivitySessionAnalysis;
}

/** semantic 搜索的嵌入源：project+summary+topics+highlights 拼成 passage 文本，不碰事件原文。 */
export interface ActivityAnalysisEmbeddingSource {
  sessionId: string;
  project?: string;
  summary: string;
  topics: string[];
  highlights: string[];
}

/** semantic 命中行：analysis 信息 + session 开始时间 + 当前指纹下的向量。 */
export interface ActivityAnalysisEmbeddingRow extends ActivityAnalysisEmbeddingSource {
  startedAt: string;
  embedding: Float32Array;
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
    try {
      await chmod(databasePath, 0o600);
      // WAL + busy_timeout：采集器持续写事件，分析层（activity_report / 桌面报告）用独立连接
      // 并发读写同一个库；没有 busy_timeout 时写冲突会立刻报 SQLITE_BUSY 而不是短暂等待。
      database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      database.exec(`
        CREATE TABLE IF NOT EXISTS activity_sessions (
          id TEXT PRIMARY KEY,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          event_count INTEGER NOT NULL DEFAULT 0
        );
      `);
      this.migrateLegacyEvents(database);
      database.exec(`
        CREATE TABLE IF NOT EXISTS activity_events (
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
        CREATE INDEX IF NOT EXISTS activity_events_time_idx ON activity_events(occurred_at);
        CREATE INDEX IF NOT EXISTS activity_events_session_idx ON activity_events(session_id);
      `);
      // 浏览器标签 URL 是 P4 增量列：新库已在 CREATE TABLE 里，旧库缺列时这里补上；
      // 与 migrateLegacyEvents / FTS 重建相互独立，只做最小加法。
      if (!tableColumns(database, "activity_events").has("url")) {
        database.exec("ALTER TABLE activity_events ADD COLUMN url TEXT;");
      }
      // 分析层输出表：一个 session 一行的结构化分析结果，与原始事件分表存放。
      database.exec(`
        CREATE TABLE IF NOT EXISTS activity_session_analysis (
          session_id   TEXT PRIMARY KEY REFERENCES activity_sessions(id) ON DELETE CASCADE,
          analyzed_at  TEXT NOT NULL,
          analyzer_model TEXT NOT NULL,
          project      TEXT,
          summary      TEXT NOT NULL,
          topics_json  TEXT NOT NULL DEFAULT '[]',
          prs_json     TEXT NOT NULL DEFAULT '[]',
          issues_json  TEXT NOT NULL DEFAULT '[]',
          people_json  TEXT NOT NULL DEFAULT '[]',
          versions_json TEXT NOT NULL DEFAULT '[]',
          decisions_json TEXT NOT NULL DEFAULT '[]',
          entities_json TEXT NOT NULL DEFAULT '[]',
          highlights_json TEXT NOT NULL DEFAULT '[]',
          worth_memory INTEGER NOT NULL DEFAULT 0,
          worth_knowledge INTEGER NOT NULL DEFAULT 0,
          is_meeting INTEGER NOT NULL DEFAULT 0,
          storage_tier TEXT NOT NULL DEFAULT 'standard',
          confidence   REAL NOT NULL DEFAULT 0,
          source_event_count INTEGER NOT NULL DEFAULT 0,
          input_hash   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS activity_analysis_time_idx ON activity_session_analysis(analyzed_at);
        CREATE INDEX IF NOT EXISTS activity_analysis_project_idx ON activity_session_analysis(project);
      `);
      // P1 已建表但缺 P2 字段的旧库：逐列 ALTER 补齐（幂等），不重建表。
      this.ensureAnalysisColumns(database);
      // 语义检索的派生向量表：analysis 行（project+summary+topics+highlights）的本地嵌入。
      // 向量只属于分析行，session 删除时随 activity_session_analysis 级联清理。
      database.exec(`
        CREATE TABLE IF NOT EXISTS activity_analysis_embeddings (
          session_id TEXT PRIMARY KEY REFERENCES activity_session_analysis(session_id) ON DELETE CASCADE,
          model_fingerprint TEXT NOT NULL,
          embedding BLOB NOT NULL,
          embedded_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS activity_analysis_embeddings_fp_idx ON activity_analysis_embeddings(model_fingerprint);
      `);
      this.ensureSearchIndex(database);
      this.database = database;
      this.root = root;
    } catch (error) {
      database.close();
      throw error;
    }
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
    this.requireDatabase().prepare("UPDATE activity_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL").run(endedAt, sessionId);
  }

  recordEvent(input: ActivityEventInput): ActivityStoredEvent {
    return this.insertEvent(input, undefined);
  }

  async recordFallbackCapture(input: ActivityFallbackCaptureInput, maxStorageMb: number): Promise<ActivityStoredEvent> {
    const root = this.requireRoot();
    const filename = `${input.occurredAt.replace(/[^0-9]/gu, "").slice(0, 17)}-${randomUUID()}.jpg`;
    const relativeSnapshotPath = path.join("snapshots", filename);
    const snapshotPath = path.join(root, relativeSnapshotPath);
    const temporaryPath = `${snapshotPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, input.jpeg, { mode: 0o600 });
    try {
      await rename(temporaryPath, snapshotPath);
      await chmod(snapshotPath, 0o600);
      const stored = this.insertEvent({
        ...input,
        source: "screenshot_fallback",
        eventType: input.eventType || "fallback_capture"
      }, { relativeSnapshotPath, bytes: input.jpeg.byteLength });
      await this.enforceStorageLimit(maxStorageMb);
      const current = this.requireDatabase().prepare("SELECT snapshot_path FROM activity_events WHERE id = ?").get(stored.id) as { snapshot_path: string | null } | undefined;
      return { ...stored, snapshotPath: current?.snapshot_path ?? undefined };
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      await unlink(snapshotPath).catch(() => undefined);
      throw error;
    }
  }

  snapshot(limit = 10): ActivityStoreSnapshot {
    const database = this.requireDatabase();
    const counts = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM activity_sessions) AS sessions,
        (SELECT COUNT(*) FROM activity_events) AS events,
        (SELECT COUNT(*) FROM activity_events WHERE source = 'screenshot_fallback' AND snapshot_path IS NOT NULL) AS fallback_captures,
        COALESCE((SELECT SUM(snapshot_bytes) FROM activity_events), 0) AS storage_bytes
    `).get() as { sessions: number; events: number; fallback_captures: number; storage_bytes: number };
    const rows = database.prepare(`
      SELECT s.id, s.started_at, s.ended_at, s.event_count,
        COUNT(CASE WHEN e.source = 'screenshot_fallback' THEN 1 END) AS snapshot_count,
        GROUP_CONCAT(DISTINCT e.application) AS applications
      FROM activity_sessions s
      LEFT JOIN activity_events e ON e.session_id = s.id
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return {
      sessions: Number(counts.sessions),
      events: Number(counts.events),
      fallbackCaptures: Number(counts.fallback_captures),
      storageBytes: Number(counts.storage_bytes),
      recentSessions: rows.map((row) => ({
        id: String(row.id),
        startedAt: String(row.started_at),
        endedAt: row.ended_at === null ? undefined : String(row.ended_at),
        snapshotCount: Number(row.snapshot_count),
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
      SELECT e.id, e.session_id, e.occurred_at, e.source, e.event_type,
        e.application, e.window_title, e.ax_role, e.ax_title, e.summary,
        e.url, e.fallback_reason, e.snapshot_path
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
      source: row.source === "screenshot_fallback" ? "screenshot_fallback" : "event",
      eventType: String(row.event_type),
      application: nullableString(row.application),
      windowTitle: nullableString(row.window_title),
      axRole: nullableString(row.ax_role),
      axTitle: nullableString(row.ax_title),
      summary: String(row.summary),
      url: nullableString(row.url),
      fallbackReason: nullableString(row.fallback_reason),
      snapshotPath: nullableString(row.snapshot_path)
    }));
  }

  /** 兜底 sweep：列出已结束但还没有分析行的 session，按结束时间升序。 */
  listSessionsPendingAnalysis(limit = 50): ActivityPendingAnalysisSession[] {
    const rows = this.requireDatabase().prepare(`
      SELECT s.id, s.started_at, s.ended_at, s.event_count
      FROM activity_sessions s
      LEFT JOIN activity_session_analysis a ON a.session_id = s.id
      WHERE s.ended_at IS NOT NULL AND a.session_id IS NULL
      ORDER BY s.ended_at ASC, s.id ASC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      startedAt: String(row.started_at),
      endedAt: String(row.ended_at),
      eventCount: Number(row.event_count)
    }));
  }

  /** 分析前的 session 元数据；未找到或尚未结束（进行中）时返回 undefined。 */
  getEndedSession(sessionId: string): ActivityPendingAnalysisSession | undefined {
    const row = this.requireDatabase().prepare(`
      SELECT id, started_at, ended_at, event_count
      FROM activity_sessions
      WHERE id = ? AND ended_at IS NOT NULL
    `).get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      startedAt: String(row.started_at),
      endedAt: String(row.ended_at),
      eventCount: Number(row.event_count)
    };
  }

  /** 只读 occurred_at/summary/application 三列；快照路径与 OCR 原文不进入分析输入。 */
  listSessionEventSummaries(sessionId: string): ActivityEventSummary[] {
    const rows = this.requireDatabase().prepare(`
      SELECT occurred_at, summary, application
      FROM activity_events
      WHERE session_id = ?
      ORDER BY occurred_at ASC, id ASC
    `).all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      occurredAt: String(row.occurred_at),
      summary: String(row.summary),
      application: nullableString(row.application)
    }));
  }

  getAnalysis(sessionId: string): ActivitySessionAnalysis | undefined {
    const row = this.requireDatabase().prepare(
      "SELECT * FROM activity_session_analysis WHERE session_id = ?"
    ).get(sessionId) as Record<string, unknown> | undefined;
    return row ? parseAnalysisRow(row) : undefined;
  }

  /** 幂等写入：同一 session 重复分析时按主键覆盖。 */
  recordAnalysis(analysis: ActivitySessionAnalysis): void {
    this.requireDatabase().prepare(`
      INSERT INTO activity_session_analysis (
        session_id, analyzed_at, analyzer_model, project, summary,
        topics_json, prs_json, issues_json, people_json, versions_json, decisions_json,
        entities_json, highlights_json, worth_memory, worth_knowledge, is_meeting, storage_tier,
        confidence, source_event_count, input_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        analyzed_at = excluded.analyzed_at,
        analyzer_model = excluded.analyzer_model,
        project = excluded.project,
        summary = excluded.summary,
        topics_json = excluded.topics_json,
        prs_json = excluded.prs_json,
        issues_json = excluded.issues_json,
        people_json = excluded.people_json,
        versions_json = excluded.versions_json,
        decisions_json = excluded.decisions_json,
        entities_json = excluded.entities_json,
        highlights_json = excluded.highlights_json,
        worth_memory = excluded.worth_memory,
        worth_knowledge = excluded.worth_knowledge,
        is_meeting = excluded.is_meeting,
        storage_tier = excluded.storage_tier,
        confidence = excluded.confidence,
        source_event_count = excluded.source_event_count,
        input_hash = excluded.input_hash
    `).run(
      analysis.sessionId,
      analysis.analyzedAt,
      analysis.analyzerModel,
      analysis.project ?? null,
      analysis.summary,
      JSON.stringify(analysis.topics),
      JSON.stringify(analysis.prs),
      JSON.stringify(analysis.issues),
      JSON.stringify(analysis.people),
      JSON.stringify(analysis.versions),
      JSON.stringify(analysis.decisions),
      JSON.stringify(analysis.entities),
      JSON.stringify(analysis.highlights),
      analysis.worthMemory ? 1 : 0,
      analysis.worthKnowledge ? 1 : 0,
      analysis.isMeeting ? 1 : 0,
      analysis.storageTier,
      analysis.confidence,
      analysis.sourceEventCount,
      analysis.inputHash
    );
  }

  /** 指定时间范围（按 session 开始时间）内的分析行，按时间升序，供报告渲染。 */
  listAnalysisForDateRange(startIso: string, endIso: string): ActivityAnalysisReportRow[] {
    const rows = this.requireDatabase().prepare(`
      SELECT a.*, s.started_at AS session_started_at
      FROM activity_session_analysis a
      JOIN activity_sessions s ON s.id = a.session_id
      WHERE s.started_at >= ? AND s.started_at < ?
      ORDER BY s.started_at ASC, a.session_id ASC
    `).all(startIso, endIso) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...parseAnalysisRow(row),
      sessionStartedAt: String(row.session_started_at)
    }));
  }

  /**
   * digest / sessions 工具的近期 session 行：开始/结束时间落在窗口内（涵盖进行中且
   * 较早开始的 session），LEFT JOIN 已落库的分析。
   */
  listRecentSessionsWithAnalysis(sinceIso: string, limit = 20): ActivityRecentSessionRow[] {
    const rows = this.requireDatabase().prepare(`
      SELECT s.id, s.started_at, s.ended_at, s.event_count, a.*
      FROM activity_sessions s
      LEFT JOIN activity_session_analysis a ON a.session_id = s.id
      WHERE s.started_at >= ? OR (s.ended_at IS NOT NULL AND s.ended_at >= ?)
      ORDER BY s.started_at DESC, s.id ASC
      LIMIT ?
    `).all(sinceIso, sinceIso, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      startedAt: String(row.started_at),
      endedAt: row.ended_at === null ? undefined : String(row.ended_at),
      eventCount: Number(row.event_count),
      analysis: row.analyzed_at === null ? undefined : parseAnalysisRow(row)
    }));
  }

  /** session 元数据；不存在返回 undefined（不要求已结束，session_show 也要能看进行中的）。 */
  getSessionRecord(sessionId: string): { id: string; startedAt: string; endedAt?: string; eventCount: number } | undefined {
    const row = this.requireDatabase().prepare(`
      SELECT id, started_at, ended_at, event_count
      FROM activity_sessions
      WHERE id = ?
    `).get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      startedAt: String(row.started_at),
      endedAt: row.ended_at === null ? undefined : String(row.ended_at),
      eventCount: Number(row.event_count)
    };
  }

  /** worthMemory=1 的分析行（按分析时间升序），供记忆同步消费。 */
  listWorthMemoryAnalyses(limit = 50): ActivitySessionAnalysis[] {
    const rows = this.requireDatabase().prepare(`
      SELECT a.*
      FROM activity_session_analysis a
      WHERE a.worth_memory = 1
      ORDER BY a.analyzed_at ASC, a.session_id ASC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map(parseAnalysisRow);
  }

  /** 项目名归一化候选：最近 sinceIso 以来出现次数最多的项目名。 */
  listRecentProjects(sinceIso: string, limit = 20): string[] {
    const rows = this.requireDatabase().prepare(`
      SELECT project, COUNT(*) AS n
      FROM activity_session_analysis
      WHERE project IS NOT NULL AND project <> '' AND analyzed_at >= ?
      GROUP BY project
      ORDER BY n DESC, project ASC
      LIMIT ?
    `).all(sinceIso, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => String(row.project));
  }

  /**
   * 缺当前指纹向量的分析行（未嵌入过，或换过嵌入模型指纹不匹配）。按分析时间升序，
   * 语义检索工具每次调用补嵌入一部分；source_event_count 过滤掉心跳/零星占位。
   */
  listAnalysisEmbeddingSources(fingerprint: string, limit = 200): ActivityAnalysisEmbeddingSource[] {
    const rows = this.requireDatabase().prepare(`
      SELECT a.session_id, a.project, a.summary, a.topics_json, a.highlights_json
      FROM activity_session_analysis a
      LEFT JOIN activity_analysis_embeddings e
        ON e.session_id = a.session_id AND e.model_fingerprint = ?
      WHERE e.session_id IS NULL AND a.source_event_count >= 3
      ORDER BY a.analyzed_at ASC, a.session_id ASC
      LIMIT ?
    `).all(fingerprint, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      project: nullableString(row.project),
      summary: String(row.summary),
      topics: parseJsonArray<string>(row.topics_json),
      highlights: parseJsonArray<string>(row.highlights_json)
    }));
  }

  /** 写/覆盖一个分析行在当前指纹下的向量（语义检索的本地派生数据）。 */
  upsertAnalysisEmbedding(sessionId: string, modelFingerprint: string, embedding: Float32Array, embeddedAt: string): void {
    this.requireDatabase().prepare(`
      INSERT INTO activity_analysis_embeddings (session_id, model_fingerprint, embedding, embedded_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        model_fingerprint = excluded.model_fingerprint,
        embedding = excluded.embedding,
        embedded_at = excluded.embedded_at
    `).run(sessionId, modelFingerprint, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength), embeddedAt);
  }

  /** 当前指纹下已嵌入的分析行 + session 开始时间，供 cosine 排序。 */
  listAnalysisEmbeddingRows(fingerprint: string, limit = 500): ActivityAnalysisEmbeddingRow[] {
    const rows = this.requireDatabase().prepare(`
      SELECT a.session_id, s.started_at AS session_started_at, a.project, a.summary,
        a.topics_json, a.highlights_json, e.embedding
      FROM activity_analysis_embeddings e
      JOIN activity_session_analysis a ON a.session_id = e.session_id
      JOIN activity_sessions s ON s.id = a.session_id
      WHERE e.model_fingerprint = ?
      ORDER BY a.analyzed_at DESC, a.session_id ASC
      LIMIT ?
    `).all(fingerprint, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const blob = row.embedding as Uint8Array | undefined;
      return {
        sessionId: String(row.session_id),
        startedAt: String(row.session_started_at),
        project: nullableString(row.project),
        summary: String(row.summary),
        topics: parseJsonArray<string>(row.topics_json),
        highlights: parseJsonArray<string>(row.highlights_json),
        embedding: blob === undefined ? new Float32Array(0) : new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4))
      };
    });
  }

  async clear(): Promise<void> {
    const database = this.requireDatabase();
    const root = this.requireRoot();
    const paths = database.prepare("SELECT snapshot_path FROM activity_events WHERE snapshot_path IS NOT NULL").all() as Array<{ snapshot_path: string }>;
    database.exec("DELETE FROM activity_fts; DELETE FROM activity_analysis_embeddings; DELETE FROM activity_session_analysis; DELETE FROM activity_events; DELETE FROM activity_sessions;");
    for (const row of paths) await unlink(path.join(root, row.snapshot_path)).catch(() => undefined);
    const snapshots = path.join(root, "snapshots");
    await rm(snapshots, { recursive: true, force: true });
    await mkdir(snapshots, { recursive: true, mode: 0o700 });
    await chmod(snapshots, 0o700);
  }

  private insertEvent(input: ActivityEventInput, snapshot: { relativeSnapshotPath: string; bytes: number } | undefined): ActivityStoredEvent {
    const database = this.requireDatabase();
    const application = redactActivityText(input.application);
    const windowTitle = redactActivityText(input.windowTitle);
    const axRole = redactActivityText(input.axRole);
    const axTitle = redactActivityText(input.axTitle);
    // URL 是结构化列，明确不进 redactActivityText：规则脱敏会把 URL 整体换成
    // [redacted url]，那会毁掉「刚才看了什么」这类查询；这里只清理控制字符并限长。
    const url = normalizeStructuredUrl(input.url);
    const redactedText = redactActivityText(input.rawText);
    const ocrText = redactActivityText(input.rawOcrText);
    const summaryText = [redactedText, ocrText].filter((value): value is string => value !== undefined).join("；") || undefined;
    const eventType = normalizeShortText(input.eventType) ?? "activity";
    const source = input.source === "screenshot_fallback" ? "screenshot_fallback" : "event";
    const mouseEventType = normalizeShortText(input.mouseEventType);
    const fallbackReason = normalizeShortText(input.fallbackReason);
    const mouseButton = input.mouseButton !== undefined && Number.isInteger(input.mouseButton) ? input.mouseButton : null;
    const summary = activitySummary(application, summaryText, {
      eventType,
      windowTitle,
      axRole,
      axTitle,
      mouseEventType,
      fallbackReason
    });
    const inputEventCount = Math.max(0, Math.trunc(input.inputEventCount ?? 0));
    const result = database.prepare(`
      INSERT INTO activity_events (
        session_id, occurred_at, source, event_type, application, bundle_id,
        window_title, ax_role, ax_title, url, redacted_text, mouse_event_type,
        mouse_button, summary, ocr_text, input_event_count, fallback_reason,
        snapshot_path, snapshot_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sessionId,
      input.occurredAt,
      source,
      eventType,
      application ?? null,
      normalizeShortText(input.bundleId) ?? null,
      windowTitle ?? null,
      axRole ?? null,
      axTitle ?? null,
      url ?? null,
      redactedText ?? null,
      mouseEventType ?? null,
      mouseButton,
      summary,
      ocrText ?? null,
      inputEventCount,
      fallbackReason ?? null,
      snapshot?.relativeSnapshotPath ?? null,
      snapshot?.bytes ?? 0
    );
    const eventId = Number(result.lastInsertRowid);
    // url 进 FTS：浏览器标签 URL 是结构化列（不做内容脱敏），纳入全文索引后可按
    // 站点/路径关键字检索；行内容只在用户主动 search() 时可见。
    database.prepare("INSERT INTO activity_fts (event_id, summary, application, window_title, event_type, ax_role, ax_title, redacted_text, ocr_text, url, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      eventId,
      summary,
      application ?? "",
      windowTitle ?? "",
      eventType,
      axRole ?? "",
      axTitle ?? "",
      redactedText ?? "",
      ocrText ?? "",
      url ?? "",
      input.occurredAt
    );
    database.prepare("UPDATE activity_sessions SET event_count = event_count + 1 WHERE id = ?").run(input.sessionId);
    return {
      id: eventId,
      sessionId: input.sessionId,
      occurredAt: input.occurredAt,
      source,
      eventType,
      application,
      windowTitle,
      axRole,
      axTitle,
      url,
      summary,
      fallbackReason,
      snapshotPath: snapshot?.relativeSnapshotPath,
      inputEventCount
    };
  }

  private async enforceStorageLimit(maxStorageMb: number): Promise<void> {
    const database = this.requireDatabase();
    const maxBytes = Math.max(1, maxStorageMb) * 1024 * 1024;
    while (true) {
      const row = database.prepare("SELECT COALESCE(SUM(snapshot_bytes), 0) AS bytes FROM activity_events").get() as { bytes: number };
      if (Number(row.bytes) <= maxBytes) return;
      const oldest = database.prepare(`
        SELECT id, snapshot_path FROM activity_events
        WHERE snapshot_path IS NOT NULL AND snapshot_bytes > 0
        ORDER BY occurred_at ASC, id ASC LIMIT 1
      `).get() as { id: number; snapshot_path: string } | undefined;
      if (!oldest) return;
      // 容量限制只淘汰 JPEG；事件语义和会话计数必须保留，避免“有图才算活动”。
      database.prepare("UPDATE activity_events SET snapshot_path = NULL, snapshot_bytes = 0 WHERE id = ?").run(oldest.id);
      await unlink(path.join(this.requireRoot(), oldest.snapshot_path)).catch(() => undefined);
    }
  }

  private migrateLegacyEvents(database: DatabaseSync): void {
    const columns = tableColumns(database, "activity_events");
    if (!columns.size || columns.has("source")) return;
    database.exec("DROP INDEX IF EXISTS activity_events_time_idx; DROP INDEX IF EXISTS activity_events_session_idx;");
    database.exec("BEGIN IMMEDIATE;");
    try {
      database.exec("ALTER TABLE activity_events RENAME TO activity_events_legacy;");
      database.exec(`
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
        INSERT INTO activity_events (
          id, session_id, occurred_at, source, event_type, application, bundle_id,
          summary, ocr_text, input_event_count, snapshot_path, snapshot_bytes
        )
        SELECT id, session_id, occurred_at, 'screenshot_fallback', 'fallback_capture',
          application, bundle_id, summary, ocr_text, input_event_count,
          snapshot_path, snapshot_bytes
        FROM activity_events_legacy;
        DROP TABLE activity_events_legacy;
      `);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }

  /**
   * P2 分析字段的向后兼容迁移：P1 建的表没有 entities/highlights/worthMemory 等列，
   * 逐列 ALTER 补齐（幂等），只在确实缺某列时执行，不重建表、不动其它列。
   */
  private ensureAnalysisColumns(database: DatabaseSync): void {
    const columns = tableColumns(database, "activity_session_analysis");
    if (
      columns.has("entities_json")
      && columns.has("highlights_json")
      && columns.has("worth_memory")
      && columns.has("worth_knowledge")
      && columns.has("is_meeting")
      && columns.has("storage_tier")
    ) return;
    const additions: ReadonlyArray<readonly [string, string]> = [
      ["entities_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["highlights_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["worth_memory", "INTEGER NOT NULL DEFAULT 0"],
      ["worth_knowledge", "INTEGER NOT NULL DEFAULT 0"],
      ["is_meeting", "INTEGER NOT NULL DEFAULT 0"],
      ["storage_tier", "TEXT NOT NULL DEFAULT 'standard'"]
    ];
    for (const [column, definition] of additions) {
      if (columns.has(column)) continue;
      database.exec(`ALTER TABLE activity_session_analysis ADD COLUMN ${column} ${definition};`);
    }
  }

  private ensureSearchIndex(database: DatabaseSync): void {
    const columns = tableColumns(database, "activity_fts");
    const requiredColumns = ["event_id", "summary", "application", "window_title", "event_type", "ax_role", "ax_title", "redacted_text", "ocr_text", "url", "occurred_at"];
    if (requiredColumns.every((column) => columns.has(column))) return;
    this.rebuildSearchIndex(database);
  }

  private rebuildSearchIndex(database: DatabaseSync): void {
    database.exec("DROP TABLE IF EXISTS activity_fts;");
    database.exec(`
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
        url,
        occurred_at
      );
      INSERT INTO activity_fts (
        event_id, summary, application, window_title, event_type,
        ax_role, ax_title, redacted_text, ocr_text, url, occurred_at
      )
      SELECT id, summary, COALESCE(application, ''), COALESCE(window_title, ''),
        event_type, COALESCE(ax_role, ''), COALESCE(ax_title, ''),
        COALESCE(redacted_text, ''), COALESCE(ocr_text, ''), COALESCE(url, ''), occurred_at
      FROM activity_events;
    `);
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

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function normalizeShortText(value: string | undefined, fallback?: string): string | undefined {
  const normalized = value?.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
  if (normalized) return normalized.slice(0, 256);
  return fallback;
}

/** URL 结构化列：只清理控制字符并限长，不做内容脱敏（参见 insertEvent 的注释）。 */
function normalizeStructuredUrl(value: string | undefined): string | undefined {
  const normalized = value?.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
  if (normalized) return normalized.slice(0, 2_048);
  return undefined;
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function parseAnalysisRow(row: Record<string, unknown>): ActivitySessionAnalysis {
  return {
    sessionId: String(row.session_id),
    analyzedAt: String(row.analyzed_at),
    analyzerModel: String(row.analyzer_model),
    project: nullableString(row.project),
    summary: String(row.summary),
    topics: parseJsonArray<string>(row.topics_json),
    prs: parseJsonArray<ActivityAnalysisReference>(row.prs_json),
    issues: parseJsonArray<ActivityAnalysisReference>(row.issues_json),
    people: parseJsonArray<string>(row.people_json),
    versions: parseJsonArray<string>(row.versions_json),
    decisions: parseJsonArray<string>(row.decisions_json),
    entities: parseJsonArray<string>(row.entities_json),
    highlights: parseJsonArray<string>(row.highlights_json),
    worthMemory: Number(row.worth_memory) === 1,
    worthKnowledge: Number(row.worth_knowledge) === 1,
    isMeeting: Number(row.is_meeting) === 1,
    storageTier: parseStorageTier(row.storage_tier),
    confidence: Number(row.confidence),
    sourceEventCount: Number(row.source_event_count),
    inputHash: String(row.input_hash)
  };
}

function parseStorageTier(value: unknown): ActivityStorageTier {
  return value === "ephemeral" || value === "important" ? value : "standard";
}

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}
