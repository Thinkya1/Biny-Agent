/**
 * 折叠行外壳（复刻 DSH ui-primitives DisclosureRow）。
 *
 * 24px 单行：`[16px leading] gap6 [title 14/24] gap8 [2×2 分隔点] gap8 [摘要 FILL 截断]`。
 * 整行是展开开关（Enter/Space 亦可）；折叠时 leading 图标悬停交叉淡化为 chevron；
 * `data-state="running"` 时行内跑 300px 扫光（CSS 侧实现）。展开体由 children 承载。
 */
import { memo, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Icon } from "../Icon.js";

export interface DisclosureRowProps {
  /** leading 槽图标（折叠态显示；悬停时淡出换 chevron）。 */
  icon: ReactNode;
  title: string;
  open: boolean;
  expandable: boolean;
  onToggle(): void;
  /** 折叠态的摘要内容（标题后的分隔点与文本）。 */
  summary?: ReactNode;
  /** 展开后仍保留折叠摘要行。 */
  keepContentWhenOpen?: boolean;
  children?: ReactNode;
  className?: string;
}

/** 渲染一个折叠行外壳。 */
export const DisclosureRow = memo(function DisclosureRow({
  icon,
  title,
  open,
  expandable,
  onToggle,
  summary,
  keepContentWhenOpen = false,
  children,
  className,
}: DisclosureRowProps): React.JSX.Element {
  const rowExpands = expandable;
  const toggleFromKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!rowExpands || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onToggle();
  };
  const toggleFromLeading = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    onToggle();
  };
  return (
    <div className={`dsh-disclosure${className ? ` ${className}` : ""}`} data-open={open || undefined}>
      <div
        aria-expanded={rowExpands ? open : undefined}
        className="dsh-disclosure-row"
        data-expandable={rowExpands || undefined}
        onClick={rowExpands ? onToggle : undefined}
        onKeyDown={rowExpands ? toggleFromKeyboard : undefined}
        role={rowExpands ? "button" : undefined}
        tabIndex={rowExpands ? 0 : undefined}
      >
        {expandable ? (
          <button
            aria-expanded={open}
            className="dsh-disclosure-leading"
            onClick={toggleFromLeading}
            tabIndex={-1}
            type="button"
          >
            <span className="dsh-disclosure-icon-idle">{icon}</span>
            <span className="dsh-disclosure-chevron-hover"><Icon name="chevron" size={12} /></span>
          </button>
        ) : (
          <span className="dsh-disclosure-leading">
            <span className="dsh-disclosure-icon-idle">{icon}</span>
          </span>
        )}
        <span className="dsh-disclosure-title">{title}</span>
        {(keepContentWhenOpen || !open) && summary}
      </div>
      {open && children}
    </div>
  );
});
