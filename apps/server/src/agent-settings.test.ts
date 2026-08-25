import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { AgentRegistry, type AgentPlugin } from "./agent.ts";
import { refreshActiveAgentHealth, refreshAgentHealth, registerAgentSettingsRoutes, resolvedRoleConfig } from "./agent-settings.ts";
import { checkCodexHealth, createCodexPlugin } from "./codex.ts";
import { openWorkshopDatabase } from "./database.ts";

const models = [{ id: "test-model", displayName: "Test Model", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] }];
const plugin: AgentPlugin = { id: "codex", displayName: "Codex", pluginVersion: "0.3.12", defaultCommand: "codex", executableEnvKey: "WORKSHOP_CODEX_PATH", runtimeVersion: { min: "0.147.0" }, description: "test", backendOptions: {}, capabilities: { continuation: true, steering: true, interruption: true, approvals: true, userInput: true, tokenUsage: true, structuredFileEvents: true }, validateConfig: ({ backendOptions }) => {
  const customArgs = backendOptions?.customArgs;
  if (Array.isArray(customArgs) && (customArgs.length > 32 || customArgs.some((argument) => typeof argument !== "string" || !argument || argument.length > 256))) throw new TypeError("invalid customArgs");
  if (Array.isArray(customArgs) && customArgs.includes("--leak")) throw new TypeError("spawn /opt/private/codex EACCES");
  if (Array.isArray(customArgs) && customArgs.some((argument) => typeof argument === "string" && argument.includes("danger-full-access"))) throw new TypeError("unsupported custom argument");
  if (backendOptions && Object.keys(backendOptions).some((key) => key !== "customArgs")) throw new TypeError("unsupported backend option");
}, health: async () => ({ id: "codex", ok: true, pluginVersion: "0.3.12", runtimeVersion: "0.147.0", capabilities: { ok: true, models, reasoningEfforts: ["low", "medium", "high"] } }), createSession: () => { throw new Error("unused"); } };

