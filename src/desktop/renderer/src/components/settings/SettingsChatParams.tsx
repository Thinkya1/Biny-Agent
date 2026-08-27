/** 聊天采样参数分页：温度与最大输出令牌，统一走设置草稿，保存时进入主进程事务。 */
import type { DesktopChatParamsSettings } from "../../../../protocol.js";
import { OptionalNumberField } from "./SettingsCompaction.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

/** 温度滑块的展示默认值；未配置时不下发 temperature，由模型/provider 自行决定。 */
const temperatureDisplayDefault = 0.7;

export function SettingsChatParams(): React.JSX.Element {
  const { draft, setChatParams } = useSettingsDraft();
  if (!draft) return <div className="settings-sections"><section><p>正在加载聊天参数…</p></section></div>;
  const chatParams = draft.chatParams;
  const update = (patch: Partial<DesktopChatParamsSettings>): void => setChatParams({ ...chatParams, ...patch });

  const temperatureSet = chatParams.temperature !== undefined;

  return (
    <div className="settings-sections chat-params-settings">
      <section id="chat-params-temperature" tabIndex={-1}>
        <div className="section-heading-row">
          <div><h3>聊天参数</h3><p>控制每次回复的采样行为；留空时跟随模型或 provider 的默认值。</p></div>
          <span className="settings-scope-badge">全局</span>
        </div>
        <label className="compaction-threshold-field">
          <span>
            <strong>温度</strong>
            <em>{temperatureSet ? chatParams.temperature?.toFixed(1) : "模型默认"}</em>
          </span>
          <input
            aria-label="温度"
            max={200}
            min={0}
            onChange={(event) => update({ temperature: Number(event.target.value) / 100 })}
            type="range"
            value={Math.round((chatParams.temperature ?? temperatureDisplayDefault) * 100)}
          />
          <span className="chat-temperature-scale"><i>精确 0.0</i><i>平衡 1.0</i><i>创造 2.0</i></span>
        </label>
        <small className="compaction-hint">
          温度越低回答越确定，越高越发散。{temperatureSet
            ? "当前为自定义值，会写入每个请求。"
            : "未自定义：不在请求里下发温度，由模型自己决定。"}
          {temperatureSet ? (
            <button className="chat-temperature-reset" onClick={() => update({ temperature: undefined })} type="button">恢复模型默认</button>
          ) : null}
        </small>
      </section>

      <section id="chat-params-max-tokens" tabIndex={-1}>
        <h3>输出额度</h3>
        <p>单次回复允许生成的最大 token 数；留空跟随模型别名配置。</p>
        <OptionalNumberField
          hint="全局覆盖所有模型的输出上限；Anthropic 扩展思考开启时会自动抬高到思考预算之上。"
          id="chat-max-output-tokens"
          label="最大令牌数"
          max={131_072}
          min={256}
          onCommit={(maxOutputTokens) => update({ maxOutputTokens })}
          unit="tokens"
          value={chatParams.maxOutputTokens}
        />
      </section>
    </div>
  );
}
