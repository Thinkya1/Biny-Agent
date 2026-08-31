/**
 * 思考链块。
 *
 * 交互：
 * - 流式思考中自动展开：呼吸灯 + 微光标题，正文实时追加并贴底滚动（用户上翻则松手）；
 * - 思考结束自动收起成一行：✓ 思考完成 · 用时；点击可随时再展开/收起；
 * - 用户的手动展开/收起会覆盖自动行为，直到 running 翻转（新一轮思考）后失效。
 */
import { memo, useEffect, useRef, useState } from "react";
import { Icon } from "../Icon.js";
import { BreathingDot } from "./BreathingDot.js";
import { Collapse } from "./Collapse.js";

export const ThinkingBlock = memo(function ThinkingBlock({
  text,
  running,
  durationMs,
  summary,
}: {
  /** 思考全文（流式追加）。 */
  text: string;
  /** 是否为流式进行中。 */
  running: boolean;
  /** 思考耗时；结束后展示在标题行。 */
  durationMs?: number;
  /**
   * 紧凑模式摘要（聚合组内嵌用）：折叠态替代「思考完成」显示内容首行，且不再占位用时，
   * 让思考行在工具组里保持轻量（图标 + 摘要，可再展开看全文）。
   */
  summary?: string;
}): React.JSX.Element {
  // 自动策略：running 开 / 完成收；override 记住用户手动选择，状态翻转即作废。
  const [override, setOverride] = useState<{ running: boolean; open: boolean }>();
  const open = override && override.running === running ? override.open : running;
  const compact = summary !== undefined;

  const bodyRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // 新一轮思考重新贴底。
  useEffect(() => {
    if (running) pinnedRef.current = true;
  }, [running]);

  // 流式追加时把正文滚动条钉在底部。
  useEffect(() => {
    const element = bodyRef.current;
    if (!element || !running || !pinnedRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [text, running, open]);

  const handleScroll = (): void => {
    const element = bodyRef.current;
    if (!element) return;
    pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
  };

  return (
    <section className={`chat-thinking${running ? " is-running" : ""}${compact ? " chat-thinking--compact" : ""}`} data-state={running ? "running" : "done"}>
      {running ? <span className="chat-visually-hidden">正在思考</span> : null}
      <button
        aria-expanded={open}
        className="chat-row-header chat-thinking-header"
        onClick={() => setOverride({ running, open: !open })}
        type="button"
      >
        <span className="chat-row-leading">
          {running
            ? <BreathingDot breathing tone="accent" />
            : <Icon name="brain" size={14} />}
        </span>
        <span className={`chat-thinking-label${running ? " chat-shimmer-text" : ""}`} title={compact ? summary : undefined}>
          {running ? "正在思考" : summary ?? "思考"}
        </span>
        {!compact && !running && durationMs !== undefined ? (
          <span className="chat-thinking-rest">了 {Math.max(1, Math.round(durationMs / 1000))} 秒</span>
        ) : null}
        <span className="chat-row-chevron"><Icon name="chevron" size={12} /></span>
      </button>
      <Collapse open={open}>
        <div className="chat-thinking-body" onScroll={handleScroll} ref={bodyRef}>
          <div className="chat-thinking-text">{text}</div>
        </div>
      </Collapse>
    </section>
  );
});
