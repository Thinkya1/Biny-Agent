import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deriveAgentVerificationPlan,
  verifyAgentRun
} from "../src/agent/verification.js";
import {
  createControlledAcceptanceCommandExecutor,
  type AcceptanceCommandAuditEvent,
  type AcceptanceCommandExecutor
} from "../src/harness/AcceptanceCommandExecutor.js";
import { AcceptanceVerifier } from "../src/harness/AcceptanceVerifier.js";
import type { AcceptanceCriterion } from "../src/harness/acceptanceTypes.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import {
  captureWorkspaceState,
  diffWorkspaceStates,
  workspaceStateDigest
} from "../src/harness/WorkspaceState.js";

await testCriteriaVerificationDoesNotRequireAgentCompletion();
await testCriteriaVerificationSupportsCancellation();
await testDeterministicTaskCannotPassWithoutCriteria();
await testWorkspaceChangeUsesTaskBaseline();
await testWorkspaceSnapshotReportsChangedFiles();
await testVerificationPlanUsesFactsInsteadOfInputKeywords();
await testAgentRunVerificationExecutesStructuredChecksAndProcesses();
await testLaunchProcessRequiresHttpReadiness();
await testVerifierSelectsReadyManagedProcess();
await testVerifierExecutesCommandsIndependently();
await testCommandCriterionRequiresControlledExecutor();
await testAutoDiscoveredCheckCannotBypassDefaultAsk();
await testWorkspaceChangeDoesNotAutoVerify();
await testControlledExecutorUsesApprovalSandboxAndAudit();
await testLongCommandOutputKeepsBoundedSummaryAndFullAudit();

