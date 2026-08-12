#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIRS = ["src", "bin", "scripts"];

function listJavaScriptFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...listJavaScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      result.push(fullPath);
    }
  }
  return result;
}

const files = SOURCE_DIRS.flatMap((directory) => listJavaScriptFiles(path.join(ROOT, directory))).sort();
for (const filePath of files) {
  const result = spawnSync(process.execPath, ["--check", filePath], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
console.log(`Syntax check passed (${files.length} JavaScript files).`);
