function isBotMentioned(mentions, botOpenId) {
  const normalizedBotId = typeof botOpenId === "string" ? botOpenId.trim() : "";
  if (!normalizedBotId || !Array.isArray(mentions)) {
    return false;
  }
  return mentions.some((mention) => {
    if (!mention || typeof mention !== "object") {
      return false;
    }
    return String(mention.openId || "").trim() === normalizedBotId
      || String(mention.userId || "").trim() === normalizedBotId;
  });
}

function stripBotMention(text, mentions, botOpenId) {
  const normalizedText = typeof text === "string" ? text : "";
  const normalizedBotId = typeof botOpenId === "string" ? botOpenId.trim() : "";
  if (!normalizedBotId || !Array.isArray(mentions) || !normalizedText) {
    return normalizedText;
  }
  const botMentions = mentions.filter((mention) => (
    String(mention?.openId || "").trim() === normalizedBotId
    || String(mention?.userId || "").trim() === normalizedBotId
  ));
  if (!botMentions.length) {
    return normalizedText;
  }
  const tokens = [];
  for (const botMention of botMentions) {
    if (botMention.name) {
      tokens.push(`@${botMention.name}`);
    }
    if (botMention.key) {
      tokens.push(botMention.key);
    }
  }
  let result = normalizedText.trim();
  for (const token of tokens) {
    if (!token) {
      continue;
    }
    result = result.split(token).join(" ").replace(/\s+/g, " ").trim();
  }
  return result.trim();
}

async function resolveBotOpenId(runtime, configuredBotOpenId) {
  const configured = typeof configuredBotOpenId === "string"
    ? configuredBotOpenId.trim()
    : "";
  if (configured) {
    return configured;
  }
  if (runtime?.resolvedBotOpenId) {
    return runtime.resolvedBotOpenId;
  }
  try {
    const adapter = typeof runtime.requireFeishuAdapter === "function"
      ? runtime.requireFeishuAdapter()
      : null;
    const botInfo = adapter && typeof adapter.getBotInfo === "function"
      ? await adapter.getBotInfo()
      : null;
    const openId = botInfo?.openId || "";
    if (openId) {
      runtime.resolvedBotOpenId = openId;
      return openId;
    }
  } catch {
    // fall through to empty
  }
  return "";
}

module.exports = {
  isBotMentioned,
  stripBotMention,
  resolveBotOpenId,
};
