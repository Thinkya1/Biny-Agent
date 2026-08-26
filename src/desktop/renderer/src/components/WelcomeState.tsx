/**
 * 新任务的欢迎空态。
 *
 * 快捷卡片只把一段具体提示写入 Composer，不创建会话，也不会直接发起运行；真正发送
 * 仍由输入框的统一提交路径负责。
 */
import { AppIcon } from "./AppIcon.js";
import { Icon, type IconName } from "./Icon.js";

interface WelcomeCard {
  icon: IconName;
  label: string;
  prompt: string;
}

const WELCOME_CARDS: WelcomeCard[] = [
  {
    icon: "search",
    label: "探索并理解代码",
    prompt: "请探索并理解这个项目的代码结构、关键模块和运行方式。"
  },
  {
    icon: "spark",
    label: "构建新功能、应用或工具",
    prompt: "请帮我在这个项目中构建一个新功能、应用或工具。"
  },
  {
    icon: "code",
    label: "审查代码并提出修改建议",
    prompt: "请审查这个项目的代码，指出问题并提出具体的修改建议。"
  },
  {
    icon: "wrench",
    label: "修复问题和失败",
    prompt: "请帮我定位并修复这个项目中的问题或失败。"
  }
];

export function WelcomeState({
  hasProject,
  onOpenProject,
  onPrefill
}: {
  hasProject: boolean;
  onOpenProject(): void;
  onPrefill(prompt: string): void;
}): React.JSX.Element {
  return (
    <section aria-label="新任务" className="biny-welcome-state">
      <AppIcon className="biny-welcome-icon" size={56} />
      <h1>你想让我在 biny 中构建什么？</h1>
      <p>{hasProject ? "选择一个方向开始，或直接描述你想完成的事情。" : "打开一个项目后，Biny 就能在你的工作区中开始工作。"}</p>
      <div className="biny-welcome-cards">
        {WELCOME_CARDS.map((card) => (
          <button className="biny-welcome-card" key={card.label} onClick={() => onPrefill(card.prompt)} type="button">
            <span className="biny-welcome-card-icon"><Icon name={card.icon} size={17} /></span>
            <span>{card.label}</span>
            <Icon className="biny-welcome-card-chevron" name="arrow-right" size={14} />
          </button>
        ))}
      </div>
      {!hasProject ? <button className="biny-welcome-open-project" onClick={onOpenProject} type="button"><Icon name="folder-open" size={15} />打开项目</button> : null}
    </section>
  );
}
