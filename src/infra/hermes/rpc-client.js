"use strict";

const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const DEFAULT_HERMES_COMMAND = "hermes";
const DEFAULT_FIRST_OUTPUT_TIMEOUT_MS = 45000;
const DEFAULT_TURN_TIMEOUT_MS = 900000;
const SESSION_ID_LINE = /^\s*session_id\s*:\s*(\S+)\s*$/im;

/**
 * Adapts Hermes Agent's one-shot CLI to the small Codex app-server-shaped
 * contract consumed by the bridge.
 *
 * Hermes deliberately has no persistent JSON-RPC server for `hermes chat`.
 * A turn is therefore one child process:
 *
 *   hermes chat --quiet --query <text> [--resume <session-id>]
 *
 * In quiet mode Hermes prints the final response, followed by
 * `session_id: <id>`.  The adapter retains that id behind the bridge's thread
 * id, so later turns can resume the same Hermes conversation.
 */
class HermesRpcClient {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.hermesCommand = normalizeNonEmptyString(options.hermesCommand)
      || resolveDefaultHermesCommand(this.env);
    this.hermesArgs = Array.isArray(options.hermesArgs) ? [...options.hermesArgs] : [];
    this.logLevel = options.logLevel || "normal";
    this.firstOutputTimeoutMs = positiveNumber(options.firstOutputTimeoutMs, DEFAULT_FIRST_OUTPUT_TIMEOUT_MS);
    this.turnTimeoutMs = positiveNumber(options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS);
    this.listeners = new Set();
    this.threads = new Map(); // bridge thread id -> { hermesSessionId, cwd }
    this.running = new Map(); // bridge thread id -> child process state
    this.connected = false;
  }

  async checkAvailability() {
    const result = await runProcess({
      command: this.hermesCommand,
      args: [...this.hermesArgs, "--version"],
      env: this.env,
      timeoutMs: 10000,
    });
    return {
      available: result.code === 0 && !result.error,
      command: this.hermesCommand,
      version: compactText(result.stdout),
      error: result.error ? result.error.message : result.code === 0 ? "" : formatProcessError(result),
    };
  }

  async connect() {
    const availability = await this.checkAvailability();
    if (!availability.available) {
      throw new Error(`Hermes CLI is unavailable via ${this.hermesCommand}: ${availability.error || "version check failed"}`);
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
    this.connected = false;
    return this.connect();
  }

  async initialize() {
    return { protocolVersion: "1", serverInfo: { name: "hermes-agent-cli-bridge", version: "1.0.0" } };
  }

  onMessage(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(method, params) {
    const message = { jsonrpc: "2.0", method, params };
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (error) {
        this.log(`listener failed: ${error.message}`);
      }
    }
  }

  async startThread({ cwd = "" } = {}) {
    const threadId = `hermes-${randomUUID()}`;
    this.threads.set(threadId, { hermesSessionId: "", cwd: normalizeNonEmptyString(cwd) });
    return this.threadResponse(threadId);
  }

  async resumeThread({ threadId } = {}) {
    const normalized = normalizeNonEmptyString(threadId);
    if (!normalized) {
      throw new Error("thread/resume requires a non-empty threadId");
    }
    // A persisted Hermes session id is also a valid bridge thread id. This is
    // useful after a bridge restart, when its in-memory mapping is gone.
    if (!this.threads.has(normalized)) {
      this.threads.set(normalized, { hermesSessionId: normalized, cwd: "" });
    }
    return this.threadResponse(normalized);
  }

  async listThreads({ limit = 100 } = {}) {
    const data = [...this.threads.entries()]
      .slice(0, Math.max(0, Number(limit) || 100))
      .map(([id, state]) => ({
        id,
        threadId: id,
        cwd: state.cwd || "",
        source: "unknown",
        updatedAt: 0,
      }));
    return { result: { data }, data };
  }

  async listModels() {
    const configured = normalizeNonEmptyString(this.env.HERMES_MODEL);
    const data = configured
      ? [{ id: configured, model: configured, displayName: configured, isDefault: true, supportedReasoningEfforts: [] }]
      : [];
    return { result: { data }, data, models: data };
  }

  async sendUserMessage({
    threadId,
    text,
    attachments = [],
    model = null,
    workspaceRoot = "",
  } = {}) {
    let bridgeThreadId = normalizeNonEmptyString(threadId);
    if (!bridgeThreadId) {
      ({ threadId: bridgeThreadId } = await this.startThread({ cwd: workspaceRoot }));
    }
    let state = this.threads.get(bridgeThreadId);
    if (!state) {
      state = { hermesSessionId: bridgeThreadId, cwd: "" };
      this.threads.set(bridgeThreadId, state);
    }

    const turnId = randomUUID();
    if (this.running.has(bridgeThreadId)) {
      this.emit("turn/started", { threadId: bridgeThreadId, turnId });
      this.emit("item/completed", {
        threadId: bridgeThreadId,
        turnId,
        item: { id: `busy-${turnId}`, type: "agentMessage", text: "The previous Hermes turn is still running." },
      });
      this.emit("turn/completed", { threadId: bridgeThreadId, turnId });
      return { threadId: bridgeThreadId, turnId };
    }

    const prompt = buildPrompt(text, attachments);
    if (!prompt) {
      throw new Error("Hermes turn requires non-empty text or attachments");
    }
    const args = buildHermesArgs({
      prefixArgs: this.hermesArgs,
      prompt,
      model,
      resumeSessionId: state.hermesSessionId,
    });
    const cwd = normalizeNonEmptyString(workspaceRoot) || state.cwd || undefined;
    const run = this.spawnTurn({ bridgeThreadId, turnId, state, args, cwd });
    this.running.set(bridgeThreadId, run);
    this.emit("turn/started", { threadId: bridgeThreadId, turnId });
    return { threadId: bridgeThreadId, turnId };
  }

  spawnTurn({ bridgeThreadId, turnId, state, args, cwd }) {
    const run = {
      child: null,
      stdout: "",
      stderr: "",
      settled: false,
      interrupted: false,
      firstOutputTimer: null,
      turnTimer: null,
    };
    let child;
    try {
      child = spawn(this.hermesCommand, args, { cwd, env: { ...this.env }, stdio: ["ignore", "pipe", "pipe"], shell: false });
    } catch (error) {
      queueMicrotask(() => this.failTurn(bridgeThreadId, turnId, run, `Unable to start Hermes CLI: ${error.message}`));
      return run;
    }
    run.child = child;
    run.firstOutputTimer = setTimeout(() => {
      this.failTurn(bridgeThreadId, turnId, run, `Hermes produced no output within ${Math.round(this.firstOutputTimeoutMs / 1000)} seconds.`);
    }, this.firstOutputTimeoutMs);
    run.turnTimer = setTimeout(() => {
      this.failTurn(bridgeThreadId, turnId, run, `Hermes turn exceeded ${Math.round(this.turnTimeoutMs / 60000)} minutes.`);
    }, this.turnTimeoutMs);

    child.stdout.on("data", (chunk) => {
      clearTimeout(run.firstOutputTimer);
      run.firstOutputTimer = null;
      run.stdout = appendBounded(run.stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      run.stderr = appendBounded(run.stderr, chunk.toString("utf8"));
    });
    child.on("error", (error) => this.failTurn(bridgeThreadId, turnId, run, `Hermes CLI error: ${error.message}`));
    child.on("close", (code, signal) => this.completeProcess(bridgeThreadId, turnId, state, run, code, signal));
    return run;
  }

  completeProcess(threadId, turnId, state, run, code, signal) {
    if (run.settled) {
      return;
    }
    run.settled = true;
    this.clearRun(threadId, run);
    if (run.interrupted) {
      this.emit("turn/cancelled", { threadId, turnId });
      return;
    }
    if (code !== 0) {
      this.emit("turn/failed", { threadId, turnId, error: { message: formatProcessError({ code, signal, stderr: run.stderr, stdout: run.stdout }) } });
      return;
    }
    const parsed = parseHermesOutput(run.stdout);
    if (parsed.sessionId) {
      state.hermesSessionId = parsed.sessionId;
    }
    if (parsed.text) {
      this.emit("item/completed", {
        threadId,
        turnId,
        item: { id: `msg-${turnId}`, type: "agentMessage", text: parsed.text },
      });
    }
    this.emit("turn/completed", { threadId, turnId });
  }

  failTurn(threadId, turnId, run, message) {
    if (run.settled) {
      return;
    }
    run.settled = true;
    this.clearRun(threadId, run);
    try {
      run.child?.kill();
    } catch {
      // The process may already have exited.
    }
    this.emit("turn/failed", { threadId, turnId, error: { message } });
  }

  async interrupt(threadId) {
    const normalized = normalizeNonEmptyString(threadId);
    const run = this.running.get(normalized);
    if (!run || run.settled) {
      return {};
    }
    run.interrupted = true;
    run.settled = true;
    this.clearRun(normalized, run);
    try {
      run.child?.kill();
    } catch {
      // A close event will be ignored because this run is settled.
    }
    this.emit("turn/cancelled", { threadId: normalized });
    return {};
  }

  killAll() {
    for (const threadId of [...this.running.keys()]) {
      this.interrupt(threadId);
    }
  }

  async sendRequest(method, params = {}) {
    switch (method) {
      case "thread/start": return this.startThread({ cwd: params.cwd });
      case "thread/resume": return this.resumeThread({ threadId: params.threadId });
      case "thread/list": return this.listThreads(params);
      case "model/list": return this.listModels();
      case "turn/start": return this.sendUserMessage({
        threadId: params.threadId,
        text: extractText(params.input),
        model: params.model,
        attachments: params.attachments,
        workspaceRoot: params.workspaceRoot,
      });
      case "turn/interrupt": return this.interrupt(params.threadId);
      default: return {};
    }
  }

  async sendNotification() { return {}; }
  async sendResponse() { return {}; }
  sendRaw() { return {}; }
  rejectAllPending() { this.killAll(); }
  getRequestTimeoutMs() { return this.turnTimeoutMs; }
  handleIncoming() {}

  threadResponse(threadId) {
    const thread = { id: threadId, threadId };
    return { result: { thread, threadId }, thread, threadId };
  }

  clearRun(threadId, run) {
    clearTimeout(run.firstOutputTimer);
    clearTimeout(run.turnTimer);
    if (this.running.get(threadId) === run) {
      this.running.delete(threadId);
    }
  }

  log(message) {
    if (this.logLevel === "verbose" || this.logLevel === "debug") {
      console.error(`[hermes-im] ${message}`);
    }
  }
}

function resolveDefaultHermesCommand(env = process.env) {
  return normalizeNonEmptyString(env.AGENT_BRIDGE_HERMES_COMMAND)
    || normalizeNonEmptyString(env.HERMES_COMMAND)
    || DEFAULT_HERMES_COMMAND;
}

function buildHermesArgs({ prefixArgs = [], prompt, model, resumeSessionId }) {
  const args = [...prefixArgs, "chat", "--quiet", "--source", "tool", "--query", prompt];
  const normalizedModel = normalizeNonEmptyString(model);
  if (normalizedModel) args.push("--model", normalizedModel);
  const normalizedSession = normalizeNonEmptyString(resumeSessionId);
  if (normalizedSession) args.push("--resume", normalizedSession);
  return args;
}

function parseHermesOutput(stdout) {
  const source = String(stdout || "").replace(/\r\n/g, "\n");
  const match = source.match(SESSION_ID_LINE);
  const sessionId = match?.[1] || "";
  const text = (match ? source.replace(match[0], "") : source).trim();
  return { text, sessionId };
}

function buildPrompt(text, attachments) {
  const normalized = normalizeNonEmptyString(text);
  const files = Array.isArray(attachments)
    ? attachments.map((item) => normalizeNonEmptyString(item?.filePath || item?.path)).filter(Boolean)
    : [];
  if (!files.length) return normalized;
  const attachmentNote = `Attached files:\n${files.map((file) => `- ${file}`).join("\n")}`;
  return normalized ? `${normalized}\n\n${attachmentNote}` : attachmentNote;
}

function extractText(input) {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) return input.map((item) => typeof item === "string" ? item : item?.text || "").filter(Boolean).join("\n");
  return input?.text || "";
}

function runProcess({ command, args, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { env: { ...env }, stdio: ["ignore", "pipe", "pipe"], shell: false });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: "", error });
      return;
    }
    let stdout = "";
    let stderr = "";
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ code: -1, error: new Error(`timed out after ${timeoutMs}ms`) });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk.toString("utf8")); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk.toString("utf8")); });
    child.on("error", (error) => finish({ code: -1, error }));
    child.on("close", (code, signal) => finish({ code, signal }));
  });
}

function formatProcessError({ code, signal, stderr, stdout }) {
  const detail = compactText(stderr) || compactText(stdout);
  const status = signal ? `terminated by ${signal}` : `exited with code ${code}`;
  return detail ? `Hermes CLI ${status}: ${detail}` : `Hermes CLI ${status}`;
}

function appendBounded(value, addition, limit = 256000) {
  const next = `${value}${addition}`;
  return next.length <= limit ? next : next.slice(-limit);
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1200);
}

function positiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  HermesRpcClient,
  CodexRpcClient: HermesRpcClient,
  buildHermesArgs,
  parseHermesOutput,
};
