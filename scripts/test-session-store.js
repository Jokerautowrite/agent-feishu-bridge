#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SessionStore } = require("../src/infra/storage/session-store");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-session-"));
const filePath = path.join(tempRoot, "sessions.json");
try {
  const store = new SessionStore({ filePath });
  store.setActiveWorkspaceRoot("binding", "/workspace/first");
  store.setActiveWorkspaceRoot("binding", "/workspace/second");
  store.setActiveWorkspaceRoot("binding", "/workspace/third");
  assert.ok(fs.existsSync(`${filePath}.bak`), "a last-known-good backup should be kept");
  fs.writeFileSync(filePath, "{truncated", "utf8");
  const recovered = new SessionStore({ filePath });
  assert.equal(recovered.getActiveWorkspaceRoot("binding"), "/workspace/second");
  console.log("session store recovery tests OK");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
