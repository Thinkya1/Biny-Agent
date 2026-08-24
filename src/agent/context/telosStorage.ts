/**
 * TELOS 的本地 Markdown 存储。
 *
 * 事实记忆仍由 MemoryStorage 负责；这里单独维护用户认可的策略、行为模式和偏差提案。
 * 模型只会产生 observation/pattern/drift，TELOS 文档本身只能由显式用户保存改变。
 */
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { globalAgentDir } from "../../config/paths.js";
import { redactSecrets } from "../../utils/secrets.js";
import type {
  BehaviorPattern,
  BehaviorPatternReviewAction,
  PatternObservation,
  PatternObservationInput,
  TelosDocument,
  TelosDocumentInput,
  TelosDrift,
  TelosDriftResolutionAction,
  TelosEvidence,
  TelosOverview,
  TelosRule,
  TelosGoal,
  TelosScope
} from "./telosTypes.js";

const telosVersion = 1;
const telosRootName = "telos";
const stateFileName = ".telos-state.json";
const lockDirectoryName = ".telos.lock";
const universalDirectoryName = "universal";
const workspaceDirectoryName = "workspaces";
const patternDirectoryName = "patterns";
const observationDirectoryName = "observations";
const driftDirectoryName = "drifts";
const historyDirectoryName = "history";
const lockTimeoutMs = 5_000;
const staleLockMs = 120_000;
const driftCooldownMs = 7 * 24 * 60 * 60 * 1_000;
const maxSummaryChars = 500;
const maxPromptChars = 6_000;

interface TelosState {
  version: 1;
  revision: number;
  updatedAt: string;
}

interface TelosStorageOptions {
  now?: () => Date;
}

const goalSchema: z.ZodType<TelosGoal> = z.object({
  id: z.string().min(1).max(128),
  text: z.string().max(1_000),
  status: z.enum(["active", "paused", "completed"]),
  horizon: z.string().max(120).optional()
}).strict();

const ruleSchema: z.ZodType<TelosRule> = z.object({
  id: z.string().min(1).max(128),
  text: z.string().max(1_000)
}).strict();

const documentSchema: z.ZodType<TelosDocument> = z.object({
  version: z.literal(1),
  scope: z.enum(["universal", "workspace"]),
  workspaceId: z.string().regex(/^[a-f0-9]{24}$/u).optional(),
  workspaceName: z.string().max(120).optional(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  mission: z.string().max(2_000),
  goals: z.array(goalSchema),
  principles: z.array(ruleSchema),
  constraints: z.array(ruleSchema),
  antiGoals: z.array(ruleSchema)
}).strict();

const evidenceSchema = z.object({
  id: z.string().min(8).max(128),
  summary: z.string().min(1).max(maxSummaryChars),
  observedAt: z.string().datetime(),
  sessionId: z.string().max(200).optional(),
  turnId: z.string().max(200).optional(),
  runId: z.string().max(200).optional(),
  externalContext: z.boolean(),
  workspaceId: z.string().regex(/^[a-f0-9]{24}$/u).optional(),
  workspaceName: z.string().max(120).optional()
}).strict();

const observationSchema = z.object({
  kind: z.literal("observation"),
  revision: z.number().int().nonnegative(),
  ...evidenceSchema.shape
}).strict();

const patternSchema: z.ZodType<BehaviorPattern> = z.object({
  id: z.string().min(8).max(128),
  scope: z.enum(["universal", "workspace"]),
  workspaceId: z.string().regex(/^[a-f0-9]{24}$/u).optional(),
  workspaceName: z.string().max(120).optional(),
  title: z.string().min(1).max(160),
  statement: z.string().min(1).max(2_000),
  status: z.enum(["candidate", "confirmed", "rejected", "expired"]),
  confidence: z.number().min(0).max(1),
  evidenceCount: z.number().int().nonnegative(),
  firstObservedAt: z.string().datetime(),
  lastObservedAt: z.string().datetime(),
  evidence: z.array(evidenceSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  revision: z.number().int().nonnegative()
}).strict();

const driftSchema: z.ZodType<TelosDrift> = z.object({
  id: z.string().min(8).max(128),
  scope: z.enum(["universal", "workspace"]),
  workspaceId: z.string().regex(/^[a-f0-9]{24}$/u).optional(),
  workspaceName: z.string().max(120).optional(),
  telosRevision: z.number().int().nonnegative(),
  patternId: z.string().min(8).max(128),
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(2_000),
  status: z.enum(["open", "snoozed", "dismissed", "resolved"]),
  suggestedAction: z.enum(["adjust_telos", "adjust_behavior"]),
  evidence: z.array(evidenceSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  snoozedUntil: z.string().datetime().optional(),
  resolvedAt: z.string().datetime().optional(),
  revision: z.number().int().nonnegative()
}).strict();

export class TelosRevisionConflictError extends Error {
  readonly name = "TelosRevisionConflictError";

  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`TELOS revision conflict: expected ${String(expectedRevision)}, actual ${String(actualRevision)}.`);
  }
}

/** 只使用稳定的 workspace hash，避免把本地绝对路径写入 TELOS 文件。 */
export function telosWorkspaceId(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 24);
}

