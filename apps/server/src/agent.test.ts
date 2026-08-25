import assert from "node:assert/strict";
import test from "node:test";
import { agentErrorBody, AgentError, AgentRegistry, capabilityError, normalizeSemver, safeAgentError, semverInRange, type AgentCompletion, type AgentPlugin, type AgentSession } from "./agent.ts";

function fakePlugin(): AgentPlugin {
  const session: AgentSession = {
    initialize: async () => undefined,
    start: async () => ({ completed: Promise.resolve({ status: "succeeded", event: { type: "turn.completed", summary: "done", sourceType: "fake/completed", payload: {} } }) }),
    continue: async () => ({ completed: Promise.resolve({ status: "succeeded", event: { type: "turn.completed", summary: "done", sourceType: "fake/completed", payload: {} } }) }),
    steer: async () => undefined, interrupt: async () => undefined, close: async () => undefined
  };
  return {
    id: "codex", displayName: "Fake", pluginVersion: "1.0.0", defaultCommand: "fake", executableEnvKey: "WORKSHOP_FAKE_PATH",
    runtimeVersion: { min: "1.0.0" }, description: "test", backendOptions: {},
    validateConfig: () => undefined,
    capabilities: { continuation: true, steering: true, interruption: false, approvals: false, userInput: false, tokenUsage: false, structuredFileEvents: false },
    health: async () => ({ id: "codex", ok: true, pluginVersion: "1.0.0", runtimeVersion: "1.2.3", capabilities: { ok: true, models: [], reasoningEfforts: [] } }),
    createSession: () => session
  };
}

test("registers a static backend and coalesces concurrent health checks", async () => {
  const plugin = fakePlugin();
  let checks = 0;
  plugin.health = async () => { checks++; await Promise.resolve(); return { id: "codex", ok: true, pluginVersion: "1.0.0", runtimeVersion: "1.2.3", capabilities: { ok: true, models: [], reasoningEfforts: [] } }; };
  const registry = new AgentRegistry([plugin]);
  const [left, right] = await Promise.all([registry.health("codex"), registry.health("codex")]);
  assert.equal(checks, 1);
  assert.equal(left, right);
  assert.equal(typeof registry.createSession("codex", {}).start, "function");
  assert.throws(() => registry.plugin("missing"), (error: unknown) => error instanceof AgentError && error.statusCode === 503);
});

test("rejects invalid plugin health timeouts", () => {
  for (const timeout of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    const plugin = fakePlugin();
    plugin.healthTimeoutMs = timeout;
    assert.throws(() => new AgentRegistry([plugin]), /health timeout must be a positive integer/);
  }
});

test("normalizes and compares SemVer and exposes stable capability errors", () => {
  assert.equal(normalizeSemver("codex-cli 0.147.1"), "0.147.1");
  assert.equal(normalizeSemver("codex-cli 0.147.0+build.1"), "0.147.0+build.1");
  assert.equal(semverInRange("0.147.0+build.1", "0.147.0", "0.147.0+other"), true);
  assert.equal(semverInRange("0.147.1", "0.147.0"), true);
  assert.equal(semverInRange("0.147.0-beta.1", "0.147.0"), false);
  assert.equal(normalizeSemver("01.0.0"), undefined);
  assert.equal(normalizeSemver("1.0.0-01"), undefined);
  assert.equal(normalizeSemver("1.0.0-"), undefined);
  assert.equal(semverInRange("1.0.0-alpha.10", "1.0.0-alpha.2"), true);
  assert.equal(semverInRange("9007199254740993.0.0", "9007199254740992.0.0"), true);
  assert.equal(semverInRange("1.0.0-9007199254740993", "1.0.0-9007199254740992"), true);
  assert.equal(capabilityError().code, "agent_capability_unsupported");
});

test("validates explicit empty model settings before starting", async () => {
  const plugin = fakePlugin();
  plugin.validateConfig = ({ model, reasoningEffort }) => {
    if (model === "" || reasoningEffort === "") throw new TypeError("empty setting");
  };
  const session = new AgentRegistry([plugin]).createSession("codex", {});
  await assert.rejects(session.start({ cwd: process.cwd(), prompt: "work", model: "" }), /empty setting/);
  await assert.rejects(session.start({ cwd: process.cwd(), prompt: "work", reasoningEffort: "" }), /empty setting/);
});

