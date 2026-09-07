#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FeishuBotRuntime } = require("../src/app/feishu-bot-runtime");
const { SessionStore } = require("../src/infra/storage/session-store");
const { onFeishuTextEvent } = require("../src/app/dispatcher");
const { normalizeCardActionContext } = require("../src/presentation/message/normalizers");
const { buildThreadPickerCard } = require("../src/presentation/card/builders");
const { handleCodexMessage } = require("../src/app/codex-event-service");

global.fetch = async () => { throw new Error("network disabled in window fixtures"); };
const workspaceRoot = "/fixture/project";
const bindingKey = "fixture:chat:chat";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function context(messageId = "command", threadKey = "") {
  return { workspaceId: "fixture", chatId: "chat", senderId: "sender", messageId, threadKey };
}
function textEvent(messageId, text, threadKey = "") {
  return {
    message: {
      message_type: "text", message_id: messageId, chat_id: "chat", root_id: threadKey,
      content: JSON.stringify({ text }),
    },
    sender: { sender_id: { open_id: "sender" } },
  };
}
function createRuntime() {
  const runtime = Object.create(FeishuBotRuntime.prototype);
  runtime.config = { defaultWorkspaceId: "fixture", activeTurnFollowUpMode: "reject" };
  const store = Object.create(SessionStore.prototype);
  store.state = { bindings: {} };
  store.save = () => {};
  store.setActiveWorkspaceRoot(bindingKey, workspaceRoot);
  runtime.sessionStore = store;
  runtime.resumedThreadIds = new Set();
  for (const name of [
    "threadCreationByBindingWorkspace", "activeTurnIdByThreadId", "pendingApprovalByThreadId",
    "pendingChatContextByThreadId", "pendingChatContextByBindingKey", "bindingKeyByThreadId",
    "workspaceRootByThreadId", "currentRunKeyByThreadId",
  ]) runtime[name] = new Map();
  runtime.cards = [];
  runtime.infos = [];
  runtime.starts = [];
  runtime.sent = [];
  runtime.resumes = [];
  runtime.backendThreads = new Map();
  runtime.codex = {
    startThread: async (params) => {
      const id = `thread-${runtime.starts.length + 1}`;
      runtime.starts.push(params);
      runtime.backendThreads.set(id, { id, cwd: params.cwd, name: id, messages: [] });
      return { result: { thread: { id } } };
    },
    resumeThread: async ({ threadId }) => {
      runtime.resumes.push(threadId);
      assert.ok(runtime.backendThreads.has(threadId), "resume must target an existing backend session");
      return { result: { thread: runtime.backendThreads.get(threadId) } };
    },
    listThreads: async () => ({ result: { data: [...runtime.backendThreads.values()].reverse() } }),
    sendUserMessage: async (params) => {
      runtime.sent.push(params);
      runtime.backendThreads.get(params.threadId).messages.push(params.text);
    },
  };
  runtime.resolveWorkspaceContext = async (normalized) => runtime.getBindingContext(normalized);
  runtime.sendInfoCardMessage = async (card) => { runtime.infos.push(card); };
  runtime.sendInteractiveCard = async ({ card }) => { runtime.cards.push(card); };
  runtime.addPendingReaction = async () => {};
  runtime.clearPendingReactionForBinding = async () => {};
  runtime.movePendingReactionToThread = () => {};
  runtime.setChatType = () => {};
  return runtime;
}
function actions(card) {
  const result = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.value?.kind) result.push(node.value);
    Object.values(node).forEach(visit);
  };
  visit(card);
  return result;
}
function selected(runtime, key = bindingKey) {
  return runtime.sessionStore.getThreadIdForWorkspace(key, workspaceRoot);
}

