import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AgentRegistry, type AgentPlugin } from "./agent.ts";
import { createTaskPlanner } from "./planner-agent.ts";

test("planning prompt keeps task decomposition at independently deliverable units", async () => {
  const prompt = await readFile(new URL("./planner-agent.ts", import.meta.url), "utf8");

  assert.match(prompt, /smallest complete task tree/);
  assert.match(prompt, /independently implementable, verifiable, and retryable delivery unit/);
  assert.match(prompt, /Do not create separate tasks merely for individual files, functions, classes, small edits, setup steps, or mechanical implementation steps/);
  assert.match(prompt, /Avoid nested subtasks unless/);
});

test("sanitizes Planner Agent session failures", async () => {
  const plugin: AgentPlugin = {
    id: "fake", displayName: "Fake", pluginVersion: "1.0.0", defaultCommand: "fake", executableEnvKey: "WORKSHOP_FAKE_PATH", runtimeVersion: { min: "1.0.0" }, description: "test", backendOptions: {}, validateConfig: () => undefined,
    capabilities: { continuation: false, steering: false, interruption: false, approvals: false, userInput: false, tokenUsage: false, structuredFileEvents: false },
    health: async () => ({ id: "fake", ok: true, pluginVersion: "1.0.0", runtimeVersion: "1.0.0", capabilities: { ok: true, models: [], reasoningEfforts: [] } }),
    createSession: () => ({ initialize: async () => { throw new Error("spawn C:/private/fake.cmd EACCES"); }, start: async () => { throw new Error("unused"); }, continue: async () => { throw new Error("unused"); }, steer: async () => undefined, interrupt: async () => undefined, close: async () => undefined })
  };
  const plan = createTaskPlanner(new AgentRegistry([plugin]));

  await assert.rejects(plan({ title: "Plan", projectRoot: process.cwd(), agentConfig: { prompt: "", agentBackend: "fake" }, requirement: "Ship", acceptanceCriteria: [] }), (error: unknown) => error instanceof Error && !/private/i.test(error.message) && (error as { statusCode?: number }).statusCode === 502);
});

test("accepts standardized text from a non-Codex Planning Agent", async () => {
  const output = JSON.stringify({ mainTask: { title: "Main", description: "", priority: "medium", dueDate: null, acceptanceCriteria: [] }, tasks: [] });
  const plugin: AgentPlugin = {
    id: "fake-standard", displayName: "Fake", pluginVersion: "1.0.0", defaultCommand: "fake", executableEnvKey: "WORKSHOP_FAKE_STANDARD_PATH", runtimeVersion: { min: "1.0.0" }, description: "test", backendOptions: {}, validateConfig: () => undefined,
    capabilities: { continuation: false, steering: false, interruption: false, approvals: false, userInput: false, tokenUsage: false, structuredFileEvents: false },
    health: async () => ({ id: "fake-standard", ok: true, pluginVersion: "1.0.0", runtimeVersion: "1.0.0", capabilities: { ok: true, models: [], reasoningEfforts: [] } }),
    createSession: (options) => {
      assert.deepEqual(options.backendOptions, { transport: "fake" });
      assert.equal(options.sandboxMode, "read-only");
      assert.equal(options.networkAccess, false);
      return ({
      initialize: async () => undefined, start: async () => ({ completed: Promise.resolve({ status: "succeeded", event: { type: "turn.completed", summary: "done", sourceType: "fake/done", payload: {}, text: output } }) }),
      continue: async () => { throw new Error("unused"); }, steer: async () => undefined, interrupt: async () => undefined, close: async () => undefined
      });
    }
  };
  const plan = createTaskPlanner(new AgentRegistry([plugin]));

  assert.equal((await plan({ title: "Plan", projectRoot: process.cwd(), agentConfig: { prompt: "", agentBackend: "fake-standard", backendOptions: { transport: "fake" } }, requirement: "Ship", acceptanceCriteria: [] })).mainTask.title, "Main");
});

test("rejects valid JSON from a failed Planning Agent completion", async () => {
  const output = JSON.stringify({ mainTask: { title: "Main", description: "", priority: "medium", dueDate: null, acceptanceCriteria: [] }, tasks: [] });
  const plugin: AgentPlugin = {
    id: "fake-failed", displayName: "Fake", pluginVersion: "1.0.0", defaultCommand: "fake", executableEnvKey: "WORKSHOP_FAKE_FAILED_PATH", runtimeVersion: { min: "1.0.0" }, description: "test", backendOptions: {}, validateConfig: () => undefined,
    capabilities: { continuation: false, steering: false, interruption: false, approvals: false, userInput: false, tokenUsage: false, structuredFileEvents: false },
    health: async () => ({ id: "fake-failed", ok: true, pluginVersion: "1.0.0", runtimeVersion: "1.0.0", capabilities: { ok: true, models: [], reasoningEfforts: [] } }),
    createSession: () => ({ initialize: async () => undefined, start: async () => ({ completed: Promise.resolve({ status: "failed", event: { type: "turn.failed", summary: "failed", sourceType: "fake/done", payload: {}, text: output } }) }), continue: async () => { throw new Error("unused"); }, steer: async () => undefined, interrupt: async () => undefined, close: async () => undefined })
  };

  await assert.rejects(createTaskPlanner(new AgentRegistry([plugin]))({ title: "Plan", projectRoot: process.cwd(), agentConfig: { prompt: "", agentBackend: "fake-failed" }, requirement: "Ship", acceptanceCriteria: [] }), /Planning Agent failed/);
});
