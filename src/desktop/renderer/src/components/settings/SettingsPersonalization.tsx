/**
 * 个性化设置：全局人格/自定义指令/记忆偏好，以及当前聊天的轻量覆盖。
 *
 * 组件只维护表单状态，所有持久化都通过上层回调进入 preload/main/runtime。
 */
import { useCallback, useEffect, useState } from "react";
import type {
  DesktopChatPersonalizationOverride,
  DesktopPersonalizationOverview,
  DesktopPersonalizationSettingsInput,
  DesktopPersonality
} from "../../../../protocol.js";

interface SettingsPersonalizationProps {
  sessionId?: string;
  sessionRunning: boolean;
  onLoad(sessionId?: string): Promise<DesktopPersonalizationOverview>;
  onSaveSettings(input: DesktopPersonalizationSettingsInput, sessionId?: string): Promise<DesktopPersonalizationOverview>;
  onSaveChat(
    sessionId: string,
    input: DesktopChatPersonalizationOverride,
    expectedRevision: string
  ): Promise<DesktopPersonalizationOverview>;
  onNotify(message: string): void;
}

const personalityOptions: Array<{ value: DesktopPersonality; label: string; detail: string }> = [
  { value: "none", label: "默认", detail: "保持简洁、中性的 Biny 默认表达。" },
  { value: "friendly", label: "友好", detail: "更温和、主动解释，并保留技术准确性。" },
  { value: "pragmatic", label: "务实", detail: "优先结论、约束与可执行的下一步。" }
];

const defaultChatOverride: DesktopChatPersonalizationOverride = {
  personality: "inherit",
  customInstructions: { mode: "inherit", value: undefined },
  useMemories: "inherit",
  contributeMemories: "inherit"
};

