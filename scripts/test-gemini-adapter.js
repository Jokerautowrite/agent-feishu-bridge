#!/usr/bin/env node

"use strict";

const assert = require("assert");
const { GeminiRpcClient, buildGeminiArgs, buildSpawnSpec } = require("../src/infra/gemini/rpc-client");

if (process.argv.includes("--fake-gemini")) {
  runFakeGemini();
} else {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

async function main() {
  const safeArgs = buildGeminiArgs({ prompt: "hello", accessMode: "default" });
  assert.deepStrictEqual(safeArgs, ["--prompt", "hello", "--output-format", "stream-json"]);
  assert.deepStrictEqual(
    buildGeminiArgs({ prompt: "inspect", accessMode: "group-readonly" }),
    ["--prompt", "inspect", "--output-format", "stream-json", "--approval-mode", "plan"]
  );
  const fullAccessArgs = buildGeminiArgs({
    prompt: "write",
    model: "gemini-2.5-pro",
    sessionId: "session-1",
    accessMode: "full-access",
  });
  assert.deepStrictEqual(fullAccessArgs, [
    "--prompt", "write",
    "--output-format", "stream-json",
    "--model", "gemini-2.5-pro",
    "--approval-mode", "yolo",
    "--resume", "session-1",
  ]);
  assert.deepStrictEqual(
    buildSpawnSpec("C:\\Program Files\\nodejs\\node.exe", ["script.js"], "win32"),
    { command: "C:\\Program Files\\nodejs\\node.exe", args: ["script.js"] },
    "native Windows executables bypass cmd.exe quoting"
  );

  const events = [];
  const diagnostics = [];
  const client = new GeminiRpcClient({
    command: process.execPath,
    commandArgs: [__filename, "--fake-gemini"],
    cwd: process.cwd(),
    firstEventTimeoutMs: 1000,
    turnTimeoutMs: 3000,
  });
  client.onMessage((message) => events.push(message));
  client.onStderr((message) => diagnostics.push(message.text));

  const availability = await client.connect();
  assert.strictEqual(availability.available, true);
  assert.match(availability.version, /^0\.test/);
  await client.initialize();

  const threadId = (await client.startThread({ cwd: process.cwd() })).threadId;
  const first = await client.sendUserMessage({
    threadId,
    text: "first prompt",
    attachments: [{ filePath: "C:\\tmp\\image.png" }],
    model: "gemini-2.5-pro",
  });
  await waitFor(events, (event) => event.method === "turn/completed" && event.params.turnId === first.turnId);
  const firstText = events
    .filter((event) => event.method === "item/agentMessage/delta" && event.params?.turnId === first.turnId)
    .map((event) => event.params.delta)
    .join("");
  assert.strictEqual(firstText, "streamed answer");
  assert(events.some((event) => event.method === "item/started" && event.params?.item?.toolName === "read_file"));
  assert(events.some((event) => event.method === "item/completed" && event.params?.item?.id === "tool-1"));
  assert(events.some((event) => event.method === "thread/tokenUsage/updated" && event.params?.tokenUsage?.totalTokens === 5));

  const second = await client.sendUserMessage({ threadId, text: "second prompt" });
  await waitFor(events, (event) => event.method === "turn/completed" && event.params.turnId === second.turnId);
  assert(
    diagnostics.some((text) => text.includes("--resume") && text.includes("gemini-session-1")),
    "later turns resume the native Gemini session"
  );

  const slowThread = (await client.startThread({ cwd: process.cwd() })).threadId;
  const slow = await client.sendUserMessage({ threadId: slowThread, text: "slow prompt" });
  await sleep(20);
  const interrupted = await client.interrupt(slowThread);
  assert.strictEqual(interrupted.interrupted, true);
  await waitFor(events, (event) => event.method === "turn/cancelled" && event.params.turnId === slow.turnId);

  console.log("Gemini adapter tests passed");
}

function runFakeGemini() {
  const marker = process.argv.indexOf("--fake-gemini");
  const args = process.argv.slice(marker + 1);
  if (args.includes("--version")) {
    console.log("0.test.0");
    return;
  }
  if (args.includes("slow prompt")) {
    setInterval(() => {}, 1000);
    return;
  }
  process.stderr.write(`fake gemini args=${JSON.stringify(args)}\n`);
  process.stdout.write('{"type":"init","session_id":"gemini-session-1","model":"gemini-2.5-pro"}\n');
  process.stdout.write('{"type":"message","role":"assistant","content":"streamed ","delta":true}\n');
  process.stdout.write('{"type":"tool_use","tool_name":"read_file","tool_id":"tool-1","parameters":{"path":"README.md"}}\n');
  process.stdout.write('{"type":"tool_result","tool_id":"tool-1","status":"success","output":"ok"}\n');
  process.stdout.write('{"type":"message","role":"assistant","content":"answer","delta":true}\n');
  process.stdout.write('{"type":"error","message":"non-fatal warning"}\n');
  process.stdout.write('{"type":"result","status":"success","stats":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}\n');
}

function waitFor(events, predicate, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (events.some(predicate)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error("timed out waiting for event"));
      }
    }, 10);
  });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
