#!/usr/bin/env node

const assert = require("node:assert/strict");
const { normalizeLogLevel, shouldLogCodexTraffic } = require("../src/shared/log-level");

assert.strictEqual(normalizeLogLevel("VERBOSE"), "verbose");
assert.strictEqual(normalizeLogLevel("unexpected"), "normal");
assert.strictEqual(
  shouldLogCodexTraffic({ method: "item/agentMessage/delta" }, "normal"),
  false
);
assert.strictEqual(
  shouldLogCodexTraffic({ method: "item/commandExecution/outputDelta" }, "normal"),
  false
);
assert.strictEqual(
  shouldLogCodexTraffic({ method: "thread/tokenUsage/updated" }, "normal"),
  false
);
assert.strictEqual(
  shouldLogCodexTraffic({ method: "account/rateLimits/updated" }, "normal"),
  false
);
assert.strictEqual(
  shouldLogCodexTraffic({ method: "item/started" }, "normal"),
  false
);
assert.strictEqual(
  shouldLogCodexTraffic({ method: "item/completed" }, "normal"),
  false
);
assert.strictEqual(
  shouldLogCodexTraffic({ method: "turn/diff/updated" }, "normal"),
  false
);
assert.strictEqual(
  shouldLogCodexTraffic({ method: "thread/status/changed" }, "normal"),
  false
);
assert.strictEqual(
  shouldLogCodexTraffic({ method: "turn/completed" }, "normal"),
  true
);
assert.strictEqual(
  shouldLogCodexTraffic({ method: "warning" }, "normal"),
  true
);
assert.strictEqual(
  shouldLogCodexTraffic({ method: "item/agentMessage/delta" }, "verbose"),
  true
);
assert.strictEqual(
  shouldLogCodexTraffic({ method: "item/completed" }, "verbose"),
  true
);
assert.strictEqual(
  shouldLogCodexTraffic({ method: "turn/completed" }, "quiet"),
  false
);

console.log("log level fixtures ok");
