const codexMessageUtils = require("../../infra/codex/message-utils");
const messageNormalizers = require("../message/normalizers");
const reactionRepo = require("../../infra/feishu/reaction-repo");
const {
  formatCardKitAssistantMarkdown,
  sanitizeAssistantMarkdown,
  splitAssistantReplyForDisplay,
} = require("../../shared/assistant-markdown");
const { formatFailureText } = require("../../shared/error-text");
const { splitOutputForCollapsedDisplay } = require("../../shared/output-collapse");
const {
  buildApprovalCard,
  buildApprovalResolvedCard,
  buildAssistantReplyCard,
  buildCardResponse,
  buildCardToast,
  buildInfoCard,
  mergeReplyText,
} = require("./builders");

const CARDKIT_STREAMING_ELEMENT_ID = "streaming_content";
const CARDKIT_BODY_MAX_BYTES = 16 * 1024;
const CARD_ACTION_DEDUPE_WINDOW_MS = 2000;
const cardActionLastSeen = new Map();

function isDuplicateCardAction(action, normalized) {
  const key = [
    normalized?.chatId || "",
    action?.kind || "",
    action?.action || "",
    action?.selectedValue
      || action?.threadId
      || action?.workspaceRoot
      || action?.formValue?.project_name
      || action?.requestId
      || "",
  ].join("|");
  if (!key || key === "|||" || key === "||||") {
    return false;
  }
  const now = Date.now();
  const last = cardActionLastSeen.get(key) || 0;
  if (now - last < CARD_ACTION_DEDUPE_WINDOW_MS) {
    return true;
  }
  cardActionLastSeen.set(key, now);
  if (cardActionLastSeen.size > 500) {
    for (const [seenKey, seenAt] of cardActionLastSeen) {
      if (now - seenAt > 10 * 1000) {
        cardActionLastSeen.delete(seenKey);
      }
    }
  }
  return false;
}

/**
 * 长消息分片：把超长正文按段落切成多块（每块 <= maxBytes），
 * 尽量在段落边界切分，避免拆散代码块。
 */
function splitLongText(text, maxBytes) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return [];
  }
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) {
    return [normalized];
  }

  // 优先按段落（\n\n）切；段落过长时再按行兜底
  const paragraphs = normalized.split(/\n{2,}/);
  const chunks = [];
  let current = "";

  const flush = () => {
    if (!current.trim()) return;
    chunks.push(current.trim());
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) continue;
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      current = candidate;
      continue;
    }
    flush();
    if (Buffer.byteLength(paragraph, "utf8") <= maxBytes) {
      current = paragraph;
      continue;
    }
    // 单个段落超长：按行拆
    const lines = paragraph.split("\n");
    let lineChunk = "";
    for (const line of lines) {
      const next = lineChunk ? `${lineChunk}\n${line}` : line;
      if (Buffer.byteLength(next, "utf8") <= maxBytes) {
        lineChunk = next;
      } else {
        if (lineChunk) chunks.push(lineChunk.trim());
        lineChunk = line;
      }
    }
    if (lineChunk) chunks.push(lineChunk.trim());
    lineChunk = "";
  }
  flush();
  return chunks.length ? chunks : [normalized];
}

/**
 * 飞书回复卡片外观参数（改这里即可换肤，无需动其他代码）
 *
 * 所有颜色均支持 light_mode（浅色主题）与 dark_mode（深色主题）两套值，
 * 格式为 rgba(r,g,b,a)，a 为透明度（0~1）。
 *
 * | 参数名 | 作用 | 阈值逻辑 |
 * | --- | --- | --- |
 * | cus-progress-green | 进度条实心格颜色（低占用） | 上下文 <70% |
 * | cus-progress-yellow | 进度条实心格颜色（中占用） | 上下文 70%~89% |
 * | cus-progress-red | 进度条实心格颜色（高占用） | 上下文 >=90% |
 * | cus-line-green | 底部分割线颜色（低占用） | 上下文 <70%，与进度条同逻辑 |
 * | cus-line-yellow | 底部分割线颜色（中占用） | 上下文 70%~89% |
 * | cus-line-red | 底部分割线颜色（高占用） | 上下文 >=90% |
 * | cus-panel-green | 🛠️ 执行耗时面板 描边+标题色 | 固定 |
 * | cus-panel-blue | 💭 推理过程面板 描边+标题色 | 固定 |
 * | cus-panel-purple | 📄 输出结果面板 描边+标题色 | 固定 |
 * | cus-body-bg | 正文区淡底色（column_set background_style） | 固定 |
 * | cus-foot-grey | footer 模型/强度/耗时 灰字 | 固定 |
 *
 * 其他可调参数：
 * - 进度条格数：buildNativeProgressBarText(pct, cells=7) 的 cells
 * - 上下文阈值：buildNativeProgressBarText 内 safePct >= 90 / >= 70
 * - header 状态色：buildCardKitHeaderTemplate（streaming=indigo / completed=green / failed=red）
 * - 工具面板行数上限：formatToolTraceText 内 clipLines(..., 2)
 * - 正文段落间距：src/shared/assistant-markdown.js 内 \n{4,} 归并规则
 */
const CARDKIT_CUSTOM_COLORS = {
  "cus-body-bg": {
    light_mode: "rgba(64,120,255,0.10)",
    dark_mode: "rgba(64,120,255,0.12)",
  },
  "cus-line-green": {
    light_mode: "rgba(52,199,89,1)",
    dark_mode: "rgba(52,199,89,1)",
  },
  "cus-line-yellow": {
    light_mode: "rgba(245,217,10,1)",
    dark_mode: "rgba(245,217,10,1)",
  },
  "cus-line-red": {
    light_mode: "rgba(255,69,58,1)",
    dark_mode: "rgba(255,69,58,1)",
  },
  "cus-panel-green": {
    light_mode: "rgba(52,199,89,1)",
    dark_mode: "rgba(52,199,89,1)",
  },
  "cus-panel-blue": {
    light_mode: "rgba(84,140,255,1)",
    dark_mode: "rgba(84,140,255,1)",
  },
  "cus-panel-purple": {
    light_mode: "rgba(123,97,255,1)",
    dark_mode: "rgba(164,143,255,1)",
  },
  "cus-foot-grey": {
    light_mode: "rgba(31,35,41,0.85)",
    dark_mode: "rgba(255,255,255,0.85)",
  },
  "cus-progress-green": {
    light_mode: "rgba(52,199,89,1)",
    dark_mode: "rgba(52,199,89,1)",
  },
  "cus-progress-yellow": {
    light_mode: "rgba(245,217,10,1)",
    dark_mode: "rgba(245,217,10,1)",
  },
  "cus-progress-red": {
    light_mode: "rgba(255,69,58,1)",
    dark_mode: "rgba(255,69,58,1)",
  },
};

async function sendInfoCardMessage(runtime, { chatId, text, replyToMessageId = "", replyInThread = false, kind = "info" }) {
  if (!chatId || !text) {
    return null;
  }

  return sendInteractiveCard(runtime, {
    chatId,
    replyToMessageId,
    replyInThread,
    card: buildInfoCard(text, { kind }),
  });
}

async function sendFeedbackByContext(runtime, normalized, { text, kind = "info", replyToMessageId = "" } = {}) {
  if (!normalized?.chatId || !text) {
    return null;
  }
  return sendInfoCardMessage(runtime, {
    chatId: normalized.chatId,
    replyToMessageId: replyToMessageId || normalized.messageId || "",
    text,
    kind,
  });
}

