/**
 * TELOS 的持久化契约。
 *
 * TELOS 不是普通记忆条目：它表达用户明确认可的长期目标与原则；行为模式和偏差
 * 都是可撤销的推断投影，只能通过证据引用关联到任务，不保存完整对话正文。
 */

export type TelosScope = "universal" | "workspace";

export type TelosGoalStatus = "active" | "paused" | "completed";

export interface TelosGoal {
  id: string;
  text: string;
  status: TelosGoalStatus;
  horizon?: string;
}

export interface TelosRule {
  id: string;
  text: string;
}

export interface TelosDocument {
  version: 1;
  scope: TelosScope;
  workspaceId?: string;
  workspaceName?: string;
  revision: number;
  updatedAt: string;
  mission: string;
  goals: TelosGoal[];
  principles: TelosRule[];
  constraints: TelosRule[];
  antiGoals: TelosRule[];
}

export interface TelosDocumentInput {
  scope: TelosScope;
  mission: string;
  goals?: TelosGoal[];
  principles?: TelosRule[];
  constraints?: TelosRule[];
  antiGoals?: TelosRule[];
}

export interface TelosEvidence {
  id: string;
  summary: string;
  observedAt: string;
  sessionId?: string;
  turnId?: string;
  runId?: string;
  externalContext: boolean;
  workspaceId?: string;
  workspaceName?: string;
}

export interface PatternObservationInput {
  scope: TelosScope;
  summary: string;
  observedAt?: string;
  sessionId?: string;
  turnId?: string;
  runId?: string;
  externalContext: boolean;
}

export interface PatternObservation extends TelosEvidence {
  kind: "observation";
  revision: number;
}

export type BehaviorPatternStatus = "candidate" | "confirmed" | "rejected" | "expired";

export interface BehaviorPattern {
  id: string;
  scope: TelosScope;
  workspaceId?: string;
  workspaceName?: string;
  title: string;
  statement: string;
  status: BehaviorPatternStatus;
  confidence: number;
  evidenceCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
  evidence: TelosEvidence[];
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export type TelosDriftStatus = "open" | "snoozed" | "dismissed" | "resolved";
export type TelosDriftSuggestedAction = "adjust_telos" | "adjust_behavior";

export interface TelosDrift {
  id: string;
  scope: TelosScope;
  workspaceId?: string;
  workspaceName?: string;
  telosRevision: number;
  patternId: string;
  title: string;
  summary: string;
  status: TelosDriftStatus;
  suggestedAction: TelosDriftSuggestedAction;
  evidence: TelosEvidence[];
  createdAt: string;
  updatedAt: string;
  snoozedUntil?: string;
  resolvedAt?: string;
  revision: number;
}

export type BehaviorPatternReviewAction = "confirm" | "reject" | "expire";
export type TelosDriftResolutionAction = "adjust_telos" | "adjust_behavior" | "dismiss" | "resolve";

export interface TelosOverview {
  revision: number;
  universal?: TelosDocument;
  workspace?: TelosDocument;
  patterns: BehaviorPattern[];
  drifts: TelosDrift[];
  counts: {
    observations: number;
    candidatePatterns: number;
    confirmedPatterns: number;
    openDrifts: number;
  };
}
