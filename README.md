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

### 记忆 v3

默认权威记忆库位于 `~/.biny/agent/memory/`；设置 `BINY_AGENT_DIR` 后改用该目录下的 `memory/`。结构化条目保存在 `entries/*.md`，`MEMORY.md` 是可读索引，整个库共用一个 revision：

- `user` 来源表示跨项目通用的偏好或工作方式，写入时需要用户明确表达的证据；
- `workspace` 来源表示工作区事实、决策、流程和踩坑，只保存 24 位工作区 ID 与名称快照，不把绝对项目路径写进来源字段；
- “全部、当前项目、通用偏好、其他项目”只是同一库的视图过滤，不对应不同物理目录。

TUI 的 `/memory` 也使用同一语义：`list`、`show`、`search` 和 `forget` 接受 `all | current | user | other` 来源视图，`add` 接受 `workspace | universal` audience 且默认写入当前 workspace。Agent 的 `save_memory` 工具使用相同 audience，`recall_memory` 从单一库检索。

首次访问 v3 库时，Biny 会把旧 `memory/global/` 与 `memory/<workspace-id>/` 条目迁入 `entries/`。旧目录原样保留为冷备份；迁移成功后不再双写，也不会继续把旧目录作为读取路径。

语义检索是可选增强。Biny 会把词法结果与可用的向量结果混合排序，并按 Embedding 模型指纹分别保存当前项目和跨项目阈值。查询重写、模型请求或向量索引失败，以及模型未下载、指纹或维度不匹配时，不会静默切换另一种 Embedding，而是回退到本地词法检索；此时自动召回只使用通用偏好和当前项目，手动搜索仍可浏览其他来源。真正注入上下文的条目才会增加召回次数。

向量保存在同目录的 `.memory-index.sqlite` 派生索引中，可以重建而不改变 Markdown。两个内置本地模型 `multilingual-e5-small` 和 `paraphrase-multilingual-MiniLM-L12-v2` 的权重不包含在安装包内，只有用户显式下载后才能离线使用。选择云端 Embedding 时，设置页会展示 endpoint，并要求按 provider/endpoint 确认一次隐私提示：重建索引会上传待索引的记忆内容，之后的语义检索会上传查询；拒绝或请求失败时仍按上述规则降级。

普通 Agent 回合在模型自然停止后直接结束；工具调用完成、权限审批和取消分别由各自的运行层处理。工作区发生修改不会自动触发 `typecheck`、`test`、`lint` 或 `build`，独立验收只在调用方明确使用 harness 时运行。运行时提示词会要求模型先识别任务目标、约束和足够完成的标准：范围内的本地操作按当前权限模式执行，外部副作用、破坏性或高成本操作，以及超出请求范围的动作需要审批或澄清。工具调用次数、重复动作和 provider step 仍由运行时预算保护。

## 开发

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

桌面端开发可使用 `pnpm desktop:dev`，实现和 IPC 说明见 [src/desktop/README.md](./src/desktop/README.md)。欢迎通过 Issue 或 PR 反馈，请勿提交 API key、token 或其他本地敏感配置。