async function sendInteractiveApprovalCard(runtime, { chatId, approval, replyToMessageId = "", replyInThread = false }) {
  if (!chatId || !approval) {
    return null;
  }

  return sendInteractiveCard(runtime, {
    chatId,
    replyToMessageId,
    replyInThread,
    card: buildApprovalCard(approval),
  });
}

async function updateInteractiveCard(runtime, { messageId, approval }) {
  if (!messageId || !approval) {
    return null;
  }
  return patchInteractiveCard(runtime, {
    messageId,
    card: buildApprovalResolvedCard(approval),
  });
}

async function sendInteractiveCard(runtime, { chatId, card, replyToMessageId = "", replyInThread = false }) {
  if (!chatId || !card) {
    return null;
  }
  return runtime.requireFeishuAdapter().sendInteractiveCard({
    chatId,
    card,
    replyToMessageId,
    replyInThread,
  });
}

async function patchInteractiveCard(runtime, { messageId, card }) {
  if (!messageId || !card) {
    return null;
  }
  return runtime.requireFeishuAdapter().patchInteractiveCard({ messageId, card });
}

async function handleCardAction(runtime, data) {
  const action = messageNormalizers.extractCardAction(data);
  const senderAllowlist = Array.isArray(runtime.config?.cardActionSenderAllowlist)
    ? runtime.config.cardActionSenderAllowlist
    : [];
  const operatorSenderIds = messageNormalizers.extractCardOperatorSenderIds
    ? messageNormalizers.extractCardOperatorSenderIds(data)
    : [];
  const chatId = messageNormalizers.extractCardChatId
    ? messageNormalizers.extractCardChatId(data)
    : "";
  const callbackChatType = messageNormalizers.extractCardChatType?.(data) || "";
  const chatType = callbackChatType || (typeof runtime.resolveChatType === "function"
    ? runtime.resolveChatType(chatId)
    : "");
  if (chatId && chatType && typeof runtime.setChatType === "function") {
    runtime.setChatType(chatId, chatType);
  }
  const isAllowedOperator = isAllowedCardOperator(
    runtime,
    operatorSenderIds,
    senderAllowlist,
    chatType,
    chatId
  );
  console.log(
    `[codex-im] card callback kind=${action?.kind || "-"} action=${action?.action || "-"} `
    + `thread=${action?.threadId || "-"} request=${action?.requestId || "-"} selected=${action?.selectedValue || "-"}`
  );
  if (!action) {
    runCardActionTask(runtime, sendCardActionFeedback(runtime, data, "无法识别卡片操作。", "error"));
    return buildCardResponse({});
  }

  if (action.kind === "approval") {
    if (!isAllowedOperator) {
      console.warn("[codex-im] card approval rejected by sender allowlist", {
        operatorIds: operatorSenderIds,
      });
      // 群聊里非管理员点审批按钮 → 静默忽略。
      // chatType 未知（解析不出群聊上下文，如外部群）也保守静默，防止群里刷提示。
      if (chatType === "group" || !chatType) {
        return buildCardResponse({});
      }
      runCardActionTask(runtime, sendCardActionFeedback(runtime, data, "你没有审批该请求的权限。", "error"));
      return buildCardResponse({});
    }
    runCardActionTask(runtime, runtime.handleApprovalCardActionAsync(action, data));
    return buildCardResponse({});
  }

  const normalized = messageNormalizers.normalizeCardActionContext(data, runtime.config);
  if (!normalized) {
    runCardActionTask(runtime, sendCardActionFeedback(runtime, data, "无法解析当前卡片上下文。", "error"));
    return buildCardResponse({});
  }

  if (!isAllowedOperator) {
    console.warn("[codex-im] card action rejected by sender allowlist", {
      operatorIds: operatorSenderIds,
      actionKind: action.kind,
      actionName: action.action || "",
    });
    // 群聊里非管理员点卡片按钮 → 静默忽略（不回复任何提示，防止刷屏）。
    // chatType 未知（解析不出群聊上下文，如外部群）也保守静默。
    if (chatType === "group" || !chatType) {
      return buildCardResponse({});
    }
    runCardActionTask(
      runtime,
      sendCardActionFeedbackByContext(runtime, normalized, "你没有操作该卡片的权限。", "error")
    );
    return buildCardResponse({});
  }

  if (isDuplicateCardAction(action, normalized)) {
    // 群聊里重复点击 → 静默忽略
    if (chatType === "group") {
      return buildCardResponse({});
    }
    runCardActionTask(
      runtime,
      sendCardActionFeedbackByContext(runtime, normalized, "操作已处理，请勿重复点击。", "info")
    );
    return buildCardResponse({});
  }

  try {
    const handled = runtime.dispatchCardAction(action, normalized);
    if (handled) {
      return handled;
    }
  } catch (error) {
    runCardActionTask(
      runtime,
      sendCardActionFeedbackByContext(runtime, normalized, formatFailureText("处理失败", error), "error")
    );
    return buildCardResponse({});
  }

  runCardActionTask(runtime, sendCardActionFeedbackByContext(runtime, normalized, "未支持的卡片操作。", "error"));
  return buildCardResponse({});
}

function isAllowedCardOperator(runtime, operatorSenderIds, senderAllowlist, chatType, chatId) {
  const [openId = "", userId = ""] = operatorSenderIds;
  const configuredAdminIds = [
    ...(Array.isArray(runtime?.config?.adminOpenIds) ? runtime.config.adminOpenIds : []),
    ...(Array.isArray(runtime?.config?.superAdminOpenIds) ? runtime.config.superAdminOpenIds : []),
  ];
  if (!Array.isArray(senderAllowlist) || senderAllowlist.length === 0) {
    if (chatType === "p2p") {
      return Boolean(openId || userId);
    }
    if (chatType !== "group") {
      // Card callbacks may omit chat type. An explicitly configured admin is
      // still safe to authorize; ordinary unknown-context senders fail closed.
      return operatorSenderIds.some((id) => id && configuredAdminIds.includes(id));
    }
    return operatorSenderIds.some((id) => id && (
      configuredAdminIds.includes(id)
      || Boolean(runtime?.groupAdmins?.isAdmin?.(chatId, id))
    ));
  }
  // 私聊：open_id 随会话变化不可靠，只校验稳定的 user_id。
  if (chatType === "p2p") {
    return Boolean(userId && senderAllowlist.includes(userId));
  }
  // 群聊：user_id 或 open_id 任一命中即可。
  if (chatType === "group") {
    return operatorSenderIds.some((id) => id && senderAllowlist.includes(id));
  }
  // 显式白名单已配置时，未知会话类型仍可凭精确身份命中。
  return operatorSenderIds.some((id) => id && senderAllowlist.includes(id));
}

function queueCardActionWithFeedback(runtime, normalized, feedbackText, task) {
  runCardActionTask(runtime, (async () => {
    await sendCardActionFeedbackByContext(runtime, normalized, feedbackText, "progress");
    try {
      await task();
    } catch (error) {
      console.error(`[codex-im] async card action failed: ${error.message}`);
      await sendCardActionFeedbackByContext(
        runtime,
        normalized,
        formatCardActionFailureText(error),
        "error"
      );
    }
  })());
  return buildCardToast(feedbackText);
}

