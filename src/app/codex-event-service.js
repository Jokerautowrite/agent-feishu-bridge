const codexMessageUtils = require("../infra/codex/message-utils");
const attachmentDirectives = require("../domain/attachments/outbound-directive-service");
const { formatFailureText } = require("../shared/error-text");

const MAX_TURN_FAILURE_CACHE_ENTRIES = 500;

async function handleStopCommand(runtime, normalized) {
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  const threadId = workspaceRoot ? runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot) : null;
  const turnId = threadId ? runtime.activeTurnIdByThreadId.get(threadId) || null : null;

  if (!threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前会话还没有可停止的运行任务。",
    });
    return;
  }

  try {
    await runtime.codex.sendRequest("turn/interrupt", {
      threadId,
      turnId,
    });
    runtime.cleanupThreadRuntimeState(threadId);
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "已发送停止请求，并已清理飞书端运行状态。可以继续发新消息。",
    });
  } catch (error) {
    runtime.cleanupThreadRuntimeState(threadId);
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `${formatFailureText("停止请求未确认", error)}\n\n我已先清理飞书端运行状态，你可以继续发消息；如果终端侧仍在跑，建议稍后再发一次 /stop。`,
    });
  }
}

function handleCodexMessage(runtime, message) {
  if (runtime.config.logLevel === "verbose" && typeof message?.method === "string") {
    console.log(`[codex-im] codex event ${message.method}`);
  }

  rememberTerminalError(runtime, message);
  const outbound = codexMessageUtils.mapCodexMessageToImEvent(message, {
    suppressCompletedAssistantText: codexMessageUtils.shouldSuppressCompletedAssistantText(
      runtime.assistantDeltaSeenByRunKey,
      message
    ),
    terminalFailureText: getRememberedTerminalError(runtime, message),
  });

  codexMessageUtils.trackAssistantDeltaReceipt(runtime.assistantDeltaSeenByRunKey, message);
  trackLatestTokenUsage(runtime, message);
  const toolUsageChanged = trackLatestToolUsage(runtime, message);
  const reasoningTraceChanged = trackLatestReasoningSummary(runtime, message);
  const progressStepText = extractProgressStepText(message);
  if (progressStepText) {
    refreshStreamingReplyCardForProgress(runtime, message, { stepText: progressStepText });
  } else if (message?.method === "turn/started") {
    // 预建流式卡：发完消息 0.1s 就有"正在处理"，避免黑盒等待。
    const startedThreadId = String(message?.params?.threadId || "").trim();
    const chatId = runtime.pendingChatContextByThreadId.get(startedThreadId)?.chatId || "";
    if (startedThreadId && chatId) {
      const startedTurnId = String(
        message?.params?.turn?.id
          || runtime.activeTurnIdByThreadId.get(startedThreadId)
          || ""
      ).trim();
      runtime.upsertAssistantReplyCard({
        threadId: startedThreadId,
        turnId: startedTurnId,
        chatId,
        text: "正在处理…",
        mode: "progress",
        state: "streaming",
      }).catch((error) => {
        console.error(`[codex-im] failed to create streaming card: ${error.message}`);
      });
    }
  }
  codexMessageUtils.trackRunKeyState(runtime.currentRunKeyByThreadId, runtime.activeTurnIdByThreadId, message);
  codexMessageUtils.trackRunningTurn(runtime.activeTurnIdByThreadId, message);
  trackRunningTurnStartedAt(runtime, message);
  codexMessageUtils.trackPendingApproval(runtime.pendingApprovalByThreadId, message);
  runtime.pruneRuntimeMapSizes();
  if (toolUsageChanged || reasoningTraceChanged) {
    refreshStreamingReplyCardForProgress(runtime, message);
  }
  if (!outbound) {
    return;
  }

  const threadId = outbound.payload?.threadId || "";
  if (!outbound.payload.turnId) {
    outbound.payload.turnId = runtime.activeTurnIdByThreadId.get(threadId) || "";
  }
  const context = runtime.pendingChatContextByThreadId.get(threadId);
  if (context) {
    outbound.payload.chatId = context.chatId;
    outbound.payload.threadKey = context.threadKey;
  }

  if (codexMessageUtils.eventShouldClearPendingReaction(outbound)) {
    runtime.clearPendingReactionForThread(threadId).catch((error) => {
      console.error(`[codex-im] failed to clear pending reaction: ${error.message}`);
    });
  }

  const shouldCleanupThreadState = isTerminalTurnMessage(message);
  runtime.deliverToFeishu(outbound)
    .catch((error) => {
      console.error(`[codex-im] failed to deliver Feishu message: ${error.message}`);
    })
    .finally(() => {
      if (!shouldCleanupThreadState || !threadId) {
        return;
      }
      forgetTerminalError(runtime, message);
      runtime.clearPendingReactionForThread(threadId).catch((error) => {
        console.error(`[codex-im] failed to clear pending reaction: ${error.message}`);
      });
      runtime.cleanupThreadRuntimeState(threadId);
    });
}

