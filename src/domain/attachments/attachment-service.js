const fs = require("fs");
const path = require("path");
const { formatFailureText } = require("../../shared/error-text");
const { isSafeTextFile } = require("../../shared/media-types");

const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;
const MAX_TEXT_PREVIEW_CHARS = 12000;

async function prepareAttachmentMessage(runtime, normalized, { workspaceRoot = "", expectedKind = "", imageMode = "native" } = {}) {
  const pendingAttachments = extractPendingAttachments(normalized, expectedKind);
  if (!pendingAttachments.length) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: [
        "我收到附件了，但没有从飞书事件里解析到资源键。",
        "",
        "这一步先停住，不会猜测下载地址。需要再看一条真实事件结构。",
      ].join("\n"),
    });
    return null;
  }

  try {
    const downloaded = [];
    for (const attachment of pendingAttachments) {
      const filePath = buildAttachmentCachePath(runtime.config, normalized, attachment);
      const result = await runtime.requireFeishuAdapter().downloadMessageResource({
        messageId: normalized.messageId,
        fileKey: attachment.resourceKey,
        type: attachment.resourceType || attachment.kind,
        filePath,
      });
      const stats = fs.statSync(filePath);
      assertCachedAttachmentSize(runtime.config, attachment, filePath, stats.size);
      const contentType = normalizeHeader(result.headers, "content-type") || inferDefaultContentType(attachment);
      downloaded.push(await buildDownloadedAttachment({
        attachment,
        filePath: result.filePath || filePath,
        size: stats.size,
        contentType,
        workspaceRoot,
      }));
    }
    return buildAttachmentNormalizedMessage({
      normalized,
      downloaded,
      imageMode,
    });
  } catch (error) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: [
        "我收到附件了，但附件处理这一步还没走通。",
        "",
        formatFailureText("附件处理失败", error),
        "",
        "文字链路不受影响；原始附件只保存在本地私有缓存。",
      ].join("\n"),
    });
    return null;
  }
}

function extractPendingAttachments(normalized, expectedKind = "") {
  const attachments = Array.isArray(normalized.attachments) ? normalized.attachments : [];
  return attachments.filter((attachment) => {
    if (!attachment?.resourceKey || attachment.filePath) {
      return false;
    }
    return expectedKind ? attachment.kind === expectedKind : true;
  });
}

function buildAttachmentCachePath(config, normalized, attachment) {
  const rootDir = config.attachmentsDir
    || path.join(process.env.HOME || "", ".codex-feishu-bridge", "attachments");
  const day = normalizeDay(normalized.receivedAt);
  const messageId = sanitizePathPart(normalized.messageId || "message");
  const resourceKey = sanitizePathPart(attachment.resourceKey || attachment.kind || "attachment");
  const fileName = sanitizePathPart(attachment.fileName || "");
  const suffix = fileName ? `-${fileName}` : ".bin";
  return path.join(rootDir, day, `${messageId}-${resourceKey}${suffix}`);
}

function normalizeDay(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

function sanitizePathPart(value) {
  const normalized = String(value || "").trim();
  return normalized.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 96) || "item";
}

function assertCachedAttachmentSize(config, attachment, filePath, size) {
  const maxBytes = attachment.kind === "image"
    ? Number(config.maxImageBytes || 0)
    : Number(config.maxAttachmentBytes || 0);
  if (maxBytes > 0 && size > maxBytes) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best-effort cleanup; the caller still gets the size-limit error.
    }
    throw new Error(`${attachment.kind || "attachment"} is too large: ${size} bytes > ${maxBytes} bytes`);
  }
}

function normalizeHeader(headers, name) {
  if (!headers || typeof headers !== "object") {
    return "";
  }
  const direct = headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
  if (typeof direct === "string") {
    return direct;
  }
  return Array.isArray(direct) ? direct.join(", ") : "";
}

async function buildDownloadedAttachment({ attachment, filePath, size, contentType, workspaceRoot }) {
  const downloaded = {
    ...attachment,
    filePath,
    size,
    contentType,
    workspaceRoot,
  };
  if (attachment.kind === "file" && isSafeTextFile(filePath, contentType) && size <= MAX_TEXT_PREVIEW_BYTES) {
    downloaded.textPreview = await readTextPreview(filePath);
  }
  if (attachment.kind === "audio") {
    downloaded.transcript = "";
    downloaded.transcriptionStatus = "not_configured";
  }
  return downloaded;
}

async function readTextPreview(filePath) {
  const text = await fs.promises.readFile(filePath, "utf8");
  return text.length > MAX_TEXT_PREVIEW_CHARS
    ? `${text.slice(0, MAX_TEXT_PREVIEW_CHARS)}\n[...truncated...]`
    : text;
}