async function testIndependentWindowsAndResume() {
  const runtime = createRuntime();
  await runtime.handleNewCommand(context());
  await onFeishuTextEvent(runtime, textEvent("message-1", "first window"));
  await runtime.handleNewCommand(context());
  await onFeishuTextEvent(runtime, textEvent("message-2", "second window"));
  await runtime.handleNewCommand(context());
  assert.deepEqual(runtime.starts, [{ cwd: workspaceRoot }, { cwd: workspaceRoot }, { cwd: workspaceRoot }]);
  assert.deepEqual(runtime.sent.map((item) => item.threadId), ["thread-1", "thread-2"]);
  assert.deepEqual(runtime.backendThreads.get("thread-3").messages, [], "New must not copy old messages");
  const panel = runtime.cards.at(-1);
  assert.deepEqual(actions(panel).filter((item) => item.kind === "thread").map((item) => item.threadId), ["thread-3", "thread-2", "thread-1"]);

  runtime.resumedThreadIds.clear();
  await runtime.switchThreadById(context(), "thread-1");
  await onFeishuTextEvent(runtime, textEvent("message-3", "continue first window"));
  assert.equal(selected(runtime), "thread-1");
  assert.deepEqual(runtime.resumes, ["thread-1"]);
  assert.equal(runtime.backendThreads.get("thread-1").messages.length, 2);
  assert.equal(runtime.backendThreads.get("thread-2").messages.length, 1);
  await runtime.handleNewCommand(context());
  assert.equal(runtime.backendThreads.size, 4, "the fourth New must not delete older sessions");
  assert.deepEqual(runtime.sessionStore.getRecentThreadIdsForWorkspace(bindingKey, workspaceRoot), ["thread-4", "thread-1", "thread-3"]);
  assert.ok(actions(runtime.cards.at(-1)).some((item) => item.action === "open_threads"));
  await runtime.switchThreadById(context(), "thread-2");
  assert.equal(selected(runtime), "thread-2", "older history remains selectable");
}

async function testFreshBindingDoesNotScanHistory() {
  const runtime = createRuntime();
  let reads = 0;
  runtime.codex.listThreads = async () => {
    reads += 1;
    return { result: { data: [{ id: "unrelated-history", cwd: workspaceRoot }] } };
  };
  await runtime.showStatusPanel(context());
  await onFeishuTextEvent(runtime, textEvent("first-message", "fresh conversation"));
  assert.equal(reads, 0, "fresh binding does not scan or adopt unrelated backend history");
  assert.equal(selected(runtime), "thread-1");
}

async function testNewRaces() {
  for (const existing of [false, true]) {
    const runtime = createRuntime();
    if (existing) await runtime.handleNewCommand(context());
    const gate = deferred();
    const start = runtime.codex.startThread;
    let starts = 0;
    runtime.codex.startThread = async (params) => { starts += 1; await gate.promise; return start(params); };
    const creating = runtime.handleNewCommand(context());
    const sending = onFeishuTextEvent(runtime, textEvent("immediate", "new window only"));
    await tick();
    assert.equal(starts, 1);
    assert.equal(runtime.sent.length, 0, "message waits for New instead of using an old or duplicate session");
    gate.resolve();
    await Promise.all([creating, sending]);
    assert.equal(runtime.sent[0].threadId, selected(runtime));
    assert.equal(starts, 1);
    assert.equal(runtime.workspaceThreadOperations.size, 0);
  }
  const runtime = createRuntime();
  const gates = [deferred(), deferred()];
  let starts = 0;
  const start = runtime.codex.startThread;
  runtime.codex.startThread = async (params) => { const index = starts++; await gates[index].promise; return start(params); };
  const first = runtime.handleNewCommand(context("new-1"));
  const second = runtime.handleNewCommand(context("new-2"));
  await tick();
  assert.equal(starts, 1, "second New is queued, not raced");
  gates[1].resolve();
  gates[0].resolve();
  await Promise.all([first, second]);
  assert.equal(selected(runtime), "thread-2");
  assert.deepEqual(runtime.sessionStore.getRecentThreadIdsForWorkspace(bindingKey, workspaceRoot), ["thread-2", "thread-1"]);
}

async function testSlowReactionAndFailedNew() {
  const runtime = createRuntime();
  await runtime.handleNewCommand(context());
  const gate = deferred();
  runtime.addPendingReaction = () => gate.promise;
  const sending = onFeishuTextEvent(runtime, textEvent("before-new", "old window message"));
  await tick();
  const creating = runtime.handleNewCommand(context());
  await tick();
  assert.equal(runtime.starts.length, 1, "New waits until the earlier message has been dispatched");
  gate.resolve();
  await Promise.all([sending, creating]);
  assert.equal(runtime.sent[0].threadId, "thread-1");
  assert.equal(selected(runtime), "thread-2");
  const start = runtime.codex.startThread;
  runtime.codex.startThread = async () => { throw new Error("synthetic creation failure"); };
  await runtime.handleNewCommand(context());
  assert.equal(selected(runtime), "thread-2");
  runtime.codex.startThread = start;
  await runtime.handleNewCommand(context());
  assert.equal(selected(runtime), "thread-3", "failed operations do not poison the queue");
}

