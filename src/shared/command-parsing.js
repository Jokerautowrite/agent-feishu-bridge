function extractBindPath(text) {
  return extractCommandArgument(text, "/codex bind ");
}

function extractSwitchThreadId(text) {
  return extractCommandArgument(text, "/codex switch ");
}

function extractRemoveWorkspacePath(text) {
  return extractCommandArgument(text, "/codex remove ");
}

function extractSendPath(text) {
  return extractCommandArgument(text, "/codex send ");
}

function extractModelValue(text) {
  return extractCommandArgument(text, "/codex model ");
}

function extractEffortValue(text) {
  return extractCommandArgument(text, "/codex effort ");
}

function extractProfileValue(text) {
  return extractCommandArgument(text, "/codex profile ");
}

function extractCommandArgument(text, prefix) {
  const trimmed = String(text || "").trim();
  const normalizedPrefix = String(prefix || "").toLowerCase();
  if (trimmed.toLowerCase().startsWith(normalizedPrefix)) {
    return trimmed.slice(normalizedPrefix.length).trim();
  }
  return "";
}

module.exports = {
  extractBindPath,
  extractEffortValue,
  extractModelValue,
  extractProfileValue,
  extractRemoveWorkspacePath,
  extractSendPath,
  extractSwitchThreadId,
};
