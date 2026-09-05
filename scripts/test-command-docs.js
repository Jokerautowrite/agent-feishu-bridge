#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildWelcomeCard } = require("../src/presentation/card/builders");

const root = path.resolve(__dirname, "..");
const docs = ["README.md", "docs/使用说明.md", "docs/飞书云文档正文.md"];
for (const relativePath of docs) {
  const content = fs.readFileSync(path.join(root, relativePath), "utf8");
  const staleLines = content.split("\n").filter((line) => (
    /`\/codex\s+/.test(line) && !/兼容/.test(line)
  ));
  assert.deepEqual(staleLines, [], `${relativePath} should document universal / commands`);
}

const welcome = JSON.stringify(buildWelcomeCard({ projectsRoot: "~/projects" }));
assert.match(welcome, /\/bind/);
assert.doesNotMatch(welcome, /\/codex bind/);
assert.match(welcome, /飞书应用必备配置/);

for (const installer of ["install.ps1", "install.sh"]) {
  const content = fs.readFileSync(path.join(root, installer), "utf8");
  assert.match(content, /gemini/, `${installer} should offer the Gemini backend`);
}

console.log("command docs fixtures ok");
