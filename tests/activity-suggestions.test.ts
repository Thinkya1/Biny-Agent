import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActivityPrivacyPolicy } from "../src/activity/privacyPolicy.js";
import { createInMemoryActivitySuggestionCache, generateActivitySuggestions } from "../src/activity/suggestions.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { ActivityStore } from "../src/activity/store.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";

await testActivitySuggestionsAreGroundedAndCached();
await testActivitySuggestionsRespectAnalysisPolicy();

async function testActivitySuggestionsAreGroundedAndCached(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = store.startSession("2026-08-31T09:00:00.000Z");
    store.recordEvent({
      sessionId,
      occurredAt: "2026-08-31T09:00:01.000Z",
      eventType: "window_title",
      application: "Editor",
      windowTitle: "Activity suggestions"
    });
    store.endSession(sessionId, "2026-08-31T10:00:00.000Z");
    store.recordAnalysis({
      sessionId,
      analyzedAt: "2026-08-31T10:00:00.000Z",
      analyzerModel: "analyzer",
      project: "biny",
      title: "修复 Activity 检索",
      description: "完成中文检索与日报对齐。",
      summary: "完成 Activity 中文检索与日报对齐",
      topics: ["jieba", "日报"],
      prs: [],
      issues: [],
      people: [],
      versions: [],
      decisions: ["使用本地 FTS 分词"],
      entities: ["activity_fts"],
      highlights: ["接入中文分词"],
      worthMemory: false,
      worthKnowledge: false,
      isMeeting: false,
      storageTier: "standard",
      confidence: 1,
      sourceEventCount: 3,
      inputHash: "suggestions-test"
    });
    let calls = 0;
    let prompt = "";
    const model: AgentModel = {
      provider: "test",
      modelId: "suggestion-model",
      runtime: "builtin-llama.cpp",
      dataResidency: "local",
      stream: async (context) => {
        calls += 1;
        prompt = JSON.stringify(context.messages[0]?.content ?? "");
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          yield { type: "text-delta", text: JSON.stringify(["我想检查 biny 的 Activity 中文检索", "帮我回顾日报里的关键决定", "继续完善 jieba FTS"] ) };
          yield { type: "finish", reason: "stop" };
        })();
      }
    };
    const cache = createInMemoryActivitySuggestionCache();
    const deps = {
      store,
      policy: new ActivityPrivacyPolicy({ ...defaultActivitySettings, analysisPolicy: "external_allowed" as const }),
      model,
      now: new Date("2026-09-01T12:00:00.000Z"),
      cache
    };
    const first = await generateActivitySuggestions(deps);
    assert.equal(first.suggestions.length, 3);
    assert.equal(first.cached, false);
    assert.equal(calls, 1);
    assert.match(prompt, /biny/u);
    assert.match(prompt, /jieba/u);
    const second = await generateActivitySuggestions(deps);
    assert.equal(second.cached, true);
    assert.equal(calls, 1);
    const forced = await generateActivitySuggestions({ ...deps, force: true });
    assert.equal(forced.cached, false);
    assert.equal(calls, 2);
  });
}

async function testActivitySuggestionsRespectAnalysisPolicy(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = store.startSession("2026-08-31T09:00:00.000Z");
    store.endSession(sessionId, "2026-08-31T10:00:00.000Z");
    store.recordAnalysis({
      sessionId,
      analyzedAt: "2026-08-31T10:00:00.000Z",
      analyzerModel: "analyzer",
      summary: "有内容",
      topics: [],
      prs: [],
      issues: [],
      people: [],
      versions: [],
      decisions: [],
      entities: [],
      highlights: [],
      worthMemory: false,
      worthKnowledge: false,
      isMeeting: false,
      storageTier: "standard",
      confidence: 1,
      sourceEventCount: 3,
      inputHash: "blocked-suggestions-test"
    });
    let calls = 0;
    const model: AgentModel = {
      provider: "external",
      modelId: "cloud",
      runtime: "provider",
      stream: async () => {
        calls += 1;
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          yield { type: "finish", reason: "stop" };
        })();
      }
    };
    const result = await generateActivitySuggestions({
      store,
      policy: new ActivityPrivacyPolicy({ ...defaultActivitySettings, analysisPolicy: "local_only" as const }),
      model
    });
    assert.deepEqual(result.suggestions, []);
    assert.equal(result.reason, "blocked");
    assert.equal(calls, 0);
  });
}

async function withStore(run: (store: ActivityStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-suggestions-"));
  const store = new ActivityStore();
  try {
    await store.open(root);
    await run(store);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}
