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
const { spawn, execFile } = require("child_process");
const { randomUUID } = require("crypto");
const path = require("path");
const os = require("os");

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const DEFAULT_CWD = process.env.CLAUDE_BRIDGE_CWD || os.homedir();
const SUPPORTED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
// 模型目录的真源是「cc-switch 当前 Claude provider 的上游 /v1/models」。
// 2026-09-27 之前这里硬编码了 opencodex 的 sub2/* 路由名，但桥早已改走
// cc-switch(15721) 不再经过 opencodex，那些名字在飞书选择器里就是死条目。
const CC_SWITCH_DB = process.env.CC_SWITCH_DB
  || path.join(os.homedir(), ".cc-switch", "cc-switch.db");
const CC_SWITCH_PYTHON = process.env.CLAUDE_BRIDGE_PYTHON || "python3";
const MODEL_CATALOG_TTL_MS = Number(process.env.CLAUDE_BRIDGE_MODEL_CATALOG_TTL_MS || 300000);
// 启动时会走一次模型目录刷新，超时要留足余量（外层 15s 就判失败）
const UPSTREAM_MODELS_TIMEOUT_MS = Number(process.env.CLAUDE_BRIDGE_MODELS_TIMEOUT_MS || 6000);
// 拉上游失败时的兜底：Claude Code 的档位名，桥默认模型就靠这些档位映射到上游模型
const STATIC_MODEL_CATALOG = [
  { id: "claude-fable-5", displayName: "DeepSeek Flash (Fable档)" },
  { id: "claude-opus-4-8", displayName: "Opus 4.8" },
  { id: "claude-sonnet-5", displayName: "Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
];
const CC_SWITCH_PROVIDER_QUERY = [
  "import sqlite3, json, sys",
  "try:",
  "    conn = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True, timeout=2)",
  "    row = conn.execute(\"SELECT settings_config FROM providers WHERE app_type='claude' AND is_current=1 LIMIT 1\").fetchone()",
  "    env = (json.loads(row[0]).get('env') or {}) if row else {}",
  "    print(json.dumps({'baseUrl': env.get('ANTHROPIC_BASE_URL', ''), 'apiKey': env.get('ANTHROPIC_AUTH_TOKEN', '')}))",
  "except Exception:",
  "    print('{}')",
].join("\n");

/**
 * 读 cc-switch 里当前 Claude provider 的上游地址与 key。
 * 桥自身只拿到 15721 这个本地代理地址，上游凭据只有 cc-switch 的库里才有。
 */
function readCcSwitchClaudeProvider() {
  return new Promise((resolve) => {
    execFile(
      CC_SWITCH_PYTHON,
      ["-c", CC_SWITCH_PROVIDER_QUERY, CC_SWITCH_DB],
      { timeout: 3000, maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error) return resolve(null);
        try {
          const parsed = JSON.parse(String(stdout || "").trim() || "{}");
          resolve(parsed && parsed.baseUrl && parsed.apiKey ? parsed : null);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/** 拉上游 /v1/models，返回模型 id 列表。 */
async function fetchUpstreamModelIds({ baseUrl, apiKey }) {
  const url = String(baseUrl).replace(/\/+$/, "") + "/models";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_MODELS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, "x-api-key": apiKey },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const raw = Array.isArray(body?.data) ? body.data
      : Array.isArray(body?.models) ? body.models : [];
    return raw
      .map((item) => (typeof item === "string" ? item : item?.id))
      .map((id) => String(id || "").trim())
      .filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}
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

/**
 * 把平铺用量包成卡片端期望的 { last:{...}, modelContextWindow } 结构。
 * 卡片 formatContextText 只认 tokenUsage.last.totalTokens + modelContextWindow，
 * 平铺结构会让「📝 上下文 xx/xx (x%)」进度条整行缺失。
 * （与 opencode 后端 wrapUsageForCard 保持同一契约。）
 */
function buildCardUsage(usage, modelContextWindow) {
  const inputTokens = Number(usage?.inputTokens || 0);
  const outputTokens = Number(usage?.outputTokens || 0);
  const last = {
    inputTokens,
    outputTokens,
    totalTokens: Number(usage?.totalTokens || (inputTokens + outputTokens)),
  };
  const out = { last };
  if (modelContextWindow > 0) out.modelContextWindow = modelContextWindow;
  return out;
}

class ClaudeRpcClient {
  constructor(opts = {}) {
    this.env = opts.env || process.env;
    this.logLevel = opts.logLevel || "info";
    this.model = opts.model || process.env.CLAUDE_BRIDGE_MODEL || "";
    this.cwd = opts.workspaceRoot || DEFAULT_CWD;
    this.command = opts.command || CLAUDE_BIN;
    this.commandArgs = Array.isArray(opts.commandArgs) ? opts.commandArgs : [];
    this.listeners = [];
    this.threads = new Map();      // threadId -> { sessionId, cwd }
    this.running = new Map();      // threadId -> child process
    this.sessionStore = opts.sessionStore || null;
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
    const persisted = this.sessionStore?.getBackendSession(threadId) || {};
    const cwd = persisted.cwd || this.cwd;
    this.threads.set(threadId, {
      sessionId: persisted.sessionId || null,
      cwd,
    });
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
    const upstreamIds = await this.loadUpstreamModelIds();
    const staticNames = new Map(STATIC_MODEL_CATALOG.map((item) => [item.id, item.displayName]));
    const entries = [];
    const seen = new Set();
    const push = (id) => {
      const key = String(id || "").trim();
      if (!key) return;
      const lower = key.toLowerCase();
      // sub2/* 是 opencodex 的路由名，桥不再经过 opencodex，列出来也选不动
      if (seen.has(lower) || lower.startsWith("sub2/")) return;
      seen.add(lower);
      entries.push({
        id: key,
        model: key,
        displayName: staticNames.get(key) || key,
        isDefault: key === configuredModel,
        supportedReasoningEfforts: [...SUPPORTED_EFFORTS],
      });
    };
    // 桥当前配置的模型必须进列表且排第一：飞书卡片的当前选中项靠它定位
    push(configuredModel);
    if (upstreamIds.length) {
      for (const id of upstreamIds) push(id);
    } else {
      for (const item of STATIC_MODEL_CATALOG) push(item.id);
    }
    if (entries.length && !entries.some((item) => item.isDefault)) {
      entries[0].isDefault = true;
    }
    return { data: entries, models: entries };
  }

  /**
   * 当前 provider 的上游模型 id，带 TTL 缓存。
   * 拉取失败时退回上一次成功的结果，避免在网络抖动时把选择器清空。
   */
  async loadUpstreamModelIds() {
    const now = Date.now();
    if (this.upstreamCache && now - this.upstreamCache.at < MODEL_CATALOG_TTL_MS) {
      return this.upstreamCache.ids;
    }
    let ids = [];
    try {
      const provider = await readCcSwitchClaudeProvider();
      if (provider) {
        ids = await fetchUpstreamModelIds(provider);
      } else {
        this.log("未读到 cc-switch 当前 Claude provider，模型列表回退静态目录");
      }
    } catch (error) {
      this.log(`拉取上游模型列表失败：${error.message}`);
    }
    if (!ids.length && this.upstreamCache?.ids?.length) {
      return this.upstreamCache.ids;
    }
    this.upstreamCache = { at: now, ids };
    return ids;
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
    const st = this.threads.get(tid) || {
      ...(this.sessionStore?.getBackendSession(tid) || {}),
      cwd: workspaceRoot || this.cwd,
    };
    st.resultFailed = false;
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
    // 附件用 Claude Code 的 @路径 引用语法（而非纯文本路径）：
    // 这样 Claude 会真正 Read 文件；图片（多模态）才会被"看见"，纯文本拼路径读不出图。
    if (attachments.length) {
      const files = attachments.map((a) => a?.path || a?.filePath).filter(Boolean);
      if (files.length) prompt += "\n\n附件：\n" + files.map((f) => `@${f}`).join("\n");
    }

    const args = [...this.commandArgs, "-p", prompt,
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

    const child = spawn(this.command, args, {
      cwd: st.cwd, env: this.env, stdio: ["ignore", "pipe", "pipe"],
    });

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
    // 运行态带 cancel：/stop（turn/interrupt）经它把 settled 置位并杀子进程，
    // 这样 close 回调不会再补发一次终态（否则停止后会多冒一条"失败"）。
    const entry = {
      child,
      turnId,
      cancel: () => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGTERM"); } catch {}
        this.running.delete(tid);
      },
    };
    this.running.set(tid, entry);
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
      if (code === 0 && !st.resultFailed) {
        this.emit("turn/completed", { threadId: tid, turnId });
      } else if (!st.resultFailed) {
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

  persistBackendSession(threadId, state) {
    if (!this.sessionStore || !state?.sessionId) {
      return;
    }
    try {
      this.sessionStore.setBackendSession(threadId, {
        sessionId: state.sessionId,
        cwd: state.cwd,
      });
    } catch (error) {
      this.log(`failed to persist Claude session mapping: ${error.message}`);
    }
  }

  /** Claude stream-json 事件 → 桥认识的 Codex 事件。返回是否产出过正文。 */
  translate(ev, threadId, turnId, st, openItems) {
    const t = ev?.type;

    if (t === "system" && ev.subtype === "init") {
      if (ev.session_id) {
        st.sessionId = ev.session_id;
        this.threads.set(threadId, st);
        this.persistBackendSession(threadId, st);
      }
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

    // 流式正文增量 —— 桥靠这个做打字机效果。
    // 契约是 item/agentMessage/delta（opencode/grok/chuang 后端都发这个），
    // 桥的 message-utils 只认 delta 和 item/completed(agentMessage) 当正文；
    // 之前发 item/started(streaming) 会被消息层整个丢弃，飞书端只有最后
    // item/completed 那一下才出字，长回答表现为长时间转圈后整段冒出。
    if (t === "stream_event") {
      const d = ev.event?.delta;
      if (d?.type === "text_delta" && d.text) {
        this.emit("item/agentMessage/delta", {
          threadId, turnId, delta: d.text,
        });
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
          tokenUsage: buildCardUsage(
            { inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0 },
            st.contextWindow || 0
          ),
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
      if (ev.session_id) {
        st.sessionId = ev.session_id;
        this.threads.set(threadId, st);
        this.persistBackendSession(threadId, st);
      }
      // 用量与上下文窗口：Claude 在 result 里给 modelUsage[<model>].contextWindow，
      // 这是卡片「📝 上下文 x/y (x%)」进度条的权威来源（assistant 事件里的 usage 常为 0）。
      const mu = ev.modelUsage && typeof ev.modelUsage === "object"
        ? Object.values(ev.modelUsage)[0]
        : null;
      const ctxWindow = Number(mu?.contextWindow || 0);
      if (ctxWindow > 0) st.contextWindow = ctxWindow;
      const ru = ev.usage || {};
      const inputTokens = Number(mu?.inputTokens ?? ru.input_tokens ?? 0);
      const outputTokens = Number(mu?.outputTokens ?? ru.output_tokens ?? 0);
      if (inputTokens || outputTokens || ctxWindow) {
        this.emit("thread/tokenUsage/updated", {
          threadId,
          tokenUsage: buildCardUsage({ inputTokens, outputTokens }, st.contextWindow || 0),
        });
      }
      if (ev.is_error) {
        const msg = String(
          ev.result
          || (Array.isArray(ev.errors) ? ev.errors.join("; ") : "")
          || "unknown error"
        ).slice(0, 600);
        // 坏 session 自愈：--resume 找不到会话时清掉映射，下一轮不带 --resume 重开，
        // 免得线程永久卡在「每轮都失败」。
        if (st.sessionId && /No conversation found|session id.*not found|could not find.*session/i.test(msg)) {
          st.sessionId = null;
          this.threads.set(threadId, st);
          try { this.sessionStore?.setBackendSession(threadId, { sessionId: "", cwd: st.cwd }); } catch {}
        }
        st.resultFailed = true;
        this.emit("turn/failed", { threadId, turnId, error: { message: msg } });
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
      case "turn/interrupt": return this.interrupt(params?.threadId, params?.turnId);
      default: this.log(`unhandled method ${method}`); return {};
    }
  }
  async sendNotification() { return {}; }
  async sendResponse() { return {}; }
  sendRaw() { return {}; }
  interrupt(threadId, turnId) {
    const e = this.running.get(threadId);
    const cancelledTurnId = turnId || (e && e.turnId) || "";
    if (e && typeof e.cancel === "function") {
      e.cancel();                       // 置 settled + 杀子进程，close 不再补发终态
    } else if (e && typeof e.kill === "function") {
      try { e.kill("SIGTERM"); } catch {}
      this.running.delete(threadId);
    }
    this.emit("turn/cancelled", { threadId, turnId: cancelledTurnId });
    return {};
  }
  killAll() {
    for (const e of this.running.values()) {
      try {
        if (e && typeof e.cancel === "function") e.cancel();
        else if (e && typeof e.kill === "function") e.kill("SIGTERM");
      } catch {}
    }
    this.running.clear();
  }
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
