/**
 * Session writer 冲突提示。
 *
 * 组件只负责把冲突状态和 Retry 键位画出来；取得 writer、读取历史和重试流程仍由
 * `BinyTui`/runtime 负责，避免展示层直接触碰 session 文件。
 */
import { matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { theme } from "../theme/index.js";

export interface SessionWriterConflictView {
  sessionId: string;
  ownerSurface?: string;
}

export class SessionWriterConflictComponent implements Component {
  private retrying = false;

  constructor(
    private readonly conflict: SessionWriterConflictView,
    private readonly onRetry: () => void
  ) {}

  setRetrying(retrying: boolean): void {
    this.retrying = retrying;
  }

  invalidate(): void {
    // 每次 render 都按终端宽度截断，无缓存需要失效。
  }

  handleInput(data: string): void {
    if (this.retrying) return;
    if (matchesKey(data, "enter") || data.toLowerCase() === "r") this.onRetry();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const owner = this.conflict.ownerSurface ? `（${this.conflict.ownerSurface}）` : "";
    const title = truncateToWidth(`  🔒 已在另一个应用${owner}中打开`, safeWidth, "…");
    const detail = truncateToWidth("  请先在那边关闭会话，才能在这里继续。", safeWidth, "…");
    const action = this.retrying ? "  重试中…" : "  Enter/R 重试";
    return [
      theme.fg("warning", title),
      theme.fg("muted", detail),
      theme.fg("dim", action)
    ];
  }
}
