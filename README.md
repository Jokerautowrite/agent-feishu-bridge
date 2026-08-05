# agent-feishu-bridge

自家二开的飞书桥：把本机 Agent 接入飞书/Lark，流式卡片、推理展示、审批流。

```text
飞书消息 -> 本机 Agent 后端 -> 飞书回复（流式卡片）
```

> 定位说明：本仓库 fork 自上游 `codex-feishu-bridge`，已做自有化改造。
> Claude 后端在独立分支/仓库维护（`~/projects/claude-feishu-bridge`），通过
> `CLAUDE_BRIDGE_BACKEND=claude` 切换，卡片格式、推理展示、审批流与 Codex 后端一致。

## 它能做什么

- 在飞书里和本机 Agent 对话。
- 把一个飞书会话绑定到一个本地项目目录。
- 在飞书里创建、切换、恢复 Agent 线程。
- 查看当前项目、当前线程和最近消息。
- 设置当前项目使用的模型和推理强度。
- 停止正在运行的 Agent 任务。
- 任务运行时，把后发消息作为引导注入当前任务。
- 通过飞书审批 Agent 发起的操作请求。
- 把绑定项目内的文件发送到飞书。
- 接收飞书图片并作为 Agent 原生图片输入读取。
- 让 Agent 通过隐藏指令把当前项目内的图片或文件回传到飞书。
- 用流式飞书卡片展示 Agent 回复、工具执行和 token 用量摘要。

## 它不做什么

- 不内置私有知识库。
- 不内置私人任务系统。
- 不内置记忆编译、召回脚本或每日沉淀。
- 不绑定任何特定团队的项目中枢或自动化系统。
- 不携带任何密钥、token、私有 ID、本地日志或个人工作区数据。

## 安装

```sh
npm install
npm run feishu-bot
```

作为 systemd 服务常驻（本机实际用法）：

```sh
systemctl --user status agent-feishu-bridge
```

## 基本配置

复制 `.env.example` 为 `.env`，填入飞书应用和默认参数：

```text
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
CODEX_IM_DEFAULT_CODEX_MODEL=gpt-5.3-codex
CODEX_IM_DEFAULT_CODEX_EFFORT=medium
CODEX_IM_DEFAULT_CODEX_ACCESS_MODE=default
CODEX_IM_ACTIVE_TURN_FOLLOW_UP_MODE=steer
```

图片和附件会下载到本机私有缓存，默认位置：

```text
~/.codex-feishu-bridge/attachments
```

配置加载顺序：

1. 当前目录的 `.env`
2. `~/.codex-im/.env`
3. 当前 shell 环境变量

## 常用命令

- `/codex bind /absolute/path`
- `/codex where`
- `/codex workspace`
- `/codex remove /absolute/path`
- `/codex send <relative-file-path>`
- `/codex switch <threadId>`
- `/codex message`
- `/codex new`
- `/codex stop`
- `/codex model`
- `/codex model update`
- `/codex model <modelId>`
- `/codex effort`
- `/codex effort <low|medium|high|xhigh|max|ultra>`
- `/codex profile`
- `/codex profile main`
- `/codex approve`
- `/codex approve workspace`
- `/codex reject`
- `/codex help`

## 飞书应用要求

事件订阅：

| 事件 | 标识 |
| --- | --- |
| 接收消息 | `im.message.receive_v1` |
| 卡片回传交互 | `card.action.trigger` |

推荐权限：

| 权限 | 标识 |
| --- | --- |
| 创建与更新卡片 | `cardkit:card:write` |
| 获取卡片信息 | `cardkit:card:read` |
| 以应用身份发消息 | `im:message:send_as_bot` |
| 读取用户发给机器人的单聊消息 | `im:message.p2p_msg:readonly` |
| 发送/删除表情回复 | `im:message.reactions:write_only` |
| 获取与上传图片或文件资源 | `im:resource` |

## 媒体附件

- 收图：飞书/Lark 图片会下载到本地私有缓存，并作为 Agent 原生图片输入进入当前轮。
- 收文件/语音：文件和音频会下载到本地私有缓存；文本类文件会附带安全预览，二进制文件和音频先传元信息与本地路径。
- 手动回传：`/codex send <当前项目下的相对文件路径>` 会自动按类型发送，图片走飞书图片消息，`.opus/.mp4` 走音频消息，其他文件走普通文件消息。
- 自动回传：Agent 回复中可包含独立一行隐藏指令 `[[codex-feishu-send:relative/path/from/workspace]]`，桥会上传该文件并从飞书发出，同时从展示文本中移除指令。

## 开发检查

```sh
npm run check
npm run check:release
```

## 我们的产品

- **猫哥 · vibecoding** — 个人站：自然语言即代码，人人都是创造者：[https://tn-vibecoding.eu.cc](https://tn-vibecoding.eu.cc)
- **5yuantoken 中转站** — 稳定高速的 AI API 中转平台：[https://5yuantoken.org](https://5yuantoken.org)
- **五元创影** — AI 生图/视频创作站：[https://canvas.5yuantoken.org](https://canvas.5yuantoken.org)

## 赞助支持

如果这个项目帮到了你，欢迎打赏一杯咖啡 ☕

<table>
  <tr>
    <td align="center"><img src="docs/sponsor/wechat-sponsor.jpg" width="200" alt="微信赞助"><br><b>微信</b></td>
    <td align="center"><img src="docs/sponsor/alipay-sponsor.jpg" width="200" alt="支付宝赞助"><br><b>支付宝</b></td>
  </tr>
</table>

赞助会用于维护本项目的服务器与开发投入，感谢你的支持 🙏

## License

自定义开源协议 © 2026 猫哥

- 个人学习、研究、内部工具：免费，但须注明出处。
- 商业用途：需联系版权所有者获得授权并支付版权费。

完整条款见 [LICENSE](LICENSE)。
