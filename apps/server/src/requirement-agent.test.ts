import assert from "node:assert/strict";
import test from "node:test";
import { AgentRegistry, type AgentPlugin } from "./agent.ts";
import type { RequirementAnalyzer } from "./commissions.ts";
import { createRequirementAnalyzer } from "./requirement-agent.ts";
import { CLARIFICATION_COMPLETION_QUESTION, completionWasConfirmed, parseRequirementAnalysis, requirementProgress } from "./requirement-analysis.ts";
import { requirementTokenUsage, requirementUsageDelta } from "./requirement-token-usage.ts";

test("keeps clarifying while a generated requirement still has open questions", () => {
  const output = JSON.stringify({
    contentMarkdown: "## Goals\nShip it\n\n## Open questions\n- Which compatibility mode is required?\n- What is the failure fallback?\n\n## Version history\n- v0.1",
    acceptanceCriteria: ["Works"]
  });
  assert.deepEqual(parseRequirementAnalysis(output), { question: "Which compatibility mode is required?" });
  assert.deepEqual(parseRequirementAnalysis(JSON.stringify({ contentMarkdown: "## Goals\nShip it\n\n## Open questions\nNone", acceptanceCriteria: ["Works"] })), { contentMarkdown: "## Goals\nShip it\n\n## Open questions\nNone", acceptanceCriteria: ["Works"] });
  assert.throws(() => parseRequirementAnalysis(JSON.stringify({ contentMarkdown: "## Goals\nShip it\n\n## Open questions\n- Need platform", acceptanceCriteria: ["Works"] })), (error: unknown) => error instanceof Error && /invalid question/.test(error.message) && (error as { statusCode?: number }).statusCode === 502);
});

test("requires a human response after the Agent proposes ending clarification", () => {
  assert.deepEqual(parseRequirementAnalysis('{"completionQuestion":true}'), { completionQuestion: true });
  assert.equal(completionWasConfirmed([{ role: "human", content: "Build it" }]), false);
  assert.equal(completionWasConfirmed([{ role: "agent", content: CLARIFICATION_COMPLETION_QUESTION }]), false);
  assert.equal(completionWasConfirmed([{ role: "agent", content: CLARIFICATION_COMPLETION_QUESTION }, { role: "human", content: "同意" }]), true);
});

test("parses optional single-choice clarification options", () => {
  assert.deepEqual(parseRequirementAnalysis('{"question":"Target platform?","options":["Windows","macOS"]}'), { question: "Target platform?", options: ["Windows", "macOS"] });
  assert.deepEqual(parseRequirementAnalysis('{"question":"Describe the workflow?"}'), { question: "Describe the workflow?" });
  assert.deepEqual(parseRequirementAnalysis('Example: {"unexpected":true}\nResult:\n```json\n{"question":"Describe the workflow?"}\n```'), { question: "Describe the workflow?" });
  assert.deepEqual(parseRequirementAnalysis('Bad examples: {"question":"Need platform"} {"question":"Target?","options":["Windows"]}\nResult: {"question":"Describe the workflow?"}'), { question: "Describe the workflow?" });
  assert.throws(() => parseRequirementAnalysis('{"question":"I will inspect the project and ask a question next."}'), /invalid question/);
  assert.throws(() => parseRequirementAnalysis('{"question":"Target?","options":["Windows"]}'), /invalid question options/);
});

test("reads cumulative requirement token usage and calculates the current turn delta", () => {
  const usage = requirementTokenUsage({ tokenUsage: { total: { inputTokens: 180, outputTokens: 45, cachedInputTokens: 120 } } });
  assert.ok(usage);
  assert.deepEqual(usage, { input: 180, output: 45, cached: 120 });
  assert.deepEqual(requirementUsageDelta({ input: 100, output: 20, cached: 80 }, usage), { input: 80, output: 25, cached: 40 });
});

