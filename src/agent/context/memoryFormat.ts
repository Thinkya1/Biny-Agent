/**
 * SQLite 记忆的有界校验、规范化和确定性检索。
 *
 * 事实序列化由 memoryStorage 交给 SQLite；向量索引属于可重建派生数据，不进入本模块。
 */
import path from "node:path";
import type {
  MemoryEntry,
  MemoryEntryInput,
  MemoryDurability,
  MemoryLineage,
  MemoryMatch,
  MemoryOrigin
} from "./memoryTypes.js";

export const maxMemorySummaryChars = 2_000;

export interface StoredEntryFields {
  id: string;
  originalId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  durability?: MemoryDurability;
  expiresAt?: string;
  archivedAt?: string;
  archivedReason?: MemoryEntry["archivedReason"];
  mergedInto?: string;
  archivedBy?: string;
}

export interface RankedMemoryEntry {
  entry: MemoryEntry;
  score: number;
  excerpt: string;
}

export function sanitizeMemoryEntryInput(input: MemoryEntryInput): MemoryEntryInput {
  if (input.origin === undefined && input.audience === undefined) {
    throw new Error("Memory entry requires origin or audience.");
  }
  if (input.origin !== undefined) validateMemoryOrigin(input.origin);
  if (input.audience !== undefined && input.audience !== "universal" && input.audience !== "workspace") {
    throw new Error("Invalid memory audience: " + String(input.audience));
  }
  if (!isMemoryKind(input.kind)) throw new Error("Invalid memory kind: " + String(input.kind));
  const lineage = (Array.isArray(input.lineage) ? input.lineage : [input.lineage]).map(sanitizeMemoryLineage);
  if (!lineage.length) throw new Error("Memory entry lineage must not be empty.");
  const sanitized: MemoryEntryInput = {
    origin: input.origin === undefined ? undefined : sanitizeMemoryOrigin(input.origin),
    audience: input.audience,
    kind: input.kind,
    topic: normalizeMemoryTopic(input.topic),
    title: input.title.replace(/\s+/g, " ").trim().slice(0, 120),
    summary: input.summary.trim().slice(0, maxMemorySummaryChars),
    decisions: sanitizeStringArray(input.decisions, 8, 500),
    paths: sanitizeStringArray(input.paths, 16, 500),
    keywords: sanitizeStringArray(input.keywords, 12, 120).map((value) => value.toLowerCase()),
    importance: normalizeImportance(input.importance),
    durability: normalizeMemoryDurability(input.durability),
    expiresAt: sanitizeOptionalTime(input.expiresAt),
    archivedAt: input.archivedAt,
    archivedReason: input.archivedReason,
    mergedInto: sanitizeOptionalIdentifier(input.mergedInto),
    lineage
  };
  if (!sanitized.title) sanitized.title = "Memory note";
  return sanitized;
}

/** 写入 SQLite 前再次做边界校验；模型输出也不能绕过格式和长度约束。 */
export function createStoredMemoryEntry(input: MemoryEntryInput, fields: StoredEntryFields): MemoryEntry {
  const safe = sanitizeMemoryEntryInput(sanitizeMemoryEntryInput(input));
  if (!safe.origin) throw new Error("Stored memory entry requires a resolved origin.");
  return {
    id: sanitizeIdentifier(fields.id),
    originalId: fields.originalId === undefined ? undefined : sanitizeIdentifier(fields.originalId),
    origin: safe.origin,
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
    lineage: Array.isArray(safe.lineage) ? safe.lineage : [safe.lineage],
    durability: safe.durability ?? fields.durability ?? "permanent",
    expiresAt: safe.expiresAt ?? sanitizeOptionalTime(fields.expiresAt),
    recallCount: 0,
    lastRecalledAt: undefined,
    archivedAt: typeof safe.archivedAt === "string" ? assertIsoTime(safe.archivedAt) : undefined,
    archivedReason: isArchiveReason(safe.archivedReason) ? safe.archivedReason : undefined,
    mergedInto: typeof safe.mergedInto === "string" ? sanitizeOptionalIdentifier(safe.mergedInto) : undefined,
    archivedBy: typeof fields.archivedBy === "string" ? fields.archivedBy.trim().slice(0, 200) || undefined : undefined
  };
}

export function assertAllowedMemoryEntry(entry: MemoryEntryInput, workspaceRoot: string): void {
  const universal = entry.origin?.kind === "user" || entry.audience === "universal";
  if (!universal) return;
  if (entry.kind !== "preference" && entry.kind !== "working_style") {
    throw new Error("Universal memory only accepts preference and working_style entries.");
  }
  if ((entry.paths?.length ?? 0) > 0 || (entry.decisions?.length ?? 0) > 0 || containsProjectPath(entry, workspaceRoot)) {
    throw new Error("Workspace paths and decisions must be stored in workspace memory.");
  }
  const lineages = Array.isArray(entry.lineage) ? entry.lineage : [entry.lineage];
  const evidenced = lineages.some((lineage) => (
    (lineage.source === "explicit" || lineage.source === "completed_task")
    && Boolean(lineage.userEvidence?.trim())
  ));
  if (!evidenced) throw new Error("Universal memory requires explicit, auditable user evidence.");
}

