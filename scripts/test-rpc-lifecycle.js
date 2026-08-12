#!/usr/bin/env node

const assert = require("node:assert/strict");
const { buildSpawnSpec, CodexRpcClient } = require("../src/infra/codex/rpc-client");

(async () => {
  assert.deepEqual(buildSpawnSpec("codex.exe", "openai", "win32"), {
    command: "codex.exe",
    args: ["--profile", "openai", "app-server"],
  });
  assert.deepEqual(buildSpawnSpec("codex.cmd", "", "win32"), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "codex.cmd", "app-server"],
  });

  const missing = new CodexRpcClient({ codexCommand: "definitely-missing-agent-bridge-command" });
  await assert.rejects(missing.connect(), /Unable to spawn Codex app-server/);

  const client = new CodexRpcClient({ codexCommand: "unused" });
  let logged = false;
  const originalError = console.error;
  console.error = (message) => {
    if (String(message).includes("Codex message listener failed")) logged = true;
  };
  try {
    client.onMessage(async () => { throw new Error("listener fixture"); });
    client.handleIncoming(JSON.stringify({ method: "fixture/event", params: {} }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(logged, true);
  } finally {
    console.error = originalError;
  }
  console.log("RPC lifecycle tests OK");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
