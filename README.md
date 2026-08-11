# Biny-Agent。

> 一个想法、半句话、一段粘贴——剩下交给 Biny。

**Biny 是一个本地优先的 AI Agent，可在 macOS 桌面端或终端中完成编码、研究和文件处理。**

它直接在你的工作区里运行：连接你自己的模型服务，在权限确认下读写文件、搜索代码、执行命令；会话保存在本机，随时可以恢复，而不是被锁在某个云端产品里。

> [!IMPORTANT]
> 利用空余时间持续开发中，如果有没有注意到的功能以及 bug 欢迎提交 issue。

## 功能

- **本地 Agent** —— 支持 macOS 桌面端、TUI 和 CLI，三种入口共用同一套 Agent Runtime 与 Session。
- **模型与 Provider** —— 支持主流模型服务、OpenAI-compatible / Anthropic-compatible 网关和 Ollama；支持流式输出、推理档位和用量统计。
- **工作区工具** —— 文件读写与补丁、代码搜索、Git、Shell、受管进程、联网搜索/抓取和 Todo。
- **安全与恢复** —— 统一权限确认、可选的 macOS 工作区沙箱、Git checkpoint/undo；异常中断后可恢复 Session，无法确认副作用的操作不会自动重试。
- **后台运行** —— Runtime Host 通过本地 SQLite authority 管理 AgentRun、TaskRun、Automation、Goal/Graph 和 Capability 状态；Session/Agent 回合事实仍以 JSONL 为 canonical source，SQLite 中对应的 session event 只是可重建投影。任务可在 Host 重启后继续查询；只有显式恢复或已持久化的 Automation/Graph 唤醒才会再次创建运行。
- **个性化与分层记忆** —— 全局个性化、全局用户记忆、项目记忆和会话历史彼此独立；聊天可分别覆盖表达风格、指令、是否读取记忆和是否贡献记忆。记忆保持本地 Markdown 可审计，不使用 embedding 或云端记忆。
- **扩展能力** ——
  - Skill：已支持全局/项目目录扫描、显式调用和按需读取资源；生态兼容与复杂编排仍在完善。
  - MCP：已支持配置并连接启用的 stdio/http server、发现并调用工具；配置体验、跨服务兼容和异常恢复仍在完善。
  - Plugin、具名子代理和持久 Memory：已有基础能力，扩展 API 与管理体验仍在迭代。
- **交互模式** —— 支持 Chat / Plan、follow-up / steer，以及 Desktop 与 TUI 共用的 slash command。

## 快速开始

### 桌面端

从 [Releases](https://github.com/Thinkya1/Biny/releases) 下载对应架构的 DMG，打开后在 **设置 → 模型** 中连接模型，再选择项目开始任务。

### 终端

需要 Node.js LTS 和 pnpm 10：

```bash
git clone https://github.com/Thinkya1/Biny.git
cd Biny && pnpm install
pnpm dev -- init
export DEEPSEEK_API_KEY="你的 key"
pnpm dev
```


## 配置

桌面端在 **设置 → 模型** 中管理模型。CLI、TUI 和 Desktop 共用全局 `~/.biny/config.json`；项目运行参数可在 `<project>/.biny/settings.json` 中覆盖。API key 不写入 README、代码或示例快照：macOS 使用 Keychain，其他平台使用 `apiKeyEnv` 环境变量。

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
  "personalization": {
    "enabled": true,
    "personality": "none",
    "customInstructions": ""
  },
  "context": {
    "memory": {
      "useMemories": false,
      "generateMemories": false,
      "maxRecalled": 3,
      "excludeExternalContext": true
    }
  }
}
```

## 开发

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

桌面端开发可使用 `pnpm desktop:dev`，实现和 IPC 说明见 [src/desktop/README.md](./src/desktop/README.md)。欢迎通过 Issue 或 PR 反馈，请勿提交 API key、token 或其他本地敏感配置。
