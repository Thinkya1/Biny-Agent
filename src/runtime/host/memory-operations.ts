/**
 * Runtime Host Memory 协议操作。
 *
 * socket Server 只负责决定是否进入独占 lane；Memory 的 selector、CAS 和派生索引副作用在这里
 * 统一落到 AgentSession，避免协议路由层直接拼装领域读写细节。
 */
import type { CommandRuntime } from "../CommandRuntime.js";
import {
  optionalSafeInteger,
  optionalString,
  readMemoryEntryInput,
  readMemoryEntryPatch,
  readMemoryOriginSelector,
  readStringArray,
  requiredInteger,
  requiredString
} from "./validation.js";

export interface RuntimeHostMemoryOperationContext {
  getCommands(): CommandRuntime;
  scheduleEmbeddingRebuild(): void;
}

export async function executeRuntimeHostMemoryOperation(
  context: RuntimeHostMemoryOperationContext,
  payload: Record<string, unknown>
): Promise<unknown> {
  const commands = context.getCommands();
  const memory = commands.agent.getLocalMemory();
  const action = requiredString(payload.action, "action");
  if (action === "overview-v3") {
    const selector = readMemoryOriginSelector(payload.selector, true);
    // 各读取来自独立原子快照；允许它们跨越一次写入，避免为 UI 读请求占用 Runtime。
    const [overview, entries, allEntries, maintenance] = await Promise.all([
      memory.getOverview(),
      memory.listMemoryEntries({ origins: [selector] }),
      memory.listMemoryEntries({ origins: ["all"] }),
      memory.loadMaintenanceStatus()
    ]);
    return { overview, entries, allEntries, maintenance };
  }
  if (action === "list-v3") {
    return await memory.listMemoryEntries({
      origins: [readMemoryOriginSelector(payload.selector, true)],
      topic: optionalString(payload.topic),
      limit: optionalSafeInteger(payload.limit),
      offset: optionalSafeInteger(payload.offset)
    });
  }
  if (action === "search-v3") {
    return await commands.agent.searchMemory(
      requiredString(payload.query, "query"),
      payload.paths === undefined ? [] : readStringArray(payload.paths, "paths"),
      {
        origins: [readMemoryOriginSelector(payload.selector, true)],
        limit: optionalSafeInteger(payload.limit),
        maxChars: optionalSafeInteger(payload.maxChars)
      }
    );
  }
  if (action === "write-v3") {
    const result = await memory.writeEntry(readMemoryEntryInput(payload.entry), {
      expectedRevision: requiredInteger(payload.expectedRevision, "expectedRevision")
    });
    if (result.written && result.entry) await commands.agent.indexMemoryEntry(result.entry);
    return result;
  }
  if (action === "update-v3") {
    const result = await memory.updateEntry(
      requiredString(payload.id, "id"),
      readMemoryEntryPatch(payload.patch),
      { expectedRevision: requiredInteger(payload.expectedRevision, "expectedRevision") }
    );
    if (result.written && result.entry) await commands.agent.indexMemoryEntry(result.entry);
    return result;
  }
  if (action === "delete-v3") {
    const id = requiredString(payload.id, "id");
    const result = await memory.deleteEntryById(
      id,
      { expectedRevision: requiredInteger(payload.expectedRevision, "expectedRevision") }
    );
    if (result.deleted) commands.agent.removeMemoryEmbeddingEntries([id]);
    return result;
  }
  if (action === "clear-v3") {
    const selector = readMemoryOriginSelector(payload.selector, true);
    const clearedIds = (await memory.listMemoryEntries({ origins: [selector] })).entries.map(({ id }) => id);
    const result = await memory.clearEntries(selector, {
      expectedRevision: requiredInteger(payload.expectedRevision, "expectedRevision")
    });
    if (result.deletedEntries) commands.agent.removeMemoryEmbeddingEntries(clearedIds);
    return result;
  }
  if (action === "consolidate-v3") {
    const selector = readMemoryOriginSelector(payload.selector, true);
    const expectedRevision = requiredInteger(payload.expectedRevision, "expectedRevision");
    const result = await memory.consolidateEntries(selector, {
      expectedRevision,
      topic: optionalString(payload.topic)
    });
    if (result.revision !== expectedRevision) context.scheduleEmbeddingRebuild();
    return result;
  }
  throw new Error(`Unknown memory operation: ${action}`);
}
