const net = require("net");
const os = require("os");
const { normalizeLogLevel, shouldLogCodexTraffic } = require("../../shared/log-level");

const IS_WINDOWS = os.platform() === "win32";
const DEFAULT_CHUANG_SOCKET =
  process.env.CHUANG_AGENT_SOCKET ||
  (IS_WINDOWS ? "" : `/run/user/${process.getuid?.() || 1000}/chuang-agent/app-server.sock`);
const DEFAULT_CODEX_COMMAND = "codex";
const WINDOWS_EXECUTABLE_SUFFIX_RE = /\.(cmd|exe|bat)$/i;
const CODEX_CLIENT_INFO = {
  name: "codex_im_agent",
  title: "Agent Bridge",
  version: "0.2.0",
};

/**
 * ChuangRpcClient —— 把 Chuang app-server（Unix socket JSON-RPC）
 * 伪装成 Codex app-server，桥的上层一行不用改（同 opencode 适配器的做法）。
 *
 * 契约：
 *   出：thread/start · thread/resume · thread/list · model/list · turn/start
 *   入：turn/started · item/agentMessage/delta · item/completed
 *       · turn/completed · turn/failed · turn/cancelled
 *
 * 连接：Unix socket（json lines），服务由 chuang-agent-app-server.service 提供。
 */
class CodexRpcClient {
  constructor({
    endpoint = "",
    env = process.env,
    codexCommand = "",
    appServerProfile = "",
    logLevel = "normal",
    requestTimeoutMs = 45000,
    turnStartTimeoutMs = 60000,
  }) {
    this.endpoint = endpoint;
    this.env = env;
    this.codexCommand = codexCommand || resolveDefaultCodexCommand(env);
    this.appServerProfile = normalizeNonEmptyString(appServerProfile);
    this.logLevel = normalizeLogLevel(logLevel);
    this.requestTimeoutMs = requestTimeoutMs;
    this.turnStartTimeoutMs = turnStartTimeoutMs;
    this.socketPath = normalizeNonEmptyString(env.CHUANG_AGENT_SOCKET) || DEFAULT_CHUANG_SOCKET;
    this.mode = "socket";
    this.socket = null;
    this.child = null;
    this.stdoutBuffer = "";
    this.pending = new Map();
    this.isReady = false;
    this.messageListeners = new Set();
    // ── 自动重连状态 ──────────────────────────────
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.reconnectMaxDelayMs = 30000;
    this.reconnectBaseDelayMs = 1000;
    this.reconnectLoopRunning = false;
    this.reconnectWaiters = new Set(); // 断线期间等待重连的 sendRequest 回调
    this.isManualRestarting = false;
  }

  async connect() {
    await this.connectSocket();
  }

