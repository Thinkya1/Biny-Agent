import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, loadConfigFile, saveConfig, saveConfigFile } from "../src/config/loader.js";
import { BINY_AGENT_DIR_ENV, globalAgentDir, globalConfigPath, projectMemoryDir, projectSessionsDir } from "../src/config/paths.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { BINY_KEYCHAIN_SERVICE, MacKeychainCredentialStore } from "../src/config/credentials.js";
import { resolveRunBudget } from "../src/agent/runBudget.js";
import { createFileConfigStore } from "../src/config/store.js";
import { ConfigRevisionConflictError } from "../src/config/versioned.js";
import type { CredentialStore } from "../src/config/credentials.js";

await testGlobalPathResolution();
testRunBudget();
testRemovedModelFormatsRequireManualUpdate();
await testProjectOverridesAndGlobalPersistence();
await testRemovedProjectBudgetFieldsAreRejected();
await testProjectCredentialFieldsAreRejected();
await testProjectModelAliasMustBeGlobal();
await testLegacyProjectConfigIsIgnored();
await testVersionedGlobalConfigRejectsStaleWriters();
await testMacKeychainCredentialStore();

async function testGlobalPathResolution(): Promise<void> {
  const configured = path.join(os.tmpdir(), `biny-agent-${String(process.pid)}`);
  assert.equal(globalAgentDir({ env: { [BINY_AGENT_DIR_ENV]: configured }, homeDir: "/unused" }), configured);
  assert.equal(globalConfigPath({ env: { [BINY_AGENT_DIR_ENV]: configured }, homeDir: "/unused" }), path.join(configured, "config.json"));
  assert.equal(globalAgentDir({ env: {}, homeDir: "/tmp/biny-home" }), "/tmp/biny-home/.biny/agent");
  assert.equal(globalConfigPath({ env: {}, homeDir: "/tmp/biny-home" }), "/tmp/biny-home/.biny/config.json");
  const projectA = projectSessionsDir("/tmp/project-a", { env: { [BINY_AGENT_DIR_ENV]: configured } });
  const projectB = projectSessionsDir("/tmp/project-b", { env: { [BINY_AGENT_DIR_ENV]: configured } });
  assert.equal(path.dirname(projectA), path.join(configured, "sessions"));
  assert.notEqual(projectA, projectB);
  assert.equal(projectSessionsDir("/tmp/project-a", { env: { [BINY_AGENT_DIR_ENV]: configured } }), projectA);
  const memoryA = projectMemoryDir("/tmp/project-a", { env: { [BINY_AGENT_DIR_ENV]: configured } });
  assert.equal(path.dirname(memoryA), path.join(configured, "memory"));
  assert.equal(path.basename(memoryA), path.basename(projectA));
  assert.notEqual(memoryA, projectMemoryDir("/tmp/project-b", { env: { [BINY_AGENT_DIR_ENV]: configured } }));
}

function testRunBudget(): void {
  assert.deepEqual(resolveRunBudget(defaultConfig.agent), {
    softStepLimit: 32,
    hardStepLimit: 96,
    maxToolCalls: 512,
    maxRepeatedActions: 3
  });

  const configured = configSchema.parse({
    ...defaultConfig,
    agent: {
      ...defaultConfig.agent,
      softStepLimit: 12,
      hardStepLimit: 48,
      maxToolCalls: 200,
      maxRepeatedActions: 5
    }
  });
  assert.deepEqual(resolveRunBudget(configured.agent), {
    softStepLimit: 12,
    hardStepLimit: 48,
    maxToolCalls: 200,
    maxRepeatedActions: 5
  });
  assert.throws(() => configSchema.parse({
    ...defaultConfig,
    agent: { ...defaultConfig.agent, maxProviderRetries: 2 }
  }), /Unrecognized key/u);
}

