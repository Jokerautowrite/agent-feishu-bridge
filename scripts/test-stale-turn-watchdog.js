#!/usr/bin/env node

const assert = require("node:assert/strict");
const { FeishuBotRuntime } = require("../src/app/feishu-bot-runtime");

function createRuntime() {
  const runtime = Object.create(FeishuBotRuntime.prototype);
  runtime.activeTurnIdByThreadId = new Map();
  runtime.activeTurnStartedAtByThreadId = new Map();
  runtime.pendingChatContextByThreadId = new Map();
  runtime.clearedReactions = [];
  runtime.cleanedThreads = [];
  runtime.notifications = [];
  runtime.clearPendingReactionForThread = async (threadId) => {
    runtime.clearedReactions.push(threadId);
  };
  runtime.cleanupThreadRuntimeState = (threadId) => {
    runtime.cleanedThreads.push(threadId);
    runtime.activeTurnIdByThreadId.delete(threadId);
    runtime.activeTurnStartedAtByThreadId.delete(threadId);
    runtime.pendingChatContextByThreadId.delete(threadId);
  };
  runtime.sendInfoCardMessage = async (message) => {
    runtime.notifications.push(message);
  };
  return runtime;
}

async function testStaleTurnIsReleasedAndNotified() {
  const runtime = createRuntime();
  const timeoutMs = 15 * 60 * 1000;
  const threadId = "stale-thread";
  runtime.activeTurnIdByThreadId.set(threadId, "turn-1");
  runtime.activeTurnStartedAtByThreadId.set(threadId, Date.now() - timeoutMs - 1);
  runtime.pendingChatContextByThreadId.set(threadId, {
    chatId: "chat-1",
    messageId: "message-1",
  });

  await runtime.clearStaleTurns(timeoutMs);

  assert.deepEqual(runtime.clearedReactions, [threadId]);
  assert.deepEqual(runtime.cleanedThreads, [threadId]);
  assert.equal(runtime.activeTurnIdByThreadId.has(threadId), false);
  assert.equal(runtime.activeTurnStartedAtByThreadId.has(threadId), false);
  assert.equal(runtime.notifications.length, 1);
  assert.equal(runtime.notifications[0].chatId, "chat-1");
  assert.equal(runtime.notifications[0].replyToMessageId, "message-1");
  assert.match(runtime.notifications[0].text, /自动解除飞书端占用/);
}

async function testFreshTurnIsLeftUntouched() {
  const runtime = createRuntime();
  const timeoutMs = 15 * 60 * 1000;
  const threadId = "fresh-thread";
  runtime.activeTurnIdByThreadId.set(threadId, "turn-2");
  runtime.activeTurnStartedAtByThreadId.set(threadId, Date.now() - timeoutMs + 1);

  await runtime.clearStaleTurns(timeoutMs);

  assert.equal(runtime.activeTurnIdByThreadId.get(threadId), "turn-2");
  assert.equal(runtime.activeTurnStartedAtByThreadId.has(threadId), true);
  assert.deepEqual(runtime.clearedReactions, []);
  assert.deepEqual(runtime.cleanedThreads, []);
  assert.deepEqual(runtime.notifications, []);
}

async function main() {
  await testStaleTurnIsReleasedAndNotified();
  await testFreshTurnIsLeftUntouched();
  console.log("stale turn watchdog checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
