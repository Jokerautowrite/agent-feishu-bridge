"use strict";
/**
 * 桥上层消费验证：用适配器发出的事件跑一遍 message-utils 的映射，
 * 确认桥的展示层（卡片）能正常消费 opencode 后端的事件。
 * 用法：node scripts/test-opencode-bridge-integration.js
 */
const { OpencodeRpcClient } = require("../src/infra/opencode/rpc-client");
const messageUtils = require("../src/infra/codex/message-utils");

const SERVER_URL = process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096";

async function main() {
  const client = new OpencodeRpcClient({ serverUrl: SERVER_URL });
  const imEvents = [];
  let deltaBuffer = "";

  client.onMessage((msg) => {
    // 模拟桥的 appDispatcher.onCodexMessage → messageUtils.mapCodexMessageToImEvent
    const imEvent = messageUtils.mapCodexMessageToImEvent(msg, {});
    if (!imEvent) return;
    if (imEvent.type === "im.agent_reply" && imEvent.payload.mode === "delta") {
      deltaBuffer += imEvent.payload.text;
    }
    imEvents.push({
      type: imEvent.type,
      state: imEvent.payload.state,
      text: (imEvent.payload.text || "").slice(0, 80),
      itemType: imEvent.payload.item?.type,
    });
  });

  await client.connect();
  await client.initialize();

  const tr = await client.startThread({ cwd: process.env.HOME });
  const threadId = tr.result.thread.id;
  console.log(`thread: ${threadId}`);

  await client.sendUserMessage({
    threadId,
    text: "用 bash 运行 `echo 桥集成测试`，然后回复一句话总结",
    workspaceRoot: process.env.HOME,
  });

  // 等 turn 结束
  const deadline = Date.now() + 120000;
  const done = await new Promise((resolve) => {
    const timer = setInterval(() => {
      const terminal = imEvents.some((e) => e.state === "completed" || e.state === "failed");
      if (terminal) { clearInterval(timer); resolve(true); }
      else if (Date.now() > deadline) { clearInterval(timer); resolve(false); }
    }, 500);
  });

  client.stopSseLoop();
  console.log(`\n=== turn ${done ? "completed" : "TIMEOUT"} ===`);
  console.log("事件序列:");
  imEvents.forEach((e, i) => {
    console.log(`  ${i + 1}. ${e.type} ${e.state ? `state=${e.state}` : ""} ${e.text ? `text=${e.text}` : ""} ${e.itemType ? `item=${e.itemType}` : ""}`);
  });
  console.log("\n流式正文:", deltaBuffer ? `"${deltaBuffer.slice(0, 200)}"` : "(空)");

  const ok = done && deltaBuffer.trim().length > 0;
  console.log(`\n${ok ? "✅ 桥集成链路完整" : "❌ 链路异常"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
