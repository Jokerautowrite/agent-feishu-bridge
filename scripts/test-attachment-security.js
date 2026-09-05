#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { handleOutboundAttachmentDirectives } = require("../src/domain/attachments/outbound-directive-service");

async function main() {
  // Retain synthetic fixtures for inspection; never touch a real workspace.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-attachment-security-"));
  const workspace = path.join(fixture, "workspace");
  const outside = path.join(fixture, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(workspace, "deliverables"));
  fs.writeFileSync(path.join(workspace, "note.txt"), "synthetic note");
  fs.writeFileSync(path.join(workspace, "auth.json"), '{"example":"not-a-real-credential"}');
  fs.writeFileSync(path.join(workspace, ".env"), "EXAMPLE=synthetic");
  fs.writeFileSync(path.join(workspace, "deliverables", "report.txt"), "synthetic report");
  fs.writeFileSync(path.join(outside, "outside.txt"), "outside fixture");
  const failures = [];
  let checked = 0;

  function runtime(config = {}) {
    return {
      config,
      uploads: [],
      notices: [],
      sentAttachmentDirectiveKeys: new Set(),
      workspaceRootByThreadId: new Map(),
      resolveWorkspaceRootForThread: () => workspace,
      async sendLocalAttachmentToFeishu(payload) { this.uploads.push(payload); },
      async sendInfoCardMessage(payload) { this.notices.push(payload); },
    };
  }
  function send(target, requestedPath, turnId = "fixture-turn") {
    return handleOutboundAttachmentDirectives(target, {
      threadId: "fixture-thread", turnId, chatId: "fixture-chat",
      text: `Attachment\n[[codex-feishu-send:${requestedPath}]]`,
    });
  }
  async function test(name, callback) {
    try {
      await callback();
      checked += 1;
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }

  await test("regular files still upload", async () => {
    const target = runtime();
    assert.strictEqual((await send(target, "note.txt")).sent, 1);
    assert.strictEqual(target.uploads[0].fileBuffer.toString(), "synthetic note");
  });
  await test("a failed error notification does not abort later attachments", async () => {
    const target = runtime();
    target.sendInfoCardMessage = async () => { throw new Error("synthetic notice failure"); };
    const result = await handleOutboundAttachmentDirectives(target, {
      threadId: "fixture-thread", turnId: "notice-failure", chatId: "fixture-chat",
      text: "[[codex-feishu-send:missing.txt]]\n[[codex-feishu-send:note.txt]]",
    });
    assert.strictEqual(result.sent, 1);
    assert.strictEqual(target.uploads.length, 1);
  });
  for (const requestedPath of ["../outside/outside.txt", ".env", "auth.json"]) {
    await test(`reject ${requestedPath}`, async () => {
      const target = runtime();
      assert.strictEqual((await send(target, requestedPath)).sent, 0);
      assert.strictEqual(target.uploads.length, 0);
      assert.strictEqual(target.notices.length, 1);
    });
  }
  if (process.platform !== "win32") {
    fs.symlinkSync(path.join(outside, "outside.txt"), path.join(workspace, "escape.txt"));
    fs.symlinkSync(outside, path.join(workspace, "escape-dir"));
    fs.symlinkSync(path.join(workspace, "auth.json"), path.join(workspace, "alias.txt"));
    fs.symlinkSync(path.join(workspace, "note.txt"), path.join(workspace, "local-link.txt"));
    for (const requestedPath of ["escape.txt", "escape-dir/outside.txt", "alias.txt"]) {
      await test(`reject symlink ${requestedPath}`, async () => {
        const target = runtime();
        assert.strictEqual((await send(target, requestedPath)).sent, 0);
        assert.strictEqual(target.uploads.length, 0);
      });
    }
    await test("allow an internal non-sensitive symlink", async () => {
      assert.strictEqual((await send(runtime(), "local-link.txt")).sent, 1);
    });
  }
  await test("missing file is reported and retryable", async () => {
    const target = runtime();
    assert.strictEqual((await send(target, "retry.txt")).sent, 0);
    fs.writeFileSync(path.join(workspace, "retry.txt"), "retry fixture");
    assert.strictEqual((await send(target, "retry.txt")).sent, 1);
    assert.strictEqual(target.uploads.length, 1);
  });
  await test("failed upload is not remembered as sent", async () => {
    const target = runtime();
    target.sendLocalAttachmentToFeishu = async () => { throw new Error("synthetic transport failure"); };
    assert.strictEqual((await send(target, "note.txt")).sent, 0);
    target.sendLocalAttachmentToFeishu = async (payload) => target.uploads.push(payload);
    assert.strictEqual((await send(target, "note.txt")).sent, 1);
    assert.strictEqual((await send(target, "note.txt")).sent, 0);
  });
  await test("one failed directive does not suppress later attachments", async () => {
    const target = runtime();
    const result = await handleOutboundAttachmentDirectives(target, {
      threadId: "fixture-thread", turnId: "two-files", chatId: "fixture-chat",
      text: "[[codex-feishu-send:missing.txt]]\n[[codex-feishu-send:note.txt]]",
    });
    assert.strictEqual(result.sent, 1);
    assert.strictEqual(target.uploads.length, 1);
  });
  await test("optional export directory is enforced", async () => {
    const target = runtime({ attachmentExportDir: "deliverables" });
    assert.strictEqual((await send(target, "note.txt")).sent, 0);
    assert.strictEqual((await send(target, "deliverables/report.txt")).sent, 1);
    assert.strictEqual(target.uploads.length, 1);
  });
  await test("export directory cannot leave the workspace", async () => {
    const target = runtime({ attachmentExportDir: "../outside" });
    assert.strictEqual((await send(target, "note.txt")).sent, 0);
    assert.strictEqual(target.uploads.length, 0);
  });
  await test("directories and empty files are not counted as sent", async () => {
    fs.writeFileSync(path.join(workspace, "empty.txt"), "");
    const target = runtime();
    assert.strictEqual((await send(target, "deliverables")).sent, 0);
    assert.strictEqual((await send(target, "empty.txt")).sent, 0);
  });
  await test("image upload limit is enforced", async () => {
    fs.writeFileSync(path.join(workspace, "large.png"), Buffer.alloc(10 * 1024 * 1024 + 1));
    const target = runtime();
    assert.strictEqual((await send(target, "large.png")).sent, 0);
    assert.strictEqual(target.uploads.length, 0);
  });
  assert.deepStrictEqual(failures, [], failures.join("\n"));
  console.log(`attachment security fixtures ok (${checked} cases; no network uploads)`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
