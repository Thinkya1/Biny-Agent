/**
 * 消息时钟标签（复刻 DSH ui-conversation message-chrome 的时钟行）。
 *
 * 日期感知时钟（当天 HH:mm / 今年 M/D HH:mm / 跨年 Y/M/D HH:mm）+ 可选
 * `· LLM X`（模型耗时 = TTFT + 解码）、`· 首 token Xs`（TTFT）、`· N tok/s`（解码吞吐）；
 * LLM 时长不可用时回退整轮墙钟 `· 用时 X`。纯展示文本；hover 揭示由外层
 * `data-time-hover-root` 的 CSS 控制。
 */
import { memo } from "react";
import {
  formatDuration,
  formatLatencySeconds,
  formatMessageClock,
  formatRunDuration,
  formatTokensPerSecond,
} from "../../chatDshModel.js";

export interface MessageClockProps {
  /** Unix epoch ms。 */
  time: number;
  /** 模型输出耗时（ms）；缺失时回退 `runMs`。 */
  llmMs?: number;
  /** 整轮墙钟（ms）。 */
  runMs?: number;
  /** 首 token 延迟（ms）。 */
  ttftMs?: number;
  /** 解码吞吐（tok/s）。 */
  tokensPerSecond?: number;
}

/** 渲染消息时钟与运行指标文本。 */
export const MessageClock = memo(function MessageClock({ time, llmMs, runMs, ttftMs, tokensPerSecond }: MessageClockProps): React.JSX.Element {
  const duration = llmMs !== undefined
    ? (<>
        <span aria-hidden="true" className="dsh-clock-dot">·</span>
        {" "}LLM {formatDuration(llmMs)}
      </>)
    : runMs !== undefined
      ? (<>
          <span aria-hidden="true" className="dsh-clock-dot">·</span>
          {" "}用时 {formatRunDuration(runMs)}
        </>)
      : null;
  return (
    <span className="dsh-message-clock">
      {formatMessageClock(time)}
      {duration}
      {ttftMs !== undefined ? (
        <>
          {" "}
          <span aria-hidden="true" className="dsh-clock-dot">·</span>
          {" "}首 token {formatLatencySeconds(ttftMs)}s
        </>
      ) : null}
      {tokensPerSecond !== undefined ? (
        <>
          {" "}
          <span aria-hidden="true" className="dsh-clock-dot">·</span>
          {" "}{formatTokensPerSecond(tokensPerSecond)} tok/s
        </>
      ) : null}
    </span>
  );
});
