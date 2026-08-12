#!/usr/bin/env node

const assert = require("node:assert/strict");
const {
  buildCardKitFooter,
  buildCardKitFinalCard,
  buildLegacyReplyCard,
  flushAssistantReplyCardNow,
  openCardKitCircuit,
  resolveReplyCardEffort,
  resolveReplyCardModel,
  shouldUseCardKitReply,
  upsertAssistantReplyCard,
} = require("../src/presentation/card/card-service");
const { deliverToFeishu, handleCodexMessage } = require("../src/app/codex-event-service");
const { classifyLocalAttachment, inferFeishuFileType } = require("../src/shared/media-types");

function createRuntime() {
  const runtime = {
    activeTurnIdByThreadId: new Map(),
    currentRunKeyByThreadId: new Map(),
    replyCardByRunKey: new Map(),
    pendingChatContextByThreadId: new Map(),
    replyFlushTimersByRunKey: new Map(),
    replyFlushInFlightByRunKey: new Map(),
    replyFlushQueuedByRunKey: new Set(),
    cardKitCircuitOpenUntil: 0,
    cardKitCircuitLastReason: "",
    latestTokenUsageByThreadId: new Map(),
    toolItemIdsByRunKey: new Map(),
    toolTraceByRunKey: new Map(),
    reasoningTraceByRunKey: new Map(),
    bindingKeyByThreadId: new Map(),
    workspaceRootByThreadId: new Map(),
    config: {
      feishuStreamingOutput: true,
      feishuCardKitStreaming: true,
      cardKitFailureCooldownMs: 300000,
      defaultCodexModel: "gpt-5.5",
      defaultCodexEffort: "medium",
    },
  };
  runtime.setReplyCardEntry = (runKey, entry) => {
    runtime.replyCardByRunKey.set(runKey, entry);
  };
  runtime.setCurrentRunKeyForThread = (threadId, runKey) => {
    runtime.currentRunKeyByThreadId.set(threadId, runKey);
  };
  runtime.upsertAssistantReplyCard = (payload) => upsertAssistantReplyCard(runtime, payload);
  runtime.resolveWorkspaceRootForThread = (threadId) => runtime.workspaceRootByThreadId.get(threadId) || "";
  runtime.getCodexParamsForWorkspace = () => ({ model: "", effort: "" });
  runtime.pruneRuntimeMapSizes = () => {};
  return runtime;
}

function collectCardText(value) {
  if (!value || typeof value !== "object") return "";
  const parts = [];
  if (typeof value.content === "string") parts.push(value.content);
  if (typeof value.text?.content === "string") parts.push(value.text.content);
  for (const key of ["elements", "columns"]) {
    for (const child of Array.isArray(value[key]) ? value[key] : []) {
      parts.push(collectCardText(child));
    }
  }
  return parts.filter(Boolean).join("\n");
}

async function testCompletedSnapshotPromotesPreviousTextToProcessPanel() {
  const runtime = createRuntime();
  const base = {
    threadId: "thread-1",
    turnId: "turn-1",
    chatId: "chat-1",
    state: "streaming",
    deferFlush: true,
  };

  const processText = "I am checking files before preparing the final answer.";
  const answerText = "结论是：\n\n- Body keeps the final answer\n- Process moves to the panel";

  await upsertAssistantReplyCard(runtime, {
    ...base,
    text: processText,
    mode: "delta",
  });
  await upsertAssistantReplyCard(runtime, {
    ...base,
    text: answerText,
    mode: "delta",
  });
  await upsertAssistantReplyCard(runtime, {
    ...base,
    text: answerText,
    mode: "completed_snapshot",
  });

  const entry = runtime.replyCardByRunKey.get("thread-1:turn-1");
  assert.ok(entry, "reply entry should exist");
  assert.strictEqual(entry.answerText, answerText);
  assert.match(entry.processText, /checking files/);
  assert.doesNotMatch(entry.answerText, /checking files/);
}

