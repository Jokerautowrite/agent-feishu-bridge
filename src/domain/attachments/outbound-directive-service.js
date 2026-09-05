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
    let delivered = false;
    try {
      delivered = await sendWorkspaceAttachment(runtime, { chatId, workspaceRoot, requestedPath });
      if (delivered) sent += 1;
    } catch {
      // Neither filesystem errors nor transport payloads belong in the chat.
      try {
        await runtime.sendInfoCardMessage({
          chatId,
          text: "附件发送失败：请检查文件可读性与飞书连接后重试。",
        });
      } catch {
        console.warn("[agent-bridge] attachment failure notice could not be delivered");
      }
    } finally {
      if (!delivered) runtime.sentAttachmentDirectiveKeys.delete(key);
    }
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
    return false;
  }
  const kind = classifyLocalAttachment(resolved.filePath);
  const fileBuffer = await readWorkspaceAttachment({
    workspaceRoot,
    filePath: resolved.filePath,
    exportDir: runtime.config?.attachmentExportDir || "",
    maxBytes: kind === "image" ? MAX_FEISHU_UPLOAD_IMAGE_BYTES : MAX_FEISHU_UPLOAD_FILE_BYTES,
  });
  await runtime.sendLocalAttachmentToFeishu({
    kind,
    chatId,
    fileName: path.basename(resolved.filePath),
    fileBuffer,
    fileType: inferFeishuFileType(resolved.filePath),
    msgType: kind === "audio" ? "audio" : "file",
  });
  return true;
}

async function readWorkspaceAttachment({ workspaceRoot, filePath, exportDir, maxBytes }) {
  const root = await fs.promises.realpath(workspaceRoot);
  const exportPath = path.resolve(workspaceRoot, exportDir || ".");
  if (exportDir && (isAbsoluteWorkspacePath(exportDir) || !pathMatchesWorkspaceRoot(exportPath, workspaceRoot))) {
    throw new Error("Invalid attachment export directory");
  }
  const allowedRoot = await fs.promises.realpath(exportPath);
  const canonicalPath = await fs.promises.realpath(filePath);
  if (!pathMatchesWorkspaceRoot(allowedRoot, root)
      || !pathMatchesWorkspaceRoot(canonicalPath, allowedRoot)
      || isSensitiveAttachmentPath(filePath, workspaceRoot)
      || isSensitiveAttachmentPath(canonicalPath, root)) {
    throw new Error("Attachment path is not allowed");
  }

  // NOFOLLOW protects the last component; on Linux the opened descriptor is
  // also resolved so a parent-directory symlink swap cannot escape the root.
  // NONBLOCK avoids hanging if a regular file is replaced by a FIFO.
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const handle = await fs.promises.open(canonicalPath, flags);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size <= 0 || stats.size > maxBytes) {
      throw new Error("Attachment is not a nonempty regular file within the size limit");
    }
    const openedPath = await fs.promises.realpath(
      process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : canonicalPath
    );
    if (openedPath !== canonicalPath || !pathMatchesWorkspaceRoot(openedPath, allowedRoot)) {
      throw new Error("Attachment changed while opening");
    }
    const current = await fs.promises.stat(canonicalPath);
    if (current.dev !== stats.dev || current.ino !== stats.ino) {
      throw new Error("Attachment identity changed while opening");
    }
    // Read at most the checked size plus one byte, even if the file grows.
    const buffer = Buffer.alloc(stats.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (!used || used > stats.size || used > maxBytes) {
      throw new Error("Attachment size changed while reading");
    }
    return buffer.subarray(0, used);
  } finally {
    await handle.close();
  }
}

function isSensitiveAttachmentPath(filePath, root) {
  const parts = normalizeWorkspacePath(path.relative(root, filePath)).toLowerCase().split("/");
  const name = parts[parts.length - 1] || "";
  return parts.some((part) => [".git", ".ssh", ".aws", ".gnupg", ".kube"].includes(part))
    || /^\.env(?:$|\.)/.test(name)
    || /^(auth|credentials|sessions?)\.json$/.test(name)
    || /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:$|\.)/.test(name)
    || /\.(pem|key|p12|pfx|sqlite|sqlite3)(?:$|-)/.test(name)
    || (path.basename(root).toLowerCase() === ".codex" && name === "config.toml");
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
