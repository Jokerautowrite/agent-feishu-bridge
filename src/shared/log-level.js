const ALLOWED_LOG_LEVELS = new Set(["quiet", "normal", "verbose"]);
const ROUTINE_CODEX_METHODS = new Set([
  "item/completed",
  "item/started",
  "thread/goal/cleared",
  "thread/settings/updated",
  "thread/status/changed",
  "thread/tokenusage/updated",
  "account/ratelimits/updated",
  "turn/diff/updated",
  "turn/plan/updated",
]);

function normalizeLogLevel(value, fallback = "normal") {
  const normalized = String(value || "").trim().toLowerCase();
  if (ALLOWED_LOG_LEVELS.has(normalized)) {
    return normalized;
  }
  return ALLOWED_LOG_LEVELS.has(fallback) ? fallback : "normal";
}

function shouldLogCodexTraffic(message, logLevel = "normal") {
  const normalizedLevel = normalizeLogLevel(logLevel);
  if (normalizedLevel === "verbose") {
    return true;
  }
  if (normalizedLevel === "quiet") {
    return false;
  }

  const method = String(message?.method || "").trim().toLowerCase();
  if (!method) {
    return true;
  }
  if (method.endsWith("delta")) {
    return false;
  }
  return !ROUTINE_CODEX_METHODS.has(method);
}

module.exports = {
  normalizeLogLevel,
  shouldLogCodexTraffic,
};
