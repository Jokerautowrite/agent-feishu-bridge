"use strict";

// Adapter for the official Grok CLI headless interface.  The CLI's `agent stdio`
// command speaks ACP, but headless streaming-json is the smaller dependency-free
// surface required by this bridge's existing backend contract.
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_COMMAND = "grok";
const DEFAULT_MODEL = "grok-build";
const SUPPORTED_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 110000;
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000;

class GrokRpcClient {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.command = normalizeString(options.command || options.grokCommand || this.env.GROK_COMMAND || DEFAULT_COMMAND);
    this.commandArgs = Array.isArray(options.commandArgs) ? [...options.commandArgs] : [];
    this.defaultCwd = normalizeString(options.cwd || options.workspaceRoot) || process.cwd();
    this.model = normalizeString(options.model || this.env.GROK_MODEL) || DEFAULT_MODEL;
    this.models = parseConfiguredModels(this.env, this.model);
    this.firstEventTimeoutMs = positiveNumber(
      options.firstEventTimeoutMs ?? this.env.GROK_BRIDGE_FIRST_EVENT_MS,
      DEFAULT_FIRST_EVENT_TIMEOUT_MS
    );
    this.turnTimeoutMs = positiveNumber(options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS);
    this.probeTimeoutMs = positiveNumber(options.probeTimeoutMs, 5000);
    this.spawnImpl = options.spawnImpl || spawn;
    this.listeners = new Set();
    this.stderrListeners = new Set();
    this.threads = new Map();
    this.running = new Map();
    this.connected = false;
    this.lastAvailability = null;
  }

  static async detectAvailability(options = {}) {
    const client = new GrokRpcClient(options);
    return client.detectAvailability();
  }

  async detectAvailability() {
    const result = await runCommand({
      spawnImpl: this.spawnImpl,
      command: this.command,
      args: [...this.commandArgs, "--version"],
      env: this.env,
      timeoutMs: this.probeTimeoutMs,
    });
    const version = firstNonEmptyLine(result.stdout);
    const available = !result.error && result.code === 0 && /^grok\b/i.test(version);
    this.lastAvailability = {
      available,
      command: this.command,
      version: available ? version : "",
      reason: available ? "" : summarizeProbeFailure(result),
    };
    return this.lastAvailability;
  }

  async connect() {
    const availability = await this.detectAvailability();
    if (!availability.available) {
      throw new Error(`Grok CLI is unavailable: ${availability.reason || "version probe failed"}`);
    }
    this.connected = true;
    return availability;
  }

  async connectSpawn() {
    return this.connect();
  }

  async connectWebSocket() {
    return this.connect();
  }

  async restartSpawn() {
    this.killAll();
    return this.connect();
  }

  async initialize() {
    if (!this.connected) {
      await this.connect();
    }
    return {
      protocolVersion: "1",
      serverInfo: { name: "grok-cli-bridge", version: "1.0.0" },
    };
  }

  onMessage(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStderr(listener) {
    if (typeof listener !== "function") return () => {};
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  emit(method, params) {
    const message = { jsonrpc: "2.0", method, params };
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (error) {
        console.error(`[grok-bridge] listener error: ${formatError(error)}`);
      }
    }
  }

  emitStderr(params) {
    for (const listener of this.stderrListeners) {
      try {
        listener(params);
      } catch (error) {
        console.error(`[grok-bridge] stderr listener error: ${formatError(error)}`);
      }
    }
    this.emit("grok/stderr", params);
  }

  async startThread({ cwd } = {}) {
    const threadId = randomUUID();
    this.threads.set(threadId, { cwd: normalizeString(cwd) || this.defaultCwd, sessionId: "", updatedAt: Date.now() });
    return threadResponse(threadId);
  }

  async resumeThread({ threadId, cwd } = {}) {
    const normalizedThreadId = normalizeString(threadId);
    if (!normalizedThreadId) throw new Error("thread/resume requires a non-empty threadId");
    const existing = this.threads.get(normalizedThreadId);
    this.threads.set(normalizedThreadId, {
      cwd: normalizeString(cwd) || existing?.cwd || this.defaultCwd,
      // A persisted Grok session id can be passed directly as the bridge thread id.
      sessionId: existing?.sessionId || normalizedThreadId,
      updatedAt: Date.now(),
    });
    return threadResponse(normalizedThreadId);
  }

  async listThreads() {
    const data = [...this.threads.entries()].map(([id, state]) => ({
      id,
      threadId: id,
      cwd: state.cwd,
      updatedAt: state.updatedAt,
      source: "grok",
    }));
    return { data, threads: data, result: { data, threads: data } };
  }

  async listModels() {
    // 优先从 grok CLI 拉取模型目录（grok CLI 已由 opencodex 注入全部 ocx 模型，
    // 链路: grok CLI -> opencodex -> sub2/xai）。失败时回退到 env 配置的模型。
    try {
      const cliModels = await this.listModelsFromCli();
      if (cliModels && cliModels.data && cliModels.data.length) return cliModels;
    } catch (error) {
      console.warn(`[grok-bridge] grok models fetch failed, falling back to env: ${formatError(error)}`);
    }
    const models = this.models.length ? this.models : [this.model];
    const data = models.map((id) => ({
      id,
      model: id,
      displayName: formatGrokDisplayName(id),
      isDefault: id === this.model,
      supportedReasoningEfforts: [...SUPPORTED_EFFORTS],
    }));
    return { data, models: data, result: { data } };
  }

  /**
   * 执行 `grok models` 并解析模型目录。grok CLI 的模型列表包含 opencodex 注入的
   * `ocx-*` 内部名；通过 ~/.grok/config.toml 的 [model.<section>] model="实际名"
   * 映射还原为目录名（如 ocx-sub2-grok-4-5 -> sub2/grok-4.5），直连模型（grok-4.5）
   * 保留原名。这样飞书选择器同时显示 sub2 中转与直连模型。
   */
  async listModelsFromCli() {
    const result = await runCommand({
      spawnImpl: this.spawnImpl,
      command: this.command,
      args: [...this.commandArgs, "models"],
      env: this.env,
      timeoutMs: this.probeTimeoutMs * 4,
    });
    if (result.error || result.code !== 0) {
      throw new Error(result.error ? formatError(result.error) : `grok models exited ${result.code}`);
    }
    return parseGrokModelsOutput(result.stdout, this.model);
  }

  async sendUserMessage({ threadId, text, attachments = [], model = null, effort = null, workspaceRoot = "" } = {}) {
    let id = normalizeString(threadId);
    if (!id) ({ threadId: id } = await this.startThread({ cwd: workspaceRoot }));
    const state = this.threads.get(id) || {
      cwd: normalizeString(workspaceRoot) || this.defaultCwd,
      sessionId: "",
      updatedAt: Date.now(),
    };
    this.threads.set(id, state);
    if (this.running.has(id)) {
      throw new Error("A Grok turn is already running for this thread");
    }
    const prompt = buildPrompt(text, attachments);
    if (!prompt) throw new Error("turn/start requires non-empty text or attachments");

    const turnId = randomUUID();
    const args = buildGrokArgs({
      prefix: this.commandArgs,
      prompt,
      cwd: normalizeString(workspaceRoot) || state.cwd || this.defaultCwd,
      model: normalizeString(model) || this.model,
      effort,
      sessionId: state.sessionId,
    });
    this.emit("turn/started", { threadId: id, turnId });
    const child = this.spawnImpl(this.command, args, {
      cwd: normalizeString(workspaceRoot) || state.cwd || this.defaultCwd,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const run = createRun({ child, threadId: id, turnId, state });
    this.running.set(id, run);
    this.attachTurnProcess(run);
    return { threadId: id, turnId };
  }

  attachTurnProcess(run) {
    const fail = (message) => this.failRun(run, message);
    run.firstTimer = setTimeout(() => fail(`Grok produced no output within ${Math.round(this.firstEventTimeoutMs / 1000)} seconds`), this.firstEventTimeoutMs);
    run.turnTimer = setTimeout(() => fail(`Grok turn exceeded ${Math.round(this.turnTimeoutMs / 60000)} minutes`), this.turnTimeoutMs);
    run.child.stdout.on("data", (chunk) => this.handleStdout(run, chunk));
    run.child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      run.stderr += text;
      this.emitStderr({ threadId: run.threadId, turnId: run.turnId, text });
    });
    run.child.on("error", (error) => fail(`Unable to start Grok: ${formatError(error)}`));
    run.child.on("close", (code, signal) => this.finishRun(run, code, signal));
  }

  handleStdout(run, chunk) {
    clearFirstTimer(run);
    run.buffer += chunk.toString("utf8");
    let newline;
    while ((newline = run.buffer.indexOf("\n")) >= 0) {
      const line = run.buffer.slice(0, newline).trim();
      run.buffer = run.buffer.slice(newline + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        run.unparsedOutput += `${line}\n`;
        continue;
      }
      this.translateEvent(run, event);
    }
  }

  translateEvent(run, event) {
    const type = normalizeString(event?.type).toLowerCase();
    if (type === "text" && typeof event.data === "string") {
      run.text += event.data;
      this.emit("item/agentMessage/delta", { threadId: run.threadId, turnId: run.turnId, delta: event.data });
      return;
    }
    if ((type === "thought" || type === "reasoning") && typeof event.data === "string") {
      this.emit("item/reasoning/summaryPartAdded", {
        threadId: run.threadId,
        turnId: run.turnId,
        item: { id: `reasoning-${run.turnId}`, type: "reasoning" },
        summary: event.data,
      });
      return;
    }
    if (type === "end") {
      run.sawEnd = true;
      const sessionId = normalizeString(event.sessionId);
      if (sessionId) run.state.sessionId = sessionId;
      run.state.updatedAt = Date.now();
      if (event.usage && typeof event.usage === "object") {
        const tokenUsage = normalizeUsage(event.usage);
        if (tokenUsage) this.emit("thread/tokenUsage/updated", { threadId: run.threadId, tokenUsage });
      }
      return;
    }
    if (type === "error") {
      run.streamError = normalizeString(event.message || event.error || event.data) || "Grok returned an error event";
    }
  }

  finishRun(run, code, signal) {
    if (run.settled) return;
    if (run.buffer.trim()) this.handleStdout(run, "\n");
    clearRunTimers(run);
    run.settled = true;
    this.running.delete(run.threadId);
    if (run.cancelled) return;
    if (code === 0 && !run.streamError) {
      if (run.text) {
        this.emit("item/completed", {
          threadId: run.threadId,
          turnId: run.turnId,
          item: { id: `message-${run.turnId}`, type: "agentMessage", text: run.text },
        });
      }
      this.emit("turn/completed", { threadId: run.threadId, turnId: run.turnId });
      return;
    }
    const detail = run.streamError || normalizeString(run.stderr) || run.unparsedOutput.trim() || `Grok exited with code ${code}${signal ? ` (${signal})` : ""}`;
    this.emit("turn/failed", { threadId: run.threadId, turnId: run.turnId, error: { message: detail.slice(0, 1000) } });
  }

  failRun(run, message) {
    if (run.settled) return;
    run.settled = true;
    clearRunTimers(run);
    this.running.delete(run.threadId);
    try { run.child.kill("SIGTERM"); } catch {}
    this.emit("turn/failed", { threadId: run.threadId, turnId: run.turnId, error: { message } });
  }

  async interrupt(threadId) {
    const id = normalizeString(threadId);
    const run = this.running.get(id);
    if (!run) return { interrupted: false };
    run.cancelled = true;
    run.settled = true;
    clearRunTimers(run);
    this.running.delete(id);
    try { run.child.kill("SIGTERM"); } catch {}
    this.emit("turn/cancelled", { threadId: id, turnId: run.turnId });
    return { interrupted: true };
  }

  async sendRequest(method, params = {}) {
    switch (method) {
      case "thread/start": return this.startThread(params);
      case "thread/resume": return this.resumeThread(params);
      case "thread/list": return this.listThreads(params);
      case "model/list": return this.listModels();
      case "turn/start": return this.sendUserMessage({
        threadId: params.threadId,
        text: extractText(params.input),
        attachments: params.attachments,
        model: params.model,
        effort: params.effort,
        workspaceRoot: params.workspaceRoot,
      });
      case "turn/interrupt": return this.interrupt(params.threadId);
      default: return {};
    }
  }

  async sendNotification() { return {}; }
  async sendResponse() { return {}; }
  sendRaw() { return {}; }
  handleIncoming() {}
  getRequestTimeoutMs() { return this.turnTimeoutMs; }

  killAll() {
    for (const threadId of [...this.running.keys()]) this.interrupt(threadId);
  }

  rejectAllPending() { this.killAll(); }
}

