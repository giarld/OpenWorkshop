import assert from "node:assert/strict";
import test from "node:test";
import { configuredSecrets, isHighRiskCommand, redactSensitive } from "./security.ts";

test("redacts common credentials in objects, text, and configured environment values", () => {
  const secrets = configuredSecrets({ sensitiveEnvironmentVariables: ["PRIVATE_VALUE"] }, { PRIVATE_VALUE: "marked-secret" });
  const result = redactSensitive({ OPENAI_API_KEY: "sk-test", GITHUB_TOKEN: "ghp_test", token: "plain", output: "OPENAI_API_KEY=sk-text marked-secret" }, secrets);
  assert.equal(result.redacted, true);
  assert.doesNotMatch(JSON.stringify(result.value), /sk-test|ghp_test|plain|sk-text|marked-secret/);
});

test("classifies separated and platform-specific destructive commands as high risk", () => {
  assert.equal(isHighRiskCommand({ command: ["rm", "-r", "-f", "target"] }), true);
  assert.equal(isHighRiskCommand({ command: "powershell Remove-Item target -Recurse" }), true);
  assert.equal(isHighRiskCommand({ command: ["cmd", "/c", "rmdir", "/s", "/q", "target"] }), true);
  assert.deepEqual([
    isHighRiskCommand({ command: "bash -lc \"rm -rf target\"" }),
    isHighRiskCommand({ command: ["sh", "-c", "rm -r -f target"] }),
    isHighRiskCommand({ commandActions: [{ command: "powershell -Command \"Remove-Item target -Recurse\"" }] })
  ], [true, true, true]);
  assert.equal(isHighRiskCommand({ command: ["npm", "test"] }), false);
});
