/**
 * 独立验收 harness 的确定性验证规划层。
 *
 * 这里只消费结构化运行事实：实际变更的文件、调用方声明的检查和受管进程。
 * 它不接入普通 AgentSession 的自然停止路径；只有显式调用该 harness 时才会运行。
 */
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import {
  AcceptanceVerifier,
  type AcceptanceVerificationResult,
  type ManagedProcessInspector
} from "../harness/AcceptanceVerifier.js";
import type { AcceptanceCommandExecutor } from "../harness/AcceptanceCommandExecutor.js";
import type { AcceptanceCriterion } from "../harness/acceptanceTypes.js";
import { isIgnoredPath } from "../workspace/ignore.js";

const ignoredDirectoryNames = new Set([
  ".biny",
  ".agent",
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage"
]);
const maxDiscoveryDepth = 4;
const maxDiscoveryEntries = 5_000;
const maxManifestBytes = 512 * 1024;
const maxDiscoveredChecks = 32;
const projectScriptNames = ["typecheck", "test", "lint", "build"] as const;

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export interface StructuredVerificationCheck {
  id: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  description?: string;
}

export interface DiscoveredProjectCheck extends StructuredVerificationCheck {
  source: "package_json" | "maven";
  projectRoot: string;
}

export interface StartedProcessVerificationFact {
  processId: string;
  cwd?: string;
  url?: string;
  readinessType?: "http" | "tcp" | "log";
  requireHttpReadiness?: boolean;
  description?: string;
}

export interface AgentVerificationFacts {
  changedFiles: readonly string[];
  /** 本回合是否观察到可写工具执行；仅作为运行事实保留，不会单独触发验证。 */
  workspaceMutationObserved?: boolean;
  /** 由宿主/API 显式提供，不从用户文本关键词推断。 */
  userRequestedVerification?: boolean;
  checks?: readonly StructuredVerificationCheck[];
  startedProcesses?: readonly StartedProcessVerificationFact[];
}

export interface AgentVerificationPlan {
  required: boolean;
  criteria: AcceptanceCriterion[];
  reasons: string[];
}

export interface VerifyAgentRunOptions {
  workspaceRoot: string;
  facts: AgentVerificationFacts;
  ignore?: string[];
  managedProcesses?: ManagedProcessInspector;
  signal?: AbortSignal;
  verifier?: AcceptanceVerifier;
  commandExecutor?: AcceptanceCommandExecutor;
}

export interface AgentRunVerificationResult {
  plan: AgentVerificationPlan;
  verification?: AcceptanceVerificationResult;
}

/**
 * 从运行事实派生检查：
 * - 结构化 checks 始终执行；
 * - 只有宿主显式要求确定性验证时，才自动发现项目检查并检查本回合启动的进程；
 * - 本回合启动的进程按精确 processId 检查，不能由旧进程冒充。
 *
 * 普通工作区变更本身不会自动触发 typecheck/test/lint/build。调用方只有在明确需要
 * 独立验收时，才应传入显式验证事实或结构化 checks。
 */
export async function deriveAgentVerificationPlan(
  workspaceRoot: string,
  facts: AgentVerificationFacts,
  ignore: string[] = []
): Promise<AgentVerificationPlan> {
  const criteria: AcceptanceCriterion[] = [];
  const reasons: string[] = [];
  if (facts.userRequestedVerification === true) reasons.push("user_requested_verification");
  const checks = facts.checks ?? [];
  if (checks.length) {
    reasons.push("structured_checks");
    criteria.push(...checks.map(commandCriterion));
  }

  if (facts.userRequestedVerification === true) {
    const discovered = await discoverProjectChecks(workspaceRoot, ignore);
    if (discovered.length) {
      reasons.push("explicit_verification_with_discovered_checks");
      criteria.push(...discovered.map(commandCriterion));
    }
    const startedProcesses = facts.startedProcesses ?? [];
    if (startedProcesses.length) {
      reasons.push("started_managed_process");
      criteria.push(...startedProcesses.map(processCriterion));
    }
  }

  const deduplicated = deduplicateCriteria(criteria);
  return {
    required: facts.userRequestedVerification === true || deduplicated.length > 0,
    criteria: deduplicated,
    reasons
  };
}

/** 派生后立即执行；无验证要求时不构造一个“空条件通过”的伪证据。 */
export async function verifyAgentRun(
  options: VerifyAgentRunOptions
): Promise<AgentRunVerificationResult> {
  options.signal?.throwIfAborted();
  const plan = await deriveAgentVerificationPlan(
    options.workspaceRoot,
    options.facts,
    options.ignore
  );
  if (!plan.required) return { plan, verification: undefined };
  const verifier = options.verifier ?? new AcceptanceVerifier({
    workspaceRoot: options.workspaceRoot,
    ignore: options.ignore,
    managedProcesses: options.managedProcesses,
    commandExecutor: options.commandExecutor
  });
  const verification = await verifier.verifyCriteria(plan.criteria, {
    signal: options.signal,
    requireCriteria: true
  });
  return { plan, verification };
}

