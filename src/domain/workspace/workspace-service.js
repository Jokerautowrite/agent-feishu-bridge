const fs = require("fs");
const path = require("path");
const {
  isAbsoluteWorkspacePath,
  isWorkspaceAllowed,
  normalizeWorkspacePath,
  pathMatchesWorkspaceRoot,
  resolveRealPathWithinWorkspace,
} = require("../../shared/workspace-paths");
const {
  extractBindPath,
  extractEffortValue,
  extractModelValue,
  extractRemoveWorkspacePath,
  extractSendPath,
} = require("../../shared/command-parsing");
const {
  extractModelCatalogFromListResponse,
  findModelByQuery,
  normalizeText,
  resolveEffectiveModelForEffort,
} = require("../../shared/model-catalog");
const {
  classifyLocalAttachment,
  inferFeishuFileType,
} = require("../../shared/media-types");
const codexMessageUtils = require("../../infra/codex/message-utils");
const { formatFailureText } = require("../../shared/error-text");

const MAX_FEISHU_UPLOAD_FILE_BYTES = 30 * 1024 * 1024;
const MAX_FEISHU_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024;

function probeAudioDurationMs(filePath) {
  return new Promise((resolve) => {
    const { spawn } = require("child_process");
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const proc = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        String(filePath),
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    let out = "";
    proc.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    proc.on("error", () => finish(null));
    proc.on("close", () => {
      const seconds = Number((out || "").trim());
      finish(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null);
    });
    setTimeout(() => finish(null), 5000);
  });
}

async function resolveWorkspaceContext(
  runtime,
  normalized,
  {
    replyToMessageId = "",
    missingWorkspaceText = "当前会话还没有绑定项目。",
  } = {}
) {
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  if (!workspaceRoot) {
    // 群聊未绑定时 fallback 到群聊默认 workspace（chat-groups）。
    // 群聊不强制绑定业务项目：用统一的群聊工作区 + AGENTS.md 约束行为，
    // 避免在群里发绑定卡片（防刷屏、防他人抢占绑定）。
    if (normalized.chatType === "group") {
      const groupWorkspace = String(runtime.config?.groupDefaultWorkspace || "").trim();
      if (groupWorkspace && isWorkspaceAllowed(groupWorkspace, runtime.config.workspaceAllowlist)) {
        return { bindingKey, workspaceRoot: groupWorkspace, replyTarget };
      }
    }
    if (missingWorkspaceText) {
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: replyTarget,
        text: missingWorkspaceText,
      });
    }
    return null;
  }

  return { bindingKey, workspaceRoot, replyTarget };
}

async function handleBindCommand(runtime, normalized) {
  const bindingKey = runtime.sessionStore.buildChatBindingKey(normalized);
  const previousBinding = runtime.sessionStore.getBinding(bindingKey) || {};
  const isFirstBinding = !String(previousBinding.activeWorkspaceRoot || "").trim()
    && Object.keys(previousBinding.threadIdByWorkspaceRoot || {}).length === 0;
  const rawWorkspaceRoot = extractBindPath(normalized.text);
  if (!rawWorkspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "用法: `/bind /绝对路径`",
    });
    return;
  }

  const workspaceRoot = resolveBindWorkspacePath(runtime, rawWorkspaceRoot);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "无法解析项目路径。支持绝对路径，或填写 `AGENT_BRIDGE_PROJECTS_ROOT` 下的文件夹名。",
    });
    return;
  }
  if (!isAbsoluteWorkspacePath(workspaceRoot)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "只支持绝对路径绑定，或 `AGENT_BRIDGE_PROJECTS_ROOT` 下的文件夹名。",
    });
    return;
  }
  if (!isWorkspaceAllowed(workspaceRoot, runtime.config.workspaceAllowlist)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "该项目不在允许绑定的白名单中。",
    });
    return;
  }

  const workspaceStats = await runtime.resolveWorkspaceStats(workspaceRoot);
  if (!workspaceStats.exists) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `项目不存在: ${workspaceRoot}`,
    });
    return;
  }

  if (!workspaceStats.isDirectory) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `路径非法: ${workspaceRoot}`,
    });
    return;
  }

  applyDefaultCodexParamsOnBind(runtime, bindingKey, workspaceRoot);
  runtime.sessionStore.setActiveWorkspaceRoot(bindingKey, workspaceRoot);
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: [
      `已绑定项目：\n${workspaceRoot}`,
      "下一条普通消息会创建新线程并立即开始。",
      isFirstBinding
        ? "首次部署自检：若卡片按钮、群聊或附件不可用，请核对 README 顶部的“飞书应用必备配置”，并确认修改后已发布飞书应用新版本。"
        : "",
    ].filter(Boolean).join("\n\n"),
  });
}