async function testHistoryOutageAndResumeFailure() {
  const runtime = createRuntime();
  await runtime.handleNewCommand(context());
  await runtime.handleNewCommand(context());
  runtime.codex.listThreads = async () => { throw new Error("synthetic history outage"); };
  await runtime.showStatusPanel(context());
  assert.equal(actions(runtime.cards.at(-1)).filter((item) => item.kind === "thread").length, 2);
  runtime.resumedThreadIds.clear();
  await runtime.switchThreadById(context(), "thread-1");
  assert.equal(selected(runtime), "thread-1", "saved windows can be resumed without thread/list");
  runtime.codex.resumeThread = async () => { throw new Error("synthetic resume failure"); };
  await assert.rejects(runtime.switchThreadById(context(), "thread-2"), /synthetic resume failure/);
  assert.equal(selected(runtime), "thread-1", "resume failure must not change the selected window");
}

async function testCardScopeAndFeedbackRace() {
  const runtime = createRuntime();
  await runtime.handleNewCommand(context());
  await runtime.handleNewCommand(context("topic-command", "topic-root"));
  const topicKey = "fixture:chat:thread:topic-root";
  const panel = runtime.cards.at(-1);
  assert.ok(actions(panel).every((item) => item.threadKey === "topic-root"));
  const picker = buildThreadPickerCard({ workspaceRoot, threads: [{ id: "thread-2" }], currentThreadId: "thread-2", threadKey: "topic-root" });
  assert.ok(actions(picker).every((item) => item.threadKey === "topic-root"));
  const normalized = normalizeCardActionContext({
    context: { open_message_id: "card-message", open_chat_id: "chat" },
    operator: { open_id: "sender" },
    action: { value: actions(panel).find((item) => item.action === "new_thread") },
  }, runtime.config);
  assert.equal(normalized.threadKey, "topic-root");

  const feedbackGate = deferred();
  const backendGate = deferred();
  runtime.requireFeishuAdapter = () => ({ sendInteractiveCard: () => feedbackGate.promise });
  runtime.sendInfoCardMessage = async () => feedbackGate.promise;
  const start = runtime.codex.startThread;
  let starting = false;
  runtime.codex.startThread = async (params) => { starting = true; await backendGate.promise; return start(params); };
  runtime.handlePanelCardAction({ kind: "panel", action: "new_thread" }, normalized);
  await tick();
  assert.equal(starting, true, "New is registered before slow feedback finishes");
  const sending = onFeishuTextEvent(runtime, textEvent("topic-reply", "topic new window", "topic-root"));
  await tick();
  assert.equal(runtime.sent.length, 0);
  backendGate.resolve();
  await sending;
  assert.equal(runtime.sent[0].threadId, "thread-3");
  assert.equal(selected(runtime, topicKey), "thread-3");
  assert.equal(selected(runtime), "thread-1", "topic card does not change the chat window");
  feedbackGate.resolve();
  await tick();
}

async function testSwitchOrderingAndActiveWindows() {
  const runtime = createRuntime();
  await runtime.handleNewCommand(context());
  const oldContext = context("old-running-message");
  runtime.setPendingThreadContext("thread-1", oldContext);
  runtime.activeTurnIdByThreadId.set("thread-1", "turn-old");
  await runtime.handleNewCommand(context("new-command"));
  assert.equal(runtime.activeTurnIdByThreadId.get("thread-1"), "turn-old");
  assert.equal(runtime.pendingChatContextByThreadId.get("thread-1"), oldContext);
  await onFeishuTextEvent(runtime, textEvent("new-message", "new window while old is busy"));
  assert.equal(runtime.sent[0].threadId, "thread-2");
  await runtime.switchThreadById(context(), "thread-1");
  assert.equal(runtime.pendingChatContextByThreadId.get("thread-1"), oldContext, "switch does not steal active reply routing");
  runtime.activeTurnIdByThreadId.clear();
  const gate = deferred();
  const start = runtime.codex.startThread;
  runtime.codex.startThread = async (params) => { await gate.promise; return start(params); };
  const creating = runtime.handleNewCommand(context());
  const switching = runtime.switchThreadById(context(), "thread-1");
  gate.resolve();
  await Promise.all([creating, switching]);
  assert.equal(selected(runtime), "thread-1", "switch to the formerly current window is evaluated after queued New");
}

