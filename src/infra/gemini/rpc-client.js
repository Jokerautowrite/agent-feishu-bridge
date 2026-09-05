"use strict";

// Adapter for the official Gemini CLI headless JSONL interface.
// One bridge turn maps to one CLI process. The `init` event supplies the
// native session id, which is retained and passed to `--resume` on later turns.
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const DEFAULT_COMMAND = "gemini";
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 45000;
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000;

class GeminiRpcClient {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.command = normalizeCommand(
      options.command
      || options.geminiCommand
      || this.env.AGENT_BRIDGE_GEMINI_COMMAND
      || this.env.GEMINI_COMMAND
      || DEFAULT_COMMAND
    );
    this.commandArgs = Array.isArray(options.commandArgs) ? [...options.commandArgs] : [];
    this.defaultCwd = normalizeString(options.cwd || options.workspaceRoot) || process.cwd();
    this.model = normalizeModel(options.model || this.env.GEMINI_MODEL);
    this.firstEventTimeoutMs = positiveNumber(options.firstEventTimeoutMs, DEFAULT_FIRST_EVENT_TIMEOUT_MS);
    this.turnTimeoutMs = positiveNumber(options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS);
    this.probeTimeoutMs = positiveNumber(options.probeTimeoutMs, 5000);
    this.spawnImpl = options.spawnImpl || spawn;
    this.platform = options.platform || process.platform;
    this.listeners = new Set();
    this.stderrListeners = new Set();
    this.threads = new Map();
    this.running = new Map();
    this.connected = false;
  }

  async checkAvailability() {
    const result = await runProcess({
      spawnImpl: this.spawnImpl,
      spec: buildSpawnSpec(this.command, [...this.commandArgs, "--version"], this.platform),
      env: this.env,
      timeoutMs: this.probeTimeoutMs,
    });
    const version = firstNonEmptyLine(result.stdout) || firstNonEmptyLine(result.stderr);
    if (result.error || result.code !== 0 || !version) {
      throw new Error(`Gemini CLI is unavailable: ${summarizeProcessFailure(result)}`);
    }
    return { available: true, command: this.command, version };
  }

  async connect() {
    const availability = await this.checkAvailability();
    this.connected = true;
    return availability;
  }

  async connectSpawn() { return this.connect(); }
  async connectWebSocket() { return this.connect(); }
  async restartSpawn() { this.killAll(); return this.connect(); }

  async initialize() {
    if (!this.connected) await this.connect();
    return {
      protocolVersion: "1",
      serverInfo: { name: "gemini-cli-bridge", version: "1.0.0" },
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
      try { listener(message); } catch (error) {
        console.error(`[gemini-bridge] listener error: ${formatError(error)}`);
      }
    }
  }

  emitStderr(params) {
    for (const listener of this.stderrListeners) {
      try { listener(params); } catch (error) {
        console.error(`[gemini-bridge] stderr listener error: ${formatError(error)}`);
      }
    }
  }

  async startThread({ cwd } = {}) {
    const threadId = randomUUID();
    this.threads.set(threadId, {
      cwd: normalizeString(cwd) || this.defaultCwd,
      sessionId: "",
      updatedAt: Date.now(),
    });
    return threadResponse(threadId);
  }

  async resumeThread({ threadId, cwd } = {}) {
    const id = requireString(threadId, "thread/resume requires a non-empty threadId");
    const previous = this.threads.get(id);
    this.threads.set(id, {
      cwd: normalizeString(cwd) || previous?.cwd || this.defaultCwd,
      sessionId: previous?.sessionId || id,
      updatedAt: Date.now(),
    });
    return threadResponse(id);
  }

  async listThreads() {
    const data = [...this.threads.entries()].map(([id, state]) => ({
      id,
      threadId: id,
      cwd: state.cwd,
      updatedAt: state.updatedAt,
      source: "gemini",
    }));
    return { data, threads: data, result: { data, threads: data } };
  }

  async listModels() {
    const id = this.model || "default";
    const data = [{ id, model: id, displayName: id, isDefault: true, supportedReasoningEfforts: [] }];
    return { data, models: data, result: { data } };
  }

  async sendUserMessage({
    threadId,
    text,
    attachments = [],
    model = null,
    accessMode = null,
    workspaceRoot = "",
  } = {}) {
    let id = normalizeString(threadId);
    if (!id) ({ threadId: id } = await this.startThread({ cwd: workspaceRoot }));
    if (this.running.has(id)) throw new Error("A Gemini turn is already running for this thread");

    const state = this.threads.get(id) || {
      cwd: normalizeString(workspaceRoot) || this.defaultCwd,
      sessionId: "",
      updatedAt: Date.now(),
    };
    this.threads.set(id, state);
    const prompt = buildPrompt(text, attachments);
    if (!prompt) throw new Error("turn/start requires non-empty text or attachments");

    const turnId = randomUUID();
    const args = buildGeminiArgs({
      prefix: this.commandArgs,
      prompt,
      model: normalizeModel(model) || this.model,
      sessionId: state.sessionId,
      accessMode,
    });
    const cwd = normalizeString(workspaceRoot) || state.cwd || this.defaultCwd;
    const spec = buildSpawnSpec(this.command, args, this.platform);
    let child;
    try {
      child = this.spawnImpl(spec.command, spec.args, {
        cwd,
        env: { ...this.env },
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
    } catch (error) {
      throw new Error(`Unable to start Gemini CLI: ${formatError(error)}`);
    }

    const run = createRun({ child, threadId: id, turnId, state });
    this.running.set(id, run);
    this.emit("turn/started", { threadId: id, turnId });
    this.attachTurn(run);
    return { threadId: id, turnId };
  }

  attachTurn(run) {
    const fail = (message) => this.failRun(run, message);
    run.firstTimer = setTimeout(
      () => fail(`Gemini produced no output within ${Math.round(this.firstEventTimeoutMs / 1000)} seconds`),
      this.firstEventTimeoutMs
    );
    run.turnTimer = setTimeout(
      () => fail(`Gemini turn exceeded ${Math.round(this.turnTimeoutMs / 60000)} minutes`),
      this.turnTimeoutMs
    );
    run.child.stdout?.on("data", (chunk) => this.handleStdout(run, chunk));
    run.child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      run.stderr += text;
      this.emitStderr({ threadId: run.threadId, turnId: run.turnId, text });
    });
    run.child.once("error", (error) => fail(`Unable to start Gemini CLI: ${formatError(error)}`));
    run.child.once("close", (code, signal) => this.finishRun(run, code, signal));
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
      try { event = JSON.parse(line); } catch {
        run.unparsedOutput += `${line}\n`;
        continue;
      }
      this.translateEvent(run, event);
    }
  }

  translateEvent(run, event) {
    const type = normalizeString(event?.type).toLowerCase();
    if (type === "init") {
      const sessionId = normalizeString(event.session_id || event.sessionId);
      if (sessionId) run.state.sessionId = sessionId;
      run.state.updatedAt = Date.now();
      return;
    }
    if (type === "message" && normalizeString(event.role).toLowerCase() === "assistant") {
      const content = extractEventText(event.content);
      if (!content) return;
      const delta = event.delta === false && content.startsWith(run.text)
        ? content.slice(run.text.length)
        : content;
      if (!delta) return;
      run.text += delta;
      this.emit("item/agentMessage/delta", {
        threadId: run.threadId,
        turnId: run.turnId,
        delta,
      });
      return;
    }
    if (type === "tool_use") {
      const item = buildToolItem(event, "started");
      run.toolItems.set(item.id, item);
      this.emit("item/started", { threadId: run.threadId, turnId: run.turnId, item });
      return;
    }
    if (type === "tool_result") {
      const item = buildToolItem(event, "completed", run.toolItems);
      this.emit("item/completed", { threadId: run.threadId, turnId: run.turnId, item });
      return;
    }
    if (type === "error") {
      const message = extractEventText(event.message || event.error || event.content);
      if (message) run.streamWarnings.push(message);
      return;
    }
    if (type === "result") {
      run.sawResult = true;
      const status = normalizeString(event.status).toLowerCase();
      if (["error", "failed", "failure"].includes(status) || event.error) {
        run.streamError = extractEventText(event.error || event.message) || "Gemini returned a failed result";
      }
      const usage = normalizeUsage(event.stats || event.usage);
      if (usage) {
        this.emit("thread/tokenUsage/updated", { threadId: run.threadId, tokenUsage: usage });
      }
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
    const detail = run.streamError
      || normalizeString(run.stderr)
      || run.streamWarnings.join("; ")
      || run.unparsedOutput.trim()
      || `Gemini exited with code ${code}${signal ? ` (${signal})` : ""}`;
    this.emit("turn/failed", {
      threadId: run.threadId,
      turnId: run.turnId,
      error: { message: detail.slice(0, 1000) },
    });
  }

  failRun(run, message) {
    if (run.settled) return;
    run.settled = true;
    clearRunTimers(run);
    this.running.delete(run.threadId);
    try { run.child.kill("SIGTERM"); } catch {}
    this.emit("turn/failed", {
      threadId: run.threadId,
      turnId: run.turnId,
      error: { message },
    });
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
      case "thread/list": return this.listThreads();
      case "model/list": return this.listModels();
      case "turn/start": return this.sendUserMessage({
        threadId: params.threadId,
        text: extractText(params.input),
        attachments: params.attachments,
        model: params.model,
        accessMode: params.accessMode,
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
  killAll() { for (const id of [...this.running.keys()]) this.interrupt(id); }
  rejectAllPending() { this.killAll(); }
}

function buildGeminiArgs({ prefix = [], prompt, model = "", sessionId = "", accessMode = "" }) {
  const args = [...prefix, "--prompt", prompt, "--output-format", "stream-json"];
  if (model && model !== "default") args.push("--model", model);
  const normalizedAccessMode = normalizeString(accessMode).toLowerCase();
  if (normalizedAccessMode === "group-readonly") {
    args.push("--approval-mode", "plan");
  } else if (normalizedAccessMode === "full-access") {
    args.push("--approval-mode", "yolo");
  }
  if (sessionId) args.push("--resume", sessionId);
  return args;
}

function buildSpawnSpec(command, args, platform = process.platform) {
  if (platform !== "win32") return { command, args };
  // Native executables do not need cmd.exe and direct spawning preserves paths
  // containing spaces. Bare commands and npm .cmd shims still need cmd.exe.
  if (/\.(?:exe|com)$/i.test(command)) return { command, args };
  return {
    command: "cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", buildWindowsCommandLine(command, args)],
  };
}

function buildWindowsCommandLine(command, args) {
  return [command, ...args].map(quoteWindowsArg).join(" ");
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (!text || /[\s"^&|<>()%!]/.test(text)) {
    return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1").replace(/%/g, "%%")}"`;
  }
  return text;
}

function buildPrompt(text, attachments) {
  const base = normalizeString(text);
  const files = (Array.isArray(attachments) ? attachments : [])
    .map((item) => normalizeString(item?.path || item?.filePath))
    .filter(Boolean);
  if (!files.length) return base;
  const note = `Local attachments available to inspect:\n${files.map((file) => `- ${file}`).join("\n")}`;
  return base ? `${base}\n\n${note}` : note;
}

function buildToolItem(event, status, previousItems = new Map()) {
  const id = normalizeString(event.tool_id || event.toolId || event.id) || randomUUID();
  const previous = previousItems.get(id) || {};
  return {
    ...previous,
    id,
    type: "mcpToolCall",
    toolName: normalizeString(event.tool_name || event.toolName || event.name || previous.toolName) || "Gemini tool",
    arguments: event.parameters || event.args || event.input || previous.arguments || {},
    output: event.output ?? event.result ?? event.content ?? "",
    status: normalizeString(event.status) || status,
  };
}

function normalizeUsage(input) {
  if (!input || typeof input !== "object") return null;
  const totals = input.totals && typeof input.totals === "object" ? input.totals : input;
  const inputTokens = numberOrZero(totals.inputTokens ?? totals.input_tokens ?? totals.prompt_tokens);
  const outputTokens = numberOrZero(totals.outputTokens ?? totals.output_tokens ?? totals.completion_tokens);
  const totalTokens = numberOrZero(totals.totalTokens ?? totals.total_tokens) || inputTokens + outputTokens;
  return inputTokens || outputTokens || totalTokens ? { inputTokens, outputTokens, totalTokens } : null;
}

function createRun({ child, threadId, turnId, state }) {
  return {
    child,
    threadId,
    turnId,
    state,
    buffer: "",
    text: "",
    stderr: "",
    unparsedOutput: "",
    streamError: "",
    streamWarnings: [],
    toolItems: new Map(),
    sawResult: false,
    settled: false,
    cancelled: false,
    firstTimer: null,
    turnTimer: null,
  };
}

function runProcess({ spawnImpl, spec, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(spec.command, spec.args, {
        env: { ...env },
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
    } catch (error) {
      resolve({ error, code: null, stdout: "", stderr: "" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...value });
    };
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => done({ error, code: null }));
    child.once("close", (code, signal) => done({ code, signal }));
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      done({ error: new Error(`version probe timed out after ${timeoutMs}ms`), code: null });
    }, timeoutMs);
    timer.unref?.();
  });
}

function summarizeProcessFailure(result) {
  if (result.error) return formatError(result.error);
  return firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout) || `exited with code ${result.code}`;
}

function extractEventText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === "string" ? item : item?.text || item?.content || "").filter(Boolean).join("");
  }
  if (value && typeof value === "object") return normalizeString(value.message || value.text || value.content);
  return "";
}

function extractText(input) {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) return input.map((item) => typeof item === "string" ? item : item?.text || "").filter(Boolean).join("\n");
  return input?.text || "";
}

function clearFirstTimer(run) {
  if (run.firstTimer) { clearTimeout(run.firstTimer); run.firstTimer = null; }
}

function clearRunTimers(run) {
  clearFirstTimer(run);
  if (run.turnTimer) { clearTimeout(run.turnTimer); run.turnTimer = null; }
}

function threadResponse(threadId) {
  const thread = { id: threadId, threadId };
  return { threadId, thread, result: { thread, threadId } };
}

function normalizeCommand(value) {
  const command = normalizeString(value);
  if (!command || /[\r\n\0]/.test(command)) throw new Error("Gemini command must be a single executable path or command name");
  return command;
}

function normalizeModel(value) { return normalizeString(value).replace(/\s*\[[^\]]+\]\s*$/, ""); }
function normalizeString(value) { return typeof value === "string" ? value.trim() : ""; }
function requireString(value, message) { const result = normalizeString(value); if (!result) throw new Error(message); return result; }
function positiveNumber(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }
function numberOrZero(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : 0; }
function firstNonEmptyLine(value) { return String(value || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || ""; }
function formatError(error) { return error instanceof Error ? error.message : String(error || "unknown error"); }

module.exports = {
  GeminiRpcClient,
  CodexRpcClient: GeminiRpcClient,
  buildGeminiArgs,
  buildSpawnSpec,
  normalizeUsage,
};
