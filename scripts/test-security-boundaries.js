#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isAuthorizedIncomingMessage } = require("../src/app/dispatcher");
const { resolveWorkspaceSendTarget } = require("../src/domain/workspace/workspace-service");
const { handleCardAction } = require("../src/presentation/card/card-service");

function testIncomingAuthorization() {
  const runtime = { config: {
    allowedSenderOpenIds: ["ou_owner"],
    adminOpenIds: [],
    superAdminOpenIds: [],
    groupAllowedChats: ["oc_allowed"],
  } };
  assert.equal(isAuthorizedIncomingMessage(runtime, { chatType: "p2p", senderId: "ou_owner" }), true);
  assert.equal(isAuthorizedIncomingMessage(runtime, { chatType: "p2p", senderId: "ou_stranger" }), false);
  assert.equal(isAuthorizedIncomingMessage(runtime, { chatType: "group", chatId: "oc_allowed", senderId: "ou_user" }), true);
  assert.equal(isAuthorizedIncomingMessage(runtime, { chatType: "group", chatId: "oc_other", senderId: "ou_user" }), false);
}

function testWorkspaceRealPathBoundary() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-boundary-"));
  const workspace = path.join(tempRoot, "workspace");
  const outside = path.join(tempRoot, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(workspace, "inside.txt"), "inside");
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
  assert.equal(resolveWorkspaceSendTarget(workspace, "inside.txt").errorText, undefined);
  assert.ok(resolveWorkspaceSendTarget(workspace, "../outside/secret.txt").errorText);
  try {
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "linked.txt"), "file");
    assert.match(resolveWorkspaceSendTarget(workspace, "linked.txt").errorText, /链接|link/i);
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
    console.warn(`symlink boundary fixture skipped: ${error.code}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function testApprovalOwnership() {
  let handled = 0;
  const runtime = {
    config: { cardActionSenderAllowlist: [], allowedSenderOpenIds: [], adminOpenIds: [], superAdminOpenIds: [], groupAllowedChats: ["oc_group"] },
    pendingApprovalByThreadId: new Map([["thread-1", { requestId: "request-1", requesterSenderId: "ou_owner" }]]),
    groupAdmins: { isAdmin: () => false },
    resolveChatType: () => "group",
    handleApprovalCardActionAsync: async () => { handled += 1; },
    buildCardToast: () => ({}),
  };
  const makeData = (openId) => ({
    operator: { open_id: openId },
    context: { open_chat_id: "oc_group" },
    action: { value: { kind: "approval", decision: "approve", requestId: "request-1", threadId: "thread-1" } },
  });
  handleCardAction(runtime, makeData("ou_stranger"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handled, 0, "a group member must not approve another user's request");
  handleCardAction(runtime, makeData("ou_owner"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handled, 1, "the request initiator may approve their request");
}

(async () => {
  testIncomingAuthorization();
  testWorkspaceRealPathBoundary();
  await testApprovalOwnership();
  console.log("security boundary tests OK");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
