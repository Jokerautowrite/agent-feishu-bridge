const { readConfig } = require("../infra/config/config");
const { SessionStore } = require("../infra/storage/session-store");
// 后端可切：AGENT_BRIDGE_BACKEND=codex|opencode|claude|chuang
// 兼容旧变量：OPENCODE_BRIDGE_BACKEND / CHUANG_BRIDGE_BACKEND / CLAUDE_BRIDGE_BACKEND
const { loadBackendClient, resolveConfiguredBackend } = require("../infra/backend-registry");
const AGENT_BRIDGE_BACKEND = resolveConfiguredBackend(process.env);
const CodexRpcClient = loadBackendClient(AGENT_BRIDGE_BACKEND);
const {
  buildCardResponse,
  buildCardToast,
  buildEffortInfoText,
  buildEffortListText,
  buildEffortValidationErrorText,
  buildHelpCardText,
  buildModelInfoText,
  buildModelListText,
  buildModelValidationErrorText,
  buildStatusPanelCard,
  buildThreadMessagesSummary,
  buildThreadPickerCard,
  buildWorkspaceBindingsCard,
  buildWelcomeCard,
  listBoundWorkspaces,
} = require("../presentation/card/builders");
const {
  addPendingReaction,
  clearPendingReactionForBinding,
  clearPendingReactionForThread,
  disposeReplyRunState,
  flushAssistantReplyCardNow,
  handleCardAction,
  movePendingReactionToThread,
  patchInteractiveCard,
  queueCardActionWithFeedback,
  runCardActionTask,
  sendCardActionFeedback,
  sendCardActionFeedbackByContext,
  sendInfoCardMessage,
  sendInteractiveApprovalCard,
  sendInteractiveCard,
  updateInteractiveCard,
  upsertAssistantReplyCard,
} = require("../presentation/card/card-service");
const {
  FeishuClientAdapter,
  patchWsClientForCardCallbacks,
} = require("../infra/feishu/client-adapter");
const runtimeCommands = require("./command-dispatcher");
const approvalRuntime = require("../domain/approval/approval-service");
const runtimeState = require("../domain/session/binding-context");
const threadRuntime = require("../domain/thread/thread-service");
const workspaceRuntime = require("../domain/workspace/workspace-service");
const memberNameCache = require("../domain/group/member-name-cache");
const groupAdminStore = require("../domain/group/group-admin-store");
const runtimeExtensions = require("./runtime-extensions");
const eventsRuntime = require("./codex-event-service");
const approvalPolicyRuntime = require("../domain/approval/approval-policy");
const appDispatcher = require("./dispatcher");
const { extractModelCatalogFromListResponse } = require("../shared/model-catalog");
const { extractProfileValue } = require("../shared/command-parsing");
const { DeliveryReceiptHook } = require("./delivery-receipt-hook");
const fs = require("fs");

const CODEX_APP_SERVER_PROFILES = Object.freeze({
  main: "",
  default: "",
  openai: "",
  ...runtimeExtensions.codexProfiles.profiles,
});
const INBOUND_MESSAGE_DEDUP_TTL_MS = 10 * 60 * 1000;
const MAX_RECENT_INBOUND_MESSAGE_IDS = 1000;
const GROUP_SECURITY_ALERT_COOLDOWN_MS = 10 * 60 * 1000;

