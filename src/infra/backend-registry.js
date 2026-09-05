const BACKENDS = Object.freeze({
  codex: { modulePath: "./codex/rpc-client", exportName: "CodexRpcClient" },
  opencode: { modulePath: "./opencode/rpc-client", exportName: "OpenCodeRpcClient" },
  claude: { modulePath: "./claude/rpc-client", exportName: "ClaudeRpcClient" },
  chuang: { modulePath: "./chuang/rpc-client", exportName: "ChuangRpcClient" },
  openclaw: { modulePath: "./openclaw/rpc-client", exportName: "OpenClawRpcClient" },
  hermes: { modulePath: "./hermes/rpc-client", exportName: "HermesRpcClient" },
  grok: { modulePath: "./grok/rpc-client", exportName: "GrokRpcClient" },
  gemini: { modulePath: "./gemini/rpc-client", exportName: "GeminiRpcClient" },
});

const LEGACY_BACKEND_ENV = Object.freeze({
  OPENCODE_BRIDGE_BACKEND: "opencode",
  CLAUDE_BRIDGE_BACKEND: "claude",
  CHUANG_BRIDGE_BACKEND: "chuang",
});

function listSupportedBackends() {
  return Object.keys(BACKENDS);
}

function normalizeBackend(value) {
  const backend = String(value || "codex").trim().toLowerCase();
  if (!BACKENDS[backend]) {
    throw new Error(`Unsupported agent backend: ${backend}. Supported: ${listSupportedBackends().join(", ")}`);
  }
  return backend;
}

function resolveConfiguredBackend(env = process.env) {
  if (env.AGENT_BRIDGE_BACKEND) return normalizeBackend(env.AGENT_BRIDGE_BACKEND);
  for (const [key, backend] of Object.entries(LEGACY_BACKEND_ENV)) {
    const value = String(env[key] || "").trim().toLowerCase();
    if (value && !["0", "false", "off", "no"].includes(value)) return backend;
  }
  return "codex";
}

function loadBackendClient(backend) {
  const normalized = normalizeBackend(backend);
  const definition = BACKENDS[normalized];
  const loaded = require(definition.modulePath);
  const Client = loaded[definition.exportName] || loaded.CodexRpcClient;
  if (typeof Client !== "function") {
    throw new Error(`Backend ${normalized} does not export a compatible RPC client.`);
  }
  return Client;
}

module.exports = {
  BACKENDS,
  listSupportedBackends,
  loadBackendClient,
  normalizeBackend,
  resolveConfiguredBackend,
};
