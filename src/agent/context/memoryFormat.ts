/**
 * 记忆条目的序列化、脱敏和确定性检索。
 *
 * 每个 v2 Markdown 文件只承载一条 entry；YAML frontmatter 是机器可读事实，正文保留给用户
 * 审计。检索只使用本地关键词、CJK bigram、路径、时间和 importance，不建立向量索引。
 */
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { redactSecrets } from "../../utils/secrets.js";
import type {
  MemoryEntry,
  MemoryEntryInput,
  MemoryLineage,
  MemoryMatch
} from "./memoryTypes.js";

export const memoryFormatVersion = 2;
export const maxMemoryEntryChars = 32_000;
export const maxMemorySummaryChars = 2_000;
export const maxMemoryCandidateChars = 2_000;

const lineageSchema = z.object({
  source: z.enum(["explicit", "completed_task", "candidate", "migration", "consolidation"]),
  externalContext: z.boolean(),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  runId: z.string().optional(),
  candidateId: z.string().optional(),
  sourceEntryIds: z.array(z.string()).optional(),
  legacyPath: z.string().optional(),
  userEvidence: z.string().optional()
});

const frontmatterSchema = z.object({
  version: z.literal(memoryFormatVersion),
  id: z.string().min(8).max(128),
  scope: z.enum(["global", "project"]),
  kind: z.enum(["preference", "working_style", "fact", "decision", "workflow", "gotcha"]),
  topic: z.string(),
  title: z.string(),
  summary: z.string(),
  decisions: z.array(z.string()).default([]),
  paths: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  importance: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().nonnegative(),
  lineage: z.array(lineageSchema).min(1)
});

