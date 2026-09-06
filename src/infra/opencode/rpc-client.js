"use strict";
/**
 * OpencodeRpcClient —— 把 opencode serve 伪装成 Codex app-server
 *
 * 桥（agent-feishu-bridge）是 DDD 分层，domain/app/presentation 只认
 * infra 那套 JSON-RPC 契约。所以接入 opencode = 实现同一契约的另一个
 * infra 适配器，上层一行不用改（同 claude 适配器的做法）。
 *
 * 契约：
 *   出：thread/start · thread/resume · thread/list · model/list · turn/start
 *   入：turn/started · item/agentMessage/delta · item/started · item/completed
 *       · turn/completed · turn/failed · turn/cancelled · thread/tokenUsage/updated
 *
 * opencode serve 实际接口：
 *   POST /session                    → 建会话 {id}
 *   GET  /session                    → 会话列表（含 tokens/model/directory）
 *   POST /session/{id}/message       → 发消息 {parts:[{type:"text",text}]}
 *   GET  /event                      → SSE 全局事件流
 *
 * SSE 事件 → 契约映射：
 *   message.part.delta (field=text)         → item/agentMessage/delta
 *   message.part.updated (type=text, delta) → item/agentMessage/delta
 *   message.part.updated (type=reasoning)   → 推理摘要（reasoningTrace）
 *   message.part.updated (type=tool)        → item/started / item/completed
 *   session.status (type=busy)              → turn/started
 *   session.status (type=idle)              → turn/completed
 *   POST 响应 info.tokens                    → thread/tokenUsage/updated
 */
const { randomUUID } = require("crypto");

const DEFAULT_SERVER_URL = process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096";
const DEFAULT_AGENT = process.env.OPENCODE_AGENT || "build";
// 首个事件的等待上限：超过就认定后端没起来，主动失败而不是让人干等
const FIRST_EVENT_TIMEOUT_MS = Number(process.env.OPENCODE_BRIDGE_FIRST_EVENT_MS || 600000);
// 单轮总时长上限
const TURN_TIMEOUT_MS = Number(process.env.OPENCODE_BRIDGE_TURN_MS || 172800000);
const MAX_TEXT_BUFFER = 102_400;
const SUPPORTED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

// ── 稳定性辅助 ──────────────────────────────────────
// POST 发送失败重试：opencode serve 偶发 fetch failed（连接被 reset），
// 直接失败会丢消息；这里做短退避重试，最多 3 次。
const POST_RETRIES = Number(process.env.OPENCODE_BRIDGE_POST_RETRIES || 3);
const POST_RETRY_BASE_MS = Number(process.env.OPENCODE_BRIDGE_POST_RETRY_BASE_MS || 800);
// POST 单次尝试的超时上限：serve 处理慢时避免无限挂起（默认 90s，可配）
const POST_TIMEOUT_MS = Number(process.env.OPENCODE_BRIDGE_POST_TIMEOUT_MS || 7200000);
async function postWithRetry(url, body, opts = {}) {
  const maxAttempts = Math.max(1, POST_RETRIES);
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal || controller.signal,
      });
      clearTimeout(timer);
      return resp;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, POST_RETRY_BASE_MS * attempt));
      }
    }
  }
  throw lastErr;
}

// 把平铺 usage 包装成卡片端期望的 { last: {...}, modelContextWindow } 结构。
// 卡片 formatContextText 只认 tokenUsage.last.totalTokens + modelContextWindow，
// 平铺结构会让"📝 上下文 xx/xx (x%)"进度条行缺失。
function wrapUsageForCard(usage, modelContextWindow) {
  const last = {
    inputTokens: Number(usage?.inputTokens || 0),
    outputTokens: Number(usage?.outputTokens || 0),
    reasoningTokens: Number(usage?.reasoningTokens || 0),
    totalTokens: Number(usage?.totalTokens || 0),
    reasoningOutputTokens: Number(usage?.reasoningOutputTokens || 0),
  };
  const out = { last };
  if (modelContextWindow > 0) out.modelContextWindow = modelContextWindow;
  return out;
}

function normalizeModelId(m) {
  const s = String(m || "").trim();
  if (!s) return "";
  // 剥掉 opencode 模型名可能带的 provider/variant 后缀段，如 "deepseek-v4-flash[max]"
  return s.replace(/\[[^\]]*\]\s*$/, "").trim();
}

function extractTextFromParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p?.type === "text" && typeof p.text === "string" && p.text)
    .map((p) => p.text)
    .join("\n")
    .trim();
}

