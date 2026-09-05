const util = require("util");

const INSTALLED = Symbol.for("agent-bridge.log-redaction");
const SECRET_NAME_RE = /(?:secret|password|passwd|api[_-]?key|(?:^|[_-])token(?:$|[_-])|access[_-]?token|refresh[_-]?token|authorization|bearer|cookie)/i;
const SECRET_FIELD_RE = /((?:["']?)(?:[a-z0-9_-]*(?:secret|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|cookie)|token)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)/gi;

function redactSensitiveText(value, env = process.env) {
  let text = String(value ?? "");
  const secrets = Object.entries(env)
    .filter(([name, secret]) => SECRET_NAME_RE.test(name) && typeof secret === "string" && secret.length >= 8)
    .map(([, secret]) => secret)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) text = text.split(secret).join("<redacted>");
  return text
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g, "<redacted-private-key>")
    .replace(/\bBearer\s+[^\s"',;}\]]+/gi, "Bearer <redacted>")
    .replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/gi, "$1<redacted>@")
    .replace(/^(\s*(?:set-cookie|cookie)\s*:\s*)[^\r\n]*/gim, "$1<redacted>")
    .replace(SECRET_FIELD_RE, "$1<redacted>");
}

function installLogRedaction(target = console, env = process.env) {
  if (target[INSTALLED]) return;
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    const original = target[method].bind(target);
    target[method] = (...args) => original(redactSensitiveText(util.format(...args), env));
  }
  Object.defineProperty(target, INSTALLED, { value: true });
}

module.exports = { redactSensitiveText, installLogRedaction };
