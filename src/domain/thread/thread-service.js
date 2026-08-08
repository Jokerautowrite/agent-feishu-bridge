const { filterThreadsByWorkspaceRoot } = require("../../shared/workspace-paths");
const { extractSwitchThreadId } = require("../../shared/command-parsing");
const codexMessageUtils = require("../../infra/codex/message-utils");
const codexEvents = require("../../app/codex-event-service");
const customModelService = require("../custom-model/custom-model-service");
const directClient = require("../../infra/custom-model/direct-client");

const THREAD_SOURCE_KINDS = new Set([
  "app",
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
]);

const MAX_CUSTOM_HISTORY_MESSAGES = 20;
let customTurnSequence = 0;

async function resolveWorkspaceThreadState(runtime, {
  bindingKey,
  workspaceRoot,
  normalized,
  autoSelectThread = true,
}) {
  const threads = await refreshWorkspaceThreads(runtime, bindingKey, workspaceRoot, normalized);
  const selectedThreadId = runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot);
  const binding = runtime.sessionStore.getBinding(bindingKey) || {};
  const shouldAutoSelectThread = autoSelectThread && binding.threadScopedBinding !== true;
  const threadId = selectedThreadId || (shouldAutoSelectThread ? (threads[0]?.id || "") : "");
  if (!selectedThreadId && threadId) {
    runtime.sessionStore.setThreadIdForWorkspace(
      bindingKey,
      workspaceRoot,
      threadId,
      codexMessageUtils.buildBindingMetadata(normalized)
    );
  }
  if (threadId) {
    runtime.setThreadBindingKey(threadId, bindingKey);
    runtime.setThreadWorkspaceRoot(threadId, workspaceRoot);
  }
  return { threads, threadId, selectedThreadId };
}

async function ensureThreadAndSendMessage(runtime, { bindingKey, workspaceRoot, normalized, threadId }) {
  const codexParams = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  const customChannel = customModelService.getChannel(runtime, codexParams?.model);
  if (customChannel) {
    const localThreadId = await sendCustomModelReply(runtime, {
      bindingKey,
      workspaceRoot,
      normalized,
      channel: customChannel,
    });
    return localThreadId;
  }

  if (!threadId) {
    const createdThreadId = await getOrCreateWorkspaceThread(runtime, {
      bindingKey,
      workspaceRoot,
      normalized,
    });
    console.log(`[codex-im] turn/start first message thread=${createdThreadId}`);
    await runtime.codex.sendUserMessage({
      threadId: createdThreadId,
      text: buildMessageWithBridgeCapabilities(normalized),
      attachments: normalized.attachments || [],
      model: codexParams.model || null,
      effort: codexParams.effort || null,
      accessMode: runtime.config.defaultCodexAccessMode,
      workspaceRoot,
    });
    runtime.setThreadBindingKey(createdThreadId, bindingKey);
    runtime.setThreadWorkspaceRoot(createdThreadId, workspaceRoot);
    return createdThreadId;
  }

  try {
    await ensureThreadResumed(runtime, threadId);
    await runtime.codex.sendUserMessage({
      threadId,
      text: buildMessageWithBridgeCapabilities(normalized),
      attachments: normalized.attachments || [],
      model: codexParams.model || null,
      effort: codexParams.effort || null,
      accessMode: runtime.config.defaultCodexAccessMode,
      workspaceRoot,
    });
    console.log(`[codex-im] turn/start ok workspace=${workspaceRoot} thread=${threadId}`);
    runtime.setThreadBindingKey(threadId, bindingKey);
    runtime.setThreadWorkspaceRoot(threadId, workspaceRoot);
    return threadId;
  } catch (error) {
    if (!shouldRecreateThread(error)) {
      throw error;
    }

    console.warn(`[codex-im] stale thread detected, recreating workspace thread: ${threadId}`);
    runtime.resumedThreadIds.delete(threadId);
    runtime.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    const recreatedThreadId = await createWorkspaceThread(runtime, {
      bindingKey,
      workspaceRoot,
      normalized,
    });
    console.log(`[codex-im] turn/start retry thread=${recreatedThreadId}`);
    await runtime.codex.sendUserMessage({
      threadId: recreatedThreadId,
      text: buildMessageWithBridgeCapabilities(normalized),
      attachments: normalized.attachments || [],
      model: codexParams.model || null,
      effort: codexParams.effort || null,
      accessMode: runtime.config.defaultCodexAccessMode,
      workspaceRoot,
    });
    runtime.setThreadBindingKey(recreatedThreadId, bindingKey);
    runtime.setThreadWorkspaceRoot(recreatedThreadId, workspaceRoot);
    return recreatedThreadId;
  }
}

