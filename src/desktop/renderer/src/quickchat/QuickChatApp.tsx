/**
 * QuickChat 悬浮窗的极简聊天界面。
 *
 * 与主窗口的完整 desktopState 投影彻底解耦：这里只维护自己的一个小消息列表 + 一个精简
 * reducer，从共享的 agent 事件流里只挑当前 QuickChat session 的事件做流式渲染。发消息复用
 * 现成的 sendPrompt（sessionId 传 undefined 即懒建会话），屏幕上下文走 quickChatScreenContext
 * IPC 取纯文本片段拼进 prompt，绝不搬截图字节。
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { DesktopQuickChatScreenContext } from "../../../protocol.js";
import type { AgentHostEvent } from "../../../../runtime/agentEvents.js";
import { isTerminalRunEvent } from "../../../../runtime/agentEvents.js";

/** 输入框草稿上限：悬浮窗定位是短问答，过长内容应回主窗口。 */
const MAX_INPUT_LENGTH = 4_000;

interface QuickChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming: boolean;
  /** 用户消息附带的小标记：是否注入了屏幕上下文。 */
  withScreenContext?: boolean;
}

interface QuickChatState {
  messages: QuickChatMessage[];
}

type QuickChatAction =
  | { type: "append"; message: QuickChatMessage }
  | { type: "set-assistant"; runId: string; content: string; streaming: boolean }
  | { type: "finish-run"; runId: string };

let messageCounter = 0;
const nextMessageId = (prefix: string): string => `${prefix}-${++messageCounter}`;

/**
 * 精简流式归约：assistant.delta 与 assistant.completed 的 content 都是累计全文（不是增量），
 * 所以同一 run 内直接替换；不同 run 各开一条气泡。与主窗口 sessionTimeline 的语义保持一致。
 */
function reduceQuickChat(state: QuickChatState, action: QuickChatAction): QuickChatState {
  switch (action.type) {
    case "append":
      return { messages: [...state.messages, action.message] };
    case "set-assistant": {
      const index = state.messages.findIndex((message) => message.id === action.runId);
      if (index === -1) {
        return {
          messages: [
            ...state.messages,
            { id: action.runId, role: "assistant", content: action.content, streaming: action.streaming }
          ]
        };
      }
      const messages = state.messages.slice();
      const existing = messages[index];
      if (!existing) return state;
      messages[index] = { ...existing, content: action.content, streaming: action.streaming };
      return { messages };
    }
    case "finish-run": {
      const index = state.messages.findIndex((message) => message.id === action.runId);
      if (index === -1) return state;
      const messages = state.messages.slice();
      const existing = messages[index];
      if (!existing) return state;
      messages[index] = { ...existing, streaming: false };
      return { messages };
    }
  }
}

/** 把屏幕上下文片段格式化成注入 prompt 的文本块；空上下文返回原文。 */
function formatPromptWithContext(input: string, context: DesktopQuickChatScreenContext): string {
  if (!context.recording) return input;
  const lines: string[] = [];
  if (context.frontmostApplication) lines.push(`前台应用：${context.frontmostApplication}`);
  if (context.windowTitle) lines.push(`当前窗口：${context.windowTitle}`);
  if (context.browserUrl) lines.push(`浏览器 URL：${context.browserUrl}`);
  if (context.ocrExcerpt) lines.push(`屏幕文字片段：${context.ocrExcerpt}`);
  if (context.recentSessionTitles.length) lines.push(`最近分析的活动：${context.recentSessionTitles.join("；")}`);
  if (!lines.length) return input;
  const stamp = context.capturedAt ? `（采集于 ${context.capturedAt}）` : "";
  return `[实时屏幕上下文${stamp}，仅供你参考，不要逐字复述]\n${lines.join("\n")}\n\n[我的问题]\n${input}`;
}

