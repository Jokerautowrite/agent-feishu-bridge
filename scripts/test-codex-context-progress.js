#!/usr/bin/env node

const assert = require("node:assert/strict");
const { handleCodexMessage } = require("../src/app/codex-event-service");
const { buildAssistantReplyFooterElements } = require("../src/presentation/card/builders");
const { upsertAssistantReplyCard, flushAssistantReplyCardNow, buildCardKitFinalCard } = require("../src/presentation/card/card-service");

async function main() {
  const threadId = "thread-context-progress";
  const turnId = "turn-context-progress";
  const runKey = `${threadId}:${turnId}`;
  const refreshed = [];
  const runtime = {
    config: { logLevel: "quiet" },
    assistantDeltaSeenByRunKey: new Map(),
    activeTurnIdByThreadId: new Map([[threadId, turnId]]),
    activeTurnStartedAtByThreadId: new Map(),
    turnFailureTextByRunKey: new Map(),
    pendingApprovalByThreadId: new Map(),
    pendingChatContextByThreadId: new Map([[threadId, { chatId: "chat-context" }]]),
    currentRunKeyByThreadId: new Map([[threadId, runKey]]),
    latestTokenUsageByThreadId: new Map(),
    toolItemIdsByRunKey: new Map(),
    toolTraceByRunKey: new Map(),
    reasoningTraceByRunKey: new Map(),
    replyCardByRunKey: new Map([[runKey, { threadId, turnId, state: "streaming" }]]),
    pruneRuntimeMapSizes() {},
    async upsertAssistantReplyCard(payload) {
      refreshed.push(payload);
    },
    async deliverToFeishu() {},
  };
  const usage = {
    modelContextWindow: 200000,
    last: { totalTokens: 140000, inputTokens: 139000, outputTokens: 1000 },
  };

  handleCodexMessage(runtime, {
    method: "thread/tokenUsage/updated",
    params: { threadId, turnId, tokenUsage: usage },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshed.length, 1, "usage-only events must refresh the active card");
  assert.deepEqual(runtime.latestTokenUsageByThreadId.get(threadId), usage);

  handleCodexMessage(runtime, {
    method: "thread/tokenUsage/updated",
    params: { threadId, turnId, tokenUsage: usage },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshed.length, 1, "unchanged usage must not enqueue duplicate refreshes");

  const footer = buildAssistantReplyFooterElements({
    statusEmoji: "!", status: "failed", contextText: "上下文 140.0k/200.0k (70%)",
  });
  assert.ok(!footer.some((element) => element.tag === "progress"), "Feishu rejects progress tags");
  assert.match(JSON.stringify(footer), /70%/);
  assert.match(JSON.stringify(footer), /140\.0k\/200\.0k/);

  const createdCards = [];
  const updatedCards = [];
  Object.assign(runtime, {
    config: { ...runtime.config, feishuCardKitStreaming: true },
    replyCardByRunKey: new Map(),
    latestTokenUsageByThreadId: new Map(),
    replyFlushTimersByRunKey: new Map(),
    replyFlushInFlightByRunKey: new Map(),
    replyFlushQueuedByRunKey: new Set(),
    setReplyCardEntry(key, entry) { this.replyCardByRunKey.set(key, entry); },
    setCurrentRunKeyForThread(id, key) { this.currentRunKeyByThreadId.set(id, key); },
    async clearPendingReactionForThread() {},
    requireFeishuAdapter: () => ({
      async createCardEntity({ card }) { createdCards.push(card); return "card-context"; },
      async sendCardByCardId() { return { data: { message_id: "message-context" } }; },
      async updateCardKitCard({ card }) { updatedCards.push(card); },
      async streamCardContent() { assert.fail("usage-only changes must update the card footer"); },
    }),
  });
  runtime.upsertAssistantReplyCard = (payload) => upsertAssistantReplyCard(runtime, payload);
  await runtime.upsertAssistantReplyCard({ threadId, turnId, chatId: "chat-context", state: "streaming", deferFlush: true });
  await flushAssistantReplyCardNow(runtime, { threadId, turnId });
  assert.equal(createdCards.length, 1);
  handleCodexMessage(runtime, { method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: usage } });
  await flushAssistantReplyCardNow(runtime, { threadId, turnId });
  assert.equal(updatedCards.length, 1, "usage change must update the existing CardKit card");
  assert.match(JSON.stringify(updatedCards[0]), /140\.0k\/200\.0k/);
  assert.match(JSON.stringify(updatedCards[0]), /\(70%\)/);
  const entry = runtime.replyCardByRunKey.get(runKey);
  const failedCard = buildCardKitFinalCard(runtime, { ...entry, state: "failed" });
  assert.match(JSON.stringify(failedCard), /140\.0k\/200\.0k/);
  console.log("Codex context progress fixtures ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
