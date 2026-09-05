#!/usr/bin/env node

const assert = require("node:assert/strict");
const { createFeishuWsLifecycleCallbacks } = require("../src/app/feishu-bot-runtime");

function main() {
  const events = [];
  const callbacks = createFeishuWsLifecycleCallbacks({
    handleFeishuConnectionEvent: (state, error) => {
      events.push({ state, error: error?.message || error || "" });
    },
  });

  assert.equal(callbacks.wsConfig.pingTimeout, 45);
  callbacks.onReady();
  callbacks.onReconnecting();
  callbacks.onReconnected();
  callbacks.onError(new Error("socket closed"));

  assert.deepEqual(events, [
    { state: "ready", error: "" },
    { state: "reconnecting", error: "" },
    { state: "reconnected", error: "" },
    { state: "failed", error: "socket closed" },
  ]);
  console.log("Feishu connection lifecycle fixtures ok");
}

main();
