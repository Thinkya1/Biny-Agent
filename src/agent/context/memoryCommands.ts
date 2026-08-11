/**
 * /memory 命令模块。
 *
 * CLI 与 TUI 共用这一份实现。命令只负责解析和展示，条目、scope revision、锁和原子写均由
 * LocalMemory/MemoryStorage 负责；未指定 scope 的旧命令仍默认 project。
 */
import { MemoryRevisionConflictError, type MemoryEntry, type MemoryKind, type MemoryScope } from "./memoryTypes.js";
import type { LocalMemory } from "./LocalMemory.js";

const memoryKinds: MemoryKind[] = ["preference", "working_style", "fact", "decision", "workflow", "gotcha"];

export const memoryCommandUsage = [
  "Usage:",
  "  /memory list [global|project|all]",
  "  /memory show [global|project] <id-or-topic>",
  "  /memory add [global|project] [kind] <topic> <note>",
  "  /memory forget [global|project] <id-or-topic>",
  "  /memory search [global|project|all] <query>",
  "  /memory consolidate [global|project] [topic]"
].join("\n");

export async function runMemoryCommand(memory: LocalMemory | undefined, args: string[]): Promise<string> {
  if (!memory) return "Local memory is unavailable.";
  const action = args[0]?.toLowerCase() ?? "list";

  if (action === "list") {
    const scopes = readScopes(args[1]);
    const result = await memory.listStoredEntries({ scopes, limit: 200 });
    if (!result.entries.length) {
      return `Local memory is empty for ${scopeLabel(scopes)}. Use /memory add [global|project] [kind] <topic> <note>.`;
    }
    return [
      `Memory entries (${String(result.entries.length)}; ${scopeLabel(scopes)}):`,
      ...result.entries.map(formatEntryLine),
      `Revisions: global=${String(result.revision.global)}, project=${String(result.revision.project)}`,
      "",
      memoryCommandUsage
    ].join("\n");
  }

  if (action === "show") {
    const parsed = readOptionalScope(args.slice(1));
    const selector = parsed.rest.join(" ").trim();
    if (!selector) return "Usage: /memory show [global|project] <id-or-topic>";
    const result = await memory.listStoredEntries({ scopes: [parsed.scope], limit: 500 });
    const entries = selectEntries(result.entries, selector);
    return entries.length
      ? entries.map(formatEntryDetail).join("\n\n")
      : `No ${parsed.scope} memory entry or topic named ${selector}.`;
  }

  if (action === "add") {
    const parsed = readOptionalScope(args.slice(1));
    const kind = isMemoryKind(parsed.rest[0])
      ? parsed.rest.shift() as MemoryKind
      : parsed.scope === "global" ? "preference" : "fact";
    const topic = parsed.rest.shift()?.trim();
    const note = parsed.rest.join(" ").trim();
    if (!topic || !note) return "Usage: /memory add [global|project] [kind] <topic> <note>";
    if (parsed.scope === "global" && kind !== "preference" && kind !== "working_style") {
      return "Global memory only accepts preference or working_style entries.";
    }
    const result = await mutateWithFreshRevision(memory, parsed.scope, async (expectedRevision) => await memory.writeScoped({
      scope: parsed.scope,
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
        userEvidence: parsed.scope === "global" ? note : undefined
      }
    }, { expectedRevision }));
    if (!result.written) return "Skipped: an equivalent note already exists or the note is too short.";
    return `Saved ${parsed.scope}/${kind} memory ${result.entry?.id ?? result.path ?? topic}.`;
  }

  if (action === "forget" || action === "delete") {
    const parsed = readOptionalScope(args.slice(1));
    const selector = parsed.rest.join(" ").trim();
    if (!selector) return "Usage: /memory forget [global|project] <id-or-topic>";
    const snapshot = await memory.listStoredEntries({ scopes: [parsed.scope], limit: 500 });
    const targets = selectEntries(snapshot.entries, selector);
    if (!targets.length) return `No ${parsed.scope} memory entry or topic named ${selector}.`;
    let deleted = 0;
    for (const target of targets) {
      const result = await mutateWithFreshRevision(memory, parsed.scope, async (expectedRevision) => (
        await memory.deleteStoredEntry(parsed.scope, target.id, { expectedRevision })
      ));
      if (result.deleted) deleted += 1;
    }
    return `Deleted ${String(deleted)} ${parsed.scope} memory ${deleted === 1 ? "entry" : "entries"}.`;
  }

  if (action === "search") {
    const scopes = readScopes(args[1]);
    const hasScope = isScopeSelector(args[1]);
    const query = args.slice(hasScope ? 2 : 1).join(" ").trim();
    if (!query) return "Usage: /memory search [global|project|all] <query>";
    const result = await memory.searchScoped(query, [], { scopes, limit: 8 });
    if (!result.matches.length) return `No memory matches for: ${query}`;
    return [
      `Memory matches for "${query}":`,
      ...result.matches.map((match) => `  [${match.entry.scope}/${match.entry.kind}/${match.topic}] ${match.entry.id} (score ${String(match.score)}) ${match.excerpt}`),
      `Included: global=${String(result.report.included.global)}, project=${String(result.report.included.project)}; trimmed: global=${String(result.report.trimmed.global)}, project=${String(result.report.trimmed.project)}; omitted=${String(result.report.omitted.length)}`
    ].join("\n");
  }

  if (action === "compact" || action === "consolidate") {
    const parsed = readOptionalScope(args.slice(1));
    const topic = parsed.rest.join(" ").trim() || undefined;
    const result = await mutateWithFreshRevision(memory, parsed.scope, async (expectedRevision) => (
      await memory.consolidateScope(parsed.scope, { expectedRevision, topic })
    ));
    if (result.error) return `Memory consolidation failed without changing data: ${result.error}`;
    return result.after < result.before
      ? `Consolidated ${parsed.scope} memory: ${String(result.before)} -> ${String(result.after)} entries.`
      : `${parsed.scope} memory has ${String(result.before)} entries; nothing to merge.`;
  }

  return memoryCommandUsage;
}