function buildGrokArgs({ prefix, prompt, cwd, model, effort, sessionId }) {
  const args = [...prefix, "-p", prompt, "--output-format", "streaming-json", "--cwd", cwd];
  if (model) args.push("--model", model);
  const normalizedEffort = normalizeEffort(effort);
  if (normalizedEffort) args.push("--reasoning-effort", normalizedEffort);
  if (sessionId) args.push("--resume", sessionId);
  return args;
}

function buildPrompt(text, attachments) {
  const base = normalizeString(text);
  const files = (Array.isArray(attachments) ? attachments : [])
    .map((item) => normalizeString(item?.path || item?.filePath))
    .filter(Boolean);
  return files.length ? `${base}${base ? "\n\n" : ""}Attached files:\n${files.join("\n")}` : base;
}

function extractText(input) {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) return input.map((part) => typeof part === "string" ? part : part?.text || "").filter(Boolean).join("\n");
  return input?.text || "";
}

function normalizeEffort(value) {
  const effort = normalizeString(value).toLowerCase();
  return SUPPORTED_EFFORTS.includes(effort) ? effort : "";
}

function normalizeUsage(usage) {
  const inputTokens = numberOrZero(usage.inputTokens ?? usage.input_tokens);
  const outputTokens = numberOrZero(usage.outputTokens ?? usage.output_tokens);
  const totalTokens = numberOrZero(usage.totalTokens ?? usage.total_tokens) || inputTokens + outputTokens;
  return inputTokens || outputTokens || totalTokens ? { inputTokens, outputTokens, totalTokens } : null;
}

