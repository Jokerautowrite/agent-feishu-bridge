const assert = require("assert");
const {
  listSupportedBackends,
  loadBackendClient,
  resolveConfiguredBackend,
} = require("../src/infra/backend-registry");

const expected = ["codex", "opencode", "claude", "chuang", "openclaw", "hermes", "grok"];
assert.deepStrictEqual(listSupportedBackends(), expected);
for (const backend of expected) {
  assert.strictEqual(typeof loadBackendClient(backend), "function", `${backend} must expose a client`);
}
assert.strictEqual(resolveConfiguredBackend({}), "codex");
assert.strictEqual(resolveConfiguredBackend({ AGENT_BRIDGE_BACKEND: "GROK" }), "grok");
assert.strictEqual(resolveConfiguredBackend({ CLAUDE_BRIDGE_BACKEND: "true" }), "claude");
assert.throws(() => resolveConfiguredBackend({ AGENT_BRIDGE_BACKEND: "unknown" }), /Unsupported agent backend/);

console.log("Backend registry tests passed.");
