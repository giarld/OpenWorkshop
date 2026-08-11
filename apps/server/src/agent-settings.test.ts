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
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});
