const messageNormalizers = require("../presentation/message/normalizers");
const eventsRuntime = require("./codex-event-service");
const attachmentRuntime = require("../domain/attachments/attachment-service");
const groupService = require("../domain/group/group-service");
const { formatFailureText } = require("../shared/error-text");

async function onFeishuTextEvent(runtime, event) {
  let normalized = messageNormalizers.normalizeFeishuTextEvent(event, runtime.config);
  if (!normalized) {
    return;
  }
  if (normalized.chatType && normalized.chatId) {
    runtime.setChatType(normalized.chatId, normalized.chatType);
  }
  if (normalized.chatType === "group") {
    const groupResult = await applyGroupMentionPolicy(runtime, normalized);
    if (!groupResult) {
      return;
    }
    normalized = groupResult;
  }
  if (normalized.command === "unsupported_message") {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildUnsupportedMessageText(normalized.unsupportedMessageType),
    });
    return;
  }

  const hasAttachmentPayload = normalized.command === "image_message"
    || normalized.command === "attachment_message"
    || (Array.isArray(normalized.attachments) && normalized.attachments.length > 0);
  if (!hasAttachmentPayload && await runtime.dispatchTextCommand(normalized)) {
    return;
  }

  const workspaceContext = await runtime.resolveWorkspaceContext(normalized, {
    replyToMessageId: normalized.messageId,
    missingWorkspaceText: "",
  });
  if (!workspaceContext) {
    await runtime.sendWelcomeCard(runtime, normalized, {
      replyToMessageId: normalized.messageId,
    });
    return;
  }
  const { bindingKey, workspaceRoot } = workspaceContext;
  const isImageMessage = normalized.command === "image_message"
    || (Array.isArray(normalized.attachments)
      && normalized.attachments.some((attachment) => attachment?.kind === "image"));
  if (hasAttachmentPayload) {
    const codexParams = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot) || {};
    const activeModel = String(codexParams.model || runtime.config.defaultCodexModel || "").trim();
    const isTextOnlyModel = attachmentRuntime.isTextOnlyImageModel(
      activeModel,
      runtime.config.textOnlyImageModelPatterns
    );
    const imageMode = isImageMessage && isTextOnlyModel ? "path" : "native";
    normalized = await attachmentRuntime.prepareAttachmentMessage(runtime, normalized, {
      workspaceRoot,
      expectedKind: isImageMessage ? "image" : "",
      imageMode,
    });
    if (!normalized) {
      return;
    }
  }
  const { threadId } = await runtime.resolveWorkspaceThreadState({
    bindingKey,
    workspaceRoot,
    normalized,
    autoSelectThread: true,
  });

  if (threadId && runtime.activeTurnIdByThreadId.has(threadId)) {
    if (runtime.pendingApprovalByThreadId.has(threadId)) {
      const prompted = await runtime.sendApprovalPrompt({
        threadId,
        normalized,
        reason: "blocked-message",
      });
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: prompted
          ? "上一条还在等授权。我已经把授权卡重新发出来了；也可以直接发 `/approve` 或 `/reject`。"
          : "上一条还在等授权。可以直接发 `/approve` 允许本次请求，或发 `/reject` 拒绝。",
        kind: "approval",
      });
      return;
    }
    if (String(runtime.activeTurnIdByThreadId.get(threadId) || "").startsWith("custom-turn-")) {
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "自定义模型正在回答中，请等待完成后再发新消息。",
      });
      return;
    }
    if (runtime.config.activeTurnFollowUpMode === "steer") {
      await steerActiveTurn(runtime, { threadId, normalized });
      return;
    }
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前线程还有任务在运行。请先等待完成，或发送 `/stop` 中断后再发新消息。",
    });
    return;
  }

  runtime.setPendingBindingContext(bindingKey, normalized);
  if (threadId) {
    runtime.setPendingThreadContext(threadId, normalized);
  }

  await runtime.addPendingReaction(bindingKey, normalized.messageId);

  try {
    const resolvedThreadId = await runtime.ensureThreadAndSendMessage({
      bindingKey,
      workspaceRoot,
      normalized,
      threadId,
    });
    runtime.movePendingReactionToThread(bindingKey, resolvedThreadId);
  } catch (error) {
    await runtime.clearPendingReactionForBinding(bindingKey);
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: formatFailureText("处理失败", error),
    });
    throw error;
  }
}

/**
 * 群聊 @过滤：群聊里只有两种情况会继续处理——
 * 1. 消息是命令（/ 开头），直接放行；
 * 2. 消息 @ 了机器人，去掉 @机器人 前缀后再放行。
 * 其他普通群聊消息静默忽略，避免机器人在群里到处接话。
 */