test("validates and stores global Run Agent settings", async () => {
  const home = await mkdtemp(join(tmpdir(), "workshop-agent-settings-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  try {
    registerAgentSettingsRoutes(server, database, new AgentRegistry([plugin]));
    const backends = (await server.inject({ method: "GET", url: "/api/agents/backends" })).json();
    assert.equal(backends[0].runtimeVersion.min, "0.147.0");
    assert.equal(backends[0].capabilities.approvals, true);
    assert.equal(backends[0].executable.environmentKey, "WORKSHOP_CODEX_PATH");
    assert.equal(typeof backends[0].executable.configured, "boolean");
    assert.equal(typeof backends[0].executable.valid, "boolean");
    const initial = (await server.inject({ method: "GET", url: "/api/agents/presets" })).json();
    assert.equal(initial.health.capabilities.models[0].id, "test-model");
    const defaultPresetId = initial.presets[0].id as string;
    assert.equal((await server.inject({ method: "PUT", url: "/api/agents/presets/" + defaultPresetId, payload: { name: "已编辑默认预设" } })).statusCode, 200);
    const tooManyPresetArgs = Array.from({ length: 33 }, (_, index) => String(index));
    assert.equal((await server.inject({ method: "POST", url: "/api/agents/presets", payload: { ...initial.presets[0], name: "参数过多", backendOptions: { customArgs: tooManyPresetArgs } } })).statusCode, 400);
    assert.equal((await server.inject({ method: "PUT", url: "/api/agents/presets/" + defaultPresetId, payload: { backendOptions: { customArgs: tooManyPresetArgs } } })).statusCode, 400);
    assert.deepEqual((await server.inject({ method: "GET", url: "/api/agents/presets" })).json().presets[0].backendOptions, { customArgs: [] });
    assert.equal((await server.inject({ method: "DELETE", url: "/api/agents/presets/" + defaultPresetId })).statusCode, 400);
    assert.deepEqual(initial.managed, { sandboxMode: "workspace-write", approvalPolicy: "on-request", networkAccess: true });
    assert.deepEqual(initial.configs.map((config: { role: string }) => config.role), ["supervisor", "developer", "reviewer"]);

    assert.equal((await server.inject({ method: "PUT", url: "/api/agents/roles/developer", payload: { model: "missing", reasoningEffort: "medium", backendOptions: { customArgs: [] } } })).statusCode, 200);
    assert.equal((await server.inject({ method: "PUT", url: "/api/agents/roles/developer", payload: { model: "  custom-model  ", reasoningEffort: " medium ", backendOptions: { customArgs: [] } } })).json().model, "custom-model");
    assert.equal((await server.inject({ method: "PUT", url: "/api/agents/roles/developer", payload: { model: "test-model", reasoningEffort: "high", backendOptions: { customArgs: ["-c", "sandbox_mode=\"danger-full-access\""] } } })).statusCode, 400);
    const redactedRoleError = await server.inject({ method: "PUT", url: "/api/agents/roles/developer", payload: { model: "test-model", reasoningEffort: "high", backendOptions: { customArgs: ["--leak"] } } });
    assert.equal(redactedRoleError.statusCode, 400);
    assert.doesNotMatch(redactedRoleError.body, /private/i);
    const beforeInvalidRole = (await server.inject({ method: "GET", url: "/api/agents/presets" })).json().presets[0].roleConfigs.developer;
    const tooManyArgs = await server.inject({ method: "PUT", url: "/api/agents/roles/developer", payload: { model: "saved", reasoningEffort: "high", backendOptions: { customArgs: Array.from({ length: 33 }, (_, index) => String(index)) } } });
    assert.equal(tooManyArgs.statusCode, 400);
    assert.deepEqual((await server.inject({ method: "GET", url: "/api/agents/presets" })).json().presets[0].roleConfigs.developer, beforeInvalidRole);
    database.exec("CREATE TEMP TRIGGER reject_role_config_update BEFORE UPDATE ON role_configs BEGIN SELECT RAISE(ABORT, 'forced role update failure'); END");
    const rejectedWrite = await server.inject({ method: "PUT", url: "/api/agents/roles/developer", payload: { model: "not-saved", reasoningEffort: "high", backendOptions: { customArgs: [] } } });
    assert.equal(rejectedWrite.statusCode, 500);
    assert.deepEqual((await server.inject({ method: "GET", url: "/api/agents/presets" })).json().presets[0].roleConfigs.developer, beforeInvalidRole);
    database.exec("DROP TRIGGER reject_role_config_update");
    assert.equal((await server.inject({ method: "PUT", url: "/api/agents/runtime", payload: { sandboxMode: "host", approvalPolicy: "never", networkAccess: true } })).statusCode, 400);
    const runtime = await server.inject({ method: "PUT", url: "/api/agents/runtime", payload: { sandboxMode: "read-only", approvalPolicy: "never", networkAccess: false } });
    assert.equal(runtime.statusCode, 200);
    assert.deepEqual(runtime.json(), { sandboxMode: "read-only", approvalPolicy: "never", networkAccess: false });

    const saved = await server.inject({ method: "PUT", url: "/api/agents/roles/supervisor", payload: { model: "test-model", reasoningEffort: "high", backendOptions: { customArgs: ["--enable", "example"] } } });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(resolvedRoleConfig(database, "project", "supervisor"), { prompt: "", model: "test-model", reasoningEffort: "high", sandboxMode: "read-only", approvalPolicy: "never", networkAccess: false, agentBackend: "codex", pluginVersion: "0.3.12", runtimeVersion: "0.147.0", backendOptions: { customArgs: ["--enable", "example"] } });

    const created = await server.inject({ method: "POST", url: "/api/agents/presets", payload: { name: "只读审查", agentBackend: "codex", model: "test-model", reasoningEffort: "low", backendOptions: { customArgs: [] }, roleConfigs: { supervisor: { model: "test-model", reasoningEffort: "low", backendOptions: { customArgs: [] } }, developer: { model: "test-model", reasoningEffort: "high", backendOptions: { customArgs: ["--developer"] } }, reviewer: { model: null, reasoningEffort: null, backendOptions: { customArgs: [] } } }, sandboxMode: "read-only", approvalPolicy: "on-request", networkAccess: false } });
    assert.equal(created.statusCode, 201);
    assert.equal((await server.inject({ method: "POST", url: "/api/agents/presets", payload: { name: "非法参数", agentBackend: "codex", model: null, reasoningEffort: null, backendOptions: { secretPath: "C:/private" }, roleConfigs: initial.presets[0].roleConfigs, sandboxMode: "read-only", approvalPolicy: "on-request", networkAccess: false } })).statusCode, 400);
    const redactedPresetError = await server.inject({ method: "POST", url: "/api/agents/presets", payload: { name: "脱敏", agentBackend: "codex", model: null, reasoningEffort: null, backendOptions: { customArgs: [] }, roleConfigs: { ...initial.presets[0].roleConfigs, supervisor: { model: null, reasoningEffort: null, backendOptions: { customArgs: ["--leak"] } } }, sandboxMode: "read-only", approvalPolicy: "on-request", networkAccess: false } });
    assert.equal(redactedPresetError.statusCode, 400);
    assert.doesNotMatch(redactedPresetError.body, /private/i);
    const presetId = created.json().id as string;
    const partialRoleUpdate = await server.inject({ method: "PUT", url: "/api/agents/presets/" + presetId, payload: { roleConfigs: { developer: { model: "test-model", reasoningEffort: "low", backendOptions: { customArgs: ["--updated"] } } } } });
    assert.equal(partialRoleUpdate.statusCode, 200);
    assert.deepEqual(partialRoleUpdate.json().roleConfigs.reviewer, { model: null, reasoningEffort: null, backendOptions: { customArgs: [] } });
    assert.equal((await server.inject({ method: "PUT", url: "/api/agents/active", payload: { presetId } })).statusCode, 200);
    assert.deepEqual(resolvedRoleConfig(database, "project", "developer"), { prompt: "", model: "test-model", reasoningEffort: "low", sandboxMode: "read-only", approvalPolicy: "on-request", networkAccess: false, agentBackend: "codex", pluginVersion: "0.3.12", runtimeVersion: "0.147.0", backendOptions: { customArgs: ["--updated"] } });
    assert.equal(resolvedRoleConfig(database, "project", "reviewer").model, null);
    assert.equal((await server.inject({ method: "DELETE", url: "/api/agents/presets/" + presetId })).statusCode, 200);
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("health metadata cannot overwrite a concurrent role save", async () => {
  const home = await mkdtemp(join(tmpdir(), "workshop-agent-settings-race-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  let releaseHealth!: () => void;
  let healthStarted!: () => void;
  const gate = new Promise<void>((resolve) => { releaseHealth = resolve; });
  const started = new Promise<void>((resolve) => { healthStarted = resolve; });
  const delayed = { ...plugin, health: async () => {
    healthStarted();
    await gate;
    return plugin.health();
  } };
  try {
    registerAgentSettingsRoutes(server, database, new AgentRegistry([delayed]));
    const save = server.inject({ method: "PUT", url: "/api/agents/roles/developer", payload: { model: "saved-model", reasoningEffort: null, backendOptions: { customArgs: [] } } });
    await started;
    const read = server.inject({ method: "GET", url: "/api/agents/presets" });
    releaseHealth();
    assert.equal((await save).statusCode, 200);
    assert.equal((await read).statusCode, 200);
    assert.equal((await server.inject({ method: "GET", url: "/api/agents/presets" })).json().presets[0].roleConfigs.developer.model, "saved-model");
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("refreshes runtime metadata before a Run snapshot is resolved", async () => {
  const home = await mkdtemp(join(tmpdir(), "workshop-agent-preflight-"));
  const database = await openWorkshopDatabase(home);
  try {
    const current = { ...plugin, health: async () => ({ id: "codex" as const, ok: true, pluginVersion: "0.3.13", runtimeVersion: "0.148.1", capabilities: { ok: true, models, reasoningEfforts: ["low"] } }) };
    await refreshActiveAgentHealth(database, new AgentRegistry([current]));
    const snapshot = resolvedRoleConfig(database, "project", "developer");
    assert.equal(snapshot.agentBackend, "codex");
    assert.equal(snapshot.pluginVersion, "0.3.13");
    assert.equal(snapshot.runtimeVersion, "0.148.1");
    assert.equal(snapshot.model, null);
    assert.equal(snapshot.reasoningEffort, null);
    assert.deepEqual(snapshot.backendOptions, { customArgs: [] });
  } finally {
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("keeps non-Codex preset options inside backendOptions", async () => {
  const home = await mkdtemp(join(tmpdir(), "workshop-generic-agent-settings-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  const generic = { ...plugin, id: "generic", displayName: "Generic", executableEnvKey: "WORKSHOP_GENERIC_PATH", validateConfig: ({ backendOptions }: Parameters<AgentPlugin["validateConfig"]>[0]) => {
    if (Object.keys(backendOptions ?? {}).some((key) => key !== "endpoint")) throw new TypeError("unexpected backend option");
  }, health: async () => ({ id: "generic", ok: true, pluginVersion: "0.3.12", runtimeVersion: "0.147.0", capabilities: { ok: true, models: [], reasoningEfforts: [] } }) } satisfies AgentPlugin;
  try {
    registerAgentSettingsRoutes(server, database, new AgentRegistry([plugin, generic]));
    const role = { model: null, reasoningEffort: null, backendOptions: {} };
    const response = await server.inject({ method: "POST", url: "/api/agents/presets", payload: { name: "通用后端", agentBackend: "generic", model: null, reasoningEffort: null, backendOptions: { endpoint: "old" }, roleConfigs: { supervisor: role, developer: role, reviewer: role }, sandboxMode: "read-only", approvalPolicy: "never", networkAccess: false } });
    assert.equal(response.statusCode, 201);
    assert.equal("customArgs" in response.json(), false);
    assert.deepEqual(response.json().roleConfigs.developer.backendOptions, {});
    const presetId = response.json().id as string;
    assert.equal((await server.inject({ method: "PUT", url: "/api/agents/active", payload: { presetId } })).statusCode, 200);
    const updated = await server.inject({ method: "PUT", url: "/api/agents/presets/" + presetId, payload: { backendOptions: { endpoint: "new" } } });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(updated.json().roleConfigs.developer.backendOptions, {});
    assert.deepEqual(resolvedRoleConfig(database, "project", "developer").backendOptions, { endpoint: "new" });
    const roleUpdate = await server.inject({ method: "PUT", url: "/api/agents/roles/developer", payload: { ...role, backendOptions: { endpoint: "role-value" } } });
    assert.equal(roleUpdate.statusCode, 200);
    assert.deepEqual(roleUpdate.json(), { role: "developer", ...role, backendOptions: { endpoint: "role-value" } });
    assert.deepEqual(resolvedRoleConfig(database, "project", "developer").backendOptions, { endpoint: "role-value" });
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("rejects presets and role updates whose effective backendOptions are invalid", async () => {
  const home = await mkdtemp(join(tmpdir(), "workshop-merged-agent-settings-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  const merged = { ...plugin, id: "merged", displayName: "Merged", executableEnvKey: "WORKSHOP_MERGED_PATH", validateConfig: ({ backendOptions }: Parameters<AgentPlugin["validateConfig"]>[0]) => {
    if (backendOptions?.left === true && backendOptions.right === true) throw new TypeError("combined options are invalid");
  }, health: async () => ({ id: "merged", ok: true, pluginVersion: "0.3.12", runtimeVersion: "0.147.0", capabilities: { ok: true, models: [], reasoningEfforts: [] } }) } satisfies AgentPlugin;
  const role = (backendOptions: Record<string, unknown>) => ({ model: null, reasoningEffort: null, backendOptions });
  const payload = { name: "合并校验", agentBackend: "merged", ...role({ left: true }), roleConfigs: { supervisor: role({ left: true }), developer: role({}), reviewer: role({}) }, sandboxMode: "read-only", approvalPolicy: "never", networkAccess: false };
  try {
    registerAgentSettingsRoutes(server, database, new AgentRegistry([plugin, merged]));
    assert.equal((await server.inject({ method: "POST", url: "/api/agents/presets", payload: { ...payload, roleConfigs: { ...payload.roleConfigs, developer: role({ right: true }) } } })).statusCode, 400);
    const created = await server.inject({ method: "POST", url: "/api/agents/presets", payload });
    assert.equal(created.statusCode, 201);
    assert.equal((await server.inject({ method: "PUT", url: "/api/agents/active", payload: { presetId: created.json().id } })).statusCode, 200);
    assert.equal((await server.inject({ method: "PUT", url: "/api/agents/roles/developer", payload: role({ right: true }) })).statusCode, 400);
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("checks an existing Run snapshot backend without consulting the active preset", async () => {
  const home = await mkdtemp(join(tmpdir(), "workshop-agent-snapshot-preflight-"));
  const database = await openWorkshopDatabase(home);
  try {
    const active = { ...plugin, health: async () => { throw new Error("active backend must not be checked"); } };
    const snapshot = { ...plugin, id: "snapshot-agent", health: async () => ({ id: "snapshot-agent", ok: true, pluginVersion: "2.0.0", runtimeVersion: "0.147.0", capabilities: { ok: true, models: [], reasoningEfforts: [] } }) };
    const health = await refreshAgentHealth(database, new AgentRegistry([active, snapshot]), JSON.stringify({ agentBackend: "snapshot-agent" }));
    assert.equal(health.id, "snapshot-agent");
  } finally {
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("returns sanitized plugin health exceptions from preset APIs", async () => {
  const home = await mkdtemp(join(tmpdir(), "workshop-agent-health-error-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  const failed = { ...plugin, health: async () => { throw new Error("spawn C:\\private\\codex.COM ENOENT"); } };
  const role = { model: null, reasoningEffort: null, backendOptions: { customArgs: [] } };
  try {
    registerAgentSettingsRoutes(server, database, new AgentRegistry([failed]));
    const response = await server.inject({ method: "POST", url: "/api/agents/presets", payload: { name: "失败后端", agentBackend: "codex", ...role, roleConfigs: { supervisor: role, developer: role, reviewer: role }, sandboxMode: "read-only", approvalPolicy: "never", networkAccess: false } });
    assert.equal(response.statusCode, 503);
    assert.match(response.body, /health check failed/i);
    assert.doesNotMatch(response.body, /private/i);
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("returns actionable Codex health failures from preset APIs", async () => {
  const home = await mkdtemp(join(tmpdir(), "workshop-codex-health-error-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  const failed = createCodexPlugin(() => checkCodexHealth({ runCommand: async () => { throw new Error("spawn codex ENOENT"); } }));
  const role = { model: null, reasoningEffort: null, backendOptions: { customArgs: [] } };
  try {
    registerAgentSettingsRoutes(server, database, new AgentRegistry([failed]));
    const response = await server.inject({ method: "POST", url: "/api/agents/presets", payload: { name: "Codex 失败后端", agentBackend: "codex", ...role, roleConfigs: { supervisor: role, developer: role, reviewer: role }, sandboxMode: "read-only", approvalPolicy: "never", networkAccess: false } });
    assert.equal(response.statusCode, 503);
    assert.match(response.body, /Codex CLI could not be started or queried: spawn codex ENOENT/);
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});
