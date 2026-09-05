#!/usr/bin/env node

const assert = require("node:assert/strict");
const appDispatcher = require("../src/app/dispatcher");
const { handleInboundFeishuMessage } = require("../src/app/feishu-bot-runtime");

async function main() {
  const originalHandler = appDispatcher.onFeishuTextEvent;
  try {
    await testHandlerWaitsForDispatch();
    await testDispatchFailureIsVisible();
    await testLedgerFailureIsVisible();
    console.log("inbound handler fixtures ok");
  } finally {
    appDispatcher.onFeishuTextEvent = originalHandler;
  }
}

async function testHandlerWaitsForDispatch() {
  let releaseDispatch;
  let dispatchStarted = false;
  let settled = false;
  const dispatch = new Promise((resolve) => {
    releaseDispatch = resolve;
  });
  const runtime = createRuntime();
  appDispatcher.onFeishuTextEvent = async () => {
    dispatchStarted = true;
    await dispatch;
    return "dispatch-result";
  };

  const handlerPromise = handleInboundFeishuMessage(runtime, buildEvent("message-wait"));
  handlerPromise.finally(() => {
    settled = true;
  });
  await nextTick();
  assert.equal(dispatchStarted, true);
  assert.equal(settled, false, "inbound handler must remain pending while dispatch is pending");

  releaseDispatch();
  assert.equal(await handlerPromise, "dispatch-result");
  assert.equal(settled, true);
}

async function testDispatchFailureIsVisible() {
  const feedback = [];
  const runtime = createRuntime({
    sendInfoCardMessage: async (payload) => feedback.push(payload),
  });
  appDispatcher.onFeishuTextEvent = async () => {
    throw new Error("dispatch failed");
  };

  await handleInboundFeishuMessage(runtime, buildEvent("message-fail"));

  assert.deepEqual(feedback, [{
    chatId: "chat-1",
    replyToMessageId: "message-fail",
    text: "处理消息时发生错误，详情已记录，请稍后重试。",
    kind: "error",
  }]);
  assert.equal(runtime.recentInboundMessageIds.has("message-fail"), false);
}

async function testLedgerFailureIsVisible() {
  const feedback = [];
  const runtime = createRuntime({
    claimInbound: async () => {
      throw new Error("ledger unavailable");
    },
    sendInfoCardMessage: async (payload) => feedback.push(payload),
  });

  await handleInboundFeishuMessage(runtime, buildEvent("message-ledger-fail"));

  assert.deepEqual(feedback, [{
    chatId: "chat-1",
    replyToMessageId: "message-ledger-fail",
    text: "处理消息时发生错误，详情已记录，请稍后重试。",
    kind: "error",
  }]);
}

function createRuntime({
  claimInbound = async () => ({ duplicate: false }),
  sendInfoCardMessage = async () => null,
} = {}) {
  return {
    deliveryReceipts: {
      claimInbound,
    },
    recentInboundMessageIds: new Map(),
    sendInfoCardMessage,
  };
}

function buildEvent(messageId) {
  return {
    message: {
      message_id: messageId,
      chat_id: "chat-1",
    },
  };
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