async function testReplyCardsUseCapturedRequestModel() {
  const runtime = createRuntime();
  runtime.bindingKeyByThreadId.set("thread-model", "binding-model");
  runtime.workspaceRootByThreadId.set("thread-model", "/workspace/model");
  runtime.getCodexParamsForWorkspace = () => ({ model: "gpt-5.6-sol", effort: "xhigh" });

  await upsertAssistantReplyCard(runtime, {
    threadId: "thread-model",
    turnId: "turn-model",
    chatId: "chat-model",
    text: "模型显示测试",
    state: "streaming",
    deferFlush: true,
  });

  const entry = runtime.replyCardByRunKey.get("thread-model:turn-model");
  assert.ok(entry, "reply entry should exist");
  assert.strictEqual(entry.model, "gpt-5.6-sol");
  assert.strictEqual(entry.effort, "xhigh");

  runtime.getCodexParamsForWorkspace = () => ({ model: "gpt-5.6-terra", effort: "high" });
  assert.strictEqual(
    resolveReplyCardModel(runtime, entry),
    "gpt-5.6-sol",
    "reply card should keep the model used when this turn started"
  );
  assert.strictEqual(
    resolveReplyCardEffort(runtime, entry),
    "xhigh",
    "reply card should keep the effort used when this turn started"
  );

  const cardKitFooter = buildCardKitFooter(runtime, entry);
  const footerText = cardKitFooter.map((el) => el.content || "").join("\n");
  assert.match(footerText, /gpt-5\.6-sol/);
  assert.match(footerText, /强度 xhigh/);
  assert.doesNotMatch(footerText, /gpt-5\.5/);
  assert.doesNotMatch(footerText, /强度 high/);

  const legacyCard = buildLegacyReplyCard(runtime, "thread-model:turn-model", entry);
  const legacyFooter = legacyCard.body.elements
    .map((element) => element?.content || element?.text?.content || "")
    .join("\n");
  assert.ok(legacyFooter.includes("gpt-5\\.6-sol"));
  assert.ok(legacyFooter.includes("强度 xhigh"));
  assert.ok(!legacyFooter.includes("gpt-5\\.5"));
}

async function testTerminalStateClosesCurrentStreamingCardAfterTurnIdMismatch() {
  const runtime = createRuntime();
  const sentCards = [];
  runtime.config.feishuCardKitStreaming = false;
  runtime.requireFeishuAdapter = () => ({
    async sendInteractiveCard({ card }) {
      sentCards.push(card);
      return { data: { message_id: "message-terminal" } };
    },
    async patchInteractiveCard({ card }) {
      sentCards.push(card);
      return {};
    },
  });
  runtime.clearPendingReactionForThread = async () => {};
  runtime.disposeReplyRunState = () => {};
  await upsertAssistantReplyCard(runtime, {
    threadId: "thread-terminal",
    turnId: "turn-streaming",
    chatId: "chat-terminal",
    text: "等待完成状态",
    state: "streaming",
    deferFlush: true,
  });
  await upsertAssistantReplyCard(runtime, {
    threadId: "thread-terminal",
    turnId: "turn-completed",
    chatId: "chat-terminal",
    state: "completed",
    deferFlush: true,
  });

  assert.strictEqual(sentCards.length, 1);
  const completedFooter = (sentCards.at(-1)?.body?.elements || [])
    .map((element) => element?.content || element?.text?.content || "")
    .join("\n");
  assert.ok(completedFooter.includes("已完成"));
  assert.strictEqual(runtime.replyCardByRunKey.has("thread-terminal:turn-completed"), false);
}

async function testStreamingRunStateCreatesCardKitCardBeforeAssistantText() {
  const runtime = createRuntime();
  const cards = [];
  runtime.requireFeishuAdapter = () => ({
    async createCardEntity({ card }) {
      cards.push(card);
      return "card-early";
    },
    async sendCardByCardId() {
      return { data: { message_id: "message-early" } };
    },
    async updateCardKitCard() {},
    async streamCardContent() {},
  });
  runtime.clearPendingReactionForThread = async () => {};
  runtime.disposeReplyRunState = () => {};

  await deliverToFeishu(runtime, {
    type: "im.run_state",
    payload: {
      threadId: "thread-early",
      turnId: "turn-early",
      chatId: "chat-early",
      state: "streaming",
    },
  });
  await flushAssistantReplyCardNow(runtime, {
    threadId: "thread-early",
    turnId: "turn-early",
  });

  assert.equal(cards.length, 1);
  assert.match(collectCardText(cards[0].body), /已收到，正在分析和执行/);
  assert.equal(cards[0].body.elements[1].expanded, true);
}