function formatCardActionFailureText(error) {
  if (isMacFilePermissionError(error)) {
    const nodePath = process.execPath || "/opt/homebrew/bin/node";
    return [
      "需要 macOS 完整磁盘访问权限。",
      "",
      "Codex Feishu bridge 需要读取本地项目文件，但被系统拦住了：",
      `\`${error.message}\``,
      "",
      "请在“系统设置 -> 隐私与安全性 -> 完整磁盘访问权限”里允许：",
      "- `/opt/homebrew/bin/node`",
      `- \`${nodePath}\``,
      "",
      "授权后重启 codex-im 进程。",
    ].join("\n");
  }
  return formatFailureText("处理失败", error);
}

function isMacFilePermissionError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return (
    code === "EPERM"
    || code === "EACCES"
    || /operation not permitted/i.test(message)
  );
}

function runCardActionTask(runtime, taskPromise) {
  Promise.resolve(taskPromise).catch((error) => {
    console.error(`[codex-im] async card action failed: ${error.message}`);
  });
}

async function sendCardActionFeedbackByContext(runtime, normalized, text, kind = "info") {
  await sendFeedbackByContext(runtime, normalized, { text, kind });
}

async function sendCardActionFeedback(runtime, data, text, kind = "info") {
  const normalized = messageNormalizers.normalizeCardActionContext(data, runtime.config);
  if (!normalized) {
    return;
  }
  await sendCardActionFeedbackByContext(runtime, normalized, text, kind);
}

async function upsertAssistantReplyCard(
  runtime,
  { threadId, turnId, chatId, text, state, mode = "delta", deferFlush = false }
) {
  if (!threadId || !chatId) {
    return;
  }

  const resolvedTurnId = turnId
    || runtime.activeTurnIdByThreadId.get(threadId)
    || codexMessageUtils.extractTurnIdFromRunKey(runtime.currentRunKeyByThreadId.get(threadId) || "")
    || "";
  const preferredRunKey = codexMessageUtils.buildRunKey(threadId, resolvedTurnId);
  let runKey = preferredRunKey;
  let existing = runtime.replyCardByRunKey.get(runKey) || null;
  let reusedCurrentRunForTerminalState = false;

  if (!existing) {
    const currentRunKey = runtime.currentRunKeyByThreadId.get(threadId) || "";
    const currentEntry = runtime.replyCardByRunKey.get(currentRunKey) || null;
    const hasTerminalState = state === "completed" || state === "failed";
    const shouldReuseCurrent = !!(
      currentEntry
      && currentEntry.state !== "completed"
      && currentEntry.state !== "failed"
      && (
        !resolvedTurnId
        || !currentEntry.turnId
        || currentEntry.turnId === resolvedTurnId
        || hasTerminalState
      )
    );
    if (shouldReuseCurrent) {
      runKey = currentRunKey;
      existing = currentEntry;
      reusedCurrentRunForTerminalState = hasTerminalState
        && !!resolvedTurnId
        && !!currentEntry.turnId
        && currentEntry.turnId !== resolvedTurnId;
    }
  }

  if (!existing) {
    existing = {
      messageId: "",
      chatId,
      replyToMessageId: "",
      text: "",
      answerText: "",
      processText: "",
      state: "streaming",
      threadId,
      turnId: resolvedTurnId,
      model: resolveConfiguredReplyModel(runtime, threadId),
      effort: resolveConfiguredReplyEffort(runtime, threadId),
      startedAt: Date.now(),
      cardKitCardId: "",
      cardKitSequence: 0,
      cardKitLastStreamedText: "",
      cardKitLastStatusSignature: "",
      fallbackUsed: false,
    };
  }

  if (typeof text === "string" && text.length > 0) {
    applyAssistantReplyText(existing, text, mode);
  }
  existing.chatId = chatId;
  existing.replyToMessageId = runtime.pendingChatContextByThreadId.get(threadId)?.messageId || existing.replyToMessageId || "";
  if (state) {
    const currentState = String(existing.state || "");
    const nextState = String(state || "");
    const currentIsTerminal = currentState === "completed" || currentState === "failed";
    const nextIsTerminal = nextState === "completed" || nextState === "failed";
    if (!(currentIsTerminal && !nextIsTerminal)) {
      existing.state = nextState;
    }
  }
  if (resolvedTurnId && !reusedCurrentRunForTerminalState) {
    existing.turnId = resolvedTurnId;
  }
  if (!existing.model) {
    existing.model = resolveConfiguredReplyModel(runtime, threadId);
  }
  if (!existing.effort) {
    existing.effort = resolveConfiguredReplyEffort(runtime, threadId);
  }

  runtime.setReplyCardEntry(runKey, existing);
  runtime.setCurrentRunKeyForThread(threadId, runKey);

  if (deferFlush && existing.state !== "completed" && existing.state !== "failed") {
    return;
  }

  const shouldFlushImmediately = existing.state === "completed"
    || existing.state === "failed"
    || (!existing.messageId && typeof existing.text === "string" && existing.text.trim());
  return scheduleReplyCardFlush(runtime, runKey, { immediate: shouldFlushImmediately });
}

function applyAssistantReplyText(entry, text, mode = "delta") {
  const incoming = typeof text === "string" ? text : "";
  if (!incoming) {
    return;
  }
  if (mode === "completed_snapshot") {
    applyCompletedAssistantSnapshot(entry, incoming);
    return;
  }
  entry.text = mergeReplyText(entry.text, incoming);
  entry.answerText = mergeReplyText(entry.answerText || "", incoming);
}

function applyCompletedAssistantSnapshot(entry, text) {
  const completedText = sanitizeAssistantMarkdown(text, { preserveHeadings: true });
  if (!completedText) {
    return;
  }

  const accumulated = sanitizeAssistantMarkdown(entry.answerText || entry.text || "", { preserveHeadings: true });
  const processPrefix = extractProcessPrefixFromCompletedSnapshot(accumulated, completedText);
  if (processPrefix) {
    entry.processText = mergeProcessText(entry.processText, processPrefix);
  }

  // The completed snapshot is the authoritative final text. Never let a short
  // partial snapshot overwrite a longer body, but avoid merging: delta text and
  // snapshot can differ in whitespace/punctuation, and a naive concat would
  // duplicate the answer.
  if (processPrefix || !accumulated || completedText.length >= accumulated.length) {
    entry.answerText = completedText;
    entry.text = completedText;
  }
}

function extractProcessPrefixFromCompletedSnapshot(accumulated, completedText) {
  const normalizedAccumulated = String(accumulated || "").trim();
  const normalizedCompleted = String(completedText || "").trim();
  if (!normalizedAccumulated || !normalizedCompleted || normalizedAccumulated === normalizedCompleted) {
    return "";
  }

  // Only treat a prefix as "process" text when the completed snapshot starts
  // with an explicit conclusion marker. Reasoning models (deepseek) may emit
  // partial snapshots that end at a mid-sentence boundary; blindly stripping
  // "everything before the snapshot" used to swallow the real opening of the
  // answer.
  const conclusionMarker = /(?:^(?:已完成|结论是|先说结论|答案是|处理好了)[，,。；;：:\s])/;
  if (conclusionMarker.test(normalizedCompleted)) {
    const markerIndex = normalizedAccumulated.lastIndexOf(normalizedCompleted);
    if (markerIndex > 0) {
      return normalizedAccumulated.slice(0, markerIndex).trim();
    }
    if (normalizedAccumulated.endsWith(normalizedCompleted)) {
      return normalizedAccumulated.slice(0, normalizedAccumulated.length - normalizedCompleted.length).trim();
    }
  }
  return "";
}

