#!/usr/bin/env node

const { main } = require("../src/index");

main().catch((error) => {
  console.error(`[codex-im] ${error.message}`);
  process.exit(1);
});