  async connectSocket() {
    if (!this.socketPath) {
      throw new Error("CHUANG_AGENT_SOCKET is not configured; set it to the chuang app-server socket path");
    }
    this.stopReconnectTimer();
    await new Promise((resolve, reject) => {
      const socket = net.connect(this.socketPath);
      this.socket = socket;
      let opened = false;

      socket.on("connect", () => {
        opened = true;
        this.isReady = true;
        this.reconnectAttempts = 0;
        console.log(`[codex-im] connected to Chuang app-server socket ${this.socketPath}`);
        this.scheduleReconnectIfNeeded(); // 清除残留重连定时器（若有）
        resolve();
      });
      socket.on("error", (error) => {
        this.isReady = false;
        if (!opened) {
          if (this.socket === socket) {
            this.socket = null;
          }
          this.scheduleReconnect();
          reject(error);
          return;
        }
        this.rejectAllPending(error);
        this.scheduleReconnect();
      });
      socket.on("data", (chunk) => {
        this.stdoutBuffer += chunk.toString("utf8");
        const lines = this.stdoutBuffer.split("\n");
        this.stdoutBuffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            this.handleIncoming(trimmed);
          }
        }
      });
      socket.on("close", () => {
        this.isReady = false;
        this.socket = null;
        this.rejectAllPending(new Error("Chuang app-server socket closed"));
        this.scheduleReconnect();
      });
    });
  }

  /**
   * 断线自动重连（带退避保护）。
   * - socket 断开/连接失败后由 connectSocket 调用。
   * - 指数退避 1s→2s→4s→…→30s 封顶，持续重试直到连上。
   * - 重连成功会重新 initialize（app-server 重启后需重新握手）。
   * - 重连期间等待的请求（sendRaw 的 reconnect waiters）会继续。
   */
  scheduleReconnect() {
    if (this.isManualRestarting) {
      return;
    }
    if (this.reconnectTimer || this.reconnectLoopRunning) {
      return;
    }
    this.isReady = false;
    const delay = Math.min(
      this.reconnectBaseDelayMs * 2 ** Math.min(this.reconnectAttempts, 6),
      this.reconnectMaxDelayMs,
    );
    this.reconnectAttempts += 1;
    console.log(
      `[codex-im] chuang socket disconnected; reconnect attempt ${this.reconnectAttempts} in ${delay}ms (protect: ${this.socketPath})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.tryReconnectOnce().catch((error) => {
        console.error(`[codex-im] chuang reconnect failed: ${error?.message || error}`);
      });
    }, delay);
  }

  stopReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async tryReconnectOnce() {
    if (this.isManualRestarting) {
      return;
    }
    try {
      // 尝试重连：connectSocket 内部成功会 resolve，失败会再次 scheduleReconnect
      await this.connectSocket();
      if (this.isReady && this.socket) {
        try {
          await this.initialize();
        } catch (error) {
          console.error(`[codex-im] chuang reinitialize failed: ${error?.message || error}`);
          this.scheduleReconnect();
        }
      }
      // 通知等待重连的请求
      if (this.reconnectWaiters.size) {
        const waiters = [...this.reconnectWaiters];
        this.reconnectWaiters.clear();
        for (const waiter of waiters) {
          waiter();
        }
      }
    } catch (error) {
      // connectSocket 失败已在内部调度下一次重连；这里只记录日志，不打断退避循环。
      console.error(`[codex-im] chuang reconnect attempt failed: ${error?.message || error}`);
    }
  }

  scheduleReconnectIfNeeded() {
    // 连接成功时若有残留定时器就清掉（兜底）
    this.stopReconnectTimer();
  }

  /**
   * 等待重连（最多 reconnectWaitMs 毫秒）。返回 true 表示已重连成功。
   */
  async waitForReconnect(reconnectWaitMs = 15000) {
    if (this.isReady && this.socket && !this.socket.destroyed && this.socket.writable) {
      return true;
    }
    if (!this.reconnectLoopRunning && !this.reconnectTimer) {
      this.scheduleReconnect();
    }
    return new Promise((resolve) => {
      let waiter;
      const timer = setTimeout(() => {
        this.reconnectWaiters.delete(waiter);
        resolve(false);
      }, reconnectWaitMs);
      waiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.reconnectWaiters.add(waiter);
    });
  }

  async restartSpawn({ appServerProfile = "" } = {}) {
    this.appServerProfile = normalizeNonEmptyString(appServerProfile);
    this.stopReconnectTimer();
    this.isManualRestarting = true;
    this.isReady = false;
    this.rejectAllPending(new Error("Chuang app-server reconnecting"));
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    this.stdoutBuffer = "";
    try {
      await this.connectSocket();
      await this.initialize();
    } finally {
      this.isManualRestarting = false;
    }
  }

  onMessage(listener) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  async initialize() {
    if (this.isReady) {
      return;
    }

    await this.sendRequest("initialize", {
      clientInfo: CODEX_CLIENT_INFO,
      capabilities: {
        experimentalApi: true,
      },
    });
    await this.sendNotification("initialized", null);
    this.isReady = true;
  }

  async sendUserMessage({
    threadId,
    text,
    attachments = [],
    model = null,
    effort = null,
    accessMode = null,
    workspaceRoot = "",
  }) {
    const input = buildTurnInputPayload(text, attachments);
    return threadId
      ? this.sendRequestProtected(
        "turn/start",
        buildTurnStartParams({
          threadId,
          input,
          model,
          effort,
          accessMode,
          workspaceRoot,
        })
      )
      : this.sendRequestProtected("thread/start", { input });
  }

  async steerTurn({
    threadId,
    expectedTurnId,
    text,
    attachments = [],
    clientUserMessageId = "",
  }) {
    const normalizedThreadId = normalizeNonEmptyString(threadId);
    const normalizedExpectedTurnId = normalizeNonEmptyString(expectedTurnId);
    const input = buildTurnInputPayload(text, attachments);
    if (!normalizedThreadId) {
      throw new Error("turn/steer requires a non-empty threadId");
    }
    if (!normalizedExpectedTurnId) {
      throw new Error("turn/steer requires a non-empty expectedTurnId");
    }
    if (!input.length) {
      throw new Error("turn/steer requires non-empty input");
    }

    const params = {
      threadId: normalizedThreadId,
      expectedTurnId: normalizedExpectedTurnId,
      input,
    };
    const normalizedClientUserMessageId = normalizeNonEmptyString(clientUserMessageId);
    if (normalizedClientUserMessageId) {
      params.clientUserMessageId = normalizedClientUserMessageId;
    }
    return this.sendRequestProtected("turn/steer", params);
  }

  async startThread({ cwd }) {
    return this.sendRequestProtected("thread/start", buildStartThreadParams(cwd));
  }

  async resumeThread({ threadId }) {
    const normalizedThreadId = normalizeNonEmptyString(threadId);
    if (!normalizedThreadId) {
      throw new Error("thread/resume requires a non-empty threadId");
    }
    return this.sendRequestProtected("thread/resume", { threadId: normalizedThreadId });
  }

  async listThreads({ cursor = null, limit = 100, sortKey = "updated_at" } = {}) {
    return this.sendRequestProtected("thread/list", buildListThreadsParams({
      cursor,
      limit,
      sortKey,
    }));
  }

  async listModels() {
    return this.sendRequestProtected("model/list", {});
  }

  async sendRequest(method, params, options = {}) {
    const id = createRequestId();
    const payload = JSON.stringify({ id, method, params });
    const timeoutMs = options.timeoutMs || this.getRequestTimeoutMs(method);

    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });

    logCodexOutboundMessage(`request:${method}`, payload, this.logLevel);
    try {
      this.sendRaw(payload);
    } catch (error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      if (pending) {
        pending.reject(error);
      }
    }
    return responsePromise;
  }

  async sendNotification(method, params) {
    const payload = JSON.stringify({ method, params });
    logCodexOutboundMessage(`notification:${method}`, payload, this.logLevel);
    this.sendRaw(payload);
  }

  async sendResponse(id, result) {
    const payload = JSON.stringify({ id, result });
    logCodexOutboundMessage("response", payload, this.logLevel);
    this.sendRaw(payload);
  }

  sendRaw(payload) {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) {
      throw new Error("Chuang app-server socket is not connected");
    }
    this.socket.write(`${payload}\n`);
  }

  /**
   * sendRequest 断线保护：socket 未连接时等待自动重连，
   * 重连成功后再发送；超时仍失败则抛出原错误。
   */
  async sendRequestProtected(method, params = {}, options = {}) {
    if (this.isReady && this.socket && !this.socket.destroyed && this.socket.writable) {
      return this.sendRequest(method, params, options);
    }
    const ok = await this.waitForReconnect(options.reconnectWaitMs || 15000);
    if (!ok) {
      throw new Error(`Chuang app-server socket is not connected (reconnect timeout for ${method})`);
    }
    return this.sendRequest(method, params, options);
  }

  handleIncoming(rawMessage) {
    const parsed = tryParseJson(rawMessage);
    if (!parsed) {
      logCodexParseFailure(rawMessage);
      return;
    }
    logCodexInboundMessage(parsed, this.logLevel);

    if (parsed && parsed.method) {
      for (const listener of this.messageListeners) {
        listener(parsed);
      }
      return;
    }

    if (parsed && parsed.id != null) {
      if (!this.pending.has(String(parsed.id))) {
        console.warn(`[codex-im] codex<= response for unknown or timed-out request id=${parsed.id}`);
        return;
      }
      const { resolve, reject } = this.pending.get(String(parsed.id));
      this.pending.delete(String(parsed.id));
      if (parsed.error) {
        reject(new Error(parsed.error.message || "Codex RPC request failed"));
        return;
      }
      resolve(parsed);
      return;
    }

    for (const listener of this.messageListeners) {
      listener(parsed);
    }
  }

  getRequestTimeoutMs(method) {
    if (method === "turn/start" || method === "turn/steer") {
      return this.turnStartTimeoutMs;
    }
    return this.requestTimeoutMs;
  }

  rejectAllPending(error) {
    if (!this.pending.size) {
      return;
    }
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      entry.reject(error);
    }
  }
}

function createRequestId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function tryParseJson(rawMessage) {
  try {
    return JSON.parse(rawMessage);
  } catch {
    return null;
  }
}

function logCodexOutboundMessage(operation, payload, logLevel = "normal") {
  const parsed = tryParseJson(payload);
  if (!shouldLogCodexTraffic(parsed, logLevel)) {
    return;
  }
  try {
    const summary = summarizeRawCodexPayload(payload);
    console.log(`[codex-im] codex=> op=${operation} ${summary}`);
  } catch {
    console.log(`[codex-im] codex=> op=${operation} <unserializable payload>`);
  }
}

function logCodexInboundMessage(message, logLevel = "normal") {
  if (!shouldLogCodexTraffic(message, logLevel)) {
    return;
  }
  try {
    console.log(`[codex-im] codex<= ${summarizeCodexMessage(message)}`);
  } catch {
    console.log("[codex-im] codex<= <unserializable message>");
  }
}

function summarizeRawCodexPayload(payload) {
  const size = Buffer.byteLength(String(payload || ""), "utf8");
  const parsed = tryParseJson(payload);
  if (!parsed) {
    return `bytes=${size} raw=${JSON.stringify(String(payload || "").slice(0, 120))}`;
  }
  return `${summarizeCodexMessage(parsed)} payloadBytes=${size}`;
}

function summarizeCodexMessage(message) {
  const parts = [];
  if (message?.id != null) {
    parts.push(`id=${message.id}`);
  }
  if (message?.method) {
    parts.push(`method=${message.method}`);
  }
  const params = message?.params || {};
  const result = message?.result || {};
  const threadId = params.threadId || result.thread?.id;
  const turnId = params.turnId;
  const itemId = params.itemId || message?.item?.id;
  if (threadId) {
    parts.push(`thread=${threadId}`);
  }
  if (turnId) {
    parts.push(`turn=${turnId}`);
  }
  if (itemId) {
    parts.push(`item=${itemId}`);
  }
  if (message?.error?.message) {
    parts.push(`error=${JSON.stringify(message.error.message)}`);
  }
  if (params?.error?.message) {
    parts.push(`paramsError=${JSON.stringify(String(params.error.message).slice(0, 300))}`);
  }
  if (params?.error?.additionalDetails) {
    parts.push(`paramsErrorDetails=${JSON.stringify(String(params.error.additionalDetails).slice(0, 300))}`);
  }
  if (result?.data && Array.isArray(result.data)) {
    parts.push(`resultItems=${result.data.length}`);
  }
  if (result?.thread?.turns && Array.isArray(result.thread.turns)) {
    parts.push(`turns=${result.thread.turns.length}`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
  parts.push(`bytes=${bytes}`);
  return parts.length ? parts.join(" ") : `bytes=${bytes}`;
}

function logCodexParseFailure(rawMessage) {
  const sample = String(rawMessage || "").slice(0, 300);
  console.warn(`[codex-im] codex<= [parse_failed] raw=${JSON.stringify(sample)}`);
}

function resolveDefaultCodexCommand(env = process.env) {
  return normalizeNonEmptyString(env.AGENT_BRIDGE_CODEX_COMMAND)
    || normalizeNonEmptyString(env.CODEX_IM_CODEX_COMMAND)
    || DEFAULT_CODEX_COMMAND;
}

function buildCodexCommandCandidates(configuredCommand) {
  const explicit = normalizeNonEmptyString(configuredCommand);
  if (explicit) {
    if (!IS_WINDOWS) {
      return [explicit];
    }

    const candidates = [explicit];
    if (!WINDOWS_EXECUTABLE_SUFFIX_RE.test(explicit)) {
      candidates.push(`${explicit}.cmd`, `${explicit}.exe`, `${explicit}.bat`);
    }
    return [...new Set(candidates)];
  }

  if (IS_WINDOWS) {
    return [DEFAULT_CODEX_COMMAND, `${DEFAULT_CODEX_COMMAND}.cmd`, `${DEFAULT_CODEX_COMMAND}.exe`, `${DEFAULT_CODEX_COMMAND}.bat`];
  }

  return [DEFAULT_CODEX_COMMAND];
}

function buildSpawnSpec(command, appServerProfile = "") {
  const normalizedProfile = normalizeNonEmptyString(appServerProfile);
  if (IS_WINDOWS) {
    const args = ["/c", command];
    if (normalizedProfile) {
      args.push("--profile", normalizedProfile);
    }
    args.push("app-server");
    return {
      command: "cmd.exe",
      args,
    };
  }

  const args = [];
  if (normalizedProfile) {
    args.push("--profile", normalizedProfile);
  }
  args.push("app-server");
  return {
    command,
    args,
  };
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function buildStartThreadParams(cwd) {
  const normalizedCwd = normalizeNonEmptyString(cwd);
  return normalizedCwd ? { cwd: normalizedCwd } : {};
}

function buildListThreadsParams({ cursor, limit, sortKey }) {
  const params = { limit, sortKey };
  const normalizedCursor = normalizeNonEmptyString(cursor);

  if (normalizedCursor) {
    params.cursor = normalizedCursor;
  }

  return params;
}

function buildTurnInputPayload(text, attachments = []) {
  const normalizedText = normalizeNonEmptyString(text);
  const items = [];

  if (normalizedText) {
    items.push({
      type: "text",
      text: normalizedText,
    });
  }

  for (const attachment of normalizeImageAttachments(attachments)) {
    items.push({
      type: "localImage",
      path: attachment.filePath,
    });
  }

  return items;
}

function normalizeImageAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments
    .filter((attachment) => attachment?.kind === "image"
      && attachment?.imageMode !== "path"
      && normalizeNonEmptyString(attachment.filePath))
    .map((attachment) => ({
      ...attachment,
      filePath: normalizeNonEmptyString(attachment.filePath),
    }));
}

function buildTurnStartParams({ threadId, input, model, effort, accessMode, workspaceRoot }) {
  const params = { threadId, input };
  const normalizedModel = normalizeNonEmptyString(model);
  const normalizedEffort = normalizeNonEmptyString(effort);
  const normalizedAccessMode = normalizeAccessMode(accessMode);
  const executionPolicies = buildExecutionPolicies(normalizedAccessMode, workspaceRoot);
  if (normalizedModel) {
    params.model = normalizedModel;
  }
  if (normalizedEffort) {
    params.effort = normalizedEffort;
  }
  if (normalizedAccessMode) {
    params.accessMode = normalizedAccessMode;
  }
  params.approvalPolicy = executionPolicies.approvalPolicy;
  params.sandboxPolicy = executionPolicies.sandboxPolicy;
  return params;
}

function normalizeAccessMode(value) {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "default") {
    return "current";
  }
  return normalized === "full-access" ? normalized : "";
}

function buildExecutionPolicies(accessMode, workspaceRoot) {
  if (accessMode === "full-access") {
    return {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  }
  const normalizedWorkspaceRoot = normalizeNonEmptyString(workspaceRoot);
  const sandboxPolicy = normalizedWorkspaceRoot
    ? {
      type: "workspaceWrite",
      writableRoots: [normalizedWorkspaceRoot],
      networkAccess: true,
    }
    : {
      type: "workspaceWrite",
      networkAccess: true,
    };
  return {
    approvalPolicy: "on-request",
    sandboxPolicy,
  };
}

module.exports = {
  CodexRpcClient,
  logCodexInboundMessage,
  logCodexOutboundMessage,
  shouldLogCodexTraffic,
};