function mergeProcessText(current, incoming) {
  const left = String(current || "").trim();
  const right = String(incoming || "").trim();
  if (!right) {
    return left;
  }
  if (!left) {
    return right;
  }
  if (left.includes(right)) {
    return left;
  }
  if (right.includes(left)) {
    return right;
  }
  return `${left}\n\n${right}`.trim();
}

async function scheduleReplyCardFlush(runtime, runKey, { immediate = false } = {}) {
  const entry = runtime.replyCardByRunKey.get(runKey);
  if (!entry) {
    return;
  }

  if (immediate) {
    clearReplyFlushTimer(runtime, runKey);
    return enqueueReplyCardFlush(runtime, runKey);
  }

  if (runtime.replyFlushTimersByRunKey.has(runKey)) {
    return;
  }

  const timer = setTimeout(() => {
    runtime.replyFlushTimersByRunKey.delete(runKey);
    enqueueReplyCardFlush(runtime, runKey).catch((error) => {
      console.error(`[codex-im] failed to flush reply card: ${error.message}`);
    });
  }, 300);
  runtime.replyFlushTimersByRunKey.set(runKey, timer);
}

function clearReplyFlushTimer(runtime, runKey) {
  const timer = runtime.replyFlushTimersByRunKey.get(runKey);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  runtime.replyFlushTimersByRunKey.delete(runKey);
}

async function flushReplyCard(runtime, runKey) {
  const entry = runtime.replyCardByRunKey.get(runKey);
  if (!entry) {
    return;
  }

  if (shouldUseCardKitReply(runtime, entry)) {
    try {
      return await flushCardKitReplyCard(runtime, runKey, entry);
    } catch (error) {
      const openUntil = openCardKitCircuit(runtime, error);
      const cooldownText = openUntil > Date.now()
        ? `; CardKit paused for ${Math.ceil((openUntil - Date.now()) / 1000)}s`
        : "";
      console.error(
        `[codex-im] CardKit reply failed, falling back to legacy card${cooldownText}: ${error.message}`
      );
      entry.fallbackUsed = true;
      entry.messageId = "";
      entry.cardKitCardId = "";
      runtime.setReplyCardEntry(runKey, entry);
    }
  }

  return flushLegacyReplyCard(runtime, runKey, entry);
}

function shouldUseCardKitReply(runtime, entry, now = Date.now()) {
  return Boolean(
    runtime.config.feishuCardKitStreaming !== false
    && entry
    && !entry.fallbackUsed
    && Number(runtime.cardKitCircuitOpenUntil || 0) <= now
  );
}

function openCardKitCircuit(runtime, error, now = Date.now()) {
  const cooldownMs = Number(runtime?.config?.cardKitFailureCooldownMs || 0);
  runtime.cardKitCircuitLastReason = String(error?.message || "unknown CardKit error").slice(0, 240);
  runtime.cardKitCircuitOpenUntil = Number.isFinite(cooldownMs) && cooldownMs > 0
    ? now + cooldownMs
    : 0;
  return runtime.cardKitCircuitOpenUntil;
}

async function flushCardKitReplyCard(runtime, runKey, entry) {
  const adapter = runtime.requireFeishuAdapter();
  if (!entry.cardKitCardId) {
    const initialContent = buildCardKitStreamingContent(entry);
    const initialStatusSignature = buildCardKitStatusSignature(runtime, runKey, entry);
    const cardId = await adapter.createCardEntity({
      card: buildCardKitStreamingCard(runtime, runKey, entry, { content: initialContent }),
    });
    entry.cardKitCardId = cardId;
    entry.cardKitSequence = 0;
    entry.cardKitLastStreamedText = initialContent;
    entry.cardKitLastStatusSignature = initialStatusSignature;

    const response = await adapter.sendCardByCardId({
      chatId: entry.chatId,
      cardId,
      replyToMessageId: entry.replyToMessageId,
    });
    entry.messageId = codexMessageUtils.extractCreatedMessageId(response);
    if (!entry.messageId) {
      throw new Error("Feishu CardKit send did not return message_id");
    }
    runtime.setReplyCardEntry(runKey, entry);
    runtime.clearPendingReactionForThread(entry.threadId).catch((error) => {
      console.error(`[codex-im] failed to clear pending reaction after CardKit card: ${error.message}`);
    });
  }

  if (entry.state === "completed" || entry.state === "failed") {
    await finalizeCardKitReply(runtime, entry);
    runtime.disposeReplyRunState(runKey, entry.threadId);
    return { providerReceipt: entry.messageId };
  }

  const content = buildCardKitStreamingContent(entry);
  const statusSignature = buildCardKitStatusSignature(runtime, runKey, entry);
  if (statusSignature !== entry.cardKitLastStatusSignature) {
    entry.cardKitSequence += 1;
    await adapter.updateCardKitCard({
      cardId: entry.cardKitCardId,
      card: buildCardKitStreamingCard(runtime, runKey, entry, { content }),
      sequence: entry.cardKitSequence,
    });
    entry.cardKitLastStreamedText = content;
    entry.cardKitLastStatusSignature = statusSignature;
    runtime.setReplyCardEntry(runKey, entry);
    return;
  }

  if (content === entry.cardKitLastStreamedText) {
    return;
  }
  entry.cardKitSequence += 1;
  await adapter.streamCardContent({
    cardId: entry.cardKitCardId,
    elementId: CARDKIT_STREAMING_ELEMENT_ID,
    content,
    sequence: entry.cardKitSequence,
  });
  entry.cardKitLastStreamedText = content;
  runtime.setReplyCardEntry(runKey, entry);
}

async function finalizeCardKitReply(runtime, entry) {
  const adapter = runtime.requireFeishuAdapter();
  const display = buildAssistantDisplayContent(entry);
  const card = buildCardKitFinalCard(runtime, entry, display);

  entry.cardKitSequence += 1;
  await adapter.setCardStreamingMode({
    cardId: entry.cardKitCardId,
    streamingMode: false,
    sequence: entry.cardKitSequence,
  });

  entry.cardKitSequence += 1;
  await adapter.updateCardKitCard({
    cardId: entry.cardKitCardId,
    card,
    sequence: entry.cardKitSequence,
  });

  // 长回复分片：主卡只放第一片，剩余内容逐片作为独立消息发送
  const chunks = Array.isArray(display.chunks) ? display.chunks : [];
  const totalPieces = chunks.length + 1;
  for (let i = 0; i < chunks.length; i++) {
    await sendInfoCardMessage(runtime, {
      chatId: entry.chatId,
      text: `**📄 续篇 ${i + 2}/${totalPieces}**\n\n${chunks[i]}`,
      kind: "info",
    });
  }
}

function buildCardKitStreamingCard(runtime, runKey, entry, options = {}) {
  const content = typeof options.content === "string" ? options.content : buildCardKitStreamingContent(entry);
  const elements = [
    ...buildCardKitStatusPanels(runtime, runKey, entry),
    buildCardKitBodyContainer(content, { elementId: CARDKIT_STREAMING_ELEMENT_ID }),
  ];
  if (entry.state === "streaming") {
    elements.push(buildCardKitStopButton(entry));
  }
  elements.push(...buildCardKitFooter(runtime, entry));

  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      wide_screen_mode: true,
      update_multi: true,
      style: {
        color: CARDKIT_CUSTOM_COLORS,
      },
      summary: {
        content: buildCardKitSummary(content, entry.state),
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: buildCardKitHeaderTitle(entry),
      },
      template: buildCardKitHeaderTemplate(entry),
    },
    body: {
      elements,
    },
  };
}

