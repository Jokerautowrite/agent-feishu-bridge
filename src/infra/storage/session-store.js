const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { normalizeModelCatalog } = require("../../shared/model-catalog");

class SessionStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = createEmptyState();
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    const parentDirectory = path.dirname(this.filePath);
    fs.mkdirSync(parentDirectory, { recursive: true });
  }

  load() {
    const raw = readOptionalStateFile(this.filePath);
    this.persistedRaw = raw;
    this.recoveredFromBackup = false;
    try {
      if (raw !== null) {
        this.state = parseState(raw);
      } else {
        const backup = readOptionalStateFile(`${this.filePath}.backup`);
        this.state = backup === null ? createEmptyState() : parseState(backup);
        this.recoveredFromBackup = backup !== null;
      }
    } catch (error) {
      if (error.code === "SESSION_STORE_UNSUPPORTED_VERSION") throw error;
      const backup = readOptionalStateFile(`${this.filePath}.backup`);
      if (backup === null) throw error;
      this.state = parseState(backup);
      this.recoveredFromBackup = true;
    }
    if (this.recoveredFromBackup) {
      console.warn("[agent-bridge] session store recovered from backup; original evidence will be retained");
    }
    this.committedState = JSON.stringify(this.state);
  }

  save() {
    try {
      // Detect stale instances. A session file must still have a single bridge
      // writer; this check is not a cross-process/distributed lock.
      if (readOptionalStateFile(this.filePath) !== this.persistedRaw) {
        throw stateError("SESSION_STORE_CONFLICT", "Session store changed externally; reload before writing");
      }
      const nextState = parseState(JSON.stringify(this.state));
      const serialized = JSON.stringify(nextState, null, 2);
      if (this.persistedRaw !== null) {
        if (this.recoveredFromBackup) {
          const evidence = `${this.filePath}.corrupt-${randomUUID()}`;
          fs.writeFileSync(evidence, this.persistedRaw, { flag: "wx", mode: 0o600 });
        } else {
          atomicWriteState(`${this.filePath}.backup`, this.persistedRaw);
        }
      }
      atomicWriteState(this.filePath, serialized);
      this.state = nextState;
      this.persistedRaw = serialized;
      this.committedState = JSON.stringify(nextState);
      this.recoveredFromBackup = false;
    } catch (error) {
      this.state = JSON.parse(this.committedState);
      throw error;
    }
  }

  getGroupAdmins() {
    return this.state.groupAdmins || {};
  }

  setGroupAdmins(groupAdmins) {
    this.state.groupAdmins = groupAdmins || {};
    this.save();
  }

  getBinding(bindingKey) {
    return this.state.bindings[bindingKey] || null;
  }

  getActiveWorkspaceRoot(bindingKey) {
    return this.state.bindings[bindingKey]?.activeWorkspaceRoot || "";
  }

  setActiveWorkspaceRoot(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    const current = this.getBinding(bindingKey) || { threadIdByWorkspaceRoot: {} };
    const threadIdByWorkspaceRoot = getThreadMap(current);
    if (normalizedWorkspaceRoot && !(normalizedWorkspaceRoot in threadIdByWorkspaceRoot)) {
      threadIdByWorkspaceRoot[normalizedWorkspaceRoot] = "";
    }

    return this.updateBinding(bindingKey, {
      ...current,
      activeWorkspaceRoot: normalizedWorkspaceRoot,
      threadIdByWorkspaceRoot,
    });
  }

  getThreadIdForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return "";
    }
    return this.state.bindings[bindingKey]?.threadIdByWorkspaceRoot?.[normalizedWorkspaceRoot] || "";
  }

  setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, extra = {}) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const threadIdByWorkspaceRoot = {
      ...getThreadMap(current),
      [normalizedWorkspaceRoot]: threadId,
    };

    return this.updateBinding(bindingKey, {
      ...current,
      ...extra,
      activeWorkspaceRoot: normalizedWorkspaceRoot,
      threadIdByWorkspaceRoot,
    });
  }

  clearThreadIdForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const threadIdByWorkspaceRoot = {
      ...getThreadMap(current),
      [normalizedWorkspaceRoot]: "",
    };

    return this.updateBinding(bindingKey, {
      ...current,
      threadIdByWorkspaceRoot,
    });
  }

  getCodexParamsForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return { model: "", effort: "" };
    }
    const raw = this.state.bindings[bindingKey]?.codexParamsByWorkspaceRoot?.[normalizedWorkspaceRoot];
    if (!raw || typeof raw !== "object") {
      return { model: "", effort: "" };
    }
    return {
      model: normalizeValue(raw.model),
      effort: normalizeValue(raw.effort),
    };
  }

  // Claude's bridge thread ID is separate from the CLI session ID. Persist
  // both so a bridge restart can resume the real conversation.
  getBackendSession(threadId) {
    const normalizedThreadId = normalizeValue(threadId);
    if (!normalizedThreadId) {
      return { sessionId: "", cwd: "" };
    }
    const raw = this.state.backendSessionByThreadId?.[normalizedThreadId];
    if (typeof raw === "string") {
      return { sessionId: normalizeValue(raw), cwd: "" };
    }
    if (!raw || typeof raw !== "object") {
      return { sessionId: "", cwd: "" };
    }
    return {
      sessionId: normalizeValue(raw.sessionId),
      cwd: normalizeValue(raw.cwd),
    };
  }

  setBackendSession(threadId, { sessionId, cwd } = {}) {
    const normalizedThreadId = normalizeValue(threadId);
    if (!normalizedThreadId) {
      return this.getBackendSession(threadId);
    }

    const nextSession = {
      sessionId: normalizeValue(sessionId),
      cwd: normalizeValue(cwd),
    };
    const current = this.getBackendSession(normalizedThreadId);
    if (current.sessionId === nextSession.sessionId && current.cwd === nextSession.cwd) {
      return current;
    }

    this.state.backendSessionByThreadId = {
      ...(this.state.backendSessionByThreadId || {}),
      [normalizedThreadId]: nextSession,
    };
    this.save();
    return nextSession;
  }

  setCodexParamsForWorkspace(bindingKey, workspaceRoot, { model, effort }) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const codexParamsByWorkspaceRoot = {
      ...getCodexParamsMap(current),
      [normalizedWorkspaceRoot]: {
        model: normalizeValue(model),
        effort: normalizeValue(effort),
      },
    };

    return this.updateBinding(bindingKey, {
      ...current,
      codexParamsByWorkspaceRoot,
    });
  }

  getApprovalCommandAllowlistForWorkspace(workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return [];
    }
    const allowlist = this.state.approvalCommandAllowlistByWorkspaceRoot?.[normalizedWorkspaceRoot];
    if (!Array.isArray(allowlist)) {
      return [];
    }
    return normalizeCommandAllowlist(allowlist);
  }

  getAvailableModelCatalog() {
    const raw = this.state.availableModelCatalog;
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const models = normalizeModelCatalog(raw.models);
    if (!models.length) {
      return null;
    }
    const updatedAt = normalizeValue(raw.updatedAt);
    return {
      models,
      updatedAt,
    };
  }

  setAvailableModelCatalog(models) {
    const normalizedModels = normalizeModelCatalog(models);
    if (!normalizedModels.length) {
      return null;
    }

    this.state.availableModelCatalog = {
      models: normalizedModels,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.state.availableModelCatalog;
  }

  rememberApprovalCommandPrefixForWorkspace(workspaceRoot, commandTokens) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    const normalizedTokens = normalizeCommandTokens(commandTokens);
    if (!normalizedWorkspaceRoot || !normalizedTokens.length) {
      return null;
    }

    const currentAllowlist = this.getApprovalCommandAllowlistForWorkspace(normalizedWorkspaceRoot);
    const exists = currentAllowlist.some((prefix) => (
      prefix.length === normalizedTokens.length
      && prefix.every((token, index) => token === normalizedTokens[index])
    ));
    if (exists) {
      return currentAllowlist;
    }

    this.state.approvalCommandAllowlistByWorkspaceRoot = {
      ...(this.state.approvalCommandAllowlistByWorkspaceRoot || {}),
      [normalizedWorkspaceRoot]: [...currentAllowlist, normalizedTokens],
    };
    this.save();
    return this.state.approvalCommandAllowlistByWorkspaceRoot[normalizedWorkspaceRoot];
  }

  removeWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const threadIdByWorkspaceRoot = getThreadMap(current);
    const codexParamsByWorkspaceRoot = getCodexParamsMap(current);
    const hasWorkspaceEntry = Object.prototype.hasOwnProperty.call(
      threadIdByWorkspaceRoot,
      normalizedWorkspaceRoot
    );
    const activeWorkspaceRoot = normalizeValue(current.activeWorkspaceRoot);
    if (!hasWorkspaceEntry && activeWorkspaceRoot !== normalizedWorkspaceRoot) {
      return current;
    }

    delete threadIdByWorkspaceRoot[normalizedWorkspaceRoot];
    delete codexParamsByWorkspaceRoot[normalizedWorkspaceRoot];

    const nextActiveWorkspaceRoot = activeWorkspaceRoot === normalizedWorkspaceRoot
      ? (Object.keys(threadIdByWorkspaceRoot).sort((left, right) => left.localeCompare(right))[0] || "")
      : activeWorkspaceRoot;

    return this.updateBinding(bindingKey, {
      ...current,
      activeWorkspaceRoot: nextActiveWorkspaceRoot,
      codexParamsByWorkspaceRoot,
      threadIdByWorkspaceRoot,
    });
  }

  updateBinding(bindingKey, nextBinding) {
    this.state.bindings[bindingKey] = {
      ...nextBinding,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.state.bindings[bindingKey];
  }

  buildBindingKey({ workspaceId, chatId, threadKey, senderId, messageId }) {
    const normalizedThreadKey = normalizeValue(threadKey);
    const normalizedMessageId = normalizeValue(messageId);
    const hasStableThreadKey = normalizedThreadKey && normalizedThreadKey !== normalizedMessageId;

    if (hasStableThreadKey) {
      return `${normalizeValue(workspaceId)}:${normalizeValue(chatId)}:thread:${normalizedThreadKey}`;
    }
    return this.buildChatBindingKey({ workspaceId, chatId });
  }

  buildChatBindingKey({ workspaceId, chatId }) {
    return `${normalizeValue(workspaceId)}:${normalizeValue(chatId)}:chat`;
  }

  buildLegacySenderBindingKey({ workspaceId, chatId, senderId }) {
    return `${normalizeValue(workspaceId)}:${normalizeValue(chatId)}:sender:${normalizeValue(senderId)}`;
  }

  findLegacySenderBindingKeyForChat({ workspaceId, chatId }) {
    const prefix = `${normalizeValue(workspaceId)}:${normalizeValue(chatId)}:sender:`;
    if (!prefix || prefix.endsWith("::sender:")) {
      return "";
    }

    const entries = Object.entries(this.state.bindings || {})
      .filter(([key, binding]) => key.startsWith(prefix) && normalizeValue(binding?.activeWorkspaceRoot))
      .sort(([, left], [, right]) => normalizeValue(right?.updatedAt).localeCompare(normalizeValue(left?.updatedAt)));

    return entries[0]?.[0] || "";
  }

}

function normalizeValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createEmptyState() {
  return {
    schemaVersion: 1,
    bindings: {},
    backendSessionByThreadId: {},
    approvalCommandAllowlistByWorkspaceRoot: {},
    groupAdmins: {},
    availableModelCatalog: {
      models: [],
      updatedAt: "",
    },
  };
}

function stateError(code, message) {
  return Object.assign(new Error(message), { code });
}

function readOptionalStateFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw stateError("SESSION_STORE_READ_FAILED", "Unable to read session store; existing state was not replaced");
  }
}

function parseState(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw stateError("SESSION_STORE_CORRUPT", "Invalid session JSON; restore a valid backup before continuing");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || !parsed.bindings || typeof parsed.bindings !== "object" || Array.isArray(parsed.bindings)) {
    throw stateError("SESSION_STORE_CORRUPT", "Invalid session state shape; refusing to clear existing bindings");
  }
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1) {
    throw stateError("SESSION_STORE_UNSUPPORTED_VERSION", "Unsupported session state version; refusing to downgrade");
  }
  return { ...createEmptyState(), ...parsed, schemaVersion: 1 };
}

function atomicWriteState(filePath, data) {
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  const fd = fs.openSync(temporaryPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Failed writes retain their private temporary file for manual diagnosis.
  fs.renameSync(temporaryPath, filePath);
  if (process.platform !== "win32") {
    const directory = fs.openSync(path.dirname(filePath), "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  }
}

function getThreadMap(binding) {
  return { ...(binding?.threadIdByWorkspaceRoot || {}) };
}

function getCodexParamsMap(binding) {
  return { ...(binding?.codexParamsByWorkspaceRoot || {}) };
}

function normalizeCommandTokens(tokens) {
  if (!Array.isArray(tokens)) {
    return [];
  }
  return tokens
    .map((token) => (typeof token === "string" ? token.trim() : ""))
    .filter(Boolean);
}

function normalizeCommandAllowlist(allowlist) {
  if (!Array.isArray(allowlist)) {
    return [];
  }
  return allowlist
    .map((tokens) => normalizeCommandTokens(tokens))
    .filter((tokens) => tokens.length > 0);
}

module.exports = { SessionStore };