async function testCriteriaVerificationDoesNotRequireAgentCompletion(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-criteria-"));
  try {
    const verifier = new AcceptanceVerifier({
      workspaceRoot: root,
      commandExecutor: trustedCommandExecutor(root)
    });
    const result = await verifier.verifyCriteria([{
      id: "independent-command",
      kind: "command_succeeded",
      command: "node -e \"process.exit(0)\""
    }], { requireCriteria: true });
    assert.equal(result.passed, true, result.summary);
    assert.equal(result.evidence[0]?.details?.execution, "independent_verifier");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testCriteriaVerificationSupportsCancellation(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-cancel-"));
  try {
    const controller = new AbortController();
    controller.abort(new Error("verification cancelled"));
    const verifier = new AcceptanceVerifier({ workspaceRoot: root });
    await assert.rejects(verifier.verifyCriteria([{
      id: "must-not-run",
      kind: "command_succeeded",
      command: "node -e \"setTimeout(() => process.exit(0), 10000)\""
    }], { signal: controller.signal }), /verification cancelled/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testVerifierSelectsReadyManagedProcess(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-ready-process-"));
  try {
    const verifier = new AcceptanceVerifier({
      workspaceRoot: root,
      commandExecutor: trustedCommandExecutor(root),
      managedProcesses: {
        listProcesses: () => [
          { processId: "failed-first", state: "running", cwd: root, readiness: { type: "log", passed: false } },
          { processId: "ready-second", state: "running", cwd: root, readiness: { type: "log", passed: true } }
        ]
      }
    });
    const result = await verifier.verifyCriteria([
      { id: "service", kind: "managed_process", cwd: "." }
    ]);
    assert.equal(result.passed, true, result.summary);
    assert.equal(result.evidence[0]?.details?.processId, "ready-second");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testWorkspaceSnapshotReportsChangedFiles(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-workspace-diff-"));
  try {
    await fs.writeFile(path.join(root, "modified.ts"), "before\n");
    await fs.writeFile(path.join(root, "deleted.ts"), "delete me\n");
    const before = await captureWorkspaceState(root);
    await fs.writeFile(path.join(root, "modified.ts"), "after\n");
    await fs.rm(path.join(root, "deleted.ts"));
    await fs.writeFile(path.join(root, "added.ts"), "added\n");
    const after = await captureWorkspaceState(root);
    const diff = diffWorkspaceStates(before, after);
    assert.deepEqual(diff.addedFiles, ["added.ts"]);
    assert.deepEqual(diff.modifiedFiles, ["modified.ts"]);
    assert.deepEqual(diff.deletedFiles, ["deleted.ts"]);
    assert.deepEqual(diff.changedFiles, ["added.ts", "deleted.ts", "modified.ts"]);
    assert.notEqual(diff.beforeDigest, diff.afterDigest);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testVerificationPlanUsesFactsInsteadOfInputKeywords(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verification-plan-"));
  try {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        build: "node build.js",
        test: "node test.js",
        typecheck: "tsc --noEmit",
        lint: "eslint ."
      }
    }));
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await fs.mkdir(path.join(root, "backend"));
    await fs.writeFile(path.join(root, "backend", "pom.xml"), "<project/>\n");
    await fs.writeFile(path.join(root, "backend", "mvnw"), "#!/bin/sh\n");

    const plan = await deriveAgentVerificationPlan(root, {
      changedFiles: ["src/feature.ts"],
      checks: [{
        id: "explicit-check",
        command: "node explicit-check.js",
        cwd: "."
      }],
      startedProcesses: [{
        processId: "process-123",
        cwd: ".",
        readinessType: "http",
        url: "http://127.0.0.1:32123/health"
      }]
    });
    const commands = plan.criteria.flatMap((criterion) =>
      criterion.kind === "command_succeeded" ? [criterion.command] : []
    );
    assert.equal(plan.required, true);
    assert.equal(commands.includes("node explicit-check.js"), true);
    assert.equal(commands.includes("pnpm run build"), false);
    assert.equal(commands.includes("pnpm run test"), false);
    assert.equal(commands.includes("pnpm run typecheck"), false);
    assert.equal(commands.includes("pnpm run lint"), false);
    assert.equal(commands.includes("./mvnw test"), false);
    assert.equal(plan.criteria.some((criterion) => criterion.kind === "managed_process"), false);

    const noFacts = await deriveAgentVerificationPlan(root, {
      changedFiles: [],
      checks: [],
      startedProcesses: []
    });
    assert.equal(noFacts.required, false);
    assert.deepEqual(noFacts.criteria, []);

    const explicitlyRequired = await deriveAgentVerificationPlan(root, {
      changedFiles: [],
      userRequestedVerification: true,
      checks: [],
      startedProcesses: []
    });
    assert.equal(explicitlyRequired.required, true);
    assert.equal(explicitlyRequired.reasons.includes("user_requested_verification"), true);
    assert.equal(explicitlyRequired.criteria.length > 0, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testAgentRunVerificationExecutesStructuredChecksAndProcesses(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-agent-verification-"));
  try {
    const processId = "process-verified";
    const result = await verifyAgentRun({
      workspaceRoot: root,
      commandExecutor: trustedCommandExecutor(root),
      facts: {
        changedFiles: [],
        userRequestedVerification: true,
        checks: [{
          id: "structured-command",
          command: "node -e \"process.exit(0)\""
        }],
        startedProcesses: [{ processId, readinessType: "log" }]
      },
      managedProcesses: {
        listProcesses: () => [{
          processId,
          state: "running",
          readiness: { type: "log", passed: true }
        }]
      }
    });
    assert.equal(result.plan.required, true);
    assert.equal(result.verification?.passed, true, result.verification?.summary);
    assert.equal(result.verification?.evidence.length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testLaunchProcessRequiresHttpReadiness(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-http-process-"));
  try {
    const verifier = new AcceptanceVerifier({
      workspaceRoot: root,
      commandExecutor: trustedCommandExecutor(root),
      managedProcesses: {
        listProcesses: () => [{
          processId: "process-log-only",
          state: "running",
          readiness: { type: "log", passed: true }
        }]
      }
    });
    const result = await verifier.verifyCriteria([{
      id: "service",
      kind: "managed_process",
      processId: "process-log-only",
      requireHttpReadiness: true
    }]);
    assert.equal(result.passed, false);
    assert.match(result.summary, /required HTTP readiness/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testCommandCriterionRequiresControlledExecutor(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-controlled-required-"));
  try {
    const marker = path.join(root, "must-not-exist.txt");
    const verifier = new AcceptanceVerifier({ workspaceRoot: root });
    const result = await verifier.verifyCriteria([{
      id: "unsafe-without-executor",
      kind: "command_succeeded",
      command: `node -e ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unsafe")`)}`
    }], { requireCriteria: true });

    assert.equal(result.passed, false);
    assert.match(result.summary, /controlled command executor is required/u);
    await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testAutoDiscoveredCheckCannotBypassDefaultAsk(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-auto-approval-"));
  try {
    const marker = path.join(root, "auto-check-ran.txt");
    const audit: AcceptanceCommandAuditEvent[] = [];
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        test: `node -e ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`)}`
      }
    }));
    const result = await verifyAgentRun({
      workspaceRoot: root,
      facts: {
        changedFiles: ["src/changed.ts"],
        userRequestedVerification: true,
        checks: [],
        startedProcesses: []
      },
      commandExecutor: createControlledAcceptanceCommandExecutor({
        workspaceRoot: root,
        sandbox: { mode: "off", allowNetwork: true },
        permissionManager: new PermissionManager({
          mode: "ask",
          allowTools: [],
          denyPaths: []
        }),
        sessionId: "verification-test",
        onAuditEvent: (event) => {
          audit.push(event);
        }
      })
    });

    assert.equal(result.plan.required, true);
    assert.equal(result.verification?.passed, false);
    assert.match(result.verification?.summary ?? "", /requires explicit approval/u);
    assert.equal(
      audit.find((event) => event.type === "command.failed")?.failureKind,
      "permission_required"
    );
    await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testWorkspaceChangeDoesNotAutoVerify(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-no-auto-"));
  try {
    const marker = path.join(root, "must-not-run.txt");
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        test: `node -e ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`)}`
      }
    }));
    const result = await verifyAgentRun({
      workspaceRoot: root,
      facts: {
        changedFiles: ["src/changed.ts"],
        checks: [],
        startedProcesses: []
      }
    });
    assert.equal(result.plan.required, false);
    assert.equal(result.verification, undefined);
    await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testControlledExecutorUsesApprovalSandboxAndAudit(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-controlled-executor-"));
  try {
    const prompts: string[] = [];
    const audit: AcceptanceCommandAuditEvent[] = [];
    const verifier = new AcceptanceVerifier({
      workspaceRoot: root,
      commandExecutor: createControlledAcceptanceCommandExecutor({
        workspaceRoot: root,
        sandbox: { mode: "workspace-write", allowNetwork: false },
        permissionManager: new PermissionManager({
          mode: "ask",
          allowTools: [],
          denyPaths: []
        }),
        sessionId: "verification-test",
        confirmPermission: async (request) => {
          prompts.push(request.command ?? "");
          return {
            approved: true,
            scope: "once",
            confirmation: "yes"
          };
        },
        onAuditEvent: (event) => {
          audit.push(event);
        }
      })
    });
    const result = await verifier.verifyCriteria([{
      id: "approved-check",
      kind: "command_succeeded",
      command: "node -e \"process.exit(0)\""
    }], { requireCriteria: true });

    assert.equal(result.passed, true, result.summary);
    assert.deepEqual(prompts, ["node -e \"process.exit(0)\""]);
    assert.deepEqual(audit.map((event) => event.type), [
      "command.started",
      "command.completed"
    ]);
    assert.notEqual(result.evidence[0]?.details?.sandbox, "off");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testDeterministicTaskCannotPassWithoutCriteria(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-empty-deterministic-"));
  try {
    const verifier = new AcceptanceVerifier({ workspaceRoot: root });
    const result = await verifier.verifyCriteria([], { requireCriteria: true });
    assert.equal(result.passed, false);
    assert.match(result.summary, /no executable acceptance criteria/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testWorkspaceChangeUsesTaskBaseline(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-workspace-state-"));
  try {
    await fs.writeFile(path.join(root, "source.txt"), "before\n");
    const baselineDigest = await workspaceStateDigest(root);
    const verifier = new AcceptanceVerifier({ workspaceRoot: root });
    const unchanged = await verifier.verifyCriteria([
      { id: "workspace", kind: "workspace_changed", baselineDigest }
    ]);
    assert.equal(unchanged.passed, false);

    await fs.writeFile(path.join(root, "source.txt"), "after\n");
    const changed = await verifier.verifyCriteria([
      { id: "workspace", kind: "workspace_changed", baselineDigest }
    ]);
    assert.equal(changed.passed, true, changed.summary);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testVerifierExecutesCommandsIndependently(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-evidence-"));
  const originalFetch = globalThis.fetch;
  try {
    await fs.writeFile(path.join(root, "package.json"), "{}\n");
    const url = "http://127.0.0.1:43210/ready";
    globalThis.fetch = (async (input): Promise<Response> => {
      assert.equal(String(input), url);
      return new Response("{\"ok\":true}", {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    const criteria: AcceptanceCriterion[] = [
        { id: "manifest", kind: "file_exists", path: "package.json" },
        { id: "build", kind: "command_succeeded", command: "node -e \"process.exit(0)\"" },
        { id: "http", kind: "http", url },
        { id: "process", kind: "managed_process", processId: "process-1", requireHttpReadiness: true }
      ];
    const verifier = new AcceptanceVerifier({
      workspaceRoot: root,
      commandExecutor: trustedCommandExecutor(root),
      managedProcesses: {
        listProcesses: () => [{ processId: "process-1", state: "running", url, readiness: { type: "http", passed: true } }]
      }
    });
    const result = await verifier.verifyCriteria(criteria);
    assert.equal(result.passed, true, result.summary);
    assert.equal(result.evidence.length, 4);
    assert.equal(result.evidence.find((evidence) => evidence.criterionId === "build")?.details?.execution, "independent_verifier");

    const independentFailure = await verifier.verifyCriteria([
      { id: "build", kind: "command_succeeded", command: "node -e \"process.exit(5)\"" }
    ]);
    assert.equal(independentFailure.passed, false);
    assert.match(independentFailure.summary, /independent verifier run/u);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testLongCommandOutputKeepsBoundedSummaryAndFullAudit(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-output-summary-"));
  try {
    const audit: AcceptanceCommandAuditEvent[] = [];
    const verifier = new AcceptanceVerifier({
      workspaceRoot: root,
      commandExecutor: createControlledAcceptanceCommandExecutor({
        workspaceRoot: root,
        sandbox: { mode: "off", allowNetwork: true },
        permissionManager: new PermissionManager({
          mode: "full-access",
          allowTools: [],
          denyPaths: []
        }),
        sessionId: "verification-output-test",
        onAuditEvent: (event) => {
          audit.push(event);
        }
      })
    });
    const result = await verifier.verifyCriteria([{
      id: "large-output",
      kind: "command_succeeded",
      command: "node -e \"process.stdout.write('x'.repeat(6000))\""
    }], { requireCriteria: true });
    const details = result.evidence[0]?.details;
    assert.equal(result.passed, true, result.summary);
    assert.equal(details?.stdoutTruncated, true);
    assert.equal(details?.stdoutChars, 6_000);
    assert.ok(String(details?.stdout ?? "").length <= 4_000);
    const completed = audit.find((event) => event.type === "command.completed");
    assert.equal(completed?.result.stdout.length, 6_000);
    assert.equal(details?.fullEvidenceToolCallId, completed?.toolCallId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function trustedCommandExecutor(workspaceRoot: string): AcceptanceCommandExecutor {
  return createControlledAcceptanceCommandExecutor({
    workspaceRoot,
    sandbox: { mode: "off", allowNetwork: true },
    permissionManager: new PermissionManager({
      mode: "full-access",
      allowTools: [],
      denyPaths: []
    }),
    sessionId: "acceptance-verifier-test"
  });
}
