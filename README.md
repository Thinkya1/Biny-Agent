# Biny

> 一个想法、半句话、一段粘贴——剩下交给 Biny。

**Biny 是一个本地优先的 AI Agent，可在 macOS 桌面端或终端中完成编码、研究和文件处理。**

它直接在你的工作区里运行：连接你自己的模型服务，在权限确认下读写文件、搜索代码、执行命令；会话保存在本机，随时可以恢复，而不是被锁在某个云端产品里。

> [!IMPORTANT]
> 利用空余时间持续开发中，如果有没有注意到的功能以及 bug 欢迎提交 issue。

## 功能

- **本地 Agent** —— 支持 macOS 桌面端、TUI 和 CLI，三种入口共用同一套 Agent Runtime 与 Session。
- **模型与 Provider** —— 支持主流模型服务、OpenAI-compatible / Anthropic-compatible 网关和 Ollama；支持流式输出、推理档位和用量统计，上下文用量展示实际占用百分比。
- **工作区工具** —— 文件读写与补丁、代码搜索、Git、Shell、受管进程、联网搜索/抓取和 Todo。
- **安全与恢复** —— 统一权限确认、可选的 macOS 工作区沙箱、Git checkpoint/undo；权限模式会保存到共享配置，Desktop 与 TUI 会沿用并同步上次选择，切换模型不会覆盖权限设置；异常中断后可恢复 Session，无法确认副作用的操作不会自动重试。Desktop/TUI 同时打开同一 Session 时，后打开的一端保留历史只读视图，并可在前一端释放后点击“重试”。
- **后台运行** —— Runtime Host 通过本地 SQLite authority 管理 AgentRun、TaskRun、Automation、Goal/Graph 和 Capability 状态；Session/Agent 回合事实仍以 JSONL 为 canonical source，SQLite 中对应的 session event 只是可重建投影。任务可在 Host 重启后继续查询；只有显式恢复或已持久化的 Automation/Graph 唤醒才会再次创建运行。
- **个性化与来源感知记忆** —— 全局个性化、单一 Markdown 记忆库和会话历史彼此独立；聊天可分别覆盖表达风格、指令、是否读取记忆和是否贡献记忆。记忆按通用偏好或工作区来源过滤，可选本地或云端 Embedding 做语义检索；Markdown 始终是权威数据，向量不可用时自动降级为词法检索。
- **扩展能力** ——
  - Skill：默认发现 Biny 受管目录和标准 `.agents/skills`，按同一 scope 的稳定名称与根目录优先级去重；Desktop 支持把本地 `SKILL.md` 显式导入来源库，再安装到 Biny 运行时目录，扫描异常会留在 SkillHub 内提示。市场、压缩包导入和自动同步仍未实现。
  - MCP：Desktop 提供独立的“MCP 服务器”页面，支持应用市场与已安装列表、自定义 Stdio / Remote 配置、剪贴板导入、连接测试、重连、工具/提示/资源详情和启停管理；环境变量与请求头只保存 Keychain 引用。
  - Plugin、具名子代理和持久 Memory：已有基础能力，扩展 API 与管理体验仍在迭代。
- **交互模式** —— 支持 Chat / Plan、follow-up / steer，以及 Desktop 与 TUI 共用的 slash command。

## 快速开始

源码运行可以按以下步骤操作。

> 需要 Node.js 22.12+，项目使用 `pnpm@10.6.5`。

### 1. 拉取代码

```bash
git clone https://github.com/Thinkya1/Biny.git
cd Biny
```

### 2. 安装依赖

```bash
corepack enable
corepack prepare pnpm@10.6.5 --activate
pnpm install --frozen-lockfile
```

### 3. 初始化配置

```bash
pnpm dev -- init
```

然后在桌面端 **设置 → 模型** 中配置模型；使用 CLI/TUI 时，也可以按[配置](#配置)设置 API key。

### 4. 启动

```bash
# macOS 桌面端
pnpm desktop:dev

# TUI
pnpm dev -- tui
```

## 配置

桌面端在 **设置 → 模型** 中管理模型。CLI、TUI 和 Desktop 共用全局 `~/.biny/config.json`；项目运行参数（不含权限模式）可在 `<project>/.biny/settings.json` 中覆盖。权限模式始终保存到共享全局配置，旧项目文件中的 `permission` 只会在内存中的有效配置里忽略；普通读取和 `doctor` 不会改写磁盘文件。API key 不写入 README、代码或示例快照：macOS 使用 Keychain，其他平台使用 `apiKeyEnv` 环境变量。发现旧配置仍含明文凭据时，具备持久凭据存储的平台会在配置写锁内转存并清除明文；没有持久凭据存储时会明确报错，不会静默丢弃。

Desktop 设置中心共用一份跨分页草稿。外观、模型、个性化、当前聊天覆盖、记忆策略和联网搜索的修改先保留在草稿中；主题和字体可以先预览，放弃草稿时会恢复。设置页底部始终显示保存区：没有改动时“保存全部”置灰，有改动时可立即提交；关闭或返回时如果仍有未保存修改，也会提示保存、放弃或取消。各类“启用”项统一用可勾选的复选框表示状态。任务运行期间仍可编辑草稿，但不能提交，也不能执行会改变 Runtime、记忆库或 Cookie 的即时动作。

Desktop 侧栏的 **MCP 服务器** 页面管理共享 MCP 配置：应用市场元数据只作为不可信的安装候选，点击安装后仍需在配置表单中检查命令、URL、参数和凭据再保存。Stdio 与 Remote（Streamable HTTP / SSE）服务器都可以在页面中测试；已打开项目时，已保存服务器的工具、提示和资源状态会从该项目 Runtime 查询。配置修改使用版本号校验，任务运行期间不会提交，避免重建 Runtime 时打断正在执行的任务。环境变量和 Remote 请求头的值不会写进 `config.json` 或 Desktop 快照；macOS 使用 Keychain，其他平台请使用环境变量引用或系统已有的环境变量。

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
