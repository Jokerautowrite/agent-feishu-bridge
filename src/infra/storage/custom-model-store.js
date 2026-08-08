const fs = require("fs");
const path = require("path");

const DEFAULT_FILE = path.join(
  require("os").homedir(),
  ".config",
  "agent-bridge",
  "custom-models.json"
);

function createEmptyState() {
  return { channels: {} };
}

class CustomModelStore {
  constructor({ filePath = DEFAULT_FILE } = {}) {
    this.filePath = filePath;
    this.state = createEmptyState();
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    const parentDirectory = path.dirname(this.filePath);
    fs.mkdirSync(parentDirectory, { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.channels && typeof parsed.channels === "object") {
        this.state = { channels: parsed.channels };
      }
    } catch {
      this.state = createEmptyState();
    }
  }

  save() {
    const parentDirectory = path.dirname(this.filePath);
    fs.mkdirSync(parentDirectory, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), {
      mode: 0o600,
    });
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // best effort: some filesystems ignore chmod
    }
  }

  list() {
    return Object.values(this.state.channels || {});
  }

  get(name) {
    const key = normalizeChannelKey(name);
    if (!key) {
      return null;
    }
    const entry = this.state.channels[key];
    return entry ? { ...entry } : null;
  }

  add({ name, baseUrl, apiKey }) {
    const key = normalizeChannelKey(name);
    if (!key) {
      return { ok: false, error: "模型名为空。" };
    }
    if (this.state.channels[key]) {
      return { ok: false, error: `已存在同名自定义模型「${name}」，请换一个模型名。` };
    }
    const now = new Date().toISOString();
    this.state.channels[key] = {
      name,
      baseUrl,
      apiKey,
      createdAt: now,
      updatedAt: now,
    };
    this.save();
    return { ok: true, channel: this.get(name) };
  }

  remove(name) {
    const key = normalizeChannelKey(name);
    if (!key || !this.state.channels[key]) {
      return false;
    }
    delete this.state.channels[key];
    this.save();
    return true;
  }
}

function normalizeChannelKey(name) {
  return typeof name === "string" ? name.trim() : "";
}

module.exports = { CustomModelStore, DEFAULT_FILE };