test("maps Codex events to safe requirement progress without exposing payloads", () => {
  assert.equal(requirementProgress({ type: "command_execution.started", summary: "secret command", method: "item/started", payload: { command: "secret" } }), "正在执行只读项目检查");
  assert.equal(requirementProgress({ type: "agent.message.delta", summary: "Agent message", method: "item/agentMessage/delta", payload: { delta: "secret output" } }), "正在组织澄清问题");
  assert.equal(requirementProgress({ type: "turn.started", summary: "Turn started", method: "turn/started", payload: {} }), undefined);
});

test("sanitizes Requirement Agent session failures", async () => {
  const plugin: AgentPlugin = {
    id: "fake", displayName: "Fake", pluginVersion: "1.0.0", defaultCommand: "fake", executableEnvKey: "WORKSHOP_FAKE_PATH", runtimeVersion: { min: "1.0.0" }, description: "test", backendOptions: {}, validateConfig: () => undefined,
    capabilities: { continuation: true, steering: false, interruption: false, approvals: false, userInput: false, tokenUsage: false, structuredFileEvents: false },
    health: async () => ({ id: "fake", ok: true, pluginVersion: "1.0.0", runtimeVersion: "1.0.0", capabilities: { ok: true, models: [], reasoningEfforts: [] } }),
    createSession: () => ({ initialize: async () => { throw new Error("spawn C:/private/fake.cmd EACCES"); }, start: async () => { throw new Error("unused"); }, continue: async () => { throw new Error("unused"); }, steer: async () => undefined, interrupt: async () => undefined, close: async () => undefined })
  };
  const analyze = createRequirementAnalyzer(new AgentRegistry([plugin]));
  const input: Parameters<RequirementAnalyzer>[0] = { commission: { id: "commission" } as Parameters<RequirementAnalyzer>[0]["commission"], projectRoot: process.cwd(), agentConfig: { prompt: "", agentBackend: "fake" }, messages: [], attachments: [], activeRequirement: null };

  await assert.rejects(analyze(input), (error: unknown) => error instanceof Error && !/private/i.test(error.message) && (error as { statusCode?: number }).statusCode === 502);
});

test("does not retry a failed Requirement Agent health check", async () => {
  let healthChecks = 0;
  const plugin: AgentPlugin = {
    id: "fake", displayName: "Fake", pluginVersion: "1.0.0", defaultCommand: "fake", executableEnvKey: "WORKSHOP_FAKE_PATH", runtimeVersion: { min: "1.0.0" }, description: "test", backendOptions: {}, validateConfig: () => undefined,
    capabilities: { continuation: true, steering: false, interruption: false, approvals: false, userInput: false, tokenUsage: false, structuredFileEvents: false },
    health: async () => { healthChecks++; return { id: "fake", ok: false, pluginVersion: "1.0.0", capabilities: { ok: false, models: [], reasoningEfforts: [] }, error: "unavailable" }; },
    createSession: () => { throw new Error("health failure must not create a session"); }
  };
  const analyze = createRequirementAnalyzer(new AgentRegistry([plugin]));
  const input: Parameters<RequirementAnalyzer>[0] = { commission: { id: "health-failure" } as Parameters<RequirementAnalyzer>[0]["commission"], projectRoot: process.cwd(), agentConfig: { prompt: "", agentBackend: "fake" }, messages: [], attachments: [], activeRequirement: null };

  await assert.rejects(analyze(input), (error: unknown) => error instanceof Error && (error as { statusCode?: number }).statusCode === 503);
  assert.equal(healthChecks, 1);
});

