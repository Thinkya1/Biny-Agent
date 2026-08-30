# Biny

> 一个想法、半句话、一段粘贴——剩下交给 Biny。

Biny 是一个本地优先、记忆优先（First Local × First Memory）的 AI Agent，在 macOS Desktop、TUI 和 CLI 中连接你的模型服务，协助编码、研究和文件处理。会话、配置和长期上下文默认保存在本机。

## 功能

- **三端入口**：Desktop、TUI、CLI 共用 Agent Runtime、工具和 Session。
- **工作区工具**：文件读写、代码搜索、Git、Shell、受管进程、Web、Todo、MCP、Plugin 和 Skill。
- **模型与 Provider**：支持主流模型服务、OpenAI-compatible / Anthropic-compatible 网关和 Ollama。
- **本地状态**：Session、Memory、TELOS、Agent Identity 和运行状态以本地文件或数据库为主。
- **安全与恢复**：权限确认、checkpoint/undo、Session 恢复，以及可审计的工具执行结果。
- **个性化**：表达风格、长期记忆和 Agent 灵魂分层管理；Markdown 是身份与记忆的权威来源。
- **活动感知**：macOS 原生采集器在本地记录屏幕活动（截图、OCR、输入事件），写入前规则脱敏、原始内容不出设备；分析层归纳会话摘要并聚合每日工作日记，Agent 可主动检索你最近在做什么。
- **交互**：支持 Chat / Plan、follow-up / steer、slash command、编辑、重试和重新生成。

## 快速开始

需要 Node.js 22.12+，项目使用 `pnpm@10.6.5`。

```bash
git clone https://github.com/Thinkya1/Biny.git
cd Biny
corepack enable
corepack prepare pnpm@10.6.5 --activate
pnpm install --frozen-lockfile
pnpm dev -- init
```

然后在 **设置 → 模型** 中配置模型：

```bash
# macOS Desktop
pnpm desktop:dev

# TUI
pnpm dev -- tui
```

## 配置

CLI、TUI 和 Desktop 共用全局 `~/.biny/config.json`；项目设置可放在 `<project>/.biny/settings.json`。API key 不要写入代码、README 或测试数据，使用 macOS Keychain 或 `apiKeyEnv` 环境变量。

最小配置示例：

```json
{
  "format": "biny-config",
  "configVersion": 1,
  "defaultModel": "coder",
  "providers": {
    "deepseek": { "type": "deepseek", "apiKeyEnv": "DEEPSEEK_API_KEY" }
  },
  "models": {
    "coder": { "provider": "deepseek", "model": "deepseek-v4-flash" }
  },
  "context": {
    "memory": { "enabled": false, "useMemories": true, "generateMemories": true }
  }
}
```

### Agent 灵魂

全局 `$BINY_AGENT_DIR/identity/`（默认 `~/.biny/agent/identity/`）保存 `SOUL.md`、`IDENTITY.md`、`STYLE.md` 和 `USER.md`。身份资料默认加载，Desktop 的 **设置 → 通用 → Agent 灵魂** 支持只读预览和提案审核；Memory、TELOS 与身份资料彼此分开。

## 开发

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```