async function applyGroupMentionPolicy(runtime, normalized) {
  const config = runtime.config || {};
  if (config.groupMentionOnly === false) {
    return normalized;
  }

  // 免@白名单：这些群聊不需要 @ 机器人也会响应
  const exemptChats = Array.isArray(config.groupMentionExemptChats)
    ? config.groupMentionExemptChats
    : [];
  if (exemptChats.includes(normalized.chatId)) {
    return normalized;
  }

  const rawText = String(normalized.text || "");
  const isCommand = /^\/[a-z]/i.test(rawText.trim());
  if (isCommand) {
    return normalized;
  }

  const botOpenId = await groupService.resolveBotOpenId(
    runtime,
    config.botOpenId || ""
  );
  if (!botOpenId) {
    console.warn("[codex-im] group mention policy: cannot resolve bot open_id, allowing message");
    return normalized;
  }

  const mentioned = groupService.isBotMentioned(normalized.mentions, botOpenId);
  if (!mentioned) {
    console.log(
      `[codex-im] group message ignored (bot not mentioned): chat=${normalized.chatId} text=${rawText.slice(0, 80)}`
    );
    return null;
  }

  const stripped = groupService.stripBotMention(rawText, normalized.mentions, botOpenId);
  if (!stripped) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "在的，你想让我做什么？直接说就行（例如 @我 帮我写个脚本）。",
    });
    return null;
  }
  normalized.text = stripped;
  normalized.command = messageNormalizers.parseCommand(stripped);
  return normalized;
}

async function steerActiveTurn(runtime, { threadId, normalized }) {
  const expectedTurnId = String(runtime.activeTurnIdByThreadId.get(threadId) || "").trim();
  if (!expectedTurnId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前任务刚好已经结束，这条引导没有送进去；请直接再发一次。",
      kind: "error",
    });
    return;
  }

  const queues = getTurnSteerQueues(runtime);
  const previous = queues.get(threadId) || Promise.resolve();
  const submission = previous
    .catch(() => undefined)
    .then(async () => {
      const activeTurnId = String(runtime.activeTurnIdByThreadId.get(threadId) || "").trim();
      if (activeTurnId !== expectedTurnId) {
        throw new Error("active turn changed before turn/steer was submitted");
      }
      return runtime.codex.steerTurn({
        threadId,
        expectedTurnId,
        text: normalized.text,
        attachments: normalized.attachments || [],
        clientUserMessageId: normalized.messageId,
      });
    });
  queues.set(threadId, submission);

  try {
    await submission;
  } catch (error) {
    console.warn(`[codex-im] turn/steer failed thread=${threadId}: ${error.message}`);
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildSteerFailureText(error),
      kind: "error",
    });
    return;
  } finally {
    if (queues.get(threadId) === submission) {
      queues.delete(threadId);
    }
  }

  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: "已把这条消息作为“引导”交给正在运行的任务，会按新要求调整，不会重开任务。",
    kind: "progress",
  });
}

function getTurnSteerQueues(runtime) {
  if (!(runtime.turnSteerQueueByThreadId instanceof Map)) {
    runtime.turnSteerQueueByThreadId = new Map();
  }
  return runtime.turnSteerQueueByThreadId;
}

function buildSteerFailureText(error) {
  const message = String(error?.message || "").toLowerCase();
  if (
    message.includes("expectedturnid")
    || message.includes("active turn changed")
    || message.includes("no active turn")
    || message.includes("turn is not active")
  ) {
    return "当前任务已先一步结束，这条引导没有送进去；请直接再发一次。";
  }
  if (
    message.includes("cannot accept same-turn steering")
    || message.includes("not steerable")
    || message.includes("manual /compact")
    || message.includes("/review")
  ) {
    return "这轮正处在不能中途引导的阶段，这条没有送进去；请等它收口，或发送 `/stop` 后重新发。";
  }
  return "引导发送失败，这条没有交给当前任务；请直接再发一次，或发送 `/stop` 后重试。";
}

function buildUnsupportedMessageText(messageType) {
  const typeLabel = String(messageType || "unknown");
  if (typeLabel === "image") {
    return [
      "我收到图片了，但飞书图片解析还没接上。",
      "",
      "现在这条桥只处理文字消息，所以图片不会进入 Codex。",
      "临时办法：先把图片里的重点用文字发给我，或者在桌面端直接给 Codex 发图。",
      "",
      "我已经把“图片消息不要静默丢弃”修了，下一步再接图片下载和多模态输入。",
    ].join("\n");
  }
  return [
    `我收到了非文本消息：\`${typeLabel}\`。`,
    "",
    "当前飞书桥暂时只处理文字消息；这类消息还不会进入 Codex。",
  ].join("\n");
}

async function onFeishuCardAction(runtime, data) {
  try {
    return await runtime.handleCardAction(data);
  } catch (error) {
    console.error(`[codex-im] failed to process card action: ${error.message}`);
    return runtime.buildCardToast(formatFailureText("处理失败", error));
  }
}

function onCodexMessage(runtime, message) {
  eventsRuntime.handleCodexMessage(runtime, message);
}

module.exports = {
  applyGroupMentionPolicy,
  onCodexMessage,
  onFeishuCardAction,
  onFeishuTextEvent,
  steerActiveTurn,
};
