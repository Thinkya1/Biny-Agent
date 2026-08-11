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

单次任务：`biny run "总结当前项目并指出最重要的风险"`。`biny chat`、`biny tui` 与直接运行 `biny` 都进入新的交互会话；它们不会自动加载上一次的聊天。需要恢复历史时使用 `biny resume` 选择会话，或使用 `biny resume <session-id>` 直接打开指定会话。TUI 内的 `/resume` 同样必须由用户明确选择，`/new` 创建新的空白聊天，`/app` 才会把当前会话交给 Biny Desktop。

### Harbor/Pier 评测

Biny 提供了 Harbor/Pier `BaseAgent` 适配器，可在隔离任务容器中执行 Biny，并将终态、session 和 token 用量交给外部 verifier。每次运行还会把 `biny-result.json` 和可下载的 `biny-session.jsonl` 放入 Harbor agent logs；session 下载失败不会改变任务评分。适配器源码位于 `benchmarks/harbor_adapter/`；任务容器需要预先提供 Biny、Node.js、配置和 Provider 凭据，适配器不会在 DeepSWE 离线容器中自动下载依赖。

机器化的一次性运行可以使用 `biny run --json --headless`；`--model` 接受已配置的模型 alias，`--max-steps` 和 `--soft-steps` 只覆盖本次运行。

```bash
harbor run \
  -p <dataset> \
  --agent benchmarks.harbor_adapter.biny_agent:BinyAgent \
  --model deepseek/deepseek-v4-flash \
  --n-concurrent 1 \
  --ae BINY_COMMAND=biny \
  --ae BINY_MODEL_ALIAS=deepseek-v4-flash \
  --ae BINY_MAX_STEPS=256 \
  --ae BINY_SOFT_STEPS=192 \
  --ae BINY_TIMEOUT_SEC=5400 \
  --ae DEEPSEEK_API_KEY=YOUR_API_KEY
```

如果 Harbor 传入了 `--model`，必须同时设置匹配的 `BINY_MODEL_ALIAS`，避免报告中的模型和 Biny 实际使用的模型不一致。`BINY_COMMAND` 默认是 `biny`，也可以指定为 `node /opt/biny/dist/cli/index.js`。

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

`personalization.customInstructions` 最多 4 KiB。`personality` 支持 `none`、`friendly` 和 `pragmatic`，只改变表达方式，不改变工具、权限或 Plan 约束。`useMemories` 控制当前聊天是否读取记忆，`generateMemories` 控制成功回合是否在空闲后贡献候选；两者相互独立，且默认都关闭。Desktop 可在 **设置 → 个性化** 修改全局默认值，TUI 使用 `/personality` 和 `/memories` 设置当前聊天覆盖；`/memory` 继续负责查看、搜索、添加、删除和整理实际数据。

模型目录由仓库内的 `models.dev` 快照提供，不需要为每个模型手写 `models` 条目。更新快照时运行：

```bash
pnpm sync:model-metadata
```

脚本默认读取 `https://models.dev/api.json`，生成 `src/ai/modelMetadata.generated.ts`；也可以用
`--input <json-file>` 做离线更新。快照只包含模型名称、能力、上下文限制和价格，不包含 provider 的
API 地址、SDK、环境变量或密钥。Provider endpoint、协议和凭据仍由 `~/.biny/config.json` 中的
`providers` 控制；上面的 `coder` 只是当前默认模型别名，模型选择器会同时展示该 provider 的快照目录。

设置 `BINY_AGENT_DIR` 可将配置和运行数据切换到独立目录。

## 数据与会话

会话和 Memory 保存在 `~/.biny/agent/`，附件与工具结果归档在项目 `.biny/`。全局用户偏好位于 `memory/global/`，项目事实仍位于按项目哈希隔离的分区；每条 durable memory 是一个带 YAML frontmatter 的 Markdown 文件，`MEMORY.md` 只是有界索引。项目事实不会跨项目召回。成功回合先写入带 session/turn/run lineage 的候选，默认等待聊天空闲 6 小时后由 Runtime Host 后台抽取；失败、取消、阻塞、不完整或使用外部 Web/MCP 上下文的回合默认不会自动贡献。这个后台流程失败也不会反转任务终态。

对 Session/Agent 回合而言，session JSONL 是 canonical runtime facts：新事件带有唯一 `eventId`、session 内连续的 `eventSeq`，以及本次执行的 `runId` 和任务级 `turnId`；旧 session 缺少这些字段时仍按历史事实读取。`.biny/runtime.sqlite` 是后台状态 authority，同时保存可从 JSONL 重建的 session event projection；TaskRun、Automation、Goal/Graph、Capability 的 event 与 projection 在同一 SQLite 事务内提交。catalog、run ledger 和 TurnStore 分别保存列表/运行状态投影与可恢复 checkpoint。`biny resume latest` 只有在用户明确执行该命令时才会校验 checkpoint 与 runtime high-water，并为 continuation 创建新的 `runId`、复用原 `turnId`；副作用不确定的工具只进入 `unknown/blocked`，不会自动重试。终态顺序是 checkpoint、canonical `turn_status`、run ledger、UI/Host 事件；终态事实已落盘但 ledger 投影失败时，下次启动会从 JSONL 修复。

