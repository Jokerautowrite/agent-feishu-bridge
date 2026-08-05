const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

class DeliveryReceiptHook {
  constructor({ cliPath = "", ledgerPath = "", exec = execFileAsync } = {}) {
    this.cliPath = String(cliPath || "").trim();
    this.ledgerPath = String(ledgerPath || "").trim();
    this.exec = exec;
    this.completedRunIds = new Set();
  }

  get enabled() {
    return Boolean(this.cliPath && this.ledgerPath);
  }

  async claimInbound(data) {
    if (!this.enabled) {
      return { duplicate: false };
    }
    const rawMessageId = String(data?.message?.message_id || "").trim();
    if (!rawMessageId) {
      return { duplicate: false };
    }

    const ids = buildReceiptIds(rawMessageId);
    const rawEventId = String(data?.header?.event_id || data?.event_id || "").trim();
    const chatId = String(data?.message?.chat_id || "").trim();
    const args = [
      "--path", this.ledgerPath,
      "append",
      "--message-id", ids.messageId,
      "--run-id", ids.runId,
      "--delivery-id", ids.deliveryId,
      "--fingerprint", sha256(`codex-feishu-private-reply:${chatId}:${rawMessageId}`),
    ];
    if (rawEventId) {
      args.push("--event-id", `evt-${sha256(rawEventId).slice(0, 48)}`);
    }

    try {
      await this.exec(this.cliPath, args, { timeout: 5000, maxBuffer: 64 * 1024 });
      return { duplicate: false };
    } catch (error) {
      const detail = `${error?.stderr || ""}\n${error?.message || ""}`;
      if (/duplicate or invalid delivery metadata|already has a sent receipt/i.test(detail)) {
        return { duplicate: true };
      }
      console.warn(`[codex-im] delivery ledger inbound hook nonfatal: ${compactError(error)}`);
      return { duplicate: false };
    }
  }

  async recordOutboundCompletion({ inboundMessageId = "", providerReceipt = "" } = {}) {
    if (!this.enabled || !inboundMessageId || !providerReceipt) {
      return false;
    }
    const ids = buildReceiptIds(inboundMessageId);
    if (this.completedRunIds.has(ids.runId)) {
      return true;
    }
    const receiptSeed = String(providerReceipt);
    try {
      await this.exec(this.cliPath, [
        "--path", this.ledgerPath,
        "transition",
        "--run-id", ids.runId,
        "--generation-status", "succeeded",
        "--delivery-status", "sent",
        "--receipt", `feishu-reply-${sha256(receiptSeed).slice(0, 48)}`,
      ], { timeout: 5000, maxBuffer: 64 * 1024 });
      this.completedRunIds.add(ids.runId);
      return true;
    } catch (error) {
      console.warn(`[codex-im] delivery ledger outbound hook nonfatal: ${compactError(error)}`);
      return false;
    }
  }

  async recordOutboundFailure({ inboundMessageId = "", failureClass = "send" } = {}) {
    return this.recordTerminal({
      inboundMessageId,
      generationStatus: "succeeded",
      deliveryStatus: "failed",
      receiptPrefix: "feishu-error",
      detail: failureClass,
    });
  }

  async recordGenerationFailure({ inboundMessageId = "", failureClass = "generation" } = {}) {
    return this.recordTerminal({
      inboundMessageId,
      generationStatus: "failed",
      deliveryStatus: "failed",
      receiptPrefix: "generation-error",
      detail: failureClass,
    });
  }

  async recordCancelled({ inboundMessageId = "" } = {}) {
    return this.recordTerminal({
      inboundMessageId,
      generationStatus: "skipped",
      deliveryStatus: "suppressed",
      receiptPrefix: "cancelled",
      detail: "user",
    });
  }

  async recordTerminal({
    inboundMessageId,
    generationStatus,
    deliveryStatus,
    receiptPrefix,
    detail,
  }) {
    if (!this.enabled || !inboundMessageId) {
      return false;
    }
    const ids = buildReceiptIds(inboundMessageId);
    try {
      await this.exec(this.cliPath, [
        "--path", this.ledgerPath,
        "transition",
        "--run-id", ids.runId,
        "--generation-status", generationStatus,
        "--delivery-status", deliveryStatus,
        "--receipt", `${receiptPrefix}-${sanitizeReceiptPart(detail)}`,
      ], { timeout: 5000, maxBuffer: 64 * 1024 });
      return true;
    } catch (error) {
      console.warn(`[codex-im] delivery ledger terminal hook nonfatal: ${compactError(error)}`);
      return false;
    }
  }
}

function buildReceiptIds(rawMessageId) {
  const digest = sha256(rawMessageId);
  return {
    messageId: `msg-${digest.slice(0, 48)}`,
    runId: `codex-run-${digest.slice(0, 48)}`,
    deliveryId: `codex-reply-${digest.slice(0, 48)}`,
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function compactError(error) {
  return String(error?.stderr || error?.message || error || "unknown error")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function sanitizeReceiptPart(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "unknown";
}

module.exports = { DeliveryReceiptHook, buildReceiptIds };