export class TelosStorage {
  private readonly root: string;
  private readonly now: () => Date;

  constructor(private readonly workspaceRoot: string, options: TelosStorageOptions = {}) {
    this.root = path.join(path.resolve(globalAgentDir()), telosRootName);
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await this.ensureRoot();
  }

  async overview(): Promise<TelosOverview> {
    await this.ensureRoot();
    const state = await this.readState();
    const [universal, workspace, patterns, drifts, observations] = await Promise.all([
      this.readDocument("universal"),
      this.readDocument("workspace"),
      this.readRecords(patternDirectoryName, patternSchema),
      this.readRecords(driftDirectoryName, driftSchema),
      this.readRecords(observationDirectoryName, observationSchema)
    ]);
    const currentWorkspaceId = telosWorkspaceId(this.workspaceRoot);
    const visiblePatterns = patterns.filter((pattern) => isVisible(pattern.scope, pattern.workspaceId, currentWorkspaceId));
    const visibleDrifts = drifts.filter((drift) => isVisible(drift.scope, drift.workspaceId, currentWorkspaceId));
    return {
      revision: state.revision,
      universal: universal?.scope === "universal" ? universal : undefined,
      workspace: workspace?.scope === "workspace" ? workspace : undefined,
      patterns: visiblePatterns.sort(sortByUpdatedAt),
      drifts: visibleDrifts.sort(sortByUpdatedAt),
      counts: {
        observations: observations.filter((observation) => isVisible(observation.workspaceId ? "workspace" : "universal", observation.workspaceId, currentWorkspaceId)).length,
        candidatePatterns: visiblePatterns.filter((pattern) => pattern.status === "candidate").length,
        confirmedPatterns: visiblePatterns.filter((pattern) => pattern.status === "confirmed").length,
        openDrifts: visibleDrifts.filter((drift) => drift.status === "open" || drift.status === "snoozed").length
      }
    };
  }

  /** 读取当前有效 TELOS，供 Agent prompt 使用；正文有界，避免策略无限膨胀。 */
  async promptText(): Promise<string> {
    const snapshot = await this.overview();
    const sections = [snapshot.universal, snapshot.workspace]
      .filter((document): document is TelosDocument => document !== undefined)
      .map((document) => renderPromptDocument(document));
    return sections.join("\n\n").slice(0, maxPromptChars);
  }