function rememberTerminalError(runtime, message) {
  if (message?.method !== "error" || message?.params?.willRetry) {
    return;
  }
  const params = message?.params || {};
  if (isRecoverableStreamDisconnect(params)) {
    return;
  }
  const errorText = codexMessageUtils.extractCodexErrorText(params)
    || "本轮任务发生异常，未返回详细原因。";
  const runKey = resolveTerminalErrorRunKey(runtime, message);
  if (!runKey || !(runtime.turnFailureTextByRunKey instanceof Map)) {
    return;
  }
  if (runtime.turnFailureTextByRunKey.has(runKey)) {
    runtime.turnFailureTextByRunKey.delete(runKey);
  }
  runtime.turnFailureTextByRunKey.set(runKey, `执行失败：${errorText}`);
  while (runtime.turnFailureTextByRunKey.size > MAX_TURN_FAILURE_CACHE_ENTRIES) {
    const oldestRunKey = runtime.turnFailureTextByRunKey.keys().next().value;
    if (!oldestRunKey) {
      break;
    }
    runtime.turnFailureTextByRunKey.delete(oldestRunKey);
  }
}

function getRememberedTerminalError(runtime, message) {
  const runKey = resolveTerminalErrorRunKey(runtime, message);
  if (!runKey || !(runtime.turnFailureTextByRunKey instanceof Map)) {
    return "";
  }
  return String(runtime.turnFailureTextByRunKey.get(runKey) || "");
}

function forgetTerminalError(runtime, message) {
  const runKey = resolveTerminalErrorRunKey(runtime, message);
  if (runKey && runtime.turnFailureTextByRunKey instanceof Map) {
    runtime.turnFailureTextByRunKey.delete(runKey);
  }
}

function resolveTerminalErrorRunKey(runtime, message) {
  const params = message?.params || {};
  const threadId = String(params?.threadId || params?.thread?.id || "").trim();
  if (!threadId) {
    return "";
  }
  const turnId = String(
    params?.turnId
      || params?.turn?.id
      || runtime.activeTurnIdByThreadId.get(threadId)
      || ""
  ).trim();
  return turnId ? codexMessageUtils.buildRunKey(threadId, turnId) : "";
}

function trackLatestTokenUsage(runtime, message) {
  if (message?.method !== "thread/tokenUsage/updated") {
    return;
  }
  const params = message?.params || {};
  const threadId = params?.threadId || "";
  const usage = params?.tokenUsage || {};
  if (!threadId || !usage || typeof usage !== "object") {
    return;
  }
  runtime.latestTokenUsageByThreadId.set(threadId, usage);
}

function trackRunningTurnStartedAt(runtime, message) {
  const method = message?.method;
  const params = message?.params || {};
  const threadId = params?.threadId || "";
  if (!threadId) {
    return;
  }
  if (method === "turn/started" || method === "turn/start") {
    runtime.activeTurnStartedAtByThreadId.set(threadId, Date.now());
    return;
  }
  if (method === "turn/completed" || method === "turn/failed" || method === "turn/cancelled") {
    runtime.activeTurnStartedAtByThreadId.delete(threadId);
  }
}

function trackLatestToolUsage(runtime, message) {
  const method = String(message?.method || "");
  const params = message?.params || {};
  if (method === "item/started" || method === "item/completed") {
    const item = params?.item || {};
    const itemType = String(item?.type || "");
    if (!isToolLikeItemType(itemType)) {
      return;
    }
    const threadId = String(params?.threadId || "");
    const turnId = String(params?.turnId || "");
    const itemId = String(item?.id || "");
    if (!threadId || !turnId || !itemId) {
      return false;
    }
    const prefix = method === "item/started" ? "开始" : "完成";
    return recordToolTrace(runtime, {
      threadId,
      turnId,
      itemId,
      summary: summarizeToolItem(itemType, item, prefix),
    });
  }

  if (isApprovalRequestEventMethod(method)) {
    const threadId = String(params?.threadId || "");
    const turnId = String(params?.turnId || "");
    const itemId = String(params?.itemId || message?.id || "");
    if (!threadId || !turnId || !itemId) {
      return false;
    }
    return recordToolTrace(runtime, {
      threadId,
      turnId,
      itemId,
      summary: summarizeApprovalRequest(params),
    });
  }
  return false;
}

