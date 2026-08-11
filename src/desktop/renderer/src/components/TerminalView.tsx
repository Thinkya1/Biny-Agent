/**
 * 内嵌终端视图（xterm.js）。
 *
 * PTY 存活在主进程、按项目复用：组件卸载只销毁前端画面，重新挂载时回放最近输出继续会话。
 * 输入与尺寸变化走 fire-and-forget 通道，输出经 onTerminalEvent 推送。
 */
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function TerminalView({ projectId }: { projectId: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  const [exitCode, setExitCode] = useState<number>();
  const [restartToken, setRestartToken] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setError(undefined);
    setExitCode(undefined);
    const styles = getComputedStyle(container);
    const pick = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback;
    const term = new Terminal({
      cursorBlink: true,
      scrollback: 5_000,
      fontSize: 12,
      lineHeight: 1.25,
      fontFamily: pick("--font-mono", "ui-monospace, \"SF Mono\", SFMono-Regular, Menlo, monospace"),
      theme: {
        background: pick("--code", "#202020"),
        foreground: pick("--text", "#f5f5f5"),
        cursor: pick("--accent", "#339cff"),
        selectionBackground: pick("--surface-selected", "#2a4052")
      }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    const safeFit = (): void => {
      // 面板滑入动画期间容器宽度从 0 过渡，尺寸太小时 fit 会算出无效行列。
      if (container.clientWidth > 40 && container.clientHeight > 40) fit.fit();
    };
    safeFit();
    let terminalId: string | undefined;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const dataDisposable = term.onData((data) => { if (terminalId) window.biny.writeTerminal(terminalId, data); });
    const resizeDisposable = term.onResize(({ cols, rows }) => { if (terminalId) window.biny.resizeTerminal(terminalId, cols, rows); });
    const observer = new ResizeObserver(safeFit);
    observer.observe(container);
    void window.biny.createTerminal(projectId, term.cols, term.rows).then((handle) => {
      if (disposed) return;
      terminalId = handle.terminalId;
      if (handle.replay) term.write(handle.replay);
      // 等待创建期间容器可能已被 ResizeObserver 改过尺寸，这里同步一次。
      window.biny.resizeTerminal(terminalId, term.cols, term.rows);
      unsubscribe = window.biny.onTerminalEvent((event) => {
        if (event.terminalId !== terminalId) return;
        if (event.type === "data") term.write(event.data);
        else setExitCode(event.exitCode);
      });
      term.focus();
    }).catch((createError: unknown) => {
      if (!disposed) setError(createError instanceof Error ? createError.message : String(createError));
    });
    return () => {
      disposed = true;
      observer.disconnect();
      unsubscribe?.();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      term.dispose();
    };
  }, [projectId, restartToken]);

  return (
    <div className="terminal-view">
      <div className="terminal-screen" ref={containerRef} />
      {error !== undefined || exitCode !== undefined ? (
        <div className="terminal-overlay">
          <span>{error ?? `进程已退出（${String(exitCode)}）`}</span>
          <button onClick={() => setRestartToken((token) => token + 1)} type="button">重新启动</button>
        </div>
      ) : null}
    </div>
  );
}
