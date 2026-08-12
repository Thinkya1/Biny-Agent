/**
 * 当前会话的费用明细浮层。
 *
 * 这里展示的是本地按模型目录价格估算的费用；服务商最终账单可能包含折扣、套餐或其他
 * 计费规则，因此必须把这个边界明确告诉用户。
 */
import { useEffect, type RefObject } from "react";
import type { UsageSummary } from "../../../../session/metadata.js";
import { formatCacheHitRate, formatTokenCount, formatUsageCost } from "../usagePresentation.js";
import { useClosingPresence } from "../useClosingPresence.js";
import { Icon } from "./Icon.js";

interface UsageSummaryPopoverProps {
  anchorRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  onClose(): void;
  summary: UsageSummary;
}

export function UsageSummaryPopover({ anchorRef, open, onClose, summary }: UsageSummaryPopoverProps): React.JSX.Element | null {
  const presence = useClosingPresence(open);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [anchorRef, onClose, open]);

  if (!presence.present) return null;

  return (
    <section aria-label="本会话费用与用量" className="cindy-usage-popover" data-popover-phase={presence.phase} role="dialog">
      <header className="cindy-usage-popover-header">
        <div>
          <strong>本会话费用</strong>
          <span>{summary.calls ? `${String(summary.calls)} 条用量记录` : "尚未产生模型请求"}</span>
        </div>
        <button aria-label="关闭费用明细" className="cindy-toolbar-button" onClick={onClose} type="button">
          <Icon name="close" size={14} />
        </button>
      </header>

      <div className="cindy-usage-total">
        <span>估算费用</span>
        <strong>{formatUsageCost(summary)}</strong>
      </div>

      <div className="cindy-usage-grid">
        <div className="cindy-usage-stat">
          <span>Token</span>
          <strong>{formatTokenCount(summary.totalTokens)}</strong>
        </div>
        <div className="cindy-usage-stat">
          <span>已计价记录</span>
          <strong>{String(summary.pricedCalls)}</strong>
        </div>
        <div className="cindy-usage-stat">
          <span>输入 Token</span>
          <strong>{formatTokenCount(summary.inputTokens)}</strong>
        </div>
        <div className="cindy-usage-stat">
          <span>输出 Token</span>
          <strong>{formatTokenCount(summary.outputTokens)}</strong>
        </div>
        <div className="cindy-usage-stat">
          <span>最近缓存命中</span>
          <strong>{formatCacheHitRate(summary.latestCacheHitRate)}</strong>
        </div>
        <div className="cindy-usage-stat">
          <span>会话加权命中</span>
          <strong>{formatCacheHitRate(summary.sessionCacheHitRate)}</strong>
        </div>
        <div className="cindy-usage-stat">
          <span>缓存读取</span>
          <strong>{formatTokenCount(summary.cacheReadTokens)}</strong>
        </div>
        <div className="cindy-usage-stat">
          <span>缓存写入</span>
          <strong>{formatTokenCount(summary.cacheWriteTokens)}</strong>
        </div>
        <div className="cindy-usage-stat">
          <span>未命中输入</span>
          <strong>{formatTokenCount(summary.cacheMissTokens ?? 0)}</strong>
        </div>
      </div>

      {summary.unpricedCalls ? <p className="cindy-usage-warning">有 {String(summary.unpricedCalls)} 条记录缺少价格，暂不显示部分合计。</p> : null}
      <p className="cindy-usage-note">价格来自模型目录；最终账单以模型服务商为准。</p>
    </section>
  );
}
