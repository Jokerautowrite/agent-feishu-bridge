const MODEL_NAME_PATTERN = /^[A-Za-z0-9._:\/+-]+$/;
const MAX_MODEL_NAME_LENGTH = 120;
const DEFAULT_TEST_TIMEOUT_MS = 15000;

function normalizeBaseUrl(input) {
  if (typeof input !== "string") {
    return "";
  }
  let url = input.trim();
  if (!url) {
    return "";
  }
  // Strip a full chat/completions path if the user pasted the endpoint URL.
  url = url.replace(/\/chat\/completions$/i, "");
  // Strip trailing slashes.
  url = url.replace(/\/+$/, "");
  return url;
}

function validateModelName(name) {
  const normalized = typeof name === "string" ? name.trim() : "";
  if (!normalized) {
    return { ok: false, error: "模型名不能为空。" };
  }
  if (normalized.length > MAX_MODEL_NAME_LENGTH) {
    return { ok: false, error: `模型名过长（最长 ${MAX_MODEL_NAME_LENGTH} 字符）。` };
  }
  if (!MODEL_NAME_PATTERN.test(normalized)) {
    return { ok: false, error: "模型名只能包含字母、数字和 . _ - / : + 符号。" };
  }
  return { ok: true, value: normalized };
}

function validateBaseUrl(rawUrl) {
  const baseUrl = normalizeBaseUrl(rawUrl);
  if (!baseUrl) {
    return { ok: false, error: "API 地址不能为空。" };
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, error: "API 地址格式不对，应以 http:// 或 https:// 开头。" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "API 地址仅支持 http/https 协议。" };
  }
  return { ok: true, value: baseUrl };
}

function validateApiKey(apiKey) {
  const normalized = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!normalized) {
    return { ok: false, error: "API Key 不能为空。" };
  }
  if (normalized.length < 8) {
    return { ok: false, error: "API Key 太短（至少 8 个字符）。" };
  }
  return { ok: true, value: normalized };
}

function maskApiKey(apiKey) {
  const raw = typeof apiKey === "string" ? apiKey : "";
  if (!raw) {
    return "";
  }
  if (raw.length <= 6) {
    return "***";
  }
  return `${raw.slice(0, 3)}***${raw.slice(-2)}`;
}

async function listModels({ baseUrl, apiKey, timeoutMs = DEFAULT_TEST_TIMEOUT_MS }) {
  const url = `${normalizeBaseUrl(baseUrl)}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = extractErrorDetail(body) || `HTTP ${response.status}`;
      } catch {
        detail = `HTTP ${response.status}`;
      }
      return { ok: false, status: response.status, error: `连通性测试失败：${detail}` };
    }
    const body = await response.json();
    const models = extractModelNamesFromList(body);
    return { ok: true, status: response.status, models };
  } catch (error) {
    const message = error?.name === "AbortError"
      ? `连接超时（${timeoutMs / 1000}s）`
      : error?.cause?.code
        ? `连接失败：${error.cause.code}`
        : `连接失败：${error?.message || "未知错误"}`;
    return { ok: false, status: 0, error: message };
  } finally {
    clearTimeout(timer);
  }
}

async function testConnection({ baseUrl, apiKey, model }) {
  const baseValidation = validateBaseUrl(baseUrl);
  if (!baseValidation.ok) {
    return baseValidation;
  }
  const modelValidation = validateModelName(model);
  if (!modelValidation.ok) {
    return modelValidation;
  }
  const keyValidation = validateApiKey(apiKey);
  if (!keyValidation.ok) {
    return keyValidation;
  }

  const result = await listModels({
    baseUrl: baseValidation.value,
    apiKey: keyValidation.value,
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const normalizedModel = modelValidation.value;
  const exactMatch = result.models.some((entry) => entry === normalizedModel);
  if (exactMatch) {
    return { ok: true, baseUrl: baseValidation.value, model: normalizedModel };
  }

  const looseMatch = result.models.some(
    (entry) => entry.toLowerCase() === normalizedModel.toLowerCase()
  );
  if (looseMatch) {
    return { ok: true, baseUrl: baseValidation.value, model: normalizedModel };
  }

  return {
    ok: false,
    error: `地址通了，但返回的模型列表里没有「${normalizedModel}」。请核对模型名。`,
  };
}

async function streamChatCompletion({
  baseUrl,
  apiKey,
  model,
  messages,
  onDelta,
  signal,
  timeoutMs = 600000,
}) {
  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  let fullText = "";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = extractErrorDetail(body) || `HTTP ${response.status}`;
      } catch {
        detail = `HTTP ${response.status}`;
      }
      return { ok: false, error: `请求失败：${detail}` };
    }

    if (!response.body) {
      return { ok: false, error: "该地址不支持流式响应（无响应体）。" };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          fullText += delta;
          if (typeof onDelta === "function") {
            onDelta(delta);
          }
        }
      }
    }

    return { ok: true, text: fullText };
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "请求超时或已中止。"
      : error?.cause?.code
        ? `连接失败：${error.cause.code}`
        : `连接失败：${error?.message || "未知错误"}`;
    return { ok: false, error: message, partialText: fullText };
  } finally {
    clearTimeout(timer);
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function extractModelNamesFromList(body) {
  const raw = Array.isArray(body?.data) ? body.data : [];
  const names = new Set();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const model = typeof entry.model === "string" ? entry.model.trim() : "";
    if (id) {
      names.add(id);
    }
    if (model) {
      names.add(model);
    }
  }
  return Array.from(names);
}

function extractErrorDetail(body) {
  const error = body?.error;
  if (!error || typeof error !== "object") {
    return "";
  }
  return String(error.message || error.code || error.type || "").trim();
}

module.exports = {
  normalizeBaseUrl,
  validateModelName,
  validateBaseUrl,
  validateApiKey,
  maskApiKey,
  listModels,
  testConnection,
  streamChatCompletion,
};
