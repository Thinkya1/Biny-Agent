/**
 * /memory 单库命令。
 *
 * user/current/other 只是来源视图；写入时使用 workspace/universal audience，不再把来源映射成
 * 两套物理目录或两份 revision。
 */
import {
  MemoryRevisionConflictError,
  type MemoryAudience,
  type MemoryEntry,
  type MemoryKind,
  type MemoryOriginSelector,
  type MemorySearchOptions,
  type MemorySearchResult
} from "./memoryTypes.js";
import type { LocalMemory } from "./LocalMemory.js";

const memoryKinds: MemoryKind[] = ["preference", "working_style", "fact", "decision", "workflow", "gotcha"];
const selectors: MemoryOriginSelector[] = ["all", "current_workspace", "user", "other_workspaces"];

export const memoryCommandUsage = [
  "Usage:",
  "  /memory list [all|current|user|other]",
  "  /memory show [all|current|user|other] <id-or-topic>",
  "  /memory add [workspace|universal] [kind] <topic> <note>",
  "  /memory forget [all|current|user|other] <id-or-topic>",
  "  /memory search [all|current|user|other] <query>",
  "  /memory consolidate [current|user] [topic]"
].join("\n");

export async function runMemoryCommand(
  memory: LocalMemory | undefined,
  args: string[],
  searchMemory?: (query: string, paths: string[], options: MemorySearchOptions) => Promise<MemorySearchResult>
): Promise<string> {
  if (!memory) return "Local memory is unavailable.";
  const action = args[0]?.toLowerCase() ?? "list";

  if (action === "list") {
    const origin = readSelector(args[1]);
    const result = await memory.listMemoryEntries({ origins: [origin], limit: 200 });
    if (!result.entries.length) return `Local memory is empty for ${selectorLabel(origin)}. Use /memory add [workspace|universal] [kind] <topic> <note>.`;
    return [
      `Memory entries (${String(result.entries.length)}; ${selectorLabel(origin)}):`,
      ...result.entries.map(formatEntryLine),
      `Revision: ${String(result.storeRevision)}`,
      "",
      memoryCommandUsage
    ].join("\n");
  }

  if (action === "show") {
    const parsed = readOptionalSelector(args.slice(1));
    const selector = parsed.rest.join(" ").trim();
    if (!selector) return "Usage: /memory show [all|current|user|other] <id-or-topic>";
    const result = await memory.listMemoryEntries({ origins: [parsed.origin], limit: 500 });
    const entries = selectEntries(result.entries, selector);
    return entries.length ? entries.map(formatEntryDetail).join("\n\n") : `No memory entry or topic named ${selector} in ${selectorLabel(parsed.origin)}.`;
  }

  if (action === "add") {
    const parsed = readOptionalAudience(args.slice(1));
    const kind = isMemoryKind(parsed.rest[0])
      ? parsed.rest.shift() as MemoryKind
      : parsed.audience === "universal" ? "preference" : "fact";
    const topic = parsed.rest.shift()?.trim();
    const note = parsed.rest.join(" ").trim();
    if (!topic || !note) return "Usage: /memory add [workspace|universal] [kind] <topic> <note>";
    if (parsed.audience === "universal" && kind !== "preference" && kind !== "working_style") {
      return "Universal memory only accepts preference or working_style entries.";
    }
    const result = await mutateWithFreshRevision(memory, async (expectedRevision) => await memory.writeEntry({
      audience: parsed.audience,
      kind,
      topic,
      title: noteTitle(note),
      summary: note,
      decisions: [],
      paths: [],
      keywords: [],
      importance: 3,
      lineage: {
        source: "explicit",
        externalContext: false,
        userEvidence: parsed.audience === "universal" ? note : undefined
      }
    }, { expectedRevision }));
    if (!result.written) return "Skipped: an equivalent note already exists or the note is too short.";
    return `Saved ${parsed.audience}/${kind} memory ${result.entry?.id ?? result.path ?? topic}.`;
  }

  if (action === "forget" || action === "delete") {
    const parsed = readOptionalSelector(args.slice(1));
    const selector = parsed.rest.join(" ").trim();
    if (!selector) return "Usage: /memory forget [all|current|user|other] <id-or-topic>";
    const snapshot = await memory.listMemoryEntries({ origins: [parsed.origin], limit: 500 });
    const targets = selectEntries(snapshot.entries, selector);
    if (!targets.length) return `No memory entry or topic named ${selector} in ${selectorLabel(parsed.origin)}.`;
    let deleted = 0;
    for (const target of targets) {
      const result = await mutateWithFreshRevision(memory, async (expectedRevision) => (
        await memory.deleteEntryById(target.id, { expectedRevision })
      ));
      if (result.deleted) deleted += 1;
    }
    return `Deleted ${String(deleted)} memory ${deleted === 1 ? "entry" : "entries"}.`;
  }

  if (action === "search") {
    const parsed = readOptionalSelector(args.slice(1));
    const query = parsed.rest.join(" ").trim();
    if (!query) return "Usage: /memory search [all|current|user|other] <query>";
    const options: MemorySearchOptions = { origins: [parsed.origin], limit: 8 };
    const result = searchMemory
      ? await searchMemory(query, [], options)
      : await memory.search(query, [], options);
    if (!result.matches.length) return `No memory matches for: ${query}`;
    return [
      `Memory matches for "${query}":`,
      ...result.matches.map((match) => `  [${originLabel(match.entry)}/${match.entry.kind}/${match.topic}] ${match.entry.id} (score ${String(match.score)}) ${match.excerpt}`),
      `Included: user=${String(result.report.origins.included.user)}, current=${String(result.report.origins.included.currentWorkspace)}, other=${String(result.report.origins.included.otherWorkspaces)}; omitted=${String(result.report.omitted.length)}`
    ].join("\n");
  }

  if (action === "compact" || action === "consolidate") {
    const parsed = readOptionalSelector(args.slice(1), "current_workspace");
    if (parsed.origin !== "current_workspace" && parsed.origin !== "user") {
      return "Consolidation requires current or user so entries from different origins are never merged.";
    }
    const topic = parsed.rest.join(" ").trim() || undefined;
    const result = await mutateWithFreshRevision(memory, async (expectedRevision) => (
      await memory.consolidateEntries(parsed.origin, { expectedRevision, topic })
    ));
    if (result.error) return `Memory consolidation failed without changing data: ${result.error}`;
    return result.after < result.before
      ? `Consolidated ${selectorLabel(parsed.origin)} memory: ${String(result.before)} -> ${String(result.after)} entries.`
      : `${selectorLabel(parsed.origin)} memory has ${String(result.before)} entries; nothing to merge.`;
  }

  return memoryCommandUsage;
}

