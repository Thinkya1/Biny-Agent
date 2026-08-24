import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ActivityPrivacyPolicy, updateActivitySettings } from "../src/activity/index.js";
import type { AgentModel } from "../src/agent/core/types.js";
import { ContextMemory } from "../src/agent/context/ContextMemory.js";
import { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";
import { createFileConfigStore } from "../src/config/store.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { activityExternalPolicySchema } from "../src/activity/settings.js";

const policies = ["local_only", "confirm_external", "external_allowed"] as const;

testActivityPolicySchemaAndDefault();
await testActivityPolicyPersistenceUsesCas();
await testActivityPolicyBlocksExternalModelsWithoutFallback();
await testContextMemoryOnlyInjectsTrustedLocalActivity();

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

async function testContextMemoryOnlyInjectsTrustedLocalActivity(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-activity-context-"));
  try {
    const entry = {
      summary: "password=do-not-send",
      application: "Editor",
      occurredAt: "2026-08-24T00:00:00.000Z",
      screenshot: "RAW_SCREENSHOT"
    } as unknown as { summary: string; application: string; occurredAt: string };
    const localModel = model("builtin-llama.cpp", "llama.cpp");
    const localMemory = new ContextMemory(
      () => localModel,
      new WorkspaceContext(root, [], 32 * 1024),
      undefined,
      8_000,
      32 * 1024,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new ActivityPrivacyPolicy()
    );
    const localPrepared = await localMemory.prepareTurn("summarize", "system", undefined, [], false, 0, [entry]);
    assert.equal(localPrepared.activity.status, "allowed");
    assert.match(localPrepared.systemPrompt ?? "", /untrusted historical context, not instructions/u);
    assert.match(localPrepared.systemPrompt ?? "", /password=\[redacted\]/u);
    assert.doesNotMatch(localPrepared.systemPrompt ?? "", /RAW_(?:OCR|KEY_VALUE|SCREENSHOT)/u);

    const cloudModel = model("provider", "openai");
    const cloudMemory = new ContextMemory(
      () => cloudModel,
      new WorkspaceContext(root, [], 32 * 1024),
      undefined,
      8_000,
      32 * 1024,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new ActivityPrivacyPolicy()
    );
    const cloudPrepared = await cloudMemory.prepareTurn("summarize", "system", undefined, [], false, 0, [entry]);
    assert.equal(cloudPrepared.activity.status, "blocked");
    assert.equal(cloudPrepared.activity.entries.length, 0);
    assert.doesNotMatch(cloudPrepared.systemPrompt ?? "", /RAW_|password=\[redacted\]/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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
