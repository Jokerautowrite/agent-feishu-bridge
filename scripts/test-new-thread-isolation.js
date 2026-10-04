#!/usr/bin/env node
/**
 * /new（面板按钮与文本命令）隔离回归：
 * 1. 群聊未绑定时点击 New → 用群默认工作区建新线程，并真正切换；
 * 2. 下一条普通消息必须落在新线程，绝不能回到旧线程；
 * 3. 2 秒内两张不同卡片的点击不能被去重逻辑互相吞掉；
 * 4. 同一张卡片的重复点击仍要被拦截。
 */
const assert = require("node:assert/strict");
const { FeishuBotRuntime } = require("../src/app/feishu-bot-runtime");
const { SessionStore } = require("../src/infra/storage/session-store");
const { onFeishuTextEvent } = require("../src/app/dispatcher");
const { isDuplicateCardAction } = require("../src/presentation/card/card-service");
const { normalizeCardActionContext } = require("../src/presentation/message/normalizers");
const { handlePanelCardAction } = require("../src/app/command-dispatcher");

const workspaceRoot = "/fixture/group-workspace";
const bindingKey = "fixture:oc_group:chat";

function createRuntime() {
  const runtime = Object.create(FeishuBotRuntime.prototype);
  runtime.config = {
    defaultWorkspaceId: "fixture",
    activeTurnFollowUpMode: "reject",
    groupDefaultWorkspace: workspaceRoot,
    workspaceAllowlist: [],
    groupMentionOnly: false,
  };
  const store = Object.create(SessionStore.prototype);
  store.state = { bindings: {} };
  store.save = () => {};
  runtime.sessionStore = store;
  runtime.resumedThreadIds = new Set();
  for (const name of [
    "threadCreationByBindingWorkspace", "activeTurnIdByThreadId", "pendingApprovalByThreadId",
    "pendingChatContextByThreadId", "pendingChatContextByBindingKey", "bindingKeyByThreadId",
    "workspaceRootByThreadId", "currentRunKeyByThreadId",
    "assistantDeltaSeenByRunKey", "turnFailureTextByRunKey", "activeTurnStartedAtByThreadId",
    "activeTurnLastActivityAtByThreadId", "latestTokenUsageByThreadId", "toolItemIdsByRunKey",
    "toolTraceByRunKey", "reasoningTraceByRunKey", "replyCardByRunKey",
  ]) runtime[name] = new Map();
  runtime.cards = [];
  runtime.infos = [];
  runtime.starts = [];
  runtime.sent = [];
  runtime.backendThreads = new Map();
  runtime.codex = {
    startThread: async (params) => {
      const id = `thread-${runtime.starts.length + 1}`;
      runtime.starts.push(params);
      runtime.backendThreads.set(id, { id, cwd: params.cwd, messages: [] });
      return { result: { thread: { id } } };
    },
    resumeThread: async ({ threadId }) => ({ result: { thread: runtime.backendThreads.get(threadId) } }),
    listThreads: async () => ({ result: { data: [...runtime.backendThreads.values()].reverse() } }),
    sendUserMessage: async (params) => {
      runtime.sent.push(params);
      runtime.backendThreads.get(params.threadId).messages.push(params.text);
    },
  };
  runtime.sendInfoCardMessage = async (card) => { runtime.infos.push(card); };
  runtime.sendInteractiveCard = async ({ card }) => { runtime.cards.push(card); };
  runtime.addPendingReaction = async () => {};
  runtime.clearPendingReactionForBinding = async () => {};
  runtime.movePendingReactionToThread = () => {};
  runtime.setChatType = FeishuBotRuntime.prototype.setChatType;
  runtime.resolveChatType = FeishuBotRuntime.prototype.resolveChatType;
  runtime.chatTypeByChatId = new Map([["oc_group", "group"]]);
  runtime.memberNameCache = { getMemberName: () => "" };
  runtime.resolveGroupSenderName = async () => "";
  runtime.buildCardResponse = () => ({});
  runtime.queueCardActionWithFeedback = (normalized, feedback, task) => task();
  runtime.deliverToFeishu = async () => {};
  runtime.pruneRuntimeMapSizes = () => {};
  runtime.clearPendingReactionForThread = async () => {};
  runtime.disposeReplyRunState = () => {};
  return runtime;
}

function cardAction(messageId, panelMessageId) {
  return normalizeCardActionContext({
    context: { open_message_id: panelMessageId || messageId, open_chat_id: "oc_group" },
    operator: { open_id: "ou_admin", user_id: "on_admin" },
    action: { value: { kind: "panel", action: "new_thread" } },
  }, { defaultWorkspaceId: "fixture" });
}

function groupTextEvent(messageId, text) {
  return {
    message: {
      message_type: "text",
      message_id: messageId,
      chat_id: "oc_group",
      chat_type: "group",
      content: JSON.stringify({ text }),
    },
    sender: { sender_id: { open_id: "ou_admin", user_id: "on_admin" } },
  };
}

async function testPanelNewIsolatesFollowingMessage() {
  const runtime = createRuntime();
  // 先有一条旧线程（模拟“已经聊过、点 New 之前”的状态）。
  await runtime.handleNewCommand({
    workspaceId: "fixture",
    chatId: "oc_group",
    chatType: "group",
    messageId: "m0",
    threadKey: "",
  });
  await onFeishuTextEvent(runtime, groupTextEvent("m1", "这是一条普通群消息 @bot"));
  const oldThread = runtime.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
  assert.equal(oldThread, "thread-1");

  // 点面板 New（走真实 dispatch 链路）。
  const action = { kind: "panel", action: "new_thread", selectedValue: "" };
  const normalized = cardAction("m2");
  const handled = handlePanelCardAction(runtime, action, normalized);
  await (handled && typeof handled.then === "function" ? handled : Promise.resolve());
  await new Promise((resolve) => setImmediate(resolve));

  const newThread = runtime.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
  assert.notEqual(newThread, oldThread, "New must switch to a fresh thread");
  assert.ok(runtime.starts.length >= 2);

  // 下一条消息落新线程。
  await onFeishuTextEvent(runtime, groupTextEvent("m3", "新线程里的消息 @bot"));
  assert.equal(runtime.sent.at(-1).threadId, newThread, "post-New message must go to the new thread");
  assert.equal(runtime.backendThreads.get(oldThread).messages.length, 1, "old thread keeps only its old message");
}

function testDuplicateKeyDoesNotSwallowDifferentCards() {
  const action = { kind: "panel", action: "new_thread" };
  const first = cardAction("m4", "panel-a");
  const second = cardAction("m5", "panel-b");
  assert.equal(isDuplicateCardAction(action, first), false);
  assert.equal(isDuplicateCardAction(action, second), false, "different cards in 2s must both be handled");
  // 同一张卡片重复点击 → 拦截。
  const third = cardAction("m6", "panel-a");
  const again = isDuplicateCardAction(action, cardAction("m6", "panel-a"));
  assert.equal(again, true, "same card double-click must be deduped");
  void third;
}

async function main() {
  await testPanelNewIsolatesFollowingMessage();
  testDuplicateKeyDoesNotSwallowDifferentCards();
  console.log("new-thread isolation fixtures ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
