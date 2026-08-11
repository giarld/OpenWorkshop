import assert from "node:assert/strict";
import test from "node:test";
import { clarificationOptionLabel, clarificationOptions, clarificationStep, stageAfterAnalysis } from "./commission-flow.ts";

test("shows exactly the next valid requirement clarification action", () => {
  assert.equal(clarificationStep("clarifying", [{ role: "human" }]), "analyze");
  assert.equal(clarificationStep("clarifying", [{ role: "human" }, { role: "agent" }]), "reply");
  assert.equal(clarificationStep("awaiting_requirement_approval", [{ role: "agent" }]), "complete");
  assert.equal(stageAfterAnalysis("question"), undefined);
  assert.equal(stageAfterAnalysis("requirement"), "requirements");
});

test("reads persisted clarification choices", () => {
  assert.deepEqual(clarificationOptions('["Windows","macOS"]'), ["Windows", "macOS"]);
  assert.deepEqual(clarificationOptions(null), []);
  assert.deepEqual(clarificationOptions("invalid"), []);
});

test("labels only the first option as recommended in its language", () => {
  assert.equal(clarificationOptionLabel("运行完整验证", true), "运行完整验证（推荐）");
  assert.equal(clarificationOptionLabel("Run full validation", true), "Run full validation (Recommended)");
  assert.equal(clarificationOptionLabel("Alternative", false), "Alternative");
});
