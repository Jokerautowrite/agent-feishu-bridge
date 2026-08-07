"use strict";
/**
 * ClaudeRpcClient —— 把 Claude Code 伪装成 Codex app-server
 *
 * 这个桥（Jiao-Joe/codex-feishu-bridge 二开）是 DDD 分层的，domain/app/presentation
 * 共 6900 行全都不认识后端，只认 infra/codex 那套 JSON-RPC 契约。
 * 所以换后端 = 实现同一套契约的另一个 infra 适配器。**其余一行不用改。**
 *
 * 契约（从 rpc-client.js + codex-event-service.js 扒出来的）：
 *   出：thread/start · thread/resume · turn/start · thread/list · model/list
 *   入：turn/started · item/started · item/completed · turn/completed · turn/failed
 *       · thread/tokenUsage/updated
 *   item.type: agentMessage / userMessage / commandExecution / mcpToolCall / webSearch
 *
 * Claude 侧用 `claude -p --output-format stream-json`，把流式事件翻成上面那套。
 */
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const path = require("path");
const os = require("os");

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const DEFAULT_CWD = process.env.CLAUDE_BRIDGE_CWD || os.homedir();
const SUPPORTED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const STATIC_MODEL_CATALOG = [
  { id: "claude-fable-5", displayName: "Fable 5" },
  { id: "claude-opus-4-8", displayName: "Opus 4.8" },
  { id: "claude-sonnet-5", displayName: "Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
];
// 首个事件的等待上限：超过就认定后端没起来，主动失败而不是让人干等
const FIRST_EVENT_TIMEOUT_MS = Number(process.env.CLAUDE_BRIDGE_FIRST_EVENT_MS || 45000);
// 整轮上限：Claude 干长活很正常，给宽一点，但不能无限
const TURN_TIMEOUT_MS = Number(process.env.CLAUDE_BRIDGE_TURN_MS || 900000);

/**
 * 剥掉模型名的方括号后缀。
 * 2026-07-27 实测：`--model claude-fable-5[1m]` 传给 `-p` 会一个事件都不吐，
 * 直接卡死到重试耗尽（10 次 × 60 秒）。飞书那头看起来就是"又不回消息了"——
 * 正是刚被卸掉的那个插件给老爸的体验。宁可降级到基础模型，不能静默卡死。
 */
function normalizeModel(m) {
  const s = String(m || "").trim();
  if (!s) return "";
  return s.replace(/\[[^\]]*\]\s*$/, "").trim();
}

class ClaudeRpcClient {
  constructor(opts = {}) {
    this.env = opts.env || process.env;
    this.logLevel = opts.logLevel || "info";
    this.model = opts.model || process.env.CLAUDE_BRIDGE_MODEL || "";
    this.cwd = opts.workspaceRoot || DEFAULT_CWD;
    this.listeners = [];
    this.threads = new Map();      // threadId -> { sessionId, cwd }
    this.running = new Map();      // threadId -> child process
    this.connected = false;
  }

  // ── 生命周期 ────────────────────────────────────────
  async connect() { this.connected = true; return this.connectSpawn(); }
  async connectSpawn() { this.log("claude backend ready (no persistent app-server needed)"); return true; }
  async connectWebSocket() { return this.connectSpawn(); }
  async restartSpawn() { this.killAll(); return this.connectSpawn(); }
  async initialize() {
    return { protocolVersion: "1", serverInfo: { name: "claude-code-bridge", version: "0.1.0" } };
  }
  onMessage(listener) { if (typeof listener === "function") this.listeners.push(listener); }
  emit(method, params) {
    const msg = { jsonrpc: "2.0", method, params };
    for (const l of this.listeners) {
      try { l(msg); } catch (e) { console.error(`[claude-im] listener error: ${e.message}`); }
    }
  }
  log(m) { if (this.logLevel === "verbose") console.log(`[claude-im] ${m}`); }

