#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SessionStore } = require("../src/infra/storage/session-store");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-session-store-"));
const failures = [];
let checked = 0;
function file(name) { return path.join(fixture, `${name}.json`); }
function valid(extra = {}) { return JSON.stringify({ bindings: {}, ...extra }); }
function test(name, callback) {
  try { callback(); checked += 1; } catch (error) { failures.push(`${name}: ${error.message}`); }
}

test("new store persists private valid state", () => {
  const filePath = file("new");
  const store = new SessionStore({ filePath });
  store.setGroupAdmins({ fixture: ["example-admin"] });
  const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.deepStrictEqual(state.groupAdmins, { fixture: ["example-admin"] });
  assert.strictEqual(state.schemaVersion, 1);
  if (process.platform !== "win32") assert.strictEqual(fs.statSync(filePath).mode & 0o777, 0o600);
});
test("corrupt JSON fails closed and preserves bytes", () => {
  const filePath = file("corrupt");
  const raw = '{"bindings":';
  fs.writeFileSync(filePath, raw);
  assert.throws(() => new SessionStore({ filePath }), { code: "SESSION_STORE_CORRUPT" });
  assert.strictEqual(fs.readFileSync(filePath, "utf8"), raw);
});
test("invalid state shape fails closed", () => {
  const filePath = file("invalid-shape");
  fs.writeFileSync(filePath, '{"bindings":[]}');
  assert.throws(() => new SessionStore({ filePath }), { code: "SESSION_STORE_CORRUPT" });
});
test("future schema is not silently downgraded", () => {
  const filePath = file("future");
  fs.writeFileSync(filePath, valid({ schemaVersion: 999 }));
  fs.writeFileSync(`${filePath}.backup`, valid());
  assert.throws(() => new SessionStore({ filePath }), { code: "SESSION_STORE_UNSUPPORTED_VERSION" });
});
test("legacy fields survive normal save with a recovery copy", () => {
  const filePath = file("legacy");
  const original = valid({ customExtension: { enabled: true } });
  fs.writeFileSync(filePath, original);
  const store = new SessionStore({ filePath });
  store.setGroupAdmins({ fixture: [] });
  assert.strictEqual(JSON.parse(fs.readFileSync(filePath)).customExtension.enabled, true);
  assert.strictEqual(fs.readFileSync(`${filePath}.backup`, "utf8"), original);
});
test("stale writer is rejected without overwriting newer state", () => {
  const filePath = file("conflict");
  fs.writeFileSync(filePath, valid());
  const first = new SessionStore({ filePath });
  const stale = new SessionStore({ filePath });
  first.setGroupAdmins({ first: [] });
  assert.throws(() => stale.setGroupAdmins({ stale: [] }), { code: "SESSION_STORE_CONFLICT" });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(filePath)).groupAdmins, { first: [] });
  assert.deepStrictEqual(stale.getGroupAdmins(), {});
});
test("failed atomic replacement preserves the previous main file", () => {
  const filePath = file("rename-failure");
  const original = valid();
  fs.writeFileSync(filePath, original);
  const store = new SessionStore({ filePath });
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === filePath) throw Object.assign(new Error("synthetic rename failure"), { code: "EIO" });
    return rename(from, to);
  };
  try {
    assert.throws(() => store.setGroupAdmins({ unsaved: [] }), /synthetic rename failure/);
    assert.strictEqual(fs.readFileSync(filePath, "utf8"), original);
    assert.deepStrictEqual(store.getGroupAdmins(), {});
  } finally {
    fs.renameSync = rename;
  }
});
test("valid backup recovers corrupt state and retains corrupt evidence", () => {
  const filePath = file("recovery");
  const original = '{"bindings":';
  fs.writeFileSync(filePath, original);
  fs.writeFileSync(`${filePath}.backup`, valid({ groupAdmins: { recovered: [] } }));
  const store = new SessionStore({ filePath });
  assert.deepStrictEqual(store.getGroupAdmins(), { recovered: [] });
  store.setGroupAdmins({ recovered: [], added: [] });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(filePath)).groupAdmins, { recovered: [], added: [] });
  const evidence = fs.readdirSync(fixture).filter((name) => name.startsWith("recovery.json.corrupt-"));
  assert.strictEqual(evidence.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(fixture, evidence[0]), "utf8"), original);
});
test("missing primary with a backup recovers rather than clearing bindings", () => {
  const filePath = file("missing-primary");
  fs.writeFileSync(`${filePath}.backup`, valid({ groupAdmins: { recovered: [] } }));
  assert.deepStrictEqual(new SessionStore({ filePath }).getGroupAdmins(), { recovered: [] });
});
test("read permission failure is not treated as an empty store", () => {
  const filePath = file("denied");
  const read = fs.readFileSync;
  fs.readFileSync = (target, ...args) => {
    if (target === filePath) throw Object.assign(new Error("synthetic permission failure"), { code: "EACCES" });
    return read(target, ...args);
  };
  try {
    assert.throws(() => new SessionStore({ filePath }), { code: "SESSION_STORE_READ_FAILED" });
  } finally {
    fs.readFileSync = read;
  }
});

assert.deepStrictEqual(failures, [], failures.join("\n"));
console.log(`session store fixtures ok (${checked} cases; synthetic files retained)`);