async function mutateWithFreshRevision<T>(
  memory: LocalMemory,
  scope: MemoryScope,
  mutation: (expectedRevision: number) => Promise<T>
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const overview = await memory.getOverview();
    try {
      return await mutation(overview.scopes[scope].revision);
    } catch (error) {
      if (!(error instanceof MemoryRevisionConflictError) || attempt === 2) throw error;
    }
  }
  throw new Error("Memory revision retry exhausted.");
}

function readOptionalScope(args: string[]): { scope: MemoryScope; rest: string[] } {
  const rest = [...args];
  const value = rest[0]?.toLowerCase();
  if (value === "global" || value === "project") {
    rest.shift();
    return { scope: value, rest };
  }
  return { scope: "project", rest };
}

function readScopes(value: string | undefined): MemoryScope[] {
  if (value === undefined || value.toLowerCase() === "all") return ["global", "project"];
  if (value.toLowerCase() === "global" || value.toLowerCase() === "project") return [value.toLowerCase() as MemoryScope];
  return ["global", "project"];
}

function isScopeSelector(value: string | undefined): boolean {
  const normalized = value?.toLowerCase();
  return normalized === "global" || normalized === "project" || normalized === "all";
}

function isMemoryKind(value: string | undefined): value is MemoryKind {
  return value !== undefined && memoryKinds.includes(value as MemoryKind);
}

function selectEntries(entries: MemoryEntry[], selector: string): MemoryEntry[] {
  const exact = entries.find((entry) => entry.id === selector);
  return exact ? [exact] : entries.filter((entry) => entry.topic === selector);
}

function formatEntryLine(entry: MemoryEntry): string {
  return `  [${entry.scope}/${entry.kind}] ${entry.id}  ${entry.topic}  ${entry.title}  importance=${String(entry.importance)}`;
}

function formatEntryDetail(entry: MemoryEntry): string {
  return [
    `${entry.id} [${entry.scope}/${entry.kind}] revision=${String(entry.revision)}`,
    `${entry.title} (${entry.topic}; importance=${String(entry.importance)})`,
    entry.summary,
    ...(entry.decisions.length ? [`Decisions: ${entry.decisions.join("; ")}`] : []),
    ...(entry.paths.length ? [`Paths: ${entry.paths.join(", ")}`] : []),
    `Updated: ${entry.updatedAt}`,
    `Sources: ${entry.lineage.map((lineage) => lineage.source).join(", ")}`
  ].join("\n");
}

function scopeLabel(scopes: MemoryScope[]): string {
  return scopes.length === 2 ? "global + project" : scopes[0] ?? "global + project";
}

function noteTitle(note: string): string {
  const firstLine = note.split("\n", 1)[0] ?? note;
  return firstLine.length <= 60 ? firstLine : `${firstLine.slice(0, 59)}…`;
}