function resolveBindWorkspacePath(runtime, rawWorkspaceRoot) {
  const raw = String(rawWorkspaceRoot || "").trim();
  if (!raw) {
    return "";
  }
  const normalized = normalizeWorkspacePath(raw);
  if (isAbsoluteWorkspacePath(normalized)) {
    return normalized;
  }
  // 相对输入：拼到默认项目根目录
  const projectsRoot = normalizeWorkspacePath(
    runtime.config?.defaultProjectsRoot || ""
  );
  if (!projectsRoot || raw.includes("/") || raw.includes("\\")) {
    return "";
  }
  return normalizeWorkspacePath(`${projectsRoot}/${raw}`);
}

async function bindWorkspaceFromForm(runtime, normalized, projectName) {
  // 群聊里只有管理员能绑定/改绑（防止群里其他人抢占绑定）
  if (normalized.chatType === "group") {
    const senderId = String(normalized.senderId || "").trim();
    const isAdmin = (
      runtime.groupAdmins && runtime.groupAdmins.isAdmin(normalized.chatId, senderId)
    ) || (
      Array.isArray(runtime.config?.adminOpenIds)
      && runtime.config.adminOpenIds.includes(senderId)
    );
    if (!isAdmin) {
      console.log(`[codex-im] group bind rejected (not admin): chat=${normalized.chatId} sender=${senderId.slice(0, 8)}...`);
      return; // 静默，不给任何提示
    }
  }

  const rawWorkspaceRoot = String(projectName || "").trim();
  if (!rawWorkspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "请填写要绑定的文件夹名。",
    });
    return;
  }

  const bindingKey = runtime.sessionStore.buildChatBindingKey(normalized);
  const currentWorkspaceRoot = runtime.resolveWorkspaceRootForBinding(bindingKey);
  const workspaceRoot = resolveBindWorkspacePath(runtime, rawWorkspaceRoot);
  if (!workspaceRoot || !isAbsoluteWorkspacePath(workspaceRoot)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "无法解析项目路径。请填写 `AGENT_BRIDGE_PROJECTS_ROOT` 下的文件夹名，或绝对路径。",
    });
    return;
  }

  if (currentWorkspaceRoot && currentWorkspaceRoot === workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "该项目已绑定，无需重复操作。",
    });
    return;
  }
  if (!isWorkspaceAllowed(workspaceRoot, runtime.config.workspaceAllowlist)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "该项目不在允许绑定的白名单中。",
    });
    return;
  }

  const workspaceStats = await runtime.resolveWorkspaceStats(workspaceRoot);
  if (!workspaceStats.exists) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `项目不存在: ${workspaceRoot}`,
    });
    return;
  }
  if (!workspaceStats.isDirectory) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `路径非法: ${workspaceRoot}`,
    });
    return;
  }

  applyDefaultCodexParamsOnBind(runtime, bindingKey, workspaceRoot);
  runtime.sessionStore.setActiveWorkspaceRoot(bindingKey, workspaceRoot);
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: `已绑定项目：\n${workspaceRoot}\n\n下一条普通消息会创建新线程并立即开始。`,
  });
}

async function handleWhereCommand(runtime, normalized) {
  await showStatusPanel(runtime, normalized);
}