async function testPublicReasoningSummaryAppearsInCardKitPanel() {
  const runtime = createRuntime();
  const cards = [];
  runtime.requireFeishuAdapter = () => ({
    async createCardEntity({ card }) {
      cards.push(card);
      return "card-reasoning";
    },
    async sendCardByCardId() {
      return { data: { message_id: "message-reasoning" } };
    },
    async updateCardKitCard() {},
    async streamCardContent() {},
  });
  runtime.clearPendingReactionForThread = async () => {};
  runtime.disposeReplyRunState = () => {};

  handleCodexMessage(runtime, {
    method: "item/completed",
    params: {
      threadId: "thread-reasoning",
      turnId: "turn-reasoning",
      item: {
        id: "reasoning-1",
        type: "reasoning",
        text: "先核对当前运行状态，再根据证据决定是否需要重启。",
      },
    },
  });

  const trace = runtime.reasoningTraceByRunKey.get("thread-reasoning:turn-reasoning");
  assert.deepEqual(trace, [{
    itemId: "reasoning-1",
    summary: "先核对当前运行状态，再根据证据决定是否需要重启。",
  }]);
  runtime.toolItemIdsByRunKey.set("thread-reasoning:turn-reasoning", new Set(["command-1"]));
  runtime.toolTraceByRunKey.set("thread-reasoning:turn-reasoning", [
    "完成：命令执行：systemctl --user show codex-feishu-bot.service",
  ]);

  await upsertAssistantReplyCard(runtime, {
    threadId: "thread-reasoning",
    turnId: "turn-reasoning",
    chatId: "chat-reasoning",
    text: "已收到，正在分析和执行。",
    state: "streaming",
    deferFlush: true,
  });
  await flushAssistantReplyCardNow(runtime, {
    threadId: "thread-reasoning",
    turnId: "turn-reasoning",
  });

  assert.equal(cards.length, 1);
  const toolPanel = cards[0].body.elements[0].elements[0].content;
  const thinkingPanel = cards[0].body.elements[1].elements[0].content;
  assert.match(toolPanel, /命令执行/);
  assert.match(thinkingPanel, /模型公开推理摘要/);
  assert.match(thinkingPanel, /先核对当前运行状态/);
  assert.doesNotMatch(thinkingPanel, /实际执行记录/);
  assert.doesNotMatch(thinkingPanel, /命令执行/);
}

function testAttachmentClassification() {
  assert.strictEqual(classifyLocalAttachment("chart.png"), "image");
  assert.strictEqual(classifyLocalAttachment("voice.opus"), "audio");
  assert.strictEqual(classifyLocalAttachment("report.pdf"), "file");
  assert.strictEqual(inferFeishuFileType("report.pdf"), "pdf");
  assert.strictEqual(inferFeishuFileType("deck.pptx"), "ppt");
}

function testCardKitCircuitBreakerRecoversAfterCooldown() {
  const runtime = createRuntime();
  const entry = { fallbackUsed: false };
  assert.strictEqual(shouldUseCardKitReply(runtime, entry, 1000), true);

  const openUntil = openCardKitCircuit(runtime, new Error("cardid is invalid"), 1000);
  assert.strictEqual(openUntil, 301000);
  assert.strictEqual(runtime.cardKitCircuitLastReason, "cardid is invalid");
  assert.strictEqual(shouldUseCardKitReply(runtime, entry, 300999), false);
  assert.strictEqual(shouldUseCardKitReply(runtime, entry, 301000), true);
}

