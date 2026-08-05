#!/usr/bin/env node

const assert = require("node:assert/strict");
const { claimInboundMessage } = require("../src/app/feishu-bot-runtime");

const cache = new Map();
assert.strictEqual(claimInboundMessage(cache, "om_test", 1000), true);
assert.strictEqual(claimInboundMessage(cache, "om_test", 1001), false);
assert.strictEqual(claimInboundMessage(cache, "om_test", 1000 + (10 * 60 * 1000) + 1), true);
assert.strictEqual(claimInboundMessage(cache, "", 1002), true);

console.log("inbound message dedup fixtures ok");
