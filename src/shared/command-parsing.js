const COMMAND_PREFIXES = [
  "/openclaw ", "/opencode ", "/claude ", "/hermes ",
  "/chuang ", "/codex ", "/grok ", "/",
];

function extractBindPath(text) {
  return extractCommandArgument(text, "bind");
}

function extractSwitchThreadId(text) {
  return extractCommandArgument(text, "switch");
}

function extractRemoveWorkspacePath(text) {
  return extractCommandArgument(text, "remove");
}

function extractSendPath(text) {
  return extractCommandArgument(text, "send");
}

function extractModelValue(text) {
  return extractCommandArgument(text, "model");
}

function extractEffortValue(text) {
  return extractCommandArgument(text, "effort");
}

function extractProfileValue(text) {
  return extractCommandArgument(text, "profile");
}

function extractCommandArgument(text, command) {
  const trimmed = String(text || "").trim();
  const normalizedCommand = String(command || "").trim().toLowerCase();
  if (!normalizedCommand) {
    return "";
  }
  for (const prefix of COMMAND_PREFIXES) {
    const fullPrefix = `${prefix}${normalizedCommand} `;
    if (trimmed.toLowerCase().startsWith(fullPrefix)) {
      return trimmed.slice(fullPrefix.length).trim();
    }
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
