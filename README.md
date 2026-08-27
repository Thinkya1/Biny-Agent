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
- **安全与恢复** —— 统一权限确认、可选的 macOS 工作区沙箱、Git checkpoint/undo；权限模式会保存到共享配置，Desktop 与 TUI 会沿用并同步上次选择，切换模型不会覆盖权限设置，Runtime Host 重建期间的权限切换会刷新快照后自动重试一次；异常中断后可恢复 Session，无法确认副作用的操作不会自动重试，也不会自动继续模型回合，而是标记为需要检查。Desktop/TUI 同时打开同一 Session 时，后打开的一端保留历史只读视图，并可在前一端释放后点击“重试”。
- **后台运行** —— Runtime Host 通过本地 SQLite authority 管理 AgentRun、TaskRun、Automation、Goal/Graph 和 Capability 状态；Session/Agent 回合事实仍以 JSONL 为 canonical source，SQLite 中对应的 session event 只是可重建投影。任务可在 Host 重启后继续查询；只有显式恢复或已持久化的 Automation/Graph 唤醒才会再次创建运行。
- **个性化与来源感知记忆** —— 全局个性化、单一 Markdown 记忆库和会话历史彼此独立；聊天可分别覆盖表达风格、指令、是否读取记忆和是否贡献记忆，新建聊天在发送首条消息前也能选择记忆策略。全局“启用记忆”是总开关，关闭后聊天覆盖不会绕过它。记忆按通用偏好或工作区来源过滤，可选本地或云端 Embedding 做语义检索；Markdown 始终是权威数据，向量不可用时自动降级为词法检索。设置中的“记忆进化”还管理通用/当前项目长期策略、行为模式审核和策略偏差处理。
- **扩展能力** ——
  - Skill：默认发现 Biny、`.agents/skills`、`.claude/skills`、`.codex/skills`、`.pi/agent/skills` 和 `.cc-switch/skills`；全局 Skill 入口中的已有软链会保留并参与去重，项目目录越界软链仍会提示。Desktop 的“导入已有”会把选中的完整技能目录复制到 `~/.biny/skills`，不删除来源；“发现技能”支持配置 GitHub 仓库、搜索仓库中的 `SKILL.md`，以及搜索 `skills.sh` 公共目录。
  - MCP：Desktop 在设置中的“MCP 服务器”分页提供应用市场与已安装列表、自定义 Stdio / Remote 配置、剪贴板导入、连接测试、重连、工具/提示/资源详情和启停管理；环境变量与请求头只保存 Keychain 引用。
  - Plugin、具名子代理和持久 Memory：Desktop 设置支持技能启停、全局默认/当前项目覆盖、自动提取草稿审核，以及 Plugin 官方市场的刷新、搜索、安装、升级、启停和卸载；Plugin 只从固定官方 HTTPS Registry 下载，安装包会校验 SHA-256 并拒绝路径穿越、链接和安装脚本，安装后默认关闭。Plugin JavaScript 会由主进程加载，不提供沙箱保证。
- **交互模式** —— 支持 Chat / Plan、follow-up / steer，以及 Desktop 与 TUI 共用的 slash command。
- **消息重试** —— Desktop 重复点击或 IPC 重入只执行一次发送；失败回合的“重试”和消息“重新生成”沿用原用户消息位置，按编辑分叉成新会话，不追加重复用户消息。

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

Desktop 设置中心共用一份跨分页草稿。外观、模型、个性化、当前聊天覆盖、记忆策略和联网搜索的修改先保留在草稿中；主题和字体可以先预览，放弃草稿时会恢复。设置页底部始终显示保存区：没有改动时“保存全部”置灰，有改动时可立即提交；配置持久化、复读和 journal 清理完成后保存立即返回，受影响的空闲 Runtime Host 与 Activity sidecar 在后台刷新；关闭或返回时如果仍有未保存修改，也会提示保存、放弃或取消。各类“启用”项统一用可勾选的复选框表示状态。任务运行期间仍可编辑草稿，但不能提交，也不能执行会改变 Runtime、记忆库或 Cookie 的即时动作。

Activity Recorder 是事件流优先的本地采集：macOS `AXObserver`/`AXUIElement` 提供前台应用、窗口和焦点控件的最小语义摘要，`CGEventTap` 只记录点击、拖拽、滚轮和键盘活动类型；连续拖拽和滚轮事件会在短窗口内合并，不保存具体键值或完整 AX Tree。只有 AX 无法取得有效上下文时，才使用第一块显示器的整屏 JPEG 和可选 Vision OCR 作为视觉 fallback。

