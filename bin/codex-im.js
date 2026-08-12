#!/usr/bin/env node

const fs = require("fs");
const { main } = require("../src/index");

function writeFatalDiagnostic(label, error = "") {
  const detail = error instanceof Error ? (error.stack || error.message) : String(error || "");
  const line = `${new Date().toISOString()} ${label}${detail ? `\n${detail}` : ""}\n`;
  try {
    if (process.env.AGENT_BRIDGE_FATAL_LOG) {
      fs.appendFileSync(process.env.AGENT_BRIDGE_FATAL_LOG, line, "utf8");
    }
  } catch {
    // Diagnostics must never mask the original failure.
  }
  console.error(`[codex-im] ${label}${detail ? `: ${detail}` : ""}`);
}

process.on("uncaughtExceptionMonitor", (error) => {
  writeFatalDiagnostic("uncaught exception", error);
});
process.on("unhandledRejection", (error) => {
  writeFatalDiagnostic("unhandled rejection", error);
});
process.on("beforeExit", (code) => {
  writeFatalDiagnostic(`process beforeExit code=${code}`);
});
process.on("exit", (code) => {
  writeFatalDiagnostic(`process exit code=${code}`);
});

main().catch((error) => {
  writeFatalDiagnostic("startup failure", error);
  process.exit(1);
});
