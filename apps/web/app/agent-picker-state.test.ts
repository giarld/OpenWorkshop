import assert from "node:assert/strict";
import test from "node:test";
import { defaultModelLabel, defaultReasoningLabel, manualModelChoice, pickerBlurCloses, reasoningValues, visibleModels } from "./agent-picker-state.ts";

test("keeps custom models selectable and preserves backend option order", () => {
  const models = [{ id: "a", displayName: "Alpha" }, { id: "b", displayName: "Beta" }];
  assert.deepEqual(visibleModels(models, "custom", "").map((item) => item.id), ["custom", "a", "b"]);
  assert.deepEqual(visibleModels(models, "b", "").map((item) => item.id), ["b", "a"]);
  assert.deepEqual(visibleModels(models, "b", "alp").map((item) => item.id), ["a"]);
  assert.deepEqual(reasoningValues({ supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "low" }] }), ["high", "low"]);
  assert.equal(defaultModelLabel([{ id: "gpt-5.6-sol", isDefault: true }]), "Codex默认(gpt-5.6-sol)");
  assert.equal(defaultReasoningLabel("medium"), "系统默认(medium)");
});

test("keeps pickers open while their scrollable options are pressed", () => {
  assert.equal(pickerBlurCloses(false, true), false);
  assert.equal(pickerBlurCloses(false, false), true);
});

test("offers an unmatched query as a manual model choice", () => {
  assert.equal(manualModelChoice("  custom/model  ", 0), "custom/model");
  assert.equal(manualModelChoice("custom/model", 1), undefined);
});
