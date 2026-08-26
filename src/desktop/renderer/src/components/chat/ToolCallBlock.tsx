/**
 * 工具调用块。
 *
 * 单行头部：状态指示 + 变体图标 + 标题 + 摘要 + 用时 + chevron，整行点击展开/收起。
 * 运行中：图标芯片带呼吸光环（呼吸灯），用时实时跳动；
 * 失败/中断：图标芯片染成对应语义色，折叠摘要替换为错误首行；
 * 展开体由调用方承载（权限卡、命令日志、diff、文件变更、网页搜索等）。
 */
import { memo, type ReactNode } from "react";
import { type ToolRowState, type ToolRowVariant, VARIANT_ICON_NAMES } from "../../chatModel.js";
import { Icon } from "../Icon.js";
import { BreathingDot } from "./BreathingDot.js";
import { Collapse } from "./Collapse.js";

export interface ToolCallBlockProps {
  variant: ToolRowVariant;
  state: ToolRowState;
  title: string;
  /** 折叠摘要文本；错误行会被 `errorSummary` 整体替换。 */
  summary: string;
  /** 错误首行（错误行折叠摘要）；null/undefined 表示非错误行。 */
  errorSummary?: string | null;
  /** 是否有展开体。 */
  expandable: boolean;
  expanded: boolean;
  onToggle(): void;
  /** 文件路径摘要只做视觉高亮，不改变整行的交互语义。 */
  highlightSummary?: boolean;
  /** 用时标签（如 `12s`），运行中实时跳动。 */
  durationLabel?: string;
  children?: ReactNode;
}

export const ToolCallBlock = memo(function ToolCallBlock({
  variant,
  state,
  title,
  summary,
  errorSummary,
  expandable,
  expanded,
  onToggle,
  highlightSummary = false,
  durationLabel,
  children,
}: ToolCallBlockProps): React.JSX.Element {
  const failureLine = state === "error" ? errorSummary ?? null : null;
  const summaryText = failureLine ?? summary;
  return (
    <section
      className={`chat-tool${expanded ? " is-open" : ""}`}
      data-state={state}
      data-variant={variant}
    >
      {state !== "ok" ? <span className="chat-visually-hidden">{stateLabel(state)}</span> : null}
      <button
        aria-expanded={expandable ? expanded : undefined}
        className="chat-row-header chat-tool-header"
        disabled={!expandable}
        onClick={expandable ? onToggle : undefined}
        type="button"
      >
        <span className="chat-tool-icon">
          {state === "running"
            ? <BreathingDot breathing tone="accent" />
            : <Icon name={VARIANT_ICON_NAMES[variant]} size={14} />}
        </span>
        <span className="chat-tool-title">{title}</span>
        {summaryText !== "" ? (
          <span
            className={`chat-tool-summary${failureLine !== null ? " is-error" : highlightSummary ? " is-target" : ""}`}
            title={summaryText}
          >
            {summaryText}
          </span>
        ) : null}
        {durationLabel !== undefined ? <span className="chat-row-meta chat-tool-duration">{durationLabel}</span> : null}
        {expandable ? <span className="chat-row-chevron"><Icon name="chevron" size={12} /></span> : null}
      </button>
      {expandable ? (
        <Collapse open={expanded}>
          <div className="chat-tool-body">{children}</div>
        </Collapse>
      ) : null}
    </section>
  );
});

function stateLabel(state: ToolRowState): string {
  if (state === "running") return "正在执行";
  if (state === "error") return "执行失败";
  if (state === "stopped") return "已中断";
  return "";
}
