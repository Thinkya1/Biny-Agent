/**
 * 新任务的欢迎空态。
 *
 * 结构：hero（图标 + 标题 + 副标题）→ children（Composer 插槽）→ 建议 pill。
 * 建议 pill 点击即直接提交，不再只是预填。入场动画：
 * hero 元素用 biny-hero-fade 即时淡入，pill 用 biny-hero-pop 按 220ms + 70ms×i
 * 阶梯弹入。提交过场（hero 淡出 / Composer 下滑）由 Workspace 的 flight 逻辑负责。
 */
import { AppIcon } from "./AppIcon.js";
import { Icon } from "./Icon.js";

const SUGGESTIONS: string[] = [
  "探索代码结构，理解项目模块和运行方式",
  "帮我构建一个新功能",
  "审查代码，指出问题并给出修改建议",
  "定位并修复项目中的问题或 bug"
];

/** pill 入场基础延迟 220ms，每个递增 70ms。 */
const PILL_BASE_DELAY = 220;
const PILL_STEP_DELAY = 70;

export function WelcomeState({
  hasProject,
  leaving,
  onOpenProject,
  onPickSuggestion,
  children
}: {
  hasProject: boolean;
  /** 提交过场中：hero 与 pill 淡出并让出指针事件。 */
  leaving?: boolean;
  onOpenProject(): void;
  onPickSuggestion(prompt: string): void;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <section aria-label="新任务" className="biny-welcome-state">
      <div className={`biny-welcome-hero${leaving ? " is-leaving" : ""}`}>
        <AppIcon className="biny-welcome-icon biny-hero-fade" size={96} />
        <h1 className="biny-hero-fade">今天聊点什么？</h1>
        <p className="biny-hero-fade">{hasProject ? "一个想法、半句话、一段粘贴——剩下交给 Biny。" : "打开一个项目后，Biny 就能在你的工作区中开始工作。"}</p>
      </div>
      {children}
      {hasProject ? (
        <div className={`biny-welcome-pills${leaving ? " is-leaving" : ""}`}>
          {SUGGESTIONS.map((suggestion, index) => (
            <button
              className="biny-welcome-pill biny-hero-pop"
              disabled={leaving}
              key={suggestion}
              onClick={() => onPickSuggestion(suggestion)}
              style={{ "--hero-delay": `${String(PILL_BASE_DELAY + index * PILL_STEP_DELAY)}ms` } as React.CSSProperties}
              title={suggestion}
              type="button"
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : (
        <button
          className="biny-welcome-open-project biny-hero-pop"
          onClick={onOpenProject}
          style={{ "--hero-delay": `${String(PILL_BASE_DELAY)}ms` } as React.CSSProperties}
          type="button"
        >
          <Icon name="folder-open" size={15} />打开项目
        </button>
      )}
    </section>
  );
}
