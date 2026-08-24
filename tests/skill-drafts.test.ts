import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { approveSkillDraft, createSkillDraft, editSkillDraft, rejectSkillDraft, retrySkillDraft } from "../src/extensions/skillDrafts.js";

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-skill-drafts-"));
  try {
    const initial = "---\nname: repeatable-workflow\ndescription: A reusable local workflow.\n---\n\nDo the first step.\n";
    const draft = await createSkillDraft({
      workspaceRoot,
      name: "repeatable-workflow",
      description: "A reusable local workflow.",
      content: initial,
      toolCalls: 5
    });
    const edited = await editSkillDraft(workspaceRoot, draft.id, "---\nname: repeatable-workflow\ndescription: A reusable local workflow.\n---\n\nDo the edited step.\n");
    assert.equal(edited.status, "pending");
    assert.match(edited.content, /edited step/u);

    const approved = await approveSkillDraft(workspaceRoot, draft.id);
    assert.equal(approved.status, "approved");
    assert.equal(approved.installedPath, ".biny/skills/repeatable-workflow/SKILL.md");
    assert.match(await readFile(path.join(workspaceRoot, ".biny", "skills", "repeatable-workflow", "SKILL.md"), "utf8"), /edited step/u);

    const duplicate = await createSkillDraft({
      workspaceRoot,
      name: "repeatable-workflow",
      description: "A reusable local workflow.",
      content: initial,
      toolCalls: 6,
      status: "failed",
      error: "temporary failure"
    });
    const retried = await retrySkillDraft(workspaceRoot, duplicate.id);
    assert.equal(retried.status, "pending");
    await assert.rejects(() => approveSkillDraft(workspaceRoot, duplicate.id), /同名 Skill/u);
    const rejected = await rejectSkillDraft(workspaceRoot, duplicate.id);
    assert.equal(rejected.status, "rejected");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

void main();