function trackLatestReasoningSummary(runtime, message) {
  const method = String(message?.method || "");
  const params = message?.params || {};
  const item = params?.item || {};
  const itemType = String(item?.type || "").trim().toLowerCase();
  const isReasoningDelta = method === "item/reasoning/delta"
    || method === "item/reasoningSummary/delta"
    || method === "item/reasoning/summaryPartAdded"
    || method === "item/reasoningSummary/summaryPartAdded";

  if (!isReasoningDelta && itemType !== "reasoning") {
    return false;
  }

  const threadId = String(params?.threadId || "").trim();
  const turnId = String(
    params?.turnId
      || params?.turn?.id
      || runtime.activeTurnIdByThreadId.get(threadId)
      || ""
  ).trim();
  const itemId = String(item?.id || params?.itemId || "reasoning").trim();
  const summary = normalizeReasoningSummaryText(
    params?.delta || params?.summary || item?.summary || item?.text
  );
  if (!threadId || !turnId || !itemId || !summary) {
    return false;
  }

  return recordReasoningTrace(runtime, {
    threadId,
    turnId,
    itemId,
    summary,
  });
}

function recordToolTrace(runtime, { threadId, turnId, itemId, summary }) {
  const normalizedThreadId = String(threadId || "");
  const normalizedTurnId = String(turnId || "");
  const normalizedItemId = String(itemId || "");
  if (!normalizedThreadId || !normalizedTurnId || !normalizedItemId) {
    return false;
  }
  const runKey = `${normalizedThreadId}:${normalizedTurnId}`;
  const current = runtime.toolItemIdsByRunKey.get(runKey) || new Set();
  const isNewTool = !current.has(normalizedItemId);
  current.add(normalizedItemId);
  runtime.toolItemIdsByRunKey.set(runKey, current);

  const toolTrace = runtime.toolTraceByRunKey.get(runKey) || [];
  let traceChanged = false;
  if (summary && !toolTrace.includes(summary)) {
    toolTrace.push(summary);
    runtime.toolTraceByRunKey.set(runKey, toolTrace.slice(-8));
    traceChanged = true;
  }
  return isNewTool || traceChanged;
}

function recordReasoningTrace(runtime, { threadId, turnId, itemId, summary }) {
  if (!(runtime.reasoningTraceByRunKey instanceof Map)) {
    runtime.reasoningTraceByRunKey = new Map();
  }
  const runKey = `${String(threadId || "")}:${String(turnId || "")}`;
  const normalizedItemId = String(itemId || "").trim();
  const normalizedSummary = normalizeReasoningSummaryText(summary);
  if (!runKey || !normalizedItemId || !normalizedSummary) {
    return false;
  }

  const trace = runtime.reasoningTraceByRunKey.get(runKey) || [];
  const index = trace.findIndex((entry) => entry?.itemId === normalizedItemId);
  const previous = index >= 0 ? String(trace[index]?.summary || "") : "";
  const merged = mergeReasoningSummary(previous, normalizedSummary);
  if (merged === previous) {
    return false;
  }

  const next = index >= 0
    ? trace.map((entry, entryIndex) => (entryIndex === index
      ? { itemId: normalizedItemId, summary: merged }
      : entry))
    : [...trace, { itemId: normalizedItemId, summary: merged }];
  runtime.reasoningTraceByRunKey.set(runKey, next.slice(-4));
  return true;
}

function mergeReasoningSummary(current, incoming) {
  const existing = String(current || "").trim();
  const next = String(incoming || "").trim();
  if (!existing) {
    return next;
  }
  if (!next || existing === next || existing.includes(next)) {
    return existing;
  }
  if (next.includes(existing)) {
    return next;
  }
  return normalizeReasoningSummaryText(`${existing}\n${next}`);
}

function normalizeReasoningSummaryText(value) {
  const clean = String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!clean) {
    return "";
  }
  const maxLength = 2400;
  if (clean.length <= maxLength) {
    return clean;
  }
  return `${clean.slice(0, maxLength - 1).trimEnd()}…`;
}

