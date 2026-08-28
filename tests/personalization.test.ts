import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSystemPrompt,
  personalizationRuntimePolicyFromSystemPrompt,
  systemPromptForTelemetry
} from "../src/agent/prompts.js";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel } from "../src/agent/core/types.js";
import { loadConfigFile } from "../src/config/loader.js";
import { providerCredentialAccount, type CredentialStore } from "../src/config/credentials.js";
import { loadProjectSettings } from "../src/config/projectSettings.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore, type AgentConfigStore } from "../src/config/store.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import {
  chatPersonalizationOverrideSchema,
  defaultChatPersonalizationOverride,
  mergeChatPersonalizationOverride,
  personalityPresetSchema,
  personalizationSettingsSchema,
  resolveChatPersonalization
} from "../src/personalization/index.js";
import {
  readSessionCatalogRecord,
  registerSessionBranch,
  SESSION_CATALOG_MISSING_REVISION,
  SessionCatalogConflictError,
  updateSessionCatalogMetadata,
  writeSessionCatalogRecord
} from "../src/session/catalog.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

testUtf8InstructionLimit();
testOverrideResolutionAndPromptPrivacy();
testBuddyPersonalityPreset();
await testGlobalAndProjectMigrations();
await testCatalogCasAndForkInheritance();
await testAgentSessionPersonalizationCas();
console.log("personalization tests passed");

function testUtf8InstructionLimit(): void {
  const withinLimit = "你".repeat(1_365);
  const overLimit = "你".repeat(1_366);
  assert.equal(Buffer.byteLength(withinLimit, "utf8"), 4_095);
  assert.equal(personalizationSettingsSchema.parse({
    enabled: true,
    personality: "friendly",
    customInstructions: withinLimit
  }).customInstructions, withinLimit);
  assert.throws(() => personalizationSettingsSchema.parse({
    enabled: true,
    personality: "friendly",
    customInstructions: overLimit
  }), /4096 UTF-8 bytes/u);
  assert.throws(() => chatPersonalizationOverrideSchema.parse({
    ...defaultChatPersonalizationOverride,
    customInstructions: { mode: "replace", value: overLimit }
  }), /4096 UTF-8 bytes/u);
}