function extractUsageTokenCounts(info) {
  const tokens = info?.tokens || {};
  if (!tokens || typeof tokens !== "object") return null;
  const input = Number(tokens.input || 0);
  const output = Number(tokens.output || 0);
  const reasoning = Number(tokens.reasoning || 0);
  const total = Number(tokens.total || input + output);
  if (!input && !output && !total) return null;
  return { inputTokens: input, outputTokens: output, reasoningTokens: reasoning, totalTokens: total };
}

function findModelContextWindow(config, providerId, modelId) {
  const providers = config?.provider || {};
  const p = providers[providerId] || providers[String(providerId || "").toLowerCase()];
  const model = p?.models?.[modelId];
  const limit = model?.limit || {};
  const ctx = Number(limit.context || 0);
  if (ctx > 0) return ctx;
  const modelName = model?.name || "";
  for (const key of [modelId, `${providerId}/${modelId}`, modelName]) {
    if (!key) continue;
    for (const [pid, pv] of Object.entries(providers)) {
      const m = pv?.models?.[key];
      if (m?.limit?.context) return Number(m.limit.context);
    }
  }
  return 0;
}

class OpencodeRpcClient {
  constructor(opts = {}) {
    this.serverUrl = opts.serverUrl || DEFAULT_SERVER_URL;
    this.agent = opts.agent || DEFAULT_AGENT;
    this.logLevel = opts.logLevel || "normal";
    this.listeners = [];
    this.threads = new Map();        // threadId -> opencode sessionId + cwd
    this.running = new Map();        // sessionId -> { turnId, timers, buffer, toolItems, reasoning, tokenUsage }
    this.sessionDirs = new Map();    // sessionId -> directory（事件路由用）
    this.sseSubs = new Map();        // directory(""=serve根) -> { controller, stop, ready }
    this.reasoningPartIds = new Set(); // 已确认是 reasoning 的 part id（delta 过滤用）
    this.sseStopped = false;
    this.connected = false;
    this.sseLoopStarted = false;
    this.serveRoot = "";           // opencode serve 启动目录（connect 时探测）
    this.sseReadyResolve = null;
    this.sseReady = new Promise((resolve) => { this.sseReadyResolve = resolve; });
    this.configCache = null;          // opencode /config 缓存
    this.configFetched = false;       // 是否已拉过 /config
  }

  // ── 生命周期 ────────────────────────────────────────
  async connect() {
    this.log("connecting to opencode serve");
    await this.ping();
    this.connected = true;
    // 探测 serve 根目录：session 列表第一条的 directory 就是 serve 启动目录。
    // 用它作为根订阅的 key，避免 "" 和具体路径两套订阅收到同一事件（重复）。
    try {
      const rootSessions = await this.listThreads({ limit: 1 });
      const first = (rootSessions.result?.data || rootSessions.data || [])[0];
      this.serveRoot = first?.cwd || "";
    } catch (e) {
      this.serveRoot = "";
    }
    // 常驻 SSE 订阅必须在任何消息发出前就绪，否则会错过首轮 idle 事件。
    // 默认订阅 serve 根目录，bind 到其他目录时再按需订阅。
    if (!this.sseLoopStarted) {
      this.sseLoopStarted = true;
      // 根订阅的 key 统一用 serveRoot（具体路径），不要用 ""——
      // 否则 "" 和 serveRoot 两套订阅会同时收到 serve 根目录事件（重复）。
      const rootKey = this.serveRoot || "";
      this.subscribeDirectory(rootKey).catch((error) => {
        console.error(`[opencode-im] SSE subscribe failed: ${error.message}`);
      });
    }
    return true;
  }