function buildCardKitBodyContainer(content, options = {}) {
  const markdownElement = {
    tag: "markdown",
    content,
    text_align: "left",
    text_size: options.textSize || "normal_v2",
    margin: "0px 0px 0px 0px",
  };
  if (options.elementId) {
    markdownElement.element_id = options.elementId;
  }
  return {
    tag: "column_set",
    flex_mode: "none",
    background_style: "cus-body-bg",
    horizontal_spacing: "12px",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [markdownElement],
      },
    ],
  };
}

function buildCardKitFooterDivider(pct) {
  const safePct = Math.max(0, Math.min(100, Number(pct) || 0));
  const color = safePct >= 90
    ? "cus-line-red"
    : safePct >= 70
      ? "cus-line-yellow"
      : "cus-line-green";
  return {
    tag: "column_set",
    flex_mode: "none",
    background_style: color,
    horizontal_spacing: "0px",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        padding: "0px 0px 0px 0px",
        elements: [{ tag: "markdown", content: "", margin: "0px 0px 0px 0px" }],
      },
    ],
  };
}

function buildCardKitStopButton(entry) {
  return {
    tag: "column_set",
    flex_mode: "none",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "🛑 停止" },
            type: "danger",
            value: {
              kind: "panel",
              action: "stop",
              threadId: entry.threadId || "",
              requestId: entry.turnId || "",
            },
          },
        ],
      },
    ],
  };
}

function buildCardKitFinalCard(runtime, entry, displayOverride) {
  const runKey = codexMessageUtils.buildRunKey(entry.threadId, entry.turnId);
  const display = displayOverride || buildAssistantDisplayContent(entry);
  const content = display.answer;
  const footerElements = buildCardKitFooter(runtime, entry);
  const elements = [
    ...buildCardKitStatusPanels(runtime, runKey, entry),
    ...buildCardKitOutputElements(runtime, content),
  ];

  if (footerElements.length) {
    const contextText = formatContextText(runtime.latestTokenUsageByThreadId.get(entry.threadId));
    const ctx = contextText ? parseContextPercent(contextText) : null;
    elements.push(buildCardKitFooterDivider(ctx?.pct));
    elements.push(...footerElements);
  }

  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      wide_screen_mode: true,
      update_multi: true,
      style: {
        color: CARDKIT_CUSTOM_COLORS,
      },
      summary: {
        content: buildCardKitSummary(content, entry.state),
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: buildCardKitHeaderTitle(entry),
      },
      template: buildCardKitHeaderTemplate(entry),
    },
    body: { elements },
  };
}

function buildCardKitOutputElements(runtime, content) {
  const visibleTailPercent = Number(runtime?.config?.outputVisibleTailPercent || 10);
  const split = splitOutputForCollapsedDisplay(content, {
    visibleTailRatio: visibleTailPercent / 100,
  });
  if (!split.collapsedContent) {
    return [buildCardKitBodyContainer(split.visibleContent)];
  }
  return [
    buildCardKitCollapsiblePanel({
      title: "📄 输出结果 · 展开全文",
      content: buildCardKitBodyContainer(split.collapsedContent),
      titleColor: "cus-panel-purple",
      borderColor: "cus-panel-purple",
      expanded: false,
    }),
    buildCardKitBodyContainer(split.visibleContent),
  ];
}

function buildCardKitStatusPanels(runtime, runKey, entry) {
  const toolTrace = runtime.toolTraceByRunKey.get(runKey);
  const reasoningTrace = runtime.reasoningTraceByRunKey?.get(runKey);
  const elapsed = formatReplyElapsed(entry.startedAt);
  const tokenUsage = runtime.latestTokenUsageByThreadId.get(entry.threadId);
  const display = buildAssistantDisplayContent(entry);
  const chatType = typeof runtime.resolveChatType === "function"
    ? runtime.resolveChatType(entry?.chatId)
    : "";
  const reasoningMode = chatType === "group"
    ? resolveGroupCardReasoningMode(runtime?.config)
    : "full";
  return [
    buildCardKitCollapsiblePanel({
      title: buildToolPanelTitle(runtime.toolItemIdsByRunKey.get(runKey), entry.state),
      content: formatToolTraceText(toolTrace, entry.state),
      titleColor: "cus-panel-green",
      borderColor: "cus-panel-green",
    }),
    buildGroupReasoningPanel(runtime, entry, {
      reasoningTrace,
      elapsed,
      tokenUsage,
      assistantNotes: display.notes,
      reasoningMode,
    }),
  ];
}

/**
 * 推理面板：私聊显示完整推理（full）；群聊按配置收敛——
 * none（默认，方案 B）：不显示推理内容，只显示“正在推理…/推理完成”状态，且不展开。
 * brief（方案 A）：只显示推理摘要前 2 行，且不展开。
 */
function buildGroupReasoningPanel(runtime, entry, {
  reasoningTrace,
  elapsed,
  tokenUsage,
  assistantNotes,
  reasoningMode,
}) {
  const isStreaming = entry.state === "streaming";
  if (reasoningMode === "none") {
    return buildCardKitCollapsiblePanel({
      title: isStreaming ? "💭 正在推理…" : "💭 推理完成",
      content: isStreaming
        ? (elapsed ? `正在处理，已运行约 ${elapsed}。` : "正在处理。")
        : (elapsed ? `已完成，耗时约 ${elapsed}；最终结论见下方正文。` : "已完成；最终结论见下方正文。"),
      titleColor: "cus-panel-blue",
      borderColor: "cus-panel-blue",
      expanded: false,
    });
  }

  const fullText = formatThinkingText({
    state: entry.state,
    elapsed,
    reasoningTrace,
    tokenUsage,
    assistantNotes,
  });
  if (reasoningMode === "brief") {
    const briefText = fullText.split("\n").slice(0, 2).join("\n");
    return buildCardKitCollapsiblePanel({
      title: isStreaming ? "💭 推理过程（实时）" : "💭 推理过程（完成）",
      content: briefText,
      titleColor: "cus-panel-blue",
      borderColor: "cus-panel-blue",
      expanded: false,
    });
  }

  return buildCardKitCollapsiblePanel({
    title: isStreaming ? "💭 推理过程（实时）" : "💭 推理过程（完成）",
    content: fullText,
    titleColor: "cus-panel-blue",
    borderColor: "cus-panel-blue",
    expanded: isStreaming,
  });
}

function resolveGroupCardReasoningMode(config) {
  const mode = String(config?.groupCardReasoningMode || "none").toLowerCase();
  return ["none", "brief", "full"].includes(mode) ? mode : "none";
}

function buildCardKitCollapsiblePanel({
  title,
  content,
  expanded = false,
  titleColor,
  borderColor,
  textSize = "notation",
}) {
  return {
    tag: "collapsible_panel",
    expanded: Boolean(expanded),
    header: {
      title: {
        tag: titleColor ? "markdown" : "plain_text",
        content: titleColor ? `<font color='${titleColor}'>${title}</font>` : title,
      },
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        size: "16px 16px",
      },
      icon_position: "follow_text",
      icon_expanded_angle: -180,
    },
    border: { color: borderColor || "grey", corner_radius: "5px" },
    padding: "8px 8px 8px 8px",
    elements: typeof content === "object" && content
      ? [content]
      : [{ tag: "markdown", content, text_size: textSize }],
  };
}

