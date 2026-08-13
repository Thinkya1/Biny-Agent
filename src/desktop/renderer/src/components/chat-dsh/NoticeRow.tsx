/**
 * 流内通知行（复刻 DSH ui-conversation MessageItem 的边界行）。
 * 上下文压缩和轮次级错误都是 transcript 里的普通行，不伪装成工具卡片。
 */
import { memo, useState } from "react";
import { Icon } from "../Icon.js";
import { StateDot, type StateDotState } from "./StateDot.js";

/** 轮次级错误：DSH TurnErrorItem 形态的紧凑单行，不附加卡片与按钮。 */
export const RunErrorRow = memo(function RunErrorRow({ message, title = "本轮运行失败", variant = "error" }: {
  message: string;
  /** 标题文案；blocked（被阻塞）等语义可覆盖。 */
  title?: string;
  /** 语义色：error 红 / warning 琥珀（DSH max-tokens 同款）。 */
  variant?: "error" | "warning";
}): React.JSX.Element {
  const dot: StateDotState = variant === "warning" ? "warning" : "error";
  return (
    <div className="dsh-run-error-row" data-variant={variant} role="alert">
      <span className="dsh-run-error-leading"><StateDot size={10} state={dot} /></span>
      <span className="dsh-run-error-title">{title}</span>
      <span aria-hidden="true" className="dsh-row-sep" />
      <span className="dsh-run-error-summary" title={message}>{message}</span>
    </div>
  );
});

/** 上下文压缩标记行：一行折叠态，可展开显示压缩摘要。 */
export const CompactionRow = memo(function CompactionRow({ title, summary, body }: {
  title: string;
  summary: string;
  /** 可选的展开摘要正文（无正文时行不可展开）。 */
  body?: string;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const expandable = body !== undefined && body !== "";
  return (
    <div className="dsh-compaction-row">
      <button
        aria-expanded={expanded}
        className="dsh-compaction-button"
        disabled={!expandable}
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <span className="dsh-compaction-leading">
          <span className="dsh-compaction-icon"><Icon name="archive" size={14} /></span>
          {expandable ? <span className="dsh-compaction-chevron"><Icon name="chevron" size={12} /></span> : null}
        </span>
        <span className="dsh-compaction-title">{title}</span>
        <span aria-hidden="true" className="dsh-row-sep" />
        <span className="dsh-compaction-summary">{summary}</span>
      </button>
      {expanded && expandable ? <div className="dsh-compaction-body">{body}</div> : null}
    </div>
  );
});