function createRun({ child, threadId, turnId, state }) {
  return { child, threadId, turnId, state, buffer: "", text: "", stderr: "", unparsedOutput: "", streamError: "", sawEnd: false, settled: false, cancelled: false, firstTimer: null, turnTimer: null };
}

function clearFirstTimer(run) {
  if (run.firstTimer) {
    clearTimeout(run.firstTimer);
    run.firstTimer = null;
  }
}

function clearRunTimers(run) {
  clearFirstTimer(run);
  if (run.turnTimer) {
    clearTimeout(run.turnTimer);
    run.turnTimer = null;
  }
}

function threadResponse(threadId) {
  const thread = { id: threadId, threadId };
  return { threadId, thread, result: { thread, threadId } };
}

function runCommand({ spawnImpl, command, args, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { env, stdio: ["ignore", "pipe", "pipe"], shell: false });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", error });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      settle({ code: null, error: new Error(`version probe timed out after ${timeoutMs}ms`) });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => settle({ code: null, error }));
    child.on("close", (code) => settle({ code, error: null }));
  });
}

function summarizeProbeFailure(result) {
  if (result.error) return formatError(result.error);
  const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
  return detail || `exited with code ${result.code}`;
}

function firstNonEmptyLine(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function parseConfiguredModels(env, defaultModel) {
  const fallback = normalizeString(defaultModel) || DEFAULT_MODEL;
  const raw = normalizeString(env?.GROK_MODELS || env?.GROK_MODEL_LIST);
  const names = [];
  const seen = new Set();
  const push = (value) => {
    const id = normalizeString(value);
    if (!id) return;
    const key = id.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(id);
  };
  push(fallback);
  for (const part of raw.split(/[,;\s]+/)) push(part);
  return names;
}

function parseGrokModelsOutput(stdout, fallbackDefault) {
  const mapping = loadOcxModelMapping();
  const names = [];
  let defaultModel = normalizeString(fallbackDefault);
  let inList = false;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("Available models:")) { inList = true; continue; }
    if (!inList) continue;
    if (t.startsWith("- ") || t.startsWith("* ")) {
      const m = /^[\-\*]\s+(\S+)(?:\s+\(default\))?$/.exec(t);
      if (!m) continue;
      const internalName = m[1];
      if (t.startsWith("* ")) defaultModel = internalName;
      names.push(internalName);
    }
  }
  const seen = new Set();
  const out = [];
  for (const internalName of names) {
    const id = mapping[internalName] || internalName;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  const defaultKey = (mapping[defaultModel] || defaultModel || "").toLowerCase();
  const entries = out.map((id) => ({
    id,
    model: id,
    displayName: formatGrokDisplayName(id),
    isDefault: id.toLowerCase() === defaultKey,
    supportedReasoningEfforts: [...SUPPORTED_EFFORTS],
  }));
  return { data: entries, models: entries, result: { data: entries } };
}

