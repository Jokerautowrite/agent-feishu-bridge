/**
 * 群成员名字缓存（open_id → 名字）。
 *
 * 设计参考社区版插件（@larksuite/openclaw-lark）：
 * 1. 群成员接口预取：GET /open-apis/im/v1/chats/{chat_id}/members
 * 2. LRU 缓存 + TTL，避免每次消息都请求飞书 API
 * 3. 空名也缓存（无权限时防止反复请求）
 * 4. in-flight 去重：同一群并发请求只发一次
 */

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 分钟
const DEFAULT_MAX_ENTRIES = 200;
const MEMBER_PAGE_SIZE = 100;

function createMemberNameCache(options = {}) {
  const ttlMs = Number(options.ttlMs || DEFAULT_TTL_MS);
  const maxEntries = Number(options.maxEntries || DEFAULT_MAX_ENTRIES);
  const cache = new Map(); // chatId -> { fetchedAt, byOpenId: Map<openId, name>, inFlight: Promise|null }

  function isFresh(chatId, now = Date.now()) {
    const entry = cache.get(chatId);
    return Boolean(entry && now - entry.fetchedAt < ttlMs);
  }

  function getMemberName(chatId, openId) {
    const entry = cache.get(chatId);
    if (!entry || !openId) {
      return "";
    }
    return entry.byOpenId.get(openId) || "";
  }

  function recordMembers(chatId, members, now = Date.now()) {
    const byOpenId = new Map();
    for (const member of members) {
      const openId = String(member?.openId || member?.member_id || "").trim();
      if (!openId) {
        continue;
      }
      const name = String(member?.name || "").trim();
      byOpenId.set(openId, name);
    }
    cache.set(chatId, {
      fetchedAt: now,
      byOpenId,
      inFlight: null,
    });
    // 简单 LRU：超出上限时删除最旧条目
    if (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey && oldestKey !== chatId) {
        cache.delete(oldestKey);
      }
    }
  }

  function clearChat(chatId) {
    cache.delete(chatId);
  }

  function clearAll() {
    cache.clear();
  }

  return {
    isFresh,
    getMemberName,
    recordMembers,
    clearChat,
    clearAll,
  };
}

/**
 * 预取群成员并写缓存。in-flight 去重 + 空列表也记录（防反复请求）。
 * 失败时不记录，让下次重试。
 */
async function prefetchChatMembers(runtime, chatId, cache) {
  if (!chatId || typeof runtime?.requireFeishuAdapter !== "function") {
    return;
  }
  if (cache.isFresh(chatId)) {
    return;
  }

  // 简单 in-flight 去重：用模块级 Map 辅助
  const inflight = prefetchInFlight.get(chatId);
  if (inflight) {
    try {
      await inflight;
    } catch {
      // ignore
    }
    return;
  }

  const promise = (async () => {
    let members = [];
    try {
      const adapter = runtime.requireFeishuAdapter();
      if (typeof adapter.listChatMembers === "function") {
        members = await adapter.listChatMembers(chatId);
      } else if (typeof adapter.getChatMembers === "function") {
        members = await adapter.getChatMembers(chatId);
      }
    } catch (error) {
      console.warn(`[codex-im] member name prefetch failed chat=${chatId}: ${error.message}`);
      // 失败不记录，下次消息再试
      prefetchInFlight.delete(chatId);
      return;
    }
    cache.recordMembers(chatId, members);
    prefetchInFlight.delete(chatId);
  })();

  prefetchInFlight.set(chatId, promise);
  try {
    await promise;
  } catch {
    // ignore
  }
}

// 模块级 in-flight 去重表
const prefetchInFlight = new Map();

module.exports = {
  createMemberNameCache,
  prefetchChatMembers,
  DEFAULT_TTL_MS,
};