test("accepts standardized text from a non-Codex Requirement Agent", async () => {
  const plugin: AgentPlugin = {
    id: "fake-standard", displayName: "Fake", pluginVersion: "1.0.0", defaultCommand: "fake", executableEnvKey: "WORKSHOP_FAKE_STANDARD_PATH", runtimeVersion: { min: "1.0.0" }, description: "test", backendOptions: {}, validateConfig: () => undefined,
    capabilities: { continuation: true, steering: false, interruption: false, approvals: false, userInput: false, tokenUsage: true, structuredFileEvents: false },
    health: async () => ({ id: "fake-standard", ok: true, pluginVersion: "1.0.0", runtimeVersion: "1.0.0", capabilities: { ok: true, models: [], reasoningEfforts: [] } }),
    createSession: (options) => {
      assert.deepEqual(options.backendOptions, { transport: "fake" });
      assert.equal(options.sandboxMode, "read-only");
      assert.equal(options.networkAccess, false);
      return ({
      initialize: async () => undefined, start: async () => ({ completed: Promise.resolve({ status: "succeeded", event: { type: "turn.completed", summary: "done", sourceType: "fake/done", payload: {}, text: "{\"question\":\"Which target?\"}" } }) }),
      continue: async () => { throw new Error("unused"); }, steer: async () => undefined, interrupt: async () => undefined, close: async () => undefined
      });
    }
  };
  const analyze = createRequirementAnalyzer(new AgentRegistry([plugin]));
  const input: Parameters<RequirementAnalyzer>[0] = { commission: { id: "standard-text" } as Parameters<RequirementAnalyzer>[0]["commission"], projectRoot: process.cwd(), agentConfig: { prompt: "", agentBackend: "fake-standard", backendOptions: { transport: "fake" } }, messages: [], attachments: [], activeRequirement: null };

  assert.deepEqual(await analyze(input), { question: "Which target?", tokenUsage: { input: 0, output: 0, cached: 0 } });
});

test("uses the final Agent message instead of process narration", async () => {
  const plugin: AgentPlugin = {
    id: "fake-messages", displayName: "Fake", pluginVersion: "1.0.0", defaultCommand: "fake", executableEnvKey: "WORKSHOP_FAKE_MESSAGES_PATH", runtimeVersion: { min: "1.0.0" }, description: "test", backendOptions: {}, validateConfig: () => undefined,
    capabilities: { continuation: false, steering: false, interruption: false, approvals: false, userInput: false, tokenUsage: false, structuredFileEvents: false },
    health: async () => ({ id: "fake-messages", ok: true, pluginVersion: "1.0.0", runtimeVersion: "1.0.0", capabilities: { ok: true, models: [], reasoningEfforts: [] } }),
    createSession: (options) => ({ initialize: async () => undefined, start: async () => {
      options.onEvent?.({ type: "agent.message.delta", summary: "message", sourceType: "fake/delta", payload: {}, text: "I will inspect the project first." });
      options.onEvent?.({ type: "agent_message.completed", summary: "message", sourceType: "fake/completed", payload: {}, text: "I will inspect the project first." });
      options.onEvent?.({ type: "agent.message.delta", summary: "message", sourceType: "fake/delta", payload: {}, text: '{"question":"Which target?"}' });
      options.onEvent?.({ type: "agent_message.completed", summary: "message", sourceType: "fake/completed", payload: {}, text: '{"question":"Which target?"}' });
      return { completed: Promise.resolve({ status: "succeeded", event: { type: "turn.completed", summary: "done", sourceType: "fake/done", payload: {} } }) };
    }, continue: async () => { throw new Error("unused"); }, steer: async () => undefined, interrupt: async () => undefined, close: async () => undefined })
  };
  const analyze = createRequirementAnalyzer(new AgentRegistry([plugin]));
  const input: Parameters<RequirementAnalyzer>[0] = { commission: { id: "final-message" } as Parameters<RequirementAnalyzer>[0]["commission"], projectRoot: process.cwd(), agentConfig: { prompt: "", agentBackend: "fake-messages" }, messages: [], attachments: [], activeRequirement: null };

  assert.deepEqual(await analyze(input), { question: "Which target?", tokenUsage: { input: 0, output: 0, cached: 0 } });
});

