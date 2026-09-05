#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ClaudeRpcClient } = require("../src/infra/claude/rpc-client");
const { SessionStore } = require("../src/infra/storage/session-store");

if (process.argv.includes("--fake-claude")) {
  runFakeClaude();
} else {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-claude-adapter-"));
  const storePath = path.join(fixture, "sessions.json");
  const store = new SessionStore({ filePath: storePath });
  const events = [];
  const client = createClient(store, events, `${storePath}.invocations`);
  const threadId = (await client.startThread({ cwd: fixture })).threadId;
  const first = await client.sendUserMessage({ threadId, text: "first prompt", workspaceRoot: fixture });
  await waitFor(events, (event) => event.method === "turn/completed" && event.params.turnId === first.turnId);

  const persisted = store.getBackendSession(threadId);
  assert.equal(persisted.sessionId, "fake-session");
  assert.equal(persisted.cwd, fixture);

  const restartedEvents = [];
  const restarted = createClient(
    new SessionStore({ filePath: storePath }),
    restartedEvents,
    `${storePath}.invocations`
  );
  await restarted.resumeThread({ threadId });
  const second = await restarted.sendUserMessage({ threadId, text: "second prompt", workspaceRoot: fixture });
  await waitFor(restartedEvents, (event) => event.method === "turn/completed" && event.params.turnId === second.turnId);
  const invocations = readInvocations(`${storePath}.invocations`);
  assert.deepStrictEqual(invocations[1], {
    prompt: "second prompt",
    resumedSessionId: "fake-session",
  });

  const failedEvents = [];
  const failedClient = createClient(
    new SessionStore({ filePath: path.join(fixture, "failed.json") }),
    failedEvents,
    `${path.join(fixture, "failed.json")}.invocations`
  );
  const failedThread = (await failedClient.startThread({ cwd: fixture })).threadId;
  const failed = await failedClient.sendUserMessage({
    threadId: failedThread,
    text: "fail prompt",
    workspaceRoot: fixture,
  });
  await waitFor(failedEvents, (event) => event.method === "turn/failed" && event.params.turnId === failed.turnId);
  assert.equal(
    failedEvents.filter((event) => event.method === "turn/failed" && event.params.turnId === failed.turnId).length,
    1
  );
  assert(!failedEvents.some((event) => event.method === "turn/completed" && event.params.turnId === failed.turnId));

  console.log("Claude adapter tests passed");
}

function createClient(sessionStore, events, invocationPath) {
  const client = new ClaudeRpcClient({
    command: process.execPath,
    commandArgs: [__filename, "--fake-claude", invocationPath || ""],
    cwd: process.cwd(),
    sessionStore,
  });
  client.onMessage((message) => events.push(message));
  client.log = () => {};
  return client;
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

function readInvocations(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function runFakeClaude() {
  const args = process.argv.slice(process.argv.indexOf("--fake-claude") + 1);
  const invocationPath = args[0];
  const prompt = args.find((arg) => arg === "first prompt" || arg === "second prompt" || arg === "fail prompt") || "";
  if (invocationPath) {
    const existing = fs.existsSync(invocationPath)
      ? JSON.parse(fs.readFileSync(invocationPath, "utf8"))
      : [];
    existing.push({
      prompt,
      resumedSessionId: args[args.indexOf("--resume") + 1] || null,
    });
    fs.writeFileSync(invocationPath, JSON.stringify(existing));
  }
  const failed = prompt === "fail prompt";
  process.stdout.write(`${JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "fake-session",
  })}\n`);
  if (failed) {
    process.stdout.write(`${JSON.stringify({
      type: "result",
      is_error: true,
      result: "synthetic failure",
      session_id: "fake-session",
    })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "answer" }] },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: "result",
      is_error: false,
      session_id: "fake-session",
    })}\n`);
  }
}
