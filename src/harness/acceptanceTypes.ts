/**
 * 独立验收 harness 使用的确定性条件类型。
 *
 * 这里只描述可由代码独立观测的条件与证据，不包含任务契约、Attempt 或 Durable Task 状态。
 */
export type AcceptanceCriterion =
  | {
    id: string;
    kind: "file_exists";
    path: string;
    description?: string;
  }
  | {
    id: string;
    kind: "workspace_changed";
    baselineDigest: string;
    description?: string;
  }
  | {
    id: string;
    kind: "command_succeeded";
    command: string;
    cwd?: string;
    timeoutMs?: number;
    description?: string;
  }
  | {
    id: string;
    kind: "http";
    url: string;
    expectedStatus?: number;
    timeoutMs?: number;
    description?: string;
  }
  | {
    id: string;
    kind: "tcp";
    host: string;
    port: number;
    timeoutMs?: number;
    description?: string;
  }
  | {
    id: string;
    kind: "managed_process";
    processId?: string;
    url?: string;
    cwd?: string;
    requireHttpReadiness?: boolean;
    description?: string;
  };

export interface AcceptanceEvidence {
  criterionId: string;
  passed: boolean;
  summary: string;
  observedAt: string;
  details?: Record<string, unknown>;
}