async function showStatusPanel(runtime, normalized, { replyToMessageId, noticeText = "" } = {}) {
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  if (!workspaceRoot) {
    await sendWelcomeCard(runtime, normalized, { replyToMessageId: replyTarget });
    return;
  }

  const { threads, threadId } = await runtime.resolveWorkspaceThreadState({
    bindingKey,
    workspaceRoot,
    normalized,
    autoSelectThread: true,
  });
  const currentThread = threads.find((thread) => thread.id === threadId) || null;
  const recentThreads = currentThread
    ? threads.filter((thread) => thread.id !== threadId).slice(0, 2)
    : threads.slice(0, 3);
  const status = runtime.describeWorkspaceStatus(threadId);
  const codexParams = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  const availableCatalog = runtime.sessionStore.getAvailableModelCatalog();
  const availableModels = Array.isArray(availableCatalog?.models) ? availableCatalog.models : [];
  const modelOptions = buildModelSelectOptions(availableModels);
  const effortOptions = buildEffortSelectOptions(availableModels, codexParams?.model || "");
  const quickCommandOptions = [
    { label: "📖 /help 帮助", value: "/help" },
    { label: "🗑️ 清空上下文", value: "/clear" },
    { label: "🔁 切换项目", value: "/switch_project" },
  ];
  await runtime.sendInteractiveCard({
    chatId: normalized.chatId,
    replyToMessageId: replyTarget,
    card: runtime.buildStatusPanelCard({
      workspaceRoot,
      codexParams,
      modelOptions,
      effortOptions,
      threadId,
      currentThread,
      recentThreads,
      totalThreadCount: threads.length,
      status,
      noticeText,
      backend: process.env.AGENT_BRIDGE_BACKEND || "",
      quickCommandOptions,
    }),
  });
}

async function sendWelcomeCard(runtime, normalized, { replyToMessageId = "" } = {}) {
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  const projectsRoot = normalizeWorkspacePath(
    runtime.config?.defaultProjectsRoot || ""
  ) || "~/projects";
  try {
    await runtime.sendInteractiveCard({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      card: runtime.buildWelcomeCard({
        backend: process.env.AGENT_BRIDGE_BACKEND || "",
        projectsRoot,
      }),
    });
  } catch (error) {
    console.error(`[codex-im] welcome card failed; using text fallback: ${error.message}`);
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: `尚未绑定项目。请发送：\n/bind ${projectsRoot}/项目文件夹\n\n首次部署者若收不到卡片或按钮无响应，请核对 README 顶部的“飞书应用必备配置”。`,
    });
  }
}

async function handleMessageCommand(runtime, normalized) {
  const workspaceContext = await resolveWorkspaceContext(runtime, normalized, {
    replyToMessageId: normalized.messageId,
  });
  if (!workspaceContext) {
    return;
  }
  const { bindingKey, workspaceRoot } = workspaceContext;

  const { threads, threadId } = await runtime.resolveWorkspaceThreadState({
    bindingKey,
    workspaceRoot,
    normalized,
    autoSelectThread: true,
  });

  if (!threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `当前项目：\`${workspaceRoot}\`\n\n该项目还没有可查看的线程消息。`,
    });
    return;
  }

  const currentThread = threads.find((thread) => thread.id === threadId) || { id: threadId };
  runtime.resumedThreadIds.delete(threadId);
  const resumeResponse = await runtime.ensureThreadResumed(threadId);
  const recentMessages = codexMessageUtils.extractRecentConversationFromResumeResponse(resumeResponse);

  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: runtime.buildThreadMessagesSummary({
      workspaceRoot,
      thread: currentThread,
      recentMessages,
    }),
  });
}

async function handleHelpCommand(runtime, normalized) {
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: runtime.buildHelpCardText(),
  });
}

async function handleUnknownCommand(runtime, normalized) {
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: "无效的 Codex 命令。\n\n可使用 `/help` 查看命令教程。",
  });
}

