const path = require("path");
const os = require("os");
const { normalizeLogLevel } = require("../../shared/log-level");

const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);
const ALLOWED_ACCESS_MODES = new Set(["default", "full-access"]);
const ALLOWED_ACTIVE_TURN_FOLLOW_UP_MODES = new Set(["reject", "steer"]);
const LEGACY_ENV_PREFIX = "CODEX_IM_";
const NEW_ENV_PREFIX = "AGENT_BRIDGE_";

/**
 * 兼容读取环境变量：优先读新前缀 AGENT_BRIDGE_*，未配置时回退旧前缀
 * CODEX_IM_*，保证老用户 .env 不破坏、品牌名统一。
 */
function readCompatEnv(legacyName) {
  const legacy = String(legacyName || "").trim();
  if (!legacy.startsWith(LEGACY_ENV_PREFIX)) {
    return legacy;
  }
  const suffix = legacy.slice(LEGACY_ENV_PREFIX.length);
  const newName = `${NEW_ENV_PREFIX}${suffix}`;
  if (typeof process.env[newName] === "string" && process.env[newName].trim() !== "") {
    return newName;
  }
  return legacy;
}

function readEnv(legacyName) {
  const name = readCompatEnv(legacyName);
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function readConfig() {
  const mode = process.argv[2] || "";

  return {
    mode,
    workspaceAllowlist: readListEnv(readCompatEnv("CODEX_IM_WORKSPACE_ALLOWLIST")),
    defaultProjectsRoot: readEnv("CODEX_IM_PROJECTS_ROOT")
      || path.join(os.homedir(), "projects"),
    cardActionSenderAllowlist: readListEnv(readCompatEnv("CODEX_IM_CARD_ACTION_SENDER_ALLOWLIST")),
    botOpenId: readEnv("CODEX_IM_BOT_OPEN_ID"),
    adminOpenIds: readListEnv(readCompatEnv("CODEX_IM_ADMIN_OPEN_IDS")),
    groupMentionOnly: readBooleanEnv(readCompatEnv("CODEX_IM_GROUP_MENTION_ONLY"), true),
    groupMentionExemptChats: readListEnv(readCompatEnv("CODEX_IM_GROUP_MENTION_EXEMPT_CHATS")),
    groupDefaultWorkspace: readEnv("CODEX_IM_GROUP_DEFAULT_WORKSPACE"),
    groupAllowedChats: readListEnv(readCompatEnv("AGENT_BRIDGE_GROUP_ALLOWED_CHATS")),
    groupAutoLeave: readBooleanEnv(readCompatEnv("AGENT_BRIDGE_GROUP_AUTO_LEAVE"), true),
    superAdminOpenIds: readListEnv(readCompatEnv("AGENT_BRIDGE_SUPER_ADMIN_OPEN_IDS")),
    groupMaliciousKeywords: readListEnv(readCompatEnv("AGENT_BRIDGE_GROUP_MALICIOUS_KEYWORDS")),
    groupReplyCooldownMs: readNonNegativeIntEnv(
      readCompatEnv("CODEX_IM_GROUP_REPLY_COOLDOWN_MS"),
      5000
    ),
    codexEndpoint: readEnv("CODEX_IM_CODEX_ENDPOINT"),
    codexCommand: readEnv("CODEX_IM_CODEX_COMMAND"),
    codexAppServerProfile: readEnv("CODEX_IM_CODEX_APP_SERVER_PROFILE"),
    defaultCodexModel: readEnv("CODEX_IM_DEFAULT_CODEX_MODEL"),
    defaultCodexEffort: readEnv("CODEX_IM_DEFAULT_CODEX_EFFORT"),
    defaultCodexAccessMode: readAccessModeEnv(readCompatEnv("CODEX_IM_DEFAULT_CODEX_ACCESS_MODE")),
    activeTurnFollowUpMode: readActiveTurnFollowUpModeEnv(
      readCompatEnv("CODEX_IM_ACTIVE_TURN_FOLLOW_UP_MODE"),
      "reject"
    ),
    logLevel: normalizeLogLevel(readEnv("CODEX_IM_LOG_LEVEL")),
    feishu: {
      appId: process.env.FEISHU_APP_ID || "",
      appSecret: process.env.FEISHU_APP_SECRET || "",
    },
    defaultWorkspaceId: readEnv("CODEX_IM_DEFAULT_WORKSPACE_ID") || "default",
    feishuStreamingOutput: readBooleanEnv(readCompatEnv("CODEX_IM_FEISHU_STREAMING_OUTPUT"), true),
    feishuCardKitStreaming: readBooleanEnv(readCompatEnv("CODEX_IM_FEISHU_CARDKIT_STREAMING"), true),
    outputVisibleTailPercent: readBoundedIntEnv(
      readCompatEnv("CODEX_IM_OUTPUT_VISIBLE_TAIL_PERCENT"),
      10,
      5,
      50
    ),
    cardKitFailureCooldownMs: readNonNegativeIntEnv(
      readCompatEnv("CODEX_IM_CARDKIT_FAILURE_COOLDOWN_MS"),
      5 * 60 * 1000
    ),
    groupCardReasoningMode: readAllowedStringEnv(
      readCompatEnv("CODEX_IM_GROUP_CARD_REASONING_MODE"),
      ["none", "brief", "full"],
      "none"
    ),
    codexRpcTimeoutMs: readPositiveIntEnv(readCompatEnv("CODEX_IM_CODEX_RPC_TIMEOUT_MS"), 45000),
    codexTurnStartTimeoutMs: readPositiveIntEnv(readCompatEnv("CODEX_IM_CODEX_TURN_START_TIMEOUT_MS"), 300000),
    staleTurnTimeoutMs: readNonNegativeIntEnv(
      readCompatEnv("CODEX_IM_STALE_TURN_TIMEOUT_MS"),
      15 * 60 * 1000
    ),
    deliveryLedgerCli: readEnv("CODEX_IM_DELIVERY_LEDGER_CLI"),
    deliveryLedgerPath: readEnv("AGENT_HUB_DELIVERY_LEDGER"),
    attachmentsDir: readEnv("CODEX_IM_ATTACHMENTS_DIR")
      || path.join(os.homedir(), ".codex-feishu-bridge", "attachments"),
    maxImageBytes: readPositiveIntEnv(readCompatEnv("CODEX_IM_MAX_IMAGE_BYTES"), 10 * 1024 * 1024),
    maxAttachmentBytes: readPositiveIntEnv(readCompatEnv("CODEX_IM_MAX_ATTACHMENT_BYTES"), 100 * 1024 * 1024),
    textOnlyImageModelPatterns: readTextOnlyImageModelPatternsEnv(
      readCompatEnv("CODEX_IM_TEXT_ONLY_MODEL_PATTERNS"),
      ["deepseek", "big-pickle"]
    ),
    imageVisionModel: readEnv("CODEX_IM_IMAGE_VISION_MODEL"),
    sessionsFile: readEnv("CODEX_IM_SESSIONS_FILE")
      || path.join(os.homedir(), ".codex-im", "sessions.json"),
  };
}

function readListEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readTextOnlyImageModelPatternsEnv(name, defaultPatterns) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) {
    return Array.isArray(defaultPatterns) ? [...defaultPatterns] : [];
  }
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function readBooleanEnv(name, defaultValue) {
  const rawValue = process.env[name];
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return defaultValue;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (TRUE_ENV_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_ENV_VALUES.has(normalized)) {
    return false;
  }
  return defaultValue;
}

function readTextEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function readAllowedStringEnv(name, allowedValues, defaultValue) {
  const value = readTextEnv(name);
  if (!value) {
    return defaultValue;
  }
  return allowedValues.includes(value) ? value : defaultValue;
}

function readPositiveIntEnv(name, defaultValue) {
  const rawValue = process.env[name];
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return defaultValue;
  }
  const parsed = Number.parseInt(rawValue.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function readNonNegativeIntEnv(name, defaultValue) {
  const rawValue = process.env[name];
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return defaultValue;
  }
  const normalized = rawValue.trim().toLowerCase();
  if (FALSE_ENV_VALUES.has(normalized)) {
    return 0;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function readBoundedIntEnv(name, defaultValue, minimum, maximum) {
  const rawValue = process.env[name];
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return defaultValue;
  }
  const parsed = Number.parseInt(rawValue.trim(), 10);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : defaultValue;
}

function readAccessModeEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  return ALLOWED_ACCESS_MODES.has(value) ? value : "";
}

function readActiveTurnFollowUpModeEnv(name, defaultValue) {
  const value = readTextEnv(name).toLowerCase();
  return ALLOWED_ACTIVE_TURN_FOLLOW_UP_MODES.has(value) ? value : defaultValue;
}

module.exports = { readConfig };
