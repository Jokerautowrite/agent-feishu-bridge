const fs = require("fs");
const path = require("path");
const {
  classifyLocalAttachment,
  inferFeishuFileType,
} = require("../../shared/media-types");
const {
  isAbsoluteWorkspacePath,
  normalizeWorkspacePath,
  pathMatchesWorkspaceRoot,
  resolveRealPathWithinWorkspace,
} = require("../../shared/workspace-paths");

const SEND_DIRECTIVE_RE = /\[\[codex-feishu-send:([^\]\n]+)\]\]/g;
const LEGACY_SEND_DIRECTIVE_RE = /\[\[yuan-feishu-send:([^\]\n]+)\]\]/g;
const MAX_FEISHU_UPLOAD_FILE_BYTES = 30 * 1024 * 1024;
const MAX_FEISHU_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024;

async function handleOutboundAttachmentDirectives(runtime, {
  threadId = "",
  turnId = "",
  chatId = "",
  text = "",
} = {}) {
  const workspaceRoot = runtime.resolveWorkspaceRootForThread(threadId)
    || runtime.workspaceRootByThreadId.get(threadId)
    || "";
  const directives = extractSendDirectives(text);
  if (!directives.length || !workspaceRoot || !chatId) {
    return { text: stripSendDirectives(text), sent: 0 };
  }

  let sent = 0;
  for (const requestedPath of directives) {
    const key = `${threadId}:${turnId}:${requestedPath}`;
    if (runtime.sentAttachmentDirectiveKeys.has(key)) {
      continue;
    }
    runtime.sentAttachmentDirectiveKeys.add(key);
    await sendWorkspaceAttachment(runtime, {
      chatId,
      workspaceRoot,
      requestedPath,
    });
    sent += 1;
  }
  return { text: stripSendDirectives(text), sent };
}

function extractSendDirectives(text) {
  return [
    ...extractSendDirectivesWithRegex(text, SEND_DIRECTIVE_RE),
    ...extractSendDirectivesWithRegex(text, LEGACY_SEND_DIRECTIVE_RE),
  ].filter((value, index, values) => values.indexOf(value) === index);
}

function extractSendDirectivesWithRegex(text, regex) {
  const result = [];
  const source = String(text || "");
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(source))) {
    const requestedPath = String(match[1] || "").trim();
    if (requestedPath) {
      result.push(requestedPath);
    }
  }
  return result;
}

function stripSendDirectives(text) {
  return String(text || "")
    .replace(SEND_DIRECTIVE_RE, "")
    .replace(LEGACY_SEND_DIRECTIVE_RE, "")
    .trim();
}

async function sendWorkspaceAttachment(runtime, { chatId, workspaceRoot, requestedPath }) {
  const resolved = await resolveWorkspaceSendTarget(workspaceRoot, requestedPath);
  if (resolved.errorText) {
    await runtime.sendInfoCardMessage({
      chatId,
      text: `附件发送指令无效：${resolved.errorText}`,
    });
    return;
  }

  const stats = await fs.promises.stat(resolved.filePath);
  if (!stats.isFile()) {
    await runtime.sendInfoCardMessage({
      chatId,
      text: `附件发送失败：只支持文件，不支持目录: ${resolved.displayPath}`,
    });
    return;
  }
  if (stats.size <= 0) {
    await runtime.sendInfoCardMessage({
      chatId,
      text: `附件发送失败：文件为空: ${resolved.displayPath}`,
    });
    return;
  }
  const kind = classifyLocalAttachment(resolved.filePath);
  const maxBytes = kind === "image" ? MAX_FEISHU_UPLOAD_IMAGE_BYTES : MAX_FEISHU_UPLOAD_FILE_BYTES;
  if (stats.size > maxBytes) {
    await runtime.sendInfoCardMessage({
      chatId,
      text: `附件发送失败：文件过大: ${resolved.displayPath}`,
    });
    return;
  }

  await runtime.sendLocalAttachmentToFeishu({
    kind,
    chatId,
    fileName: path.basename(resolved.filePath),
    fileBuffer: await fs.promises.readFile(resolved.filePath),
    fileType: inferFeishuFileType(resolved.filePath),
    msgType: kind === "audio" ? "audio" : "file",
  });
}

async function resolveWorkspaceSendTarget(workspaceRoot, requestedPath) {
  const normalizedInput = normalizeWorkspacePath(requestedPath);
  if (!normalizedInput) {
    return { errorText: "缺少相对路径。" };
  }
  if (isAbsoluteWorkspacePath(normalizedInput)) {
    return { errorText: "只支持当前项目下的相对路径，不支持绝对路径。" };
  }
  const candidatePath = path.resolve(workspaceRoot, requestedPath);
  if (!pathMatchesWorkspaceRoot(candidatePath, workspaceRoot)) {
    return { errorText: "路径不能跳出当前项目目录。" };
  }
  let filePath;
  try {
    filePath = await resolveRealPathWithinWorkspace(workspaceRoot, candidatePath);
  } catch (error) {
    if (error?.code === "ERR_WORKSPACE_PATH_ESCAPE") {
      return { errorText: "路径最终指向当前项目目录之外，已拒绝发送。" };
    }
    if (error?.code === "ENOENT") {
      return { errorText: "文件不存在。" };
    }
    throw error;
  }
  return {
    filePath,
    displayPath: normalizeWorkspacePath(path.relative(workspaceRoot, candidatePath)) || requestedPath,
  };
}

module.exports = {
  extractSendDirectives,
  handleOutboundAttachmentDirectives,
  stripSendDirectives,
};