async function handleSendCommand(runtime, normalized) {
  const workspaceContext = await resolveWorkspaceContext(runtime, normalized, {
    replyToMessageId: normalized.messageId,
  });
  if (!workspaceContext) {
    return;
  }
  const { workspaceRoot } = workspaceContext;

  const requestedPath = extractSendPath(normalized.text);
  if (!requestedPath) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "用法: `/send <当前项目下的相对文件路径>`",
    });
    return;
  }

  const resolvedTarget = await resolveWorkspaceSendTarget(workspaceRoot, requestedPath);
  if (resolvedTarget.errorText) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: resolvedTarget.errorText,
    });
    return;
  }

  let fileStats;
  try {
    fileStats = await fs.promises.stat(resolvedTarget.filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `文件不存在: ${resolvedTarget.displayPath}`,
      });
      return;
    }
    throw error;
  }

  if (!fileStats.isFile()) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `只支持发送文件，不支持目录: ${resolvedTarget.displayPath}`,
    });
    return;
  }

  if (fileStats.size <= 0) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `文件为空，无法发送: ${resolvedTarget.displayPath}`,
    });
    return;
  }

  const attachmentKind = classifyLocalAttachment(resolvedTarget.filePath);
  const maxUploadBytes = attachmentKind === "image"
    ? MAX_FEISHU_UPLOAD_IMAGE_BYTES
    : MAX_FEISHU_UPLOAD_FILE_BYTES;
  const uploadLimitLabel = attachmentKind === "image" ? "10MB" : "30MB";
  if (fileStats.size > maxUploadBytes) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `文件过大，飞书当前只支持发送 ${uploadLimitLabel} 以内${attachmentKind === "image" ? "图片" : "文件"}: ${resolvedTarget.displayPath}`,
    });
    return;
  }

  try {
    const fileBuffer = await fs.promises.readFile(resolvedTarget.filePath);
    const fileType = inferFeishuFileType(resolvedTarget.filePath);
    const isAudio = attachmentKind === "audio";
    const duration = isAudio ? await probeAudioDurationMs(resolvedTarget.filePath) : null;
    await runtime.sendLocalAttachmentToFeishu({
      kind: attachmentKind,
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      fileName: path.basename(resolvedTarget.filePath),
      fileBuffer,
      fileType,
      msgType: isAudio ? "audio" : "file",
      duration,
    });
    console.log(`[codex-im] attachment/send ok kind=${attachmentKind} durationMs=${duration || "-"} workspace=${workspaceRoot} path=${resolvedTarget.displayPath}`);
  } catch (error) {
    console.warn(
      `[codex-im] attachment/send failed workspace=${workspaceRoot} path=${resolvedTarget.displayPath}: ${error.message}`
    );
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: formatFailureText("发送附件失败", error),
    });
  }
}

async function handleModelCommand(runtime, normalized) {
  const workspaceContext = await resolveCodexSettingWorkspaceContext(runtime, normalized);
  if (!workspaceContext) {
    return;
  }
  const { bindingKey, workspaceRoot } = workspaceContext;

  const rawModel = extractModelValue(normalized.text);
  if (!rawModel) {
    const current = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
    const availableModelsResult = await loadAvailableModels(runtime, {
      forceRefresh: false,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: runtime.buildModelInfoText(workspaceRoot, current, availableModelsResult),
    });
    return;
  }

  const modelUpdateDirective = parseUpdateDirective(rawModel);
  if (modelUpdateDirective) {
    const availableModelsResult = await loadAvailableModels(runtime, {
      forceRefresh: true,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: runtime.buildModelListText(workspaceRoot, availableModelsResult, {
        refreshed: true,
      }),
    });
    return;
  }

  const availableModelsResult = await loadAvailableModelsForSetting(runtime, normalized, {
    settingType: "model",
  });
  if (!availableModelsResult) {
    return;
  }

  const resolvedModel = resolveRequestedModel(availableModelsResult.models, rawModel);
  if (!resolvedModel) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: runtime.buildModelValidationErrorText(workspaceRoot, rawModel, availableModelsResult.models),
    });
    return;
  }

  const current = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  runtime.sessionStore.setCodexParamsForWorkspace(bindingKey, workspaceRoot, {
    model: resolvedModel,
    effort: current.effort || "",
  });
  await runtime.showStatusPanel(normalized, {
    replyToMessageId: normalized.messageId,
    noticeText: `已设置模型：${resolvedModel}`,
  });
}

async function handleEffortCommand(runtime, normalized) {
  const workspaceContext = await resolveCodexSettingWorkspaceContext(runtime, normalized);
  if (!workspaceContext) {
    return;
  }
  const { bindingKey, workspaceRoot } = workspaceContext;

  const rawEffort = extractEffortValue(normalized.text);
  if (!rawEffort) {
    const current = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
    const availableModelsResult = await loadAvailableModels(runtime, {
      forceRefresh: false,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: runtime.buildEffortInfoText(workspaceRoot, current, availableModelsResult),
    });
    return;
  }

  const availableModelsResult = await loadAvailableModelsForSetting(runtime, normalized, {
    settingType: "effort",
  });
  if (!availableModelsResult) {
    return;
  }

  const current = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  const effectiveModel = resolveEffectiveModelForEffort(availableModelsResult.models, current.model);
  if (!effectiveModel) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前无法确定模型，请先执行 `/model` 并设置模型后再设置推理强度。",
    });
    return;
  }

  const resolvedEffort = resolveRequestedEffort(effectiveModel, rawEffort);
  if (!resolvedEffort) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: runtime.buildEffortValidationErrorText(workspaceRoot, effectiveModel, rawEffort),
    });
    return;
  }

  runtime.sessionStore.setCodexParamsForWorkspace(bindingKey, workspaceRoot, {
    model: current.model || "",
    effort: resolvedEffort,
  });
  await runtime.showStatusPanel(normalized, {
    replyToMessageId: normalized.messageId,
    noticeText: `已设置推理强度：${resolvedEffort}`,
  });
}