export function rankMemoryEntries(entries: MemoryEntry[], query: string, queryPaths: string[], now: Date): RankedMemoryEntry[] {
  const queryTerms = tokenizeMemoryText(query);
  const pathTerms = queryPaths.map(normalizeSearchPath).filter(Boolean);
  return entries.map((entry) => {
    const title = entry.title.toLowerCase();
    const summary = entry.summary.toLowerCase();
    const keywords = entry.keywords.map((keyword) => keyword.toLowerCase());
    const searchable = title + "\n" + summary + "\n"
      + entry.decisions.join("\n").toLowerCase() + "\n" + keywords.join(" ");
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
  return normalized.toLowerCase() === "memory" ? "memory-topic" : normalized;
}

export function normalizeImportance(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 3;
  return Math.min(5, Math.max(1, Math.round(value)));
}

export function sanitizeMemoryLineage(lineage: MemoryLineage): MemoryLineage {
  if (!isLineageSource(lineage.source)) throw new Error("Invalid memory lineage source: " + String(lineage.source));
  return {
    source: lineage.source,
    externalContext: lineage.externalContext,
    sessionId: sanitizeOptionalLineageValue(lineage.sessionId, 200),
    turnId: sanitizeOptionalLineageValue(lineage.turnId, 200),
    runId: sanitizeOptionalLineageValue(lineage.runId, 200),
    sourceEntryIds: lineage.sourceEntryIds === undefined
      ? undefined
      : sanitizeStringArray(lineage.sourceEntryIds, Number.MAX_SAFE_INTEGER, 200),
    userEvidence: sanitizeOptionalLineageValue(lineage.userEvidence, 1_000)
  };
}

export function memoryEntryEquals(left: MemoryEntry, right: MemoryEntryInput): boolean {
  return (right.origin === undefined || memoryOriginsEqual(left.origin, right.origin))
    && memoryEntryExactKey(left) === memoryEntryExactKey(right);
}

export function memoryEntryExactKey(entry: Pick<MemoryEntry, "summary"> | Pick<MemoryEntryInput, "summary">): string {
  return normalizeMemoryContent(entry.summary);
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
  return (matched ?? entry.summary).slice(0, 500);
}

function containsProjectPath(entry: MemoryEntryInput, workspaceRoot: string): boolean {
  const content = [entry.topic, entry.title, entry.summary, ...(entry.keywords ?? [])].join("\n");
  if (content.includes(path.resolve(workspaceRoot))) return true;
  return /(?:^|[\s\x60'(])(?:\.{0,2}\/|src\/|tests?\/|packages?\/|apps?\/|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|go|java|py|rs|md|json|ya?ml))(?:$|[\s\x60'),.:])/u.test(content);
}

function sanitizeStringArray(values: string[] | undefined, maxItems: number, maxChars: number): string[] {
  if (!values) return [];
  return [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().slice(0, maxChars))
    .filter(Boolean))].slice(0, maxItems);
}

function sanitizeOptionalLineageValue(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  return value.trim().slice(0, maxChars) || undefined;
}

function sanitizeIdentifier(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 128);
  if (sanitized.length < 8) throw new Error("Memory entry id must contain at least 8 safe characters.");
  return sanitized;
}

function assertIsoTime(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error("Invalid memory timestamp: " + value);
  return new Date(value).toISOString();
}

function normalizeSearchPath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

export function normalizeMemoryContent(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

function isArchiveReason(value: unknown): value is NonNullable<MemoryEntry["archivedReason"]> {
  return value === "exact_dup" || value === "exact" || value === "expired"
    || value === "orphan" || value === "similarity_merge" || value === "llm_merge"
    || value === "similarity" || value === "llm" || value === "manual";
}

function normalizeMemoryDurability(value: MemoryDurability | undefined): MemoryDurability {
  return value === "temporary" ? "temporary" : "permanent";
}

function sanitizeOptionalTime(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return assertIsoTime(value);
}

function sanitizeOptionalIdentifier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return sanitizeIdentifier(trimmed);
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
    || value === "explicit_edit"
    || value === "completed_task"
    || value === "sleep";
}

export function memoryOriginsEqual(left: MemoryOrigin, right: MemoryOrigin): boolean {
  return left.kind === right.kind
    && (left.kind === "user" || (right.kind === "workspace" && left.workspaceId === right.workspaceId));
}

function validateMemoryOrigin(origin: MemoryOrigin): void {
  if (origin.kind === "user") return;
  if (origin.kind !== "workspace" || !/^[a-f0-9]{24}$/u.test(origin.workspaceId) || !origin.workspaceName.trim()) {
    throw new Error("Invalid workspace memory origin.");
  }
}

function sanitizeMemoryOrigin(origin: MemoryOrigin): MemoryOrigin {
  validateMemoryOrigin(origin);
  if (origin.kind === "user") return { kind: "user" };
  return {
    kind: "workspace",
    workspaceId: origin.workspaceId,
    workspaceName: origin.workspaceName.replace(/\s+/g, " ").trim().slice(0, 120)
  };
}
