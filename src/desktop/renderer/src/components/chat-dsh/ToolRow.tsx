/**
 * 工具调用折叠行（复刻 DSH ui-tool ToolRow，figma 122:9479）。
 *
 * 24px 单行：`[16px leading] gap6 [标题] gap8 [2×2 分隔点] gap8 [摘要 FILL 截断]`；
 * leading 槽状态替换：error → 红点、stopped → 琥珀点，running/ok 保留变体图标（运行信号
 * 由行扫光承担）；错误行的折叠摘要即失败首行（错误色）；
 * 文件路径摘要只做高亮，点击仍由整行统一处理展开/收起。展开体由调用方传入。
 */
import { memo, type ReactNode } from "react";
import { Icon, type IconName } from "../Icon.js";
import { VARIANT_ICON_NAMES, type ToolRowState, type ToolRowVariant } from "../../chatDshModel.js";
import { StateDot } from "./StateDot.js";
import { DisclosureRow } from "./DisclosureRow.js";

export interface ToolRowProps {
  variant: ToolRowVariant;
  state: ToolRowState;
  title: string;
  /** 折叠摘要文本；错误行会被 `errorSummary` 整体替换。 */
  summary: string;
  /** 错误首行（错误行折叠摘要）；null 表示非错误行。 */
  errorSummary?: string | null;
  /** 是否可展开（有正文/输出/卡片）。 */
  expandable: boolean;
  expanded: boolean;
  onToggle(): void;
  /** 文件目标摘要只做视觉高亮，不改变整行的交互语义。 */
  highlightSummary?: boolean;
  /** 折叠态的时长标签（如 `12s`），放在摘要之后。 */
  durationLabel?: string;
  /** 展开体内容。 */
  children?: ReactNode;
  className?: string;
}

/** leading 槽状态替换：错误/打断换状态点，其余保留变体图标。 */
function leadingFor(state: ToolRowState, iconName: IconName): React.JSX.Element {
  if (state === "error") return <StateDot state="error" />;
  if (state === "stopped") return <StateDot state="warning" />;
  return <Icon name={iconName} size={14} />;
}

/** 渲染一个工具调用折叠行。 */
export const ToolRow = memo(function ToolRow({
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
  className,
}: ToolRowProps): React.JSX.Element {
  const failureLine = state === "error" ? errorSummary ?? null : null;
  const summaryText = failureLine ?? summary;
  return (
    <section
      className={`dsh-tool-row${className ? ` ${className}` : ""}`}
      data-state={state}
      data-variant={variant}
    >
      {state !== "ok" ? <span className="dsh-visually-hidden">{stateLabel(state)}</span> : null}
      <DisclosureRow
        expandable={expandable}
        icon={leadingFor(state, VARIANT_ICON_NAMES[variant])}
        keepContentWhenOpen
        onToggle={onToggle}
        open={expanded}
        summary={summaryText !== "" && (
          <>
            <span aria-hidden="true" className="dsh-row-sep" />
            <span className={`dsh-tool-summary${failureLine !== null ? " is-error" : highlightSummary ? " is-target" : ""}`}>{summaryText}</span>
            {durationLabel !== undefined ? <span className="dsh-tool-duration">{durationLabel}</span> : null}
          </>
        )}
        title={title}
      >
        {children}
      </DisclosureRow>
    </section>
  );
});

function stateLabel(state: ToolRowState): string {
  if (state === "running") return "正在执行";
  if (state === "error") return "执行失败";
  if (state === "stopped") return "已中断";
  return "";
}
