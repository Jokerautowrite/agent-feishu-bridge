#!/usr/bin/env node

const assert = require("assert");
const { isAllowedCardOperator } = require("../src/presentation/card/card-service");

const runtime = {
  config: {
    adminOpenIds: ["ou_config_admin"],
    superAdminOpenIds: ["ou_super_admin"],
  },
  groupAdmins: {
    isAdmin: (chatId, senderId) => chatId === "oc_group" && senderId === "ou_owner",
  },
};

assert.strictEqual(
  isAllowedCardOperator(runtime, ["ou_user", "on_user"], [], "p2p", "ou_user"),
  true,
  "identified private-chat users remain allowed by default"
);
assert.strictEqual(
  isAllowedCardOperator(runtime, ["", ""], [], "p2p", "ou_user"),
  false,
  "missing private-chat identity fails closed"
);
assert.strictEqual(
  isAllowedCardOperator(runtime, ["ou_owner", ""], [], "group", "oc_group"),
  true,
  "recorded group admin is allowed"
);
assert.strictEqual(
  isAllowedCardOperator(runtime, ["ou_config_admin", ""], [], "group", "oc_other"),
  true,
  "configured group admin is allowed"
);
assert.strictEqual(
  isAllowedCardOperator(runtime, ["ou_member", ""], [], "group", "oc_group"),
  false,
  "ordinary group members cannot operate approval cards by default"
);
assert.strictEqual(
  isAllowedCardOperator(runtime, ["ou_member", "on_allowed"], ["on_allowed"], "group", "oc_group"),
  true,
  "an explicit allowlist remains authoritative"
);
assert.strictEqual(
  isAllowedCardOperator(runtime, ["ou_member", ""], [], "", ""),
  false,
  "unknown chat context fails closed without an explicit allowlist"
);

console.log("card authorization tests OK");