function testRemovedModelFormatsRequireManualUpdate(): void {
  assert.throws(
    () => configSchema.parse({ ...defaultConfig, model: { provider: "deepseek", model: "deepseek-chat" } }),
    (error: unknown) => error instanceof Error
      && /Unsupported model configuration/u.test(error.message)
      && /no longer auto-migrates/u.test(error.message)
      && /defaultModel/u.test(error.message)
      && /biny doctor/u.test(error.message)
  );
  assert.throws(
    () => configSchema.parse({
      ...defaultConfig,
      defaultModel: "legacy",
      models: { ...defaultConfig.models, legacy: { provider: "deepseek", model: "deepseek-reasoner" } }
    }),
    /model ID `deepseek-reasoner` was removed/u
  );
  assert.throws(
    () => configSchema.parse({
      ...defaultConfig,
      defaultModel: "legacy",
      models: { ...defaultConfig.models, legacy: { provider: "deepseek", model: "deepseek-v4-flash", thinking: { efforts: ["high"] } } }
    }),
    /model-level `thinking` field was removed; use `reasoning`/u
  );
}

async function testProjectOverridesAndGlobalPersistence(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-config-test-"));
  const globalRoot = path.join(root, "global");
  const workspace = path.join(root, "project");
  await fs.mkdir(workspace);
  try {
    await saveConfig(workspace, { ...defaultConfig, defaultModel: "deepseek-v4-pro" }, { globalDir: globalRoot });
    await fs.mkdir(path.join(workspace, ".biny"));
    await fs.writeFile(path.join(workspace, ".biny", "settings.json"), JSON.stringify({
      defaultModel: "deepseek-v4-flash",
      thinking: { enabled: false },
      agent: { softStepLimit: 2 },
      permission: { mode: "read-only" },
      context: {
        compaction: { reserveTokens: 2_048, keepRecentTokens: 8_192, maxSummaryTokens: 1_024 },
        memory: { maxRecalled: 1 }
      },
      sandbox: { mode: "workspace-write" }
    }));

    const effective = await loadConfig(workspace, { globalDir: globalRoot });
    assert.equal(effective.defaultModel, "deepseek-v4-flash");
    assert.equal(effective.thinking.enabled, false);
    assert.equal(effective.agent.softStepLimit, 2);
    assert.equal(effective.permission.mode, "read-only");
    assert.equal(effective.context.compaction.reserveTokens, 2_048);
    assert.equal(effective.context.compaction.keepRecentTokens, 8_192);
    assert.equal(effective.context.compaction.maxSummaryTokens, 1_024);
    // 个性化和记忆策略只有 global + chat 两层；旧 project memory override 迁移后被移除。
    assert.equal(effective.context.memory.maxRecalled, defaultConfig.context.memory.maxRecalled);
    assert.equal(effective.sandbox.mode, "workspace-write");

    const changed = structuredClone(effective);
    changed.defaultModel = "deepseek-v4-pro";
    changed.permission.mode = "ask";
    await saveConfig(workspace, changed, { globalDir: globalRoot });
    const global = await loadConfigFile(globalRoot);
    assert.equal(global.defaultModel, "deepseek-v4-pro");
    assert.equal(global.permission.mode, "ask");
    assert.equal((await loadConfig(workspace, { globalDir: globalRoot })).defaultModel, "deepseek-v4-flash");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testRemovedProjectBudgetFieldsAreRejected(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-project-budget-"));
  const globalRoot = path.join(root, "global");
  const workspace = path.join(root, "project");
  await fs.mkdir(path.join(workspace, ".biny"), { recursive: true });
  try {
    await fs.writeFile(path.join(workspace, ".biny", "settings.json"), JSON.stringify({
      agent: {
        maxSteps: 2,
        maxTaskSteps: 10,
        maxAttempts: 7,
        maxCompletionContinuations: 3
      }
    }));
    await assert.rejects(
      loadConfig(workspace, { globalDir: globalRoot }),
      /Invalid project [\s\S]*Unrecognized key\(s\)/u
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testProjectCredentialFieldsAreRejected(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-project-settings-"));
  const workspace = path.join(root, "project");
  await fs.mkdir(path.join(workspace, ".biny"), { recursive: true });
  try {
    await fs.writeFile(path.join(workspace, ".biny", "settings.json"), JSON.stringify({
      providers: { leaked: { type: "openai", apiKey: "not-a-real-key" } }
    }));
    await assert.rejects(loadConfig(workspace, { globalDir: path.join(root, "global") }), /Unrecognized key|Invalid project/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testProjectModelAliasMustBeGlobal(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-project-model-"));
  const workspace = path.join(root, "project");
  const globalRoot = path.join(root, "global");
  await fs.mkdir(path.join(workspace, ".biny"), { recursive: true });
  try {
    await saveConfig(workspace, defaultConfig, { globalDir: globalRoot });
    await fs.writeFile(path.join(workspace, ".biny", "settings.json"), JSON.stringify({ defaultModel: "project-only" }));
    await assert.rejects(loadConfig(workspace, { globalDir: globalRoot }), /Project defaultModel.*not configured in global/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testLegacyProjectConfigIsIgnored(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-legacy-config-"));
  const workspace = path.join(root, "project");
  const globalRoot = path.join(root, "global");
  await fs.mkdir(workspace);
  try {
    await saveConfigFile(globalRoot, defaultConfig);
    await saveConfigFile(workspace, { ...defaultConfig, defaultModel: "deepseek-v4-pro" });
    assert.equal((await loadConfig(workspace, { globalDir: globalRoot })).defaultModel, defaultConfig.defaultModel);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testVersionedGlobalConfigRejectsStaleWriters(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-config-cas-"));
  const workspace = path.join(root, "project");
  const globalRoot = path.join(root, "global");
  await fs.mkdir(workspace);
  const credentialStore: CredentialStore = {
    persistent: false,
    get: async () => undefined,
    set: async () => undefined,
    delete: async () => undefined
  };
  try {
    const firstStore = createFileConfigStore(workspace, { globalDir: globalRoot, credentialStore });
    const secondStore = createFileConfigStore(workspace, { globalDir: globalRoot, credentialStore });
    const firstLoad = firstStore.loadVersioned;
    const firstSave = firstStore.saveVersioned;
    const secondLoad = secondStore.loadVersioned;
    const secondSave = secondStore.saveVersioned;
    if (!firstLoad || !firstSave || !secondLoad || !secondSave) throw new Error("Versioned config store API is unavailable.");
    const first = await firstLoad();
    const second = await secondLoad();

    const friendly = structuredClone(first.config);
    friendly.personalization.personality = "friendly";
    await firstSave(friendly, first.revision);
    const concurrentReads = await Promise.all(
      Array.from({ length: 24 }, async () => await loadConfigFile(globalRoot))
    );
    assert.equal(concurrentReads.every((config) => config.personalization.personality === "friendly"), true);

    const stale = structuredClone(second.config);
    stale.personalization.personality = "pragmatic";
    await assert.rejects(
      secondSave(stale, second.revision),
      (error: unknown) => error instanceof ConfigRevisionConflictError
    );
    assert.equal((await firstLoad()).config.personalization.personality, "friendly");
    await assert.rejects(fs.access(path.join(globalRoot, ".config.write.lock")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testMacKeychainCredentialStore(): Promise<void> {
  const values = new Map<string, string>();
  const calls: Array<{ command: string; args: string[] }> = [];
  const store = new MacKeychainCredentialStore(async (command, args) => {
    calls.push({ command, args });
    const account = args[args.indexOf("-a") + 1]!;
    if (command === "security" && args[0] === "find-generic-password") {
      const value = values.get(account);
      if (!value) throw Object.assign(new Error("missing"), { code: 44 });
      return { stdout: `${value}\n` };
    }
    if (args[0] === "add-generic-password") values.set(account, args[args.indexOf("-w") + 1]!);
    if (args[0] === "delete-generic-password") values.delete(account);
    return { stdout: "" };
  });

  await store.set("provider:openai:apiKey", "test-secret");
  assert.equal(await store.get("provider:openai:apiKey"), "test-secret");
  await store.delete("provider:openai:apiKey");
  assert.equal(await store.get("provider:openai:apiKey"), undefined);
  assert.ok(calls.every((call) => call.args.includes("-s") && call.args[call.args.indexOf("-s") + 1] === BINY_KEYCHAIN_SERVICE));
}
