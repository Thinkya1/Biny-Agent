/** 统一设置草稿中的个性化分页；不直接持久化。 */
import type { DesktopChatPersonalizationOverride, DesktopPersonality } from "../../../../protocol.js";
import { SettingsCheckbox } from "./SettingsCheckbox.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

const personalityOptions: Array<{ value: DesktopPersonality; label: string; detail: string }> = [
  { value: "none", label: "默认", detail: "保持简洁、中性的 Biny 默认表达。" },
  { value: "friendly", label: "友好", detail: "更温和、主动解释，并保留技术准确性。" },
  { value: "pragmatic", label: "务实", detail: "优先结论、约束与可执行的下一步。" }
];

export function SettingsPersonalizationDraft({ sessionRunning }: { sessionRunning: boolean }): React.JSX.Element {
  const { draft, setChat, setPersonalization, snapshot } = useSettingsDraft();
  if (!draft || !snapshot) return <div className="settings-sections"><section><p>正在加载个性化设置…</p></section></div>;
  const settings = draft.personalization;
  const chat = draft.chat;
  const instructionBytes = new TextEncoder().encode(settings.customInstructions).byteLength;
  const chatInstructionBytes = new TextEncoder().encode(chat?.customInstructions.value ?? "").byteLength;
  const updateChat = (patch: Partial<DesktopChatPersonalizationOverride>): void => {
    if (chat) setChat({ ...chat, ...patch });
  };
  return (
    <div className="settings-sections personalization-settings">
      <section id="personalization-global" tabIndex={-1}>
        <div className="section-heading-row">
          <div><h3>全局默认</h3><p>应用到所有项目和新聊天；修改会与其他设置一起保存。</p></div>
          <span className="settings-scope-badge">全局</span>
        </div>
        <SettingsCheckbox checked={settings.enabled} detail="将人格与自定义指令加入每个新根回合的系统上下文" label="启用个性化" onChange={(enabled) => setPersonalization({ ...settings, enabled })} />
      </section>

      <section>
        <h3>人格</h3>
        <div aria-label="全局人格" className="personality-option-grid" role="radiogroup">
          {personalityOptions.map((option) => (
            <button aria-checked={settings.personality === option.value} className={`personality-option${settings.personality === option.value ? " is-selected" : ""}`} disabled={!settings.enabled} key={option.value} onClick={() => setPersonalization({ ...settings, personality: option.value })} role="radio" type="button">
              <strong>{option.label}</strong><small>{option.detail}</small>
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="section-heading-row">
          <div><h3>自定义指令</h3><p>告诉 Biny 你的长期偏好、表达方式与固定约束。</p></div>
          <span className={`settings-byte-count${instructionBytes > 4_096 ? " is-over" : ""}`}>{formatBytes(instructionBytes)} / 4 KiB</span>
        </div>
        <textarea className="personalization-instructions" disabled={!settings.enabled} onChange={(event) => setPersonalization({ ...settings, customInstructions: event.target.value })} placeholder="例如：优先给出结论；代码注释使用中文；不要自动提交 Git…" rows={6} value={settings.customInstructions} />
      </section>

      {snapshot.chat && chat ? (
        <section className="chat-personalization-section" id="personalization-chat" tabIndex={-1}>
          <div className="section-heading-row">
            <div><h3>当前聊天</h3><p>只覆盖这个聊天，不改动全局默认。</p></div>
            <span className="settings-scope-badge is-chat">聊天</span>
          </div>
          <div className="chat-override-grid">
            <label><span>人格</span><select onChange={(event) => updateChat({ personality: event.target.value as DesktopChatPersonalizationOverride["personality"] })} value={chat.personality}><option value="inherit">继承全局</option><option value="none">默认</option><option value="friendly">友好</option><option value="pragmatic">务实</option></select></label>
            <label><span>自定义指令</span><select onChange={(event) => updateChat({ customInstructions: { mode: event.target.value as DesktopChatPersonalizationOverride["customInstructions"]["mode"], value: event.target.value === "replace" ? chat.customInstructions.value ?? "" : undefined } })} value={chat.customInstructions.mode}><option value="inherit">继承全局</option><option value="replace">替换为本聊天指令</option><option value="disabled">本聊天停用</option></select></label>
            <label><span>使用记忆</span><select onChange={(event) => updateChat({ useMemories: inheritedBoolean(event.target.value) })} value={String(chat.useMemories)}><option value="inherit">继承全局</option><option value="true">使用</option><option value="false">不使用</option></select></label>
            <label><span>生成记忆</span><select onChange={(event) => updateChat({ contributeMemories: inheritedBoolean(event.target.value) })} value={String(chat.contributeMemories)}><option value="inherit">继承全局</option><option value="true">生成</option><option value="false">不生成</option></select></label>
          </div>
          {chat.customInstructions.mode === "replace" ? (
            <div className="chat-instructions-field">
              <div><span>本聊天指令</span><small className={`settings-byte-count${chatInstructionBytes > 4_096 ? " is-over" : ""}`}>{formatBytes(chatInstructionBytes)} / 4 KiB</small></div>
              <textarea onChange={(event) => updateChat({ customInstructions: { mode: "replace", value: event.target.value } })} rows={4} value={chat.customInstructions.value ?? ""} />
            </div>
          ) : null}
        </section>
      ) : null}
      <p className={`settings-effective-hint${sessionRunning ? " is-blocked" : ""}`}>
        {sessionRunning ? "当前任务运行中：可以继续编辑，保存将在任务完成或停止后可用。" : "保存后从下一根回合生效。"}
      </p>
    </div>
  );
}

function inheritedBoolean(value: string): "inherit" | boolean {
  return value === "inherit" ? "inherit" : value === "true";
}

function formatBytes(bytes: number): string {
  return bytes < 1_024 ? `${String(bytes)} B` : `${(bytes / 1_024).toFixed(1)} KiB`;
}