  // ── 线程 ────────────────────────────────────────────
  /**
   * 桥用 extractThreadId(response) = response.result.thread.id 取值。
   * 少一层 `result` 就报 "thread/start did not return a thread id"。
   * 顶层的 threadId/thread 一并保留，兼容其它读法。
   */
  async startThread({ cwd } = {}) {
    const threadId = randomUUID();
    this.threads.set(threadId, { sessionId: null, cwd: cwd || this.cwd });
    return this.threadResponse(threadId);
  }
  async resumeThread({ threadId }) {
    if (!threadId) throw new Error("thread/resume requires a non-empty threadId");
    if (!this.threads.has(threadId)) this.threads.set(threadId, { sessionId: threadId, cwd: this.cwd });
    return this.threadResponse(threadId);
  }
  threadResponse(threadId) {
    const thread = { id: threadId, threadId };
    return { result: { thread, threadId }, thread, threadId };
  }
  async listThreads() {
    const threads = [...this.threads.keys()].map((id) => ({ id, threadId: id, updatedAt: Date.now() }));
    return { result: { threads, data: threads }, threads, data: threads };
  }
  /**
   * 桥用 shared/model-catalog.js 解析：只认 response.data（或 response.result.data），
   * 每项必须有 `model` 或 `id`，effort 走 supportedReasoningEfforts。
   * 返回值形状对不上会在启动时抛 "model/list returned no models"。
   */
  async listModels() {
    const configuredModel = normalizeModel(this.model);
    const modelIds = [
      ...new Set([
        configuredModel,
        ...STATIC_MODEL_CATALOG.map((item) => item.id),
      ].filter(Boolean)),
    ];
    const defaultModel = configuredModel || modelIds[0];
    const displayNames = new Map(
      STATIC_MODEL_CATALOG.map((item) => [item.id, item.displayName])
    );
    const data = modelIds.map((id) => ({
      id,
      model: id,
      displayName: displayNames.get(id) || id,
      isDefault: id === defaultModel,
      supportedReasoningEfforts: [...SUPPORTED_EFFORTS],
    }));
    return { data, models: data };
  }

  // ── 核心：一轮对话 ──────────────────────────────────
  async sendUserMessage({
    threadId,
    text,
    attachments = [],
    model = null,
    effort = null,
    accessMode = null,
    workspaceRoot = "",
  }) {
    let tid = threadId;
    if (!tid) ({ threadId: tid } = await this.startThread({ cwd: workspaceRoot }));
    const st = this.threads.get(tid) || { sessionId: null, cwd: workspaceRoot || this.cwd };
    const turnId = randomUUID();

    // Claude CLI 的 --resume 不能并发复用同一个 session。飞书端连续催问时，
    // 直接并发 spawn 会让多个 Claude 子进程互相抢会话，表现为卡住不回。
    if (this.running.has(tid)) {
      this.emit("turn/started", { threadId: tid, turnId });
      this.emit("item/completed", {
        threadId: tid,
        turnId,
        item: {
          id: `busy-${turnId}`,
          type: "agentMessage",
          text: "⏳ 上一条还在处理中。为避免同一 Claude 会话并发抢占，本条没有重复发送；请等待当前回复，或先停止当前任务后再发。",
        },
      });
      this.emit("turn/completed", { threadId: tid, turnId });
      return { threadId: tid, turnId };
    }

    let prompt = String(text || "");
    if (attachments.length) {
      const files = attachments.map((a) => a?.path || a?.filePath).filter(Boolean);
      if (files.length) prompt += "\n\n[附件]\n" + files.join("\n");
    }

    const args = ["-p", prompt,
      "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
    const rawModel = model || this.model;
    const m = normalizeModel(rawModel);
    if (m) args.push("--model", m);
    if (m !== String(rawModel || "").trim() && rawModel) {
      this.log(`model "${rawModel}" → "${m}"（剥掉方括号后缀，否则 -p 会静默卡死）`);
    }
    const normalizedEffort = normalizeEffort(effort);
    if (normalizedEffort) args.push("--effort", normalizedEffort);
    if (isFullAccess(accessMode)) args.push("--dangerously-skip-permissions");
    if (st.sessionId) args.push("--resume", st.sessionId);

    this.emit("turn/started", { threadId: tid, turnId });

    const child = spawn(CLAUDE_BIN, args, {
      cwd: st.cwd, env: this.env, stdio: ["ignore", "pipe", "pipe"],
    });
    this.running.set(tid, child);

    let buf = "";
    let sawText = false;
    let settled = false;
    const openItems = new Map();

    // ── 超时兜底 ──────────────────────────────────────
    // 沉默失败是最坏的结果：老爸看不到任何东西，也不知道该不该等。
    // 宁可告诉他"我失败了"，也不能让他干等。
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch {}
      this.running.delete(tid);
      this.emit("turn/failed", { threadId: tid, turnId, error: { message: reason } });
    };
    let firstTimer = setTimeout(
      () => fail(`后端 ${Math.round(FIRST_EVENT_TIMEOUT_MS / 1000)} 秒内没有任何响应，已中止。常见原因：上游不可用、模型名无效、认证过期。`),
      FIRST_EVENT_TIMEOUT_MS
    );
    const turnTimer = setTimeout(
      () => fail(`本轮超过 ${Math.round(TURN_TIMEOUT_MS / 60000)} 分钟未完成，已中止。`),
      TURN_TIMEOUT_MS
    );
    const clearFirst = () => { if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; } };