function buildToolPanelTitle(toolItems, state) {
  const count = toolItems instanceof Set ? toolItems.size : 0;
  if (count > 0) {
    return `🛠️ 执行耗时 · 查看 ${count} 个步骤`;
  }
  if (state === "streaming") {
    return "🛠️ 工具执行";
  }
  return "🛠️ 工具执行 · 无额外步骤";
}

function buildCardKitStreamingContent(entry) {
  return buildAssistantDisplayContent(entry).answer;
}

function buildCardKitStatusSignature(runtime, runKey, entry) {
  const toolItems = runtime.toolItemIdsByRunKey.get(runKey);
  const toolTrace = runtime.toolTraceByRunKey.get(runKey);
  const reasoningTrace = runtime.reasoningTraceByRunKey?.get(runKey);
  const tokenUsage = runtime.latestTokenUsageByThreadId.get(entry.threadId);
  const display = buildAssistantDisplayContent(entry);
  return JSON.stringify({
    state: entry.state,
    toolCount: toolItems instanceof Set ? toolItems.size : 0,
    toolTrace: Array.isArray(toolTrace) ? toolTrace.filter(Boolean) : [],
    reasoningTrace: Array.isArray(reasoningTrace)
      ? reasoningTrace.map((entry) => ({
        itemId: String(entry?.itemId || ""),
        summary: String(entry?.summary || ""),
      }))
      : [],
    contextUsed: Number(tokenUsage?.last?.totalTokens || 0),
    contextWindow: Number(tokenUsage?.modelContextWindow || 0),
    reasoning: Number(tokenUsage?.last?.reasoningOutputTokens || 0),
    notes: display.notes,
  });
}

function resolveAssistantReplyContent(entry) {
  const answerText = typeof entry.answerText === "string" ? entry.answerText.trim() : "";
  if (answerText) {
    return answerText;
  }
  const text = typeof entry.text === "string" ? entry.text.trim() : "";
  if (text) {
    return text;
  }
  if (entry.state === "failed") {
    return "这次没有顺利完成。";
  }
  if (entry.state === "completed") {
    return "我已经处理好了。";
  }
  return "已收到，正在分析和执行。";
}

function buildAssistantDisplayContent(entry) {
  const raw = resolveAssistantReplyContent(entry);
  const explicitProcessText = typeof entry.processText === "string" ? entry.processText.trim() : "";
  if (entry.state !== "completed") {
    return {
      answer: formatCardKitAssistantMarkdown(raw),
      notes: explicitProcessText ? formatCardKitThinkingMarkdown(explicitProcessText) : "",
    };
  }
  if (explicitProcessText) {
    return {
      answer: formatCardKitAssistantMarkdown(raw),
      notes: formatCardKitThinkingMarkdown(explicitProcessText),
    };
  }
  const split = splitAssistantReplyForDisplay(raw);
  const formattedAnswer = formatCardKitAssistantMarkdown(split.answerText);
  if (Buffer.byteLength(formattedAnswer, "utf8") > CARDKIT_BODY_MAX_BYTES) {
    const chunks = splitLongText(formattedAnswer, CARDKIT_BODY_MAX_BYTES);
    const first = chunks[0] || formattedAnswer;
    return {
      answer: `${first}\n\n_（回复较长，剩余内容已分片发送，请往下看）_`,
      notes: formatCardKitThinkingMarkdown(split.preAnswerText),
      chunks: chunks.slice(1),
    };
  }
  return {
    answer: formattedAnswer,
    notes: formatCardKitThinkingMarkdown(split.preAnswerText),
  };
}

function resolveConfiguredReplyModel(runtime, threadId) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId) {
    return "";
  }

  const bindingKey = runtime?.bindingKeyByThreadId?.get?.(normalizedThreadId) || "";
  const workspaceRoot = typeof runtime?.resolveWorkspaceRootForThread === "function"
    ? runtime.resolveWorkspaceRootForThread(normalizedThreadId)
    : runtime?.workspaceRootByThreadId?.get?.(normalizedThreadId) || "";
  if (!bindingKey || !workspaceRoot || typeof runtime?.getCodexParamsForWorkspace !== "function") {
    return "";
  }

  const params = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  return typeof params?.model === "string" ? params.model.trim() : "";
}

function resolveConfiguredReplyEffort(runtime, threadId) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId) {
    return "";
  }

  const bindingKey = runtime?.bindingKeyByThreadId?.get?.(normalizedThreadId) || "";
  const workspaceRoot = typeof runtime?.resolveWorkspaceRootForThread === "function"
    ? runtime.resolveWorkspaceRootForThread(normalizedThreadId)
    : runtime?.workspaceRootByThreadId?.get?.(normalizedThreadId) || "";
  if (!bindingKey || !workspaceRoot || typeof runtime?.getCodexParamsForWorkspace !== "function") {
    return "";
  }

  const params = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  return typeof params?.effort === "string" ? params.effort.trim() : "";
}

function resolveReplyCardModel(runtime, entry) {
  const capturedModel = typeof entry?.model === "string" ? entry.model.trim() : "";
  if (capturedModel) {
    return capturedModel;
  }

  return resolveConfiguredReplyModel(runtime, entry?.threadId)
    || String(runtime?.config?.defaultCodexModel || "").trim()
    || "Codex";
}

function resolveReplyCardEffort(runtime, entry) {
  const capturedEffort = typeof entry?.effort === "string" ? entry.effort.trim() : "";
  if (capturedEffort) {
    return capturedEffort;
  }

  return resolveConfiguredReplyEffort(runtime, entry?.threadId)
    || String(runtime?.config?.defaultCodexEffort || "").trim();
}

function buildCardKitFooter(runtime, entry) {
  const elements = [];
  const headline = [];
  const model = resolveReplyCardModel(runtime, entry);
  if (model) {
    headline.push(`🧠 ${model}`);
  }
  const effort = resolveReplyCardEffort(runtime, entry);
  if (effort) {
    headline.push(`💪 强度 ${effort}`);
  }
  const elapsed = formatReplyElapsed(entry.startedAt);
  if (elapsed) {
    headline.push(`⏳ 耗时 ${elapsed}`);
  }
  elements.push({
    tag: "markdown",
    content: `<font color='cus-foot-grey'>${headline.join(" · ")}</font>`,
    text_size: "notation",
    margin: "4px 0px 0px 0px",
  });

  const contextText = formatContextText(runtime.latestTokenUsageByThreadId.get(entry.threadId));
  if (contextText) {
    const ctx = parseContextPercent(contextText);
    if (ctx) {
      elements.push({
        tag: "markdown",
        content: `📝 上下文 ${ctx.usedText}/${ctx.windowText} · ${buildNativeProgressBarText(ctx.pct)} (${ctx.pct}%)`,
        text_size: "notation",
        margin: "2px 0px 0px 0px",
      });
    } else {
      elements.push({
        tag: "markdown",
        content: contextText,
        text_size: "notation",
        margin: "2px 0px 0px 0px",
      });
    }
  }

  return elements;
}

function parseContextPercent(contextText) {
  const text = String(contextText || "").trim();
  const m = text.match(/^上下文\s+([0-9][0-9.,]*[kKmM]?)\/([0-9][0-9.,]*[kKmM]?)\s+\((\d+)%\)(?:\s*·\s*(.*))?$/);
  if (!m) {
    return null;
  }
  return {
    usedText: m[1],
    windowText: m[2],
    pct: Math.max(0, Math.min(100, Number(m[3]) || 0)),
    advisory: m[4] || "",
  };
}