class FeishuBotRuntime {
  constructor(config = readConfig()) {
    this.config = config;
    this.sessionStore = new SessionStore({ filePath: config.sessionsFile });
    this.codex = new CodexRpcClient({
      endpoint: config.codexEndpoint,
      env: process.env,
      codexCommand: config.codexCommand,
      appServerProfile: config.codexAppServerProfile,
      logLevel: config.logLevel,
      requestTimeoutMs: config.codexRpcTimeoutMs,
      turnStartTimeoutMs: config.codexTurnStartTimeoutMs,
    });
    this.codexAppServerProfile = config.codexAppServerProfile || "";
    this.lark = null;
    this.client = null;
    this.wsClient = null;
    this.feishuAdapter = null;
    this.memberNameCache = memberNameCache.createMemberNameCache();
    this.groupAdmins = groupAdminStore.createGroupAdminStore({
      persist: (snapshot) => this.sessionStore.setGroupAdmins(snapshot),
    });
    this.pendingChatContextByThreadId = new Map();
    this.pendingChatContextByBindingKey = new Map();
    this.chatTypeByChatId = new Map();
    this.activeTurnIdByThreadId = new Map();
    // chuang 2.0: 当前进度步骤卡所在的 runKey（首个 delta 到达时清掉进度文本再写正文）。
    this.progressRunKeyByThreadId = new Map();
    this.activeTurnStartedAtByThreadId = new Map();
    this.turnSteerQueueByThreadId = new Map();
    this.turnFailureTextByRunKey = new Map();
    this.pendingApprovalByThreadId = new Map();
    this.replyCardByRunKey = new Map();
    this.currentRunKeyByThreadId = new Map();
    this.replyFlushTimersByRunKey = new Map();
    this.replyFlushInFlightByRunKey = new Map();
    this.replyFlushQueuedByRunKey = new Set();
    this.cardKitCircuitOpenUntil = 0;
    this.cardKitCircuitLastReason = "";
    this.latestTokenUsageByThreadId = new Map();
    this.toolItemIdsByRunKey = new Map();
    this.toolTraceByRunKey = new Map();
    this.reasoningTraceByRunKey = new Map();
    this.assistantDeltaSeenByRunKey = new Map();
    this.pendingReactionByBindingKey = new Map();
    this.pendingReactionByThreadId = new Map();
    this.bindingKeyByThreadId = new Map();
    this.workspaceRootByThreadId = new Map();
    this.approvalAllowlistByWorkspaceRoot = new Map();
    this.inFlightApprovalRequestKeys = new Set();
    this.sentAttachmentDirectiveKeys = new Set();
    this.threadCreationByBindingWorkspace = new Map();
    this.resumedThreadIds = new Set();
    this.recentInboundMessageIds = new Map();
    this.groupSecurityAlertCooldown = new Map();
    this.deliveryReceipts = new DeliveryReceiptHook({
      cliPath: config.deliveryLedgerCli,
      ledgerPath: config.deliveryLedgerPath,
    });
    this.staleTurnWatchdog = null;
    this.runtimeKeepalive = null;
    this.extensions = runtimeExtensions;
    this.codex.onMessage((message) => appDispatcher.onCodexMessage(this, message));
  }

  async start() {
    this.validateConfig();
    this.initializeFeishuSdk();
    await this.codex.connect();
    await this.codex.initialize();
    this.groupAdmins.loadFromSnapshot(this.sessionStore.getGroupAdmins());
    // opencode 后端：SSE 订阅由 connect() 内自动建立（serve 根目录），
    // bind 到其他目录时适配器会按需补订阅。无需在此额外启动。
    await this.refreshAvailableModelCatalogAtStartup();
    this.startLongConnection();
    this.startStaleTurnWatchdog();
    this.startRuntimeKeepalive();
    console.log(`[codex-im] feishu-bot runtime ready for app ${maskSecret(this.config.feishu.appId)}`);
  }

  validateConfig() {
    if (!this.config.feishu.appId || !this.config.feishu.appSecret) {
      throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are required for feishu-bot mode");
    }
    if (!String(this.config.defaultCodexModel || "").trim()) {
      throw new Error("AGENT_BRIDGE_DEFAULT_CODEX_MODEL is required");
    }
    if (!String(this.config.defaultCodexEffort || "").trim()) {
      throw new Error("AGENT_BRIDGE_DEFAULT_CODEX_EFFORT is required");
    }
    if (!String(this.config.defaultCodexAccessMode || "").trim()) {
      throw new Error(
        "AGENT_BRIDGE_DEFAULT_CODEX_ACCESS_MODE is required and must be one of: default, full-access"
      );
    }
  }

  initializeFeishuSdk() {
    try {
      // Official SDK: https://github.com/larksuite/node-sdk
      this.lark = require("@larksuiteoapi/node-sdk");
    } catch {
      throw new Error(
        "Missing @larksuiteoapi/node-sdk. Run `npm install` in codex-im before starting feishu-bot mode."
      );
    }

    this.client = new this.lark.Client({
      appId: this.config.feishu.appId,
      appSecret: this.config.feishu.appSecret,
      appType: this.lark.AppType.SelfBuild,
      domain: this.lark.Domain.Feishu,
      loggerLevel: resolveFeishuLoggerLevel(this.lark, this.config.logLevel),
    });

    this.wsClient = new this.lark.WSClient({
      appId: this.config.feishu.appId,
      appSecret: this.config.feishu.appSecret,
      appType: this.lark.AppType.SelfBuild,
      domain: this.lark.Domain.Feishu,
      loggerLevel: resolveFeishuLoggerLevel(this.lark, this.config.logLevel),
      wsConfig: {
        PingInterval: 30,
        PingTimeout: 5,
      },
    });
    this.feishuAdapter = new FeishuClientAdapter(this.client);
    patchWsClientForCardCallbacks(this.wsClient);
  }