export function QuickChatApp(): React.JSX.Element {
  const [state, dispatch] = useReducer(reduceQuickChat, { messages: [] });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [injectScreenContext, setInjectScreenContext] = useState(false);
  const [noProject, setNoProject] = useState(false);
  /** 本悬浮窗专属会话：首发时懒建，之后整个窗口生命周期内复用。 */
  const sessionIdRef = useRef<string | undefined>(undefined);
  const projectIdRef = useRef<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 启动时读一次偏好与活动项目；注入开关若开着，发送时再实时取屏幕上下文。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [settings, boot] = await Promise.all([window.biny.quickChatSettings(), window.biny.bootstrap()]);
        if (cancelled) return;
        setInjectScreenContext(settings.injectScreenContext);
        projectIdRef.current = boot.activeProjectId ?? boot.projects.at(0)?.id;
        setNoProject(projectIdRef.current === undefined);
      } catch {
        // 读取失败时降级为不注入，发送仍可用。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 订阅共享 agent 事件流，只挑当前 QuickChat session 的事件做流式渲染。
  useEffect(() => {
    const unsubscribe = window.biny.onAgentEvent((envelope) => {
      const event = envelope.event;
      const sessionId = sessionIdRef.current;
      if (!event || sessionId === undefined || event.sessionId !== sessionId) return;
      handleStreamEvent(event, dispatch);
    });
    return unsubscribe;
  }, []);

  // 新消息/流式更新时滚到底部。
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [state.messages]);

  const send = useCallback(async (): Promise<void> => {
    const text = input.trim();
    const projectId = projectIdRef.current;
    if (!text || busy) return;
    if (!projectId) {
      setNoProject(true);
      return;
    }
    setBusy(true);
    let withScreenContext = false;
    try {
      let prompt = text;
      if (injectScreenContext) {
        try {
          const context = await window.biny.quickChatScreenContext();
          const formatted = formatPromptWithContext(text, context);
          if (formatted !== text) {
            prompt = formatted;
            withScreenContext = true;
          }
        } catch {
          // 取上下文失败不阻塞发送：按纯文本发。
        }
      }
      dispatch({
        type: "append",
        message: { id: nextMessageId("user"), role: "user", content: text, streaming: false, withScreenContext }
      });
      setInput("");
      // sessionId 传 undefined → 主进程懒建一个新会话并把 id 放进回执，后续轮次复用它。
      const receipt = await window.biny.sendPrompt(projectId, sessionIdRef.current, prompt, "chat", []);
      sessionIdRef.current = receipt.sessionId;
      // 占位一条空的流式气泡，等待第一个 delta。
      dispatch({ type: "set-assistant", runId: receipt.runId, content: "", streaming: true });
    } catch (error) {
      dispatch({
        type: "append",
        message: {
          id: nextMessageId("error"),
          role: "assistant",
          content: error instanceof Error ? error.message : String(error),
          streaming: false
        }
      });
    } finally {
      setBusy(false);
    }
  }, [busy, injectScreenContext, input]);

  return (
    <div className="quickchat-root">
      <div className="quickchat-titlebar">
        <span className="quickchat-titlebar-title">快速对话</span>
        <button
          aria-label="关闭"
          className="quickchat-icon-button"
          onClick={() => void window.biny.hideQuickChat()}
          title="关闭（⌥Space 重新唤醒）"
          type="button"
        >
          ×
        </button>
      </div>

      <div className="quickchat-messages" ref={scrollRef}>
        {state.messages.length === 0 ? (
          <div className="quickchat-empty">
            问点什么…{injectScreenContext ? "\n会自动带上当前屏幕的文本上下文。" : ""}
          </div>
        ) : (
          state.messages.map((message) => (
            <div className={`quickchat-message ${message.role}`} key={message.id}>
              {message.withScreenContext ? <span className="quickchat-context-flag">已附屏幕上下文</span> : null}
              {message.content}
              {message.streaming && message.content === "" ? (
                <span className="quickchat-typing" aria-label="正在生成">
                  <i /><i /><i />
                </span>
              ) : null}
            </div>
          ))
        )}
      </div>

      {noProject ? <div className="quickchat-banner">还没有可用项目。请先在主窗口打开一个项目。</div> : null}

      <div className="quickchat-composer">
        <textarea
          autoFocus
          className="quickchat-input"
          disabled={noProject}
          maxLength={MAX_INPUT_LENGTH}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              void window.biny.hideQuickChat();
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="发消息…（Enter 发送，Shift+Enter 换行）"
          rows={1}
          value={input}
        />
        <button
          aria-label="发送"
          className="quickchat-send"
          disabled={busy || !input.trim() || noProject}
          onClick={() => void send()}
          type="button"
        >
          ➤
        </button>
      </div>
    </div>
  );
}

/** 把当前 session 的流事件折进气泡列表；终态事件统一收尾。 */
function handleStreamEvent(event: AgentHostEvent, dispatch: React.Dispatch<QuickChatAction>): void {
  if (event.type === "assistant.delta" || event.type === "assistant.completed") {
    dispatch({ type: "set-assistant", runId: event.runId, content: event.content, streaming: event.type === "assistant.delta" });
    return;
  }
  if (isTerminalRunEvent(event)) {
    // 失败/中止且本轮还没任何文本时，补一条说明，避免气泡停在「正在生成」。
    if ((event.type === "run.failed" || event.type === "run.aborted") ) {
      const reason = event.type === "run.failed" ? event.error : event.reason;
      dispatch({ type: "set-assistant", runId: event.runId, content: reason || "本轮未产出内容。", streaming: false });
    } else {
      dispatch({ type: "finish-run", runId: event.runId });
    }
  }
}
