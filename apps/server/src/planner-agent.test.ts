import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("planning prompt keeps task decomposition at independently deliverable units", async () => {
  const prompt = await readFile(new URL("./planner-agent.ts", import.meta.url), "utf8");

  assert.match(prompt, /smallest complete task tree/);
  assert.match(prompt, /independently implementable, verifiable, and retryable delivery unit/);
  assert.match(prompt, /Do not create separate tasks merely for individual files, functions, classes, small edits, setup steps, or mechanical implementation steps/);
  assert.match(prompt, /Avoid nested subtasks unless/);
});