  startLongConnection() {
    const eventDispatcher = new this.lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        const messageId = String(data?.message?.message_id || "").trim();
        const ledgerClaim = await this.deliveryReceipts.claimInbound(data);
        if (ledgerClaim.duplicate) {
          console.warn("[codex-im] ignored duplicate Feishu message from delivery ledger");
          return;
        }
        if (!claimInboundMessage(this.recentInboundMessageIds, messageId)) {
          console.warn(`[codex-im] ignored duplicate Feishu message id=${messageId || "-"}`);
          return;
        }
        appDispatcher.onFeishuTextEvent(this, data).catch((error) => {
          this.recentInboundMessageIds.delete(messageId);
          console.error(`[codex-im] failed to process Feishu message: ${error.message}`);
        });
      },
      "card.action.trigger": async (data) => appDispatcher.onFeishuCardAction(this, data),
      "im.chat.member.bot.added_v1": async (data) => {
        const chatId = String(data?.chat_id || "").trim();
        const operatorOpenId = String(data?.operator_id?.open_id || "").trim();
        if (!chatId || !operatorOpenId) {
          return;
        }
        console.log(
          `[codex-im] bot added to group chat=${chatId} by operator=${operatorOpenId.slice(0, 8)}...`
        );
        // 未授权群自动退群（v3.0 群聊安全铁律 #2/#3）：
        // 只有显式配置了 groupAllowedChats 且开启 groupAutoLeave 才生效；
        // 未配置白名单时保持旧行为（不主动退群，仅把拉入者记为管理员）。
        const allowedChats = Array.isArray(this.config.groupAllowedChats)
          ? this.config.groupAllowedChats
          : [];
        const autoLeaveEnabled = Boolean(this.config.groupAutoLeave) && allowedChats.length > 0;
        if (autoLeaveEnabled && !allowedChats.includes(chatId)) {
          await this.handleUnauthorizedGroupAdded(chatId, operatorOpenId);
          return;
        }
        await this.groupAdmins.addAdmin(chatId, operatorOpenId);
      },
    });

    this.wsClient.start({ eventDispatcher });
    console.log("[codex-im] Feishu long connection started");
  }

  async refreshAvailableModelCatalogAtStartup() {
    const cachedCatalog = this.sessionStore.getAvailableModelCatalog();
    let models = [];
    try {
      const response = await Promise.race([
        this.codex.listModels(),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error("model/list startup refresh timed out after 10000ms")),
          10000
        )),
      ]);
      models = extractModelCatalogFromListResponse(response);
    } catch (error) {
      models = Array.isArray(cachedCatalog?.models) ? cachedCatalog.models : [];
      if (!models.length) {
        throw error;
      }
      console.warn(`[codex-im] model catalog refresh unavailable; using cached catalog: ${error.message}`);
    }
    if (!models.length) {
      throw new Error("model/list returned no models at startup");
    }
    this.sessionStore.setAvailableModelCatalog(models);
    const validatedDefaults = workspaceRuntime.validateDefaultCodexParamsConfig(this, models);
    if (!validatedDefaults.model) {
      throw new Error(`Invalid AGENT_BRIDGE_DEFAULT_CODEX_MODEL: ${this.config.defaultCodexModel}`);
    }
    if (!validatedDefaults.effort) {
      throw new Error(
        `Invalid AGENT_BRIDGE_DEFAULT_CODEX_EFFORT: ${this.config.defaultCodexEffort} for model ${validatedDefaults.model}`
      );
    }
    console.log(`[codex-im] model catalog refreshed at startup: ${models.length} entries`);
  }

  startStaleTurnWatchdog() {
    const timeoutMs = Number(this.config.staleTurnTimeoutMs || 0);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || this.staleTurnWatchdog) {
      return;
    }
    const intervalMs = Math.max(30000, Math.min(60000, Math.floor(timeoutMs / 3)));
    this.staleTurnWatchdog = setInterval(() => {
      this.clearStaleTurns(timeoutMs).catch((error) => {
        console.error(`[codex-im] stale turn watchdog failed: ${error.message}`);
      });
    }, intervalMs);
    console.log(
      `[codex-im] stale turn watchdog enabled timeoutMs=${timeoutMs} intervalMs=${intervalMs}`
    );
    if (typeof this.staleTurnWatchdog.unref === "function") {
      this.staleTurnWatchdog.unref();
    }
  }

  startRuntimeKeepalive() {
    if (this.runtimeKeepalive) {
      return;
    }

    // The Feishu SDK unrefs its heartbeat timers on Windows, so a healthy
    // long-connection runtime can otherwise fall out of Node's event loop.
    // Keep exactly one referenced timer alive for the lifetime of the bridge.
    this.runtimeKeepalive = setInterval(() => {
      if (this.codex.mode !== "spawn" || !this.codex.child) {
        return;
      }
      const childExited = this.codex.child.exitCode !== null || this.codex.child.signalCode !== null;
      if (!childExited) {
        return;
      }
      console.error("[codex-im] Codex app-server stopped; exiting for supervisor restart");
      clearInterval(this.runtimeKeepalive);
      this.runtimeKeepalive = null;
      process.exit(1);
    }, 5000);
    console.log("[codex-im] runtime keepalive enabled intervalMs=5000");
  }

  async clearStaleTurns(timeoutMs) {
    const now = Date.now();
    for (const [threadId, startedAt] of this.activeTurnStartedAtByThreadId.entries()) {
      if (!startedAt || now - startedAt < timeoutMs) {
        continue;
      }
      const context = this.pendingChatContextByThreadId.get(threadId);
      const turnId = this.activeTurnIdByThreadId.get(threadId) || "";
      console.warn(
        `[codex-im] stale turn detected thread=${threadId} turn=${turnId}; releasing Feishu runtime state`
      );
      try {
        await this.clearPendingReactionForThread(threadId);
      } catch (error) {
        console.error(`[codex-im] failed to clear stale turn reaction: ${error.message}`);
      }
      this.cleanupThreadRuntimeState(threadId);
      if (!context?.chatId) {
        continue;
      }
      try {
        await this.sendInfoCardMessage({
          chatId: context.chatId,
          replyToMessageId: context.messageId,
          text: "检测到上一轮长时间未返回完成事件，已自动解除飞书端占用。现在可以继续发消息；如果上一个任务仍在终端侧运行，先发 `/stop` 更稳。",
        });
      } catch (error) {
        console.error(`[codex-im] failed to notify stale turn recovery: ${error.message}`);
      }
    }
  }

  resolveReplyToMessageId(normalized, replyToMessageId = "") {
    return replyToMessageId || normalized.messageId;
  }

  getBindingContext(normalized) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const chatBindingKey = this.sessionStore.buildChatBindingKey(normalized);
    if (bindingKey !== chatBindingKey) {
      let workspaceRoot = this.resolveWorkspaceRootForBinding(bindingKey);
      if (!workspaceRoot) {
        workspaceRoot = this.inheritThreadBindingFromSender(normalized, bindingKey);
      }
      return { bindingKey, workspaceRoot };
    }

    let chatWorkspaceRoot = this.resolveWorkspaceRootForBinding(chatBindingKey);
    if (!chatWorkspaceRoot) {
      chatWorkspaceRoot = this.inheritChatBindingFromLegacySender(
        {
          ...normalized,
          threadKey: "",
          messageId: "",
        },
        chatBindingKey
      );
    }
    if (chatWorkspaceRoot) {
      return { bindingKey: chatBindingKey, workspaceRoot: chatWorkspaceRoot };
    }

    let workspaceRoot = this.resolveWorkspaceRootForBinding(bindingKey);
    if (!workspaceRoot) {
      workspaceRoot = this.inheritThreadBindingFromSender(normalized, bindingKey);
    }
    if (!workspaceRoot) {
      workspaceRoot = this.inheritChatBindingFromLegacySender(normalized, bindingKey);
    }
    return { bindingKey, workspaceRoot };
  }

  inheritThreadBindingFromSender(normalized, bindingKey) {
    const threadKey = typeof normalized?.threadKey === "string" ? normalized.threadKey.trim() : "";
    const messageId = typeof normalized?.messageId === "string" ? normalized.messageId.trim() : "";
    const hasStableThreadKey = threadKey && threadKey !== messageId;
    if (!hasStableThreadKey) {
      return "";
    }

    const chatBindingKey = this.sessionStore.buildBindingKey({
      ...normalized,
      threadKey: "",
      messageId: "",
    });
    let inheritedFromBindingKey = chatBindingKey;
    let inheritedWorkspaceRoot = this.resolveWorkspaceRootForBinding(inheritedFromBindingKey);

    if (!inheritedWorkspaceRoot) {
      inheritedFromBindingKey = this.sessionStore.findLegacySenderBindingKeyForChat(normalized);
      inheritedWorkspaceRoot = inheritedFromBindingKey
        ? this.resolveWorkspaceRootForBinding(inheritedFromBindingKey)
        : "";
    }

    if (!inheritedFromBindingKey || inheritedFromBindingKey === bindingKey || !inheritedWorkspaceRoot) {
      return "";
    }

    const inheritedParams = this.sessionStore.getCodexParamsForWorkspace(
      inheritedFromBindingKey,
      inheritedWorkspaceRoot
    );

    this.sessionStore.setThreadIdForWorkspace(
      bindingKey,
      inheritedWorkspaceRoot,
      "",
      {
        workspaceId: normalized.workspaceId,
        chatId: normalized.chatId,
        threadKey: normalized.threadKey,
        senderId: normalized.senderId,
        inheritedFromBindingKey,
        threadScopedBinding: true,
      }
    );
    if (inheritedParams.model || inheritedParams.effort) {
      this.sessionStore.setCodexParamsForWorkspace(bindingKey, inheritedWorkspaceRoot, inheritedParams);
    }

    console.log(
      `[codex-im] inherited workspace binding for feishu thread=${threadKey} from=${inheritedFromBindingKey} workspace=${inheritedWorkspaceRoot}`
    );
    return inheritedWorkspaceRoot;
  }

  inheritChatBindingFromLegacySender(normalized, bindingKey) {
    const threadKey = typeof normalized?.threadKey === "string" ? normalized.threadKey.trim() : "";
    const messageId = typeof normalized?.messageId === "string" ? normalized.messageId.trim() : "";
    const hasStableThreadKey = threadKey && threadKey !== messageId;
    if (hasStableThreadKey) {
      return "";
    }

    const legacyBindingKey = this.sessionStore.findLegacySenderBindingKeyForChat(normalized);
    if (!legacyBindingKey || legacyBindingKey === bindingKey) {
      return "";
    }

    const inheritedWorkspaceRoot = this.resolveWorkspaceRootForBinding(legacyBindingKey);
    if (!inheritedWorkspaceRoot) {
      return "";
    }
    const inheritedParams = this.sessionStore.getCodexParamsForWorkspace(
      legacyBindingKey,
      inheritedWorkspaceRoot
    );

    this.sessionStore.setThreadIdForWorkspace(
      bindingKey,
      inheritedWorkspaceRoot,
      "",
      {
        workspaceId: normalized.workspaceId,
        chatId: normalized.chatId,
        threadKey: "",
        senderId: "",
        inheritedFromBindingKey: legacyBindingKey,
        chatScopedBinding: true,
      }
    );
    if (inheritedParams.model || inheritedParams.effort) {
      this.sessionStore.setCodexParamsForWorkspace(bindingKey, inheritedWorkspaceRoot, inheritedParams);
    }

    console.log(
      `[codex-im] migrated legacy sender workspace binding to chat binding chat=${normalized.chatId} workspace=${inheritedWorkspaceRoot}`
    );
    return inheritedWorkspaceRoot;
  }

  getCurrentThreadContext(normalized) {
    const { bindingKey, workspaceRoot } = this.getBindingContext(normalized);
    const threadId = workspaceRoot ? this.resolveThreadIdForBinding(bindingKey, workspaceRoot) : "";
    return { bindingKey, workspaceRoot, threadId };
  }

  requireFeishuAdapter() {
    if (!this.feishuAdapter) {
      throw new Error("Feishu adapter is not initialized");
    }
    return this.feishuAdapter;
  }

  describeCodexAppServerProfile() {
    return this.codexAppServerProfile || "main";
  }

  async switchCodexAppServerProfile(profileAlias) {
    const rawAlias = String(profileAlias || "").trim().toLowerCase();
    if (!rawAlias) {
      return {
        ok: false,
        message: `当前 Codex 运行档：${this.describeCodexAppServerProfile()}\n\n用法：${this.buildProfileUsageText()}`,
      };
    }
    if (!(rawAlias in CODEX_APP_SERVER_PROFILES)) {
      return {
        ok: false,
        message: `未知运行档。可用：${this.buildProfileAliasListText()}。`,
      };
    }
    if (this.activeTurnIdByThreadId.size > 0) {
      return {
        ok: false,
        message: "当前还有任务在运行。先等完成，或发送 `/stop` 后再切换运行档。",
      };
    }

    const nextProfile = CODEX_APP_SERVER_PROFILES[rawAlias];
    const currentProfile = this.codexAppServerProfile || "";
    if (nextProfile === currentProfile) {
      return {
        ok: true,
        message: `已经是当前运行档：${this.describeCodexAppServerProfile()}`,
      };
    }

    if (typeof this.extensions?.codexProfiles?.beforeSwitchCodexAppServerProfile === "function") {
      await this.extensions.codexProfiles.beforeSwitchCodexAppServerProfile(nextProfile, process.env);
    }

    await this.codex.restartSpawn({ appServerProfile: nextProfile });
    this.codexAppServerProfile = nextProfile;
    const response = await this.codex.listModels();
    const models = extractModelCatalogFromListResponse(response);
    if (models.length) {
      this.sessionStore.setAvailableModelCatalog(models);
    }
    this.resumedThreadIds.clear();
    return {
      ok: true,
      message: `已切换 Codex 运行档：${this.describeCodexAppServerProfile()}`,
    };
  }

  async handleProfileCommand(normalized) {
    const value = extractProfileValue(normalized.text);
    if (!value) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: [
          `当前 Codex 运行档：${this.describeCodexAppServerProfile()}`,
          "",
          "用法：",
          "`/profile main`",
          ...this.getExtensionProfileHelpLines(),
          "",
          `说明：该命令会重启飞书桥背后的 Codex app-server${this.getExtensionProfileNote()}。`,
        ].join("\n"),
      });
      return;
    }
    try {
      const result = await this.switchCodexAppServerProfile(value);
      if (result.ok) {
        const { bindingKey, workspaceRoot } = this.getBindingContext(normalized);
        if (workspaceRoot) {
          this.sessionStore.setCodexParamsForWorkspace(bindingKey, workspaceRoot, {
            model: "",
            effort: "",
          });
        }
      }
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: result.ok
          ? `${result.message}\n\n当前项目的模型覆盖已清空，将使用该运行档默认模型。`
          : result.message,
      });
    } catch (error) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `切换 Codex 运行档失败：${error.message}`,
      });
    }
  }

  getExtensionProfileHelpLines() {
    const getLines = this.extensions?.codexProfiles?.getProfileHelpLines;
    return typeof getLines === "function" ? getLines() : [];
  }

  getExtensionProfileNote() {
    const getNote = this.extensions?.codexProfiles?.getProfileNote;
    return typeof getNote === "function" ? getNote() : "";
  }

  buildProfileUsageText() {
    return ["`/profile main`", ...this.getExtensionProfileHelpLines()].join(" 或 ");
  }

  buildProfileAliasListText() {
    const labels = ["`main`"];
    const displayNames = this.extensions?.codexProfiles?.displayNames || {};
    for (const name of Object.values(displayNames)) {
      labels.push(`\`${name}\``);
    }
    return labels.join("、");
  }

  async resolveWorkspaceStats(workspaceRoot) {
    try {
      const stats = await fs.promises.stat(workspaceRoot);
      return {
        exists: true,
        isDirectory: stats.isDirectory(),
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { exists: false, isDirectory: false };
      }
      throw error;
    }
  }
}

