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

export type MemoryEntryInput = StoredMemoryEntryInput;
export type MemoryEntry = StoredMemoryEntry;
export type MemoryCandidateInput = StoredMemoryCandidateInput;
export type MemoryCandidate = StoredMemoryCandidate;
export type MemoryOverview = StoredMemoryOverview;
export type MemoryEntriesResult = StoredMemoryEntriesResult;
export type MemoryClearResult = StoredMemoryClearResult;
export type MemoryConsolidationResult = StoredMemoryConsolidationResult;
export type MemoryRecallOmission = StoredMemoryRecallOmission;
export type MemoryRecallReport = StoredMemoryRecallReport;
export type MemoryMatch = StoredMemoryMatch;
export type MemorySearchResult = StoredMemorySearchResult;
export type MemoryWriteResult = StoredMemoryWriteResult;
export type MemoryCandidateMutationResult = StoredMemoryCandidateMutationResult;