function buildEmojiProgressBar(pct, width = 5) {
  const raw = Math.round((pct / 100) * width);
  const filled = pct > 0 ? Math.max(1, Math.min(width, raw)) : 0;
  const block = pct >= 90 ? "🟥" : pct >= 70 ? "🟧" : "🟩";
  return block.repeat(filled) + "⬜".repeat(width - filled);
}

function buildNativeProgressBarText(pct, cells = 7) {
  const safePct = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = safePct > 0 ? Math.max(1, Math.round((safePct / 100) * cells)) : 0;
  const color = safePct >= 90 ? "cus-progress-red" : safePct >= 70 ? "cus-progress-yellow" : "cus-progress-green";
  const parts = [];
  for (let i = 0; i < cells; i += 1) {
    parts.push(`<font color='${i < filled ? color : "grey-200"}'>▊</font>`);
  }
  return parts.join(" ");
}

function buildCardKitHeaderTitle(entry) {
  if (entry?.state === "failed") {
    return "🔴 未完成";
  }
  if (entry?.state === "completed") {
    return "✅ 已完成";
  }
  return "🟡 正在回复";
}

function buildCardKitHeaderTemplate(entry) {
  if (entry?.state === "failed") {
    return "red";
  }
  if (entry?.state === "completed") {
    return "green";
  }
  return "indigo";
}