export function SettingsPersonalization({
  sessionId,
  sessionRunning,
  onLoad,
  onSaveSettings,
  onSaveChat,
  onNotify
}: SettingsPersonalizationProps): React.JSX.Element {
  const [overview, setOverview] = useState<DesktopPersonalizationOverview>();
  const [loadError, setLoadError] = useState<string>();
  const [enabled, setEnabled] = useState(true);
  const [personality, setPersonality] = useState<DesktopPersonality>("none");
  const [customInstructions, setCustomInstructions] = useState("");
  const [useMemories, setUseMemories] = useState(true);
  const [generateMemories, setGenerateMemories] = useState(true);
  const [chatOverride, setChatOverride] = useState<DesktopChatPersonalizationOverride>(defaultChatOverride);
  const [busy, setBusy] = useState(false);

  const adopt = useCallback((next: DesktopPersonalizationOverview): void => {
    setOverview(next);
    setEnabled(next.settings.enabled);
    setPersonality(next.settings.personality);
    setCustomInstructions(next.settings.customInstructions);
    setUseMemories(next.memory.useMemories);
    setGenerateMemories(next.memory.generateMemories);
    setChatOverride(next.chat?.override ?? defaultChatOverride);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadError(undefined);
    onLoad(sessionId)
      .then((next) => { if (!cancelled) adopt(next); })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, [adopt, onLoad, sessionId]);

  if (loadError) {
    return <div className="settings-sections"><section><h3>无法加载个性化设置</h3><p>{loadError}</p></section></div>;
  }
  if (!overview) return <div className="settings-sections"><section><p>正在加载个性化设置…</p></section></div>;

  const customInstructionBytes = utf8ByteLength(customInstructions);
  const globalDirty = enabled !== overview.settings.enabled
    || personality !== overview.settings.personality
    || customInstructions !== overview.settings.customInstructions
    || useMemories !== overview.memory.useMemories
    || generateMemories !== overview.memory.generateMemories;
  const chatDirty = overview.chat !== undefined && !chatOverridesEqual(chatOverride, overview.chat.override);
  const chatInstructionBytes = utf8ByteLength(chatOverride.customInstructions.value ?? "");

  const saveGlobal = async (): Promise<void> => {
    if (busy || sessionRunning || customInstructionBytes > 4_096) return;
    setBusy(true);
    try {
      adopt(await onSaveSettings({
        expectedRevision: overview.configRevision,
        settings: { enabled, personality, customInstructions },
        memory: { ...overview.memory, useMemories, generateMemories }
      }, sessionId));
      onNotify("个性化设置已保存");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error));
      try {
        adopt(await onLoad(sessionId));
      } catch {
        // 保留最初的保存错误；重新打开设置时还会再次加载。
      }
    } finally {
      setBusy(false);
    }
  };

  const saveChat = async (): Promise<void> => {
    if (!sessionId || !overview.chat || busy || sessionRunning || chatInstructionBytes > 4_096) return;
    setBusy(true);
    try {
      adopt(await onSaveChat(sessionId, normalizedChatOverride(chatOverride), overview.chat.metadataRevision));
      onNotify("当前聊天覆盖已保存");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error));
      try {
        adopt(await onLoad(sessionId));
      } catch {
        // 保留最初的 catalog CAS/运行状态错误。
      }
    } finally {
      setBusy(false);
    }
  };

  const blockedHint = sessionRunning ? "当前任务运行中，完成或停止后才能修改。" : "保存后从下一根回合生效。";
  return (
    <div className="settings-sections personalization-settings">
      <section>
        <div className="section-heading-row">
          <div><h3>全局默认</h3><p>应用到所有项目和新聊天；聊天级覆盖优先于这里。</p></div>
          <span className="settings-scope-badge">全局</span>
        </div>
        <div className="setting-row">
          <span><strong>启用个性化</strong><small>将人格与自定义指令加入每个新根回合的系统上下文</small></span>
          <button aria-checked={enabled} className={`setting-switch${enabled ? " is-on" : ""}`} disabled={busy || sessionRunning} onClick={() => setEnabled((value) => !value)} role="switch" type="button"><span className="setting-switch-knob" /></button>
        </div>
      </section>

      <section>
        <h3>人格</h3>
        <div aria-label="全局人格" className="personality-option-grid" role="radiogroup">
          {personalityOptions.map((option) => (
            <button
              aria-checked={personality === option.value}
              className={`personality-option${personality === option.value ? " is-selected" : ""}`}
              disabled={!enabled || busy || sessionRunning}
              key={option.value}
              onClick={() => setPersonality(option.value)}
              role="radio"
              type="button"
            >
              <strong>{option.label}</strong>
              <small>{option.detail}</small>
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="section-heading-row">
          <div><h3>自定义指令</h3><p>告诉 Biny 你的长期偏好、表达方式与固定约束。</p></div>
          <span className={customInstructionBytes > 4_096 ? "settings-byte-count is-over" : "settings-byte-count"}>{formatBytes(customInstructionBytes)} / 4 KiB</span>
        </div>
        <textarea
          className="personalization-instructions"
          disabled={!enabled || busy || sessionRunning}
          onChange={(event) => setCustomInstructions(event.target.value)}
          placeholder="例如：优先给出结论；代码注释使用中文；不要自动提交 Git…"
          rows={6}
          value={customInstructions}
        />
      </section>

      <section>
        <h3>记忆偏好</h3>
        <div className="setting-row">
          <span><strong>使用记忆</strong><small>在新根回合中检索相关的全局与项目记忆</small></span>
          <button aria-checked={useMemories} className={`setting-switch${useMemories ? " is-on" : ""}`} disabled={busy || sessionRunning} onClick={() => setUseMemories((value) => !value)} role="switch" type="button"><span className="setting-switch-knob" /></button>
        </div>
        <div className="setting-row">
          <span><strong>生成记忆</strong><small>任务成功后提取可复用信息；关闭后仍可使用已有记忆</small></span>
          <button aria-checked={generateMemories} className={`setting-switch${generateMemories ? " is-on" : ""}`} disabled={busy || sessionRunning} onClick={() => setGenerateMemories((value) => !value)} role="switch" type="button"><span className="setting-switch-knob" /></button>
        </div>
        <p className={`settings-effective-hint${sessionRunning ? " is-blocked" : ""}`}>{blockedHint}</p>
        <div className="settings-button-row">
          <button disabled={busy || sessionRunning || !globalDirty || customInstructionBytes > 4_096} onClick={() => { void saveGlobal(); }} type="button">{busy ? "保存中…" : "保存全局设置"}</button>
        </div>
      </section>

      {sessionId && overview.chat ? (
        <section className="chat-personalization-section">
          <div className="section-heading-row">
            <div><h3>当前聊天</h3><p>只覆盖这个聊天，不改动全局默认。</p></div>
            <span className="settings-scope-badge is-chat">聊天</span>
          </div>
          <div className="chat-override-grid">
            <label>
              <span>人格</span>
              <select disabled={busy || sessionRunning} onChange={(event) => setChatOverride((current) => ({ ...current, personality: event.target.value as DesktopChatPersonalizationOverride["personality"] }))} value={chatOverride.personality}>
                <option value="inherit">继承全局</option>
                <option value="none">默认</option>
                <option value="friendly">友好</option>
                <option value="pragmatic">务实</option>
              </select>
            </label>
            <label>
              <span>自定义指令</span>
              <select disabled={busy || sessionRunning} onChange={(event) => setChatOverride((current) => ({ ...current, customInstructions: { ...current.customInstructions, mode: event.target.value as DesktopChatPersonalizationOverride["customInstructions"]["mode"] } }))} value={chatOverride.customInstructions.mode}>
                <option value="inherit">继承全局</option>
                <option value="replace">替换为本聊天指令</option>
                <option value="disabled">本聊天停用</option>
              </select>
            </label>
            <label>
              <span>使用记忆</span>
              <select disabled={busy || sessionRunning} onChange={(event) => setChatOverride((current) => ({ ...current, useMemories: parseInheritedBoolean(event.target.value) }))} value={String(chatOverride.useMemories)}>
                <option value="inherit">继承全局</option>
                <option value="true">使用</option>
                <option value="false">不使用</option>
              </select>
            </label>
            <label>
              <span>生成记忆</span>
              <select disabled={busy || sessionRunning} onChange={(event) => setChatOverride((current) => ({ ...current, contributeMemories: parseInheritedBoolean(event.target.value) }))} value={String(chatOverride.contributeMemories)}>
                <option value="inherit">继承全局</option>
                <option value="true">生成</option>
                <option value="false">不生成</option>
              </select>
            </label>
          </div>
          {chatOverride.customInstructions.mode === "replace" ? (
            <div className="chat-instructions-field">
              <div><span>本聊天指令</span><small className={chatInstructionBytes > 4_096 ? "settings-byte-count is-over" : "settings-byte-count"}>{formatBytes(chatInstructionBytes)} / 4 KiB</small></div>
              <textarea disabled={busy || sessionRunning} onChange={(event) => setChatOverride((current) => ({ ...current, customInstructions: { ...current.customInstructions, value: event.target.value } }))} rows={4} value={chatOverride.customInstructions.value ?? ""} />
            </div>
          ) : null}
          <p className="settings-effective-hint">
            当前实际：{personalityLabel(overview.chat.effective.personality)} · {overview.chat.effective.useMemories ? "使用记忆" : "不使用记忆"} · {overview.chat.effective.contributeMemories ? "生成记忆" : "不生成记忆"}
          </p>
          <p className={`settings-effective-hint${sessionRunning ? " is-blocked" : ""}`}>{blockedHint}</p>
          <div className="settings-button-row">
            <button disabled={busy || sessionRunning || !chatDirty || chatInstructionBytes > 4_096} onClick={() => { void saveChat(); }} type="button">{busy ? "保存中…" : "保存聊天覆盖"}</button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function normalizedChatOverride(input: DesktopChatPersonalizationOverride): DesktopChatPersonalizationOverride {
  return {
    ...input,
    customInstructions: {
      mode: input.customInstructions.mode,
      value: input.customInstructions.mode === "replace" ? input.customInstructions.value ?? "" : undefined
    }
  };
}

function chatOverridesEqual(left: DesktopChatPersonalizationOverride, right: DesktopChatPersonalizationOverride): boolean {
  const normalizedLeft = normalizedChatOverride(left);
  const normalizedRight = normalizedChatOverride(right);
  return normalizedLeft.personality === normalizedRight.personality
    && normalizedLeft.customInstructions.mode === normalizedRight.customInstructions.mode
    && normalizedLeft.customInstructions.value === normalizedRight.customInstructions.value
    && normalizedLeft.useMemories === normalizedRight.useMemories
    && normalizedLeft.contributeMemories === normalizedRight.contributeMemories;
}

function parseInheritedBoolean(value: string): "inherit" | boolean {
  if (value === "inherit") return value;
  return value === "true";
}

function personalityLabel(value: DesktopPersonality): string {
  return personalityOptions.find((option) => option.value === value)?.label ?? "默认";
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function formatBytes(bytes: number): string {
  return bytes < 1_024 ? `${String(bytes)} B` : `${(bytes / 1_024).toFixed(1)} KiB`;
}
