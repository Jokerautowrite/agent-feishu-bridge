#!/usr/bin/env node

const assert = require("node:assert/strict");
const http = require("node:http");
const { CodexRpcClient } = require("../src/infra/codex/rpc-client");
const { showStatusPanel } = require("../src/domain/workspace/workspace-service");

async function main() {
  await testLiveCatalogClient();
  await testStatusPanelRefreshesCatalog();
  console.log("Live model catalog tests passed.");
}

async function testLiveCatalogClient() {
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    requestCount += 1;
    assert.equal(request.headers.authorization, "Bearer test-token");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: `live-model-${requestCount}` }] }));
  });
  await listen(server);

  try {
    const address = server.address();
    const client = new CodexRpcClient({
      modelCatalogUrl: `http://127.0.0.1:${address.port}/v1/models`,
      modelCatalogAuthToken: "test-token",
      extraModels: ["stale-model"],
    });
    client.sendRequest = async () => {
      throw new Error("static Codex model/list must not be used with a live catalog");
    };

    const first = await client.listModels();
    const second = await client.listModels();
    assert.deepEqual(first.data.map((item) => item.model), ["live-model-1"]);
    assert.deepEqual(second.data.map((item) => item.model), ["live-model-2"]);
    assert.equal(requestCount, 2, "each listModels call must fetch the current catalog");
  } finally {
    await close(server);
  }
}

async function testStatusPanelRefreshesCatalog() {
  let catalog = {
    models: [{ id: "cached-model", model: "cached-model" }],
    updatedAt: "before",
  };
  let catalogRequests = 0;
  const cards = [];
  const runtime = {
    codex: {
      async listModels() {
        catalogRequests += 1;
        return { data: [{ id: `live-panel-${catalogRequests}` }] };
      },
    },
    sessionStore: {
      getAvailableModelCatalog() {
        return catalog;
      },
      setAvailableModelCatalog(models) {
        catalog = { models, updatedAt: `refresh-${catalogRequests}` };
        return catalog;
      },
    },
    resolveReplyToMessageId() { return "message-1"; },
    resolveThreadIdForBinding() { return ""; },
    getBindingContext() { return { bindingKey: "binding-1", workspaceRoot: "/workspace" }; },
    async resolveWorkspaceThreadState() { return { threads: [], threadId: "" }; },
    describeWorkspaceStatus() { return { code: "idle" }; },
    getCodexParamsForWorkspace() { return { model: "", effort: "" }; },
    buildStatusPanelCard(payload) { return payload; },
    async sendInteractiveCard(payload) { cards.push(payload.card); },
  };
  const normalized = { chatId: "chat-1", messageId: "message-1" };

  await showStatusPanel(runtime, normalized);
  await showStatusPanel(runtime, normalized);

  assert.equal(catalogRequests, 2, "each status panel must refresh the catalog");
  assert.deepEqual(cards[0].modelOptions, [{ label: "live-panel-1", value: "live-panel-1" }]);
  assert.deepEqual(cards[1].modelOptions, [{ label: "live-panel-2", value: "live-panel-2" }]);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