async function sendCustomModelReply(runtime, { bindingKey, workspaceRoot, normalized, channel }) {
  const localThreadId = buildCustomModelThreadId(workspaceRoot);
  runtime.setThreadBindingKey(localThreadId, bindingKey);
  runtime.setThreadWorkspaceRoot(localThreadId, workspaceRoot);
  runtime.setPendingThreadContext(localThreadId, normalized);

  const history = getOrCreateCustomHistory(runtime, localThreadId);
  const userText = buildGroupSenderIdentityForCustom(normalized, normalized.text);
  if (userText) {
    history.push({ role: "user", content: userText });
  }

  customTurnSequence += 1;
  const turnId = `custom-turn-${Date.now()}-${customTurnSequence}`;
  codexEvents.handleCodexMessage(runtime, {
    method: "turn/started",
    params: { threadId: localThreadId, turnId },
  });

  let fullText = "";
  const streamResult = await directClient.streamChatCompletion({
    baseUrl: channel.baseUrl,
    apiKey: channel.apiKey,
    model: channel.name,
    messages: history,
    onDelta: (delta) => {
      codexEvents.handleCodexMessage(runtime, {
        method: "item/agentMessage/delta",
        params: { threadId: localThreadId, turnId, delta },
      });
    },
  });

  fullText = streamResult.ok ? streamResult.text : String(streamResult.partialText || "");
  if (fullText) {
    codexEvents.handleCodexMessage(runtime, {
      method: "item/completed",
      params: {
        threadId: localThreadId,
        turnId,
        item: { type: "agentMessage", text: fullText },
      },
    });
  }

  if (!streamResult.ok) {
    codexEvents.handleCodexMessage(runtime, {
      method: "turn/failed",
      params: {
        threadId: localThreadId,
        turnId,
        error: { message: streamResult.error || "自定义模型请求失败。" },
      },
    });
    if (fullText) {
      history.push({ role: "assistant", content: fullText });
    }
    trimCustomHistory(runtime, localThreadId);
    return localThreadId;
  }

  codexEvents.handleCodexMessage(runtime, {
    method: "turn/completed",
    params: {
      threadId: localThreadId,
      turnId,
      turn: { status: "completed" },
    },
  });
  history.push({ role: "assistant", content: fullText });
  trimCustomHistory(runtime, localThreadId);
  return localThreadId;
}

function buildCustomModelThreadId(workspaceRoot) {
  return `custom-${encodeURIComponent(workspaceRoot || "default")}`;
}

function getOrCreateCustomHistory(runtime, localThreadId) {
  if (!runtime.customModelHistoryByThreadId.has(localThreadId)) {
    runtime.customModelHistoryByThreadId.set(localThreadId, []);
  }
  return runtime.customModelHistoryByThreadId.get(localThreadId);
}

function trimCustomHistory(runtime, localThreadId) {
  const history = runtime.customModelHistoryByThreadId.get(localThreadId);
  if (Array.isArray(history) && history.length > MAX_CUSTOM_HISTORY_MESSAGES) {
    runtime.customModelHistoryByThreadId.set(
      localThreadId,
      history.slice(history.length - MAX_CUSTOM_HISTORY_MESSAGES)
    );
  }
}

async function getOrCreateWorkspaceThread(runtime, { bindingKey, workspaceRoot, normalized }) {
  const lockKey = `${bindingKey}\n${workspaceRoot}`;
  const existingThreadId = runtime.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
  if (existingThreadId) {
    return existingThreadId;
  }

  const inFlight = runtime.threadCreationByBindingWorkspace?.get(lockKey);
  if (inFlight) {
    return inFlight;
  }

  const createPromise = createWorkspaceThread(runtime, {
    bindingKey,
    workspaceRoot,
    normalized,
  }).finally(() => {
    runtime.threadCreationByBindingWorkspace?.delete(lockKey);
  });

  runtime.threadCreationByBindingWorkspace?.set(lockKey, createPromise);
  return createPromise;
}

