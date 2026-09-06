const { randomUUID } = require("node:crypto");

const WAITING = new Set(["pending", "submitting", "submitted", "unknown", "delivery_failed"]);
const keyOf = (r) => JSON.stringify([r.backendInstance, r.nativeSessionId, r.turnId, r.nativeRequestId]);

// Process-local by design: old cards fail closed after restart. Native reconciliation
// is required before adding persistence; never replay an ambiguous authorization.
class InteractionStore {
  constructor({ now = Date.now, ttlMs = 30 * 60 * 1000, maxEntries = 500 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  register(request, context) {
    for (const name of ["backend", "backendInstance", "nativeSessionId", "nativeRequestId", "threadId", "turnId"]) {
      if (typeof request?.[name] !== "string" || !request[name]) throw Error(`invalid interaction ${name}`);
    }
    if (!context?.chatId || !context?.senderId) throw Error("missing interaction context");
    if (!["permission", "questionnaire"].includes(request.type)) throw Error("unsupported interaction type");
    if (request.type === "permission") {
      if (!request.decisions?.length || request.decisions.some((d) => !d.id || !d.label)) {
        throw Error("invalid interaction decisions");
      }
    } else if (!request.questions?.length) {
      throw Error("invalid interaction questions");
    }
    this.expire();
    const key = keyOf(request);
    for (const entry of this.entries.values()) if (entry.key === key) return entry;
    if (this.entries.size >= this.maxEntries) {
      for (const [id, entry] of this.entries) {
        if (!WAITING.has(entry.state)) this.entries.delete(id);
        if (this.entries.size < this.maxEntries) break;
      }
    }
    if (this.entries.size >= this.maxEntries) throw Error("interaction capacity exceeded");
    const entry = {
      id: randomUUID(), key, request: structuredClone(request),
      chatId: context.chatId, senderId: context.senderId, messageId: "",
      replyToMessageId: context.messageId || "", threadKey: context.threadKey || "",
      state: "pending", expiresAt: this.now() + this.ttlMs,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  markDelivered(id, messageId) {
    const entry = this.entries.get(id);
    if (!entry || !messageId) throw Error("missing interaction delivery receipt");
    entry.messageId = messageId;
  }

  expire() {
    for (const entry of this.entries.values()) {
      // An in-flight POST is bounded by adapter timeout; do not expire mid-submit.
      if (WAITING.has(entry.state) && entry.state !== "submitting" && entry.expiresAt <= this.now()) {
        entry.state = "expired";
      }
    }
  }

  hasWaiting(threadId, turnId) {
    this.expire();
    return [...this.entries.values()].some((e) => e.request.threadId === threadId
      && (!turnId || e.request.turnId === turnId) && WAITING.has(e.state));
  }

  cancelThread(threadId, turnId) {
    for (const entry of this.entries.values()) {
      if (entry.request.threadId === threadId && (!turnId || entry.request.turnId === turnId)
        && WAITING.has(entry.state)) entry.state = "cancelled";
    }
  }

  acknowledge(request, state) {
    if (!["resolved", "rejected", "cancelled"].includes(state)) return null;
    const entry = [...this.entries.values()].find((e) => e.key === keyOf(request));
    if (!entry || !WAITING.has(entry.state)) return null;
    entry.state = state;
    return entry;
  }

  async submit(id, context, response, resolve) {
    this.expire();
    const entry = this.entries.get(id);
    if (!entry) throw Error("interaction missing or restarted");
    if (entry.chatId !== context.chatId || !entry.messageId || entry.messageId !== context.messageId
      || !context.senderIds?.includes(entry.senderId)) throw Error("interaction context mismatch");
    if (entry.state !== "pending") throw Error(`interaction ${entry.state}`);
    const answer = validateAnswer(entry.request, response);
    if (typeof resolve !== "function") throw Error("interaction backend unsupported");
    // Claim before the first await: independent requests are concurrent, same request is not.
    entry.state = "submitting";
    try {
      const ack = await resolve(entry.request, answer);
      if (!["submitted", "resolved", "rejected"].includes(ack?.status)) throw Error("missing native acknowledgement");
      if (entry.state === "submitting") entry.state = ack.status;
    } catch (error) {
      if (entry.state === "submitting") entry.state = error?.code === "INTERACTION_EXPIRED" ? "expired" : "unknown";
      // Deliberately do not retain raw exceptions: they may contain tool inputs or secrets.
    }
    return entry;
  }
}

function validateAnswer(request, response) {
  if (request.type === "permission") {
    if (!request.decisions.some((d) => d.id === response?.decision)) throw Error("invalid interaction decision");
    return { decision: response.decision };
  }
  if (response?.decision === "reject" && request.allowReject) return { decision: "reject" };
  if (!Array.isArray(response?.answers) || response.answers.length !== request.questions.length) {
    throw Error("invalid interaction answers");
  }
  const answers = response.answers.map((answer, index) => {
    const q = request.questions[index];
    const selected = answer?.selected;
    const text = answer?.text;
    if (!Array.isArray(selected) || selected.some((id) => typeof id !== "string"
      || !q.options.some((o) => o.id === id)) || new Set(selected).size !== selected.length
      || typeof text !== "string" || text.length > 4000 || (text && !q.allowCustom)) {
      throw Error("invalid interaction answer");
    }
    const count = selected.length + (text.trim() ? 1 : 0);
    if (!count || (!q.multiple && count !== 1)) throw Error("invalid interaction answer cardinality");
    return { selected: [...selected], text: text.trim() };
  });
  return { answers };
}

module.exports = { InteractionStore, validateAnswer };