function buildAttachmentNormalizedMessage({ normalized, downloaded, imageMode = "native" }) {
  const imageAttachments = downloaded.filter((attachment) => attachment.kind === "image");
  const nonImageAttachments = downloaded.filter((attachment) => attachment.kind !== "image");
  const isPathMode = imageMode === "path";
  const taggedDownloaded = downloaded.map((attachment) =>
    attachment.kind === "image" && isPathMode
      ? { ...attachment, imageMode: "path" }
      : attachment
  );
  const userText = normalizeUserAttachmentText(normalized.text, downloaded);
  const notes = buildAttachmentSystemNotes(taggedDownloaded);
  const text = [userText, "", ...notes].filter(Boolean).join("\n");

  return {
    ...normalized,
    text,
    command: "message",
    attachments: [
      ...preserveNonDownloadedAttachments(normalized.attachments, downloaded),
      ...taggedDownloaded,
    ],
    imageContext: !isPathMode && imageAttachments[0]
      ? {
        filePath: imageAttachments[0].filePath,
        size: imageAttachments[0].size,
        contentType: imageAttachments[0].contentType,
        mode: "native",
      }
      : undefined,
    attachmentContext: nonImageAttachments.length ? nonImageAttachments : undefined,
  };
}

function buildAttachmentSystemNotes(downloaded) {
  return downloaded.map((attachment) => {
    if (attachment.kind === "image") {
      if (attachment.imageMode === "path") {
        return [
          "[System note: A Feishu/Lark user sent an image. The current model has no vision capability, so the bridge did NOT attach it as native image input.]",
          `Local path: ${attachment.filePath}`,
          `File name: ${attachment.fileName || path.basename(attachment.filePath)}`,
          `Size: ${attachment.size} bytes`,
          `Content type: ${attachment.contentType || "unknown"}`,
          "Inspect this image with a vision-capable tool using the local path before answering, e.g. run: vision \"<Local path>\" -q \"你要问的问题\"",
        ].join("\n");
      }
      return "[System note: A Feishu/Lark user sent an image. The bridge downloaded the original image to local private cache and attached it to this Codex turn as a native image input. Look at the attached image directly; do not treat this note as a replacement for visual inspection.]";
    }
    const lines = [
      `[System note: A Feishu/Lark user sent a ${attachment.kind}. The bridge downloaded it to local private cache and is passing metadata as text because the Codex app-server input shape is only confirmed for text and localImage.]`,
      `Local path: ${attachment.filePath}`,
      `File name: ${attachment.fileName || path.basename(attachment.filePath)}`,
      `Size: ${attachment.size} bytes`,
      `Content type: ${attachment.contentType || "unknown"}`,
    ];
    if (attachment.kind === "audio") {
      lines.push("Transcription: not configured in this bridge version.");
    }
    if (attachment.textPreview) {
      lines.push("", "Text preview:", attachment.textPreview);
    }
    return lines.join("\n");
  });
}

function normalizeUserAttachmentText(text, downloaded) {
  const normalized = String(text || "").trim();
  if (normalized) {
    return normalized;
  }
  if (downloaded.some((attachment) => attachment.kind === "image")) {
    if (downloaded.some((attachment) => attachment.kind === "image" && attachment.imageMode === "path")) {
      return "Inspect the image at the local path in the system notes using a vision tool.";
    }
    return "Please inspect this image.";
  }
  if (downloaded.some((attachment) => attachment.kind === "audio")) {
    return "Please process this audio attachment.";
  }
  return "Please process this file attachment.";
}

function preserveNonDownloadedAttachments(attachments, downloaded) {
  if (!Array.isArray(attachments)) {
    return [];
  }
  const downloadedKeys = new Set(downloaded.map((attachment) => attachment.resourceKey).filter(Boolean));
  return attachments.filter((attachment) => attachment.filePath || !downloadedKeys.has(attachment.resourceKey));
}

function inferDefaultContentType(attachment) {
  if (attachment.kind === "image") {
    return "image/png";
  }
  if (attachment.kind === "audio") {
    return "audio/opus";
  }
  return "application/octet-stream";
}

function isTextOnlyImageModel(model, patterns) {
  const name = String(model || "").trim().toLowerCase();
  if (!name) {
    return false;
  }
  return (Array.isArray(patterns) ? patterns : []).some((pattern) => {
    const p = String(pattern || "").trim().toLowerCase();
    return Boolean(p) && (name === p || name.startsWith(p));
  });
}

module.exports = {
  prepareAttachmentMessage,
  isTextOnlyImageModel,
};