async function mutateWithFreshRevision<T>(memory: LocalMemory, mutation: (expectedRevision: number) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const overview = await memory.getOverview();
    try {
      return await mutation(overview.storeRevision);
    } catch (error) {
      if (!(error instanceof MemoryRevisionConflictError) || attempt === 2) throw error;
    }
  }
  throw new Error("Memory revision retry exhausted.");
}

function readOptionalAudience(args: string[]): { audience: MemoryAudience; rest: string[] } {
  const rest = [...args];
  const value = rest[0]?.toLowerCase();
  if (value === "workspace" || value === "universal") {
    rest.shift();
    return { audience: value, rest };
  }
  return { audience: "workspace", rest };
}

function readOptionalSelector(args: string[], fallback: MemoryOriginSelector = "all"): { origin: MemoryOriginSelector; rest: string[] } {
  const rest = [...args];
  const normalized = selectorFromInput(rest[0]);
  if (normalized) {
    rest.shift();
    return { origin: normalized, rest };
  }
  return { origin: fallback, rest };
}

function readSelector(value: string | undefined): MemoryOriginSelector {
  return selectorFromInput(value) ?? "all";
}

function selectorFromInput(value: string | undefined): MemoryOriginSelector | undefined {
  const normalized = value?.toLowerCase();
  if (normalized === "current") return "current_workspace";
  if (normalized === "other") return "other_workspaces";
  return selectors.includes(normalized as MemoryOriginSelector) ? normalized as MemoryOriginSelector : undefined;
}

function isMemoryKind(value: string | undefined): value is MemoryKind {
  return value !== undefined && memoryKinds.includes(value as MemoryKind);
}

function selectEntries(entries: MemoryEntry[], selector: string): MemoryEntry[] {
  const exact = entries.find((entry) => entry.id === selector);
  return exact ? [exact] : entries.filter((entry) => entry.topic === selector);
}

function originLabel(entry: MemoryEntry): string {
  return entry.origin.kind === "user" ? "user" : `workspace:${entry.origin.workspaceName}`;
}

function formatEntryLine(entry: MemoryEntry): string {
  return `  [${originLabel(entry)}/${entry.kind}] ${entry.id}  ${entry.topic}  ${entry.title}  importance=${String(entry.importance)}`;
}

function formatEntryDetail(entry: MemoryEntry): string {
  return [
    `${entry.id} [${originLabel(entry)}/${entry.kind}] revision=${String(entry.revision)}`,
    `${entry.title} (${entry.topic}; importance=${String(entry.importance)})`,
    entry.summary,
    ...(entry.decisions.length ? [`Decisions: ${entry.decisions.join("; ")}`] : []),
    ...(entry.paths.length ? [`Paths: ${entry.paths.join(", ")}`] : []),
    `Updated: ${entry.updatedAt}`,
    `Recalled: ${String(entry.recallCount)}${entry.lastRecalledAt ? `; last ${entry.lastRecalledAt}` : ""}`,
    `Sources: ${entry.lineage.map((lineage) => lineage.source).join(", ")}`
  ].join("\n");
}

function selectorLabel(selector: MemoryOriginSelector): string {
  if (selector === "current_workspace") return "current workspace";
  if (selector === "other_workspaces") return "other workspaces";
  if (selector === "user") return "universal preferences";
  return "all origins";
}

function noteTitle(note: string): string {
  const firstLine = note.split("\n", 1)[0] ?? note;
  return firstLine.length <= 60 ? firstLine : `${firstLine.slice(0, 59)}…`;
}
