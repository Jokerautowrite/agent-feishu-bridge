const assert = require("node:assert/strict");
const { OpencodeRpcClient } = require("../src/infra/opencode/rpc-client");

async function main() {
  // Break caught: a failed steering POST was tolerated whenever old SSE text
  // existed, so Feishu accepted a steer while OpenCode never received it.
  const client = new OpencodeRpcClient({ serverUrl: "http://127.0.0.1:4096" });
  const run = { turnId: "turn-1", settled: false, sawText: true };
  client.running.set("session-1", run);
  client.log = () => {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("fetch failed"); };
  try {
    await assert.rejects(
      client.steerTurn({ threadId: "session-1", expectedTurnId: "turn-1", text: "next instruction" }),
      /注入引导消息失败/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(run.settled, false, "a failed steer must not terminate a still-running backend turn");
  console.log("OpenCode steering failure fixtures ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