async function handleWorkspacesCommand(runtime, normalized, { replyToMessageId } = {}) {
  const bindingKey = runtime.sessionStore.buildBindingKey(normalized);
  const binding = runtime.sessionStore.getBinding(bindingKey) || {};
  const items = runtime.listBoundWorkspaces(binding);
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  if (!items.length) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "当前会话还没有已绑定项目。先发送 `/bind /绝对路径`。",
    });
    return;
  }

  await runtime.sendInteractiveCard({
    chatId: normalized.chatId,
    replyToMessageId: replyTarget,
    card: runtime.buildWorkspaceBindingsCard(items),
  });
}

async function showThreadPicker(runtime, normalized, { replyToMessageId } = {}) {
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

  const threads = await runtime.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
  const currentThreadId = runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot) || threads[0]?.id || "";
  if (!threads.length) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: `当前项目：\`${workspaceRoot}\`\n\n还没有可切换的历史线程。`,
    });
    return;
  }

  await runtime.sendInteractiveCard({
    chatId: normalized.chatId,
    replyToMessageId: replyTarget,
    card: runtime.buildThreadPickerCard({
      workspaceRoot,
      threads,
      currentThreadId,
    }),
  });
}

async function handleRemoveCommand(runtime, normalized) {
  const workspaceRoot = extractRemoveWorkspacePath(normalized.text);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "用法: `/remove /绝对路径`",
    });
    return;
  }

  if (!isAbsoluteWorkspacePath(workspaceRoot)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "路径必须是绝对路径。",
    });
    return;
  }

  await removeWorkspaceByPath(runtime, normalized, workspaceRoot, {
    replyToMessageId: normalized.messageId,
  });
}

async function switchWorkspaceByPath(runtime, normalized, workspaceRoot, { replyToMessageId } = {}) {
  const targetWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
  if (!targetWorkspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "目标项目无效，请刷新后重试。",
    });
    return;
  }

  const { bindingKey } = runtime.getBindingContext(normalized);
  const currentWorkspaceRoot = runtime.resolveWorkspaceRootForBinding(bindingKey);
  if (currentWorkspaceRoot && currentWorkspaceRoot === targetWorkspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "已经是当前项目，无需切换。",
    });
    return;
  }

  const binding = runtime.sessionStore.getBinding(bindingKey) || {};
  const items = runtime.listBoundWorkspaces(binding);
  if (!items.some((item) => item.workspaceRoot === targetWorkspaceRoot)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "该项目未绑定到当前会话，请先执行 `/bind /绝对路径`。",
    });
    return;
  }

  runtime.sessionStore.setActiveWorkspaceRoot(bindingKey, targetWorkspaceRoot);
  await runtime.resolveWorkspaceThreadState({
    bindingKey,
    workspaceRoot: targetWorkspaceRoot,
    normalized,
    autoSelectThread: true,
  });

  await handleWorkspacesCommand(runtime, normalized, {
    replyToMessageId: replyToMessageId || normalized.messageId,
  });
}

async function removeWorkspaceByPath(runtime, normalized, workspaceRoot, { replyToMessageId } = {}) {
  const targetWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
  if (!targetWorkspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "目标项目无效，请刷新后重试。",
    });
    return;
  }

  const { bindingKey } = runtime.getBindingContext(normalized);
  const currentWorkspaceRoot = runtime.resolveWorkspaceRootForBinding(bindingKey);
  if (currentWorkspaceRoot && currentWorkspaceRoot === targetWorkspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "当前项目不支持移除，请先切换到其他项目。",
    });
    return;
  }

  const binding = runtime.sessionStore.getBinding(bindingKey) || {};
  const items = runtime.listBoundWorkspaces(binding);
  if (!items.some((item) => item.workspaceRoot === targetWorkspaceRoot)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "该项目未绑定到当前会话，无需移除。",
    });
    return;
  }

  runtime.sessionStore.removeWorkspace(bindingKey, targetWorkspaceRoot);
  await handleWorkspacesCommand(runtime, normalized, {
    replyToMessageId: replyToMessageId || normalized.messageId,
  });
}

