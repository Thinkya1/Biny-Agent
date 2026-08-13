/**
 * 设置中心的二级详情层。
 *
 * 它只负责层级交互：进入时聚焦首个控件，捕获 Escape，并在退出后恢复触发控件焦点。
 * 详情内容自己提供 dialog 语义和可访问名称，避免嵌套原生 Dialog。
 */
import { useEffect, useRef } from "react";

const detailLayerStack: symbol[] = [];

export function SettingsDetailLayer({ children, onClose }: {
  children: React.ReactNode;
  onClose(): void;
}): React.JSX.Element {
  const backdropRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const layerIdRef = useRef(Symbol("settings-detail-layer"));

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const layerId = layerIdRef.current;
    detailLayerStack.push(layerId);
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const focusTarget = backdropRef.current?.querySelector<HTMLElement>(
      "[data-settings-detail-autofocus], [data-model-dialog-autofocus], button, input, textarea, select, [tabindex]:not([tabindex='-1'])"
    );
    focusTarget?.focus();

    const handleLayerKeys = (event: KeyboardEvent): void => {
      if (detailLayerStack.at(-1) !== layerId) return;
      if (event.isComposing || event.defaultPrevented) return;
      if (event.key === "Escape") {
        // 捕获阶段消费，保证一次 Escape 只关闭当前详情层，而不是继续关闭整个设置中心。
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(backdropRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])"
      ) ?? [])].filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? current <= 0 ? focusable.length - 1 : current - 1
        : current < 0 || current === focusable.length - 1 ? 0 : current + 1;
      event.preventDefault();
      focusable[next]?.focus();
    };
    document.addEventListener("keydown", handleLayerKeys, true);
    return () => {
      document.removeEventListener("keydown", handleLayerKeys, true);
      const stackIndex = detailLayerStack.lastIndexOf(layerId);
      if (stackIndex >= 0) detailLayerStack.splice(stackIndex, 1);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <div
      className="model-dialog-backdrop settings-detail-layer"
      onClick={(event) => { if (event.target === event.currentTarget) onCloseRef.current(); }}
      ref={backdropRef}
    >
      {children}
    </div>
  );
}
