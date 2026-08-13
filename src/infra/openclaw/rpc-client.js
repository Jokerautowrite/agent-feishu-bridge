"use strict";

// Adapter for the documented OpenClaw CLI contract. It intentionally has no
// registry/config wiring: consumers can opt in by importing this module.
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const DEFAULT_COMMAND = "openclaw";
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_AVAILABILITY_TIMEOUT_MS = 10_000;

class OpenClawAdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OpenClawAdapterError";
    this.code = code;
    Object.assign(this, details);
  }
}

class OpenClawRpcClient {
  constructor(options = {}) {
    this.command = normalizeCommand(options.command || options.openclawCommand || resolveDefaultCommand(options.env));
    this.env = options.env || process.env;
    this.agentId = normalizeString(options.agentId);
    this.timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.availabilityTimeoutMs = positiveNumber(options.availabilityTimeoutMs, DEFAULT_AVAILABILITY_TIMEOUT_MS);
    this.spawnImpl = options.spawnImpl || spawn;
    this.platform = options.platform || process.platform;
    this.listeners = new Set();
    this.threads = new Map();
    this.running = new Map();
    this.connected = false;
  }

  async checkAvailability() {
    const result = await runProcess({
      spawnImpl: this.spawnImpl,
      spec: buildSpawnSpec(this.command, ["--version"], this.platform),
      env: this.env,
      timeoutMs: this.availabilityTimeoutMs,
    });
    if (result.error || result.code !== 0) {
      throw normalizeProcessError(result, "OpenClaw CLI is unavailable");
    }
    return { available: true, command: this.command, version: result.stdout.trim() };
  }

  async connect() {
    await this.checkAvailability();
    this.connected = true;
    return true;
  }

  async initialize() {
    return { protocolVersion: "1", serverInfo: { name: "openclaw-cli-bridge", version: "1.0.0" } };
  }

