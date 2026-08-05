#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "coverage",
  "dist",
]);

const SKIP_FILES = new Set([
  "package-lock.json",
  "scripts/privacy-scan.js",
]);

const SKIP_EXTENSIONS = new Set([
  ".tgz",
  ".gz",
  ".zip",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".pdf",
]);

const PATTERNS = [
  { name: "private-persona", re: /\b(Jiao|Mira)\b|予安/g },
  { name: "private-systems", re: /Obsidian|TaskNotes|OpenClaw|Hermes|Chronicle|Knowledge Wiki|Over CDN/gi },
  { name: "local-private-path", re: /\/Users\/keeploving/g },
  { name: "env-secret-assignment", re: /FEISHU_APP_SECRET\s*=\s*(?!x{6,}|YOUR_|<|$)[^\s]+/g },
  { name: "openai-like-secret", re: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: "github-token", re: /gh[pousr]_[A-Za-z0-9_]{20,}/g },
  { name: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{20,}/g },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/g },
];

const ALLOWED_PUBLIC_TERMS = [
  "Jiao-Joe",
];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(ROOT, fullPath);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        files.push(...walk(fullPath));
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (
      SKIP_FILES.has(entry.name) ||
      SKIP_FILES.has(relPath) ||
      SKIP_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      continue;
    }
    files.push(relPath);
  }
  return files;
}

function scanFile(relPath) {
  const fullPath = path.join(ROOT, relPath);
  let text = fs.readFileSync(fullPath, "utf8");
  for (const term of ALLOWED_PUBLIC_TERMS) {
    text = text.replaceAll(term, "[allowed-public-owner]");
  }
  const findings = [];
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    let match;
    while ((match = pattern.re.exec(text)) !== null) {
      const before = text.slice(0, match.index);
      const line = before.split(/\r?\n/).length;
      findings.push({ file: relPath, line, name: pattern.name, match: match[0] });
    }
  }
  return findings;
}

function main() {
  const files = walk(ROOT);
  const findings = files.flatMap(scanFile);
  if (findings.length) {
    console.error("Privacy scan failed:");
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line} [${finding.name}] ${finding.match}`);
    }
    process.exit(1);
  }
  console.log(`Privacy scan passed (${files.length} files checked).`);
}

main();
