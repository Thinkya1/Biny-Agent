import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentModel } from "../src/agent/core/types.js";
import { buildMemoryOverview } from "../src/agent/context/memoryFormat.js";
import { parseMemoryCitations } from "../src/agent/context/memoryCitations.js";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import type { MemoryEntry } from "../src/agent/context/memoryTypes.js";
import { createMemoryTools } from "../src/extensions/memory.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";

await testParseMemoryCitations();
await testBuildMemoryOverview();
await testRecallMemoryDefaultOrigin();
console.log("memory citations tests passed");

async function testParseMemoryCitations(): Promise<void> {
  const plain = "回答正文，没有引用。";
  assert.deepEqual(parseMemoryCitations(plain), { citations: [], textWithoutBlock: plain });

  const withBlock = [
    "回答主体。",
    "",
    "<memory-citations>",
    "- abcdef12-34cd-4e55-8f66-0000000000aa | note=给出了发布顺序",
    "- ffff0000-1111-4222-8333-444444444444",
    "- abcdef12-34cd-4e55-8f66-0000000000aa | note=重复去重",
    "- short-1 | note=不足 8 位的 id 形态被忽略",
    "- 非小写行",
    "</memory-citations>",
    ""
  ].join("\n");
  const parsed = parseMemoryCitations(withBlock);
  assert.deepEqual(parsed.citations.map(({ id }) => id), [
    "abcdef12-34cd-4e55-8f66-0000000000aa",
    "ffff0000-1111-4222-8333-444444444444"
  ]);
  assert.equal(parsed.citations[0]?.note, "给出了发布顺序");
  assert.equal(parsed.textWithoutBlock, "回答主体。");

  const emptyBlock = "文字。\n<memory-citations>\n</memory-citations>\n";
  assert.deepEqual(parseMemoryCitations(emptyBlock), { citations: [], textWithoutBlock: "文字。" });
}

async function testBuildMemoryOverview(): Promise<void> {
  const entry = (topic: string, title: string, importance = 3): MemoryEntry => ({
    id: `${topic}-${title}`.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32).padEnd(8, "0"),
    origin: { kind: "workspace", workspaceId: "0123456789abcdef01234567", workspaceName: "ws" },
    kind: "fact",
    topic,
    title,
    summary: title,
    decisions: [],
    paths: [],
    keywords: [],
    importance,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    revision: 1,
    lineage: [{ source: "explicit", externalContext: false }],
    recallCount: 0
  });

  assert.equal(buildMemoryOverview([]), "");
  const overview = buildMemoryOverview([
    entry("release", "Cut release after tests", 5),
    entry("release", "Tag naming rule", 2),
    entry("debugging", "Prefer deterministic clocks", 3)
  ]);
  assert.match(overview, /release: Cut release after tests; Tag naming rule/u);
  assert.match(overview, /debugging: Prefer deterministic clocks/u);
  assert.match(overview, /recall_memory/u);
  assert.match(overview, /memory-citations/u);
  assert.ok(overview.length < 4_000);
  // 只列概览里的标题，绝不携带跨项目正文或完整条目。
  assert.equal(overview.includes("workspaceId"), false);
  assert.equal(overview.includes("0123456789abcdef01234567"), false);

  const many = Array.from({ length: 200 }, (_, index) => entry(`topic-${String(index % 10)}`, `Entry ${String(index)} ${"x".repeat(40)}`));
  const bounded = buildMemoryOverview(many, { maxChars: 1_000 });
  assert.ok(bounded.length <= 1_000);
  assert.match(bounded, /omitted beyond this overview budget/u);
}

async function testRecallMemoryDefaultOrigin(): Promise<void> {
  const agentRoot = await mkdtemp(path.join(os.tmpdir(), "biny-citations-agent-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-citations-workspace-"));
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), "biny-citations-other-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = agentRoot;
  try {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const own = await memory.writeEntry({
      audience: "workspace",
      kind: "fact",
      topic: "project",
      title: "本项目事实",
      summary: "当前项目的事实：构建产物输出到 dist/ 目录，且发布前必须通过类型检查。",
      decisions: [],
      paths: [],
      keywords: ["构建"],
      importance: 3,
      lineage: { source: "explicit", externalContext: false }
    }, { expectedRevision: 0 });
    assert.ok(own.written);

    // 用另一个 LocalMemory 实例模拟“其他工作区”的条目进入同一共享库。
    const otherMemory = new LocalMemory(otherRoot, unusedModel);
    const other = await otherMemory.writeEntry({
      audience: "workspace",
      kind: "fact",
      topic: "project",
      title: "其他项目事实",
      summary: "其他项目的事实：构建产物输出到 out/ 目录，且发布前必须通过单元测试。",
      decisions: [],
      paths: [],
      keywords: ["构建"],
      importance: 5,
      lineage: { source: "explicit", externalContext: false }
    }, { expectedRevision: (await memory.getOverview()).storeRevision });
    assert.ok(other.written);

    const [saveTool, recallTool] = createMemoryTools(() => memory);
    void saveTool;
    assert.ok(recallTool);
    const run = async (args: unknown): Promise<{ matches: Array<{ entry: { origin: { kind: string; workspaceId?: string } } }> }> => {
      const resolved = recallTool.resolveExecution(args);
      assert.ok(!("isError" in resolved));
      return await resolved.execute({ toolCallId: "recall-test" }) as never;
    };

    const defaultSearch = await run({ query: "构建产物" });
    assert.ok(defaultSearch.matches.length >= 1);
    const ids = defaultSearch.matches.map(({ entry }) => entry.origin.workspaceId);
    const otherId = other.entry?.origin.kind === "workspace" ? other.entry.origin.workspaceId : undefined;
    assert.equal(ids.includes(otherId), false, "缺省召回绝不带入其他工作区的记忆");

    const explicitAll = await run({ query: "构建产物", origin: "all" });
    assert.equal(
      explicitAll.matches.some(({ entry }) => entry.origin.workspaceId === otherId),
      true,
      "显式 all 选择才允许浏览跨项目记忆"
    );
  } finally {
    if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previous;
    await rm(agentRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(otherRoot, { recursive: true, force: true });
  }
}

function unusedModel(): AgentModel {
  return {
    provider: "test",
    modelId: "unused",
    async stream() {
      return (async function* () { /* 这些测试不调用模型 */ })();
    }
  };
}
