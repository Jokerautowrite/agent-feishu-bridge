#!/usr/bin/env node

const assert = require("assert");
const { handlePanelCardAction } = require("../src/app/command-dispatcher");
const { handleStopCommand } = require("../src/app/codex-event-service");
const { extractCardAction } = require("../src/presentation/message/normalizers");

async function main() {
  const action = extractCardAction({
    action: {
      value: {
        kind: "panel",
        action: "stop",
        threadId: "thread-card",
        requestId: "turn-card",
      },
    },
  });
  assert.deepEqual(action, {
    kind: "panel",
    action: "stop",
    selectedValue: "",
    threadId: "thread-card",
    requestId: "turn-card",
  });

  let stopInput = null;
  const dispatchRuntime = {
    buildCardResponse: () => ({}),
    queueCardActionWithFeedback: (_normalized, _feedback, task) => task(),
    handleStopCommand: async (normalized) => { stopInput = normalized; },
  };
  await handlePanelCardAction(dispatchRuntime, action, { chatId: "chat-card" });
  assert.equal(stopInput.threadId, "thread-card");
  assert.equal(stopInput.requestId, "turn-card");

  const interrupts = [];
  const messages = [];
  const runtime = {
    getBindingContext: () => ({ bindingKey: "binding", workspaceRoot: "" }),
    resolveThreadIdForBinding: () => null,
    activeTurnIdByThreadId: new Map(),
    codex: {
      sendRequest: async (method, params) => interrupts.push({ method, params }),
    },
    cleanupThreadRuntimeState: () => {},
    sendInfoCardMessage: async (message) => messages.push(message),
  };
  await handleStopCommand(runtime, {
    chatId: "chat-card",
    messageId: "message-card",
    threadId: "thread-card",
    requestId: "turn-card",
  });
  assert.deepEqual(interrupts, [{
    method: "turn/interrupt",
    params: { threadId: "thread-card", turnId: "turn-card" },
  }]);
  assert.equal(messages.length, 1);

  console.log("stop card action tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
