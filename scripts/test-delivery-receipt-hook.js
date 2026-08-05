#!/usr/bin/env node

const assert = require("node:assert/strict");
const { DeliveryReceiptHook, buildReceiptIds } = require("../src/app/delivery-receipt-hook");
const { deliverToFeishu } = require("../src/app/codex-event-service");
const { mapCodexMessageToImEvent } = require("../src/infra/codex/message-utils");

async function main() {
  const calls = [];
  const hook = new DeliveryReceiptHook({
    cliPath: "/test/ledger",
    ledgerPath: "/test/ledger.sqlite3",
    exec: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "ok" };
    },
  });

  assert.deepStrictEqual(await hook.claimInbound({
    header: { event_id: "event-raw" },
    message: { message_id: "message-raw", chat_id: "recipient-raw" },
  }), { duplicate: false });
  assert.strictEqual(await hook.recordOutboundCompletion({
    inboundMessageId: "message-raw",
    providerReceipt: "provider-raw",
  }), true);
  assert.strictEqual(await hook.recordOutboundCompletion({
    inboundMessageId: "other-message",
  }), false);

  const serialized = JSON.stringify(calls);
  assert.ok(!serialized.includes("message-raw"));
  assert.ok(!serialized.includes("recipient-raw"));
  assert.ok(!serialized.includes("event-raw"));
  assert.ok(!serialized.includes("provider-raw"));
  assert.ok(calls[0].args.includes("append"));
  assert.ok(calls[1].args.includes("transition"));
  assert.deepStrictEqual(buildReceiptIds("message-raw"), buildReceiptIds("message-raw"));

  const duplicateHook = new DeliveryReceiptHook({
    cliPath: "/test/ledger",
    ledgerPath: "/test/ledger.sqlite3",
    exec: async () => {
      const error = new Error("exit 1");
      error.stderr = "duplicate or invalid delivery metadata";
      throw error;
    },
  });
  assert.deepStrictEqual(await duplicateHook.claimInbound({
    message: { message_id: "message-raw", chat_id: "recipient-raw" },
  }), { duplicate: true });

  const nonfatalHook = new DeliveryReceiptHook({
    cliPath: "/test/ledger",
    ledgerPath: "/test/ledger.sqlite3",
    exec: async () => {
      throw new Error("ledger unavailable");
    },
  });
  assert.deepStrictEqual(await nonfatalHook.claimInbound({
    message: { message_id: "message-raw" },
  }), { duplicate: false });
  assert.strictEqual(await nonfatalHook.recordOutboundCompletion({
    inboundMessageId: "message-raw",
    providerReceipt: "provider-raw",
  }), false);

  const terminalCalls = [];
  const terminalHook = new DeliveryReceiptHook({
    cliPath: "/test/ledger",
    ledgerPath: "/test/ledger.sqlite3",
    exec: async (_command, args) => terminalCalls.push(args),
  });
  assert.strictEqual(await terminalHook.recordGenerationFailure({
    inboundMessageId: "failed-message",
    failureClass: "model error",
  }), true);
  assert.ok(terminalCalls[0].includes("generation-error-model-error"));
  assert.strictEqual(await terminalHook.recordCancelled({
    inboundMessageId: "cancelled-message",
  }), true);
  assert.ok(terminalCalls[1].includes("skipped"));
  assert.ok(terminalCalls[1].includes("suppressed"));
  assert.deepStrictEqual(mapCodexMessageToImEvent({
    method: "turn/cancelled",
    params: { threadId: "thread-cancel", turnId: "turn-cancel" },
  }), {
    type: "im.run_state",
    payload: {
      threadId: "thread-cancel",
      turnId: "turn-cancel",
      state: "cancelled",
    },
  });

  const receiptEvents = [];
  const runtime = {
    config: {
      feishuStreamingOutput: true,
      feishuCardKitStreaming: true,
    },
    pendingChatContextByThreadId: new Map([
      ["thread-ok", { messageId: "inbound-ok" }],
      ["thread-fail", { messageId: "inbound-fail" }],
      ["thread-cancel", { messageId: "inbound-cancel" }],
    ]),
    upsertAssistantReplyCard: async ({ threadId, state }) => {
      if (threadId === "thread-fail" && state === "completed") {
        throw new Error("provider rejected");
      }
      return { providerReceipt: "om-provider-confirmed" };
    },
    deliveryReceipts: {
      recordOutboundCompletion: async (payload) => receiptEvents.push(["sent", payload]),
      recordOutboundFailure: async (payload) => receiptEvents.push(["send-failed", payload]),
      recordGenerationFailure: async (payload) => receiptEvents.push(["generation-failed", payload]),
      recordCancelled: async (payload) => receiptEvents.push(["cancelled", payload]),
    },
  };
  await deliverToFeishu(runtime, {
    type: "im.run_state",
    payload: { threadId: "thread-ok", turnId: "turn-ok", chatId: "chat", state: "completed" },
  });
  assert.deepStrictEqual(receiptEvents[0], ["sent", {
    inboundMessageId: "inbound-ok",
    providerReceipt: "om-provider-confirmed",
  }]);
  await assert.rejects(deliverToFeishu(runtime, {
    type: "im.run_state",
    payload: { threadId: "thread-fail", turnId: "turn-fail", chatId: "chat", state: "completed" },
  }), /provider rejected/);
  assert.equal(receiptEvents[1][0], "send-failed");
  await deliverToFeishu(runtime, {
    type: "im.run_state",
    payload: { threadId: "thread-fail", turnId: "turn-fail", chatId: "chat", state: "failed" },
  });
  assert.equal(receiptEvents[2][0], "generation-failed");
  await deliverToFeishu(runtime, {
    type: "im.run_state",
    payload: { threadId: "thread-cancel", turnId: "turn-cancel", chatId: "chat", state: "cancelled" },
  });
  assert.equal(receiptEvents[3][0], "cancelled");

  console.log("delivery receipt hook fixtures ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