  onMessage(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(method, params) {
    const message = { jsonrpc: "2.0", method, params };
    for (const listener of this.listeners) {
      try { listener(message); } catch { /* An observer must not stop a turn. */ }
    }
  }

  async startThread({ cwd = "" } = {}) {
    const threadId = randomUUID();
    this.threads.set(threadId, { sessionId: threadId, cwd: normalizeString(cwd) });
    return threadResponse(threadId);
  }

  async resumeThread({ threadId } = {}) {
    const id = requireId(threadId, "thread/resume requires a non-empty threadId");
    if (!this.threads.has(id)) this.threads.set(id, { sessionId: id, cwd: "" });
    return threadResponse(id);
  }

  async listThreads() {
    const data = [...this.threads.keys()].map((id) => ({ id, threadId: id, updatedAt: Date.now() }));
    return { result: { data, threads: data }, data, threads: data };
  }

  // OpenClaw's generic CLI does not expose a stable model-list envelope.
  // Return a valid empty bridge catalog rather than inventing local models.
  async listModels() { return { result: { data: [] }, data: [] }; }

  async sendUserMessage({ threadId, text, model = null, effort = null, workspaceRoot = "" } = {}) {
    let id = normalizeString(threadId);
    if (!id) id = (await this.startThread({ cwd: workspaceRoot })).result.thread.id;
    const prompt = normalizeString(text);
    if (!prompt) throw new OpenClawAdapterError("OPENCLAW_INVALID_REQUEST", "OpenClaw turn/start requires non-empty text");
    if (this.running.has(id)) {
      throw new OpenClawAdapterError("OPENCLAW_TURN_IN_FLIGHT", `OpenClaw already has an active turn for thread ${id}`, { threadId: id });
    }

    const thread = this.threads.get(id) || { sessionId: id, cwd: normalizeString(workspaceRoot) };
    this.threads.set(id, thread);
    const turnId = randomUUID();
    const args = buildAgentArgs({ agentId: this.agentId, sessionId: thread.sessionId, prompt, model, effort });
    const spec = buildSpawnSpec(this.command, args, this.platform);
    let child;
    try {
      child = this.spawnImpl(spec.command, spec.args, { cwd: thread.cwd || undefined, env: { ...this.env }, stdio: ["ignore", "pipe", "pipe"], shell: false });
    } catch (error) {
      throw normalizeSpawnError(error);
    }
    const run = { child, threadId: id, turnId, stdout: "", stderr: "", terminal: false, abortRequested: false };
    this.running.set(id, run);
    this.attachTurn(run);

    return new Promise((resolve, reject) => {
      const onSpawn = () => { cleanup(); this.emit("turn/started", { threadId: id, turnId }); resolve({ threadId: id, turnId }); };
      const onError = (error) => { cleanup(); reject(normalizeSpawnError(error)); };
      const cleanup = () => { child.removeListener("spawn", onSpawn); child.removeListener("error", onError); };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  attachTurn(run) {
    const { child } = run;
    child.stdout?.on("data", (chunk) => { run.stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { run.stderr += chunk.toString("utf8"); });
    child.once("error", (error) => this.finishError(run, normalizeSpawnError(error)));
    child.once("close", (code, signal) => this.finishClose(run, code, signal));
  }

  finishClose(run, code, signal) {
    if (run.terminal) return;
    if (run.abortRequested || signal === "SIGINT" || signal === "SIGTERM" || code === 130 || code === 143) {
      this.finishCancelled(run);
      return;
    }
    if (code !== 0) {
      this.finishError(run, normalizeProcessError({ code, signal, stderr: run.stderr }, "OpenClaw agent command failed"));
      return;
    }
    let envelope;
    try { envelope = parseJsonEnvelope(run.stdout); }
    catch (error) { this.finishError(run, error); return; }
    if (envelope.ok === false || envelope.status === "error" || envelope.status === "timeout" || envelope.status === "in_flight") {
      this.finishError(run, normalizeResultError(envelope));
      return;
    }
    const finalText = extractFinalText(envelope);
    if (finalText) {
      this.emit("item/completed", { threadId: run.threadId, turnId: run.turnId, item: { id: `message-${run.turnId}`, type: "agentMessage", text: finalText } });
    }
    const usage = normalizeUsage(envelope.usage || envelope.meta?.usage);
    if (usage) this.emit("thread/tokenUsage/updated", { threadId: run.threadId, tokenUsage: usage });
    this.finishTerminal(run, "turn/completed", { threadId: run.threadId, turnId: run.turnId });
  }

  finishError(run, error) {
    if (run.terminal) return;
    this.finishTerminal(run, "turn/failed", { threadId: run.threadId, turnId: run.turnId, error: serializeError(error) });
  }

  finishCancelled(run) {
    if (run.terminal) return;
    this.finishTerminal(run, "turn/cancelled", { threadId: run.threadId, turnId: run.turnId });
  }

  finishTerminal(run, method, params) {
    if (run.terminal) return;
    run.terminal = true;
    this.running.delete(run.threadId);
    this.emit(method, params);
  }

  async interruptTurn({ threadId } = {}) {
    const id = requireId(threadId, "turn/interrupt requires a non-empty threadId");
    const run = this.running.get(id);
    if (!run) return { threadId: id, interrupted: false };
    run.abortRequested = true;
    try { run.child.kill("SIGTERM"); }
    catch (error) { this.finishError(run, normalizeSpawnError(error)); throw normalizeSpawnError(error); }
    const timer = setTimeout(() => { try { run.child.kill("SIGKILL"); } catch {} }, 5_000);
    timer.unref?.();
    return { threadId: id, interrupted: true };
  }

  async sendRequest(method, params = {}) {
    switch (method) {
      case "thread/start": return this.startThread({ cwd: params.cwd });
      case "thread/resume": return this.resumeThread({ threadId: params.threadId });
      case "thread/list": return this.listThreads();
      case "model/list": return this.listModels();
      case "turn/start": return this.sendUserMessage({ threadId: params.threadId, text: extractInputText(params.input), model: params.model, effort: params.effort, workspaceRoot: params.workspaceRoot });
      case "turn/interrupt": return this.interruptTurn({ threadId: params.threadId });
      default: throw new OpenClawAdapterError("OPENCLAW_UNSUPPORTED_METHOD", `OpenClaw adapter does not support ${method}`);
    }
  }

  async sendNotification() { return {}; }
  async sendResponse() { return {}; }
  async disconnect() { for (const id of [...this.running.keys()]) await this.interruptTurn({ threadId: id }); this.connected = false; }
}

function buildAgentArgs({ agentId, sessionId, prompt, model, effort }) {
  const args = ["agent"];
  if (agentId) args.push("--agent", agentId);
  args.push("--session-id", sessionId, "--message", prompt);
  if (normalizeString(model)) args.push("--model", normalizeString(model));
  if (normalizeString(effort)) args.push("--thinking", normalizeString(effort));
  args.push("--json");
  return args;
}

function buildSpawnSpec(command, args, platform = process.platform) {
  if (platform !== "win32") return { command, args };
  return { command: "cmd.exe", args: ["/d", "/s", "/c", buildWindowsCommandLine(command, args)] };
}

function buildWindowsCommandLine(command, args) {
  return [command, ...args].map(quoteWindowsArg).join(" ");
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (!text || /[\s"^&|<>()%!]/.test(text)) return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1").replace(/%/g, "%%")}"`;
  return text;
}

function runProcess({ spawnImpl, spec, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnImpl(spec.command, spec.args, { env: { ...env }, stdio: ["ignore", "pipe", "pipe"], shell: false }); }
    catch (error) { resolve({ error }); return; }
    let stdout = ""; let stderr = ""; let settled = false;
    const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ stdout, stderr, ...value }); } };
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => done({ error }));
    child.once("close", (code, signal) => done({ code, signal }));
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} done({ error: new OpenClawAdapterError("OPENCLAW_TIMEOUT", `OpenClaw availability check timed out after ${timeoutMs}ms`) }); }, timeoutMs);
    timer.unref?.();
  });
}

