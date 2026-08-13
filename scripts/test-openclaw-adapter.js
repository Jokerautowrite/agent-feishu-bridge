"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { OpenClawRpcClient, OpenClawAdapterError, buildAgentArgs, buildSpawnSpec } = require("../src/infra/openclaw/rpc-client");

class FakeChild extends EventEmitter {
  constructor({ stdout = "", stderr = "", code = 0, signal = null, keepOpen = false } = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.kills = [];
    process.nextTick(() => {
      this.emit("spawn");
      if (!keepOpen) {
        if (stdout) this.stdout.emit("data", Buffer.from(stdout));
        if (stderr) this.stderr.emit("data", Buffer.from(stderr));
        this.emit("close", code, signal);
      }
    });
  }
  kill(signal) { this.kills.push(signal); this.emit("close", null, signal); return true; }
}

async function main() {
  const invocations = [];
  const responses = [
    { stdout: "OpenClaw 2026.8.0\n" },
    { stdout: JSON.stringify({ ok: true, status: "ok", final: "adapter final", usage: { input: 3, output: 2, total: 5 } }) },
  ];
  const client = new OpenClawRpcClient({
    command: "openclaw",
    agentId: "bridge",
    platform: "linux",
    spawnImpl(command, args) { invocations.push({ command, args }); return new FakeChild(responses.shift()); },
  });
  const events = [];
  client.onMessage((message) => events.push(message));

  const availability = await client.checkAvailability();
  assert.equal(availability.available, true);
  assert.deepEqual(invocations[0], { command: "openclaw", args: ["--version"] });

  const thread = await client.startThread({ cwd: "" });
  const started = await client.sendUserMessage({ threadId: thread.result.thread.id, text: "hello", model: "openai/test", effort: "medium" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.threadId, thread.result.thread.id);
  assert.deepEqual(invocations[1].args, buildAgentArgs({ agentId: "bridge", sessionId: thread.result.thread.id, prompt: "hello", model: "openai/test", effort: "medium" }));
  assert.equal(events.find((event) => event.method === "item/completed")?.params.item.text, "adapter final");
  assert.deepEqual(events.find((event) => event.method === "thread/tokenUsage/updated")?.params.tokenUsage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  assert.equal(events.at(-1).method, "turn/completed");

  const failing = new OpenClawRpcClient({ platform: "linux", spawnImpl() { return new FakeChild({ stdout: JSON.stringify({ ok: false, status: "timeout", error: { message: "deadline" } }) }); } });
  const failures = [];
  failing.onMessage((event) => failures.push(event));
  await failing.sendUserMessage({ threadId: "failed-thread", text: "x" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failures.at(-1).method, "turn/failed");
  assert.equal(failures.at(-1).params.error.code, "OPENCLAW_TIMEOUT");

  let runningChild;
  const cancellable = new OpenClawRpcClient({ platform: "linux", spawnImpl() { runningChild = new FakeChild({ keepOpen: true }); return runningChild; } });
  const cancelled = [];
  cancellable.onMessage((event) => cancelled.push(event));
  await cancellable.sendUserMessage({ threadId: "cancel-thread", text: "x" });
  await cancellable.interruptTurn({ threadId: "cancel-thread" });
  assert.deepEqual(runningChild.kills, ["SIGTERM"]);
  assert.equal(cancelled.at(-1).method, "turn/cancelled");

  assert.deepEqual(buildSpawnSpec("openclaw", ["agent", "--message", "hello world"], "win32"), { command: "cmd.exe", args: ["/d", "/s", "/c", "openclaw agent --message \"hello world\""] });
  assert.throws(() => new OpenClawRpcClient({ command: "bad\ncommand" }), OpenClawAdapterError);
  console.log("OpenClaw adapter tests passed.");
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