async function testLateReplyDoesNotCleanNextTurn() {
  const runtime = createRuntime();
  for (const name of [
    "assistantDeltaSeenByRunKey", "turnFailureTextByRunKey", "activeTurnStartedAtByThreadId",
    "latestTokenUsageByThreadId", "toolItemIdsByRunKey", "toolTraceByRunKey",
    "reasoningTraceByRunKey", "replyCardByRunKey",
  ]) runtime[name] = new Map();
  runtime.pruneRuntimeMapSizes = () => {};
  runtime.clearPendingReactionForThread = async () => {};
  const delivered = [];
  const gate = deferred();
  runtime.deliverToFeishu = async (event) => { delivered.push(event); await gate.promise; };
  const threadId = "returning-window";
  runtime.activeTurnIdByThreadId.set(threadId, "old-turn");
  runtime.setPendingThreadContext(threadId, context("old-message", "old-topic"));
  handleCodexMessage(runtime, { method: "turn/completed", params: { threadId, turn: { id: "old-turn", status: "completed" } } });
  assert.equal(delivered[0].payload.threadKey, "old-topic");
  const nextContext = context("next-message", "next-topic");
  runtime.setPendingThreadContext(threadId, nextContext);
  handleCodexMessage(runtime, { method: "turn/started", params: { threadId, turn: { id: "next-turn" } } });
  gate.resolve();
  await tick();
  assert.equal(runtime.activeTurnIdByThreadId.get(threadId), "next-turn", "old terminal delivery must not clear the next turn");
  assert.equal(runtime.pendingChatContextByThreadId.get(threadId), nextContext);
  handleCodexMessage(runtime, { method: "turn/completed", params: { threadId, turn: { id: "next-turn", status: "completed" } } });
  await tick();
  assert.equal(runtime.activeTurnIdByThreadId.has(threadId), false);
  assert.equal(runtime.pendingChatContextByThreadId.has(threadId), false, "normal terminal cleanup still runs");
}

async function testStaleTerminalEventsDoNotMutateCurrentTurn() {
  const methods = ["turn/completed", "turn/failed", "turn/cancelled", "error"];
  for (const method of methods) {
    for (const nestedTurnId of [false, true]) {
      for (const active of [false, true]) {
        const runtime = createRuntime();
        const threadId = "reused-window";
        const turnId = "current-turn";
        const runKey = `${threadId}:${turnId}`;
        const nextContext = context("next-message", "next-topic");
        const approval = { requestId: "current-approval", threadId, turnId };
        const entry = { threadId, turnId, state: "streaming", text: "current answer" };
        for (const name of [
          "assistantDeltaSeenByRunKey", "turnFailureTextByRunKey", "activeTurnStartedAtByThreadId",
          "activeTurnLastActivityAtByThreadId", "latestTokenUsageByThreadId", "toolItemIdsByRunKey",
          "toolTraceByRunKey", "reasoningTraceByRunKey", "replyCardByRunKey",
        ]) runtime[name] = new Map();
        const effects = [];
        runtime.pruneRuntimeMapSizes = () => {};
        runtime.clearPendingReactionForThread = async () => { effects.push("clear reaction"); };
        runtime.deliverToFeishu = async () => { effects.push("deliver"); };
        runtime.disposeReplyRunState = () => { effects.push("dispose answer"); };
        if (active) runtime.activeTurnIdByThreadId.set(threadId, turnId);
        runtime.currentRunKeyByThreadId.set(threadId, runKey);
        runtime.activeTurnStartedAtByThreadId.set(threadId, 123);
        runtime.activeTurnLastActivityAtByThreadId.set(threadId, 456);
        runtime.setPendingThreadContext(threadId, nextContext);
        runtime.pendingApprovalByThreadId.set(threadId, approval);
        runtime.replyCardByRunKey.set(runKey, entry);
        handleCodexMessage(runtime, {
          method,
          params: {
            threadId,
            ...(nestedTurnId ? { turn: { id: "old-turn", status: "completed" } } : { turnId: "old-turn" }),
            ...(method === "error" ? { error: { message: "stream disconnected" }, willRetry: false } : {}),
          },
        });
        await tick();
        const label = `${method}, nested=${nestedTurnId}, active=${active}`;
        assert.deepEqual(effects, [], label);
        assert.equal(runtime.activeTurnIdByThreadId.get(threadId), active ? turnId : undefined, label);
        assert.equal(runtime.currentRunKeyByThreadId.get(threadId), runKey, label);
        assert.equal(runtime.activeTurnStartedAtByThreadId.get(threadId), 123, label);
        assert.equal(runtime.activeTurnLastActivityAtByThreadId.get(threadId), 456, label);
        assert.equal(runtime.pendingChatContextByThreadId.get(threadId), nextContext, label);
        assert.equal(runtime.pendingApprovalByThreadId.get(threadId), approval, label);
        assert.equal(runtime.replyCardByRunKey.get(runKey), entry, label);
      }
    }
  }
}

