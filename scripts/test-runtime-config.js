#!/usr/bin/env node
const assert = require("assert");
const { readConfig } = require("../src/infra/config/config");

const keys = [
  "AGENT_BRIDGE_CODEX_TURN_START_TIMEOUT_MS", "CODEX_IM_CODEX_TURN_START_TIMEOUT_MS",
  "AGENT_BRIDGE_ATTACHMENT_EXPORT_DIR", "CODEX_IM_ATTACHMENT_EXPORT_DIR",
  "AGENT_BRIDGE_GROUP_SENDER_ALLOWLIST", "CODEX_IM_GROUP_SENDER_ALLOWLIST",
];
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
try {
  for (const key of keys) delete process.env[key];
  assert.strictEqual(readConfig().codexTurnStartTimeoutMs, 60000);
  assert.strictEqual(readConfig().attachmentExportDir, "");
  process.env.AGENT_BRIDGE_CODEX_TURN_START_TIMEOUT_MS = "172800000";
  assert.strictEqual(
    readConfig().codexTurnStartTimeoutMs,
    172800000,
    "ack timeout passes through without a hard ceiling (long chuang turns)",
  );
  process.env.AGENT_BRIDGE_CODEX_TURN_START_TIMEOUT_MS = "120000";
  assert.strictEqual(readConfig().codexTurnStartTimeoutMs, 120000);
  process.env.AGENT_BRIDGE_ATTACHMENT_EXPORT_DIR = "deliverables";
  assert.strictEqual(readConfig().attachmentExportDir, "deliverables");
  delete process.env.AGENT_BRIDGE_ATTACHMENT_EXPORT_DIR;
  process.env.CODEX_IM_ATTACHMENT_EXPORT_DIR = "exports";
  assert.strictEqual(readConfig().attachmentExportDir, "exports");
  delete process.env.CODEX_IM_ATTACHMENT_EXPORT_DIR;
  process.env.AGENT_BRIDGE_GROUP_SENDER_ALLOWLIST = "oc_a:ou_1,ou_2;oc_b:ou_3;bad-entry";
  assert.deepStrictEqual(
    readConfig().groupSenderAllowlists,
    { oc_a: ["ou_1", "ou_2"], oc_b: ["ou_3"] },
    "group sender allowlists parse into per-chat sender lists"
  );
  // 新前缀优先于旧前缀
  process.env.CODEX_IM_GROUP_SENDER_ALLOWLIST = "oc_old:ou_old";
  assert.deepStrictEqual(
    readConfig().groupSenderAllowlists,
    { oc_a: ["ou_1", "ou_2"], oc_b: ["ou_3"] },
    "new env prefix wins over legacy prefix"
  );
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
console.log("runtime config fixtures ok");
