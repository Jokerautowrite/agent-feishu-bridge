#!/usr/bin/env node

const assert = require("assert");
const { FeishuClientAdapter } = require("../src/infra/feishu/client-adapter");
const { normalizeFeishuTextEvent } = require("../src/presentation/message/normalizers");
const {
  classifyLocalAttachment,
  inferFeishuFileType,
  isSafeTextFile,
} = require("../src/shared/media-types");

async function main() {
  testMediaClassification();
  testNonTextNormalizers();
  await testFeishuAdapterResources();
  console.log("media fixtures ok");
}

function testMediaClassification() {
  assert.strictEqual(classifyLocalAttachment("out.png"), "image");
  assert.strictEqual(classifyLocalAttachment("voice.opus"), "audio");
  assert.strictEqual(classifyLocalAttachment("voice.mp4"), "audio");
  assert.strictEqual(classifyLocalAttachment("notes.md"), "file");
  assert.strictEqual(inferFeishuFileType("voice.opus"), "opus");
  assert.strictEqual(inferFeishuFileType("clip.mp4"), "mp4");
  assert.strictEqual(inferFeishuFileType("paper.pdf"), "pdf");
  assert.strictEqual(inferFeishuFileType("notes.md"), "stream");
  assert.strictEqual(isSafeTextFile("notes.md"), true);
  assert.strictEqual(isSafeTextFile("archive.zip"), false);
}

function testNonTextNormalizers() {
  const config = { defaultWorkspaceId: "default" };
  const sender = { sender_id: { open_id: "ou_test" } };

  const image = normalizeFeishuTextEvent({
    sender,
    message: {
      message_type: "image",
      chat_id: "oc_test",
      message_id: "om_image",
      content: JSON.stringify({ image_key: "img_key" }),
    },
  }, config);
  assert.strictEqual(image.command, "image_message");
  assert.deepStrictEqual(image.attachments[0], {
    kind: "image",
    resourceKey: "img_key",
    resourceType: "image",
  });

  const richImage = normalizeFeishuTextEvent({
    sender,
    message: {
      message_type: "post",
      chat_id: "oc_test",
      message_id: "om_post",
      content: JSON.stringify({
        post: {
          zh_cn: {
            content: [[
              { tag: "text", text: "please inspect" },
              { tag: "img", image_key: "img_post_key" },
            ]],
          },
        },
      }),
    },
  }, config);
  assert.strictEqual(richImage.command, "message");
  assert.strictEqual(richImage.text, "please inspect");
  assert.deepStrictEqual(richImage.attachments[0], {
    kind: "image",
    resourceKey: "img_post_key",
    resourceType: "image",
  });

  const file = normalizeFeishuTextEvent({
    sender,
    message: {
      message_type: "file",
      chat_id: "oc_test",
      message_id: "om_file",
      content: JSON.stringify({
        file_key: "file_key",
        file_name: "report.md",
        file_size: 42,
        file_type: "stream",
      }),
    },
  }, config);
  assert.strictEqual(file.command, "attachment_message");
  assert.strictEqual(file.attachments[0].kind, "file");
  assert.strictEqual(file.attachments[0].resourceKey, "file_key");
  assert.strictEqual(file.attachments[0].fileName, "report.md");
  assert.strictEqual(file.attachments[0].fileSize, 42);
}

