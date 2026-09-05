const GPT_5_6_REASONING_EFFORTS = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const GPT_6_ASTRA_REASONING_EFFORTS = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function extractModelCatalogFromListResponse(response) {
  const candidates = Array.isArray(response?.result?.data)
    ? response.result.data
    : Array.isArray(response?.data)
      ? response.data
      : [];
  return normalizeModelCatalog(candidates);
}

function resolveEffectiveModelForEffort(models, currentModel) {
  if (!Array.isArray(models) || !models.length) {
    return null;
  }
  const normalizedCurrent = normalizeText(currentModel).toLowerCase();
  if (normalizedCurrent) {
    const matched = findModelByQuery(models, normalizedCurrent);
    if (matched) {
      return matched;
    }
  }
  return models.find((item) => item.isDefault) || models[0];
}

function findModelByQuery(models, query) {
  const normalizedQuery = normalizeText(query).toLowerCase();
  if (!normalizedQuery || !Array.isArray(models)) {
    return null;
  }
  const bareQuery = normalizedQuery.split("/").pop();
  const exact = models.find((item) => {
    const modelName = normalizeText(item?.model).toLowerCase();
    const idName = normalizeText(item?.id).toLowerCase();
    return modelName === normalizedQuery || idName === normalizedQuery;
  });
  if (exact) return exact;
  return models.find((item) => {
    const modelName = normalizeText(item?.model).toLowerCase();
    const idName = normalizeText(item?.id).toLowerCase();
    const bareModel = modelName.split("/").pop();
    const bareId = idName.split("/").pop();
    return bareModel === bareQuery || bareId === bareQuery;
  }) || null;
}

function normalizeModelCatalog(models) {
  if (!Array.isArray(models)) {
    return [];
  }
  const normalized = [];
  const seen = new Set();
  for (const model of models) {
    if (!model || typeof model !== "object") {
      continue;
    }
    const modelId = normalizeText(model.model);
    const id = normalizeText(model.id);
    const normalizedModel = modelId || id;
    if (!normalizedModel) {
      continue;
    }
    const dedupeKey = normalizedModel.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    const declaredReasoningEfforts = normalizeReasoningEfforts(
      model.supportedReasoningEfforts || model.supported_reasoning_efforts
    );
    normalized.push({
      id,
      model: normalizedModel,
      displayName: normalizeText(model.displayName || model.display_name),
      supportedReasoningEfforts: extendReasoningEffortsForModel(
        normalizedModel,
        declaredReasoningEfforts
      ),
      defaultReasoningEffort: normalizeText(model.defaultReasoningEffort || model.default_reasoning_effort),
      isDefault: !!(model.isDefault || model.is_default),
    });
  }
  return normalized;
}

function extendReasoningEffortsForModel(model, efforts) {
  const normalizedModel = normalizeText(model);
  if (/^gpt-6-astra(?:$|-)/i.test(normalizedModel)) {
    return normalizeReasoningEfforts([
      ...efforts,
      ...GPT_6_ASTRA_REASONING_EFFORTS,
    ]);
  }
  if (/^gpt-5\.6(?:$|-)/i.test(normalizedModel)) {
    return normalizeReasoningEfforts([
      ...efforts,
      ...GPT_5_6_REASONING_EFFORTS,
    ]);
  }
  return efforts;
}

function normalizeReasoningEfforts(efforts) {
  if (!Array.isArray(efforts)) {
    return [];
  }
  const result = [];
  const seen = new Set();
  for (const effort of efforts) {
    const normalized = normalizeText(
      typeof effort === "string"
        ? effort
        : effort?.reasoningEffort || effort?.reasoning_effort
    );
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Parse an opencodex /v1/models response into bridge-ready model catalog entries.
 * opencodex returns { id, reasoning_effort, reasoning_efforts:[{value,label}] }.
 */
function parseOpenCodeXModelCatalog(response, currentModel) {
  const candidates = Array.isArray(response?.data)
    ? response.data
    : Array.isArray(response?.result?.data)
      ? response.result.data
      : [];
  const adapted = candidates.map((entry) => ({
    id: entry?.id,
    model: entry?.id,
    displayName: entry?.display_name || entry?.id,
    defaultReasoningEffort: entry?.reasoning_effort || (
      (entry?.reasoning_efforts || []).find((e) => e && e.default)?.value
    ) || "",
    supportedReasoningEfforts: (() => {
      const declared = (entry?.reasoning_efforts || [])
        .map((e) => e && e.value)
        .filter(Boolean);
      // opencodex 对 deepseek 等无 effort 声明的模型，补默认集合以保证默认 effort 校验通过
      // 默认含 max/ultra：opencodex /v1/models 对 sub2 路由模型不暴露 ladder，但实际路由接受 max
      return declared.length
        ? declared
        : ["low", "medium", "high", "xhigh", "max", "ultra"];
    })(),
  }));
  const normalized = normalizeModelCatalog(adapted);
  // 让 opencodex 的 isDefault 标记与当前请求的模型对齐
  if (normalized.length && currentModel) {
    const key = normalizeText(currentModel).toLowerCase();
    normalized.forEach((m) => { m.isDefault = m.id.toLowerCase() === key || m.model.toLowerCase() === key; });
  }
  return normalized;
}

module.exports = {
  extractModelCatalogFromListResponse,
  parseOpenCodeXModelCatalog,
  findModelByQuery,
  normalizeModelCatalog,
  normalizeText,
  resolveEffectiveModelForEffort,
};
