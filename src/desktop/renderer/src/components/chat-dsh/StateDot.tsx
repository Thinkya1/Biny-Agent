/**
 * 状态点（复刻 DSH ui-primitives StateDot，figma 14:3303/3305/3312, 122:9182）。
 *
 * done/warning/error：10px 外层同色 10% 光环 + 6px 实心核；
 * ongoing：3×3 矩阵外圈 8 个 2px 像素顺时针追逐点亮。
 */
import { memo } from "react";

export type StateDotState = "done" | "warning" | "ongoing" | "error";

/** 3×3 矩阵外圈格子（2px 像素，10px 网格），顺时针从左上起。 */
const MATRIX_CELLS: readonly (readonly [number, number])[] = [
  [0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4],
];

/** 渲染一个状态点（aria-hidden；配套可见文本表达状态）。 */
export const StateDot = memo(function StateDot({ state, size = 10, className }: {
  state: StateDotState;
  size?: number;
  className?: string;
}): React.JSX.Element {
  if (state === "ongoing") {
    return (
      <svg
        aria-hidden="true"
        className={`dsh-state-dot is-ongoing${className ? ` ${className}` : ""}`}
        height={size}
        shapeRendering="crispEdges"
        viewBox="0 0 10 10"
        width={size}
      >
        {MATRIX_CELLS.map(([x, y], index) => (
          <rect
            className="dsh-state-cell"
            height="2"
            key={`${x}-${y}`}
            /* 负延迟错相，让每个格子从挂载起就在追逐。 */
            style={{ animationDelay: `${(index - MATRIX_CELLS.length) * 125}ms` }}
            width="2"
            x={x}
            y={y}
          />
        ))}
      </svg>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`dsh-state-dot is-${state}${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
    />
  );
});