module.exports = {
  bindWorkspaceFromForm,
  handleBindCommand,
  handleEffortCommand,
  handleHelpCommand,
  handleMessageCommand,
  handleModelCommand,
  handleRemoveCommand,
  handleSendCommand,
  handleUnknownCommand,
  handleWhereCommand,
  handleWorkspacesCommand,
  removeWorkspaceByPath,
  sendWelcomeCard,
  resolveWorkspaceContext,
  showStatusPanel,
  showThreadPicker,
  switchWorkspaceByPath,
  validateDefaultCodexParamsConfig,
};

async function resolveWorkspaceSendTarget(workspaceRoot, requestedPath) {
  const normalizedInput = normalizeWorkspacePath(requestedPath);
  if (!normalizedInput) {
    return { errorText: "用法: `/send <当前项目下的相对文件路径>`" };
  }
  if (isAbsoluteWorkspacePath(normalizedInput)) {
    return { errorText: "只支持当前项目下的相对路径，不支持绝对路径。" };
  }

  const candidatePath = path.resolve(workspaceRoot, requestedPath);
  const normalizedResolvedPath = normalizeWorkspacePath(candidatePath);
  if (!pathMatchesWorkspaceRoot(normalizedResolvedPath, workspaceRoot)) {
    return { errorText: "文件路径超出了当前项目根目录。" };
  }

  let filePath;
  try {
    filePath = await resolveRealPathWithinWorkspace(workspaceRoot, candidatePath);
  } catch (error) {
    if (error?.code === "ERR_WORKSPACE_PATH_ESCAPE") {
      return { errorText: "文件路径最终指向当前项目目录之外，已拒绝发送。" };
    }
    if (error?.code === "ENOENT") {
      return {
        filePath: candidatePath,
        displayPath: normalizeWorkspacePath(path.relative(workspaceRoot, candidatePath)) || path.basename(candidatePath),
      };
    }
    throw error;
  }

  return {
    filePath,
    displayPath: normalizeWorkspacePath(path.relative(workspaceRoot, candidatePath)) || path.basename(candidatePath),
  };
}

function parseUpdateDirective(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized === "update") {
    return { forceRefresh: true };
  }
  return null;
}

function applyDefaultCodexParamsOnBind(runtime, bindingKey, workspaceRoot) {
  const current = runtime.sessionStore.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  if (current.model || current.effort) {
    return;
  }

  const availableCatalog = runtime.sessionStore.getAvailableModelCatalog();
  const availableModels = Array.isArray(availableCatalog?.models) ? availableCatalog.models : [];
  const validatedDefaults = validateDefaultCodexParamsConfig(runtime, availableModels);
  const defaultModel = validatedDefaults.model;
  const defaultEffort = validatedDefaults.effort;
  if (!defaultModel && !defaultEffort) {
    return;
  }

  runtime.sessionStore.setCodexParamsForWorkspace(bindingKey, workspaceRoot, {
    model: defaultModel,
    effort: defaultEffort,
  });
}

function validateDefaultCodexParamsConfig(runtime, modelsInput) {
  const models = Array.isArray(modelsInput) ? modelsInput : [];
  const rawModel = normalizeText(runtime.config.defaultCodexModel);
  const rawEffort = normalizeEffort(runtime.config.defaultCodexEffort);
  const result = { model: "", effort: "" };
  if (!rawModel && !rawEffort) {
    return result;
  }
  if (!models.length) {
    return result;
  }

  if (rawModel) {
    result.model = resolveRequestedModel(models, rawModel);
  }

  if (rawEffort) {
    const effectiveModel = resolveEffectiveModelForEffort(models, result.model || rawModel);
    if (effectiveModel) {
      result.effort = resolveRequestedEffort(effectiveModel, rawEffort);
    }
  }

  return result;
}