test("starts a new Session for each turn when continuation is unsupported", async () => {
  let sessions = 0;
  let starts = 0;
  let continues = 0;
  const prompts: string[] = [];
  const plugin: AgentPlugin = {
    id: "fake-stateless", displayName: "Fake", pluginVersion: "1.0.0", defaultCommand: "fake", executableEnvKey: "WORKSHOP_FAKE_STATELESS_PATH", runtimeVersion: { min: "1.0.0" }, description: "test", backendOptions: {}, validateConfig: () => undefined,
    capabilities: { continuation: false, steering: false, interruption: false, approvals: false, userInput: false, tokenUsage: false, structuredFileEvents: false },
    health: async () => ({ id: "fake-stateless", ok: true, pluginVersion: "1.0.0", runtimeVersion: "1.0.0", capabilities: { ok: true, models: [], reasoningEfforts: [] } }),
    createSession: () => { sessions++; return { initialize: async () => undefined, start: async ({ prompt }) => { starts++; prompts.push(prompt); return { completed: Promise.resolve({ status: "succeeded", event: { type: "turn.completed", summary: "done", sourceType: "fake/done", payload: {}, text: '{"question":"Next?"}' } }) }; }, continue: async () => { continues++; throw new Error("unused"); }, steer: async () => undefined, interrupt: async () => undefined, close: async () => undefined }; }
  };
  const analyze = createRequirementAnalyzer(new AgentRegistry([plugin]));
  const input: Parameters<RequirementAnalyzer>[0] = { commission: { id: "stateless" } as Parameters<RequirementAnalyzer>[0]["commission"], projectRoot: process.cwd(), agentConfig: { prompt: "", agentBackend: "fake-stateless" }, messages: [], attachments: [], activeRequirement: null };

  await analyze(input);
  await analyze({ ...input, messages: [{ role: "human", content: "second answer" }] });
  assert.deepEqual({ sessions, starts, continues }, { sessions: 2, starts: 2, continues: 0 });
  assert.match(prompts[1]!, /second answer/);
});

