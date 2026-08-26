import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ActivityPrivacyPolicy, updateActivitySettings } from "../src/activity/index.js";
import type { AgentModel } from "../src/agent/core/types.js";
import { createFileConfigStore } from "../src/config/store.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import {
  activityAnalysisPolicySchema,
  activityExternalPolicySchema,
  defaultActivitySettings
} from "../src/activity/settings.js";

const policies = ["local_only", "confirm_external", "external_allowed"] as const;

testActivityPolicySchemaAndDefault();
testAnalysisPolicySchemaAndDefault();
await testActivityPolicyPersistenceUsesCas();
await testActivityPolicyBlocksExternalModelsWithoutFallback();
await testAnalysisPolicyGatesExternalModels();

function testActivityPolicySchemaAndDefault(): void {
  for (const externalPolicy of policies) {
    assert.equal(activityExternalPolicySchema.parse(externalPolicy), externalPolicy);
    const parsed = configSchema.parse({
      ...defaultConfig,
      activity: { externalPolicy }
    });
    assert.equal(parsed.activity.externalPolicy, externalPolicy);
  }

  const legacy = structuredClone(defaultConfig) as unknown as Record<string, unknown>;
  delete legacy.activity;
  assert.equal(configSchema.parse(legacy).activity.externalPolicy, "local_only");
  assert.throws(() => activityExternalPolicySchema.parse("cloud_by_default"), /Invalid enum value/u);
}

async function testActivityPolicyPersistenceUsesCas(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-activity-policy-"));
  const workspace = path.join(root, "workspace");
  const globalRoot = path.join(root, "global");
  await fs.mkdir(workspace);
  const store = createFileConfigStore(workspace, { globalDir: globalRoot, credentialStore: memoryCredentialStore() });
  try {
    for (const externalPolicy of policies) {
      const current = await store.loadVersioned!();
      const saved = await store.saveVersioned!({
        ...current.config,
        activity: { externalPolicy }
      }, current.revision);
      assert.equal(saved.config.activity.externalPolicy, externalPolicy);
      assert.equal((await store.load()).activity.externalPolicy, externalPolicy);
      const persisted = JSON.parse(await fs.readFile(path.join(globalRoot, "config.json"), "utf8")) as { activity?: { externalPolicy?: string } };
      assert.equal(persisted.activity?.externalPolicy, externalPolicy);
    }

    const before = await store.load();
    const updated = await updateActivitySettings(store, workspace, (current) => ({
      ...current,
      externalPolicy: "confirm_external"
    }));
    const after = await store.load();
    assert.equal(updated.externalPolicy, "confirm_external");
    assert.equal(after.activity.externalPolicy, "confirm_external");
    assert.equal(after.permission.mode, before.permission.mode);
    assert.equal(after.defaultModel, before.defaultModel);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testActivityPolicyBlocksExternalModelsWithoutFallback(): Promise<void> {
  const local = model("builtin-llama.cpp", "llama.cpp");
  const cloud = model("provider", "openai", "local", "http://127.0.0.1:11434/v1");

  for (const externalPolicy of policies) {
    const policy = new ActivityPrivacyPolicy({ externalPolicy });
    assert.equal(policy.canUseWithModel(local), true);
    assert.equal(policy.canUseWithModel(cloud), false);
    assert.equal(policy.evaluate(local).unsupportedPolicy, externalPolicy !== "local_only");
    if (externalPolicy !== "local_only") {
      assert.match(policy.evaluate(local).message, /当前版本暂不支持/u);
    }

    let operationCalled = false;
    const result = await policy.run(cloud, () => {
      operationCalled = true;
      return "must-not-run";
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.value, undefined);
    assert.equal(result.fallbackAttempted, false);
    assert.equal(result.decision.policy, externalPolicy);
    assert.match(result.decision.message, /阻止/u);
    assert.equal(operationCalled, false);
  }

  const localOnly = new ActivityPrivacyPolicy();
  const fakeLocalUrl = model("provider", "llama.cpp", "local", "file:///tmp/model.gguf");
  assert.equal(localOnly.canUseWithModel(fakeLocalUrl), false, "provider name and URL must not infer local trust");
}

function testAnalysisPolicySchemaAndDefault(): void {
  for (const analysisPolicy of policies) {
    assert.equal(activityAnalysisPolicySchema.parse(analysisPolicy), analysisPolicy);
    const parsed = configSchema.parse({
      ...defaultConfig,
      activity: { analysisPolicy }
    });
    assert.equal(parsed.activity.analysisPolicy, analysisPolicy);
  }

  // 分析维度默认 confirm_external 且未确认：外部模型分析默认不放行，与回忆维度（local_only）相互独立。
  assert.equal(defaultActivitySettings.analysisPolicy, "confirm_external");
  assert.equal(defaultActivitySettings.analysisExternalConfirmed, false);
  const legacy = structuredClone(defaultConfig) as unknown as Record<string, unknown>;
  delete legacy.activity;
  assert.equal(configSchema.parse(legacy).activity.analysisPolicy, "confirm_external");
  assert.throws(() => activityAnalysisPolicySchema.parse("cloud_by_default"), /Invalid enum value/u);
}

async function testAnalysisPolicyGatesExternalModels(): Promise<void> {
  const local = model("builtin-llama.cpp", "llama.cpp");
  const cloud = model("provider", "openai");

  // 受信任的本地模型在任何分析策略下都放行。
  for (const analysisPolicy of policies) {
    const decision = new ActivityPrivacyPolicy({ analysisPolicy }).evaluateAnalysis(local);
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, "trusted_local_model");
    assert.equal(decision.trustedLocalModel, true);
  }

  // external_allowed：明确允许把脱敏摘要送到外部模型。
  const allowed = new ActivityPrivacyPolicy({ analysisPolicy: "external_allowed" }).evaluateAnalysis(cloud);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, "external_allowed");

  // confirm_external：未确认拦截、确认后放行。
  const pending = new ActivityPrivacyPolicy({ analysisPolicy: "confirm_external", analysisExternalConfirmed: false });
  assert.equal(pending.evaluateAnalysis(cloud).allowed, false);
  assert.equal(pending.evaluateAnalysis(cloud).reason, "external_needs_confirmation");
  const confirmed = new ActivityPrivacyPolicy({ analysisPolicy: "confirm_external", analysisExternalConfirmed: true });
  assert.equal(confirmed.evaluateAnalysis(cloud).allowed, true);
  assert.equal(confirmed.evaluateAnalysis(cloud).reason, "external_confirmed");

  // local_only + 外部模型：拦截，且 runAnalysis 绝不执行回调（不降级到备用模型）。
  const localOnly = new ActivityPrivacyPolicy({ analysisPolicy: "local_only" });
  const blocked = localOnly.evaluateAnalysis(cloud);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "external_blocked");
  let operationCalled = false;
  const run = await localOnly.runAnalysis(cloud, () => {
    operationCalled = true;
    return "must-not-run";
  });
  assert.equal(run.status, "blocked");
  assert.equal(run.value, undefined);
  assert.equal(operationCalled, false);
}

function model(
  runtime: "builtin-llama.cpp" | "provider",
  provider: string,
  dataResidency?: "local" | "external",
  _endpoint?: string
): AgentModel {
  return {
    provider,
    modelId: "activity-test-model",
    runtime,
    dataResidency,
    stream: async () => (async function* () {
      yield { type: "finish", reason: "stop" };
    })()
  };
}

function memoryCredentialStore() {
  return {
    persistent: false,
    get: async () => undefined,
    set: async () => undefined,
    delete: async () => undefined
  };
}