function buildCardKitSummary(content, state) {
  const plain = String(content || "")
    .replace(/[*_`#>[\]()~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain) {
    return plain.slice(0, 120);
  }
  if (state === "failed") {
    return "这次没有顺利完成。";
  }
  if (state === "completed") {
    return "我已经处理好了。";
  }
  return "正在回复。";
}

function buildLegacyReplyCard(runtime, runKey, entry) {
  const legacyDisplay = entry.state === "completed"
    ? splitAssistantReplyForDisplay(resolveAssistantReplyContent(entry))
    : { answerText: entry.text };
  const chatType = typeof runtime.resolveChatType === "function"
    ? runtime.resolveChatType(entry?.chatId)
    : "";
  const reasoningMode = chatType === "group"
    ? resolveGroupCardReasoningMode(runtime?.config)
    : "full";
  let thinkingText = formatThinkingText({
    state: entry.state,
    elapsed: formatReplyElapsed(entry.startedAt),
    reasoningTrace: runtime.reasoningTraceByRunKey?.get(runKey),
    tokenUsage: runtime.latestTokenUsageByThreadId.get(entry.threadId),
    assistantNotes: buildAssistantDisplayContent(entry).notes,
  });
  if (reasoningMode === "none") {
    thinkingText = entry.state === "streaming"
      ? "💭 正在推理…"
      : "💭 推理完成";
  } else if (reasoningMode === "brief") {
    thinkingText = thinkingText.split("\n").slice(0, 2).join("\n");
  }
  return buildAssistantReplyCard({
    text: legacyDisplay.answerText,
    state: entry.state,
    elapsed: formatReplyElapsed(entry.startedAt),
    model: resolveReplyCardModel(runtime, entry),
    effort: resolveReplyCardEffort(runtime, entry),
    toolText: formatToolTraceText(runtime.toolTraceByRunKey.get(runKey), entry.state),
    thinkingText,
    usageText: formatUsageText(runtime.latestTokenUsageByThreadId.get(entry.threadId)),
    contextText: formatContextText(runtime.latestTokenUsageByThreadId.get(entry.threadId)),
    toolCountText: formatToolCountText(runtime.toolItemIdsByRunKey.get(runKey)),
    outputVisibleTailPercent: runtime?.config?.outputVisibleTailPercent,
  });
}

async function flushLegacyReplyCard(runtime, runKey, entry) {
  const card = buildLegacyReplyCard(runtime, runKey, entry);

  if (!entry.messageId) {
    const response = await sendInteractiveCard(runtime, {
      chatId: entry.chatId,
      card,
      replyToMessageId: entry.replyToMessageId,
    });
    entry.messageId = codexMessageUtils.extractCreatedMessageId(response);
    if (!entry.messageId) {
      throw new Error("Feishu legacy card send did not return message_id");
    }
    runtime.setReplyCardEntry(runKey, entry);
    runtime.clearPendingReactionForThread(entry.threadId).catch((error) => {
      console.error(`[codex-im] failed to clear pending reaction after first reply card: ${error.message}`);
    });
    if (entry.state === "completed" || entry.state === "failed") {
      runtime.disposeReplyRunState(runKey, entry.threadId);
    }
    return { providerReceipt: entry.messageId };
  }

  await patchInteractiveCard(runtime, {
    messageId: entry.messageId,
    card,
  });

  if (entry.state === "completed" || entry.state === "failed") {
    runtime.disposeReplyRunState(runKey, entry.threadId);
  }
  return { providerReceipt: entry.messageId };
}

async function enqueueReplyCardFlush(runtime, runKey) {
  if (runtime.replyFlushInFlightByRunKey.has(runKey)) {
    runtime.replyFlushQueuedByRunKey.add(runKey);
    return runtime.replyFlushInFlightByRunKey.get(runKey);
  }

  const flushPromise = (async () => {
    let result;
    try {
      do {
        runtime.replyFlushQueuedByRunKey.delete(runKey);
        result = await flushReplyCard(runtime, runKey);
      } while (runtime.replyFlushQueuedByRunKey.has(runKey));
      return result;
    } finally {
      runtime.replyFlushInFlightByRunKey.delete(runKey);
      runtime.replyFlushQueuedByRunKey.delete(runKey);
    }
  })();

  runtime.replyFlushInFlightByRunKey.set(runKey, flushPromise);
  return flushPromise;
}

async function addPendingReaction(runtime, bindingKey, messageId) {
  if (!bindingKey || !messageId) {
    return;
  }

  await clearPendingReactionForBinding(runtime, bindingKey);

  const reaction = await createReaction(runtime, {
    messageId,
    emojiType: "Typing",
  });
  runtime.pendingReactionByBindingKey.set(bindingKey, {
    messageId,
    reactionId: reaction.reactionId,
  });
}

function movePendingReactionToThread(runtime, bindingKey, threadId) {
  if (!bindingKey || !threadId) {
    return;
  }

  const pending = runtime.pendingReactionByBindingKey.get(bindingKey);
  if (!pending) {
    return;
  }
  runtime.pendingReactionByBindingKey.delete(bindingKey);
  runtime.pendingReactionByThreadId.set(threadId, pending);
}

async function clearPendingReactionForBinding(runtime, bindingKey) {
  const pending = runtime.pendingReactionByBindingKey.get(bindingKey);
  if (!pending) {
    return;
  }
  runtime.pendingReactionByBindingKey.delete(bindingKey);
  await deleteReaction(runtime, pending);
}

async function clearPendingReactionForThread(runtime, threadId) {
  if (!threadId) {
    return;
  }
  const pending = runtime.pendingReactionByThreadId.get(threadId);
  if (!pending) {
    return;
  }
  runtime.pendingReactionByThreadId.delete(threadId);
  await deleteReaction(runtime, pending);
}

async function createReaction(runtime, { messageId, emojiType }) {
  return reactionRepo.createReaction(runtime.requireFeishuAdapter(), { messageId, emojiType });
}

async function deleteReaction(runtime, { messageId, reactionId }) {
  await reactionRepo.deleteReaction(runtime.requireFeishuAdapter(), { messageId, reactionId });
}

function disposeReplyRunState(runtime, runKey, threadId) {
  if (runKey) {
    clearReplyFlushTimer(runtime, runKey);
    runtime.replyFlushQueuedByRunKey.delete(runKey);
    runtime.replyFlushInFlightByRunKey.delete(runKey);
    runtime.replyCardByRunKey.delete(runKey);
    runtime.toolItemIdsByRunKey.delete(runKey);
    runtime.toolTraceByRunKey.delete(runKey);
    if (runtime.reasoningTraceByRunKey instanceof Map) {
      runtime.reasoningTraceByRunKey.delete(runKey);
    }
    runtime.assistantDeltaSeenByRunKey.delete(runKey);
  }
  if (threadId && runtime.currentRunKeyByThreadId.get(threadId) === runKey) {
    runtime.currentRunKeyByThreadId.delete(threadId);
  }
}

async function flushAssistantReplyCardNow(runtime, { threadId, turnId = "" } = {}) {
  if (!threadId) {
    return;
  }
  const preferredRunKey = codexMessageUtils.buildRunKey(threadId, turnId);
  const runKey = runtime.replyCardByRunKey.has(preferredRunKey)
    ? preferredRunKey
    : runtime.currentRunKeyByThreadId.get(threadId) || preferredRunKey;
  if (!runtime.replyCardByRunKey.has(runKey)) {
    return;
  }
  clearReplyFlushTimer(runtime, runKey);
  return enqueueReplyCardFlush(runtime, runKey);
}

function formatReplyElapsed(startedAt) {
  if (!startedAt || !Number.isFinite(startedAt)) {
    return "";
  }
  const elapsedSeconds = Math.max(0, (Date.now() - startedAt) / 1000);
  if (elapsedSeconds < 10) {
    return `${elapsedSeconds.toFixed(1)}s`;
  }
  return `${Math.round(elapsedSeconds)}s`;
}

function formatUsageText(tokenUsage) {
  const last = tokenUsage?.last;
  if (!last || typeof last !== "object") {
    return "";
  }
  const input = Number(last.inputTokens || 0);
  const output = Number(last.outputTokens || 0);
  if (!input && !output) {
    return "";
  }
  return `↑ ${formatCompactTokens(input)} · ↓ ${formatCompactTokens(output)}`;
}

function formatContextText(tokenUsage) {
  const last = tokenUsage?.last;
  const used = Number(last?.totalTokens || 0);
  const window = Number(tokenUsage?.modelContextWindow || 0);
  if (!used || !window) {
    return "";
  }
  const pct = Math.max(0, Math.min(100, Math.round((used / window) * 100)));
  const advisory = used >= 90000
    ? " · 建议开新线程"
    : used >= 60000
      ? " · 上下文偏重"
      : "";
  return `上下文 ${formatCompactTokens(used)}/${formatCompactTokens(window)} (${pct}%)${advisory}`;
}

function formatToolCountText(toolItems) {
  const count = toolItems instanceof Set ? toolItems.size : 0;
  return `API ${count} 次`;
}

function formatToolTraceText(toolTrace, state) {
  const steps = Array.isArray(toolTrace) ? toolTrace.filter(Boolean) : [];
  if (!steps.length) {
    if (state === "failed") {
      return "这轮在正式收口前断掉了，工具步骤没完整留住。";
    }
    if (state === "completed") {
      return "这轮没有额外工具调用，主要是直接整理回复。";
    }
    return "这轮还没走到明确的工具步骤。";
  }
  return clipLines(steps.map((step) => `● ${step}`).join("\n"), 2);
}

function formatThinkingText({
  state,
  elapsed,
  reasoningTrace,
  tokenUsage,
  assistantNotes = "",
}) {
  const reasoningSteps = normalizeReasoningTrace(reasoningTrace);
  const reasoningTokens = Number(tokenUsage?.last?.reasoningOutputTokens || 0);
  const publicNotes = typeof assistantNotes === "string" ? assistantNotes.trim() : "";
  const sections = [];

  if (reasoningSteps.length) {
    sections.push(`**模型公开推理摘要**\n${reasoningSteps.map((step, index) => (
      `${index + 1}. ${step}`
    )).join("\n")}`);
  } else if (publicNotes) {
    sections.push(`**已公开的过程说明**\n${publicNotes}`);
  } else {
    sections.push("**启动判断**\n- 已接收任务，先确认目标、范围和约束。");
  }

  if (state === "streaming") {
    sections.push("**当前动作**\n- 正在拆解任务并选择下一步验证方式。");
  }

  if (state === "failed") {
    sections.push(elapsed
      ? `**中断状态**\n- 本轮在约 ${elapsed} 时中断，已保留上面的公开过程。`
      : "**中断状态**\n- 本轮中途断开，已保留上面的公开过程。");
    return sections.join("\n\n");
  }

  if (state === "completed") {
    sections.push(elapsed
      ? `**收口判断**\n- 已完成，耗时约 ${elapsed}；最终结论见下方正文。`
      : "**收口判断**\n- 已完成；最终结论见下方正文。");
  } else {
    sections.push(elapsed
      ? `**当前状态**\n- 仍在处理，已运行约 ${elapsed}。`
      : "**当前状态**\n- 正在处理。");
  }

  if (reasoningTokens > 0) {
    sections.push(`**思考量**\n- 本轮已使用约 ${formatCompactTokens(reasoningTokens)} 个推理 token。`);
  }

  return sections.join("\n\n");
}

function clipLines(text, maxLines) {
  const lines = String(text || "").split("\n");
  if (lines.length <= maxLines) {
    return text;
  }
  return `${lines.slice(0, maxLines).join("\n")}\n…`;
}

function normalizeReasoningTrace(trace) {
  if (!Array.isArray(trace)) {
    return [];
  }
  return trace
    .map((entry) => String(entry?.summary || "").trim())
    .filter(Boolean)
    .slice(-4);
}

function formatCardKitThinkingMarkdown(text) {
  const formatted = formatCardKitAssistantMarkdown(text);
  if (Buffer.byteLength(formatted, "utf8") <= 8000) {
    return formatted;
  }
  const clipped = formatted.slice(0, 3600).trim();
  return `${clipped}\n\n_思考面板内容较长，已截断显示。_`;
}

function formatCompactTokens(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) {
    return "0";
  }
  if (n >= 1000000) {
    return `${(n / 1000000).toFixed(1)}m`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return `${Math.round(n)}`;
}


module.exports = {
  addPendingReaction,
  buildCardKitFooter,
  buildCardKitFinalCard,
  buildLegacyReplyCard,
  clearPendingReactionForBinding,
  clearPendingReactionForThread,
  disposeReplyRunState,
  flushAssistantReplyCardNow,
  handleCardAction,
  isAllowedCardOperator,
  movePendingReactionToThread,
  openCardKitCircuit,
  patchInteractiveCard,
  queueCardActionWithFeedback,
  resolveReplyCardModel,
  resolveReplyCardEffort,
  runCardActionTask,
  sendCardActionFeedback,
  sendCardActionFeedbackByContext,
  sendInfoCardMessage,
  sendInteractiveApprovalCard,
  sendInteractiveCard,
  shouldUseCardKitReply,
  updateInteractiveCard,
  upsertAssistantReplyCard,
};