function refreshStreamingReplyCardForProgress(runtime, message, options = {}) {
  const params = message?.params || {};
  const threadId = String(params?.threadId || "").trim();
  if (options.stepText) {
    const progressKey = codexMessageUtils.buildRunKey(
      threadId,
      String(params?.turnId || params?.turn?.id || "").trim() || runtime.activeTurnIdByThreadId.get(threadId) || ""
    );
    if (progressKey) {
      runtime.progressRunKeyByThreadId.set(threadId, progressKey);
    }
  }
  const turnId = String(
    params?.turnId
      || params?.turn?.id
      || runtime.activeTurnIdByThreadId.get(threadId)
      || ""
  ).trim();
  const chatId = String(runtime.pendingChatContextByThreadId.get(threadId)?.chatId || "").trim();
  if (!threadId || !turnId || !chatId) {
    return;
  }
  const runKey = codexMessageUtils.buildRunKey(threadId, turnId);
  const currentRunKey = runtime.currentRunKeyByThreadId.get(threadId) || "";
  if (!runtime.replyCardByRunKey.has(runKey) && !runtime.replyCardByRunKey.has(currentRunKey)) {
    return;
  }
  runtime.upsertAssistantReplyCard({
    threadId,
    turnId,
    chatId,
    text: options.stepText || undefined,
    mode: options.stepText ? "progress" : "delta",
    state: "streaming",
  }).catch((error) => {
    console.error(`[codex-im] failed to refresh streaming progress card: ${error.message}`);
  });
}

/**
 * 从 chuang turn/progress 事件提取"正在做什么"的人类可读文本。
 * 服务端 TerminalEvent：step_started / model_started / tool_started 等。
 * 这样飞书端在整轮完成前就能看到工作步骤（不再黑盒等整段回复）。
 */
function extractProgressStepText(message) {
  const method = String(message?.method || "");
  if (method !== "turn/progress") {
    return null;
  }
  const event = message?.params?.event?.event || message?.params?.event || {};
  const kind = String(event.kind || "");
  switch (kind) {
    case "step_started": {
      const title = String(event.title || "").trim();
      return title ? `正在${title}…` : "正在准备…";
    }
    case "model_started":
      return "思考中…";
    case "tool_started": {
      const detail = String(event.activity_detail || "").trim();
      const title = String(event.activity_title || "").trim();
      if (title) {
        return detail ? `正在${title}：${detail}` : `正在${title}…`;
      }
      const tool = String(event.tool || "").trim();
      return tool ? `正在执行 ${tool}…` : "正在执行…";
    }
    default:
      return null;
  }
}

function isToolLikeItemType(itemType) {
  return [
    "commandExecution",
    "webSearch",
    "mcpToolCall",
    "localShellCall",
  ].includes(itemType);
}

function summarizeToolItem(itemType, item, prefix = "") {
  const normalizedType = String(itemType || "");
  const label = prefix ? `${prefix}：` : "";
  if (normalizedType === "webSearch") {
    const query = firstNonEmptyString(
      item?.query,
      item?.input?.query,
      item?.arguments?.query,
      item?.payload?.query
    );
    return query ? `${label}网页搜索：${query}` : `${label}网页搜索`;
  }

  if (normalizedType === "commandExecution" || normalizedType === "localShellCall") {
    const command = firstNonEmptyString(
      item?.command,
      item?.input?.command,
      item?.arguments?.command,
      item?.payload?.command,
      item?.cmd,
      item?.input?.cmd,
      item?.shellCommand
    );
    return command ? `${label}命令执行：${truncateInline(command, 80)}` : `${label}命令执行`;
  }

  if (normalizedType === "mcpToolCall") {
    const toolName = firstNonEmptyString(
      item?.toolName,
      item?.name,
      item?.input?.toolName,
      item?.arguments?.toolName,
      item?.payload?.toolName
    );
    return toolName ? `${label}MCP 工具：${toolName}` : `${label}MCP 工具`;
  }

  return `${label}${normalizedType || "工具调用"}`;
}

function summarizeApprovalRequest(params) {
  const reason = firstNonEmptyString(params?.reason);
  const command = firstNonEmptyString(params?.command);
  const commandText = command ? `：${truncateInline(command, 80)}` : "";
  const reasonText = reason ? `（${truncateInline(reason, 40)}）` : "";
  return `等待授权${reasonText}${commandText}`;
}

