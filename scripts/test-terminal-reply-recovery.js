#!/usr/bin/env node

const assert = require("node:assert/strict");
const { handleCodexMessage, deliverToFeishu } = require("../src/app/codex-event-service");
const { mapCodexMessageToImEvent } = require("../src/infra/codex/message-utils");

function waitForAsyncDelivery() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createRuntime() {
  const delivered = [];
  const runtime = {
    config: { logLevel: "quiet" },
    assistantDeltaSeenByRunKey: new Map(),
    activeTurnIdByThreadId: new Map(),
    activeTurnStartedAtByThreadId: new Map(),
    turnFailureTextByRunKey: new Map(),
    pendingApprovalByThreadId: new Map(),
    pendingChatContextByThreadId: new Map(),
    currentRunKeyByThreadId: new Map(),
    latestTokenUsageByThreadId: new Map(),
    toolItemIdsByRunKey: new Map(),
    toolTraceByRunKey: new Map(),
    clearedThreads: [],
    cleanedThreads: [],
    pruneRuntimeMapSizes() {},
    clearPendingReactionForThread: async (threadId) => runtime.clearedThreads.push(threadId),
    cleanupThreadRuntimeState(threadId) {
      runtime.cleanedThreads.push(threadId);
      runtime.activeTurnIdByThreadId.delete(threadId);
      runtime.activeTurnStartedAtByThreadId.delete(threadId);
      runtime.pendingChatContextByThreadId.delete(threadId);
      for (const runKey of runtime.turnFailureTextByRunKey.keys()) {
        if (runKey.startsWith(`${threadId}:`)) {
          runtime.turnFailureTextByRunKey.delete(runKey);
        }
      }
    },
    async deliverToFeishu(event) {
      delivered.push(event);
    },
  };
  return { runtime, delivered };
}

async function testGenericErrorBecomesVisibleFailureAtCompletion() {
  const { runtime, delivered } = createRuntime();
  const threadId = "thread-generic-error";
  const turnId = "turn-generic-error";
  runtime.activeTurnIdByThreadId.set(threadId, turnId);
  runtime.activeTurnStartedAtByThreadId.set(threadId, Date.now());
  runtime.pendingChatContextByThreadId.set(threadId, {
    chatId: "chat-generic-error",
    messageId: "message-generic-error",
  });

  handleCodexMessage(runtime, {
    method: "error",
    params: {
      threadId,
      turnId,
      error: { message: "upstream request failed" },
    },
  });
  await waitForAsyncDelivery();
  assert.equal(delivered.length, 0, "raw error waits for its terminal turn event");

  handleCodexMessage(runtime, {
    method: "turn/completed",
    params: {
      threadId,
      turnId,
      turn: { status: "completed" },
    },
  });
  await waitForAsyncDelivery();

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].payload.state, "failed");
  assert.match(delivered[0].payload.text, /执行失败：upstream request failed/);
  assert.equal(runtime.turnFailureTextByRunKey.size, 0, "terminal cleanup clears cached failure");
}

async function testGenericErrorWithoutDetailStillGetsFailureCard() {
  const { runtime, delivered } = createRuntime();
  const threadId = "thread-generic-error-no-detail";
  const turnId = "turn-generic-error-no-detail";
  runtime.activeTurnIdByThreadId.set(threadId, turnId);
  runtime.activeTurnStartedAtByThreadId.set(threadId, Date.now());
  runtime.pendingChatContextByThreadId.set(threadId, {
    chatId: "chat-generic-error-no-detail",
    messageId: "message-generic-error-no-detail",
  });

  handleCodexMessage(runtime, {
    method: "error",
    params: { threadId, turnId, error: {} },
  });
  handleCodexMessage(runtime, {
    method: "turn/completed",
    params: {
      threadId,
      turnId,
      turn: { status: "completed" },
    },
  });
  await waitForAsyncDelivery();

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].payload.state, "failed");
  assert.match(delivered[0].payload.text, /未返回详细原因/);
}

function testMappedTerminalFailureOverridesCompletedStatus() {
  const event = mapCodexMessageToImEvent(
    {
      method: "turn/completed",
      params: {
        threadId: "thread-map",
        turnId: "turn-map",
        turn: { status: "completed" },
      },
    },
    { terminalFailureText: "执行失败：model unavailable" }
  );
  assert.equal(event.payload.state, "failed");
  assert.equal(event.payload.text, "执行失败：model unavailable");
}

async function testFinalReceiptDoesNotBlindRetry() {
  const calls = { upsert: 0, flush: 0, recorded: 0 };
  const runtime = {
    pendingChatContextByThreadId: new Map([["thread-retry", { messageId: "message-retry" }]]),
    async upsertAssistantReplyCard() {
      calls.upsert += 1;
      return {};
    },
    async flushAssistantReplyCardNow() {
      calls.flush += 1;
      assert.fail("an ambiguous final receipt must not trigger a second card flush");
    },
    deliveryReceipts: {
      async recordOutboundCompletion() {
        assert.fail("an ambiguous final receipt must not be recorded as delivered");
      },
      async recordOutboundFailure({ inboundMessageId, failureClass }) {
        calls.recorded += 1;
        assert.equal(inboundMessageId, "message-retry");
        assert.equal(failureClass, "receipt-unknown");
      },
    },
  };

  await deliverToFeishu(runtime, {
    type: "im.run_state",
    payload: {
      state: "completed",
      threadId: "thread-retry",
      turnId: "turn-retry",
      chatId: "chat-retry",
    },
  });

  assert.deepEqual(calls, { upsert: 1, flush: 0, recorded: 1 });
}

(async () => {
  await testGenericErrorBecomesVisibleFailureAtCompletion();
  await testGenericErrorWithoutDetailStillGetsFailureCard();
  testMappedTerminalFailureOverridesCompletedStatus();
  await testFinalReceiptDoesNotBlindRetry();
  console.log("terminal reply recovery fixtures ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
