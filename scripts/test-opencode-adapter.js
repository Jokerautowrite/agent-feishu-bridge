"use strict";
/**
 * 适配器冒烟测试：验证 opencode 适配器能否把 opencode serve
 * 的 SSE 事件翻译成桥认识的 Codex 契约事件。
 * 用法：node scripts/test-opencode-adapter.js
 */
const { OpencodeRpcClient } = require("../src/infra/opencode/rpc-client");

const SERVER_URL = process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096";

async function main() {
  const client = new OpencodeRpcClient({ serverUrl: SERVER_URL, logLevel: "verbose" });
  const events = [];
  client.onMessage((msg) => {
    events.push(msg);
    const p = msg.params || {};
    if (msg.method === "item/agentMessage/delta") {
      process.stdout.write(p.delta);
    } else {
      const item = p.item || {};
      console.log(`\n[EVENT] ${msg.method} turn=${p.turnId?.slice(0,8)} item=${item.type || "-"}${item.text ? ` text=${item.text.slice(0,60)}` : ""}${item.command ? ` cmd=${item.command.slice(0,50)}` : ""}`);
    }
  });

  // 1. connect + listModels
  await client.connect();
  await client.initialize();
  console.log("=== connected ===");

  const modelResp = await client.listModels();
  const models = modelResp.result?.data || modelResp.data || [];
  console.log(`=== model/list: ${models.length} models ===`);
  console.log(models.slice(0, 5).map((m) => m.id).join(", "));

  // 2. startThread
  const threadResp = await client.startThread({ cwd: process.env.HOME });
  const threadId = threadResp.result?.thread?.id;
  console.log(`=== thread/start → ${threadId} ===`);

  // 3. 启动 SSE 循环
  client.startSseLoop().catch((e) => console.error(`SSE loop: ${e.message}`));

  // 4. 发消息（用一段会触发工具的消息验证工具事件）
  const prompt = process.env.OPENCODE_TEST_PROMPT || "用 bash 运行 `echo 适配器测试OK` 然后回复结果";
  console.log(`=== sendUserMessage: ${prompt} ===`);
  await client.sendUserMessage({ threadId, text: prompt, workspaceRoot: process.env.HOME });

  // 等待事件流结束（直到 turn/completed 或超时）
  const deadline = Date.now() + 120000;
  const completed = await new Promise((resolve) => {
    const timer = setInterval(() => {
      const done = events.some((e) => e.method === "turn/completed" || e.method === "turn/failed");
      if (done) { clearInterval(timer); resolve(true); }
      else if (Date.now() > deadline) { clearInterval(timer); resolve(false); }
    }, 500);
  });

  client.stopSseLoop();
  console.log(`\n=== turn ${completed ? "completed" : "TIMEOUT"} ===`);
  const methods = [...new Set(events.map((e) => e.method))];
  console.log("事件类型:", methods.join(", "));
  const usageEvents = events.filter((e) => e.method === "thread/tokenUsage/updated");
  if (usageEvents.length) {
    console.log("tokenUsage:", JSON.stringify(usageEvents[usageEvents.length - 1].params.tokenUsage));
  }
  const finalText = events
    .filter((e) => e.method === "item/completed" && e.params?.item?.type === "agentMessage")
    .map((e) => e.params.item.text)
    .join("\n");
  console.log("最终正文片段:", finalText.slice(-200));

  process.exit(completed ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