function testPersistentWindowMigration() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-thread-windows-"));
  const filePath = path.join(dir, "sessions.json");
  fs.writeFileSync(filePath, JSON.stringify({ bindings: {
    [bindingKey]: { activeWorkspaceRoot: workspaceRoot, threadIdByWorkspaceRoot: { [workspaceRoot]: "legacy" } },
  } }));
  const store = new SessionStore({ filePath });
  store.rememberWorkspaceThreads(bindingKey, workspaceRoot, ["history-1", "history-2"]);
  store.setThreadIdForWorkspace(bindingKey, workspaceRoot, "new");
  const reloaded = new SessionStore({ filePath });
  assert.equal(reloaded.getThreadIdForWorkspace(bindingKey, workspaceRoot), "new");
  assert.deepEqual(reloaded.getRecentThreadIdsForWorkspace(bindingKey, workspaceRoot), ["new", "legacy", "history-1"]);
  reloaded.setThreadIdForWorkspace(bindingKey, workspaceRoot, "legacy");
  assert.deepEqual(reloaded.getRecentThreadIdsForWorkspace(bindingKey, workspaceRoot), ["legacy", "new", "history-1"]);
  assert.equal(reloaded.getRecentThreadIdsForWorkspace("other-binding", workspaceRoot).length, 0);
}

async function testCurrentTerminalEventsStillComplete() {
  for (const method of ["turn/completed", "turn/failed", "turn/cancelled", "error"]) {
    for (const identity of ["flat", "nested", "missing", "untracked", "pending"]) {
      const runtime = createRuntime();
      const threadId = "finishing-window";
      const turnId = "finishing-turn";
      for (const name of [
        "assistantDeltaSeenByRunKey", "turnFailureTextByRunKey", "activeTurnStartedAtByThreadId",
        "activeTurnLastActivityAtByThreadId", "latestTokenUsageByThreadId", "toolItemIdsByRunKey",
        "toolTraceByRunKey", "reasoningTraceByRunKey", "replyCardByRunKey",
      ]) runtime[name] = new Map();
      const delivered = [];
      runtime.pruneRuntimeMapSizes = () => {};
      runtime.clearPendingReactionForThread = async () => {};
      runtime.deliverToFeishu = async (event) => { delivered.push(event); };
      if (identity === "pending") {
        runtime.currentRunKeyByThreadId.set(threadId, `${threadId}:pending`);
      } else if (identity !== "untracked") {
        runtime.activeTurnIdByThreadId.set(threadId, turnId);
        runtime.currentRunKeyByThreadId.set(threadId, `${threadId}:${turnId}`);
      }
      const replyContext = context("finishing-message", "finishing-topic");
      runtime.setPendingThreadContext(threadId, replyContext);
      runtime.pendingApprovalByThreadId.set(threadId, { requestId: "approval" });
      handleCodexMessage(runtime, {
        method,
        params: {
          threadId,
          ...(identity === "nested" ? { turn: { id: turnId } } : identity === "missing" ? {} : { turnId }),
          ...(method === "error" ? { error: { message: "stream disconnected" }, willRetry: false } : {}),
        },
      });
      await tick();
      const label = `${method}, identity=${identity}`;
      assert.equal(delivered.length, 1, label);
      assert.equal(delivered[0].payload.threadKey, replyContext.threadKey, label);
      assert.equal(runtime.activeTurnIdByThreadId.has(threadId), false, label);
      assert.equal(runtime.pendingApprovalByThreadId.has(threadId), false, label);
      assert.equal(runtime.pendingChatContextByThreadId.has(threadId), false, label);
    }
  }
}

async function main() {
  testPersistentWindowMigration();
  await testFreshBindingDoesNotScanHistory();
  await testIndependentWindowsAndResume();
  await testNewRaces();
  await testSlowReactionAndFailedNew();
  await testHistoryOutageAndResumeFailure();
  await testCardScopeAndFeedbackRace();
  await testSwitchOrderingAndActiveWindows();
  await testLateReplyDoesNotCleanNextTurn();
  await testStaleTerminalEventsDoNotMutateCurrentTurn();
  await testCurrentTerminalEventsStillComplete();
  console.log("thread window fixtures ok (offline; synthetic persistence files retained)");
}
main().catch((error) => { console.error(error); process.exit(1); });
