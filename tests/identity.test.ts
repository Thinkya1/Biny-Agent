import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IdentityStorage } from "../src/agent/context/identityStorage.js";
import {
  detectIdentitySecretWarning,
  identityDocumentFileNames,
  renderIdentityPrompt
} from "../src/agent/context/identityFormat.js";
import { identityDocumentKinds } from "../src/agent/context/identityTypes.js";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-identity-test-"));
  const agent = path.join(root, "biny-agent");

  try {
    // 只保留 soul / user 两类长期身份文档。
    assert.deepEqual([...identityDocumentKinds], ["soul", "user"]);
    assert.deepEqual(identityDocumentFileNames, { soul: "SOUL.md", user: "USER.md" });

    const storage = new IdentityStorage({ agentDir: agent });
    // 初始化前不创建任何目录，overview 返回空快照。
    assert.equal((await storage.overview()).revision, 0);
    await assert.rejects(fs.access(path.join(agent, "identity")), /ENOENT/u);
    await storage.initialize();

    // 写入 soul 文档，revision 递增。
    const savedSoul = await storage.saveDocument("soul", "# Soul\n\nBe precise and kind.\n", 0);
    assert.equal(savedSoul.revision, 1);
    assert.equal(savedSoul.documents.soul?.content, "# Soul\n\nBe precise and kind.");
    assert.equal(await fs.readFile(path.join(agent, "identity", "SOUL.md"), "utf8"), "# Soul\n\nBe precise and kind.\n");

    // revision 乐观锁：过期 expectedRevision 触发冲突。
    await assert.rejects(
      storage.saveDocument("user", "# User\n\nA stale edit.\n", 0),
      /revision conflict/iu
    );

    // 写入 user 文档，revision 继续递增。
    const savedUser = await storage.saveDocument("user", "# User\n\nPrefer small verified changes.\n", savedSoul.revision);
    assert.equal(savedUser.revision, 2);
    assert.equal(savedUser.documents.user?.content, "# User\n\nPrefer small verified changes.");

    // prompt 投影：includeUser=false 时只注入 soul。
    const soulOnly = renderIdentityPrompt({ documents: savedUser.documents, includeUser: false });
    assert.ok(soulOnly);
    assert.match(soulOnly, /Be precise and kind/u);
    assert.doesNotMatch(soulOnly, /Prefer small verified changes/u);

    // prompt 投影：includeUser=true 时同时注入 soul 与 user。
    const withUser = renderIdentityPrompt({ documents: savedUser.documents, includeUser: true });
    assert.ok(withUser);
    assert.match(withUser, /Be precise and kind/u);
    assert.match(withUser, /Prefer small verified changes/u);

    // 空文档集合不产生 prompt。
    assert.equal(renderIdentityPrompt({ documents: {}, includeUser: true }), undefined);

    // 密钥警示保留：能识别疑似凭据，但不修改正文。
    assert.equal(detectIdentitySecretWarning("apiKey=sk-identity-secret-value"), "检测到疑似凭据字段。");
    assert.equal(detectIdentitySecretWarning("token ghp_abcdefghijklmnopqrstuvwxyz123"), "检测到疑似访问凭据。");
    assert.equal(detectIdentitySecretWarning("Just a normal preference."), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log("identity tests passed");
}

void main();