    child.stdout.on("data", (chunk) => {
      clearFirst();                       // 有任何输出就说明后端活着
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        sawText = this.translate(ev, tid, turnId, st, openItems) || sawText;
      }
    });

    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });

    child.on("close", (code) => {
      clearFirst(); clearTimeout(turnTimer);
      if (settled) return;               // 已经被超时兜底判过，不重复发终态
      settled = true;
      this.running.delete(tid);
      for (const [id, type] of openItems) {
        this.emit("item/completed", { threadId: tid, turnId, item: { id, type } });
      }
      if (code === 0) {
        this.emit("turn/completed", { threadId: tid, turnId });
      } else {
        this.emit("turn/failed", {
          threadId: tid, turnId,
          error: { message: (stderr || `claude exited ${code}`).slice(0, 600) },
        });
      }
    });
    child.on("error", (err) => {
      clearFirst(); clearTimeout(turnTimer);
      if (settled) return;
      settled = true;
      this.running.delete(tid);
      this.emit("turn/failed", { threadId: tid, turnId, error: { message: err.message } });
    });

    return { threadId: tid, turnId };
  }

  /** Claude stream-json 事件 → 桥认识的 Codex 事件。返回是否产出过正文。 */
  translate(ev, threadId, turnId, st, openItems) {
    const t = ev?.type;

    if (t === "system" && ev.subtype === "init") {
      if (ev.session_id) { st.sessionId = ev.session_id; this.threads.set(threadId, st); }
      return false;
    }

    // 上游抖动时 Claude 会自己重试（可能 10 次 × 60 秒）。
    // 不透出的话，飞书那头就是纯静默——必须让人看见"在重试"，而不是以为死了。
    if (t === "system" && ev.subtype === "api_retry") {
      const wait = Math.round((ev.retry_delay_ms || 0) / 1000);
      this.emit("item/completed", {
        threadId, turnId,
        item: {
          id: `retry-${turnId}-${ev.attempt || 0}`,
          type: "agentMessage",
          text: `⏳ 上游返回 ${ev.error_status || "错误"}，第 ${ev.attempt || 1}/${ev.max_retries || "?"} 次重试，等待 ${wait}s…`,
        },
      });
      return false;
    }

    // 流式正文增量 —— 桥靠这个做打字机效果
    if (t === "stream_event") {
      const d = ev.event?.delta;
      if (d?.type === "text_delta" && d.text) {
        this.emit("item/started", {
          threadId, turnId,
          item: { id: `msg-${turnId}`, type: "agentMessage", text: d.text, streaming: true },
        });
        openItems.set(`msg-${turnId}`, "agentMessage");
        return true;
      }
      return false;
    }

    if (t === "assistant") {
      let produced = false;
      for (const c of ev.message?.content || []) {
        if (c.type === "text" && c.text) {
          this.emit("item/completed", {
            threadId, turnId,
            item: { id: `msg-${turnId}`, type: "agentMessage", text: c.text },
          });
          openItems.delete(`msg-${turnId}`);
          produced = true;
        } else if (c.type === "tool_use") {
          const id = c.id || randomUUID();
          const isShell = /^(Bash|BashOutput)$/.test(c.name);
          const type = isShell ? "commandExecution" : "mcpToolCall";
          this.emit("item/started", {
            threadId, turnId,
            item: {
              id, type, name: c.name,
              command: isShell ? String(c.input?.command || "").slice(0, 400) : undefined,
              arguments: isShell ? undefined : c.input,
            },
          });
          openItems.set(id, type);
        }
      }
      const u = ev.message?.usage;
      if (u) {
        this.emit("thread/tokenUsage/updated", {
          threadId,
          tokenUsage: {
            inputTokens: u.input_tokens || 0,
            outputTokens: u.output_tokens || 0,
            totalTokens: (u.input_tokens || 0) + (u.output_tokens || 0),
          },
        });
      }
      return produced;
    }

    if (t === "user") {
      for (const c of ev.message?.content || []) {
        if (c.type === "tool_result" && openItems.has(c.tool_use_id)) {
          const type = openItems.get(c.tool_use_id);
          this.emit("item/completed", {
            threadId, turnId,
            item: {
              id: c.tool_use_id, type,
              output: typeof c.content === "string" ? c.content.slice(0, 2000) : undefined,
              status: c.is_error ? "failed" : "completed",
            },
          });
          openItems.delete(c.tool_use_id);
        }
      }
      return false;
    }

    if (t === "result") {
      if (ev.session_id) { st.sessionId = ev.session_id; this.threads.set(threadId, st); }
      if (ev.is_error) {
        this.emit("turn/failed", {
          threadId, turnId, error: { message: String(ev.result || "unknown error").slice(0, 600) },
        });
      }
      return false;
    }
    return false;
  }

  // ── 兼容桥调用的其余方法 ────────────────────────────
  async sendRequest(method, params = {}) {
    switch (method) {
      case "thread/start": return this.startThread({ cwd: params?.cwd });
      case "thread/resume": return this.resumeThread({ threadId: params?.threadId });
      case "thread/list": return this.listThreads();
      case "model/list": return this.listModels();
      case "turn/start": return this.sendUserMessage({
        threadId: params?.threadId,
        text: extractText(params?.input),
        model: params?.model,
        effort: params?.effort,
        accessMode: params?.accessMode,
      });
      case "turn/interrupt": return this.interrupt(params?.threadId);
      default: this.log(`unhandled method ${method}`); return {};
    }
  }
  async sendNotification() { return {}; }
  async sendResponse() { return {}; }
  sendRaw() { return {}; }
  interrupt(threadId) {
    const c = this.running.get(threadId);
    if (c) { c.kill("SIGTERM"); this.running.delete(threadId); }
    this.emit("turn/cancelled", { threadId });
    return {};
  }
  killAll() { for (const c of this.running.values()) { try { c.kill("SIGTERM"); } catch {} } this.running.clear(); }
  rejectAllPending() { this.killAll(); }
  getRequestTimeoutMs() { return 300000; }
  handleIncoming() {}
}

function normalizeEffort(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return SUPPORTED_EFFORTS.has(normalized) ? normalized : "";
}

function isFullAccess(value) {
  return String(value || "").trim().toLowerCase() === "full-access";
}

function extractText(input) {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input.map((x) => (typeof x === "string" ? x : x?.text || "")).filter(Boolean).join("\n");
  }
  return input.text || "";
}

module.exports = { ClaudeRpcClient, CodexRpcClient: ClaudeRpcClient };