  /**
   * 订阅一个目录的 SSE 事件流。directory="" 表示 serve 根目录（默认全局流）。
   * opencode 的 /event 按目录隔离：项目目录 session 的事件只在带
   * ?directory= 的订阅里出现。已订阅的目录直接复用。
   */
  async subscribeDirectory(directory, opts = {}) {
    const key = String(directory || "");
    if (this.sseSubs.has(key)) {
      return this.sseSubs.get(key);
    }
    let sdk;
    try {
      sdk = await import("@opencode-ai/sdk/v2");
    } catch (e) {
      console.error(`[opencode-im] @opencode-ai/sdk not found: ${e.message}`);
      return null;
    }
    const controller = new AbortController();
    const sub = { controller, ready: null, stop: false };
    const readyResolve = opts.waitReady
      ? null
      : new Promise((resolve) => { sub.ready = resolve; });
    this.sseSubs.set(key, sub);

    // 异步建立连接并迭代
    (async () => {
      try {
        const client = sdk.createOpencodeClient({ baseUrl: this.serverUrl });
        const params = key ? { directory: key } : undefined;
        const events = await client.event.subscribe(params);
        this.log(`opencode SSE stream connected (directory=${key || "<root>"})`);
        if (sub.ready) {
          const r = sub.ready;
          sub.ready = null;
          r();
        }
        if (opts.waitReadyResolve) opts.waitReadyResolve();
        for await (const ev of events.stream) {
          if (sub.stop || this.sseStopped) break;
          if (this.sseReadyResolve) {
            const r = this.sseReadyResolve;
            this.sseReadyResolve = null;
            r();
          }
          this.handleSseEvent(ev);
        }
        // SSE 流非正常结束：serve 可能 reset 了长连接。先触发重连，
        // 给一个 grace 期（默认 20s）等 idle 事件回来；期间若重连成功且收到
        // 对应 turn 的 idle 事件，turn 会正常 completeTurn。grace 期过后仍未
        // 恢复才 fail，避免"一断就全部失败"的糟糕体验。
        if (!sub.stop && !this.sseStopped) {
          this.scheduleResubscribe(key);
          const graceMs = Number(process.env.OPENCODE_BRIDGE_SSE_GRACE_MS || 20000);
          this.log(`opencode SSE stream ended (dir=${key || "<root>"}); waiting ${Math.round(graceMs/1000)}s grace before failing pending turns`);
          setTimeout(() => {
            if (!sub.stop && !this.sseStopped) {
              this.failAllRunning("opencode SSE 连接中断且未在宽限期内恢复，请重试（连接非正常结束）。", key);
            }
          }, graceMs);
        }
        this.log(`opencode SSE stream ended (directory=${key || "<root>"})`);
        // 正常结束时同样自愈：删除旧订阅后 3s 重连，保证后续消息能重新收到 idle 事件。
        if (!sub.stop && !this.sseStopped) {
          await new Promise((r) => setTimeout(r, 3000));
          if (!sub.stop && !this.sseStopped) {
            this.sseSubs.delete(key);
            this.subscribeDirectory(key).catch((err) => {
              this.log("opencode SSE re-subscribe failed (" + (key || "<root>") + "): " + err.message);
            });
          }
        }
      } catch (err) {
        if (!sub.stop && !this.sseStopped) {
          this.log(`opencode SSE subscribe error (${key || "<root>"}): ${err.message}; resubscribing`);
          this.scheduleResubscribe(key);
          const graceMs = Number(process.env.OPENCODE_BRIDGE_SSE_GRACE_MS || 20000);
          setTimeout(() => {
            if (!sub.stop && !this.sseStopped) {
              this.failAllRunning(`opencode SSE 订阅出错且未在宽限期内恢复（${err.message}），请重试。`, key);
            }
          }, graceMs);
        }
      } finally {
        this.sseSubs.delete(key);
      }
    })();

    return sub;
  }

  // 防抖重连：同一目录的多路断线事件只触发一路重连，避免并发订阅爆炸
  scheduleResubscribe(directory) {
    const key = String(directory || "");
    if (this._resubTimers && this._resubTimers.has(key)) return;
    if (!this._resubTimers) this._resubTimers = new Map();
    this._resubTimers.set(key, setTimeout(() => {
      this._resubTimers.delete(key);
      if (this.sseStopped) return;
      this.sseSubs.delete(key);
      this.subscribeDirectory(key).catch((err) => {
        this.log("opencode SSE re-subscribe failed (" + (key || "<root>") + "): " + err.message);
      });
    }, 3000));
  }

  async ping() {
    const resp = await fetch(`${this.serverUrl}/config`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      throw new Error(`opencode serve unreachable: HTTP ${resp.status}`);
    }
  }

  async connectWebSocket() { return this.connect(); }
  async restartSpawn() { return this.connect(); }

  async initialize() {
    return { protocolVersion: "1", serverInfo: { name: "opencode-bridge", version: "0.1.0" } };
  }

  onMessage(listener) {
    if (typeof listener === "function") this.listeners.push(listener);
  }

  emit(method, params) {
    const msg = { jsonrpc: "2.0", method, params };
    for (const l of this.listeners) {
      try { l(msg); } catch (e) { console.error(`[opencode-im] listener error: ${e.message}`); }
    }
  }

  log(m) {
    if (this.logLevel === "verbose" || this.logLevel === "debug") console.log(`[opencode-im] ${m}`);
  }