function loadOcxModelMapping() {
  // opencodex 注入 grok CLI 时，会在 ~/.grok/config.toml 写 [model.ocx-*] 段：
  //   [model.ocx-sub2-grok-4-5]
  //   model = "sub2/grok-4.5"
  // 解析该映射，把 grok models 输出的内部名还原为目录名。
  const mapping = {};
  try {
    const configPath = path.join(os.homedir(), ".grok", "config.toml");
    const text = fs.readFileSync(configPath, "utf8");
    const sectionRe = /^\[model\.([^\]]+)\]\s*\n((?:.*\n)*?)(?=^\[|$(?![\s\S]))/gm;
    let m;
    while ((m = sectionRe.exec(text)) !== null) {
      const section = m[1] || "";
      // Only remap opencodex-injected ocx-* aliases. Custom sections like
      // relay-grok-46 must keep their section name so Feishu defaults match
      // `grok models` output and CLI --model selection.
      if (!section.startsWith("ocx-")) continue;
      const body = m[2] || "";
      const mm = /^model\s*=\s*"([^"]+)"/m.exec(body);
      if (mm) mapping[section] = mm[1];
    }
  } catch (error) {
    // 配置文件不存在/不可读时返回空映射，模型名原样透传。
  }
  return mapping;
}

function formatGrokDisplayName(id) {
  const model = normalizeString(id);
  const matched = /^grok-(\d+(?:\.\d+)*)$/i.exec(model);
  return matched ? `Grok ${matched[1]}` : model;
}

function normalizeString(value) { return String(value || "").trim(); }
function positiveNumber(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback; }
function numberOrZero(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : 0; }
function formatError(error) { return error instanceof Error ? error.message : String(error || "unknown error"); }

module.exports = { GrokRpcClient, CodexRpcClient: GrokRpcClient, buildGrokArgs, parseConfiguredModels };
