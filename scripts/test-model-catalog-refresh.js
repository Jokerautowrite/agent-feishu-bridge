#!/usr/bin/env node
/**
 * 模型目录实时性回归：
 * - TTL 内：走缓存，不打扰后端；
 * - TTL 过期：实时拉取并更新缓存；
 * - 实时拉取失败：回退旧缓存且不抛错；
 * - 面板打开（showStatusPanel）在缓存过期时会触发实时拉取。
 */
const assert = require("node:assert/strict");
const { loadAvailableModels, showStatusPanel } = require("../src/domain/workspace/workspace-service");

function createRuntime({ updatedAt, listModels, config = {} }) {
  let savedCatalog = null;
  return {
    config: { modelCatalogTtlMs: 5 * 60 * 1000, modelCatalogTimeoutMs: 200, ...config },
    sessionStore: {
      getAvailableModelCatalog: () => ({
        models: [{ id: "old-model", model: "old-model" }],
        updatedAt,
      }),
      setAvailableModelCatalog: (models) => {
        savedCatalog = { models, updatedAt: new Date().toISOString() };
        return savedCatalog;
      },
    },
    codex: { listModels },
    getSavedCatalog: () => savedCatalog,
  };
}

async function testFreshCacheSkipsBackend() {
  let calls = 0;
  const runtime = createRuntime({
    updatedAt: new Date().toISOString(),
    listModels: async () => { calls += 1; return { data: [{ id: "fresh", model: "fresh" }] }; },
  });
  const result = await loadAvailableModels(runtime, { forceRefresh: false });
  assert.equal(calls, 0, "fresh cache must not hit the backend");
  assert.equal(result.source, "cache");
  assert.equal(result.models[0].model, "old-model");
}

async function testStaleCacheRefreshesLive() {
  let calls = 0;
  const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const runtime = createRuntime({
    updatedAt: staleAt,
    listModels: async () => {
      calls += 1;
      return { data: [{ id: "brand-new", model: "brand-new" }] };
    },
  });
  const result = await loadAvailableModels(runtime, { forceRefresh: false });
  assert.equal(calls, 1, "stale cache must refresh from the backend");
  assert.equal(result.source, "live");
  assert.equal(result.models[0].model, "brand-new");
  assert.ok(runtime.getSavedCatalog(), "fresh models must be persisted");
}

async function testFailureFallsBackToCache() {
  const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const runtime = createRuntime({
    updatedAt: staleAt,
    listModels: async () => { throw new Error("synthetic backend outage"); },
  });
  const result = await loadAvailableModels(runtime, { forceRefresh: false });
  assert.equal(result.error, "");
  assert.equal(result.source, "cache");
  assert.equal(result.models[0].model, "old-model");
  assert.match(result.warning || "", /synthetic backend outage/);
}

async function testStatusPanelTriggersLiveRefresh() {
  let calls = 0;
  const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const runtime = createRuntime({
    updatedAt: staleAt,
    listModels: async () => {
      calls += 1;
      return { data: [{ id: "panel-model", model: "panel-model" }] };
    },
  });
  runtime.getBindingContext = () => ({ bindingKey: "binding", workspaceRoot: "/fixture/project" });
  runtime.resolveReplyToMessageId = (_normalized, replyToMessageId) => replyToMessageId || "message";
  runtime.resolveWorkspaceThreadState = async () => ({ threads: [], threadId: "" });
  runtime.resolveThreadIdForBinding = () => "";
  runtime.describeWorkspaceStatus = () => ({ code: "idle" });
  runtime.getCodexParamsForWorkspace = () => ({ model: "", effort: "" });
  runtime.sendInteractiveCard = async () => { runtime.panelSent = true; };
  runtime.buildStatusPanelCard = () => ({});
  await showStatusPanel(runtime, { chatId: "chat", messageId: "message" });
  assert.equal(calls, 1, "opening the panel with an expired cache must refresh models");
  assert.equal(runtime.panelSent, true);
}

async function main() {
  await testFreshCacheSkipsBackend();
  await testStaleCacheRefreshesLive();
  await testFailureFallsBackToCache();
  await testStatusPanelTriggersLiveRefresh();
  console.log("model catalog refresh fixtures ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