function attachRuntimeForwarders() {
  const proto = FeishuBotRuntime.prototype;

  const plainForwarders = {
    buildCardResponse,
    buildCardToast,
    buildEffortInfoText,
    buildEffortListText,
    buildEffortValidationErrorText,
    buildHelpCardText,
    buildModelInfoText,
    buildModelListText,
    buildModelValidationErrorText,
    buildStatusPanelCard,
    buildWelcomeCard,
    buildThreadMessagesSummary,
    buildThreadPickerCard,
    buildWorkspaceBindingsCard,
    listBoundWorkspaces,
  };

  for (const [methodName, fn] of Object.entries(plainForwarders)) {
    proto[methodName] = function forwardedPlain(...args) {
      return fn(...args);
    };
  }

  const runtimeFirstForwarders = {
    dispatchTextCommand: runtimeCommands.dispatchTextCommand,
    resolveWorkspaceContext: workspaceRuntime.resolveWorkspaceContext,
    resolveWorkspaceThreadState: threadRuntime.resolveWorkspaceThreadState,
    ensureThreadAndSendMessage: threadRuntime.ensureThreadAndSendMessage,
    ensureThreadResumed: threadRuntime.ensureThreadResumed,
    resolveWorkspaceRootForBinding: runtimeState.resolveWorkspaceRootForBinding,
    resolveThreadIdForBinding: runtimeState.resolveThreadIdForBinding,
    setThreadBindingKey: runtimeState.setThreadBindingKey,
    setThreadWorkspaceRoot: runtimeState.setThreadWorkspaceRoot,
    setPendingBindingContext: runtimeState.setPendingBindingContext,
    setPendingThreadContext: runtimeState.setPendingThreadContext,
    setReplyCardEntry: runtimeState.setReplyCardEntry,
    setCurrentRunKeyForThread: runtimeState.setCurrentRunKeyForThread,
    resolveWorkspaceRootForThread: runtimeState.resolveWorkspaceRootForThread,
    rememberApprovalPrefixForWorkspace: approvalPolicyRuntime.rememberApprovalPrefixForWorkspace,
    shouldAutoApproveRequest: approvalPolicyRuntime.shouldAutoApproveRequest,
    tryAutoApproveRequest: approvalPolicyRuntime.tryAutoApproveRequest,
    applyApprovalDecision: approvalRuntime.applyApprovalDecision,
    sendApprovalPrompt: approvalRuntime.sendApprovalPrompt,
    handleBindCommand: workspaceRuntime.handleBindCommand,
    bindWorkspaceFromForm: workspaceRuntime.bindWorkspaceFromForm,
    sendWelcomeCard: workspaceRuntime.sendWelcomeCard,
    handleWhereCommand: workspaceRuntime.handleWhereCommand,
    showStatusPanel: workspaceRuntime.showStatusPanel,
    handleMessageCommand: workspaceRuntime.handleMessageCommand,
    handleHelpCommand: workspaceRuntime.handleHelpCommand,
    handleUnknownCommand: workspaceRuntime.handleUnknownCommand,
    handleWorkspacesCommand: workspaceRuntime.handleWorkspacesCommand,
    showThreadPicker: workspaceRuntime.showThreadPicker,
    handleNewCommand: threadRuntime.handleNewCommand,
    handleSwitchCommand: threadRuntime.handleSwitchCommand,
    handleRemoveCommand: workspaceRuntime.handleRemoveCommand,
    handleSendCommand: workspaceRuntime.handleSendCommand,
    handleModelCommand: workspaceRuntime.handleModelCommand,
    handleEffortCommand: workspaceRuntime.handleEffortCommand,
    refreshWorkspaceThreads: threadRuntime.refreshWorkspaceThreads,
    describeWorkspaceStatus: threadRuntime.describeWorkspaceStatus,
    switchThreadById: threadRuntime.switchThreadById,
    handleStopCommand: eventsRuntime.handleStopCommand,
    handleApprovalCommand: approvalRuntime.handleApprovalCommand,
    deliverToFeishu: eventsRuntime.deliverToFeishu,
    sendInfoCardMessage,
    sendInteractiveApprovalCard,
    updateInteractiveCard,
    sendInteractiveCard,
    patchInteractiveCard,
    handleCardAction,
    dispatchCardAction: runtimeCommands.dispatchCardAction,
    handlePanelCardAction: runtimeCommands.handlePanelCardAction,
    handleThreadCardAction: runtimeCommands.handleThreadCardAction,
    handleWorkspaceCardAction: runtimeCommands.handleWorkspaceCardAction,
    handleFormCardAction: runtimeCommands.handleFormCardAction,
    queueCardActionWithFeedback,
    runCardActionTask,
    handleApprovalCardActionAsync: approvalRuntime.handleApprovalCardActionAsync,
    sendCardActionFeedbackByContext,
    sendCardActionFeedback,
    switchWorkspaceByPath: workspaceRuntime.switchWorkspaceByPath,
    removeWorkspaceByPath: workspaceRuntime.removeWorkspaceByPath,
    upsertAssistantReplyCard,
    flushAssistantReplyCardNow,
    addPendingReaction,
    movePendingReactionToThread,
    clearPendingReactionForBinding,
    clearPendingReactionForThread,
    disposeReplyRunState,
    cleanupThreadRuntimeState: runtimeState.cleanupThreadRuntimeState,
    pruneRuntimeMapSizes: runtimeState.pruneRuntimeMapSizes,
  };

  for (const [methodName, fn] of Object.entries(runtimeFirstForwarders)) {
    proto[methodName] = function forwardedRuntimeFirst(...args) {
      return fn(this, ...args);
    };
  }

  proto.getCodexParamsForWorkspace = function getCodexParamsForWorkspace(bindingKey, workspaceRoot) {
    return this.sessionStore.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  };

  proto.setChatType = function setChatType(chatId, chatType) {
    const normalizedChatId = typeof chatId === "string" ? chatId.trim() : "";
    const normalizedChatType = typeof chatType === "string" ? chatType.trim().toLowerCase() : "";
    if (!normalizedChatId || !normalizedChatType) {
      return;
    }
    this.chatTypeByChatId.set(normalizedChatId, normalizedChatType);
  };

  proto.resolveChatType = function resolveChatType(chatId) {
    const normalizedChatId = typeof chatId === "string" ? chatId.trim() : "";
    return normalizedChatId ? String(this.chatTypeByChatId.get(normalizedChatId) || "") : "";
  };

  /**
   * 解析群聊发送者的显示名字。
   * 优先用成员缓存；未命中时先预取群成员（一次），仍没有则回退 open_id。
   */
  proto.resolveGroupSenderName = async function resolveGroupSenderName(chatId, senderId) {
    const normalizedChatId = typeof chatId === "string" ? chatId.trim() : "";
    const normalizedSenderId = typeof senderId === "string" ? senderId.trim() : "";
    if (!normalizedChatId || !normalizedSenderId) {
      return "";
    }
    const cached = this.memberNameCache.getMemberName(normalizedChatId, normalizedSenderId);
    if (cached) {
      return cached;
    }
    try {
      await memberNameCache.prefetchChatMembers(this, normalizedChatId, this.memberNameCache);
    } catch {
      // 预取失败不阻断消息处理
    }
    return this.memberNameCache.getMemberName(normalizedChatId, normalizedSenderId);
  };

  /**
   * 被拉入未授权群聊：自动退群 + 私聊告警超级管理员（v3.0 群聊安全铁律）。
   * 不把拉入者记为管理员（该群不被授权）。
   */
  proto.handleUnauthorizedGroupAdded = async function handleUnauthorizedGroupAdded(chatId, operatorOpenId) {
    const normalizedChatId = typeof chatId === "string" ? chatId.trim() : "";
    const normalizedOperator = typeof operatorOpenId === "string" ? operatorOpenId.trim() : "";
    console.warn(
      `[codex-im] bot added to UNAUTHORIZED group chat=${normalizedChatId} `
      + `by operator=${normalizedOperator.slice(0, 8)}... → auto-leave + alert`
    );

    let leftGroup = false;
    try {
      const adapter = this.requireFeishuAdapter();
      const botInfo = typeof adapter.getBotInfo === "function" ? await adapter.getBotInfo() : null;
      const botOpenId = botInfo?.openId || "";
      if (botOpenId) {
        if (typeof adapter.leaveGroup === "function") {
          await adapter.leaveGroup(normalizedChatId, botOpenId);
          leftGroup = true;
        }
        this.resolvedBotOpenId = botOpenId;
      }
    } catch (error) {
      console.error(`[codex-im] auto-leave failed chat=${normalizedChatId}: ${error.message}`);
    }

    await this.alertSuperAdminGroupSecurity({
      title: leftGroup
        ? "⚠️ 检测到被拉入未授权群聊（已自动退出）"
        : "⚠️ 检测到被拉入未授权群聊（自动退出失败，请人工处理）",
      details: [
        `群ID：${normalizedChatId}`,
        `拉入者 open_id：${normalizedOperator}`,
        `时间：${new Date().toISOString()}`,
      ].join("\n"),
      throttleKey: `added:${normalizedChatId}`,
    });
  };

  /**
   * 私聊告警超级管理员（带节流：同一 key 10 分钟内只发一次，防刷屏）。
   */
  proto.alertSuperAdminGroupSecurity = async function alertSuperAdminGroupSecurity({
    title = "",
    details = "",
    throttleKey = "",
  } = {}) {
    const superAdmins = Array.isArray(this.config.superAdminOpenIds)
      ? this.config.superAdminOpenIds
      : [];
    if (!superAdmins.length || !title) {
      return;
    }
    const key = String(throttleKey || title).trim();
    const now = Date.now();
    const lastAlertAt = Number(this.groupSecurityAlertCooldown?.get(key) || 0);
    if (now - lastAlertAt < GROUP_SECURITY_ALERT_COOLDOWN_MS) {
      return;
    }
    this.groupSecurityAlertCooldown?.set(key, now);

    const text = `${title}\n${details}`;
    const adapter = this.requireFeishuAdapter();
    for (const openId of superAdmins) {
      try {
        if (typeof adapter.sendTextMessageToOpenId === "function") {
          await adapter.sendTextMessageToOpenId(openId, text);
        }
      } catch (error) {
        console.error(
          `[codex-im] super admin alert failed openId=${openId.slice(0, 8)}...: ${error.message}`
        );
      }
    }
  };
}

