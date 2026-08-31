/**
 * 思考/运行状态字形。
 *
 * 使用轻量 SVG 而不是把完整的 loading 组件嵌入时间线，保证思考行和工具行的
 * 状态图标尺寸、描边和动画保持一致。
 */
export function ThinkingGlyph({ animated = false }: { animated?: boolean }): React.JSX.Element {
  return (
    <svg aria-hidden="true" className={`thinking-glyph${animated ? " is-animated" : ""}`} fill="none" viewBox="0 0 14 14">
      <circle cx="7" cy="7" r="5.35" stroke="currentColor" strokeDasharray="2.7 1.9" strokeLinecap="round" strokeWidth="1.35" />
      <circle cx="4.2" cy="4.25" fill="currentColor" r="0.8" />
      <circle cx="9.8" cy="9.75" fill="currentColor" r="0.8" />
    </svg>
  );
}