  // ── 线程 ────────────────────────────────────────────
  async startThread({ cwd } = {}) {
    // opencode 的 POST /session 通过 query 参数 ?directory= 指定工作目录
    //（body 里的 cwd 会被忽略，实测 session.directory 会固定为 serve 启动目录）。
    const url = new URL(`${this.serverUrl}/session`);
    if (cwd) {
      url.searchParams.set("directory", cwd);
    }
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Feishu chat (agent-feishu-bridge)" }),
    });
    if (!resp.ok) {
      throw new Error(`opencode create session failed: HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const sessionId = data?.id;
    if (!sessionId) {
      throw new Error("opencode create session returned no id");
    }
    const directory = cwd || data?.directory || "";
    const threadId = sessionId;
    this.threads.set(threadId, { sessionId, cwd: directory });
    this.sessionDirs.set(sessionId, directory);
    // 该目录如果还没订阅 SSE，立即订阅（opencode 事件按目录隔离）。
    // serve 根目录的会话用 serveRoot 作为 key，与 connect 里的根订阅保持一致。
    if (this.sseLoopStarted) {
      const subKey = directory || "";
      await this.subscribeDirectory(subKey).catch((err) => {
        this.log(`subscribe directory failed (${directory}): ${err.message}`);
      });
    }
    this.log(`thread/start → session ${sessionId} (dir=${directory || "<root>"})`);
    return this.threadResponse(threadId);
  }

  async resumeThread({ threadId }) {
    const normalized = String(threadId || "").trim();
    if (!normalized) throw new Error("thread/resume requires a non-empty threadId");
    const resp = await fetch(`${this.serverUrl}/session/${normalized}`, { signal: AbortSignal.timeout(5000) });
    if (resp.status === 404) throw new Error(`opencode session not found: ${normalized}`);
    if (!resp.ok) throw new Error(`opencode get session failed: HTTP ${resp.status}`);
    const data = await resp.json();
    const directory = data?.directory || "";
    this.threads.set(normalized, { sessionId: normalized, cwd: directory });
    this.sessionDirs.set(normalized, directory);
    if (this.sseLoopStarted) {
      const subKey = directory || "";
      await this.subscribeDirectory(subKey).catch((err) => {
        this.log(`subscribe directory failed (${directory}): ${err.message}`);
      });
    }
    return this.threadResponse(normalized);
  }

  threadResponse(threadId) {
    const thread = { id: threadId, threadId };
    return { result: { thread, threadId }, thread, threadId };
  }

  async listThreads({ limit = 100 } = {}) {
    // opencode 的 /session 列表只返回当前 directory 的 session。
    // 要列出所有目录的会话：查 serve 根目录 + 所有已知目录（bind 过的），合并去重。
    const directories = new Set([this.serveRoot || ""]);
    for (const dir of this.sessionDirs.values()) {
      if (dir) directories.add(dir);
    }
    const merged = new Map(); // id -> thread
    for (const dir of directories) {
      try {
        const url = new URL(`${this.serverUrl}/session`);
        url.searchParams.set("limit", String(limit));
        if (dir) url.searchParams.set("directory", dir);
        const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) continue;
        const parsed = await resp.json();
        const sessions = Array.isArray(parsed) ? parsed : [];
        for (const s of sessions) {
          const id = s?.id;
          if (!id) continue;
          merged.set(id, {
            id,
            cwd: s?.directory || dir || "",
            name: s?.title || s?.slug || "",
            updatedAt: Number(s?.time?.updated || 0),
            // 用 "unknown" 而非 "opencode"：桥的 THREAD_SOURCE_KINDS 白名单不含
            // 第三方来源名，不在白名单的 thread 会被 listThreads 过滤掉。
            source: "unknown",
          });
        }
      } catch (e) {
        this.log(`listThreads directory failed (${dir || "<root>"}): ${e.message}`);
      }
    }
    const data = [...merged.values()].slice(0, limit);
    return { result: { data }, data };
  }

  async listModels() {
    const resp = await fetch(`${this.serverUrl}/config`, { signal: AbortSignal.timeout(5000) });
    const config = resp.ok ? await resp.json() : {};
    this.configCache = config;
    this.configFetched = true;
    const models = [];
    const seen = new Set();
    const configured = config?.model || "";
    const push = (id) => {
      const n = normalizeModelId(id);
      if (n && !seen.has(n)) {
        seen.add(n);
        models.push({
          id: n,
          model: n,
          displayName: n,
          isDefault: n === normalizeModelId(configured),
          supportedReasoningEfforts: [...SUPPORTED_EFFORTS],
        });
      }
    };
    if (configured) push(configured);
    // 从 provider 配置里收集模型名
    const providers = config?.provider || {};
    for (const provider of Object.values(providers)) {
      const modelsById = provider?.models || {};
      for (const modelId of Object.keys(modelsById)) {
        push(modelId);
      }
    }
    // 保底：如果上面什么都没解析出来，给一个占位
    if (!models.length) {
      push(normalizeModelId(configured) || "zen-cpa/deepseek-v4-flash");
    }
    const data = models;
    return { data, result: { data }, models: data };
  }

  // ── 模型上下文窗口：从 /config 的 limit.context 解析 ──
  async resolveSessionContextWindow(sessionId) {
    try {
      if (!this.configFetched) {
        const resp = await fetch(`${this.serverUrl}/config`, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          this.configCache = await resp.json();
          this.configFetched = true;
        }
      }
      const providerId = "";
      let modelId = "";
      try {
        const sresp = await fetch(`${this.serverUrl}/session/${encodeURIComponent(sessionId)}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (sresp.ok) {
          const s = await sresp.json();
          const model = s?.model || {};
          modelId = String(model?.id || "");
          const pid = String(model?.providerID || "");
          const window = findModelContextWindow(this.configCache, pid, modelId);
          if (window > 0) return window;
          if (pid) {
            const providerVal = pid.startsWith("sub2/") ? pid : pid;
            const w2 = findModelContextWindow(this.configCache, providerVal, modelId);
            if (w2 > 0) return w2;
          }
        }
      } catch (e) {
        this.log(`resolveSessionContextWindow session fetch failed: ${e.message}`);
      }
      // 兜底：用默认模型（config.model）的窗口
      const fallback = findModelContextWindow(this.configCache, "", String(this.configCache?.model || "").split("/")[1] || "");
      return fallback > 0 ? fallback : 0;
    } catch (e) {
      this.log(`resolveSessionContextWindow failed: ${e.message}`);
      return 0;
    }
  }

  // ── 核心：一轮对话 ──────────────────────────────────
  async sendUserMessage({
    threadId,
    text,
    attachments = [],
    model = null,
    effort = null,
    workspaceRoot = "",
  }) {
    let tid = threadId;
    let st = this.threads.get(tid);
    if (!tid || !st) {
      ({ threadId: tid } = await this.startThread({ cwd: workspaceRoot }));
      st = this.threads.get(tid);
    }
    const sessionId = st.sessionId;
    const turnId = randomUUID();
    const key = `${sessionId}`;

    // 同一个 session 不并发跑多个 turn —— 上一轮没结束就先提示
    if (this.running.has(key)) {
      this.emit("turn/started", { threadId: tid, turnId });
      this.emit("item/completed", {
        threadId: tid,
        turnId,
        item: {
          id: `busy-${turnId}`,
          type: "agentMessage",
          text: "⏳ 上一条还在处理中。为避免同一 opencode 会话并发抢占，本条没有重复发送；请等待当前回复，或先停止当前任务后再发。",
        },
      });
      this.emit("turn/completed", { threadId: tid, turnId });
      return { threadId: tid, turnId };
    }

    // 组装发送内容：文本 + 附件路径说明
    let prompt = String(text || "");
    if (attachments && attachments.length) {
      const files = attachments.map((a) => a?.path || a?.filePath).filter(Boolean);
      if (files.length) prompt += "\n\n[附件]\n" + files.join("\n");
    }
    const parts = [{ type: "text", text: prompt }];

    const run = {
      turnId,
      buffer: "",
      toolItems: new Map(),   // callID -> { id, type, name, command }
      reasoningText: "",
      tokenUsage: null,
      settled: false,
      sawText: false,
    };
    this.running.set(key, run);

    this.emit("turn/started", { threadId: tid, turnId });

    // 确保目标目录的 SSE 订阅已就绪再发消息，否则会错过该目录会话的 idle 事件。
    // opencode 事件按目录隔离：必须等对应目录的订阅建立后才能收到该会话的事件。
    const dir = this.sessionDirs.get(sessionId) || "";
    const dirSub = this.sseSubs.get(dir);
    if (dirSub && dirSub.ready) {
      try {
        await Promise.race([
          dirSub.ready,
          new Promise((_, rej) => setTimeout(() => rej(new Error(`SSE 订阅目录就绪超时 (${dir || "<root>"})`)), 8000)),
        ]);
      } catch (e) {
        this.log(`wait dir subscribe ready: ${e.message}`);
      }
    }

    // 首事件超时：后端没动静就主动失败，不让人干等
    const fail = (reason) => {
      if (run.settled) return;
      run.settled = true;
      if (run.firstTimer) clearTimeout(run.firstTimer);
      if (run.turnTimer) clearTimeout(run.turnTimer);
      this.running.delete(key);
      this.emit("turn/failed", { threadId: tid, turnId, error: { message: reason } });
    };
    run.firstTimer = setTimeout(
      () => fail(`后端 ${Math.round(FIRST_EVENT_TIMEOUT_MS / 1000)} 秒内没有任何响应，已中止。常见原因：opencode serve 未运行、模型不可用、认证过期。`),
      FIRST_EVENT_TIMEOUT_MS
    );
    run.turnTimer = setTimeout(
      () => fail(`本轮超过 ${Math.round(TURN_TIMEOUT_MS / 60000)} 分钟未完成，已中止。`),
      TURN_TIMEOUT_MS
    );

    // 确保 SSE 订阅已建立再发消息，避免错过首轮 idle 事件
    await this.sseReady.catch(() => {});

    // 发起请求（异步，事件从 SSE 流回来）。POST 失败自动重试（postWithRetry），
    // 重试仍失败且 SSE 已开始流 → 消息其实已送达，不致命；否则 fail。
    const respPromise = postWithRetry(`${this.serverUrl}/session/${sessionId}/message`, { parts })
      .catch((err) => {
        if (!run.settled && run.sawText) {
          this.log(`POST failed but SSE flowing: ${err.message}`);
          return null;
        }
        fail(`向 opencode 发送消息失败（已重试 ${POST_RETRIES} 次）：${err.message}`);
        return null;
      });

    respPromise.then(async (resp) => {
      if (!resp || run.settled) return;
      try {
        const data = await resp.json();
        const usage = extractUsageTokenCounts(data?.info);
        if (usage) {
          run.tokenUsage = usage;
          // 补上模型上下文窗口：codex 桥的 usage 自带 modelContextWindow，
          // opencode 的 info.tokens 没有，需从 /config 的 limit.context 解析。
          // 否则卡片底部"📝 上下文 xx/xx (x%)"进度条行缺失。
          let emitUsage = usage;
          let modelWindow = 0;
          try {
            modelWindow = await this.resolveSessionContextWindow(sessionId);
            if (modelWindow > 0) {
              emitUsage = { ...usage, modelContextWindow: modelWindow };
            }
          } catch (e) {
            this.log(`resolve context window failed: ${e.message}`);
          }
          this.emit("thread/tokenUsage/updated", { threadId: tid, tokenUsage: wrapUsageForCard(emitUsage, modelWindow) });
        }
        // 同步响应里若已有最终文本且 SSE 没给过正文，补一次
        if (!run.sawText) {
          const text = extractTextFromParts(data?.parts);
          if (text) {
            run.sawText = true;
            this.emit("item/completed", {
              threadId: tid,
              turnId,
              item: { id: `msg-${turnId}`, type: "agentMessage", text },
            });
          }
        }
      } catch (e) {
        this.log(`failed to parse POST response: ${e.message}`);
      }
    });

    return { threadId: tid, turnId };
  }

  // ── SSE 事件翻译 ────────────────────────────────────
  handleSseEvent(raw) {
    if (!raw || typeof raw !== "object") return;
    const props = raw.properties || {};
    const sessionId = props.sessionID
      || (props.part && typeof props.part === "object" ? props.part.sessionID : null);
    if (!sessionId || typeof sessionId !== "string") return;
    const run = this.running.get(sessionId);
    if (!run) return;
    const tid = sessionId;
    const turnId = run.turnId;

    // 后端已有事件流入，说明会话活着：取消"首事件超时"，
    // 防止回复正在流式输出时被 60s 定时器误杀（首事件可能因模型思考而延迟）。
    if (run.firstTimer) {
      clearTimeout(run.firstTimer);
      run.firstTimer = null;
    }

    const type = raw.type;
    switch (type) {
      case "message.part.delta": {
        if (props.field !== "text") return;
        // 该 delta 若属于 reasoning part，跳过（只做推理摘要，不当正文）
        const partID = typeof props.partID === "string" ? props.partID : "";
        if (partID && this.reasoningPartIds.has(partID)) return;
        const delta = typeof props.delta === "string" ? props.delta : "";
        if (!delta) return;
        run.sawText = true;
        run.buffer += delta;
        if (run.buffer.length > MAX_TEXT_BUFFER) {
          run.buffer = run.buffer.slice(0, MAX_TEXT_BUFFER) + "\n\n…(内容过长，已截断)";
        }
        this.emit("item/agentMessage/delta", {
          threadId: tid,
          turnId,
          delta,
        });
        return;
      }

      case "message.part.updated": {
        const part = props.part || {};
        const partType = part.type;
        if (partType === "text") {
          // 正文走 message.part.delta 流式增量；这里只标记已有文本，
          // 不直接 emit（updated 会带用户消息回显和完整正文，与 delta 重复）。
          const full = typeof part.text === "string" ? part.text : "";
          if (full) {
            run.sawText = true;
            if (!run.buffer) {
              // delta 流未启动时用 updated 完整文本兜底（极少情况）
              run.buffer = full;
            }
          }
          return;
        }

        if (partType === "reasoning") {
          // 记录 reasoning part id，后续该 part 的 delta 不当正文处理
          if (typeof part.id === "string" && part.id) {
            this.reasoningPartIds.add(part.id);
          }
          if (typeof part.text === "string" && part.text) {
            run.reasoningText = mergeReasoning(run.reasoningText, part.text);
            if (run.reasoningText.length > 2400) {
              run.reasoningText = run.reasoningText.slice(0, 2399) + "…";
            }
            this.emit("item/reasoning/summaryPartAdded", {
              threadId: tid,
              turnId,
              item: { id: `reasoning-${turnId}`, type: "reasoning" },
              summary: run.reasoningText,
            });
          }
          return;
        }

        if (partType === "tool") {
          const callID = part.callID;
          const toolName = part.tool;
          const state = part.state || {};
          const status = String(state.status || "").toLowerCase();
          if (!callID) return;

          const type = toolName === "bash" ? "commandExecution" : "mcpToolCall";
          const command = typeof state.input?.command === "string"
            ? String(state.input.command).slice(0, 400)
            : typeof state.input?.cmd === "string"
              ? String(state.input.cmd).slice(0, 400)
              : undefined;

          if (status === "pending" || status === "running" || !run.toolItems.has(callID)) {
            if (!run.toolItems.has(callID)) {
              run.toolItems.set(callID, { id: callID, type, name: toolName, command });
            }
            this.emit("item/started", {
              threadId: tid,
              turnId,
              item: run.toolItems.get(callID),
            });
            return;
          }

          if (status === "completed" || status === "error") {
            if (run.toolItems.has(callID)) {
              this.emit("item/completed", {
                threadId: tid,
                turnId,
                item: {
                  ...run.toolItems.get(callID),
                  status: status === "error" ? "failed" : "completed",
                },
              });
              run.toolItems.delete(callID);
            } else {
              this.emit("item/completed", {
                threadId: tid,
                turnId,
                item: { id: callID, type, name: toolName, status: status === "error" ? "failed" : "completed" },
              });
            }
            return;
          }
          return;
        }
        return;
      }

      case "session.status": {
        const statusType = props.status?.type;
        if (statusType === "idle") {
          this.completeTurn(sessionId, run, tid, turnId);
        }
        return;
      }

      case "session.idle": {
        this.completeTurn(sessionId, run, tid, turnId);
        return;
      }

      default:
        return;
    }
  }

  completeTurn(sessionId, run, tid, turnId) {
    if (!run || run.settled) return;
    run.settled = true;
    if (run.firstTimer) clearTimeout(run.firstTimer);
    if (run.turnTimer) clearTimeout(run.turnTimer);
    this.running.delete(sessionId);

    // 把还没 close 的 tool item 收尾
    for (const item of run.toolItems.values()) {
      this.emit("item/completed", { threadId: tid, turnId, item: { ...item, status: "completed" } });
    }
    run.toolItems.clear();

    this.emit("turn/completed", { threadId: tid, turnId });
  }

  failAllRunning(reason, directory) {
    const reasonMsg = reason || "opencode SSE 连接中断，本回合结果可能不完整，请重试。";
    let failed = 0;
    for (const [sid, run] of this.running.entries()) {
      if (!run || run.settled) continue;
      run.settled = true;
      if (run.firstTimer) clearTimeout(run.firstTimer);
      if (run.turnTimer) clearTimeout(run.turnTimer);
      this.running.delete(sid);
      this.emit("turn/failed", { threadId: sid, turnId: run.turnId, error: { message: reasonMsg } });
      failed++;
    }
    if (failed > 0) {
      this.log("failAllRunning" + (directory ? " (" + directory + ")" : "") + ": failed " + failed + " pending turn(s): " + reasonMsg);
    }
    return failed;
  }

  // ── 兼容桥调用的其余方法 ────────────────────────────
  async sendRequest(method, params = {}) {
    switch (method) {
      case "thread/start": return this.startThread({ cwd: params?.cwd });
      case "thread/resume": return this.resumeThread({ threadId: params?.threadId });
      case "thread/list": return this.listThreads({ limit: params?.limit });
      case "model/list": return this.listModels();
      case "turn/start": return this.sendUserMessage({
        threadId: params?.threadId,
        text: extractText(params?.input),
        model: params?.model,
        effort: params?.effort,
        accessMode: params?.accessMode,
        workspaceRoot: params?.workspaceRoot,
      });
      case "turn/steer": return this.steerTurn({
        threadId: params?.threadId,
        expectedTurnId: params?.expectedTurnId,
        text: extractText(params?.input),
        attachments: params?.attachments || [],
        clientUserMessageId: params?.clientUserMessageId || "",
      });
      case "turn/interrupt": return this.interrupt(params?.threadId);
      default:
        this.log(`unhandled method ${method}`);
        return {};
    }
  }

  async sendNotification() { return {}; }
  async sendResponse() { return {}; }
  sendRaw() { return {}; }

  /**
   * 运行中引导：向正在跑的 opencode 会话注入一条新消息。
   * opencode 的 POST /session/{id}/message 在会话忙碌时会把它当作对当前
   * turn 的追加输入（实测可穿透），后续 SSE delta 仍走当前 turn 的事件流。
   * 与 sendUserMessage 的区别：不做 busy 拒绝、不新建 turnId，直接注入。
   */
  async steerTurn({ threadId, expectedTurnId, text, attachments = [], clientUserMessageId = "" } = {}) {
    const normalized = String(threadId || "").trim();
    const expected = String(expectedTurnId || "").trim();
    if (!normalized) throw new Error("turn/steer requires a non-empty threadId");
    if (!expected) throw new Error("turn/steer requires a non-empty expectedTurnId");

    const run = this.running.get(normalized);
    if (!run) {
      throw new Error(`turn/steer failed: session ${normalized} is not running`);
    }
    if (run.turnId !== expected) {
      throw new Error("turn/steer failed: active turn changed before submission");
    }
    if (!String(text || "").trim()) {
      throw new Error("turn/steer requires non-empty input");
    }

    let prompt = String(text || "");
    if (attachments && attachments.length) {
      const files = attachments.map((a) => a?.path || a?.filePath).filter(Boolean);
      if (files.length) prompt += "\n\n[附件]\n" + files.join("\n");
    }

    await postWithRetry(`${this.serverUrl}/session/${normalized}/message`, { parts: [{ type: "text", text: prompt }] })
      .catch((err) => {
        // An accepted Feishu steer whose backend POST failed is a lost instruction.
        // SSE staying alive only proves another request is running; it is not an ACK.
        throw new Error(`向 opencode 注入引导消息失败（已重试 ${POST_RETRIES} 次）：${err.message}`);
      });

    return { threadId: normalized, turnId: run.turnId };
  }

  async interrupt(threadId) {
    const normalized = String(threadId || "").trim();
    if (!normalized) return {};
    const run = this.running.get(normalized);
    if (run) {
      try {
        await fetch(`${this.serverUrl}/session/${normalized}/abort`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(5000),
        });
      } catch (e) {
        this.log(`interrupt abort failed: ${e.message}`);
      }
      run.settled = true;
      if (run.firstTimer) clearTimeout(run.firstTimer);
      if (run.turnTimer) clearTimeout(run.turnTimer);
      this.running.delete(normalized);
      this.emit("turn/cancelled", { threadId: normalized, turnId: run.turnId });
    }
    return {};
  }

  // ── SSE 订阅生命周期 ──────────────────────────────
  // 用官方 @opencode-ai/sdk 的 event.subscribe() 订阅事件（与 opencode-lark 一致，
  // 已实测可用）。不要在底层手写 fetch+reader —— SDK 的 createSseClient 才是被
  // 验证过的路径。SDK 是 ESM，桥是 CJS，所以用动态 import()。
  stopSseLoop() {
    this.sseStopped = true;
    // 停止所有目录的 SSE 订阅
    for (const [dir, sub] of this.sseSubs.entries()) {
      sub.stop = true;
      try { sub.controller.abort(); } catch {}
      this.log(`SSE subscription stopped (directory=${dir || "<root>"})`);
    }
    this.sseSubs.clear();
  }

  killAll() { this.stopSseLoop(); this.running.clear(); }
  rejectAllPending() { this.killAll(); }
  getRequestTimeoutMs() { return 300000; }
  handleIncoming() {}
}

function mergeReasoning(current, incoming) {
  const a = String(current || "").trim();
  const b = String(incoming || "").trim();
  if (!a) return b;
  if (!b) return a;
  if (a.includes(b)) return a;
  if (b.includes(a)) return b;
  return `${a}\n${b}`.trim();
}

function extractText(input) {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input.map((x) => (typeof x === "string" ? x : x?.text || "")).filter(Boolean).join("\n");
  }
  return input.text || "";
}

module.exports = {
  OpencodeRpcClient,
  // 兼容 runtime 的统一解构：CodexRpcClient 指向 opencode 适配器
  CodexRpcClient: OpencodeRpcClient,
};