async function createWorkspaceThread(runtime, { bindingKey, workspaceRoot, normalized }) {
  const response = await runtime.codex.startThread({
    cwd: workspaceRoot,
  });
  console.log(`[codex-im] thread/start ok workspace=${workspaceRoot}`);

  const resolvedThreadId = codexMessageUtils.extractThreadId(response);
  if (!resolvedThreadId) {
    throw new Error("thread/start did not return a thread id");
  }

  runtime.sessionStore.setThreadIdForWorkspace(
    bindingKey,
    workspaceRoot,
    resolvedThreadId,
    codexMessageUtils.buildBindingMetadata(normalized)
  );
  runtime.resumedThreadIds.add(resolvedThreadId);
  runtime.setPendingThreadContext(resolvedThreadId, normalized);
  runtime.setThreadBindingKey(resolvedThreadId, bindingKey);
  runtime.setThreadWorkspaceRoot(resolvedThreadId, workspaceRoot);
  return resolvedThreadId;
}

async function ensureThreadResumed(runtime, threadId) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId || runtime.resumedThreadIds.has(normalizedThreadId)) {
    return null;
  }

  const response = await runtime.codex.resumeThread({ threadId: normalizedThreadId });
  runtime.resumedThreadIds.add(normalizedThreadId);
  console.log(`[codex-im] thread/resume ok thread=${normalizedThreadId}`);
  return response;
}

async function handleNewCommand(runtime, normalized) {
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前会话还未绑定项目。先发送 `/bind /绝对路径`。",
    });
    return;
  }

  try {
    const createdThreadId = await createWorkspaceThread(runtime, {
      bindingKey,
      workspaceRoot,
      normalized,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `已创建新线程并切换到它:\n${workspaceRoot}\n\nthread: ${createdThreadId}`,
    });
    await runtime.showStatusPanel(normalized, { replyToMessageId: normalized.messageId });
  } catch (error) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `创建新线程失败: ${error.message}`,
    });
  }
}

async function handleSwitchCommand(runtime, normalized) {
  const threadId = extractSwitchThreadId(normalized.text);
  if (!threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "用法: `/switch <threadId>`",
    });
    return;
  }

  await switchThreadById(runtime, normalized, threadId, { replyToMessageId: normalized.messageId });
}

async function refreshWorkspaceThreads(runtime, bindingKey, workspaceRoot, normalized) {
  try {
    const threads = await listCodexThreadsForWorkspace(runtime, workspaceRoot);
    const currentThreadId = runtime.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const shouldKeepCurrentThread = currentThreadId && runtime.resumedThreadIds.has(currentThreadId);
    if (currentThreadId && !shouldKeepCurrentThread && !threads.some((thread) => thread.id === currentThreadId)) {
      runtime.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    }
    return threads;
  } catch (error) {
    console.warn(`[codex-im] thread/list failed for workspace=${workspaceRoot}: ${error.message}`);
    return [];
  }
}

async function listCodexThreadsForWorkspace(runtime, workspaceRoot) {
  const allThreads = await listCodexThreadsPaginated(runtime);
  const sourceFiltered = allThreads.filter((thread) => isSupportedThreadSourceKind(thread?.sourceKind));
  return filterThreadsByWorkspaceRoot(sourceFiltered, workspaceRoot);
}

async function listCodexThreadsPaginated(runtime) {
  const allThreads = [];
  const seenThreadIds = new Set();
  let cursor = null;

  for (let page = 0; page < 10; page += 1) {
    const response = await runtime.codex.listThreads({
      cursor,
      limit: 200,
      sortKey: "updated_at",
    });
    const pageThreads = codexMessageUtils.extractThreadsFromListResponse(response);
    for (const thread of pageThreads) {
      if (seenThreadIds.has(thread.id)) {
        continue;
      }
      seenThreadIds.add(thread.id);
      allThreads.push(thread);
    }

    const nextCursor = codexMessageUtils.extractThreadListCursor(response);
    if (!nextCursor || nextCursor === cursor) {
      break;
    }
    cursor = nextCursor;
    if (pageThreads.length === 0) {
      break;
    }
  }

  return allThreads;
}

