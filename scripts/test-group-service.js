#!/usr/bin/env node

const assert = require("assert");
const groupService = require("../src/domain/group/group-service");
const { applyGroupMentionPolicy } = require("../src/app/dispatcher");

const BOT_OPEN_ID = "ou_12345678901234567890123456789012345";

function mention(overrides = {}) {
  return {
    key: "@_user_1",
    openId: "",
    userId: "",
    name: "小策",
    ...overrides,
  };
}

// ── isBotMentioned ──
assert.strictEqual(groupService.isBotMentioned([], BOT_OPEN_ID), false, "empty mentions");
assert.strictEqual(
  groupService.isBotMentioned([mention({ openId: "ou_other" })], BOT_OPEN_ID),
  false,
  "mention of other user"
);
assert.strictEqual(
  groupService.isBotMentioned([mention({ openId: BOT_OPEN_ID })], BOT_OPEN_ID),
  true,
  "mention of bot by open_id"
);
assert.strictEqual(
  groupService.isBotMentioned([mention({ userId: BOT_OPEN_ID })], BOT_OPEN_ID),
  true,
  "mention of bot by user_id"
);
assert.strictEqual(groupService.isBotMentioned([mention()], ""), false, "empty bot id");

// ── stripBotMention ──
assert.strictEqual(
  groupService.stripBotMention("@小策 帮我写个脚本", [mention({ openId: BOT_OPEN_ID })], BOT_OPEN_ID),
  "帮我写个脚本",
  "strip leading @name"
);
assert.strictEqual(
  groupService.stripBotMention("帮我 @小策 写个脚本", [mention({ openId: BOT_OPEN_ID })], BOT_OPEN_ID),
  "帮我 写个脚本",
  "strip mid @name"
);
assert.strictEqual(
  groupService.stripBotMention("@小策", [mention({ openId: BOT_OPEN_ID })], BOT_OPEN_ID),
  "",
  "strip only mention"
);
assert.strictEqual(
  groupService.stripBotMention("普通消息", [mention()], "ou_other"),
  "普通消息",
  "no-op when bot not mentioned"
);
assert.strictEqual(
  groupService.stripBotMention("", [mention({ openId: BOT_OPEN_ID })], BOT_OPEN_ID),
  "",
  "empty text no-op"
);

// ── resolveBotOpenId ──
(async () => {
  let callCount = 0;
  const runtime = {
    requireFeishuAdapter: () => ({
      getBotInfo: async () => {
        callCount += 1;
        return { openId: BOT_OPEN_ID, name: "小策" };
      },
    }),
  };
  assert.strictEqual(await groupService.resolveBotOpenId(runtime, ""), BOT_OPEN_ID);
  assert.strictEqual(await groupService.resolveBotOpenId(runtime, ""), BOT_OPEN_ID, "cached");
  assert.strictEqual(callCount, 1, "adapter called only once");
  assert.strictEqual(await groupService.resolveBotOpenId({}, "ou_configured"), "ou_configured");

  // ── applyGroupMentionPolicy ──
  const policyRuntime = {
    config: { groupMentionOnly: true },
    resolvedBotOpenId: BOT_OPEN_ID,
    sendInfoCardMessage: async () => {},
  };

  // command passes through unchanged
  const cmdNormalized = { chatType: "group", text: "/help", command: "help", mentions: [mention()], chatId: "oc_g1", messageId: "om_1" };
  assert.strictEqual(await applyGroupMentionPolicy(policyRuntime, cmdNormalized), cmdNormalized, "command allowed");

  // mentioned → stripped
  const mentionedNormalized = { chatType: "group", text: "@小策 帮我看看这个", command: "message", mentions: [mention({ openId: BOT_OPEN_ID })], chatId: "oc_g2", messageId: "om_2" };
  const strippedResult = await applyGroupMentionPolicy(policyRuntime, mentionedNormalized);
  assert.ok(strippedResult, "mentioned allowed");
  assert.strictEqual(strippedResult.text, "帮我看看这个");
  assert.strictEqual(strippedResult.command, "message");

  // mention + command
  const mentionCommand = { chatType: "group", text: "@小策 /where", command: "message", mentions: [mention({ openId: BOT_OPEN_ID })], chatId: "oc_g3", messageId: "om_3" };
  const mentionCommandResult = await applyGroupMentionPolicy(policyRuntime, mentionCommand);
  assert.ok(mentionCommandResult, "mention+command allowed");
  assert.strictEqual(mentionCommandResult.text, "/where");
  assert.strictEqual(mentionCommandResult.command, "where", "command re-parsed after strip");

  // not mentioned → ignored
  const ignored = { chatType: "group", text: "随便聊聊", command: "message", mentions: [mention({ openId: "ou_other" })], chatId: "oc_g4", messageId: "om_4" };
  assert.strictEqual(await applyGroupMentionPolicy(policyRuntime, ignored), null, "not mentioned ignored");

  // mention only, empty text → greeting, not passed through
  const emptyMention = { chatType: "group", text: "@小策", command: "message", mentions: [mention({ openId: BOT_OPEN_ID })], chatId: "oc_g5", messageId: "om_5" };
  assert.strictEqual(await applyGroupMentionPolicy(policyRuntime, emptyMention), null, "empty mention greeted not passed");

  // groupMentionOnly disabled → allow all
  const openRuntime = { config: { groupMentionOnly: false }, resolvedBotOpenId: BOT_OPEN_ID };
  const openMsg = { chatType: "group", text: "随便聊聊", command: "message", mentions: [], chatId: "oc_g6", messageId: "om_6" };
  assert.strictEqual(await applyGroupMentionPolicy(openRuntime, openMsg), openMsg, "filter disabled allows all");

  // exempt chat allowlist → allow without mention
  const exemptRuntime = {
    config: { groupMentionOnly: true, groupMentionExemptChats: ["oc_exempt"] },
    resolvedBotOpenId: BOT_OPEN_ID,
  };
  const exemptMsg = { chatType: "group", text: "免@群聊", command: "message", mentions: [], chatId: "oc_exempt", messageId: "om_exempt" };
  assert.strictEqual(await applyGroupMentionPolicy(exemptRuntime, exemptMsg), exemptMsg, "exempt chat allows all");

  console.log("group-service tests OK");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
