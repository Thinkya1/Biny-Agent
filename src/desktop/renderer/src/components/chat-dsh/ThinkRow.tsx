/**
 * 思考折叠行（复刻 DSH ui-conversation ReasoningRow）。
 *
 * 折叠态：Think 标题 + 2×2 分隔点 + 摘要——运行中显示最后一行并贴尾滚动，完成后显示第一行；
 * 展开态：缩进灰色正文。运行中行内跑扫光动画。
 */
import { memo, useEffect, useRef } from "react";
import { Icon } from "../Icon.js";
import { DisclosureRow } from "./DisclosureRow.js";

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

function latestLine(text: string): string {
  const visible = text.trimEnd();
  const newline = visible.lastIndexOf("\n");
  return newline === -1 ? visible : visible.slice(newline + 1);
}

/** 渲染一条思考折叠行。 */
export const ThinkRow = memo(function ThinkRow({ text, running, expanded, onToggle }: {
  text: string;
  /** 是否为流式尾部（决定摘要跟随末尾与扫光）。 */
  running: boolean;
  expanded: boolean;
  onToggle(): void;
}): React.JSX.Element {
  const summaryRef = useRef<HTMLSpanElement>(null);
  const summary = running ? latestLine(text) : firstLine(text);

  // 运行中摘要贴尾滚动：把省略号截断的位置推到最右侧（合成滚动节流到帧）。
  useEffect(() => {
    const element = summaryRef.current;
    if (element === null) return;
    if (running) element.scrollLeft = element.scrollWidth - element.clientWidth;
    else element.scrollLeft = 0;
  }, [running, summary]);

  return (
    <section className={`dsh-think-row${running ? " is-running" : ""}`} data-state={running ? "running" : "ok"}>
      {running ? <span className="dsh-visually-hidden">正在思考</span> : null}
      <DisclosureRow
        expandable
        icon={<Icon name="brain" size={14} />}
        keepContentWhenOpen
        onToggle={onToggle}
        open={expanded}
        summary={(
          <>
            <span aria-hidden="true" className="dsh-row-sep" />
            <span className="dsh-think-summary" data-follow-end={running || undefined} ref={summaryRef}>{summary}</span>
          </>
        )}
        title="Think"
      >
        <div className="dsh-think-body">{text}</div>
      </DisclosureRow>
    </section>
  );
});
