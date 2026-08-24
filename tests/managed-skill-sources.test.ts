import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  importManagedSkillSource,
  installManagedSkillSource,
  listManagedSkillSources
} from "../src/extensions/managedSkillSources.js";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-managed-skill-source-"));
  const sourceDirectory = path.join(root, "input", "demo-skill");
  const sourceFile = path.join(sourceDirectory, "SKILL.md");
  const sourceRoot = path.join(root, "skill-sources");
  const installedRoot = path.join(root, "installed-skills");
  try {
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(sourceFile, "---\nname: demo-skill\ndescription: Imported demo skill\n---\n\n# Demo\n");

    const imported = await importManagedSkillSource({ sourceFile, root: sourceRoot, installedRoot });
    assert.equal(imported.id, "demo-skill");
    assert.equal(imported.installed, false);
    assert.equal(await readFile(path.join(sourceRoot, "demo-skill", "SKILL.md"), "utf8"), await readFile(sourceFile, "utf8"));

    const beforeInstall = await listManagedSkillSources({ root: sourceRoot, installedRoot });
    assert.deepEqual(beforeInstall.sources.map((source) => ({ id: source.id, installed: source.installed })), [{ id: "demo-skill", installed: false }]);

    await installManagedSkillSource({ sourceId: "demo-skill", root: sourceRoot, skillRoot: installedRoot });
    const afterInstall = await listManagedSkillSources({ root: sourceRoot, installedRoot });
    assert.equal(afterInstall.sources[0]?.installed, true);
    assert.equal(await readFile(path.join(installedRoot, "demo-skill", "SKILL.md"), "utf8"), await readFile(sourceFile, "utf8"));
    await assert.rejects(
      () => installManagedSkillSource({ sourceId: "demo-skill", root: sourceRoot, skillRoot: installedRoot }),
      /Skill 已安装/
    );

    const externalDirectory = path.join(root, "external", "linked-skill");
    await mkdir(externalDirectory, { recursive: true });
    const externalFile = path.join(externalDirectory, "SKILL.md");
    await writeFile(externalFile, "---\nname: linked-skill\ndescription: Linked\n---\n");
    const linkedFile = path.join(root, "input", "linked-skill", "SKILL.md");
    await mkdir(path.dirname(linkedFile), { recursive: true });
    await symlink(externalFile, linkedFile);
    await assert.rejects(() => importManagedSkillSource({ sourceFile: linkedFile, root: sourceRoot, installedRoot }), /符号链接/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
