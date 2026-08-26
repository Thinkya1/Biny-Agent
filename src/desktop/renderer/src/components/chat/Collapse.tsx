/**
 * 高度动画折叠容器。
 *
 * 用 CSS grid-template-rows 0fr ↔ 1fr 做顺滑的高度过渡（内容高度自适应，无需测量），
 * 同步淡入淡出。收起时内容 inert，不响应焦点与点击。
 */
import { memo, type ReactNode } from "react";

export const Collapse = memo(function Collapse({
  open,
  children,
  className,
}: {
  open: boolean;
  children?: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      aria-hidden={!open}
      className={`chat-collapse${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}
      inert={!open}
    >
      <div className="chat-collapse-inner">
        <div className="chat-collapse-content">{children}</div>
      </div>
    </div>
  );
});
