#!/usr/bin/env node

const assert = require("node:assert/strict");
const { CodexRpcClient } = require("../src/infra/codex/rpc-client");
const { FeishuBotRuntime } = require("../src/app/feishu-bot-runtime");

async function main() {
  const threadId = "thread-transport-failure";
  const turnId = "turn-transport-failure";
  const delivered = [];
  const runtime = {
    config: { logLevel: "quiet" },
    assistantDeltaSeenByRunKey: new Map(),
    activeTurnIdByThreadId: new Map([[threadId, turnId]]),
    activeTurnStartedAtByThreadId: new Map(),
    turnFailureTextByRunKey: new Map(),
    pendingApprovalByThreadId: new Map(),
    pendingChatContextByThreadId: new Map([[threadId, { chatId: "chat-transport" }]]),
    currentRunKeyByThreadId: new Map([[threadId, `${threadId}:${turnId}`]]),
    latestTokenUsageByThreadId: new Map(),
    toolItemIdsByRunKey: new Map(),
    toolTraceByRunKey: new Map(),
    reasoningTraceByRunKey: new Map(),
    replyCardByRunKey: new Map(),
    pruneRuntimeMapSizes() {},
    async clearPendingReactionForThread() {},
    cleanupThreadRuntimeState() {},
    async deliverToFeishu(event) { delivered.push(event); },
  };

  let failureCallbacks = 0;
  const client = new CodexRpcClient({
    onTransportFailure: ({ error, source }) => {
      failureCallbacks += 1;
      FeishuBotRuntime.prototype.handleCodexTransportFailure.call(runtime, error, source);
    },
  });
  client.notifyTransportFailure(new Error("app-server exited with code 1"), "spawn-close");
  client.notifyTransportFailure(new Error("socket also closed"), "stdin-error");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failureCallbacks, 1, "error and close from one transport must notify only once");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].payload.state, "failed");
  assert.match(delivered[0].payload.text, /spawn-close/);
  assert.equal(runtime.activeTurnIdByThreadId.size, 0, "transport failure releases the active turn");
  FeishuBotRuntime.prototype.handleCodexTransportFailure.call(runtime, new Error("idle close"), "spawn-close");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered.length, 1, "idle transport failure must not invent a user reply");
  console.log("Codex transport failure fixtures ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
