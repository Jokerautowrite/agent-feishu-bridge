#!/usr/bin/env node

const assert = require("node:assert/strict");
const { FeishuBotRuntime } = require("../src/app/feishu-bot-runtime");
const { resolveWorkspaceThreadState } = require("../src/domain/thread/thread-service");

function createRuntime({
  chatWorkspaceRoot = "",
  threadWorkspaceRoot = "",
  inheritedThreadWorkspaceRoot = "",
} = {}) {
  const runtime = Object.create(FeishuBotRuntime.prototype);
  runtime.sessionStore = {
    buildBindingKey({ threadKey, messageId }) {
      return threadKey && threadKey !== messageId ? "thread-key" : "chat-key";
    },
    buildChatBindingKey() {
      return "chat-key";
    },
  };
  runtime.resolveWorkspaceRootForBinding = (bindingKey) => {
    if (bindingKey === "thread-key") {
      return threadWorkspaceRoot;
    }
    return chatWorkspaceRoot;
  };
  runtime.inheritThreadBindingFromSender = () => inheritedThreadWorkspaceRoot;
  runtime.inheritChatBindingFromLegacySender = () => "";
  return runtime;
}

function testNewFeishuThreadGetsItsOwnBinding() {
  const runtime = createRuntime({
    chatWorkspaceRoot: "/workspace",
    inheritedThreadWorkspaceRoot: "/workspace",
  });
  const result = runtime.getBindingContext({
    threadKey: "root-1",
    messageId: "reply-1",
  });
  assert.deepStrictEqual(result, {
    bindingKey: "thread-key",
    workspaceRoot: "/workspace",
  });
}

function testExistingFeishuThreadKeepsItsOwnBinding() {
  const runtime = createRuntime({
    chatWorkspaceRoot: "/workspace-chat",
    threadWorkspaceRoot: "/workspace-thread",
  });
  const result = runtime.getBindingContext({
    threadKey: "root-1",
    messageId: "reply-2",
  });
  assert.deepStrictEqual(result, {
    bindingKey: "thread-key",
    workspaceRoot: "/workspace-thread",
  });
}

function testUnthreadedChatKeepsChatBinding() {
  const runtime = createRuntime({
    chatWorkspaceRoot: "/workspace",
  });
  const result = runtime.getBindingContext({
    threadKey: "",
    messageId: "message-1",
  });
  assert.deepStrictEqual(result, {
    bindingKey: "chat-key",
    workspaceRoot: "/workspace",
  });
}

function testNewFeishuThreadCreatesAnEmptyThreadScopedBinding() {
  let savedBinding = null;
  const runtime = Object.create(FeishuBotRuntime.prototype);
  runtime.sessionStore = {
    buildBindingKey({ threadKey, messageId }) {
      return threadKey && threadKey !== messageId ? "thread-key" : "chat-key";
    },
    buildChatBindingKey() {
      return "chat-key";
    },
    findLegacySenderBindingKeyForChat() {
      return "";
    },
    getCodexParamsForWorkspace() {
      return {};
    },
    setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata) {
      savedBinding = { bindingKey, workspaceRoot, threadId, metadata };
    },
  };
  runtime.resolveWorkspaceRootForBinding = (bindingKey) => (
    bindingKey === "chat-key" ? "/workspace" : ""
  );

  const result = runtime.getBindingContext({
    workspaceId: "workspace-1",
    chatId: "chat-1",
    threadKey: "root-1",
    messageId: "reply-1",
    senderId: "sender-1",
  });
  assert.deepStrictEqual(result, {
    bindingKey: "thread-key",
    workspaceRoot: "/workspace",
  });
  assert.equal(savedBinding?.bindingKey, "thread-key");
  assert.equal(savedBinding?.workspaceRoot, "/workspace");
  assert.equal(savedBinding?.threadId, "");
  assert.equal(savedBinding?.metadata?.threadScopedBinding, true);
}

async function testThreadScopedBindingDoesNotAutoSelectOldThread() {
  const runtime = {
    codex: {
      async listThreads() {
        return {
          result: {
            data: [{
              id: "old-thread",
              cwd: "/workspace",
              sourceKind: "app",
            }],
          },
        };
      },
    },
    sessionStore: {
      getBinding() {
        return { threadScopedBinding: true };
      },
      getThreadIdForWorkspace() {
        return "";
      },
      setThreadIdForWorkspace() {
        throw new Error("thread-scoped binding must not select an old thread");
      },
    },
    resumedThreadIds: new Set(),
    resolveThreadIdForBinding() {
      return "";
    },
    setThreadBindingKey() {},
    setThreadWorkspaceRoot() {},
  };

  const result = await resolveWorkspaceThreadState(runtime, {
    bindingKey: "thread-key",
    workspaceRoot: "/workspace",
    normalized: {},
  });
  assert.equal(result.threadId, "");
  assert.equal(result.threads.length, 1);
}

testNewFeishuThreadGetsItsOwnBinding();
testExistingFeishuThreadKeepsItsOwnBinding();
testUnthreadedChatKeepsChatBinding();
testNewFeishuThreadCreatesAnEmptyThreadScopedBinding();
testThreadScopedBindingDoesNotAutoSelectOldThread()
  .then(() => console.log("thread-scoped binding fixtures ok"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
