const directClient = require("../../infra/custom-model/direct-client");

function listChannels(runtime) {
  return runtime?.customModelStore?.list?.() || [];
}

function getChannel(runtime, modelName) {
  const name = typeof modelName === "string" ? modelName.trim() : "";
  if (!name) {
    return null;
  }
  return runtime?.customModelStore?.get?.(name) || null;
}

async function addChannel(runtime, { name, baseUrl, apiKey }) {
  // Validate format first, then test connectivity, then persist.
  const nameValidation = directClient.validateModelName(name);
  if (!nameValidation.ok) {
    return nameValidation;
  }
  const baseValidation = directClient.validateBaseUrl(baseUrl);
  if (!baseValidation.ok) {
    return baseValidation;
  }
  const keyValidation = directClient.validateApiKey(apiKey);
  if (!keyValidation.ok) {
    return keyValidation;
  }

  const normalizedName = nameValidation.value;
  if (getChannel(runtime, normalizedName)) {
    return { ok: false, error: `已存在同名自定义模型「${normalizedName}」。` };
  }

  const connection = await directClient.testConnection({
    baseUrl: baseValidation.value,
    apiKey: keyValidation.value,
    model: normalizedName,
  });
  if (!connection.ok) {
    return connection;
  }

  const saved = runtime.customModelStore.add({
    name: normalizedName,
    baseUrl: connection.baseUrl,
    apiKey: keyValidation.value,
  });
  if (!saved.ok) {
    return saved;
  }
  return { ok: true, channel: saved.channel };
}

function removeChannel(runtime, name) {
  return runtime?.customModelStore?.remove?.(name) || false;
}

function maskChannelKey(channel) {
  return directClient.maskApiKey(channel?.apiKey);
}

module.exports = {
  listChannels,
  getChannel,
  addChannel,
  removeChannel,
  maskChannelKey,
};