test("enforces busy and capability semantics around a plugin session", async () => {
  const plugin = fakePlugin();
  let finish!: () => void;
  plugin.createSession = () => ({
    initialize: async () => undefined,
    start: async () => ({ completed: new Promise((resolve) => { finish = () => resolve({ status: "interrupted", event: { type: "turn.interrupted", summary: "stopped", sourceType: "fake/completed", payload: {} } }); }) }),
    continue: async () => { throw new Error("unused"); }, steer: async () => undefined, interrupt: async () => undefined, close: async () => undefined
  });
  const session = new AgentRegistry([plugin]).createSession("codex", {});
  const turn = await session.start({ cwd: process.cwd(), prompt: "work" });
  await assert.rejects(session.start({ cwd: process.cwd(), prompt: "again" }), (error: unknown) => error instanceof AgentError && error.code === "agent_session_busy");
  await assert.rejects(session.interrupt(), (error: unknown) => error instanceof AgentError && error.code === "agent_capability_unsupported");
  finish();
  assert.equal((await turn.completed).status, "interrupted");
});

test("normalizes plugin health exceptions and timeouts", async () => {
  const failed = fakePlugin();
  failed.health = async () => { throw new Error("C:\\secret\\codex.cmd failed"); };
  assert.deepEqual(await new AgentRegistry([failed]).health("codex"), {
    id: "codex", ok: false, pluginVersion: "1.0.0", capabilities: { ok: false, models: [], reasoningEfforts: [] }, error: "Agent backend health check failed: [REDACTED] failed"
  });

  const timedOut = fakePlugin();
  timedOut.healthTimeoutMs = 5;
  timedOut.health = () => new Promise(() => undefined);
  const timeout = await new AgentRegistry([timedOut]).health("codex");
  assert.equal(timeout.ok, false);
  assert.equal(timeout.error, "Agent backend health check timed out after 5 ms");
});

test("sanitizes plugin health errors and unknown-backend failures without throwing", async () => {
  const plugin = fakePlugin();
  const previous = process.env.WORKSHOP_FAKE_PATH;
  process.env.WORKSHOP_FAKE_PATH = "  /opt/private/fake  ";
  plugin.health = async () => ({ id: "codex", ok: false, pluginVersion: "1.0.0", capabilities: { ok: false, models: [], reasoningEfforts: [], error: "failed to open /opt/private/fake" }, error: "spawn /opt/private/fake EACCES" });
  try {
    const registry = new AgentRegistry([plugin]);
    const health = await registry.health("codex");
    assert.doesNotMatch(String(health.error) + " " + String(health.capabilities.error), /private/i);
    assert.doesNotMatch(registry.safeError("codex", new Error("failed to open /opt/private/fake")), /private/i);
    assert.doesNotThrow(() => registry.safeError("removed", new Error("spawn C:/private/removed.cmd ENOENT")));
    assert.doesNotMatch(registry.safeError("removed", new Error("spawn C:/private/removed.cmd ENOENT")), /private/i);
  } finally { if (previous === undefined) delete process.env.WORKSHOP_FAKE_PATH; else process.env.WORKSHOP_FAKE_PATH = previous; }
});

test("enforces each plugin runtime version range", async () => {
  const failures = [
    [undefined, "Agent runtime version is missing; requires >= 2.0.0 and <= 3.0.0"],
    ["invalid", "Agent runtime version could not be parsed; requires >= 2.0.0 and <= 3.0.0"],
    ["1.9.9", "Agent runtime 1.9.9 is incompatible; requires >= 2.0.0 and <= 3.0.0"],
    ["3.0.1", "Agent runtime 3.0.1 is incompatible; requires >= 2.0.0 and <= 3.0.0"]
  ] as const;
  for (const [runtimeVersion, error] of failures) {
    const plugin = fakePlugin();
    plugin.runtimeVersion = { min: "2.0.0", max: "3.0.0" };
    plugin.health = async () => ({ id: "codex", ok: true, pluginVersion: "1.0.0", ...(runtimeVersion ? { runtimeVersion } : {}), capabilities: { ok: true, models: [], reasoningEfforts: [] } });
    const health = await new AgentRegistry([plugin]).health("codex");
    assert.equal(health.ok, false);
    assert.equal(health.error, error);
  }
  const compatible = fakePlugin();
  compatible.runtimeVersion = { min: "2.0.0", max: "3.0.0" };
  compatible.health = async () => ({ id: "codex", ok: true, pluginVersion: "1.0.0", runtimeVersion: "runtime v2.1.0", capabilities: { ok: true, models: [], reasoningEfforts: [] } });
  assert.equal((await new AgentRegistry([compatible]).health("codex")).runtimeVersion, "2.1.0");
});

