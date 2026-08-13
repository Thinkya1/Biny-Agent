/**
 * 展开体 IN/OUT 卡片（复刻 DSH ToolRow 的 ioCard，figma 1249:35657）。
 *
 * l1 边框 12px 圆角的等宽表面：IN 与 OUT 各占一个 gutter 标签网格，独立滚动
 * （max-height 150px），中间 1px 发丝线分隔；标签 sticky 在各自滚动区内。
 */
import { memo } from "react";

/** 渲染通用工具展开体的 IN/OUT 卡片。 */
export const IoCard = memo(function IoCard({ input, output, outputError = false }: {
  /** 输入文本（pretty 参数）；null 不渲染 IN 段。 */
  input: string | null;
  /** 输出文本（结果）；null 不渲染 OUT 段。 */
  output: string | null;
  /** 输出段是否按错误色渲染。 */
  outputError?: boolean;
}): React.JSX.Element | null {
  if (input === null && output === null) return null;
  return (
    <div className="dsh-io-card">
      {input !== null ? (
        <div className="dsh-io-section">
          <span className="dsh-io-label">IN</span>
          <span className="dsh-io-text">{input}</span>
        </div>
      ) : null}
      {input !== null && output !== null ? <span aria-hidden="true" className="dsh-io-divider" /> : null}
      {output !== null ? (
        <div className="dsh-io-section">
          <span className="dsh-io-label">OUT</span>
          <span className="dsh-io-text" data-error={outputError || undefined}>{output}</span>
        </div>
      ) : null}
    </div>
  );
});
