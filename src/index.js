const path = require("path");
const os = require("os");
const fs = require("fs");
const dotenv = require("dotenv");

const { readConfig } = require("./infra/config/config");
const { FeishuBotRuntime } = require("./app/feishu-bot-runtime");

function loadEnv() {
  ensureDefaultConfigDirectory();

  const envCandidates = [
    path.join(process.cwd(), ".env"),
    path.join(os.homedir(), ".codex-im", ".env"),
  ];

  for (const envPath of envCandidates) {
    if (!fs.existsSync(envPath)) {
      continue;
    }
    dotenv.config({ path: envPath });
    return;
  }

  dotenv.config();
}

function ensureDefaultConfigDirectory() {
  const defaultConfigDir = path.join(os.homedir(), ".codex-im");
  fs.mkdirSync(defaultConfigDir, { recursive: true });
}

async function main() {
  loadEnv();
  const config = readConfig();

  if (!config.mode || config.mode === "feishu-bot") {
    const runtime = new FeishuBotRuntime(config);
    await runtime.start();
    return;
  }

  console.error("Usage: codex-im [feishu-bot]");
  process.exit(1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[codex-im] ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main };
