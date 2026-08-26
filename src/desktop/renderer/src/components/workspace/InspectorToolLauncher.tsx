/**
 * 右侧 Inspector 的工具启动器与只读子代理结果展示。
 *
 * 这里不直接触达 IPC：父级只把已经存在的浏览器、文件、终端和斜杠命令能力作为回调传入，
 * 以免展示层再承担项目或会话的运行时职责。
 */
import { useCallback, useState } from "react";
import type { DesktopSlashResult } from "../../../../protocol.js";
import { Icon, type IconName } from "../Icon.js";

export type InspectorToolAction = "review" | "terminal" | "browser" | "files" | "side-chat";

export interface InspectorCommandState {
  status: "idle" | "loading" | "ready" | "error";
  result?: DesktopSlashResult;
  error?: string;
}

interface LauncherAction {
  action: InspectorToolAction;
  icon: IconName;
  label: string;
  shortcut?: string;
}

const launcherActions: readonly LauncherAction[] = [
  { action: "review", icon: "shield", label: "审阅", shortcut: "⇧⌘G" },
  { action: "terminal", icon: "terminal", label: "终端" },
  { action: "browser", icon: "site", label: "浏览器", shortcut: "⌘T" },
  { action: "files", icon: "folder", label: "文件", shortcut: "⌘P" },
  { action: "side-chat", icon: "message", label: "侧边聊天", shortcut: "⌥⌘S" }
];

export function InspectorToolLauncher({ onAction, error }: {
  onAction(action: InspectorToolAction): void;
  error?: string;
}): React.JSX.Element {
  return (
    <section aria-label="工作区工具" className="biny-inspector-launcher">
      <div aria-hidden="true" className="biny-inspector-launcher-spacer" />
      <div className="biny-inspector-launcher-list">
        {launcherActions.map(({ action, icon, label, shortcut }) => (
          <button className="biny-inspector-launcher-item" key={action} onClick={() => onAction(action)} type="button">
            <Icon name={icon} size={20} />
            <span>{label}</span>
            {shortcut ? <kbd>{shortcut}</kbd> : null}
          </button>
        ))}
      </div>
      {error ? <p className="biny-inspector-launcher-error" role="alert"><Icon name="warning" size={14} /><span>{error}</span></p> : null}
    </section>
  );
}

export function InspectorReview({ state, onRetry }: {
  state: InspectorCommandState;
  onRetry(): void;
}): React.JSX.Element {
  return (
    <section aria-label="审阅结果" className="biny-inspector-command">
      <div className="biny-inspector-command-intro">
        <Icon name="shield" size={18} />
        <div>
          <h2>审阅</h2>
          <p>检查当前 Git 改动的正确性、回归风险与缺失测试。</p>
        </div>
      </div>
      <InspectorCommandOutput emptyLabel="正在准备审阅…" state={state} />
      <div className="biny-inspector-command-actions">
        <button disabled={state.status === "loading"} onClick={onRetry} type="button">
          {state.status === "loading" ? "正在审阅" : "重新审阅"}
        </button>
      </div>
    </section>
  );
}

export function InspectorSideChat({ state, onSend }: {
  state: InspectorCommandState;
  onSend(input: string): void;
}): React.JSX.Element {
  const [input, setInput] = useState("");
  const submit = useCallback((): void => {
    const question = input.trim();
    if (!question || state.status === "loading") return;
    onSend(question);
  }, [input, onSend, state.status]);
  return (
    <section aria-label="侧边聊天" className="biny-inspector-command biny-inspector-side-chat">
      <div className="biny-inspector-command-intro">
        <Icon name="message" size={18} />
        <div>
          <h2>侧边聊天</h2>
          <p>向当前项目的只读子代理提问，结果不会写入当前会话。</p>
        </div>
      </div>
      <InspectorCommandOutput emptyLabel="输入问题后，子代理会在这里返回结果。" state={state} />
      <form className="biny-inspector-side-chat-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <textarea
          aria-label="向侧边聊天提问"
          disabled={state.status === "loading"}
          maxLength={190}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="询问当前项目中的实现或改动…"
          rows={3}
          value={input}
        />
        <button disabled={!input.trim() || state.status === "loading"} type="submit">
          {state.status === "loading" ? "正在发送" : "发送"}
        </button>
      </form>
    </section>
  );
}

function InspectorCommandOutput({ emptyLabel, state }: {
  emptyLabel: string;
  state: InspectorCommandState;
}): React.JSX.Element {
  if (state.status === "loading") {
    return <div aria-live="polite" className="biny-inspector-command-state"><span className="mini-spinner" /><span>正在请求子代理…</span></div>;
  }
  if (state.status === "error") {
    return <div className="biny-inspector-command-state is-error" role="alert"><Icon name="warning" size={16} /><span>{state.error}</span></div>;
  }
  if (state.status === "ready") {
    return (
      <div className="biny-inspector-command-result">
        <span className="biny-inspector-command-result-title">{state.result?.title ?? "结果"}</span>
        <pre>{state.result?.content}</pre>
      </div>
    );
  }
  return <div className="biny-inspector-command-state"><span>{emptyLabel}</span></div>;
}