function describeWorkspaceStatus(runtime, threadId) {
  if (!threadId) {
    return { code: "idle", label: "空闲" };
  }
  if (runtime.pendingApprovalByThreadId.has(threadId)) {
    return { code: "approval", label: "等待授权" };
  }
  if (runtime.activeTurnIdByThreadId.has(threadId)) {
    return { code: "running", label: "运行中" };
  }
  return { code: "idle", label: "空闲" };
}

async function switchThreadById(runtime, normalized, threadId, { replyToMessageId } = {}) {
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "当前会话还未绑定项目。先发送 `/bind /绝对路径`。",
    });
    return;
  }

  const currentThreadId = runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot);
  if (currentThreadId && currentThreadId === threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "已经是当前线程，无需切换。",
    });
    return;
  }

  const availableThreads = await refreshWorkspaceThreads(runtime, bindingKey, workspaceRoot, normalized);
  const selectedThread = availableThreads.find((thread) => thread.id === threadId) || null;
  if (!selectedThread) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "指定线程当前不可用，请刷新后重试。",
    });
    return;
  }

  const resolvedWorkspaceRoot = selectedThread.cwd || workspaceRoot;
  runtime.sessionStore.setActiveWorkspaceRoot(bindingKey, resolvedWorkspaceRoot);
  runtime.sessionStore.setThreadIdForWorkspace(
    bindingKey,
    resolvedWorkspaceRoot,
    threadId,
    codexMessageUtils.buildBindingMetadata(normalized)
  );
  runtime.setThreadBindingKey(threadId, bindingKey);
  runtime.setThreadWorkspaceRoot(threadId, resolvedWorkspaceRoot);
  runtime.resumedThreadIds.delete(threadId);
  await ensureThreadResumed(runtime, threadId);
  await runtime.showStatusPanel(normalized, { replyToMessageId: replyTarget });
}

function isSupportedThreadSourceKind(sourceKind) {
  const normalized = typeof sourceKind === "string" && sourceKind.trim() ? sourceKind.trim() : "unknown";
  return THREAD_SOURCE_KINDS.has(normalized);
}

function shouldRecreateThread(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("thread not found") || message.includes("unknown thread");
}

function buildMessageWithBridgeCapabilities(normalized) {
  const text = String(normalized?.text || "");
  const isGroup = normalized?.chatType === "group";
  const senderName = String(normalized?.senderName || "").trim();
  const senderId = String(normalized?.senderId || "").trim();

  const identityBlock = isGroup
    ? buildGroupSenderIdentity(senderName, senderId)
    : "";
  const body = identityBlock
    ? `${identityBlock}${text}`
    : text;

  return [
    "<feishu-bridge-capabilities>",
    "[System note: This Feishu/Lark bridge can send current-workspace attachments back to Feishu. If the user asks you to send a local image, file, or audio, create or locate the file under the bound workspace, then include a hidden directive on its own line: [[codex-feishu-send:relative/path/from/workspace]]. The bridge will upload it. Supported routing: images as Feishu image messages, .opus/.mp4 as audio, other files as file messages. Do not use absolute paths in the directive; keep a short human explanation separately.]",
    "[System note: Replies are shown in Feishu CardKit. Prefer scan-friendly Markdown: short paragraphs, ordered/bulleted lists, Markdown tables for comparisons, and fenced code blocks for commands/snippets.]",
    "</feishu-bridge-capabilities>",
    "",
    body,
  ].join("\n");
}

/**
 * 群聊发送者身份前缀（防串台）。
 * 有名字用名字，没名字回退 open_id 后缀，让 Agent 至少能区分是谁发的。
 */
function buildGroupSenderIdentity(senderName, senderId) {
  const label = senderName || (senderId ? `用户${senderId.slice(-6)}` : "群成员");
  return `【群聊·${label}】`;
}

function buildGroupSenderIdentityForCustom(normalized, text) {
  if (normalized?.chatType !== "group") {
    return String(text || "");
  }
  const senderName = String(normalized?.senderName || "").trim();
  const senderId = String(normalized?.senderId || "").trim();
  const prefix = buildGroupSenderIdentity(senderName, senderId);
  return `${prefix}${String(text || "")}`;
}

module.exports = {
  createWorkspaceThread,
  describeWorkspaceStatus,
  ensureThreadAndSendMessage,
  ensureThreadResumed,
  handleNewCommand,
  handleSwitchCommand,
  refreshWorkspaceThreads,
  resolveWorkspaceThreadState,
  switchThreadById,
};
