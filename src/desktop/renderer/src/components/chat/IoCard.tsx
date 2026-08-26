/**
 * 通用工具展开体的 IN/OUT 卡片：
 * IN 与 OUT 各占一个标签段，独立滚动（max-height 受限），中间发丝线分隔。
 */
import { memo } from "react";

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
    <div className="chat-io-card">
      {input !== null ? (
        <div className="chat-io-section">
          <span className="chat-io-label">IN</span>
          <span className="chat-io-text">{input}</span>
        </div>
      ) : null}
      {input !== null && output !== null ? <span aria-hidden="true" className="chat-io-divider" /> : null}
      {output !== null ? (
        <div className="chat-io-section">
          <span className="chat-io-label">OUT</span>
          <span className="chat-io-text" data-error={outputError || undefined}>{output}</span>
        </div>
      ) : null}
    </div>
  );
});
