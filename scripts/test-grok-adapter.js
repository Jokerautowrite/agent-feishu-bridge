"use strict";

const assert = require("assert");
const { GrokRpcClient } = require("../src/infra/grok/rpc-client");

if (process.argv.includes("--fake-grok")) {
  runFakeGrok();
} else {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

async function main() {
  const events = [];
  const stderr = [];
  const client = new GrokRpcClient({
    command: process.execPath,
    commandArgs: [__filename, "--fake-grok"],
    cwd: process.cwd(),
    firstEventTimeoutMs: 1000,
    turnTimeoutMs: 3000,
  });
  client.onMessage((message) => events.push(message));
  client.onStderr((message) => stderr.push(message.text));

  const availability = await client.connect();
  assert.equal(availability.available, true, "version probe should recognize Grok");
  assert.match(availability.version, /^grok\b/i);
  await client.initialize();
  const thread = await client.startThread({ cwd: process.cwd() });
  const threadId = thread.threadId;
  const first = await client.sendUserMessage({ threadId, text: "first prompt", model: "grok-build", effort: "high" });
  await waitFor(events, (event) => event.method === "turn/completed" && event.params.turnId === first.turnId);
  const second = await client.sendUserMessage({ threadId, text: "second prompt" });
  await waitFor(events, (event) => event.method === "turn/completed" && event.params.turnId === second.turnId);

  const firstText = events.filter((event) => event.params?.turnId === first.turnId && event.method === "item/agentMessage/delta").map((event) => event.params.delta).join("");
  assert.equal(firstText, "streamed answer");
  assert(events.some((event) => event.method === "item/completed" && event.params?.turnId === first.turnId && event.params.item.text === "streamed answer"));
  assert(events.some((event) => event.method === "item/reasoning/summaryPartAdded" && event.params?.turnId === first.turnId));
  assert(events.some((event) => event.method === "thread/tokenUsage/updated" && event.params?.tokenUsage?.totalTokens === 5));
  assert(stderr.some((text) => text.includes("fake diagnostic")), "stderr should be exposed separately");

  assert(stderr.some((text) => text.includes("--resume") && text.includes("fake-session")), "later turns must resume the CLI session returned by the first turn");

  const slowThread = (await client.startThread({ cwd: process.cwd() })).threadId;
  const slow = await client.sendUserMessage({ threadId: slowThread, text: "slow prompt" });
  await sleep(20);
  const interrupted = await client.interrupt(slowThread);
  assert.equal(interrupted.interrupted, true);
  await waitFor(events, (event) => event.method === "turn/cancelled" && event.params.turnId === slow.turnId);
  assert(!events.some((event) => event.method === "turn/failed" && event.params?.turnId === slow.turnId));

  const listed = await client.listThreads();
  assert(listed.data.some((item) => item.id === threadId));

  const catalogClient = new GrokRpcClient({
    command: process.execPath,
    commandArgs: [__filename, "--fake-grok"],
    env: { GROK_MODEL: "grok-4.5", GROK_MODELS: "grok-4.5,grok-4.6" },
  });
  const catalog = await catalogClient.listModels();
  assert.deepEqual(catalog.models.map((item) => item.model), ["grok-4.5", "grok-4.6"]);
  assert.equal(catalog.models.find((item) => item.model === "grok-4.5")?.isDefault, true);
  assert.equal(catalog.models.find((item) => item.model === "grok-4.5")?.displayName, "Grok 4.5");

  console.log("Grok adapter tests passed");
}

function runFakeGrok() {
  const args = process.argv.slice(process.argv.indexOf("--fake-grok") + 1);
  if (args.includes("--version")) {
    console.log("grok 0.test");
    return;
  }
  if (args.includes("slow prompt")) {
    setInterval(() => {}, 1000);
    return;
  }
  process.stderr.write(`fake diagnostic args=${JSON.stringify(args)}\n`);
  process.stdout.write('{"type":"text","data":"streamed "}\n');
  process.stdout.write('{"type":"thought","data":"checking"}\n');
  process.stdout.write('{"type":"text","data":"answer"}\n');
  process.stdout.write('{"type":"end","sessionId":"fake-session","usage":{"inputTokens":2,"outputTokens":3}}\n');
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