test("clears the previous idle timer before continuing a cached Session", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let completeContinue!: (value: { status: "succeeded"; event: { type: string; summary: string; sourceType: string; payload: {}; text: string } }) => void;
  let closes = 0;
  const plugin: AgentPlugin = {
    id: "fake-timer", displayName: "Fake", pluginVersion: "1.0.0", defaultCommand: "fake", executableEnvKey: "WORKSHOP_FAKE_TIMER_PATH", runtimeVersion: { min: "1.0.0" }, description: "test", backendOptions: {}, validateConfig: () => undefined,
    capabilities: { continuation: true, steering: false, interruption: false, approvals: false, userInput: false, tokenUsage: false, structuredFileEvents: false },
    health: async () => ({ id: "fake-timer", ok: true, pluginVersion: "1.0.0", runtimeVersion: "1.0.0", capabilities: { ok: true, models: [], reasoningEfforts: [] } }),
    createSession: () => ({ initialize: async () => undefined, start: async () => ({ completed: Promise.resolve({ status: "succeeded", event: { type: "turn.completed", summary: "done", sourceType: "fake/done", payload: {}, text: '{"question":"First?"}' } }) }), continue: async () => ({ completed: new Promise((resolve) => { completeContinue = resolve; }) }), steer: async () => undefined, interrupt: async () => undefined, close: async () => { closes++; } })
  };
  const analyze = createRequirementAnalyzer(new AgentRegistry([plugin]));
  const input: Parameters<RequirementAnalyzer>[0] = { commission: { id: "idle-timer" } as Parameters<RequirementAnalyzer>[0]["commission"], projectRoot: process.cwd(), agentConfig: { prompt: "", agentBackend: "fake-timer" }, messages: [], attachments: [], activeRequirement: null };
  await analyze(input);

  const continuing = analyze({ ...input, messages: [{ role: "human", content: "continue" }] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  context.mock.timers.tick(60 * 60 * 1_000);
  assert.equal(closes, 0);
  completeContinue({ status: "succeeded", event: { type: "turn.completed", summary: "done", sourceType: "fake/done", payload: {}, text: '{"question":"Second?"}' } });
  await continuing;
  await analyze.close();
  assert.equal(closes, 1);
});

test("closes every cached Requirement Session even when one close fails", async () => {
  const closed: number[] = [];
  let created = 0;
  const plugin: AgentPlugin = {
    id: "fake-close", displayName: "Fake", pluginVersion: "1.0.0", defaultCommand: "fake", executableEnvKey: "WORKSHOP_FAKE_CLOSE_PATH", runtimeVersion: { min: "1.0.0" }, description: "test", backendOptions: {}, validateConfig: () => undefined,
    capabilities: { continuation: true, steering: false, interruption: false, approvals: false, userInput: false, tokenUsage: false, structuredFileEvents: false },
    health: async () => ({ id: "fake-close", ok: true, pluginVersion: "1.0.0", runtimeVersion: "1.0.0", capabilities: { ok: true, models: [], reasoningEfforts: [] } }),
    createSession: () => { const id = ++created; return { initialize: async () => undefined, start: async () => ({ completed: Promise.resolve({ status: "succeeded", event: { type: "turn.completed", summary: "done", sourceType: "fake/done", payload: {}, text: '{"question":"Next?"}' } }) }), continue: async () => { throw new Error("unused"); }, steer: async () => undefined, interrupt: async () => undefined, close: async () => { closed.push(id); if (id === 1) throw new Error("close failed"); } }; }
  };
  const analyze = createRequirementAnalyzer(new AgentRegistry([plugin]));
  const input = (id: string): Parameters<RequirementAnalyzer>[0] => ({ commission: { id } as Parameters<RequirementAnalyzer>[0]["commission"], projectRoot: process.cwd(), agentConfig: { prompt: "", agentBackend: "fake-close" }, messages: [], attachments: [], activeRequirement: null });
  await analyze(input("close-one"));
  await analyze(input("close-two"));

  await analyze.close();

  assert.deepEqual(closed.sort(), [1, 2]);
});

test("does not retry a failed Requirement Agent completion", async () => {
  let sessions = 0;
  let starts = 0;
  const plugin: AgentPlugin = {
    id: "fake-failed", displayName: "Fake", pluginVersion: "1.0.0", defaultCommand: "fake", executableEnvKey: "WORKSHOP_FAKE_FAILED_PATH", runtimeVersion: { min: "1.0.0" }, description: "test", backendOptions: {}, validateConfig: () => undefined,
    capabilities: { continuation: true, steering: false, interruption: false, approvals: false, userInput: false, tokenUsage: false, structuredFileEvents: false },
    health: async () => ({ id: "fake-failed", ok: true, pluginVersion: "1.0.0", runtimeVersion: "1.0.0", capabilities: { ok: true, models: [], reasoningEfforts: [] } }),
    createSession: () => { sessions++; return { initialize: async () => undefined, start: async () => { starts++; return { completed: Promise.resolve({ status: "failed", event: { type: "turn.failed", summary: "failed", sourceType: "fake/done", payload: {}, text: '{"question":"Which target?"}' } }) }; }, continue: async () => { throw new Error("unused"); }, steer: async () => undefined, interrupt: async () => undefined, close: async () => undefined }; }
  };
  const input: Parameters<RequirementAnalyzer>[0] = { commission: { id: "failed-output" } as Parameters<RequirementAnalyzer>[0]["commission"], projectRoot: process.cwd(), agentConfig: { prompt: "", agentBackend: "fake-failed" }, messages: [], attachments: [], activeRequirement: null };

  await assert.rejects(createRequirementAnalyzer(new AgentRegistry([plugin]))(input), /Requirement Agent failed/);
  assert.equal(sessions, 1);
  assert.equal(starts, 1);
});