async function testFeishuAdapterResources() {
  const calls = [];
  let messageCreateResponse = { code: 0 };
  let messageReplyResponse = { code: 0 };
  let messagePatchResponse = { code: 0 };
  const fakeClient = {
    im: {
      v1: {
        file: {
          create: async (payload) => {
            calls.push(["file.create", payload]);
            return { file_key: "file_uploaded" };
          },
        },
        image: {
          create: async (payload) => {
            calls.push(["image.create", payload]);
            return { image_key: "image_uploaded" };
          },
        },
        message: {
          create: async (payload) => {
            calls.push(["message.create", payload]);
            return messageCreateResponse;
          },
          reply: async (payload) => {
            calls.push(["message.reply", payload]);
            return messageReplyResponse;
          },
          patch: async (payload) => {
            calls.push(["message.patch", payload]);
            return messagePatchResponse;
          },
        },
        messageResource: {
          get: async (payload) => {
            calls.push(["messageResource.get", payload]);
            return {
              headers: { "content-type": "image/png" },
              writeFile: async () => {},
            };
          },
        },
      },
    },
  };
  const adapter = new FeishuClientAdapter(fakeClient);

  await adapter.sendFileMessage({
    chatId: "oc_test",
    fileName: "voice.opus",
    fileBuffer: Buffer.from("audio"),
    fileType: "opus",
    msgType: "audio",
  });
  assert.strictEqual(calls[0][0], "file.create");
  assert.strictEqual(calls[0][1].data.file_type, "opus");
  assert.strictEqual(calls[1][1].data.msg_type, "audio");
  assert.strictEqual(calls[1][1].data.content, JSON.stringify({ file_key: "file_uploaded" }));

  await adapter.sendImageMessage({
    chatId: "oc_test",
    imageBuffer: Buffer.from("image"),
    replyToMessageId: "om_parent:extra",
  });
  assert.strictEqual(calls[2][0], "image.create");
  assert.strictEqual(calls[2][1].data.image_type, "message");
  assert.strictEqual(calls[3][0], "message.reply");
  assert.strictEqual(calls[3][1].path.message_id, "om_parent");
  assert.strictEqual(calls[3][1].data.msg_type, "image");
  assert.strictEqual(calls[3][1].data.content, JSON.stringify({ image_key: "image_uploaded" }));

  const downloaded = await adapter.downloadMessageResource({
    messageId: "om_image:extra",
    fileKey: "img_key",
    type: "image",
  });
  assert.strictEqual(downloaded.headers["content-type"], "image/png");
  assert.strictEqual(calls[4][0], "messageResource.get");
  assert.strictEqual(calls[4][1].path.message_id, "om_image");
  assert.strictEqual(calls[4][1].path.file_key, "img_key");
  assert.strictEqual(calls[4][1].params.type, "image");

  const createdCard = await adapter.sendInteractiveCard({
    chatId: "oc_test",
    card: { schema: "2.0" },
  });
  assert.deepStrictEqual(createdCard, { code: 0 });
  assert.strictEqual(calls[5][0], "message.create");

  const repliedCard = await adapter.sendInteractiveCard({
    chatId: "oc_test",
    card: { schema: "2.0" },
    replyToMessageId: "om_card:extra",
  });
  assert.deepStrictEqual(repliedCard, { code: 0 });
  assert.strictEqual(calls[6][0], "message.reply");
  assert.strictEqual(calls[6][1].path.message_id, "om_card");

  const patchedCard = await adapter.patchInteractiveCard({
    messageId: "om_card",
    card: { schema: "2.0", body: [] },
  });
  assert.deepStrictEqual(patchedCard, { code: 0 });
  assert.strictEqual(calls[7][0], "message.patch");
  assert.strictEqual(calls[7][1].path.message_id, "om_card");

  messageCreateResponse = { code: 230001, msg: "create rejected" };
  await assert.rejects(
    () => adapter.sendInteractiveCard({ chatId: "oc_test", card: { schema: "2.0" } }),
    /Feishu message\.create failed: 230001 create rejected/
  );

  messageReplyResponse = { code: 230002, msg: "reply rejected" };
  await assert.rejects(
    () => adapter.sendInteractiveCard({
      chatId: "oc_test",
      card: { schema: "2.0" },
      replyToMessageId: "om_card",
    }),
    /Feishu message\.reply failed: 230002 reply rejected/
  );

  messagePatchResponse = { code: 230003, msg: "patch rejected" };
  await assert.rejects(
    () => adapter.patchInteractiveCard({ messageId: "om_card", card: { schema: "2.0" } }),
    /Feishu message\.patch failed: 230003 patch rejected/
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
