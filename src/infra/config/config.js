const path = require("path");
const os = require("os");
const { normalizeLogLevel } = require("../../shared/log-level");

const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);
const ALLOWED_ACCESS_MODES = new Set(["default", "full-access"]);
const ALLOWED_ACTIVE_TURN_FOLLOW_UP_MODES = new Set(["reject", "steer"]);

function readConfig() {
  const mode = process.argv[2] || "";

  return {
    mode,
    workspaceAllowlist: readListEnv("CODEX_IM_WORKSPACE_ALLOWLIST"),
    defaultProjectsRoot: readTextEnv("CODEX_IM_PROJECTS_ROOT")
      || path.join(os.homedir(), "projects"),
    cardActionSenderAllowlist: readListEnv("CODEX_IM_CARD_ACTION_SENDER_ALLOWLIST"),
    codexEndpoint: process.env.CODEX_IM_CODEX_ENDPOINT || "",
    codexCommand: process.env.CODEX_IM_CODEX_COMMAND || "",
    codexAppServerProfile: readTextEnv("CODEX_IM_CODEX_APP_SERVER_PROFILE"),
    defaultCodexModel: readTextEnv("CODEX_IM_DEFAULT_CODEX_MODEL"),
    defaultCodexEffort: readTextEnv("CODEX_IM_DEFAULT_CODEX_EFFORT"),
    defaultCodexAccessMode: readAccessModeEnv("CODEX_IM_DEFAULT_CODEX_ACCESS_MODE"),
    activeTurnFollowUpMode: readActiveTurnFollowUpModeEnv(
      "CODEX_IM_ACTIVE_TURN_FOLLOW_UP_MODE",
      "reject"
    ),
    logLevel: normalizeLogLevel(readTextEnv("CODEX_IM_LOG_LEVEL")),
    feishu: {
      appId: process.env.FEISHU_APP_ID || "",
      appSecret: process.env.FEISHU_APP_SECRET || "",
    },
    defaultWorkspaceId: process.env.CODEX_IM_DEFAULT_WORKSPACE_ID || "default",
    feishuStreamingOutput: readBooleanEnv("CODEX_IM_FEISHU_STREAMING_OUTPUT", true),
    feishuCardKitStreaming: readBooleanEnv("CODEX_IM_FEISHU_CARDKIT_STREAMING", true),
    cardKitFailureCooldownMs: readNonNegativeIntEnv(
      "CODEX_IM_CARDKIT_FAILURE_COOLDOWN_MS",
      5 * 60 * 1000
    ),
    codexRpcTimeoutMs: readPositiveIntEnv("CODEX_IM_CODEX_RPC_TIMEOUT_MS", 45000),
    codexTurnStartTimeoutMs: readPositiveIntEnv("CODEX_IM_CODEX_TURN_START_TIMEOUT_MS", 300000),
    staleTurnTimeoutMs: readNonNegativeIntEnv(
      "CODEX_IM_STALE_TURN_TIMEOUT_MS",
      15 * 60 * 1000
    ),
    deliveryLedgerCli: readTextEnv("CODEX_IM_DELIVERY_LEDGER_CLI"),
    deliveryLedgerPath: readTextEnv("AGENT_HUB_DELIVERY_LEDGER"),
    attachmentsDir: process.env.CODEX_IM_ATTACHMENTS_DIR
      || path.join(os.homedir(), ".codex-feishu-bridge", "attachments"),
    maxImageBytes: readPositiveIntEnv("CODEX_IM_MAX_IMAGE_BYTES", 10 * 1024 * 1024),
    maxAttachmentBytes: readPositiveIntEnv("CODEX_IM_MAX_ATTACHMENT_BYTES", 100 * 1024 * 1024),
    textOnlyImageModelPatterns: readTextOnlyImageModelPatternsEnv(
      "CODEX_IM_TEXT_ONLY_MODEL_PATTERNS",
      ["deepseek", "big-pickle"]
    ),
    sessionsFile: process.env.CODEX_IM_SESSIONS_FILE
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

function readAccessModeEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  return ALLOWED_ACCESS_MODES.has(value) ? value : "";
}

function readActiveTurnFollowUpModeEnv(name, defaultValue) {
  const value = readTextEnv(name).toLowerCase();
  return ALLOWED_ACTIVE_TURN_FOLLOW_UP_MODES.has(value) ? value : defaultValue;
}

module.exports = { readConfig };
