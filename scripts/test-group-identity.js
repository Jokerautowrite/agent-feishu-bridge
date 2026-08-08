#!/usr/bin/env node

const assert = require("assert");
const {
  createMemberNameCache,
  prefetchChatMembers,
} = require("../src/domain/group/member-name-cache");
const { enrichGroupSenderIdentity } = require("../src/app/dispatcher");

// ── createMemberNameCache ──
const cache = createMemberNameCache({ ttlMs: 60 * 1000 });

cache.recordMembers("oc_group1", [
  { openId: "ou_alice", name: "Alice" },
  { openId: "ou_bob", name: "Bob" },
  { openId: "", name: "no-id" },
]);
assert.strictEqual(cache.getMemberName("oc_group1", "ou_alice"), "Alice");
assert.strictEqual(cache.getMemberName("oc_group1", "ou_bob"), "Bob");
assert.strictEqual(cache.getMemberName("oc_group1", "ou_unknown"), "", "unknown member");
assert.strictEqual(cache.getMemberName("oc_other", "ou_alice"), "", "different chat");
assert.ok(cache.isFresh("oc_group1"), "fresh within TTL");

// TTL 过期
const expiredCache = createMemberNameCache({ ttlMs: 1 });
expiredCache.recordMembers("oc_g", [{ openId: "ou_x", name: "X" }]);
assert.strictEqual(expiredCache.isFresh("oc_g", Date.now() + 5000), false, "stale after TTL");
assert.strictEqual(expiredCache.getMemberName("oc_g", "ou_x"), "X", "name survives TTL for reads");

// 空名也记录（防重试）
const emptyCache = createMemberNameCache();
emptyCache.recordMembers("oc_g", [{ openId: "ou_noperm", name: "" }]);
assert.strictEqual(emptyCache.getMemberName("oc_g", "ou_noperm"), "", "empty name cached");

// ── prefetchChatMembers ──
(async () => {
  let calls = 0;
  const runtime = {
    requireFeishuAdapter: () => ({
      listChatMembers: async () => {
        calls += 1;
        return [
          { openId: "ou_m1", name: "成员一" },
          { openId: "ou_m2", name: "成员二" },
        ];
      },
    }),
  };
  const prefetchCache = createMemberNameCache({ ttlMs: 60 * 1000 });

  await prefetchChatMembers(runtime, "oc_pre", prefetchCache);
  assert.strictEqual(calls, 1, "first prefetch calls API");
  assert.strictEqual(prefetchCache.getMemberName("oc_pre", "ou_m1"), "成员一");
  assert.strictEqual(prefetchCache.getMemberName("oc_pre", "ou_m2"), "成员二");

  // 第二次在 TTL 内不再请求
  await prefetchChatMembers(runtime, "oc_pre", prefetchCache);
  assert.strictEqual(calls, 1, "cached, no second API call");

  // 空 chatId 跳过
  await prefetchChatMembers(runtime, "", prefetchCache);
  assert.strictEqual(calls, 1, "empty chatId skipped");

  // 失败不记录（下次重试）
  let fail = true;
  const failRuntime = {
    requireFeishuAdapter: () => ({
      listChatMembers: async () => {
        if (fail) {
          throw new Error("no permission");
        }
        return [{ openId: "ou_ok", name: "OK" }];
      },
    }),
  };
  const failCache = createMemberNameCache();
  await prefetchChatMembers(failRuntime, "oc_fail", failCache);
  assert.strictEqual(failCache.isFresh("oc_fail"), false, "failure not recorded as fresh");
  fail = false;
  await prefetchChatMembers(failRuntime, "oc_fail", failCache);
  assert.strictEqual(failCache.getMemberName("oc_fail", "ou_ok"), "OK", "retry succeeds");

  // ── enrichGroupSenderIdentity ──
  const identityRuntime = {
    resolveGroupSenderName: async (chatId, senderId) => {
      if (chatId === "oc_g" && senderId === "ou_alice") {
        return "Alice";
      }
      return "";
    },
  };
  const groupMsg = {
    chatType: "group",
    chatId: "oc_g",
    senderId: "ou_alice",
    senderName: "",
    text: "帮我看看",
  };
  const enriched = await enrichGroupSenderIdentity(identityRuntime, groupMsg);
  assert.strictEqual(enriched.senderName, "Alice", "sender name resolved");

  const p2pMsg = { chatType: "p2p", chatId: "ou_alice", senderId: "ou_alice", text: "hi" };
  const p2pEnriched = await enrichGroupSenderIdentity(identityRuntime, p2pMsg);
  assert.strictEqual(p2pEnriched.senderName, undefined, "p2p no injection");

  console.log("group-identity tests OK");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