  async saveDocument(input: TelosDocumentInput, expectedRevision: number): Promise<TelosDocument> {
    return await this.withLock(async () => {
      const state = await this.readState();
      assertExpectedRevision(expectedRevision, state.revision);
      const timestamp = this.now().toISOString();
      const currentWorkspaceId = telosWorkspaceId(this.workspaceRoot);
      const currentWorkspaceName = path.basename(path.resolve(this.workspaceRoot)) || "当前项目";
      const document: TelosDocument = documentSchema.parse({
        version: telosVersion,
        scope: input.scope,
        workspaceId: input.scope === "workspace" ? currentWorkspaceId : undefined,
        workspaceName: input.scope === "workspace" ? currentWorkspaceName : undefined,
        revision: state.revision + 1,
        updatedAt: timestamp,
        mission: cleanText(input.mission, 2_000),
        goals: normalizeGoals(input.goals),
        principles: normalizeRules(input.principles),
        constraints: normalizeRules(input.constraints),
        antiGoals: normalizeRules(input.antiGoals)
      });
      await this.writeDocument(document);
      await this.writeHistory(document);
      await this.writeState({ version: 1, revision: document.revision, updatedAt: timestamp });
      return document;
    });
  }

  /**
   * 成功根回合只写入脱敏 observation，并同步更新候选行为模式。
   * 同一类摘要的多次出现才会逐步提高置信度；状态不会自动从 candidate 变成 confirmed。
   */
  async recordObservation(input: PatternObservationInput): Promise<BehaviorPattern> {
    if (input.externalContext) throw new Error("External context cannot become a TELOS observation.");
    return await this.withLock(async () => {
      const state = await this.readState();
      const timestamp = input.observedAt ?? this.now().toISOString();
      const currentWorkspaceId = telosWorkspaceId(this.workspaceRoot);
      const currentWorkspaceName = path.basename(path.resolve(this.workspaceRoot)) || "当前项目";
      const evidence: TelosEvidence = evidenceSchema.parse({
        id: randomUUID(),
        summary: cleanText(input.summary, maxSummaryChars),
        observedAt: timestamp,
        sessionId: cleanOptional(input.sessionId, 200),
        turnId: cleanOptional(input.turnId, 200),
        runId: cleanOptional(input.runId, 200),
        externalContext: false,
        workspaceId: input.scope === "workspace" ? currentWorkspaceId : undefined,
        workspaceName: input.scope === "workspace" ? currentWorkspaceName : undefined
      });
      const observation: PatternObservation = {
        kind: "observation",
        revision: state.revision + 1,
        ...evidence
      };
      await this.writeRecord(observationDirectoryName, observation.id, renderObservation(observation));
      const patterns = await this.readRecords(patternDirectoryName, patternSchema);
      const patternKey = normalizePatternKey(evidence.summary);
      const current = patterns.find((pattern) => (
        pattern.scope === input.scope
        && pattern.workspaceId === (input.scope === "workspace" ? currentWorkspaceId : undefined)
        && normalizePatternKey(pattern.statement) === patternKey
        && pattern.status !== "rejected"
        && pattern.status !== "expired"
      ));
      const nextRevision = state.revision + 1;
      const pattern: BehaviorPattern = current
        ? patternSchema.parse({
          ...current,
          confidence: Math.min(0.95, Math.max(current.confidence, 0.35 + (current.evidenceCount + 1) * 0.15)),
          evidenceCount: current.evidenceCount + 1,
          firstObservedAt: minIso(current.firstObservedAt, evidence.observedAt),
          lastObservedAt: maxIso(current.lastObservedAt, evidence.observedAt),
          evidence: appendEvidence(current.evidence, evidence),
          updatedAt: timestamp,
          revision: nextRevision
        })
        : patternSchema.parse({
          id: randomUUID(),
          scope: input.scope,
          workspaceId: input.scope === "workspace" ? currentWorkspaceId : undefined,
          workspaceName: input.scope === "workspace" ? currentWorkspaceName : undefined,
          title: `重复行为：${evidence.summary.slice(0, 64)}`,
          statement: evidence.summary,
          status: "candidate",
          confidence: 0.5,
          evidenceCount: 1,
          firstObservedAt: evidence.observedAt,
          lastObservedAt: evidence.observedAt,
          evidence: [evidence],
          createdAt: timestamp,
          updatedAt: timestamp,
          revision: nextRevision
        });
      await this.writeRecord(patternDirectoryName, pattern.id, renderPattern(pattern));
      await this.writeState({ version: 1, revision: nextRevision, updatedAt: timestamp });
      return pattern;
    });
  }