async function testContextFooterWarnings() {
  const runtime = createRuntime();
  const threadId = "thread-context";
  await upsertAssistantReplyCard(runtime, {
    threadId,
    turnId: "turn-context",
    chatId: "chat-context",
    text: "上下文提醒测试",
    state: "streaming",
    deferFlush: true,
  });
  const entry = runtime.replyCardByRunKey.get(`${threadId}:turn-context`);
  assert.ok(entry, "reply entry should exist");

  runtime.latestTokenUsageByThreadId.set(threadId, {
    modelContextWindow: 200000,
    last: {
      inputTokens: 140000,
      outputTokens: 1,
      totalTokens: 140000,
    },
  });
  const footerText1 = buildCardKitFooter(runtime, entry).map((el) => el.content || "").join("\n");
  assert.match(footerText1, /cus-progress-yellow/);
  assert.match(footerText1, /\(70%\)/);

  runtime.latestTokenUsageByThreadId.set(threadId, {
    modelContextWindow: 200000,
    last: {
      inputTokens: 180000,
      outputTokens: 1,
      totalTokens: 180000,
    },
  });
  const footerText2 = buildCardKitFooter(runtime, entry).map((el) => el.content || "").join("\n");
  assert.match(footerText2, /cus-progress-red/);
  assert.match(footerText2, /\(90%\)/);
}

function testLongCompletedOutputUsesConfiguredFallbackPercent() {
  const runtime = createRuntime();
  runtime.config.outputVisibleTailPercent = 10;
  const paragraphs = Array.from({ length: 20 }, (_, index) => (
    `第 ${index + 1} 段：这是用于验证输出折叠效果的正文内容，默认收起前面的大部分分析，只保留结尾重点。`
  ));
  const answerText = paragraphs.join("\n\n");
  const entry = {
    threadId: "thread-output-collapse",
    turnId: "turn-output-collapse",
    chatId: "chat-output-collapse",
    state: "completed",
    answerText,
    startedAt: Date.now() - 1000,
  };
  const card = buildCardKitFinalCard(runtime, entry);
  const outputPanel = card.body.elements[2];
  const visibleTail = card.body.elements[3];
  assert.strictEqual(outputPanel.tag, "collapsible_panel");
  assert.strictEqual(outputPanel.expanded, false);
  assert.match(outputPanel.header.title.content, /输出结果/);
  assert.strictEqual(outputPanel.elements[0].background_style, "cus-body-bg");
  const collapsedText = outputPanel.elements[0].columns[0].elements[0].content;
  assert.match(collapsedText, /第 1 段/);
  assert.doesNotMatch(collapsedText, /第 20 段/);
  assert.match(visibleTail.columns[0].elements[0].content, /第 20 段/);
}

function testLongCompletedOutputShowsSemanticConclusion() {
  const runtime = createRuntime();
  const answerText = [
    ...Array.from({ length: 20 }, (_, index) => `分析 ${index + 1}：这里是较长的调查和验证内容，用于占据正文的大部分篇幅，并验证当前实现是否符合预期。`),
    "最终结论：只显示这一段和后面的操作建议，不再机械地固定显示最后 20%。",
    "下一步：确认样式后启用到正式飞书桥。",
  ].join("\n\n");
  const card = buildCardKitFinalCard(runtime, {
    threadId: "thread-smart-conclusion",
    turnId: "turn-smart-conclusion",
    chatId: "chat-smart-conclusion",
    state: "completed",
    answerText,
  });
  const visibleTail = card.body.elements[3].columns[0].elements[0].content;
  assert.match(visibleTail, /^最终结论/);
  assert.match(visibleTail, /下一步/);
  assert.doesNotMatch(visibleTail, /分析 12/);
}

(async () => {
  await testCompletedSnapshotPromotesPreviousTextToProcessPanel();
  await testReplyCardsUseCapturedRequestModel();
  await testTerminalStateClosesCurrentStreamingCardAfterTurnIdMismatch();
  await testStreamingRunStateCreatesCardKitCardBeforeAssistantText();
  await testPublicReasoningSummaryAppearsInCardKitPanel();
  testAttachmentClassification();
  testCardKitCircuitBreakerRecoversAfterCooldown();
  await testContextFooterWarnings();
  testLongCompletedOutputUsesConfiguredFallbackPercent();
  testLongCompletedOutputShowsSemanticConclusion();
  console.log("card reply content fixtures ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
