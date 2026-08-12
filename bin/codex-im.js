#!/usr/bin/env node

const { main } = require("../src/index");

let runtime = null;
let shuttingDown = false;

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error?.code === "EPIPE") {
      process.exit(0);
    }
    process.exit(1);
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[codex-im] received ${signal}, shutting down`);
  try {
    await runtime?.stop?.();
  } catch (error) {
    console.error(`[codex-im] shutdown failed: ${error.message}`);
    process.exitCode = 1;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    shutdown(signal).finally(() => process.exit());
  });
}

main().then((startedRuntime) => {
  runtime = startedRuntime || null;
}).catch((error) => {
  console.error(`[codex-im] ${error.message}`);
  process.exit(1);
});