test("covers the Fake Agent completion contract, abnormal exits, and multiple turns", async () => {
  const outcomes: AgentCompletion["status"][] = ["succeeded", "failed", "cancelled", "interrupted"];
  let turn = 0;
  const plugin = fakePlugin();
  plugin.createSession = () => ({
    initialize: async () => undefined,
    start: async () => completion(outcomes[turn++]!),
    continue: async () => completion(outcomes[turn++]!),
    steer: async () => undefined, interrupt: async () => undefined, close: async () => undefined
  });
  const session = new AgentRegistry([plugin]).createSession("codex", {});
  await session.initialize();
  assert.equal((await (await session.start({ cwd: process.cwd(), prompt: "first" })).completed).status, "succeeded");
  assert.equal((await (await session.continue({ cwd: process.cwd(), prompt: "second" })).completed).status, "failed");
  assert.equal((await (await session.continue({ cwd: process.cwd(), prompt: "third" })).completed).status, "cancelled");
  assert.equal((await (await session.continue({ cwd: process.cwd(), prompt: "fourth" })).completed).status, "interrupted");

  plugin.createSession = () => ({
    initialize: async () => { throw new Error("process exited"); },
    start: async () => { throw new Error("process exited"); },
    continue: async () => { throw new Error("process exited"); },
    steer: async () => undefined, interrupt: async () => undefined, close: async () => undefined
  });
  const crashed = new AgentRegistry([plugin]).createSession("codex", {});
  await assert.rejects(crashed.initialize(), /process exited/);
  await assert.rejects(crashed.start({ cwd: process.cwd(), prompt: "crash" }), /process exited/);
});

test("rejects every unsupported interactive capability", async () => {
  const plugin = fakePlugin();
  plugin.capabilities = { continuation: false, steering: false, interruption: false, approvals: false, userInput: false, tokenUsage: false, structuredFileEvents: false };
  const session = new AgentRegistry([plugin]).createSession("codex", {});
  const options = { cwd: process.cwd(), prompt: "work" };
  for (const action of [() => session.continue(options), () => session.steer("help"), () => session.interrupt()]) {
    await assert.rejects(action(), (error: unknown) => error instanceof AgentError && error.code === "agent_capability_unsupported");
  }
});

test("propagates plugin interrupt rejection and preserves safe Agent error codes", async () => {
  const plugin = fakePlugin();
  plugin.capabilities = { ...plugin.capabilities, interruption: true };
  plugin.createSession = () => ({
    initialize: async () => undefined, start: async () => completion("succeeded"), continue: async () => completion("succeeded"),
    steer: async () => undefined, interrupt: async () => { throw capabilityError(); }, close: async () => undefined
  });
  const registry = new AgentRegistry([plugin]);
  await assert.rejects(registry.createSession("codex", {}).interrupt(), (error: unknown) => error instanceof AgentError && error.code === "agent_capability_unsupported");
  const safeAgent = safeAgentError(registry, "codex", capabilityError());
  const safeSystem = safeAgentError(registry, "codex", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  assert.deepEqual(agentErrorBody(safeAgent, safeAgent.message), { error: "当前 Agent 后端不支持该操作", code: "agent_capability_unsupported" });
  assert.equal("code" in agentErrorBody(safeSystem, safeSystem.message), false);
});

test("publishes executable configuration status without exposing its value", () => {
  const key = "WORKSHOP_TEST_INVALID_EXECUTABLE";
  const plugin = { ...fakePlugin(), executableEnvKey: key };
  delete process.env[key];
  assert.deepEqual(new AgentRegistry([plugin]).backends()[0]?.executable, { defaultCommand: "fake", environmentKey: key, configured: false, valid: true });
  process.env[key] = "relative/private/path";
  try {
    const info = new AgentRegistry([plugin]).backends()[0]!;
    assert.deepEqual(info.executable, { defaultCommand: "fake", environmentKey: key, configured: true, valid: false });
    assert.doesNotMatch(JSON.stringify(info), /relative\/private/);
  } finally { delete process.env[key]; }
});

test("uses each plugin executable value as an explicit redaction secret", () => {
  const previous = process.env.WORKSHOP_FAKE_PATH;
  process.env.WORKSHOP_FAKE_PATH = "  /opt/private/fake  ";
  try { assert.deepEqual(new AgentRegistry([fakePlugin()]).explicitSecrets("codex"), ["/opt/private/fake"]); }
  finally { if (previous === undefined) delete process.env.WORKSHOP_FAKE_PATH; else process.env.WORKSHOP_FAKE_PATH = previous; }
});

function completion(status: AgentCompletion["status"]) {
  return { completed: Promise.resolve({ status, event: { type: `turn.${status}`, summary: status, sourceType: "fake/completed", payload: {} } }) };
}
