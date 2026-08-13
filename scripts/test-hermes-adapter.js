"use strict";

const assert = require("assert");
const { HermesRpcClient, buildHermesArgs, parseHermesOutput } = require("../src/infra/hermes/rpc-client");

const MOCK_HERMES = String.raw`
const args = process.argv.slice(1);
if (args.includes("--version")) { console.log("hermes-agent 0.test"); process.exit(0); }
if (args.includes("--fail")) { console.error("simulated provider failure"); process.exit(7); }
if (args.includes("--sleep")) { setInterval(() => {}, 1000); }
const query = args[args.indexOf("--query") + 1] || "";
const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : "new-session";
console.log("answer: " + query);
console.log("session_id: " + resume);
`;

async function main() {
  assert.deepStrictEqual(parseHermesOutput("hello\nsession_id: abc\n"), { text: "hello", sessionId: "abc" });
  assert.deepStrictEqual(
    buildHermesArgs({ prefixArgs: [], prompt: "hi", model: "nous/model", resumeSessionId: "abc" }).slice(-6),
    ["--query", "hi", "--model", "nous/model", "--resume", "abc"]
  );

  const client = createClient();
  const availability = await client.checkAvailability();
  assert.strictEqual(availability.available, true, availability.error);
  await client.connect();

  const events = [];
  client.onMessage((message) => events.push(message));
  const started = await client.startThread({ cwd: process.cwd() });
  const first = await client.sendUserMessage({ threadId: started.threadId, text: "first turn" });
  await waitFor(events, (event) => event.method === "turn/completed" && event.params.turnId === first.turnId);
  const text = events.find((event) => event.method === "item/completed" && event.params.turnId === first.turnId)?.params.item.text;
  assert.strictEqual(text, "answer: first turn");
  assert.strictEqual(client.threads.get(started.threadId).hermesSessionId, "new-session");

  const second = await client.sendUserMessage({ threadId: started.threadId, text: "second turn" });
  await waitFor(events, (event) => event.method === "turn/completed" && event.params.turnId === second.turnId);
  assert.strictEqual(client.threads.get(started.threadId).hermesSessionId, "new-session");

  const failed = createClient({ hermesArgs: ["-e", MOCK_HERMES, "--", "--fail"] });
  const failedEvents = [];
  failed.onMessage((message) => failedEvents.push(message));
  const failedTurn = await failed.sendUserMessage({ text: "failure" });
  const failedEvent = await waitFor(failedEvents, (event) => event.method === "turn/failed" && event.params.turnId === failedTurn.turnId);
  assert.match(failedEvent.params.error.message, /simulated provider failure/);

  const sleeping = createClient({ hermesArgs: ["-e", MOCK_HERMES, "--", "--sleep"] });
  const sleepingEvents = [];
  sleeping.onMessage((message) => sleepingEvents.push(message));
  const sleepingTurn = await sleeping.sendUserMessage({ text: "stop" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await sleeping.interrupt(sleepingTurn.threadId);
  await waitFor(sleepingEvents, (event) => event.method === "turn/cancelled" && event.params.threadId === sleepingTurn.threadId);
  assert.strictEqual(sleepingEvents.some((event) => event.method === "turn/failed"), false);

  console.log("Hermes adapter contract tests passed.");
}

function createClient(overrides = {}) {
  return new HermesRpcClient({
    hermesCommand: process.execPath,
    hermesArgs: ["-e", MOCK_HERMES],
    firstOutputTimeoutMs: 1000,
    turnTimeoutMs: 2000,
    ...overrides,
  });
}

function waitFor(events, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = events.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for adapter event"));
      }
    }, 5);
  });
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
