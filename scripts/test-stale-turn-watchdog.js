#!/usr/bin/env node

const assert = require("node:assert/strict");
const { FeishuBotRuntime } = require("../src/app/feishu-bot-runtime");
const { trackRunningTurnStartedAt } = require("../src/app/codex-event-service");

function createRuntime() {
  const runtime = Object.create(FeishuBotRuntime.prototype);
  runtime.activeTurnIdByThreadId = new Map();
  runtime.activeTurnStartedAtByThreadId = new Map();
  runtime.activeTurnLastActivityAtByThreadId = new Map();
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
    runtime.activeTurnLastActivityAtByThreadId.delete(threadId);
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
  runtime.activeTurnStartedAtByThreadId.set(threadId, Date.now() - timeoutMs + 10000);

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
  const busy = createRuntime();
  busy.activeTurnStartedAtByThreadId.set("busy", Date.now() - 60 * 60 * 1000);
  busy.activeTurnLastActivityAtByThreadId.set("busy", Date.now());
  await busy.clearStaleTurns(15 * 60 * 1000);
  assert.deepEqual(busy.cleanedThreads, [], "an active long task must not expire based on total age");
  testActivityTracking();
  await testProgressDuringReactionClearIsNotDiscarded();
  console.log("stale turn watchdog checks passed");
}

function testActivityTracking() {
  const runtime = createRuntime();
  const params = { threadId: "tracked", turnId: "current" };
  runtime.activeTurnIdByThreadId.set("tracked", "current");
  trackRunningTurnStartedAt(runtime, { method: "turn/started", params });
  assert.ok(runtime.activeTurnStartedAtByThreadId.has("tracked"));
  assert.ok(runtime.activeTurnLastActivityAtByThreadId.has("tracked"));

  for (const method of [
    "item/started", "item/completed", "item/agentMessage/delta", "item/plan/delta",
    "item/commandExecution/outputDelta", "item/reasoning/summaryTextDelta",
    "item/mcpToolCall/progress", "turn/plan/updated", "turn/diff/updated",
  ]) {
    runtime.activeTurnLastActivityAtByThreadId.set("tracked", 1);
    trackRunningTurnStartedAt(runtime, { method, params: { ...params, delta: "progress" } });
    assert.ok(runtime.activeTurnLastActivityAtByThreadId.get("tracked") > 1, method);
  }
  for (const method of ["thread/status/changed", "thread/tokenUsage/updated", "unrelated/heartbeat"]) {
    runtime.activeTurnLastActivityAtByThreadId.set("tracked", 1);
    trackRunningTurnStartedAt(runtime, { method, params });
    assert.equal(runtime.activeTurnLastActivityAtByThreadId.get("tracked"), 1, method);
  }
  trackRunningTurnStartedAt(runtime, {
    method: "item/agentMessage/delta", params: { ...params, turnId: "old", delta: "late" },
  });
  assert.equal(runtime.activeTurnLastActivityAtByThreadId.get("tracked"), 1, "late old-turn progress is ignored");
  trackRunningTurnStartedAt(runtime, { method: "turn/completed", params });
  assert.equal(runtime.activeTurnStartedAtByThreadId.has("tracked"), false);
  assert.equal(runtime.activeTurnLastActivityAtByThreadId.has("tracked"), false);
  trackRunningTurnStartedAt(runtime, { method: "item/started", params });
  assert.equal(runtime.activeTurnLastActivityAtByThreadId.has("tracked"), false, "late item does not revive a terminal turn");
}

async function testProgressDuringReactionClearIsNotDiscarded() {
  const runtime = createRuntime();
  runtime.activeTurnStartedAtByThreadId.set("racing", Date.now() - 3600000);
  runtime.clearPendingReactionForThread = async () => {
    runtime.activeTurnLastActivityAtByThreadId.set("racing", Date.now());
  };
  await runtime.clearStaleTurns(900000);
  assert.deepEqual(runtime.cleanedThreads, [], "recheck progress after awaiting reaction removal");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