/** 发现项目声明的检查命令；扫描结果只取决于工作区结构，不读取用户输入。 */
export async function discoverProjectChecks(
  workspaceRoot: string,
  ignore: string[] = []
): Promise<DiscoveredProjectCheck[]> {
  const root = path.resolve(workspaceRoot);
  const manifests = await discoverManifests(root, ignore);
  const checks: DiscoveredProjectCheck[] = [];
  for (const manifestPath of manifests) {
    if (checks.length >= maxDiscoveredChecks) break;
    const directory = path.dirname(manifestPath);
    const projectRoot = toRelative(root, directory);
    if (path.basename(manifestPath) === "pom.xml") {
      checks.push({
        id: criterionId("maven-test", projectRoot),
        command: await fileExists(path.join(directory, "mvnw")) ? "./mvnw test" : "mvn test",
        cwd: projectRoot,
        description: `Maven tests in ${projectRoot}`,
        source: "maven",
        projectRoot
      });
      continue;
    }
    const scripts = await readPackageScripts(manifestPath);
    if (!scripts) continue;
    const packageManager = await detectPackageManager(directory, root);
    for (const script of projectScriptNames) {
      if (checks.length >= maxDiscoveredChecks) break;
      const command = scripts.get(script);
      if (!command || script === "test" && isPlaceholderTest(command)) continue;
      checks.push({
        id: criterionId(`node-${script}`, projectRoot),
        command: `${packageManager} run ${script}`,
        cwd: projectRoot,
        description: `${script} in ${projectRoot}`,
        source: "package_json",
        projectRoot
      });
    }
  }
  return checks;
}

function commandCriterion(check: StructuredVerificationCheck): AcceptanceCriterion {
  return {
    id: check.id,
    kind: "command_succeeded",
    command: check.command,
    cwd: check.cwd,
    timeoutMs: check.timeoutMs,
    description: check.description
  };
}

function processCriterion(fact: StartedProcessVerificationFact): AcceptanceCriterion {
  return {
    id: criterionId("managed-process", fact.processId),
    kind: "managed_process",
    processId: fact.processId,
    url: fact.url,
    cwd: fact.cwd,
    requireHttpReadiness: fact.requireHttpReadiness ?? fact.readinessType === "http",
    description: fact.description
  };
}

async function discoverManifests(root: string, ignore: string[]): Promise<string[]> {
  const results: string[] = [];
  let visited = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxDiscoveryDepth || visited >= maxDiscoveryEntries) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      visited += 1;
      if (visited > maxDiscoveryEntries) return;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (isIgnoredPath(relative, ignore)) continue;
      if (entry.isFile() && (entry.name === "package.json" || entry.name === "pom.xml")) {
        results.push(absolute);
      } else if (entry.isDirectory() && !ignoredDirectoryNames.has(entry.name)) {
        await visit(absolute, depth + 1);
      }
    }
  };
  await visit(root, 0);
  return results;
}

async function readPackageScripts(manifestPath: string): Promise<Map<string, string> | undefined> {
  try {
    const metadata = await fs.stat(manifestPath);
    if (!metadata.isFile() || metadata.size > maxManifestBytes) return undefined;
    const parsed: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.scripts)) return new Map();
    return new Map(
      Object.entries(parsed.scripts)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
  } catch {
    return undefined;
  }
}

async function detectPackageManager(directory: string, workspaceRoot: string): Promise<PackageManager> {
  let current = path.resolve(directory);
  const root = path.resolve(workspaceRoot);
  while (isWithinOrEqual(root, current)) {
    if (await fileExists(path.join(current, "pnpm-lock.yaml"))) return "pnpm";
    if (await fileExists(path.join(current, "yarn.lock"))) return "yarn";
    if (await fileExists(path.join(current, "bun.lockb")) || await fileExists(path.join(current, "bun.lock"))) {
      return "bun";
    }
    if (current === root) break;
    current = path.dirname(current);
  }
  return "npm";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function deduplicateCriteria(criteria: readonly AcceptanceCriterion[]): AcceptanceCriterion[] {
  const signatures = new Set<string>();
  const ids = new Map<string, number>();
  const result: AcceptanceCriterion[] = [];
  for (const criterion of criteria) {
    const signature = criterionSignature(criterion);
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    const count = (ids.get(criterion.id) ?? 0) + 1;
    ids.set(criterion.id, count);
    result.push(count === 1 ? { ...criterion } : { ...criterion, id: `${criterion.id}-${String(count)}` });
  }
  return result;
}

function criterionSignature(criterion: AcceptanceCriterion): string {
  if (criterion.kind === "command_succeeded") {
    return `command\0${criterion.cwd ?? "."}\0${criterion.command}`;
  }
  if (criterion.kind === "managed_process") return `process\0${criterion.processId ?? ""}`;
  return JSON.stringify(criterion);
}

function criterionId(prefix: string, value: string): string {
  const suffix = value.replace(/[^A-Za-z0-9_-]+/gu, "-").replace(/^-|-$/gu, "") || "root";
  return `${prefix}-${suffix}`.slice(0, 128);
}

function isPlaceholderTest(command: string): boolean {
  return /no test specified|exit\s+1/iu.test(command);
}

function toRelative(root: string, value: string): string {
  return path.relative(root, value) || ".";
}

function isWithinOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
