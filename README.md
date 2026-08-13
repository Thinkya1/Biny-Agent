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
- **个性化与来源感知记忆** —— 全局个性化、单一 Markdown 记忆库和会话历史彼此独立；聊天可分别覆盖表达风格、指令、是否读取记忆和是否贡献记忆。记忆按通用偏好或工作区来源过滤，可选本地或云端 Embedding 做语义检索；Markdown 始终是权威数据，向量不可用时自动降级为词法检索。
- **扩展能力** ——
  - Skill：已支持全局/项目目录扫描、显式调用和按需读取资源；生态兼容与复杂编排仍在完善。
  - MCP：已支持配置并连接启用的 stdio/http server、发现并调用工具；配置体验、跨服务兼容和异常恢复仍在完善。
  - Plugin、具名子代理和持久 Memory：已有基础能力，扩展 API 与管理体验仍在迭代。
- **交互模式** —— 支持 Chat / Plan、follow-up / steer，以及 Desktop 与 TUI 共用的 slash command。

## 快速开始

### 桌面端调试启动

```bash
pnpm desktop:dev
```

### TUI 调试启动

```bash
pnpm dev -- tui
```

## 配置

桌面端在 **设置 → 模型** 中管理模型。CLI、TUI 和 Desktop 共用全局 `~/.biny/config.json`；项目运行参数可在 `<project>/.biny/settings.json` 中覆盖。API key 不写入 README、代码或示例快照：macOS 使用 Keychain，其他平台使用 `apiKeyEnv` 环境变量。

Desktop 设置中心共用一份跨分页草稿。外观、模型、个性化、当前聊天覆盖、记忆策略和联网搜索的修改都由底部“保存全部”统一提交；主题和字体可以先预览，放弃草稿时会恢复。关闭含未保存修改的设置时，可以选择保存、放弃或取消。任务运行期间仍可编辑草稿，但不能提交，也不能执行会改变 Runtime、记忆库或 Cookie 的即时动作。

连接测试、Cookie 导入/导出/清理，以及记忆条目的增删改和整理不会进入设置草稿，确认后立即执行。本地 Embedding 下载、取消和删除，以及向量索引重建或取消也属于维护动作：它们不随“保存全部”回滚，任务运行期间不可执行，活动本地模型不能直接删除。保存新的 Embedding 选择后，Biny 会在设置事务提交并复读成功后调度后台重建；失败只保留词法降级状态，不撤销已保存设置。

CLI/TUI 的模型请求会自动读取 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`；在 macOS 未设置这些环境变量时，会继续读取系统 HTTP/HTTPS 代理设置。没有代理时保持直连，不需要用户为终端额外导出代理变量。

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
      "enabled": false,
      "useMemories": true,
      "generateMemories": true,
      "queryRewrite": true,
      "maxRecalled": 5,
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