function testOverrideResolutionAndPromptPrivacy(): void {
  const override = mergeChatPersonalizationOverride(defaultChatPersonalizationOverride, {
    personality: "pragmatic",
    customInstructions: { mode: "replace", value: "Use <short> evidence." },
    useMemories: true,
    contributeMemories: false
  });
  const resolved = resolveChatPersonalization({
    enabled: true,
    personality: "friendly",
    customInstructions: "Global private instruction."
  }, {
    useMemories: false,
    generateMemories: true,
    extractModel: undefined,
    consolidationModel: undefined,
    excludeExternalContext: true
  }, override);
  assert.equal(resolved.personality, "pragmatic");
  assert.equal(resolved.customInstructions, "Use <short> evidence.");
  assert.equal(resolved.useMemories, true);
  assert.equal(resolved.contributeMemories, false);

  const memoryDisabled = resolveChatPersonalization({
    enabled: true,
    personality: "friendly",
    customInstructions: ""
  }, {
    ...defaultConfig.context.memory,
    enabled: false
  }, {
    ...defaultChatPersonalizationOverride,
    useMemories: true,
    contributeMemories: true
  });
  assert.equal(memoryDisabled.memoryEnabled, false);
  assert.equal(memoryDisabled.useMemories, false);
  assert.equal(memoryDisabled.contributeMemories, false);

  const prompt = buildSystemPrompt({ mode: "qa", cwd: "/tmp/work", personalization: resolved });
  assert.match(prompt, /Use &lt;short&gt; evidence\./u);
  assert.match(prompt, /cannot override system or mode rules/u);
  assert.match(
    prompt,
    /runtime safety, tool permissions, and Plan-mode rules; project AGENTS\/instructions; the current user task; chat personalization overrides; global personalization; recalled memory/u
  );
  const telemetry = systemPromptForTelemetry(prompt) ?? "";
  assert.doesNotMatch(telemetry, /short|Global private/u);
  assert.match(telemetry, /personality="pragmatic"/u);
  assert.match(telemetry, /configVersion="1"/u);
  assert.match(telemetry, /instructionsHash="sha256:[a-f0-9]{64}"/u);
  const persisted = personalizationRuntimePolicyFromSystemPrompt(prompt);
  assert.deepEqual(persisted, {
    personality: "pragmatic",
    configVersion: 1,
    instructionsHash: resolved.instructionsHash,
    useMemories: true,
    contributeMemories: false,
    excludeExternalContext: true,
    maxRecalled: 5,
    telos: {
      enabled: false,
      autoObserve: false,
      driftDetection: false,
      proactivePrompts: false
    }
  });

  const identityPrompt = buildSystemPrompt({
    mode: "qa",
    cwd: "/tmp/work",
    identityPrompt: "<biny_identity>local private identity</biny_identity>"
  });
  assert.match(identityPrompt, /local private identity/u);
  const identityTelemetry = systemPromptForTelemetry(identityPrompt) ?? "";
  assert.match(identityTelemetry, /<biny_identity omitted="true" \/>/u);
  assert.doesNotMatch(identityTelemetry, /local private identity/u);

  const disabled = resolveChatPersonalization({
    enabled: false,
    personality: "friendly",
    customInstructions: "ignored"
  }, defaultConfig.context.memory, override);
  assert.equal(disabled.personality, "none");
  assert.equal(disabled.customInstructions, "");
}

function testBuddyPersonalityPreset(): void {
  // buddy 是完整 preset：schema、prompt 注入、telemetry 摘要与运行策略恢复都要认得它。
  assert.equal(personalityPresetSchema.parse("buddy"), "buddy");
  assert.equal(personalizationSettingsSchema.parse({
    enabled: true,
    personality: "buddy",
    customInstructions: ""
  }).personality, "buddy");
  const override = mergeChatPersonalizationOverride(defaultChatPersonalizationOverride, {
    personality: "buddy"
  });
  assert.equal(override.personality, "buddy");
  const resolved = resolveChatPersonalization({
    enabled: true,
    personality: "buddy",
    customInstructions: ""
  }, {
    useMemories: true,
    generateMemories: true,
    extractModel: undefined,
    consolidationModel: undefined,
    excludeExternalContext: true
  }, override);
  assert.equal(resolved.personality, "buddy");

  const prompt = buildSystemPrompt({ mode: "qa", cwd: "/tmp/work", personalization: resolved });
  assert.match(prompt, /personality="buddy"/u);
  assert.match(prompt, /像跟朋友发消息一样说话，不是客服。/u);
  assert.match(prompt, /禁止开场白/u);
  assert.match(prompt, /emoji 克制/u);

  // telemetry 只保留枚举元字段；buddy 人格正文不能泄进诊断日志。
  const telemetry = systemPromptForTelemetry(prompt) ?? "";
  assert.match(telemetry, /personality="buddy"/u);
  assert.doesNotMatch(telemetry, /omitted="true"/u);
  assert.doesNotMatch(telemetry, /像跟朋友发消息一样说话/u);

  // TurnStore 续跑恢复运行策略时放行 buddy，不能回退成 undefined。
  const persisted = personalizationRuntimePolicyFromSystemPrompt(prompt);
  assert.equal(persisted?.personality, "buddy");
}

