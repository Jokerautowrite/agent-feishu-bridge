#!/usr/bin/env node

const assert = require("assert");
const { checkGroupCommandAuthorization } = require("../src/app/dispatcher");
const { createGroupAdminStore } = require("../src/domain/group/group-admin-store");

// 管理员来自"谁拉机器人进群"
const store = createGroupAdminStore({ persist: async () => {} });
store.addAdmin("oc_grp", "ou_owner");

const runtime = {
  groupAdmins: store,
  config: { adminOpenIds: [] },
};

(async () => {
  // 群聊命令：管理员可执行
  const ownerCmd = {
    chatType: "group",
    chatId: "oc_grp",
    senderId: "ou_owner",
    command: "where",
    text: "/where",
  };
  assert.strictEqual(await checkGroupCommandAuthorization(runtime, ownerCmd), true, "group admin command allowed");

  // 群聊命令：非管理员拒绝（静默）
  const strangerCmd = {
    chatType: "group",
    chatId: "oc_grp",
    senderId: "ou_stranger",
    command: "stop",
    text: "/stop",
  };
  assert.strictEqual(await checkGroupCommandAuthorization(runtime, strangerCmd), false, "group non-admin command rejected");

  // 群聊普通消息：人人可发（不是命令）
  const chatMsg = {
    chatType: "group",
    chatId: "oc_grp",
    senderId: "ou_stranger",
    command: "message",
    text: "随便聊聊",
  };
  assert.strictEqual(await checkGroupCommandAuthorization(runtime, chatMsg), true, "group plain chat allowed");

  // 私聊命令：不限制
  const p2pCmd = {
    chatType: "p2p",
    chatId: "ou_stranger",
    senderId: "ou_stranger",
    command: "bind",
    text: "/bind",
  };
  assert.strictEqual(await checkGroupCommandAuthorization(runtime, p2pCmd), true, "p2p command allowed");

  // 群聊命令：config 兜底管理员
  const configAdminRuntime = {
    groupAdmins: store,
    config: { adminOpenIds: ["ou_config_admin"] },
  };
  const configAdminCmd = {
    chatType: "group",
    chatId: "oc_grp",
    senderId: "ou_config_admin",
    command: "model",
    text: "/model",
  };
  assert.strictEqual(await checkGroupCommandAuthorization(configAdminRuntime, configAdminCmd), true, "config admin allowed");

  console.log("group-authz tests OK");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