Activity 的全局策略保存在 `activity.externalPolicy`，当前始终按 `local_only` 执行。只有明确标记为 `builtin-llama.cpp` 的可信本地模型可以在 `activity.activityRecallEnabled` 开启后检索、总结或接收脱敏事件摘要；云模型不会执行 Activity 查询，也不会收到事件摘要、截图或 OCR。`confirm_external` 和 `external_allowed` 仅用于未来 schema/持久化，提前写入时仍会 fail-closed，并提示当前版本暂不支持。Activity 回忆默认关闭。

Desktop 设置中心的 **设置 → 活动记录** 页面按“状态、权限、采集、OCR 与输入、敏感应用、存储配额、最近会话、危险区”展示设置；页面只显示摘要和历史统计，不展示截图预览或完整事件树。辅助功能和输入监控用于事件流；屏幕录制只用于视觉 fallback。macOS 权限区的每一项都提供真实的系统设置入口；点击后会先发起对应权限申请，再打开“隐私与安全性”的对应面板。缺少屏幕录制权限时事件仍会继续记录，页面显示“事件记录正常，视觉 fallback 不可用”。JPEG、OCR 和原始事件只保存在全局本地目录；容量限制只淘汰 JPEG，清除操作会删除事件、OCR 和所有 fallback JPEG。

记忆管理只有一个入口：**设置 → 记忆**。其中“记忆进化”按通用策略和当前项目策略分别编辑使命、目标、原则、约束与反目标；保存会生成新的 revision。行为模式必须由用户确认后才会参与策略判断，策略偏差只提供“调整策略、调整行为、忽略或暂缓”的选择，不会自动改写目标。聊天输入框中的眼睛按钮只切换当前聊天的记忆读取与贡献，不改变全局记忆开关。

Desktop 设置中的 **MCP 服务器** 分页管理共享 MCP 配置，不再占用侧栏主工作区入口：应用市场元数据只作为不可信的安装候选，选择传输方式后仍需在配置表单中检查命令、URL、参数和凭据再保存。Stdio 与 Remote（Streamable HTTP / SSE）服务器都可以在页面中测试；已打开项目时，已保存服务器的工具、提示和资源状态会从该项目 Runtime 查询。配置修改使用版本号校验，任务运行期间不会提交，避免重建 Runtime 时打断正在执行的任务。环境变量和 Remote 请求头的值不会写进 `config.json` 或 Desktop 快照；macOS 使用 Keychain，其他平台请使用环境变量引用或系统已有的环境变量。

### Desktop SkillHub

在 **扩展 → 技能** 中：

- **导入已有**：扫描全局 Agent Skill 入口中的未受 Biny 管理技能，多选后复制完整目录到 `~/.biny/skills`。来源目录和软链保持不变；导入动作不会自动删除或覆盖已有目录。
- **发现技能 → 仓库**：默认读取几个公开 GitHub Skill 仓库，也可以在“仓库管理”中添加 `owner/repository` 和分支。Biny 会读取仓库 tree，识别 `SKILL.md`，安装时下载完整技能目录。
- **发现技能 → skills.sh**：输入至少两个字符搜索公共目录，支持分页和一键安装。

仓库列表保存在 `~/.biny/skill-repositories.json`。远程请求和安装在 Desktop 主进程执行，并限制仓库坐标、响应大小、文件数量及总大小；Skill 文件仍会在安装后经过本地 catalog/runtime 的安全校验。

技能页也会显示当前项目的有效开关来源：项目覆盖优先于全局默认，清除项目覆盖即可恢复继承。自动技能提取默认开启，根回合成功且至少完成 5 次工具调用后在后台生成草稿；抽取内容会先脱敏并排除外部上下文，不会自动启用。草稿需要在设置页预览、编辑并批准，批准后写入当前项目的 `.biny/skills/`。

在 **设置 → 插件** 中，应用市场使用固定的 Biny 官方 Registry；刷新失败时保留上次可用缓存并显示过期状态。市场插件安装到当前项目的 `.biny/plugins/`，默认不启用；已安装插件可以打开目录、启停或卸载。运行时只加载受管清单中已启用的插件，单个插件加载失败不会阻塞其他插件或主 Runtime。

### Desktop 聊天命令与 Skill

桌面聊天输入框输入 `/` 会打开按“对话状态 / 扩展能力 / 工作区 / Skills”分组的补全菜单，菜单显示用途、参数示例和当前 Skill 描述，并自动隐藏 TUI 专用及低层运行时命令。菜单由输入框自身处理 `↑`、`↓`、`Enter`、`Tab` 和 `Esc`，长列表只在菜单内部滚动。选择 `/skills:<name>` 后会插入可识别的 Skill token；发送时才重新读取该 Skill 的 `SKILL.md` 正文并注入本次请求。

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
  "activity": {
    "enabled": false,
    "activityRecallEnabled": false,
    "externalPolicy": "local_only"
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
