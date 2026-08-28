import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importAlmaWorkspace, scanAlmaWorkspace } from "../src/agent/context/almaImport.js";
import { proposeIdentityEvolution } from "../src/agent/context/identityEvolution.js";
import { IdentityStorage } from "../src/agent/context/identityStorage.js";
import { renderIdentityPrompt } from "../src/agent/context/identityFormat.js";
import type { AgentModel } from "../src/agent/core/types.js";
import type { MemoryCandidate } from "../src/agent/context/memoryTypes.js";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-identity-test-"));
  const source = path.join(root, "alma-workspace");
  const agent = path.join(root, "biny-agent");
  await fs.mkdir(path.join(source, "memory"), { recursive: true });
  await fs.writeFile(path.join(source, "SOUL.md"), "# Soul\n\nBe precise and kind.\n", "utf8");
  await fs.writeFile(path.join(source, "IDENTITY.md"), "# Identity\n\napiKey=sk-identity-secret-value\n", "utf8");
  await fs.writeFile(path.join(source, "USER.md"), "# User\n\nPrefer small verified changes.\n", "utf8");
  await fs.writeFile(path.join(source, "MEMORY.md"), "# Memory\n\nA daily note.\n", "utf8");
  await fs.writeFile(path.join(source, "memory", "2026-08-27.md"), "# Daily\n\nA recent note.\n", "utf8");
  // 该文件用于证明适配器不会因为 Alma 工作区存在数据库就扩大读取范围。
  await fs.writeFile(path.join(source, "chat_threads.db"), "not scanned", "utf8");

  try {
    const storage = new IdentityStorage({ agentDir: agent });
    await storage.initialize();
    const scanned = await scanAlmaWorkspace(source);
    assert.equal(scanned.identityFiles.filter((file) => file.exists).length, 4);
    assert.equal(scanned.memoryFiles.length, 1);
    assert.equal(scanned.source.files.some((file) => file.relativePath === "chat_threads.db"), false);

    const imported = await importAlmaWorkspace(storage, source);
    assert.equal(imported.proposals.length, 3);
    assert.equal(imported.memoryFiles.some((file) => file.content !== undefined), false);
    const identityProposal = imported.proposals.find((proposal) => proposal.document === "identity");
    assert.equal(identityProposal?.secretWarning, "检测到疑似凭据字段。");

    const afterImport = await storage.overview();
    assert.equal(afterImport.documents.soul, undefined);
    assert.equal(afterImport.importSource?.files.some((file) => file.content !== undefined), false);
    const soulProposal = afterImport.proposals.find((proposal) => proposal.document === "soul");
    assert.ok(soulProposal);
    const accepted = await storage.reviewProposal(soulProposal.id, "accept", afterImport.revision);
    assert.equal(accepted.overview.documents.soul?.content, "# Soul\n\nBe precise and kind.");
    assert.equal(await fs.readFile(path.join(agent, "identity", "SOUL.md"), "utf8"), "# Soul\n\nBe precise and kind.\n");
    await assert.rejects(
      storage.reviewProposal(identityProposal!.id, "accept", accepted.overview.revision),
      /疑似凭据/u
    );

    const manual = await storage.setDocumentProposal(
      "style",
      "# Style\n\nUse short paragraphs.",
      accepted.overview.revision
    );
    await assert.rejects(
      storage.setDocumentProposal("user", "# User\n\nA stale edit.", accepted.overview.revision),
      /revision conflict/u
    );
    const acceptedManual = await storage.reviewProposal(manual.id, "accept", (await storage.overview()).revision);
    const prompt = renderIdentityPrompt({ documents: acceptedManual.overview.documents, includeUser: false });
    assert.match(prompt, /Be precise and kind/u);
    assert.match(prompt, /Style/u);
    assert.doesNotMatch(prompt, /Prefer small verified changes/u);
    assert.ok(manual);
    assert.equal(manual.baseRevision, 0);

    const candidate: MemoryCandidate = {
      id: "candidate-identity-1",
      summary: "用户明确要求以后保持短段落、先给结论，再给最小的验证步骤。这是稳定的协作偏好。",
      completed: true,
      lineage: {
        source: "completed_task",
        sessionId: "session-1",
        turnId: "turn-1",
        runId: "run-1",
        externalContext: false
      },
      origin: { kind: "user" },
      createdAt: "2026-08-28T00:00:00.000Z",
      eligibleAt: "2026-08-28T00:00:00.000Z",
      revision: 1
    };
    const evolution = await proposeIdentityEvolution({
      storage,
      candidates: [candidate],
      model: scriptedModel(JSON.stringify({
        proposal: {
          document: "style",
          content: "# Style\n\n先给结论，再给最小验证步骤。",
          reason: "完成回合中出现了明确且稳定的协作表达偏好。",
          evidence: ["candidate-identity-1"]
        }
      }))
    });
    assert.equal(evolution?.kind, "evolution");
    assert.deepEqual(evolution?.source, { kind: "memory", candidateIds: [candidate.id] });
    assert.equal((await storage.overview()).documents.style?.content, "# Style\n\nUse short paragraphs.");
    const duplicateEvolution = await proposeIdentityEvolution({
      storage,
      candidates: [candidate],
      model: scriptedModel(JSON.stringify({ proposal: null }))
    });
    assert.equal(duplicateEvolution, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log("identity tests passed");
}

function scriptedModel(text: string): AgentModel {
  return {
    provider: "test",
    modelId: "identity-evolution-test",
    stream: async () => (async function* () {
      yield { type: "text-delta" as const, text };
      yield { type: "finish" as const, reason: "stop" as const };
    })()
  };
}

void main();
