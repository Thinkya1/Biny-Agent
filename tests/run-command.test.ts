import assert from "node:assert/strict";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { applyRunConfig, createRunConfigStore, validateRunOptions } from "../src/cli/commands/run.js";
import { appendCapped } from "../src/tools/shell/runCommand.js";

const config = structuredClone(defaultConfig);
const overridden = applyRunConfig(config, {
  model: "deepseek-v4-pro",
  maxSteps: 256,
  softSteps: 192,
  headless: true
});

assert.equal(overridden.defaultModel, "deepseek-v4-pro");
assert.equal(overridden.agent.hardStepLimit, 256);
assert.equal(overridden.agent.softStepLimit, 192);
assert.equal(overridden.permission.mode, "full-access");
assert.equal(overridden.permission.criticalAlwaysAsk, false);

assert.throws(
  () => validateRunOptions({ maxSteps: 64, softSteps: 65 }),
  /softSteps cannot be greater than maxSteps/
);
assert.throws(
  () => validateRunOptions({ maxSteps: 1_025 }),
  /maxSteps must be an integer between 1 and 1024/
);
assert.throws(
  () => validateRunOptions({ permissionMode: "safe" as never }),
  /permissionMode must be one of ask, read-only, auto, full-access/
);

await testRunConfigStoreKeepsOverridesEphemeral();
testShellOutputCapTrimsByBytes();

console.log("run command tests passed");

function testShellOutputCapTrimsByBytes(): void {
  const maxOutputBytes = 1024 * 1024;
  // 输出上限按字节计：多字节字符超限截断时不能按字符数删（会成倍多删），也不能切断半个 UTF-8 序列。
  const chunk = "字".repeat(400_000); // 1_200_000 字节，超出 1 MiB 上限
  const capped = appendCapped("", chunk);
  const keptCharacters = Math.floor(maxOutputBytes / 3);
  assert.equal(Buffer.byteLength(capped, "utf8"), keptCharacters * 3);
  assert.equal(capped, chunk.slice(chunk.length - keptCharacters));
  assert.equal(capped.includes("\uFFFD"), false);

  const ascii = appendCapped("a".repeat(maxOutputBytes), "b".repeat(100));
  assert.equal(Buffer.byteLength(ascii, "utf8"), maxOutputBytes);
  assert.equal(ascii, `${"a".repeat(maxOutputBytes - 100)}${"b".repeat(100)}`);
}

async function testRunConfigStoreKeepsOverridesEphemeral(): Promise<void> {
  let persisted = structuredClone(defaultConfig);
  let revision = 0;
  const base: AgentConfigStore = {
    load: async () => structuredClone(persisted),
    save: async () => { throw new Error("Run config wrapper must use saveVersioned."); },
    loadVersioned: async () => ({ config: structuredClone(persisted), revision: String(revision) }),
    saveVersioned: async (candidate, expectedRevision) => {
      assert.equal(expectedRevision, String(revision));
      persisted = structuredClone(candidate);
      revision += 1;
      return { config: structuredClone(persisted), revision: String(revision) };
    }
  };
  const store = createRunConfigStore("/tmp/biny-run-config", {
    model: "deepseek-v4-pro",
    maxSteps: 256,
    softSteps: 192,
    headless: true
  }, base);
  const initial = await store.loadVersioned!();
  assert.equal(initial.config.defaultModel, "deepseek-v4-pro");
  assert.equal(initial.config.agent.hardStepLimit, 256);
  assert.equal(initial.config.permission.mode, "full-access");

  const candidate = structuredClone(initial.config);
  candidate.providers.deepseek!.timeoutMs = 12_345;
  const saved = await store.saveVersioned!(candidate, initial.revision);

  assert.equal(saved.config.defaultModel, "deepseek-v4-pro");
  assert.equal(saved.config.permission.mode, "full-access");
  assert.equal(persisted.defaultModel, defaultConfig.defaultModel);
  assert.equal(persisted.agent.hardStepLimit, defaultConfig.agent.hardStepLimit);
  assert.equal(persisted.agent.softStepLimit, defaultConfig.agent.softStepLimit);
  assert.equal(persisted.permission.mode, defaultConfig.permission.mode);
  assert.equal(persisted.permission.criticalAlwaysAsk, defaultConfig.permission.criticalAlwaysAsk);
  assert.equal(persisted.providers.deepseek?.timeoutMs, 12_345);
}