async function resolveCodexSettingWorkspaceContext(runtime, normalized) {
  return resolveWorkspaceContext(runtime, normalized, {
    replyToMessageId: normalized.messageId,
    missingWorkspaceText: "当前会话还未绑定项目。先发送 `/bind /绝对路径`。",
  });
}

function normalizeEffort(value) {
  return String(value || "").trim().toLowerCase();
}

async function loadAvailableModelsForSetting(runtime, normalized, { settingType }) {
  const availableModelsResult = await loadAvailableModels(runtime, {
    forceRefresh: false,
  });
  if (!availableModelsResult.error) {
    return availableModelsResult;
  }
  const isEffort = settingType === "effort";
  const actionLabel = isEffort ? "推理强度" : "模型";
  const listCommand = isEffort ? "/effort" : "/model";
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: [
      `无法设置${actionLabel}：${availableModelsResult.error}`,
      "",
      `请先执行 \`${listCommand}\`，确认可用${actionLabel}后重试。`,
    ].join("\n"),
  });
  return null;
}

async function loadAvailableModels(runtime, { forceRefresh = false } = {}) {
  const cached = runtime.sessionStore.getAvailableModelCatalog();
  if (!forceRefresh && cached?.models?.length) {
    return {
      models: cached.models,
      error: "",
      source: "cache",
      updatedAt: cached.updatedAt || "",
    };
  }

  try {
    const response = await runtime.codex.listModels();
    const models = extractModelCatalogFromListResponse(response);
    if (!models.length) {
      if (cached?.models?.length) {
        return {
          models: cached.models,
          error: "",
          source: "cache",
          updatedAt: cached.updatedAt || "",
          warning: "Codex 未返回模型列表，已回退本地缓存。",
        };
      }
      return {
        models: [],
        error: "Codex 未返回可用模型列表。",
        source: forceRefresh ? "refresh" : "live",
        updatedAt: "",
      };
    }
    const saved = runtime.sessionStore.setAvailableModelCatalog(models);
    return {
      models,
      error: "",
      source: forceRefresh ? "refresh" : "live",
      updatedAt: saved?.updatedAt || new Date().toISOString(),
    };
  } catch (error) {
    if (cached?.models?.length) {
      return {
        models: cached.models,
        error: "",
        source: "cache",
        updatedAt: cached.updatedAt || "",
        warning: `拉取失败，已回退本地缓存：${error?.message || "未知错误"}`,
      };
    }
    return {
      models: [],
      error: error?.message || "获取模型列表失败。",
      source: forceRefresh ? "refresh" : "live",
      updatedAt: "",
    };
  }
}

function resolveRequestedModel(models, rawInput) {
  const matched = findModelByQuery(models, rawInput);
  return matched?.model || matched?.id || "";
}

function resolveRequestedEffort(modelEntry, rawEffort) {
  if (!modelEntry) {
    return "";
  }
  const query = normalizeEffort(rawEffort);
  if (!query) {
    return "";
  }
  const availableEfforts = listModelEfforts(modelEntry, { withDefaultFallback: true });
  for (const effort of availableEfforts) {
    if (normalizeEffort(effort) === query) {
      return effort;
    }
  }
  return "";
}

function buildModelSelectOptions(models) {
  if (!Array.isArray(models) || !models.length) {
    return [];
  }
  return models
    .map((item) => normalizeText(item?.model))
    .filter(Boolean)
    .slice(0, 100)
    .map((model) => ({
      label: model,
      value: model,
    }));
}

function buildEffortSelectOptions(models, currentModel) {
  const effectiveModel = resolveEffectiveModelForEffort(models, currentModel);
  if (!effectiveModel) {
    return [];
  }
  const supported = listModelEfforts(effectiveModel, { withDefaultFallback: true });
  const options = [];
  const seen = new Set();
  for (const effort of supported) {
    const normalized = normalizeText(effort);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    options.push({
      label: normalized,
      value: normalized,
    });
  }
  return options.slice(0, 20);
}

function listModelEfforts(modelEntry, { withDefaultFallback = false } = {}) {
  const supported = Array.isArray(modelEntry?.supportedReasoningEfforts)
    ? modelEntry.supportedReasoningEfforts
    : [];
  if (supported.length) {
    return supported;
  }
  if (!withDefaultFallback) {
    return [];
  }
  const defaultEffort = normalizeText(modelEntry?.defaultReasoningEffort);
  return defaultEffort ? [defaultEffort] : [];
}