async function testGlobalAndProjectMigrations(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-personalization-config-"));
  const globalRoot = path.join(root, "global");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(globalRoot, { recursive: true });
  await fs.mkdir(path.join(workspace, ".biny"), { recursive: true });
  try {
    const legacy = structuredClone(defaultConfig) as unknown as Record<string, unknown>;
    delete legacy.format;
    delete legacy.configVersion;
    (legacy.providers as Record<string, Record<string, unknown>>).deepseek!.apiKey = "test-only-migration-key";
    const context = legacy.context as Record<string, unknown>;
    context.memory = {
      enabled: true,
      autoRemember: true,
      maxRecalled: 2,
      model: "deepseek-v4-flash"
    };
    await fs.writeFile(path.join(globalRoot, "config.json"), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    const migrated = await loadConfigFile(globalRoot);
    assert.equal(migrated.format, "biny-config");
    assert.equal(migrated.configVersion, 1);
    assert.deepEqual(migrated.context.memory, {
      enabled: true,
      useMemories: true,
      generateMemories: true,
      queryRewrite: true,
      extractModel: "deepseek-v4-flash",
      consolidationModel: "deepseek-v4-flash",
      similarityThresholds: {},
      cloudEmbeddingConsents: {},
      excludeExternalContext: true,
      maxRecalled: 2
    });
    // 旧配置未声明嵌入模型时，读取方由调用点（非 schema 迁移）回落到本地默认。
    assert.equal(migrated.context.memory.embeddingModel, undefined);
    const persisted = JSON.parse(await fs.readFile(path.join(globalRoot, "config.json"), "utf8")) as Record<string, unknown>;
    assert.equal(persisted.format, undefined, "plain config reads must not rewrite migrations");
    assert.equal(persisted.configVersion, undefined);
    const persistedMemory = (persisted.context as Record<string, unknown>).memory as Record<string, unknown>;
    assert.equal(persistedMemory.enabled, true);
    assert.equal(persistedMemory.autoRemember, true);
    assert.equal(persistedMemory.model, "deepseek-v4-flash");
    assert.equal(
      ((persisted.providers as Record<string, Record<string, unknown>>).deepseek ?? {}).apiKey,
      "test-only-migration-key"
    );

    const storedCredentials = new Map<string, string>();
    const credentialStore: CredentialStore = {
      persistent: true,
      get: async (account) => storedCredentials.get(account),
      set: async (account, value) => { storedCredentials.set(account, value); },
      delete: async (account) => { storedCredentials.delete(account); }
    };
    const loaded = await createFileConfigStore(workspace, { globalDir: globalRoot, credentialStore }).load();
    assert.equal(loaded.providers.deepseek?.apiKey, "test-only-migration-key");
    assert.equal(storedCredentials.get(providerCredentialAccount("deepseek", "apiKey")), "test-only-migration-key");
    const secured = JSON.parse(await fs.readFile(path.join(globalRoot, "config.json"), "utf8")) as Record<string, unknown>;
    assert.equal(secured.format, "biny-config");
    assert.equal(secured.configVersion, 1);
    assert.equal(((secured.providers as Record<string, Record<string, unknown>>).deepseek ?? {}).apiKey, undefined);

    await fs.writeFile(path.join(workspace, ".biny", "settings.json"), JSON.stringify({
      agent: { softStepLimit: 7 },
      context: { memory: { enabled: true, autoRemember: true, model: "deepseek-v4-flash" } }
    }), { mode: 0o600 });
    const project = await loadProjectSettings(workspace);
    assert.deepEqual(project, { agent: { softStepLimit: 7 } });
    const projectDocument = JSON.parse(
      await fs.readFile(path.join(workspace, ".biny", "settings.json"), "utf8")
    ) as Record<string, unknown>;
    assert.equal(projectDocument.format, undefined, "plain project settings reads must not rewrite migrations");
    assert.equal(projectDocument.configVersion, undefined);
    assert.notEqual(projectDocument.context, undefined);

    const partialMemory = configSchema.parse({
      ...defaultConfig,
      context: { ...defaultConfig.context, memory: { enabled: true } }
    }).context.memory;
    assert.equal(partialMemory.enabled, true);
    assert.equal(partialMemory.useMemories, true);
    assert.equal(partialMemory.generateMemories, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testCatalogCasAndForkInheritance(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-personalization-catalog-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    const now = new Date().toISOString();
    const personalization = {
      personality: "friendly" as const,
      customInstructions: { mode: "replace" as const, value: "Keep this fork preference." },
      useMemories: true,
      contributeMemories: "inherit" as const
    };
    await writeSessionCatalogRecord(workspace, {
      version: 1,
      sessionId: "parent",
      rootSessionId: "parent",
      personalization,
      createdAt: now,
      updatedAt: now
    }, { expectedRevision: SESSION_CATALOG_MISSING_REVISION });
    await registerSessionBranch(workspace, {
      sessionId: "child",
      parentSessionId: "parent",
      branchPoint: { kind: "event", index: 1 }
    });
    assert.deepEqual((await readSessionCatalogRecord(workspace, "child"))?.personalization, personalization);
    await assert.rejects(
      updateSessionCatalogMetadata(
        workspace,
        "child",
        { personalization: defaultChatPersonalizationOverride },
        SESSION_CATALOG_MISSING_REVISION
      ),
      SessionCatalogConflictError
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testAgentSessionPersonalizationCas(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-personalization-session-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    let storedConfig = structuredClone(defaultConfig);
    let configRevision = "config-1";
    const store: AgentConfigStore = {
      load: async () => structuredClone(storedConfig),
      save: async (config) => { storedConfig = structuredClone(config); },
      loadVersioned: async () => ({ config: structuredClone(storedConfig), revision: configRevision }),
      saveVersioned: async (config, expectedRevision) => {
        if (expectedRevision !== configRevision) throw new Error("stale config revision");
        storedConfig = structuredClone(config);
        configRevision = "config-2";
        return { config: structuredClone(storedConfig), revision: configRevision };
      }
    };
    const model: AgentModel = {
      provider: "test",
      modelId: "unused",
      async stream() {
        return (async function* () { /* state updates do not invoke the model */ })();
      }
    };
    await ensureAgentDirs(workspace);
    const recorder = new SessionRecorder(workspace, "draft-personalization");
    const agent = new AgentSession({
      workspaceRoot: workspace,
      config: structuredClone(storedConfig),
      configStore: store,
      model,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager({ ...storedConfig.permission, source: "test" }),
      recorder
    });
    await agent.initialize();

    const initial = await agent.getPersonalizationState();
    assert.equal(initial.catalogRevision, SESSION_CATALOG_MISSING_REVISION);
    assert.equal(initial.configRevision, "config-1");
    const chat = await agent.updateChatPersonalization(
      { personality: "friendly" },
      SESSION_CATALOG_MISSING_REVISION
    );
    assert.equal(chat.resolved.personality, "friendly");
    assert.notEqual(chat.catalogRevision, SESSION_CATALOG_MISSING_REVISION);
    await assert.rejects(
      agent.updateChatPersonalization({ personality: "pragmatic" }, SESSION_CATALOG_MISSING_REVISION),
      SessionCatalogConflictError
    );

    const global = await agent.updateGlobalPersonalization({
      personalization: {
        enabled: true,
        personality: "pragmatic",
        customInstructions: "Global instruction after a CAS write."
      },
      memory: {
        ...storedConfig.context.memory,
        useMemories: true,
        generateMemories: true
      }
    }, "config-1");
    assert.equal(global.configRevision, "config-2");
    assert.equal(global.global.personality, "pragmatic");
    assert.equal(global.resolved.personality, "friendly");
    assert.equal(global.resolved.customInstructions, "Global instruction after a CAS write.");
    await assert.rejects(
      agent.updateGlobalPersonalization({ personalization: storedConfig.personalization }, "config-1"),
      /stale config revision/u
    );
    await agent.close();
  } finally {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await fs.rm(root, { recursive: true, force: true });
  }
}