export interface StoredEntryFields {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface RankedMemoryEntry {
  entry: MemoryEntry;
  score: number;
  excerpt: string;
}

export function sanitizeMemoryEntryInput(input: MemoryEntryInput): MemoryEntryInput {
  if (input.scope !== "global" && input.scope !== "project") throw new Error(`Invalid memory scope: ${String(input.scope)}`);
  if (!isMemoryKind(input.kind)) throw new Error(`Invalid memory kind: ${String(input.kind)}`);
  const lineage = (Array.isArray(input.lineage) ? input.lineage : [input.lineage]).map(sanitizeMemoryLineage);
  if (!lineage.length) throw new Error("Memory entry lineage must not be empty.");
  const sanitized: MemoryEntryInput = {
    scope: input.scope,
    kind: input.kind,
    topic: normalizeMemoryTopic(redactSecrets(input.topic)),
    title: redactSecrets(input.title).replace(/\s+/g, " ").trim().slice(0, 120),
    summary: redactSecrets(input.summary).trim().slice(0, maxMemorySummaryChars),
    decisions: sanitizeStringArray(input.decisions, 8, 500),
    paths: sanitizeStringArray(input.paths, 16, 500),
    keywords: sanitizeStringArray(input.keywords, 12, 120).map((value) => value.toLowerCase()),
    importance: normalizeImportance(input.importance),
    lineage
  };
  if (!sanitized.title) sanitized.title = "Project note";
  return sanitized;
}

/** 写盘前再次脱敏，候选经过模型也不能绕过第一道过滤。 */
export function createStoredMemoryEntry(input: MemoryEntryInput, fields: StoredEntryFields): MemoryEntry {
  const safe = sanitizeMemoryEntryInput(sanitizeMemoryEntryInput(input));
  return {
    id: sanitizeIdentifier(fields.id),
    scope: safe.scope,
    kind: safe.kind,
    topic: safe.topic,
    title: safe.title,
    summary: safe.summary,
    decisions: safe.decisions ?? [],
    paths: safe.paths ?? [],
    keywords: safe.keywords ?? [],
    importance: safe.importance ?? 3,
    createdAt: assertIsoTime(fields.createdAt),
    updatedAt: assertIsoTime(fields.updatedAt),
    revision: Math.max(0, Math.trunc(fields.revision)),
    lineage: Array.isArray(safe.lineage) ? safe.lineage : [safe.lineage]
  };
}

export function renderMemoryEntry(entry: MemoryEntry): string {
  const safe = createStoredMemoryEntry(entry, {
    id: entry.id,
    revision: entry.revision,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  });
  const frontmatter = stringifyYaml({
    version: memoryFormatVersion,
    id: safe.id,
    scope: safe.scope,
    kind: safe.kind,
    topic: safe.topic,
    title: safe.title,
    summary: safe.summary,
    decisions: safe.decisions,
    paths: safe.paths,
    keywords: safe.keywords,
    importance: safe.importance,
    createdAt: safe.createdAt,
    updatedAt: safe.updatedAt,
    revision: safe.revision,
    lineage: safe.lineage
  }, { lineWidth: 0 }).trimEnd();
  return [
    "---",
    frontmatter,
    "---",
    "",
    `# ${safe.title}`,
    "",
    safe.summary,
    ...(safe.decisions.length ? ["", "## Decisions", "", ...safe.decisions.map((decision) => `- ${decision}`)] : []),
    ...(safe.paths.length ? ["", "## Paths", "", ...safe.paths.map((entryPath) => `- \`${entryPath.replaceAll("`", "")}\``)] : []),
    ""
  ].join("\n");
}

export function parseMemoryEntryFile(content: string): MemoryEntry | undefined {
  if (!content.startsWith("---\n")) return undefined;
  const closing = content.indexOf("\n---", 4);
  if (closing < 0) return undefined;
  let raw: unknown;
  try {
    raw = parseYaml(content.slice(4, closing));
  } catch {
    return undefined;
  }
  const parsed = frontmatterSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  try {
    return createStoredMemoryEntry({
      scope: value.scope,
      kind: value.kind,
      topic: value.topic,
      title: value.title,
      summary: value.summary,
      decisions: value.decisions,
      paths: value.paths,
      keywords: value.keywords,
      importance: value.importance,
      lineage: value.lineage
    }, {
      id: value.id,
      revision: value.revision,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt
    });
  } catch {
    return undefined;
  }
}

export function assertAllowedScopedEntry(entry: MemoryEntryInput, workspaceRoot: string): void {
  if (entry.scope !== "global") return;
  if (entry.kind !== "preference" && entry.kind !== "working_style") {
    throw new Error("Global memory only accepts preference and working_style entries.");
  }
  if ((entry.paths?.length ?? 0) > 0 || (entry.decisions?.length ?? 0) > 0 || containsProjectPath(entry, workspaceRoot)) {
    throw new Error("Project paths and decisions must be stored in project memory.");
  }
  const lineages = Array.isArray(entry.lineage) ? entry.lineage : [entry.lineage];
  const evidenced = lineages.some((lineage) => (
    (lineage.source === "explicit" || lineage.source === "completed_task" || lineage.source === "candidate")
    && Boolean(lineage.userEvidence?.trim())
  ));
  if (!evidenced) throw new Error("Global memory requires explicit, auditable user evidence.");
}

export function rankMemoryEntries(entries: MemoryEntry[], query: string, queryPaths: string[], now: Date): RankedMemoryEntry[] {
  const queryTerms = tokenizeMemoryText(query);
  const pathTerms = queryPaths.map(normalizeSearchPath).filter(Boolean);
  return entries.map((entry) => {
    const title = entry.title.toLowerCase();
    const summary = entry.summary.toLowerCase();
    const keywords = entry.keywords.map((keyword) => keyword.toLowerCase());
    const searchable = `${title}\n${summary}\n${entry.decisions.join("\n").toLowerCase()}\n${keywords.join(" ")}`;
    let score = entry.importance * 4;
    for (const term of queryTerms) {
      if (keywords.some((keyword) => keyword === term)) score += 18;
      else if (keywords.some((keyword) => keyword.includes(term) || term.includes(keyword))) score += 9;
      if (title.includes(term)) score += 12;
      if (summary.includes(term)) score += 6;
      if (searchable.includes(term)) score += 3;
    }
    for (const requested of pathTerms) {
      for (const entryPath of entry.paths.map(normalizeSearchPath)) {
        if (entryPath === requested) score += 30;
        else if (entryPath.endsWith(requested) || requested.endsWith(entryPath)) score += 18;
        else if (path.basename(entryPath) === path.basename(requested)) score += 12;
      }
    }
    const ageMs = Math.max(0, now.getTime() - Date.parse(entry.updatedAt));
    // 90 天线性衰减只做轻量 tie-break；durable memory 不因年龄被删除或完全失去召回机会。
    score += Math.max(0, 8 - ageMs / (90 * 24 * 60 * 60 * 1_000) * 8);
    return { entry, score, excerpt: createMemoryExcerpt(entry, queryTerms) };
  }).filter(({ score, entry }) => queryTerms.length === 0 && pathTerms.length === 0 || score > entry.importance * 4 + 0.01)
    .sort((left, right) => (
      right.score - left.score
      || right.entry.importance - left.entry.importance
      || right.entry.updatedAt.localeCompare(left.entry.updatedAt)
      || left.entry.id.localeCompare(right.entry.id)
    ));
}

export function normalizeMemoryTopic(value: string): string {
  const normalized = [...value.toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, "-").replace(/^-+|-+$/g, "")]
    .slice(0, 64)
    .join("")
    .replace(/-+$/g, "");
  if (!normalized) return "project";
  // macOS 默认大小写不敏感，memory.md 会和权威索引 MEMORY.md 冲突。
  return normalized.toLowerCase() === "memory" ? "memory-topic" : normalized;
}

export function normalizeImportance(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 3;
  return Math.min(5, Math.max(1, Math.round(value)));
}

export function sanitizeMemoryLineage(lineage: MemoryLineage): MemoryLineage {
  if (!isLineageSource(lineage.source)) throw new Error(`Invalid memory lineage source: ${String(lineage.source)}`);
  return {
    source: lineage.source,
    externalContext: lineage.externalContext,
    sessionId: sanitizeOptionalLineageValue(lineage.sessionId, 200),
    turnId: sanitizeOptionalLineageValue(lineage.turnId, 200),
    runId: sanitizeOptionalLineageValue(lineage.runId, 200),
    candidateId: sanitizeOptionalLineageValue(lineage.candidateId, 200),
    sourceEntryIds: lineage.sourceEntryIds === undefined
      ? undefined
      : sanitizeStringArray(lineage.sourceEntryIds, Number.MAX_SAFE_INTEGER, 200),
    legacyPath: sanitizeOptionalLineageValue(lineage.legacyPath, 500),
    userEvidence: sanitizeOptionalLineageValue(lineage.userEvidence, 1_000)
  };
}

export function memoryEntryEquals(left: MemoryEntry, right: MemoryEntryInput): boolean {
  return normalizeForDedup(left.title) === normalizeForDedup(right.title)
    && normalizeForDedup(left.summary) === normalizeForDedup(right.summary);
}

export function tokenizeMemoryText(value: string): string[] {
  const lower = value.toLowerCase();
  const ascii = lower.split(/[^a-z0-9_$./-]+/).filter((term) => term.length >= 2);
  const cjk: string[] = [];
  for (const run of lower.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? []) {
    if (run.length === 1) cjk.push(run);
    for (let index = 0; index + 1 < run.length; index += 1) cjk.push(run.slice(index, index + 2));
  }
  return [...new Set([...ascii, ...cjk])].slice(0, 64);
}

export function memoryMatchFromRanked(ranked: RankedMemoryEntry, relativePath: string): MemoryMatch {
  return {
    entry: ranked.entry,
    topic: ranked.entry.topic,
    path: relativePath,
    excerpt: ranked.excerpt,
    score: ranked.score
  };
}

function createMemoryExcerpt(entry: MemoryEntry, terms: string[]): string {
  const candidates = [entry.summary, ...entry.decisions];
  const matched = candidates.find((value) => terms.some((term) => value.toLowerCase().includes(term)));
  return redactSecrets(matched ?? entry.summary).slice(0, 500);
}

function containsProjectPath(entry: MemoryEntryInput, workspaceRoot: string): boolean {
  const content = [entry.topic, entry.title, entry.summary, ...(entry.keywords ?? [])].join("\n");
  if (content.includes(path.resolve(workspaceRoot))) return true;
  return /(?:^|[\s`'(])(?:\.{0,2}\/|src\/|tests?\/|packages?\/|apps?\/|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|go|java|py|rs|md|json|ya?ml))(?:$|[\s`'),.:])/u.test(content);
}

function sanitizeStringArray(values: string[] | undefined, maxItems: number, maxChars: number): string[] {
  if (!values) return [];
  return [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => redactSecrets(value).trim().slice(0, maxChars))
    .filter(Boolean))].slice(0, maxItems);
}

function sanitizeOptionalLineageValue(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  return redactSecrets(value).trim().slice(0, maxChars) || undefined;
}

function sanitizeIdentifier(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 128);
  if (sanitized.length < 8) throw new Error("Memory entry id must contain at least 8 safe characters.");
  return sanitized;
}

function assertIsoTime(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Invalid memory timestamp: ${value}`);
  return new Date(value).toISOString();
}

function normalizeSearchPath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

function normalizeForDedup(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function isMemoryKind(value: string): value is MemoryEntryInput["kind"] {
  return value === "preference"
    || value === "working_style"
    || value === "fact"
    || value === "decision"
    || value === "workflow"
    || value === "gotcha";
}

function isLineageSource(value: string): value is MemoryLineage["source"] {
  return value === "explicit"
    || value === "completed_task"
    || value === "candidate"
    || value === "migration"
    || value === "consolidation";
}
