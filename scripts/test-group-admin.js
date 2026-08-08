#!/usr/bin/env node

const assert = require("assert");
const { createGroupAdminStore } = require("../src/domain/group/group-admin-store");

(async () => {
  // ── createGroupAdminStore ──
  let persisted = null;
  const store = createGroupAdminStore({
    persist: async (snapshot) => {
      persisted = snapshot;
    },
  });

  assert.strictEqual(store.isAdmin("oc_g1", "ou_alice"), false, "no admin initially");
  assert.strictEqual(store.isAdmin("oc_g1", ""), false, "empty id");

  // 添加管理员（拉机器人进群的人）
  assert.strictEqual(await store.addAdmin("oc_g1", "ou_alice"), true, "first admin added");
  assert.strictEqual(store.isAdmin("oc_g1", "ou_alice"), true);
  assert.strictEqual(store.isAdmin("oc_g1", "ou_bob"), false, "other not admin");
  assert.strictEqual(store.isAdmin("oc_g2", "ou_alice"), false, "different chat not admin");

  // 重复添加
  assert.strictEqual(await store.addAdmin("oc_g1", "ou_alice"), false, "duplicate admin rejected");

  // 第二个管理员（第二个拉机器人进群的人）
  assert.strictEqual(await store.addAdmin("oc_g1", "ou_bob"), true, "second admin added");
  assert.strictEqual(store.isAdmin("oc_g1", "ou_bob"), true);

  // 无效输入
  assert.strictEqual(await store.addAdmin("", "ou_x"), false, "empty chat");
  assert.strictEqual(await store.addAdmin("oc_g3", ""), false, "empty openId");

  // ── snapshot / loadFromSnapshot ──
  assert.deepStrictEqual(persisted, {
    oc_g1: ["ou_alice", "ou_bob"],
  }, "persist called with snapshot");

  const restored = createGroupAdminStore({ persist: async () => {} });
  restored.loadFromSnapshot(persisted);
  assert.strictEqual(restored.isAdmin("oc_g1", "ou_alice"), true, "restored admin");
  assert.strictEqual(restored.isAdmin("oc_g1", "ou_bob"), true, "restored second admin");
  assert.strictEqual(restored.isAdmin("oc_g1", "ou_charlie"), false, "restored others not admin");

  // 空快照
  const emptyRestore = createGroupAdminStore({ persist: async () => {} });
  emptyRestore.loadFromSnapshot(null);
  assert.strictEqual(emptyRestore.isAdmin("oc_g1", "ou_alice"), false, "null snapshot");
  emptyRestore.loadFromSnapshot({});
  assert.strictEqual(emptyRestore.isAdmin("oc_g1", "ou_alice"), false, "empty snapshot");

  console.log("group-admin tests OK");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