  async reviewPattern(
    id: string,
    action: BehaviorPatternReviewAction,
    expectedRevision: number,
    options: { detectDrift?: boolean } = {}
  ): Promise<TelosOverview> {
    return await this.withLock(async () => {
      const state = await this.readState();
      assertExpectedRevision(expectedRevision, state.revision);
      const patterns = await this.readRecords(patternDirectoryName, patternSchema);
      const pattern = patterns.find((candidate) => candidate.id === id);
      if (!pattern) throw new Error("未找到该行为模式。");
      assertVisibleRecord(pattern, telosWorkspaceId(this.workspaceRoot), "行为模式");
      const timestamp = this.now().toISOString();
      const nextRevision = state.revision + 1;
      const next: BehaviorPattern = patternSchema.parse({
        ...pattern,
        status: action === "confirm" ? "confirmed" : action === "reject" ? "rejected" : "expired",
        updatedAt: timestamp,
        revision: nextRevision
      });
      await this.writeRecord(patternDirectoryName, next.id, renderPattern(next));
      if (options.detectDrift !== false) await this.maybeCreateDrift(next, nextRevision, timestamp);
      await this.writeState({ version: 1, revision: nextRevision, updatedAt: timestamp });
      return await this.overview();
    });
  }

  async resolveDrift(id: string, action: TelosDriftResolutionAction, expectedRevision: number): Promise<TelosOverview> {
    return await this.withLock(async () => {
      const state = await this.readState();
      assertExpectedRevision(expectedRevision, state.revision);
      const drifts = await this.readRecords(driftDirectoryName, driftSchema);
      const drift = drifts.find((candidate) => candidate.id === id);
      if (!drift) throw new Error("未找到该策略偏差。");
      assertVisibleRecord(drift, telosWorkspaceId(this.workspaceRoot), "策略偏差");
      const timestamp = this.now().toISOString();
      const nextRevision = state.revision + 1;
      const next: TelosDrift = driftSchema.parse({
        ...drift,
        status: action === "dismiss" ? "dismissed" : "resolved",
        updatedAt: timestamp,
        resolvedAt: timestamp,
        revision: nextRevision
      });
      await this.writeRecord(driftDirectoryName, next.id, renderDrift(next));
      await this.writeState({ version: 1, revision: nextRevision, updatedAt: timestamp });
      return await this.overview();
    });
  }

  async snoozeDrift(id: string, until: string, expectedRevision: number): Promise<TelosOverview> {
    return await this.withLock(async () => {
      const state = await this.readState();
      assertExpectedRevision(expectedRevision, state.revision);
      const drifts = await this.readRecords(driftDirectoryName, driftSchema);
      const drift = drifts.find((candidate) => candidate.id === id);
      if (!drift) throw new Error("未找到该策略偏差。");
      assertVisibleRecord(drift, telosWorkspaceId(this.workspaceRoot), "策略偏差");
      const timestamp = this.now().toISOString();
      const nextRevision = state.revision + 1;
      const next: TelosDrift = driftSchema.parse({
        ...drift,
        status: "snoozed",
        snoozedUntil: new Date(until).toISOString(),
        updatedAt: timestamp,
        revision: nextRevision
      });
      await this.writeRecord(driftDirectoryName, next.id, renderDrift(next));
      await this.writeState({ version: 1, revision: nextRevision, updatedAt: timestamp });
      return await this.overview();
    });
  }

