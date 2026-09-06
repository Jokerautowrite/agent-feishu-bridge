const plain = (content) => ({ tag: "plain_text", content: String(content || "") });
const md = (content) => ({ tag: "markdown", content });
const clip = (text, length = 3000) => String(text || "").slice(0, length);
const STATE_TEXT = {
  pending: "等待你的选择", submitting: "正在回传后端", submitted: "已发送，等待后端确认",
  resolved: "后端已确认处理", rejected: "后端已确认拒绝", cancelled: "任务已结束或已停止",
  expired: "请求已过期，请重新发起任务", unknown: "回传结果未知，请勿重复授权；请在后端核对或 /stop",
  delivery_failed: "交互卡投递失败，请 /stop 后重试",
};

function button(entry, label, action, decision = "", extra = {}) {
  return {
    tag: "button", text: plain(label), type: decision === "reject" ? "danger" : "default",
    value: { kind: "interaction", interactionId: entry.id, action, ...(decision ? { decision } : {}) },
    ...extra,
  };
}

function buildInteractionCard(entry) {
  const r = entry.request;
  const elements = [md(`**${STATE_TEXT[entry.state] || "状态未知"}**`)];
  if (entry.state === "pending") {
    if (r.type === "permission") {
      elements.push(md(clip(r.detail)));
      for (const d of r.decisions) if (d.scope) elements.push(md(`**${d.label}的范围：** ${clip(d.scope, 1500)}`));
      elements.push({ tag: "column_set", flex_mode: "none", columns: r.decisions.map((d) => ({
        tag: "column", width: "weighted", weight: 1,
        elements: [button(entry, d.label, "decide", d.id)],
      })) });
    } else {
      const fields = [];
      for (const q of r.questions) {
        fields.push(md(clip(q.prompt, 2000)));
        if (q.options.length) {
          fields.push({
            tag: q.multiple ? "multi_select_static" : "select_static", name: q.id,
            placeholder: plain(q.multiple ? "可选择多项" : "选择一项，或填写自定义答案"),
            options: q.options.map((o) => ({ text: plain(clip(o.label, 200)), value: o.id })),
          });
          const descriptions = q.options.filter((o) => o.description);
          if (descriptions.length) fields.push(md(clip(descriptions.map((o) => `${o.label}：${o.description}`).join("\n"), 3000)));
        }
        if (q.allowCustom) fields.push({
          tag: "input", name: `${q.id}_text`,
          placeholder: plain(q.multiple ? "自定义答案（可选）" : "自定义答案（与选项二选一）"),
        });
      }
      fields.push(button(entry, "提交回答", "answer", "", { type: "primary", name: "answer_submit", action_type: "form_submit" }));
      elements.push({ tag: "form", name: "interaction_form", elements: fields });
      if (r.allowReject) elements.push(button(entry, "拒绝回答", "decide", "reject"));
    }
  }
  return {
    schema: "2.0", config: { wide_screen_mode: true, update_multi: true },
    header: { title: plain(clip(r.title || "Agent 交互请求", 100)), template: entry.state === "pending" ? "orange" : "blue" },
    body: { elements },
  };
}

function readInteractionForm(request, form = {}) {
  return { answers: (request.questions || []).map((q) => {
    const raw = form[q.id];
    // Preserve invalid shapes for domain validation instead of silently dropping them.
    return { selected: raw == null || raw === "" ? [] : Array.isArray(raw) ? raw : [raw],
      text: form[`${q.id}_text`] ?? "" };
  }) };
}

module.exports = { buildInteractionCard, readInteractionForm, STATE_TEXT };
