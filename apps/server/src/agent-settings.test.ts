import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { registerAgentSettingsRoutes, resolvedRoleConfig } from "./agent-settings.ts";
import { openWorkshopDatabase } from "./database.ts";

const health = async () => ({ ok: true as const, version: "codex-test", models: [{ id: "test-model", displayName: "Test Model", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] }] });

test("validates and stores global Run Agent settings", async () => {
  const home = await mkdtemp(join(tmpdir(), "workshop-agent-settings-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  try {
    registerAgentSettingsRoutes(server, database, health);
    const initial = (await server.inject({ method: "GET", url: "/api/settings/agents" })).json();
    assert.equal(initial.health.models[0].id, "test-model");
    const defaultPresetId = initial.presets[0].id as string;
    assert.equal((await server.inject({ method: "PUT", url: "/api/settings/agents/presets/" + defaultPresetId, payload: { name: "已编辑默认预设" } })).statusCode, 200);
    assert.equal((await server.inject({ method: "DELETE", url: "/api/settings/agents/presets/" + defaultPresetId })).statusCode, 400);
    assert.deepEqual(initial.managed, { command: "codex", appServerArgs: ["app-server", "-c", "sandbox_mode=\"workspace-write\"", "-c", "approval_policy=\"never\"", "-c", "sandbox_workspace_write.network_access=true"], sandboxMode: "workspace-write", approvalPolicy: "on-request", networkAccess: true, workingDirectory: "Run workspace" });
    assert.deepEqual(initial.configs.map((config: { role: string }) => config.role), ["supervisor", "developer", "reviewer"]);

    assert.equal((await server.inject({ method: "PUT", url: "/api/settings/agents/developer", payload: { model: "missing", reasoningEffort: "medium", customArgs: [] } })).statusCode, 400);
    assert.equal((await server.inject({ method: "PUT", url: "/api/settings/agents/developer", payload: { model: "test-model", reasoningEffort: "max", customArgs: [] } })).statusCode, 400);
    assert.equal((await server.inject({ method: "PUT", url: "/api/settings/agents/developer", payload: { model: "test-model", reasoningEffort: "high", customArgs: ["-c", "sandbox_mode=\"danger-full-access\""] } })).statusCode, 400);
    assert.equal((await server.inject({ method: "PUT", url: "/api/settings/agents/runtime", payload: { sandboxMode: "host", approvalPolicy: "never", networkAccess: true } })).statusCode, 400);
    const runtime = await server.inject({ method: "PUT", url: "/api/settings/agents/runtime", payload: { sandboxMode: "read-only", approvalPolicy: "never", networkAccess: false } });
    assert.equal(runtime.statusCode, 200);
    assert.deepEqual(runtime.json(), { command: "codex", appServerArgs: ["app-server", "-c", "sandbox_mode=\"read-only\"", "-c", "approval_policy=\"never\""], sandboxMode: "read-only", approvalPolicy: "never", networkAccess: false, workingDirectory: "Run workspace" });

    const saved = await server.inject({ method: "PUT", url: "/api/settings/agents/supervisor", payload: { model: "test-model", reasoningEffort: "high", customArgs: ["--enable", "example"] } });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(resolvedRoleConfig(database, "project", "supervisor"), { prompt: "", model: "test-model", reasoningEffort: "high", customArgs: ["--enable", "example"], sandboxMode: "read-only", approvalPolicy: "never", networkAccess: false });

    const created = await server.inject({ method: "POST", url: "/api/settings/agents/presets", payload: { name: "只读审查", agentBackend: "codex", model: "test-model", reasoningEffort: "low", customArgs: [], roleConfigs: { supervisor: { model: "test-model", reasoningEffort: "low", customArgs: [] }, developer: { model: "test-model", reasoningEffort: "high", customArgs: ["--developer"] }, reviewer: { model: null, reasoningEffort: null, customArgs: [] } }, sandboxMode: "read-only", approvalPolicy: "on-request", networkAccess: false } });
    assert.equal(created.statusCode, 201);
    const presetId = created.json().id as string;
    const partialRoleUpdate = await server.inject({ method: "PUT", url: "/api/settings/agents/presets/" + presetId, payload: { roleConfigs: { developer: { model: "test-model", reasoningEffort: "low", customArgs: ["--updated"] } } } });
    assert.equal(partialRoleUpdate.statusCode, 200);
    assert.deepEqual(partialRoleUpdate.json().roleConfigs.reviewer, { model: null, reasoningEffort: null, customArgs: [] });
    assert.equal((await server.inject({ method: "PUT", url: "/api/settings/agents/active", payload: { presetId } })).statusCode, 200);
    assert.deepEqual(resolvedRoleConfig(database, "project", "developer"), { prompt: "", model: "test-model", reasoningEffort: "low", customArgs: ["--updated"], sandboxMode: "read-only", approvalPolicy: "on-request", networkAccess: false });
    assert.equal(resolvedRoleConfig(database, "project", "reviewer").model, undefined);
    assert.equal((await server.inject({ method: "DELETE", url: "/api/settings/agents/presets/" + presetId })).statusCode, 200);
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});