  private async maybeCreateDrift(pattern: BehaviorPattern, revision: number, timestamp: string): Promise<void> {
    if (pattern.status !== "confirmed" || pattern.evidenceCount < 3) return;
    const spanMs = Date.parse(pattern.lastObservedAt) - Date.parse(pattern.firstObservedAt);
    if (spanMs < 7 * 24 * 60 * 60 * 1_000 || pattern.confidence < 0.75) return;
    const document = await this.readDocument(pattern.scope);
    if (!document || (!document.mission.trim() && !document.goals.length && !document.principles.length && !document.constraints.length && !document.antiGoals.length)) return;
    const telosText = documentText(document).toLocaleLowerCase();
    if (telosText.includes(pattern.statement.toLocaleLowerCase())) return;
    const drifts = await this.readRecords(driftDirectoryName, driftSchema);
    const duplicate = drifts.some((drift) => (
      drift.patternId === pattern.id
      && drift.telosRevision === document.revision
      && drift.status !== "dismissed"
      && drift.status !== "resolved"
    ));
    if (duplicate) return;
    const recentlyCreated = drifts.some((drift) => (
      drift.patternId === pattern.id
      && Date.parse(timestamp) - Date.parse(drift.createdAt) < driftCooldownMs
      && drift.status !== "dismissed"
    ));
    if (recentlyCreated) return;
    const drift: TelosDrift = driftSchema.parse({
      id: randomUUID(),
      scope: pattern.scope,
      workspaceId: pattern.workspaceId,
      workspaceName: pattern.workspaceName,
      telosRevision: document.revision,
      patternId: pattern.id,
      title: "行为模式与当前 TELOS 尚未对齐",
      summary: `最近的协作记录持续呈现“${pattern.statement}”，但当前 TELOS 中没有对应的目标或原则。请确认是调整策略，还是调整行为。`,
      status: "open",
      suggestedAction: "adjust_telos",
      evidence: pattern.evidence,
      createdAt: timestamp,
      updatedAt: timestamp,
      revision
    });
    await this.writeRecord(driftDirectoryName, drift.id, renderDrift(drift));
  }

  private async readDocument(scope: TelosScope): Promise<TelosDocument | undefined> {
    const filePath = this.documentPath(scope);
    const content = await readOptional(filePath);
    if (!content) return undefined;
    return parseDocument(content);
  }

  private async writeDocument(document: TelosDocument): Promise<void> {
    await this.writeFile(this.documentPath(document.scope), renderDocument(document));
  }

  private async writeHistory(document: TelosDocument): Promise<void> {
    const scopeName = document.scope === "universal" ? "universal" : `workspace-${document.workspaceId ?? "unknown"}`;
    await this.writeRecord(historyDirectoryName, `${scopeName}-${String(document.revision)}`, renderDocument(document));
  }

  private documentPath(scope: TelosScope): string {
    return scope === "universal"
      ? path.join(this.root, universalDirectoryName, "TELOS.md")
      : path.join(this.root, workspaceDirectoryName, telosWorkspaceId(this.workspaceRoot), "TELOS.md");
  }

  private async readRecords<T>(directoryName: string, schema: z.ZodType<T>): Promise<T[]> {
    const directory = path.join(this.root, directoryName);
    try {
      const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".md")).sort();
      const records: T[] = [];
      for (const name of names) {
        const value = await readOptional(path.join(directory, name));
        if (!value) continue;
        const parsed = schema.safeParse(parseFrontmatter(value));
        if (parsed.success) records.push(parsed.data);
      }
      return records;
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  private async writeRecord(directoryName: string, id: string, content: string): Promise<void> {
    await this.writeFile(path.join(this.root, directoryName, `${safeFileName(id)}.md`), content);
  }

