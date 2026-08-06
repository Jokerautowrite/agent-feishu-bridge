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
const FIRST_EVENT_TIMEOUT_MS = Number(process.env.OPENCODE_BRIDGE_FIRST_EVENT_MS || 60000);
// 单轮总时长上限
const TURN_TIMEOUT_MS = Number(process.env.OPENCODE_BRIDGE_TURN_MS || 1200000);
const MAX_TEXT_BUFFER = 102_400;
const SUPPORTED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

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

class OpencodeRpcClient {
  constructor(opts = {}) {
    this.serverUrl = opts.serverUrl || DEFAULT_SERVER_URL;
    this.agent = opts.agent || DEFAULT_AGENT;
    this.logLevel = opts.logLevel || "normal";
    this.listeners = [];
    this.threads = new Map();        // threadId -> opencode sessionId + cwd
    this.running = new Map();        // sessionId -> { turnId, timers, buffer, toolItems, reasoning, tokenUsage }
    this.sseAbort = null;
    this.sseStopped = false;
    this.connected = false;
    this.sseLoopStarted = false;
    this.sseReadyResolve = null;
    this.sseReady = new Promise((resolve) => { this.sseReadyResolve = resolve; });
  }

  // ── 生命周期 ────────────────────────────────────────
  async connect() {
    this.log("connecting to opencode serve");
    await this.ping();
    this.connected = true;
    // 常驻 SSE 循环必须在任何消息发出前就绪，否则会错过首轮 idle 事件
    if (!this.sseLoopStarted) {
      this.sseLoopStarted = true;
      this.startSseLoop().catch((error) => {
        console.error(`[opencode-im] SSE loop failed: ${error.message}`);
      });
    }
    return true;
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
    const resp = await fetch(`${this.serverUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Feishu chat (agent-feishu-bridge)", cwd: cwd || undefined }),
    });
    if (!resp.ok) {
      throw new Error(`opencode create session failed: HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const sessionId = data?.id;
    if (!sessionId) {
      throw new Error("opencode create session returned no id");
    }
    const threadId = sessionId;
    this.threads.set(threadId, { sessionId, cwd: cwd || "" });
    this.log(`thread/start → session ${sessionId}`);
    return this.threadResponse(threadId);
  }

  async resumeThread({ threadId }) {
    const normalized = String(threadId || "").trim();
    if (!normalized) throw new Error("thread/resume requires a non-empty threadId");
    const resp = await fetch(`${this.serverUrl}/session/${normalized}`, { signal: AbortSignal.timeout(5000) });
    if (resp.status === 404) throw new Error(`opencode session not found: ${normalized}`);
    if (!resp.ok) throw new Error(`opencode get session failed: HTTP ${resp.status}`);
    const data = await resp.json();
    this.threads.set(normalized, { sessionId: normalized, cwd: data?.directory || "" });
    return this.threadResponse(normalized);
  }

  threadResponse(threadId) {
    const thread = { id: threadId, threadId };
    return { result: { thread, threadId }, thread, threadId };
  }

  async listThreads({ limit = 100 } = {}) {
    const resp = await fetch(`${this.serverUrl}/session?limit=${limit}`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`opencode list sessions failed: HTTP ${resp.status}`);
    const sessions = Array.isArray(await resp.json()) ? await resp.json() : [];
    const data = sessions.map((s) => ({
      id: s?.id,
      cwd: s?.directory || "",
      name: s?.title || s?.slug || "",
      updatedAt: Number(s?.time?.updated || 0),
      source: "opencode",
    })).filter((t) => t.id);
    return { result: { data }, data };
  }

  async listModels() {
    const resp = await fetch(`${this.serverUrl}/config`, { signal: AbortSignal.timeout(5000) });
    const config = resp.ok ? await resp.json() : {};
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

    // 发起请求（异步，事件从 SSE 流回来）
    const respPromise = fetch(`${this.serverUrl}/session/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts }),
    }).catch((err) => {
      if (!run.settled && run.sawText) {
        // SSE 已经在流，POST 响应丢失不致命
        this.log(`POST failed but SSE flowing: ${err.message}`);
        return null;
      }
      fail(`向 opencode 发送消息失败：${err.message}`);
      return null;
    });

    respPromise.then(async (resp) => {
      if (!resp || run.settled) return;
      try {
        const data = await resp.json();
        const usage = extractUsageTokenCounts(data?.info);
        if (usage) {
          run.tokenUsage = usage;
          this.emit("thread/tokenUsage/updated", { threadId: tid, tokenUsage: usage });
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

    const type = raw.type;
    switch (type) {
      case "message.part.delta": {
        if (props.field !== "text") return;
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
          const delta = props.delta || part.text;
          if (typeof delta === "string" && delta) {
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
          }
          return;
        }

        if (partType === "reasoning") {
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
      case "turn/interrupt": return this.interrupt(params?.threadId);
      default:
        this.log(`unhandled method ${method}`);
        return {};
    }
  }

  async sendNotification() { return {}; }
  async sendResponse() { return {}; }
  sendRaw() { return {}; }

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
  async startSseLoop() {
    let sdk;
    try {
      sdk = await import("@opencode-ai/sdk/v2");
    } catch (e) {
      console.error(`[opencode-im] @opencode-ai/sdk not found: ${e.message}`);
      return;
    }
    const controller = new AbortController();
    this.sseAbort = controller;
    try {
      const client = sdk.createOpencodeClient({ baseUrl: this.serverUrl });
      const events = await client.event.subscribe();
      this.log("opencode SSE stream connected");
      for await (const ev of events.stream) {
        if (this.sseStopped) break;
        if (this.sseReadyResolve) {
          const r = this.sseReadyResolve;
          this.sseReadyResolve = null;
          r();
        }
        this.handleSseEvent(ev);
      }
      this.log("opencode SSE stream ended");
    } catch (err) {
      if (!this.sseStopped) {
        this.log(`opencode SSE loop error: ${err.message}; retrying in 3s`);
        await new Promise((r) => setTimeout(r, 3000));
        this.sseAbort = null;
        return this.startSseLoop();
      }
    }
  }

  stopSseLoop() {
    this.sseStopped = true;
    if (this.sseAbort) {
      try { this.sseAbort.abort(); } catch {}
      this.sseAbort = null;
    }
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
};
