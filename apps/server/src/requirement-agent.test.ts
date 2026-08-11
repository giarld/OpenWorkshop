import assert from "node:assert/strict";
import test from "node:test";
import { CLARIFICATION_COMPLETION_QUESTION, completionWasConfirmed, parseRequirementAnalysis } from "./requirement-analysis.ts";
import { requirementTokenUsage, requirementUsageDelta } from "./requirement-token-usage.ts";

test("keeps clarifying while a generated requirement still has open questions", () => {
  const output = JSON.stringify({
    contentMarkdown: "## Goals\nShip it\n\n## Open questions\n- Which compatibility mode is required?\n- What is the failure fallback?\n\n## Version history\n- v0.1",
    acceptanceCriteria: ["Works"]
  });
  assert.deepEqual(parseRequirementAnalysis(output), { question: "Which compatibility mode is required?" });
  assert.deepEqual(parseRequirementAnalysis(JSON.stringify({ contentMarkdown: "## Goals\nShip it\n\n## Open questions\nNone", acceptanceCriteria: ["Works"] })), { contentMarkdown: "## Goals\nShip it\n\n## Open questions\nNone", acceptanceCriteria: ["Works"] });
});

test("requires a human response after the Agent proposes ending clarification", () => {
  assert.deepEqual(parseRequirementAnalysis('{"completionQuestion":true}'), { completionQuestion: true });
  assert.equal(completionWasConfirmed([{ role: "human", content: "Build it" }]), false);
  assert.equal(completionWasConfirmed([{ role: "agent", content: CLARIFICATION_COMPLETION_QUESTION }]), false);
  assert.equal(completionWasConfirmed([{ role: "agent", content: CLARIFICATION_COMPLETION_QUESTION }, { role: "human", content: "同意" }]), true);
});

test("parses optional single-choice clarification options", () => {
  assert.deepEqual(parseRequirementAnalysis('{"question":"Target platform?","options":["Windows","macOS"]}'), { question: "Target platform?", options: ["Windows", "macOS"] });
  assert.deepEqual(parseRequirementAnalysis('{"question":"Describe the workflow"}'), { question: "Describe the workflow" });
  assert.throws(() => parseRequirementAnalysis('{"question":"Target?","options":["Windows"]}'), /invalid question options/);
});

test("reads cumulative requirement token usage and calculates the current turn delta", () => {
  const usage = requirementTokenUsage({ tokenUsage: { total: { inputTokens: 180, outputTokens: 45, cachedInputTokens: 120 } } });
  assert.ok(usage);
  assert.deepEqual(usage, { input: 180, output: 45, cached: 120 });
  assert.deepEqual(requirementUsageDelta({ input: 100, output: 20, cached: 80 }, usage), { input: 80, output: 25, cached: 40 });
});