  private async writeFile(filePath: string, content: string): Promise<void> {
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporary, "w", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, filePath);
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.chmod(this.root, 0o700);
  }

  private async readState(): Promise<TelosState> {
    const content = await readOptional(path.join(this.root, stateFileName));
    if (!content) return { version: 1, revision: 0, updatedAt: new Date(0).toISOString() };
    try {
      const parsed = JSON.parse(content) as Partial<TelosState>;
      const revision = parsed.revision;
      if (parsed.version !== 1 || !Number.isSafeInteger(revision) || revision === undefined || revision < 0 || typeof parsed.updatedAt !== "string") {
        throw new Error("Invalid TELOS state.");
      }
      return { version: 1, revision, updatedAt: parsed.updatedAt };
    } catch (error) {
      throw new Error(`无法读取 TELOS 状态：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async writeState(state: TelosState): Promise<void> {
    await this.writeFile(path.join(this.root, stateFileName), `${JSON.stringify(state, null, 2)}\n`);
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    await this.ensureRoot();
    const lockPath = path.join(this.root, lockDirectoryName);
    const startedAt = Date.now();
    while (true) {
      try {
        await fs.mkdir(lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > staleLockMs) await fs.rm(lockPath, { recursive: true, force: true });
        } catch (statError) {
          if (!isNotFound(statError)) throw statError;
        }
        if (Date.now() - startedAt >= lockTimeoutMs) throw new Error("TELOS 存储锁等待超时，请稍后重试。");
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }
    try {
      return await work();
    } finally {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  }
}

function assertExpectedRevision(expected: number, actual: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error("TELOS expected revision is invalid.");
  if (expected !== actual) throw new TelosRevisionConflictError(expected, actual);
}

function parseDocument(content: string): TelosDocument | undefined {
  const parsed = documentSchema.safeParse(parseFrontmatter(content));
  return parsed.success ? parsed.data : undefined;
}

function parseFrontmatter(content: string): unknown {
  if (!content.startsWith("---\n")) return undefined;
  const closing = content.indexOf("\n---", 4);
  if (closing < 0) return undefined;
  try {
    return parseYaml(content.slice(4, closing));
  } catch {
    return undefined;
  }
}

function renderDocument(document: TelosDocument): string {
  const frontmatter = stringifyYaml({
    version: 1,
    scope: document.scope,
    workspaceId: document.workspaceId,
    workspaceName: document.workspaceName,
    revision: document.revision,
    updatedAt: document.updatedAt,
    mission: document.mission,
    goals: document.goals,
    principles: document.principles,
    constraints: document.constraints,
    antiGoals: document.antiGoals
  }, { lineWidth: 0 }).trimEnd();
  return [
    "---",
    frontmatter,
    "---",
    "",
    "# TELOS",
    "",
    "## 使命",
    "",
    document.mission || "（尚未填写）",
    "",
    "## 目标",
    "",
    ...document.goals.map((goal) => `- [${goal.status === "completed" ? "x" : " "}] ${goal.text}${goal.horizon ? `（${goal.horizon}）` : ""}`),
    ...(document.goals.length ? [] : ["- （尚未填写）"]),
    "",
    "## 原则",
    "",
    ...renderRules(document.principles),
    "",
    "## 约束",
    "",
    ...renderRules(document.constraints),
    "",
    "## 反目标",
    "",
    ...renderRules(document.antiGoals),
    ""
  ].join("\n");
}

function renderPromptDocument(document: TelosDocument): string {
  const scope = document.scope === "universal" ? "通用 TELOS" : `项目 TELOS（${document.workspaceName ?? "当前项目"}）`;
  return [
    `## ${scope}`,
    `使命：${document.mission || "未定义"}`,
    `目标：${document.goals.filter((goal) => goal.status === "active").map((goal) => goal.text).join("；") || "未定义"}`,
    `原则：${document.principles.map((rule) => rule.text).join("；") || "未定义"}`,
    `约束：${document.constraints.map((rule) => rule.text).join("；") || "未定义"}`,
    `反目标：${document.antiGoals.map((rule) => rule.text).join("；") || "未定义"}`
  ].join("\n");
}

function renderObservation(observation: PatternObservation): string {
  return renderRecord(observation, "# 行为观察", observation.summary);
}

function renderPattern(pattern: BehaviorPattern): string {
  return renderRecord(pattern, `# ${pattern.title}`, [
    pattern.statement,
    "",
    `状态：${pattern.status}`,
    `置信度：${Math.round(pattern.confidence * 100)}%`,
    `观察次数：${String(pattern.evidenceCount)}`,
    "",
    "## 证据",
    "",
    ...pattern.evidence.map((evidence) => `- ${evidence.observedAt}：${evidence.summary}`)
  ].join("\n"));
}

function renderDrift(drift: TelosDrift): string {
  return renderRecord(drift, `# ${drift.title}`, [
    drift.summary,
    "",
    `状态：${drift.status}`,
    `建议动作：${drift.suggestedAction}`,
    `TELOS revision：${String(drift.telosRevision)}`,
    "",
    "## 证据",
    "",
    ...drift.evidence.map((evidence) => `- ${evidence.observedAt}：${evidence.summary}`)
  ].join("\n"));
}

function renderRecord(value: unknown, title: string, body: string): string {
  return ["---", stringifyYaml(value, { lineWidth: 0 }).trimEnd(), "---", "", title, "", body, ""].join("\n");
}

function renderRules(rules: TelosRule[]): string[] {
  return rules.length ? rules.map((rule) => `- ${rule.text}`) : ["- （尚未填写）"];
}

function normalizeGoals(goals: TelosGoal[] | undefined): TelosGoal[] {
  return (goals ?? []).map((goal) => ({
    id: cleanText(goal.id || randomUUID(), 128),
    text: cleanText(goal.text, 1_000),
    status: goal.status,
    horizon: cleanOptional(goal.horizon, 120)
  })).filter((goal) => goal.text);
}

function normalizeRules(rules: TelosRule[] | undefined): TelosRule[] {
  return (rules ?? []).map((rule) => ({
    id: cleanText(rule.id || randomUUID(), 128),
    text: cleanText(rule.text, 1_000)
  })).filter((rule) => rule.text);
}

function cleanText(value: string, maxChars: number): string {
  return redactSecrets(value ?? "").replace(/\s+/gu, " ").trim().slice(0, maxChars);
}

function cleanOptional(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  const clean = cleanText(value, maxChars);
  return clean || undefined;
}

function appendEvidence(existing: TelosEvidence[], next: TelosEvidence): TelosEvidence[] {
  if (existing.some((evidence) => evidence.id === next.id)) return existing;
  return [...existing, next].slice(-32);
}

function normalizePatternKey(value: string): string {
  return cleanText(value, maxSummaryChars).toLocaleLowerCase().replace(/[0-9a-f]{8,}/gu, "id");
}

function documentText(document: TelosDocument): string {
  return [
    document.mission,
    ...document.goals.map((goal) => goal.text),
    ...document.principles.map((rule) => rule.text),
    ...document.constraints.map((rule) => rule.text),
    ...document.antiGoals.map((rule) => rule.text)
  ].join(" ").toLocaleLowerCase();
}

function isVisible(scope: TelosScope, workspaceId: string | undefined, currentWorkspaceId: string): boolean {
  return scope === "universal" || workspaceId === currentWorkspaceId;
}

function assertVisibleRecord(
  record: { scope: TelosScope; workspaceId?: string },
  currentWorkspaceId: string,
  label: string
): void {
  if (!isVisible(record.scope, record.workspaceId, currentWorkspaceId)) {
    throw new Error(`该${label}不属于当前工作区。`);
  }
}

function sortByUpdatedAt<T extends { updatedAt: string }>(left: T, right: T): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

function minIso(left: string, right: string): string { return Date.parse(left) <= Date.parse(right) ? left : right; }
function maxIso(left: string, right: string): string { return Date.parse(left) >= Date.parse(right) ? left : right; }

function safeFileName(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 180);
  return safe || randomUUID();
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
