import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSkills } from "../src/extensions/skills.js";
import { resolveSkillActivation, setSkillActivation } from "../src/extensions/skillActivation.js";
import { createSkillRef } from "../src/extensions/skillRef.js";

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-skill-activation-"));
  try {
    const skillDirectory = path.join(workspaceRoot, ".biny", "skills", "demo-skill");
    const globalRoot = path.join(workspaceRoot, "global-skills");
    await mkdir(skillDirectory, { recursive: true });
    await mkdir(globalRoot, { recursive: true });
    await writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: demo-skill\ndescription: A test skill.\n---\n\nUse the test skill.\n", "utf8");

    const ref = createSkillRef({ scope: "project", name: "demo-skill", projectRoot: await realpath(workspaceRoot), source: "biny" });
    assert.deepEqual(resolveSkillActivation({ ref }), {
      enabled: true,
      globalEnabled: true,
      projectOverride: undefined,
      source: "default"
    });
    assert.equal(resolveSkillActivation({ ref, globalDefaults: { [ref]: false } }).enabled, false);
    assert.equal(resolveSkillActivation({ ref, globalDefaults: { [ref]: false }, projectOverrides: { [ref]: true } }).enabled, true);
    assert.equal(resolveSkillActivation({ ref, globalDefaults: { [ref]: false }, projectOverrides: { [ref]: true } }).source, "project");
    assert.deepEqual(setSkillActivation({ [ref]: false }, ref, undefined), {});

    const disabled = await loadSkills({
      workspaceRoot,
      projectPaths: [".biny/skills"],
      globalRoot,
      globalDefaults: { [ref]: false }
    });
    assert.deepEqual(disabled.skills.map((skill) => skill.ref), [], JSON.stringify({ expectedRef: ref, actual: disabled.skills.map((skill) => skill.ref) }));
    assert.equal(disabled.prompt, "");

    const projectEnabled = await loadSkills({
      workspaceRoot,
      projectPaths: [".biny/skills"],
      globalRoot,
      globalDefaults: { [ref]: false },
      projectOverrides: { [ref]: true }
    });
    assert.deepEqual(projectEnabled.skills.map((skill) => skill.ref), [ref]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

void main();
