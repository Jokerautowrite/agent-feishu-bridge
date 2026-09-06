const assert = require("node:assert/strict");
const { extractCardAction } = require("../src/presentation/message/normalizers");

async function main() {
  // Break caught: the callback router silently drops generic forms or their arrays.
  assert.deepEqual(extractCardAction({ action: {
    value: { kind: "interaction", interactionId: "opaque", action: "answer" },
    form_value: { q0: ["o0", "o1"] },
  } }), { kind: "interaction", interactionId: "opaque", action: "answer",
    decision: "", formValue: { q0: ["o0", "o1"] } });

  const { InteractionStore } = require("../src/domain/interaction/interaction-store");
  const { buildInteractionCard, readInteractionForm } = require("../src/presentation/card/interaction-card");
  let now = 100;
  const store = new InteractionStore({ now: () => now, ttlMs: 1000 });
  const context = { chatId: "chat-a", senderId: "sender-a" };
  const permission = {
    backend: "fixture", backendInstance: "instance-a", nativeRequestId: "request-a",
    nativeSessionId: "session-a", threadId: "thread-a", turnId: "turn-a",
    type: "permission", title: "Read a file", detail: "test operation",
    decisions: [
      { id: "once", label: "允许1次" },
      { id: "always", label: "允许全部", scope: "本会话匹配 read:* 的请求" },
      { id: "reject", label: "拒绝" },
    ],
  };
  const entry = store.register(permission, context);
  assert.equal(store.register(permission, context), entry, "SSE replay must not create a second request");
  assert.notEqual(store.register({ ...permission, backendInstance: "instance-b" }, context).id, entry.id);
  assert.notEqual(store.register({ ...permission, turnId: "turn-b" }, context).id, entry.id);
  store.markDelivered(entry.id, "card-a");
  const callback = { chatId: "chat-a", messageId: "card-a", senderIds: ["sender-a"] };
  let writes = 0;
  const resolve = async () => { writes++; return { status: "resolved" }; };
  // Breaks caught: wrong chat/message/actor and forged wider scope reach native transport.
  for (const bad of [
    { ...callback, chatId: "chat-b" }, { ...callback, messageId: "card-b" },
    { ...callback, senderIds: ["sender-b"] },
  ]) await assert.rejects(store.submit(entry.id, bad, { decision: "once" }, resolve), /context/);
  await assert.rejects(store.submit(entry.id, callback, { decision: "global" }, resolve), /decision/);
  assert.equal(writes, 0);
  const card = buildInteractionCard(entry);
  assert.match(JSON.stringify(card), /本会话匹配/);
  assert(!JSON.stringify(card).includes("session-a"), "card payload carries opaque IDs, not routing authority");
  let release;
  const pending = store.submit(entry.id, callback, { decision: "always" }, async (request, answer) => {
    assert.equal(request.nativeRequestId, "request-a");
    assert.deepEqual(answer, { decision: "always" });
    writes++;
    await new Promise((r) => { release = r; });
    return { status: "resolved" };
  });
  assert.equal(entry.state, "submitting");
  await assert.rejects(store.submit(entry.id, callback, { decision: "once" }, resolve), /submitting/);
  release();
  await pending;
  assert.equal(writes, 1);
  assert.equal(entry.state, "resolved");
  await assert.rejects(store.submit(entry.id, callback, { decision: "once" }, resolve), /resolved/);

  const fresh = (id) => {
    const e = store.register({ ...permission, nativeRequestId: id }, context);
    store.markDelivered(e.id, "card-a");
    return e;
  };
  const unknown = fresh("unknown");
  await store.submit(unknown.id, callback, { decision: "once" }, async () => { throw Error("lost ACK"); });
  assert.equal(unknown.state, "unknown");
  await assert.rejects(store.submit(unknown.id, callback, { decision: "once" }, resolve), /unknown/);
  const emptyAck = fresh("empty-ack");
  await store.submit(emptyAck.id, callback, { decision: "once" }, async () => ({}));
  assert.equal(emptyAck.state, "unknown", "empty adapter success must not grant permissions");
  const submitted = fresh("submitted");
  await store.submit(submitted.id, callback, { decision: "once" }, async () => ({ status: "submitted" }));
  assert.equal(submitted.state, "submitted", "transport write is not business acknowledgement");
  const cancelled = fresh("cancelled");
  await store.submit(cancelled.id, callback, { decision: "once" }, async () => {
    store.cancelThread("thread-a", "turn-a");
    return { status: "resolved" };
  });
  assert.equal(cancelled.state, "cancelled", "late HTTP response must not resurrect a stopped request");
  const expired = fresh("expired");
  now = 1101;
  await assert.rejects(store.submit(expired.id, callback, { decision: "once" }, resolve), /expired/);
  assert.equal(expired.state, "expired");
  const restarted = new InteractionStore();
  await assert.rejects(restarted.submit(entry.id, callback, { decision: "once" }, resolve), /missing/);

  const question = store.register({
    ...permission, nativeRequestId: "question", type: "questionnaire",
    questions: [
      { id: "q0", prompt: "Pick one", options: [{ id: "o0", label: "A" }, { id: "o1", label: "B" }], multiple: false, allowCustom: true },
      { id: "q1", prompt: "Pick several", options: [{ id: "o0", label: "C" }, { id: "o1", label: "D" }], multiple: true, allowCustom: false },
      { id: "q2", prompt: "Write", options: [], multiple: false, allowCustom: true },
    ],
  }, context);
  store.markDelivered(question.id, "card-a");
  const form = { q0: "o1", q1: ["o0", "o1"], q2_text: "typed answer" };
  const answer = readInteractionForm(question.request, form);
  assert.deepEqual(answer, { answers: [
    { selected: ["o1"], text: "" }, { selected: ["o0", "o1"], text: "" },
    { selected: [], text: "typed answer" },
  ] });
  const questionCard = JSON.stringify(buildInteractionCard(question));
  for (const tag of ["select_static", "multi_select_static", "input", "form_submit"]) assert(questionCard.includes(tag));
  for (const invalid of [
    { ...form, q0: ["o0", "o1"] }, { ...form, q0: "forged" },
    { ...form, q0_text: "both-choice-and-text" }, { ...form, q1_text: "custom-not-supported" },
    { ...form, q1: ["o0", "o0"] }, { ...form, q2_text: "" },
    { ...form, q0: { value: "o0" } },
  ]) await assert.rejects(store.submit(question.id, callback, readInteractionForm(question.request, invalid), resolve), /answer/);
  await store.submit(question.id, callback, answer, async (_request, actual) => {
    assert.deepEqual(actual, answer);
    return { status: "resolved" };
  });
  assert.equal(question.state, "resolved");
  const unsupportedScope = fresh("no-scope");
  unsupportedScope.request.decisions = [{ id: "once", label: "允许1次" }, { id: "reject", label: "拒绝" }];
  assert(!JSON.stringify(buildInteractionCard(unsupportedScope)).includes("允许全部"));
  console.log("Generic interaction state, form and isolation checks passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
