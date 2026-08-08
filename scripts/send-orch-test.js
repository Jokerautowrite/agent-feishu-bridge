const fs = require("fs");
const os = require("os");
const path = require("path");
const lark = require("@larksuiteoapi/node-sdk");

// env 文件路径：优先环境变量 AGENT_BRIDGE_ENV_FILE，缺省 ~/.config/agent-bridge/agent-bridge-codex.env
const ENV_FILE = process.env.AGENT_BRIDGE_ENV_FILE
  || path.join(os.homedir(), ".config/agent-bridge/agent-bridge-codex.env");
const env = Object.fromEntries(
  fs.readFileSync(ENV_FILE, "utf8")
    .split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const backend = (env.AGENT_BRIDGE_BACKEND || "codex").toLowerCase();
const agentMeta = {
  codex: { name: "Codex", icon: "🤖" },
  opencode: { name: "OpenCode", icon: "⚡" },
  claude: { name: "Claude", icon: "🧠" },
  chuang: { name: "Chuang", icon: "🛰️" },
};
const meta = agentMeta[backend] || { name: backend, icon: "🤖" };
const client = new lark.Client({
  appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET,
  appType: lark.AppType.SelfBuild, domain: lark.Domain.Feishu,
  loggerLevel: lark.LoggerLevel.error,
});
// 测试群 chat_id：优先 env 文件里的 AGENT_BRIDGE_TEST_CHAT_ID，其次进程环境变量，最后命令行参数
const CHAT_ID = env.AGENT_BRIDGE_TEST_CHAT_ID
  || process.env.AGENT_BRIDGE_TEST_CHAT_ID
  || process.argv[2];
if (!CHAT_ID) {
  console.error("缺少测试群 chat_id：请在 env 文件设置 AGENT_BRIDGE_TEST_CHAT_ID，或传命令行参数");
  process.exit(1);
}

function opt(label, value) { return { text: { tag: "plain_text", content: label }, value }; }
function select(name, placeholder, options) { return { tag: "select_static", name, placeholder: { tag: "plain_text", content: placeholder }, options }; }
function btn(text, value, type = "default") { return { tag: "button", text: { tag: "plain_text", content: text }, type, value }; }

const card = {
  schema: "2.0",
  config: { wide_screen_mode: true, update_multi: true, style: { color: {} }, summary: { content: "🎛️ 编排控制台" } },
  header: { title: { tag: "plain_text", content: "🎛️ 编排控制台" }, template: "indigo" },
  body: {
    elements: [
      { tag: "markdown", content: `**${meta.icon} 当前智能体**：${meta.name} 桥（v0.2.4）\n**📁 当前项目**：\`~/projects/chuang-agent\``, text_size: "normal" },

      // 模型 + 强度（真实版从 Agent 拉取）
      { tag: "column_set", flex_mode: "none",
        columns: [
          { tag: "column", width: "weighted", weight: 1, elements: [
            select("model", "🤖 选择模型", [
              opt("gpt-5.5（当前）", "gpt-5.5"),
              opt("gpt-5.6-sol", "gpt-5.6-sol"),
              opt("deepseek-v4", "deepseek-v4"),
              opt("✏️ 自定义模型…", "__custom__"),
            ]),
          ]},
          { tag: "column", width: "weighted", weight: 1, elements: [
            select("effort", "⚡ 选择强度", [
              opt("低 low", "low"), opt("中 medium（当前）", "medium"),
              opt("高 high", "high"), opt("极高 xhigh", "xhigh"),
            ]),
          ]},
        ],
      },

      select("quick_cmd", "⚡ 快捷指令…", [
        opt("📖 /help 帮助", "/help"),
        opt("🗑️ 清空上下文", "/clear"),
        opt("🔁 切换项目", "/switch_project"),
      ]),
      { tag: "hr" },

      { tag: "column_set", flex_mode: "none",
        columns: [
          { tag: "column", width: "weighted", weight: 1, elements: [ btn("➕ 新建线程", { kind: "panel", action: "new_thread" }, "primary") ] },
          { tag: "column", width: "weighted", weight: 1, elements: [ btn("📋 全部线程", { kind: "panel", action: "open_threads" }) ] },
        ],
      },
      { tag: "hr" },

      { tag: "markdown", content: "**🧩 更多能力**", text_size: "notation" },
      { tag: "column_set", flex_mode: "none",
        columns: [
          { tag: "column", width: "weighted", weight: 1, elements: [ btn("🖼️ 生图", { kind: "cap", name: "imagegen" }, "primary") ] },
          { tag: "column", width: "weighted", weight: 1, elements: [ btn("🎬 生视频", { kind: "cap", name: "video" }, "primary") ] },
        ],
      },
      { tag: "column_set", flex_mode: "none",
        columns: [
          { tag: "column", width: "weighted", weight: 1, elements: [ btn("📚 查知识库", { kind: "cap", name: "brain" }) ] },
          { tag: "column", width: "weighted", weight: 1, elements: [ btn("✍️ 写文章", { kind: "cap", name: "writer" }) ] },
        ],
      },
    ],
  },
};

(async () => {
  const resp = await client.cardkit.v1.card.create({ data: { type: "card_json", data: JSON.stringify(card) } });
  const cardId = resp.data?.card_id || resp.card_id;
  await client.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: { receive_id: CHAT_ID, msg_type: "interactive",
            content: JSON.stringify({ type: "card", data: { card_id: cardId } }) } });
  console.log("✅ 绑定完成态控制台卡(v7) 已发送");
})().catch((e) => { console.error("失败:", (e.message || e).slice(0, 300)); process.exit(1); });
