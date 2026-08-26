/**
 * 呼吸灯状态点。
 *
 * `breathing` 时核心点带一圈光晕，缓慢缩放明暗（约 2.2s 一轮），表达「活着」；
 * 静态语义色（success/danger/warning/muted）只保留纯色点，不闪。
 * 颜色全部走主题 token，明暗主题自动适配。
 */
import { memo } from "react";

export type BreathingDotTone = "accent" | "success" | "danger" | "warning" | "muted";

export const BreathingDot = memo(function BreathingDot({
  tone = "accent",
  breathing = false,
  className,
}: {
  tone?: BreathingDotTone;
  /** 是否启用呼吸动画；完成/失败等终态关掉。 */
  breathing?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={`chat-breath-dot is-${tone}${breathing ? " is-breathing" : ""}${className ? ` ${className}` : ""}`}
    />
  );
});