function isApprovalRequestEventMethod(method) {
  return typeof method === "string" && method.endsWith("requestApproval");
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function truncateInline(text, limit = 80) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) {
    return "";
  }
  if (clean.length <= limit) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, limit - 1))}…`;
}

async function deliverToFeishu(runtime, event) {
  if (event.type === "im.agent_reply") {
    const attachmentResult = await attachmentDirectives.handleOutboundAttachmentDirectives(runtime, {
      threadId: event.payload.threadId,
      turnId: event.payload.turnId,
      chatId: event.payload.chatId,
      text: event.payload.text,
    });
    if (!attachmentResult.text && attachmentResult.sent > 0) {
      return;
    }
    const progressRunKey = runtime.progressRunKeyByThreadId.get(event.payload.threadId) || "";
    const replyRunKey = codexMessageUtils.buildRunKey(
      event.payload.threadId,
      event.payload.turnId
    );
    const deltaStartsFreshReply = progressRunKey && (!replyRunKey || progressRunKey === replyRunKey);
    if (deltaStartsFreshReply) {
      runtime.progressRunKeyByThreadId.delete(event.payload.threadId);
    }
    await runtime.upsertAssistantReplyCard({
      threadId: event.payload.threadId,
      turnId: event.payload.turnId,
      chatId: event.payload.chatId,
      text: attachmentResult.text,
      mode: event.payload.mode || "delta",
      resetText: deltaStartsFreshReply,
      state: "streaming",
      deferFlush: !runtime.config.feishuStreamingOutput,
    });
    return;
  }

  if (event.type === "im.run_state") {
    if (event.payload.state === "streaming") {
      if (!runtime.config.feishuStreamingOutput) {
        return;
      }
      await runtime.upsertAssistantReplyCard({
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        chatId: event.payload.chatId,
        state: "streaming",
      });
    } else if (event.payload.state === "completed") {
      const inboundMessageId = runtime.pendingChatContextByThreadId
        .get(event.payload.threadId)?.messageId || "";
      try {
        let delivery = await runtime.upsertAssistantReplyCard({
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
          chatId: event.payload.chatId,
          state: "completed",
        });
        let providerReceipt = String(delivery?.providerReceipt || "").trim();
        if (providerReceipt) { await runtime.deliveryReceipts.recordOutboundCompletion({
          inboundMessageId,
          providerReceipt,
        }); } else { console.warn("[codex-im] final: no provider receipt, not dropping"); await runtime.deliveryReceipts.recordOutboundFailure({ inboundMessageId, failureClass: "receipt-unknown" }); }
      } catch (error) {
        await runtime.deliveryReceipts.recordOutboundFailure({
          inboundMessageId,
          failureClass: error?.code || error?.name || "send",
        });
        throw error;
      }
    } else if (event.payload.state === "failed") {
      const inboundMessageId = runtime.pendingChatContextByThreadId
        .get(event.payload.threadId)?.messageId || "";
      await runtime.deliveryReceipts.recordGenerationFailure({
        inboundMessageId,
        failureClass: "codex-turn",
      });
      await runtime.upsertAssistantReplyCard({
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        chatId: event.payload.chatId,
        text: event.payload.text || "执行失败",
        state: "failed",
      });
    } else if (event.payload.state === "cancelled") {
      const inboundMessageId = runtime.pendingChatContextByThreadId
        .get(event.payload.threadId)?.messageId || "";
      await runtime.deliveryReceipts.recordCancelled({ inboundMessageId });
    }
    return;
  }

  if (event.type === "im.approval_request") {
    const approval = runtime.pendingApprovalByThreadId.get(event.payload.threadId);
    if (!approval) {
      return;
    }
    await runtime.flushAssistantReplyCardNow({
      threadId: event.payload.threadId,
      turnId: event.payload.turnId || "",
    }).catch((error) => {
      console.error(`[codex-im] failed to flush reply before approval prompt: ${error.message}`);
    });
    const autoApproved = await runtime.tryAutoApproveRequest(event.payload.threadId, approval);
    if (autoApproved) {
      return;
    }
    await runtime.sendApprovalPrompt({
      threadId: event.payload.threadId,
      reason: "request",
    });
  }
}

function isTerminalTurnMessage(message) {
  const method = typeof message?.method === "string" ? message.method : "";
  if (method === "turn/completed" || method === "turn/failed" || method === "turn/cancelled") {
    return true;
  }
  if (method !== "error") {
    return false;
  }
  const params = message?.params || {};
  if (params?.willRetry) {
    return false;
  }
  const errorMessage = String(params?.error?.message || "");
  const errorDetails = String(params?.error?.additionalDetails || "");
  return /stream disconnected|Reconnecting/i.test(errorMessage)
    || /stream disconnected/i.test(errorDetails);
}

function isRecoverableStreamDisconnect(params) {
  const errorMessage = String(params?.error?.message || "");
  const errorDetails = String(params?.error?.additionalDetails || "");
  return /stream disconnected|Reconnecting/i.test(errorMessage)
    || /stream disconnected/i.test(errorDetails);
}

module.exports = {
  deliverToFeishu,
  handleCodexMessage,
  handleStopCommand,
};
