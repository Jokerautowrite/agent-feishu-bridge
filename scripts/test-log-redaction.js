#!/usr/bin/env node
const assert = require("assert");
const { redactSensitiveText, installLogRedaction } = require("../src/shared/log-redaction");
const { scanText } = require("./privacy-scan");

const secret = "synthetic-credential-for-tests";
const env = { EXAMPLE_API_KEY: secret };
for (const input of [
  `Authorization: Bearer ${secret}`,
  JSON.stringify({ api_key: secret }),
  `PASSWORD="${secret}"`,
  `https://example.invalid/?access_token=${secret}&limit=1`,
  `arbitrary error includes ${secret}`,
]) {
  assert.ok(!redactSensitiveText(input, env).includes(secret));
}
assert.ok(!redactSensitiveText("password=unknown-test-value", {}).includes("unknown-test-value"));
assert.ok(!redactSensitiveText(`unlabelled ${secret}`, { BOT_TOKEN: secret }).includes(secret));
assert.ok(!redactSensitiveText("Cookie: session=first-fixture; csrf=second-fixture", {}).includes("second-fixture"));
assert.strictEqual(redactSensitiveText("method=turn/completed bytes=120", env), "method=turn/completed bytes=120");
const output = [];
const target = {};
for (const method of ["log", "info", "warn", "error", "debug"]) {
  target[method] = (...args) => output.push(args.join(" "));
}
installLogRedaction(target, env);
installLogRedaction(target, env);
target.error("failure: %s", secret);
target.warn({ token: secret });
assert.strictEqual(output.length, 2);
assert.ok(output.every((line) => !line.includes(secret)));
const syntheticKey = ["sk", "a".repeat(25)].join("-");
const findings = scanText("fixture.txt", syntheticKey);
assert.strictEqual(findings.length, 1);
assert.ok(!JSON.stringify(findings).includes(syntheticKey), "privacy findings must never echo a credential");
console.log("log redaction fixtures ok");
