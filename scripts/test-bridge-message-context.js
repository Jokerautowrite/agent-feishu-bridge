#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  listSupportedBackends,
  loadBackendClient,
} = require("../src/infra/backend-registry");
const {
  buildMessageWithBridgeCapabilities,
} = require("../src/domain/thread/thread-service");

const STATIC_CAPABILITY_MARKER = /<feishu-bridge-capabilities>|This Feishu\/Lark bridge can send current-workspace attachments/;
const expectedBackends = [
  "codex",
  "opencode",
  "claude",
  "chuang",
  "openclaw",
  "hermes",
  "grok",
  "gemini",
];

assert.deepStrictEqual(listSupportedBackends(), expectedBackends);
for (const backend of expectedBackends) {
  assert.strictEqual(typeof loadBackendClient(backend), "function", `${backend} must expose a client`);
}

const directMessage = buildMessageWithBridgeCapabilities({
  chatType: "p2p",
  text: "只转发这一句",
});
assert.strictEqual(directMessage, "只转发这一句");
assert.doesNotMatch(directMessage, STATIC_CAPABILITY_MARKER);

const groupMessage = buildMessageWithBridgeCapabilities({
  chatType: "group",
  isGroupAdmin: false,
  senderName: "成员",
  text: "看看状态",
});
assert.match(groupMessage, /【群聊·成员】看看状态/);
assert.match(groupMessage, /<group-hard-guard>/);
assert.doesNotMatch(groupMessage, STATIC_CAPABILITY_MARKER);

const dynamicAttachmentNote = "[System note: A Feishu/Lark user sent an image for this turn.]";
assert.strictEqual(
  buildMessageWithBridgeCapabilities({ chatType: "p2p", text: dynamicAttachmentNote }),
  dynamicAttachmentNote,
  "per-message attachment context must remain intact"
);

const sourceRoot = path.resolve(__dirname, "..", "src");
for (const filePath of listJavaScriptFiles(sourceRoot)) {
  assert.doesNotMatch(
    fs.readFileSync(filePath, "utf8"),
    STATIC_CAPABILITY_MARKER,
    `static bridge capabilities must not be injected from ${path.relative(sourceRoot, filePath)}`
  );
}

console.log("bridge message context tests OK");

function listJavaScriptFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJavaScriptFiles(filePath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(filePath);
    }
  }
  return files;
}
