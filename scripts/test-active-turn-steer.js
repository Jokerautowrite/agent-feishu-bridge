const assert = require("node:assert/strict");
const { CodexRpcClient } = require("../src/infra/codex/rpc-client");
const { onFeishuTextEvent } = require("../src/app/dispatcher");

async function main() {
  await testRpcClientBuildsTurnSteerRequest();
  await testRunningTurnMessagesAreSerializedAsSteering();
  await testRejectModeKeepsLegacyBusyMessage();
  console.log("active turn steer fixtures ok");
}

async function testRpcClientBuildsTurnSteerRequest() {
  const client = new CodexRpcClient({});
  let captured = null;
  client.sendRequest = async (method, params) => {
    captured = { method, params };
    return { turnId: "turn-1" };
  };

  await client.steerTurn({
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    text: "只查日志，不要改文件",
    attachments: [{ kind: "image", filePath: "/workspace/screenshot.png" }],
    clientUserMessageId: "message-1",
  });

  assert.deepEqual(captured, {
    method: "turn/steer",
    params: {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      clientUserMessageId: "message-1",
      input: [
        { type: "text", text: "只查日志，不要改文件" },
        { type: "localImage", path: "/workspace/screenshot.png" },
      ],
    },
  });
}

async function testRunningTurnMessagesAreSerializedAsSteering() {
  const firstGate = deferred();
  const calls = [];
  const cards = [];
  const runtime = createRuntime({
    steerTurn: async (params) => {
      calls.push(`start:${params.clientUserMessageId}`);
      if (params.clientUserMessageId === "message-1") {
        await firstGate.promise;
      }
      calls.push(`done:${params.clientUserMessageId}`);
      return { turnId: "turn-1" };
    },
    sendInfoCardMessage: async (payload) => cards.push(payload),
  });

  const first = onFeishuTextEvent(runtime, buildTextEvent("message-1", "只看错误日志"));
  await nextTick();
  assert.deepEqual(calls, ["start:message-1"]);

  const second = onFeishuTextEvent(runtime, buildTextEvent("message-2", "不要重启服务"));
  await nextTick();
  assert.deepEqual(calls, ["start:message-1"]);

  firstGate.resolve();
  await Promise.all([first, second]);

  assert.deepEqual(calls, [
    "start:message-1",
    "done:message-1",
    "start:message-2",
    "done:message-2",
  ]);
  assert.equal(cards.length, 2);
  assert.ok(cards.every((card) => card.kind === "progress"));
  assert.ok(cards.every((card) => card.text.includes("作为“引导”")));
  assert.equal(runtime.turnSteerQueueByThreadId.size, 0);
}

async function testRejectModeKeepsLegacyBusyMessage() {
  const cards = [];
  const runtime = createRuntime({
    activeTurnFollowUpMode: "reject",
    steerTurn: async () => {
      throw new Error("turn/steer should not run in reject mode");
    },
    sendInfoCardMessage: async (payload) => cards.push(payload),
  });

  await onFeishuTextEvent(runtime, buildTextEvent("message-3", "改成只读"));

  assert.equal(cards.length, 1);
  assert.match(cards[0].text, /当前线程还有任务在运行/);
}

function createRuntime({
  activeTurnFollowUpMode = "steer",
  steerTurn = async () => ({ turnId: "turn-1" }),
  sendInfoCardMessage = async () => null,
} = {}) {
  const threadId = "thread-1";
  return {
    config: {
      defaultWorkspaceId: "default",
      activeTurnFollowUpMode,
    },
    activeTurnIdByThreadId: new Map([[threadId, "turn-1"]]),
    pendingApprovalByThreadId: new Map(),
    codex: { steerTurn },
    dispatchTextCommand: async () => false,
    resolveWorkspaceContext: async () => ({
      bindingKey: "binding-1",
      workspaceRoot: "/workspace",
    }),
    resolveWorkspaceThreadState: async () => ({ threadId }),
    sendInfoCardMessage,
  };
}

function buildTextEvent(messageId, text) {
  return {
    message: {
      message_type: "text",
      message_id: messageId,
      chat_id: "chat-1",
      content: JSON.stringify({ text }),
    },
    sender: {
      sender_id: {
        open_id: "user-1",
      },
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
