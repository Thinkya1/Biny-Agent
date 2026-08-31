/** 聊天默认能力设置：保存 Agent 每回合默认暴露的工具与 Skill 范围。 */
import type { CapabilitySelectionMode } from "../../../../../agent/capabilitySelection.js";
import type { DesktopChatParamsSettings } from "../../../../protocol.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

const selectionOptions: Array<{ value: CapabilitySelectionMode; label: string; detail: string }> = [
  { value: "auto", label: "自动", detail: "沿用当前运行时的默认能力面，由模型按需使用。" },
  { value: "all", label: "全部", detail: "向模型暴露当前已注册的全部能力。" },
  { value: "none", label: "不调用", detail: "本回合不向模型提供这一类能力。" }
];

export function SettingsCapabilityDefaults(): React.JSX.Element {
  const { draft, setChatParams } = useSettingsDraft();
  if (!draft) return <div className="settings-sections"><section><p>正在加载能力设置…</p></section></div>;

  const update = (patch: Partial<DesktopChatParamsSettings>): void => setChatParams({ ...draft.chatParams, ...patch });

  return (
    <div className="settings-sections capability-default-settings">
      <section id="chat-capability-defaults" tabIndex={-1}>
        <div className="section-heading-row">
          <div><h3>工具与 Skill</h3><p>设置每条新消息的默认能力范围；发送前可在输入框的“能力”菜单里临时自定义。</p></div>
          <span className="settings-scope-badge">全局</span>
        </div>
        <CapabilitySelectionField
          label="默认工具调用"
          value={draft.chatParams.defaultToolSelection}
          onChange={(defaultToolSelection) => update({ defaultToolSelection })}
        />
        <CapabilitySelectionField
          label="默认 Skill"
          value={draft.chatParams.defaultSkillSelection}
          onChange={(defaultSkillSelection) => update({ defaultSkillSelection })}
        />
      </section>
    </div>
  );
}

function CapabilitySelectionField({ label, onChange, value }: {
  label: string;
  onChange(value: CapabilitySelectionMode): void;
  value: CapabilitySelectionMode;
}): React.JSX.Element {
  return (
    <div className="capability-default-field">
      <strong>{label}</strong>
      <div aria-label={label} className="capability-default-grid" role="radiogroup">
        {selectionOptions.map((option) => (
          <button
            aria-checked={option.value === value}
            className={`capability-default-option${option.value === value ? " is-selected" : ""}`}
            key={option.value}
            onClick={() => onChange(option.value)}
            role="radio"
            type="button"
          >
            <span className="capability-default-option-title"><span className={`radio${option.value === value ? " is-selected" : ""}`} />{option.label}</span>
            <small>{option.detail}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