attachRuntimeForwarders();

FeishuBotRuntime.prototype.sendFileMessage = function sendFileMessage(args) {
  return this.requireFeishuAdapter().sendFileMessage(args);
};

FeishuBotRuntime.prototype.sendImageMessage = function sendImageMessage(args) {
  return this.requireFeishuAdapter().sendImageMessage(args);
};

FeishuBotRuntime.prototype.sendLocalAttachmentToFeishu = function sendLocalAttachmentToFeishu(args) {
  return sendLocalAttachmentWithRuntime(this, args);
};

async function sendLocalAttachmentWithRuntime(runtime, {
  kind,
  chatId,
  fileName,
  fileBuffer,
  fileType = "stream",
  msgType = "file",
  duration = null,
  replyToMessageId = "",
  replyInThread = false,
}) {
  if (kind === "image") {
    return runtime.sendImageMessage({
      chatId,
      imageBuffer: fileBuffer,
      replyToMessageId,
      replyInThread,
    });
  }
  return runtime.sendFileMessage({
    chatId,
    fileName,
    fileBuffer,
    fileType,
    msgType,
    duration,
    replyToMessageId,
    replyInThread,
  });
}

function resolveFeishuLoggerLevel(lark, logLevel) {
  if (logLevel === "verbose") {
    return lark.LoggerLevel.info;
  }
  if (logLevel === "quiet") {
    return lark.LoggerLevel.error;
  }
  return lark.LoggerLevel.warn;
}

function maskSecret(value) {
  if (!value) {
    return "";
  }
  if (value.length <= 6) {
    return "***";
  }
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function claimInboundMessage(cache, messageId, now = Date.now()) {
  const normalizedMessageId = String(messageId || "").trim();
  if (!normalizedMessageId || !(cache instanceof Map)) {
    return true;
  }

  for (const [id, expiresAt] of cache.entries()) {
    if (Number(expiresAt) <= now) {
      cache.delete(id);
    }
  }
  if (Number(cache.get(normalizedMessageId) || 0) > now) {
    return false;
  }

  cache.set(normalizedMessageId, now + INBOUND_MESSAGE_DEDUP_TTL_MS);
  while (cache.size > MAX_RECENT_INBOUND_MESSAGE_IDS) {
    const oldestId = cache.keys().next().value;
    if (!oldestId) {
      break;
    }
    cache.delete(oldestId);
  }
  return true;
}

module.exports = { FeishuBotRuntime, claimInboundMessage };
