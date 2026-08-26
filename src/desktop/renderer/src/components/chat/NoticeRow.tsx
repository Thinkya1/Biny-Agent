/**
 * 流内通知行：上下文压缩标记。
 * 是 transcript 里的普通行，不伪装成工具卡片。
 * 轮次级失败/未完成输出走 `RunErrorCard`（统一的错误卡片）。
 */
import { memo, useState } from "react";
import { Icon } from "../Icon.js";

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
    <div className={`chat-notice is-compaction${expanded ? " is-open" : ""}`}>
      <button
        aria-expanded={expandable ? expanded : undefined}
        className="chat-row-header chat-notice-header"
        disabled={!expandable}
        onClick={expandable ? () => setExpanded((current) => !current) : undefined}
        type="button"
      >
        <span className="chat-row-leading"><Icon name="archive" size={13} /></span>
        <span className="chat-notice-title">{title}</span>
        <span className="chat-notice-summary" title={summary}>{summary}</span>
        {expandable ? <span className="chat-row-chevron"><Icon name="chevron" size={12} /></span> : null}
      </button>
      {expanded && expandable ? <div className="chat-notice-body">{body}</div> : null}
    </div>
  );
});