function parseJsonEnvelope(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) throw new OpenClawAdapterError("OPENCLAW_INVALID_RESPONSE", "OpenClaw agent returned no JSON response");
  try { return JSON.parse(raw); }
  catch {
    for (const line of raw.split(/\r?\n/).reverse()) { try { return JSON.parse(line); } catch {} }
    throw new OpenClawAdapterError("OPENCLAW_INVALID_RESPONSE", "OpenClaw agent returned malformed JSON", { stdout: raw.slice(0, 1000) });
  }
}

function extractFinalText(envelope) {
  if (typeof envelope?.final === "string") return envelope.final;
  if (typeof envelope?.result?.final === "string") return envelope.result.final;
  const payloads = Array.isArray(envelope?.payloads) ? envelope.payloads : [];
  return payloads.map((item) => typeof item?.text === "string" ? item.text : "").filter(Boolean).join("\n");
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = Number(usage.input ?? usage.inputTokens ?? 0);
  const output = Number(usage.output ?? usage.outputTokens ?? 0);
  const total = Number(usage.total ?? usage.totalTokens ?? input + output);
  return input || output || total ? { inputTokens: input, outputTokens: output, totalTokens: total } : null;
}

function normalizeResultError(envelope) {
  const status = normalizeString(envelope?.status) || "error";
  const code = status === "timeout" ? "OPENCLAW_TIMEOUT" : status === "in_flight" ? "OPENCLAW_TURN_IN_FLIGHT" : "OPENCLAW_RUN_ERROR";
  return new OpenClawAdapterError(code, normalizeString(envelope?.error?.message) || `OpenClaw agent returned status ${status}`, { status, kind: envelope?.error?.kind });
}

function normalizeProcessError(result, prefix) {
  if (result.error instanceof OpenClawAdapterError) return result.error;
  const detail = normalizeString(result.stderr) || normalizeString(result.error?.message) || `exit code ${result.code ?? "unknown"}`;
  return new OpenClawAdapterError("OPENCLAW_PROCESS_ERROR", `${prefix}: ${detail}`, { exitCode: result.code, signal: result.signal });
}

function normalizeSpawnError(error) {
  return error instanceof OpenClawAdapterError ? error : new OpenClawAdapterError("OPENCLAW_UNAVAILABLE", `Unable to start OpenClaw CLI: ${normalizeString(error?.message) || "unknown error"}`, { cause: error });
}

function serializeError(error) { return { code: error?.code || "OPENCLAW_ERROR", message: error?.message || String(error), kind: error?.kind }; }
function threadResponse(threadId) { const thread = { id: threadId, threadId }; return { result: { thread, threadId }, thread, threadId }; }
function extractInputText(input) { return Array.isArray(input) ? input.map((item) => typeof item === "string" ? item : item?.text || "").filter(Boolean).join("\n") : typeof input === "string" ? input : input?.text || ""; }
function resolveDefaultCommand(env = process.env) { return env?.AGENT_BRIDGE_OPENCLAW_COMMAND || env?.OPENCLAW_COMMAND || DEFAULT_COMMAND; }
function normalizeCommand(value) { const command = normalizeString(value); if (!command || /[\r\n\0]/.test(command)) throw new OpenClawAdapterError("OPENCLAW_INVALID_COMMAND", "OpenClaw command must be a single executable path or command name"); return command; }
function normalizeString(value) { return typeof value === "string" ? value.trim() : ""; }
function requireId(value, message) { const id = normalizeString(value); if (!id) throw new OpenClawAdapterError("OPENCLAW_INVALID_REQUEST", message); return id; }
function positiveNumber(value, fallback) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : fallback; }

module.exports = { OpenClawRpcClient, OpenClawAdapterError, buildAgentArgs, buildSpawnSpec, extractFinalText, normalizeUsage, parseJsonEnvelope };
