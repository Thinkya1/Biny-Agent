/** 自动压缩设置分页：触发阈值、保留策略与摘要模型，统一走设置草稿，保存时进入主进程事务。 */
import { useEffect, useState } from "react";
import type { DesktopCompactionSettings } from "../../../../protocol.js";
import { SettingsCheckbox } from "./SettingsCheckbox.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

/** 可留空的数字输入：空文本提交为 undefined（交给后端自动推导），越界值夹取到 [min, max]。 */
export function OptionalNumberField({
  hint,
  id,
  label,
  max,
  min,
  onCommit,
  unit,
  value
}: {
  hint: string;
  id: string;
  label: string;
  max: number;
  min: number;
  onCommit(value: number | undefined): void;
  unit?: string;
  value: number | undefined;
}): React.JSX.Element {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => setText(value === undefined ? "" : String(value)), [value]);
  const commit = (): void => {
    if (text.trim() === "") {
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      setText(value === undefined ? "" : String(value));
      return;
    }
    const next = Math.min(max, Math.max(min, Math.trunc(parsed)));
    setText(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <label className="activity-field" htmlFor={id}>
      <span>{label}</span>
      <div className="activity-number-input"><input id={id} inputMode="numeric" max={max} min={min} onBlur={commit} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") commit(); }} placeholder="自动" type="number" value={text} />{unit ? <em>{unit}</em> : null}</div>
      <small>{hint}</small>
    </label>
  );
}

export function SettingsCompaction(): React.JSX.Element {
  const { draft, setCompaction, snapshot } = useSettingsDraft();
  if (!draft || !snapshot) return <div className="settings-sections"><section><p>正在加载压缩设置…</p></section></div>;
  const compaction = draft.compaction;
  const update = (patch: Partial<DesktopCompactionSettings>): void => setCompaction({ ...compaction, ...patch });

  // 阈值滑块以百分比交互，存储为 0.5–0.95 的小数；未配置时按 80% 展示（后端缺省自动推导）。
  const percent = Math.round((compaction.triggerPercent ?? 0.8) * 100);
  const modelChoices = snapshot.models.configured;

  return (
    <div className="settings-sections compaction-settings">
      <section id="compaction-enable" tabIndex={-1}>
        <div className="section-heading-row">
          <div><h3>自动压缩</h3><p>上下文接近上限时自动总结历史消息，让长对话不掉链子。</p></div>
          <span className="settings-scope-badge">全局</span>
        </div>
        <SettingsCheckbox checked={compaction.enabled} detail="关闭后上下文写满会直接报错，需要手动 /compact" label="启用自动压缩" onChange={(enabled) => update({ enabled })} />
      </section>

      <section id="compaction-threshold" tabIndex={-1}>
        <h3>触发阈值</h3>
        <p>上下文用量达到该比例时触发压缩。</p>
        <label className="compaction-threshold-field">
          <span><strong>压缩阈值</strong><em>{percent}%</em></span>
          <input aria-label="压缩阈值" disabled={!compaction.enabled} max={95} min={50} onChange={(event) => update({ triggerPercent: Number(event.target.value) / 100 })} type="range" value={percent} />
        </label>
        <small className="compaction-hint">高级设置里的「预留 token」显式配置时优先于此百分比。</small>
      </section>

      <section id="compaction-keep" tabIndex={-1}>
        <h3>保留策略</h3>
        <p>压缩后保留的最近消息；条数与 token 双上限，谁先撞到按谁。</p>
        <OptionalNumberField hint="压缩后至少保留的最近消息条数；留空按 token 预算自动推导。" id="compaction-keep-messages" label="保留最近消息数" max={500} min={1} onCommit={(keepRecentMessages) => update({ keepRecentMessages })} unit="条" value={compaction.keepRecentMessages} />
      </section>

      <section id="compaction-model" tabIndex={-1}>
        <h3>压缩模型</h3>
        <p>生成压缩摘要所用的模型；可选便宜的模型降低成本。</p>
        <select aria-label="压缩模型" className="compaction-model-select" disabled={!compaction.enabled} onChange={(event) => update({ summaryModel: event.target.value === "" ? undefined : event.target.value })} value={compaction.summaryModel ?? ""}>
          <option value="">跟随当前模型</option>
          {modelChoices.map((choice) => (
            <option key={choice.alias} value={choice.alias}>{choice.displayName ?? choice.alias}（{choice.alias}）</option>
          ))}
        </select>
      </section>

      <details className="compaction-advanced">
        <summary>高级</summary>
        <section id="compaction-advanced-tokens" tabIndex={-1}>
          <p>以下 token 级配置留空时按当前模型上下文窗口自动推导。</p>
          <OptionalNumberField hint="触发压缩前为模型输出预留的 token 数；显式配置后优先于触发阈值百分比。" id="compaction-reserve" label="预留 token" max={262_144} min={256} onCommit={(reserveTokens) => update({ reserveTokens })} unit="tokens" value={compaction.reserveTokens} />
          <OptionalNumberField hint="压缩后保留的最近消息 token 上限。" id="compaction-keep-tokens" label="保留段 token 上限" max={1_000_000} min={256} onCommit={(keepRecentTokens) => update({ keepRecentTokens })} unit="tokens" value={compaction.keepRecentTokens} />
          <OptionalNumberField hint="压缩摘要本身的最大长度。" id="compaction-summary-tokens" label="摘要最大 token" max={32_768} min={256} onCommit={(maxSummaryTokens) => update({ maxSummaryTokens })} unit="tokens" value={compaction.maxSummaryTokens} />
        </section>
      </details>
    </div>
  );
}
