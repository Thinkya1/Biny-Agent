import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addSkillRepository,
  discoverSkillRepositories,
  installDiscoveredSkill,
  listSkillRepositories,
  removeSkillRepository,
  searchSkillsSh,
  type SkillRepository
} from "../src/extensions/skillDiscovery.js";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-discovery-"));
  const homeDir = path.join(root, "home");
  const repository: SkillRepository = { owner: "demo-owner", name: "demo-skills", branch: "main", enabled: true };
  const fetcher: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/git/trees/main")) {
      return response(JSON.stringify({ tree: [
        { path: "skills/demo/SKILL.md", type: "blob", size: 64 },
        { path: "skills/demo/references/guide.md", type: "blob", size: 10 }
      ] }));
    }
    if (url.endsWith("/skills/demo/SKILL.md")) return response("---\nname: demo-skill\ndescription: Demo discovery skill\n---\n\n# Demo\n");
    if (url.endsWith("/skills/demo/references/guide.md")) return response("# Guide\n");
    if (url.includes("skills.sh/api/search")) return response(JSON.stringify({ query: "demo", count: 1, skills: [{ id: "demo-owner/demo-skills:demo-skill", skillId: "demo-skill", name: "demo-skill", installs: 42, source: "demo-owner/demo-skills" }] }));
    return response("not found", 404);
  };

  try {
    const defaults = await listSkillRepositories(homeDir);
    assert.equal(defaults.repositories.length, 4);
    await addSkillRepository(repository, homeDir);
    assert.equal((await listSkillRepositories(homeDir)).repositories.some((item) => item.owner === repository.owner), true);

    const discovered = await discoverSkillRepositories({ repositories: [repository], fetcher });
    assert.equal(discovered.warnings.length, 0);
    assert.equal(discovered.skills[0]?.directory, "skills/demo");
    assert.equal(discovered.skills[0]?.name, "demo-skill");

    const searched = await searchSkillsSh({ query: "demo", fetcher });
    assert.equal(searched.totalCount, 1);
    assert.equal(searched.skills[0]?.installs, 42);
    assert.equal(searched.skills[0]?.repoOwner, "demo-owner");

    const installed = await installDiscoveredSkill({ skill: discovered.skills[0]!, homeDir, fetcher });
    assert.equal(installed.name, "demo-skill");
    assert.equal(await readFile(path.join(homeDir, ".biny", "skills", "demo", "references", "guide.md"), "utf8"), "# Guide\n");

    await assert.rejects(
      () => installDiscoveredSkill({ skill: discovered.skills[0]!, homeDir, fetcher }),
      /Skill 已安装/
    );
    await removeSkillRepository(repository.owner, repository.name, homeDir);
    assert.equal((await listSkillRepositories(homeDir)).repositories.some((item) => item.owner === repository.owner), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

await main();
