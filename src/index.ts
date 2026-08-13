/** Biny 的公共 AI 类型；Agent Loop 与运行时服务保持为内部实现。 */
import type {
  MemoryCandidate as StoredMemoryCandidate,
  MemoryCandidateInput as StoredMemoryCandidateInput,
  MemoryCandidateMutationResult as StoredMemoryCandidateMutationResult,
  MemoryClearResult as StoredMemoryClearResult,
  MemoryConsolidationResult as StoredMemoryConsolidationResult,
  MemoryEntriesResult as StoredMemoryEntriesResult,
  MemoryEntry as StoredMemoryEntry,
  MemoryEntryInput as StoredMemoryEntryInput,
  MemoryMatch as StoredMemoryMatch,
  MemoryOverview as StoredMemoryOverview,
  MemoryRecallOmission as StoredMemoryRecallOmission,
  MemoryRecallReport as StoredMemoryRecallReport,
  MemorySearchResult as StoredMemorySearchResult,
  ScopedMemoryWriteResult as StoredMemoryWriteResult
} from "./agent/context/memoryTypes.js";

export * from "./ai/index.js";
export type { AgentTurnOutcome, AgentTurnStatus, AgentTurnStopReason } from "./agent/types.js";
export type {
  AgentPersonalizationState,
  ChatPersonalizationOverride,
  ChatPersonalizationOverridePatch,
  GlobalPersonalizationUpdate,
  MemoryPolicy,
  PersonalizationMetadata,
  PersonalizationSettings,
  PersonalityPreset,
  ResolvedChatPersonalization
} from "./personalization/index.js";
export type {
  MemoryAudience,
  MemoryDeleteResult,
  MemoryEntryPatch,
  MemoryKind,
  MemoryLineage,
  MemoryOrigin,
  MemoryOriginCounts,
  MemoryOriginSelector,
} from "./agent/context/memoryTypes.js";

/** 包根只暴露来源感知的 v3 结构；旧 scope 字段留在迁移实现内部。 */
export type MemoryEntryInput = Omit<StoredMemoryEntryInput, "scope">;
export type MemoryEntry = Omit<StoredMemoryEntry, "scope">;
export type MemoryCandidateInput = Omit<StoredMemoryCandidateInput, "scopeHint">;
export type MemoryCandidate = Omit<StoredMemoryCandidate, "scopeHint">;
export type MemoryOverview = Omit<StoredMemoryOverview, "scopes" | "revision">;
export type MemoryEntriesResult = Omit<StoredMemoryEntriesResult, "entries" | "revision"> & {
  entries: MemoryEntry[];
};
export type MemoryClearResult = Omit<StoredMemoryClearResult, "scope">;
export type MemoryConsolidationResult = Omit<StoredMemoryConsolidationResult, "scope">;
export type MemoryRecallOmission = Omit<StoredMemoryRecallOmission, "scope">;
export type MemoryRecallReport = Omit<StoredMemoryRecallReport, "included" | "trimmed" | "omitted"> & {
  omitted: MemoryRecallOmission[];
};
export type MemoryMatch = Omit<StoredMemoryMatch, "entry"> & { entry: MemoryEntry };
export type MemorySearchResult = Omit<StoredMemorySearchResult, "matches" | "revision" | "report"> & {
  matches: MemoryMatch[];
  report: MemoryRecallReport;
};
export type MemoryWriteResult = Omit<StoredMemoryWriteResult, "entry"> & { entry?: MemoryEntry };
export type MemoryCandidateMutationResult = Omit<StoredMemoryCandidateMutationResult, "candidate"> & {
  candidate?: MemoryCandidate;
};
