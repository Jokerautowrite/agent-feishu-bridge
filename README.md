# agent-feishu-bridge

把本地运行的 AI Agent 接入飞书 / Lark，在聊天窗口中远程使用项目绑定、会话管理、流式回复、工具状态、审批和文件传输能力。

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](package.json)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-blue)](#快速开始)
[![Backends](https://img.shields.io/badge/backends-8-purple)](#支持的-agent-后端)
[![License](https://img.shields.io/badge/license-custom-lightgrey)](LICENSE)

```text
飞书 / Lark 消息
       ↓
agent-feishu-bridge
       ↓
本机 Agent CLI / RPC 服务
       ↓
流式卡片、结果、审批与附件
```

这个项目只负责连接飞书和本机 Agent。Agent、模型凭据、代码仓库及工作目录仍由用户自己的设备管理，不需要把项目部署到公网服务器。

## 功能概览

- 通过飞书私聊或群聊使用本机 Agent。
- 将不同飞书会话绑定到不同本地项目目录。
- 创建、切换、恢复和停止 Agent 会话。
- 在飞书中选择模型、推理强度和执行权限。
- 用流式卡片展示回答、执行进度、工具调用和上下文占用。
- 长回答自动突出结论，其余正文默认折叠，减少卡片滚动长度。
- 支持图片、文件和音频的接收与回传。
- 支持 Agent 操作审批、群聊权限控制和工作区路径限制。
- 使用飞书官方长连接，不要求公网回调地址。
- 提供 Windows、Linux 和 macOS 用户级安装脚本。

## 支持的 Agent 后端

通过统一变量 `AGENT_BRIDGE_BACKEND` 选择后端：

| Agent | 配置值 | 连接方式 | 使用前准备 |
| --- | --- | --- | --- |
| Codex | `codex` | `codex app-server` | 安装并登录 Codex CLI |
| OpenCode | `opencode` | OpenCode SDK + SSE | 安装 OpenCode，并运行 `opencode serve` |
| Claude Code | `claude` | `claude -p --output-format stream-json` | 安装并登录 Claude Code |
| Chuang | `chuang` | app-server Unix socket | 启动 Chuang app-server 并设置 socket |
| OpenClaw | `openclaw` | `openclaw agent --json` | 安装并完成 OpenClaw 配置 |
| Hermes Agent | `hermes` | `hermes chat --quiet` | 安装并完成 Hermes Agent 配置 |
| Grok | `grok` | `grok -p --output-format streaming-json` | 安装并登录 Grok CLI |
| Gemini CLI | `gemini` | `gemini --prompt --output-format stream-json` | 安装并登录 Gemini CLI |

默认后端是 `codex`。旧变量 `OPENCODE_BRIDGE_BACKEND`、`CLAUDE_BRIDGE_BACKEND` 和 `CHUANG_BRIDGE_BACKEND` 仍可兼容读取；新部署建议统一使用 `AGENT_BRIDGE_BACKEND`。

## 效果预览

<p align="center">
  <img src="docs/demo-1.png" width="340" alt="飞书中的 Agent 对话示例">
  <img src="docs/demo-2.png" width="340" alt="流式回复卡片示例">
</p>

## 快速开始

开始前需要：

- Git
- Node.js 18 或更高版本
- 一个已安装并可在终端运行的 Agent CLI
- 一个飞书企业自建应用

> [!IMPORTANT]
> 必须先完成下面的飞书应用配置。机器人能力、权限、事件或应用版本缺少任何一项，都可能表现为“安装成功，但机器人完全没有回复”。

### 1. 配置飞书应用

在[飞书开放平台](https://open.feishu.cn/app)创建一个企业自建应用：

1. 在“添加应用能力”中启用机器人。
2. 在“权限管理”中添加所需权限。
3. 在“事件与回调”中，将事件订阅和回调订阅都设置为“使用长连接接收”。
4. 添加事件和回调。
5. 创建并发布应用版本，使配置对实际用户生效。

基础权限：

| 用途 | 权限标识 | 必需性 |
| --- | --- | --- |
| 以应用身份发送消息 | `im:message:send_as_bot` | 必需 |
| 接收单聊消息 | `im:message.p2p_msg:readonly` | 使用单聊时必需 |
| 接收群聊中 @ 机器人的消息 | `im:message.group_at_msg:readonly` | 使用群聊时必需 |
| 创建和更新流式卡片 | `cardkit:card:write` | 必需 |
| 获取卡片信息 | `cardkit:card:read` | 必需 |

事件与回调：

| 类型 | 名称 | 标识 | 接收方式 |
| --- | --- | --- | --- |
| 事件订阅 | 接收消息 v2.0 | `im.message.receive_v1` | 长连接 |
| 回调订阅 | 卡片回传交互 | `card.action.trigger` | 长连接 |

可选权限：

| 功能 | 权限标识 |
| --- | --- |
| 显示或删除消息处理状态表情 | `im:message.reactions:write_only` |
| 接收或发送图片、文件和音频 | `im:resource` |

官方参考：[接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、[使用长连接接收事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)、[处理卡片回调](https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-callbacks)。

### 2. 一行安装

安装器会下载或更新项目、安装生产依赖、询问飞书凭据、Agent 后端和项目根目录，并配置当前用户的后台启动方式。重复运行安装命令可安全更新已有安装，现有私有配置会保留。

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/Jokerautowrite/agent-feishu-bridge/main/install.ps1 | iex
```

Linux / macOS：

```sh
curl -fsSL https://raw.githubusercontent.com/Jokerautowrite/agent-feishu-bridge/main/install.sh | bash
```

默认安装位置：

| 系统 | 后台运行方式 | 配置文件 |
| --- | --- | --- |
| Windows | 当前用户启动项 | `%LOCALAPPDATA%\agent-feishu-bridge\.env` |
| Linux | systemd user service | `~/.config/agent-feishu-bridge/.env` |
| macOS | LaunchAgent | `~/.config/agent-feishu-bridge/.env` |

如果不希望安装后台服务：

```powershell
# Windows
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Jokerautowrite/agent-feishu-bridge/main/install.ps1))) -NoStartup -NoStart
```

```sh
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/Jokerautowrite/agent-feishu-bridge/main/install.sh | bash -s -- --no-service
```

> 多台设备可以重复使用同一安装命令。若多台设备需要同时在线，建议每台设备使用不同的飞书自建应用；同一 App ID 的多个长连接客户端可能由飞书进行集群投递，不保证每台设备都收到同一条消息。

### 3. 首次绑定项目

在飞书中向机器人发送：

```text
/bind /absolute/path/to/project
```

Windows 示例：

```text
/bind D:\workspace\my-project
```

也可以先设置 `AGENT_BRIDGE_PROJECTS_ROOT`，再只发送目录名：

```text
/bind my-project
```

绑定成功后发送 `/where`，即可查看当前 Agent、项目、模型、推理强度、会话和快捷操作。

## 配置

安装器生成的 `.env` 不会提交到 Git。手动部署时，可复制 `.env.example` 并至少配置：

```dotenv
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx

AGENT_BRIDGE_BACKEND=codex
AGENT_BRIDGE_DEFAULT_CODEX_MODEL=gpt-5.3-codex
AGENT_BRIDGE_DEFAULT_CODEX_EFFORT=medium
AGENT_BRIDGE_DEFAULT_CODEX_ACCESS_MODE=default
AGENT_BRIDGE_PROJECTS_ROOT=/path/to/projects
```

`AGENT_BRIDGE_DEFAULT_CODEX_*` 是为兼容早期 Codex 版本保留的通用运行参数名，对其他后端同样生效。

后端常用配置：

```dotenv
# Codex：可选，留空时自动启动 codex app-server
AGENT_BRIDGE_CODEX_ENDPOINT=
AGENT_BRIDGE_CODEX_COMMAND=codex

# OpenCode
OPENCODE_SERVER_URL=http://127.0.0.1:4096
OPENCODE_AGENT=build

# Claude Code
CLAUDE_BIN=claude
CLAUDE_BRIDGE_MODEL=

# Chuang
CHUANG_AGENT_SOCKET=/path/to/chuang.sock

# OpenClaw
AGENT_BRIDGE_OPENCLAW_COMMAND=openclaw
OPENCLAW_MODEL=

# Hermes Agent
AGENT_BRIDGE_HERMES_COMMAND=hermes
HERMES_MODEL=

# Grok
GROK_COMMAND=grok
GROK_MODEL=grok-4.5
GROK_MODELS=grok-4.5,grok-4.6

# Gemini CLI
AGENT_BRIDGE_GEMINI_COMMAND=gemini
GEMINI_MODEL=
```

Gemini 后端使用官方的 [Headless / stream-json 协议](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md)。先按[官方安装说明](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/installation.mdx)安装并运行一次 `gemini` 完成登录，再设置 `AGENT_BRIDGE_BACKEND=gemini`。

Gemini 的无界面模式无法把终端交互式确认原样转发到飞书。桥默认保留 Gemini 的安全审批策略，群聊普通成员强制使用 `--approval-mode plan`；只有当项目访问模式明确设置为 `full-access` 时，适配器才会传入 `--approval-mode yolo`。请只在可信私聊和可信工作区中启用完整访问。

配置加载顺序：

1. 当前进程的环境变量
2. `AGENT_BRIDGE_ENV_FILE` 指定的文件
3. 当前目录的 `.env`
4. 系统默认配置文件
5. 兼容旧版本的 `~/.codex-im/.env`

完整配置示例见 [.env.example](.env.example)。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `/bind <路径或目录名>` | 绑定项目 |
| `/where` | 打开当前状态和操作控制台 |
| `/workspace` | 查看或切换已绑定项目 |
| `/remove <路径>` | 移除项目绑定 |
| `/new` | 新建 Agent 会话 |
| `/switch <threadId>` | 切换会话 |
| `/message` | 查看最近消息 |
| `/stop` | 停止当前任务 |
| `/model` | 查看或选择模型 |
| `/model update` | 刷新模型列表 |
| `/model <modelId>` | 设置模型 |
| `/effort` | 查看可用推理强度 |
| `/effort <值>` | 设置推理强度 |
| `/profile` | 查看运行配置 |
| `/approve` | 批准当前操作 |
| `/reject` | 拒绝当前操作 |
| `/send <相对路径>` | 发送项目内文件到飞书 |
| `/help` | 查看帮助 |

旧写法 `/codex bind ...`、`/claude bind ...`、`/opencode bind ...` 等仍兼容；推荐统一使用不带 Agent 名称的通用 `/` 命令。

## 长回答与卡片显示

长回复完成后，桥会优先识别“结论、总结、建议、下一步”等结尾段落并直接显示，其余正文收进“输出结果”折叠面板。没有识别到明确结论时，默认显示最后 10%。

```dotenv
AGENT_BRIDGE_OUTPUT_VISIBLE_TAIL_PERCENT=10
```

允许范围为 5 到 50。卡片颜色集中定义在 `src/presentation/card/card-service.js` 的 `CARDKIT_CUSTOM_COLORS` 中，支持浅色和深色主题。

## 媒体与文件

- 飞书图片会下载到本地私有缓存，并作为 Agent 图片输入传入当前回合。
- 文件和音频会下载到本地缓存；文本文件附带安全预览，其他文件传递元信息和本地路径。
- `/send <相对路径>` 只允许发送当前绑定项目内的文件。
- Agent 可在回复中输出独立指令 `[[codex-feishu-send:relative/path/from/workspace]]`，桥会发送对应文件并从展示文本中移除该指令。

## 手动安装与开发

```sh
git clone https://github.com/Jokerautowrite/agent-feishu-bridge.git
cd agent-feishu-bridge
npm install
cp .env.example .env
npm run feishu-bot
```

提交修改前运行：

```sh
npm run check
npm run check:release
```

项目目录：

```text
src/app/             应用运行时和消息调度
src/domain/          工作区、会话、审批、附件和群聊领域逻辑
src/infra/           Agent 后端、飞书 SDK、配置和持久化适配器
src/presentation/    飞书消息与卡片渲染
src/shared/          通用解析与格式化工具
scripts/             测试、隐私扫描和发布检查
```

新增 Agent 后端时，实现与现有 RPC client 一致的桥接接口，并在 `src/infra/backend-registry.js` 注册。适配器应把后端事件转换为桥的线程、回合、消息、工具和 token 事件，不要让后端差异侵入飞书业务层。

## 安全边界

- `.env`、访问令牌、飞书密钥、运行日志和会话数据不得提交到仓库。
- 工作区白名单和绑定路径限制用于约束 Agent 可访问的项目目录。
- 文件回传仅允许当前绑定项目内的相对路径。
- 群聊建议启用允许列表、管理员和只读权限策略。
- 本项目不会内置私人知识库、个人记忆系统或组织专用自动化流程。

安全问题请参考 [SECURITY.md](SECURITY.md)。

## 排错

| 现象 | 优先检查 |
| --- | --- |
| 机器人完全没有回复 | 机器人能力、`im.message.receive_v1`、消息权限、应用版本是否已发布 |
| 能回复文字，但按钮没有反应 | `card.action.trigger` 和回调长连接 |
| 启动后提示 Agent 不可用 | 对应 CLI 是否安装、登录并可在同一用户环境中运行 |
| `/bind` 失败 | 使用绝对路径，或确认目录位于 `AGENT_BRIDGE_PROJECTS_ROOT` 下 |
| 图片或文件失败 | `im:resource` 权限、文件大小限制和项目路径 |
| 多台设备只有一台响应 | 不要让多个实例共用同一个飞书 App ID |

## 贡献

欢迎提交问题和 Pull Request。请保持功能通用、可复用，不要提交本机绝对路径、账号数据、密钥、聊天记录或组织专用逻辑。详细要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

Copyright © 2026 猫哥（猫哥工作室）。

- 个人学习、研究和非商业内部工具可免费使用，但必须保留署名和协议。
- 商业用途需要获得版权所有者书面授权。

完整条款见 [LICENSE](LICENSE)。