模型请求也会以不含 prompt/response 正文的 `model_request` 事件写入 session，并关联 `sessionId`、`runId`、`turnId`、step、工具调用 id、首事件/首输出延迟、重试、provider usage 和结构化错误分类。`/status` 展示 provider 请求汇总以及本地输入 token 估算与 provider 实际值的对照；Runtime 事件流和 JSON 接口可供宿主或外部诊断读取。Biny 不提供用户可见的 `/trace` 命令，避免把底层事件明细变成另一套交互协议。

`biny sessions` 默认列出第一页；需要机器读取或继续翻页时使用 `--json`、`--limit <count>` 和返回的 `--cursor <cursor>`，`--parent <session-id>` 可只查看某个会话的直接分支。Desktop 侧栏首屏加载根会话，展开父会话时再按页加载子节点。Desktop、TUI 和 CLI 使用同一份历史；复制、编辑重发和 fork 会保留父会话关系，删除会话会同步清理正文、catalog、断点和 run ledger。

Desktop、TUI 和 `biny plan` 运行同一项目时，会通过本地 Unix socket attach 到同一个独立 Runtime Host，共享实时事件、权限请求和显式恢复；取消请求携带目标 run ID，Host 按当前 owner 状态匹配处理：客户端快照 revision 尚未同步不会阻止同一 run 的取消，迟到的旧取消也不会作用到后续 run。取消请求尚未产生运行终态时，Desktop 的停止按钮保持可操作，允许用户重试；收到终态后才恢复普通发送按钮。Desktop 选择“中止并关闭”时会先提交精确取消并有界等待运行态收敛；完全退出时会回收本次 Desktop 启动的 Host，但不会终止 attach 到的既有 owner。没有 owner 时会按项目自动启动 Host。一端退出不会复制出第二个 AgentSession。已有 Host 时，未带临时配置覆盖的 `biny run` 也会直接 attach。

普通 `biny`、`biny chat`、`biny tui` 和 Desktop 启动都不会自动打开旧的空闲 session，也不会因为旧 TurnStore checkpoint 调用模型；空闲 Host 会被重建为空白聊天，运行中的 Host 也不会被 Desktop 隐式接管。需要恢复时，必须使用 `biny resume`、`biny resume <session-id>` 或 TUI 的 `/resume`；`/app` 是 TUI → Desktop 的显式会话交接入口。Automation、Agent Graph 和显式安装的 daemon pending fire/wake 仍按各自的后台调度规则运行。

TUI 中，运行时第一次 `Ctrl+C` 只请求取消，500ms 内第二次才退出；空闲时也需要连续两次 `Ctrl+C` 退出。退出前会先通知 Host 取消当前 AgentRun，避免只断开终端后留下下次启动会继续显示的旧运行。

TaskRun 的 `retry` 不是普通对话里的“继续”，也不能用确认参数强行重放。只有同时满足以下条件才允许进入重试准入：TaskRun 和最新 TaskAttempt 都是 `failed`；失败分类是 `RateLimit`，或已证明在 provider dispatch 之前发生了 `continuation_abandoned_before_provider_dispatch`；Attempt 的副作用安全性是 `safe` 或 `idempotent`。工具失败、超时、取消、预算耗尽、验证失败，以及 `unknown`/`unsafe` 副作用都会拒绝重试；当前通用 TaskRun 入口尚未绑定执行 adapter 时也会拒绝启动，而不会只把状态改成 `running`。需要继续普通任务时，请发送新的 prompt 或使用明确的 Session/AgentRun continuation。

桌面端切换模型或读取个性化设置时，如果发现驻留 Host 缺少当前能力且项目处于空闲状态，会自动替换 owner 并重试请求；运行中的任务不会被强制重启。

需要手动托管 owner 时可运行 `biny runtime-host --workspace-root <workspace> --persistence-root <data-root>`；通常不需要手动启动。

后台任务和本地自动化使用同一个 Runtime Host：

```bash
biny daemon install          # 安装当前 workspace 的用户级 LaunchAgent
biny daemon status
biny automation list --json
biny task list --json
biny graph inspect <graph-id> --json
```

`biny daemon install` 只写入当前用户的 `~/Library/LaunchAgents`，不会开放网络端口，也不会自动安装系统级任务。需要前台运行 Host 时使用 `biny daemon run`；`biny daemon uninstall` 会停止并移除该 LaunchAgent。TUI 和 Desktop 可通过 `/tasks`、`/automation`、`/goal`、`/graph`、`/capabilities` 查询或控制对应的 authority 投影。

Automation 的 `executionTemplate` 当前只支持 `prompt`、`sessionId` 和 `mode`；`modelAlias`、`permissionMode`、`workspaceRoot` 会在创建时明确拒绝，避免配置被静默忽略。Graph/TaskRun 在 Host 重启时会回收未能证明执行结果的节点：未开始 AgentRun 的 claim 可以回到 `ready`，已有不确定副作用的执行会进入 `blocked`，取消后的晚到结果不会恢复节点或 Graph 状态。

## 当前边界

- 项目仍在持续开发，部分桌面端入口和扩展能力会继续调整。
- 带 `--model`、步数、权限或 `--headless` 覆盖的 `biny run` 仍使用独立的一次性 runtime，不修改共享 Host。
- 本地构建不签名、不公证；公开发布需要单独配置 macOS signing / notarization。
- 暂无语音输入和实时语音对话。

## 开发

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

桌面端开发可使用 `pnpm desktop:dev`，实现和 IPC 说明见 [src/desktop/README.md](./src/desktop/README.md)。欢迎通过 Issue 或 PR 反馈，请勿提交 API key、token 或其他本地敏感配置。
