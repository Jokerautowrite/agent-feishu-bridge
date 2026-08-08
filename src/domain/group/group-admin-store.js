/**
 * 群管理员存储：谁把机器人拉进群，谁就是该群管理员。
 *
 * 数据来源：
 * 1. 事件 im.chat.member.bot.added_v1 的 operator_id（拉机器人进群的人）
 * 2. 可选配置 AGENT_BRIDGE_ADMIN_OPEN_IDS（全局兜底，通常不需要）
 *
 * 持久化到 sessions 文件的 groupAdmins 字段，重启不丢。
 */

function createGroupAdminStore(options = {}) {
  const adminsByChat = new Map(); // chatId -> Set<openId>
  const persist = typeof options.persist === "function" ? options.persist : null;
  let dirty = false;

  function loadFromSnapshot(snapshot) {
    adminsByChat.clear();
    if (!snapshot || typeof snapshot !== "object") {
      return;
    }
    for (const [chatId, admins] of Object.entries(snapshot)) {
      if (!chatId || !Array.isArray(admins)) {
        continue;
      }
      const set = new Set();
      for (const openId of admins) {
        const normalized = String(openId || "").trim();
        if (normalized) {
          set.add(normalized);
        }
      }
      if (set.size > 0) {
        adminsByChat.set(chatId, set);
      }
    }
    dirty = false;
  }

  function snapshot() {
    const out = {};
    for (const [chatId, set] of adminsByChat) {
      out[chatId] = [...set];
    }
    return out;
  }

  function isAdmin(chatId, openId) {
    const normalizedChatId = typeof chatId === "string" ? chatId.trim() : "";
    const normalizedOpenId = typeof openId === "string" ? openId.trim() : "";
    if (!normalizedChatId || !normalizedOpenId) {
      return false;
    }
    const set = adminsByChat.get(normalizedChatId);
    return Boolean(set && set.has(normalizedOpenId));
  }

  async function addAdmin(chatId, openId) {
    const normalizedChatId = typeof chatId === "string" ? chatId.trim() : "";
    const normalizedOpenId = typeof openId === "string" ? openId.trim() : "";
    if (!normalizedChatId || !normalizedOpenId) {
      return false;
    }
    let set = adminsByChat.get(normalizedChatId);
    if (!set) {
      set = new Set();
      adminsByChat.set(normalizedChatId, set);
    }
    if (set.has(normalizedOpenId)) {
      return false;
    }
    set.add(normalizedOpenId);
    dirty = true;
    if (persist) {
      try {
        await persist(snapshot());
        dirty = false;
      } catch (error) {
        console.warn(`[codex-im] group admin persist failed: ${error.message}`);
      }
    }
    return true;
  }

  function isDirty() {
    return dirty;
  }

  return {
    isAdmin,
    addAdmin,
    loadFromSnapshot,
    snapshot,
    isDirty,
  };
}

module.exports = {
  createGroupAdminStore,
};
