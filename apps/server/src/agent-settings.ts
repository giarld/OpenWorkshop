import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { APPROVAL_POLICIES, COMMAND_APPROVAL_POLICY, COMMAND_SANDBOX_MODE, SANDBOX_MODES, checkCodexHealth, codexAppServerArgs, snapshotRoleConfig, validateCustomArgs, type ApprovalPolicy, type CodexHealth, type CodexRoleConfig, type SandboxMode } from "./codex.ts";
import { SettingsStore } from "./database.ts";

export const RUN_AGENT_ROLES = ["supervisor", "developer", "reviewer"] as const;
export type RunAgentRole = typeof RUN_AGENT_ROLES[number];

type RoleConfigRow = { role: string; prompt: string; model: string | null; reasoning_effort: string | null; custom_args_json: string };
type CodexRuntimeSettings = { sandboxMode: SandboxMode; approvalPolicy: ApprovalPolicy; networkAccess: boolean };

export function registerAgentSettingsRoutes(server: FastifyInstance, database: DatabaseSync, health = checkCodexHealth): void {
  server.get("/api/settings/agents", async () => ({
    health: await health(),
    managed: managedSettings(codexRuntimeSettings(database)),
    configs: RUN_AGENT_ROLES.map((role) => roleConfig(database, role))
  }));

  server.put<{ Body: { sandboxMode?: unknown; approvalPolicy?: unknown; networkAccess?: unknown } }>("/api/settings/agents/runtime", async (request) => {
    const sandboxMode = enumValue(request.body?.sandboxMode, SANDBOX_MODES, "sandboxMode");
    const approvalPolicy = enumValue(request.body?.approvalPolicy, APPROVAL_POLICIES, "approvalPolicy");
    if (typeof request.body?.networkAccess !== "boolean") throw badRequest("networkAccess must be boolean");
    const settings = { sandboxMode, approvalPolicy, networkAccess: request.body.networkAccess };
    new SettingsStore(database).set("codexRuntime", settings);
    return managedSettings(settings);
  });

  server.put<{ Params: { role: string }; Body: { model?: unknown; reasoningEffort?: unknown; customArgs?: unknown } }>("/api/settings/agents/:role", async (request, reply) => {
    if (!RUN_AGENT_ROLES.includes(request.params.role as RunAgentRole)) return reply.code(404).send({ error: "Unsupported Agent role" });
    const model = nullableString(request.body?.model, "model");
    const reasoningEffort = nullableString(request.body?.reasoningEffort, "reasoningEffort");
    const customArgs = stringArray(request.body?.customArgs);
    try { validateCustomArgs(customArgs); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }

    if (model || reasoningEffort) {
      const result = await health();
      if (!result.ok) return reply.code(503).send({ error: result.error ?? "Codex is unavailable" });
      const selected = model ? result.models?.find((item) => item.id === model) : result.models?.find((item) => item.isDefault);
      if (!selected) return reply.code(400).send({ error: model ? "Model is not available" : "Codex default model is unavailable" });
      if (reasoningEffort && !selected.supportedReasoningEfforts?.some((item) => item.reasoningEffort === reasoningEffort)) return reply.code(400).send({ error: "Reasoning effort is not supported by this model" });
    }

    const role = request.params.role as RunAgentRole;
    const current = row(database, role, null);
    const now = new Date().toISOString();
    if (current) database.prepare("UPDATE role_configs SET model = ?, reasoning_effort = ?, custom_args_json = ?, updated_at = ? WHERE project_id IS NULL AND role = ?")
      .run(model, reasoningEffort, JSON.stringify(customArgs), now, role);
    else database.prepare("INSERT INTO role_configs (id, project_id, role, prompt, model, reasoning_effort, custom_args_json, updated_at) VALUES (?, NULL, ?, '', ?, ?, ?, ?)")
      .run(randomUUID(), role, model, reasoningEffort, JSON.stringify(customArgs), now);
    return roleConfig(database, role);
  });
}

export function resolvedRoleConfig(database: DatabaseSync, projectId: string, role: string): Readonly<CodexRoleConfig> {
  const global = row(database, role, null);
  const project = row(database, role, projectId);
  return Object.freeze({ ...snapshotRoleConfig(toConfig(global), project ? toConfig(project) : undefined), ...codexRuntimeSettings(database) });
}

export function codexRuntimeSettings(database: DatabaseSync): CodexRuntimeSettings {
  const value = new SettingsStore(database).get<Partial<CodexRuntimeSettings>>("codexRuntime", {}) ?? {};
  return {
    sandboxMode: SANDBOX_MODES.includes(value.sandboxMode as SandboxMode) ? value.sandboxMode as SandboxMode : COMMAND_SANDBOX_MODE,
    approvalPolicy: APPROVAL_POLICIES.includes(value.approvalPolicy as ApprovalPolicy) ? value.approvalPolicy as ApprovalPolicy : COMMAND_APPROVAL_POLICY,
    networkAccess: typeof value.networkAccess === "boolean" ? value.networkAccess : true
  };
}

function managedSettings(settings: CodexRuntimeSettings) {
  return { command: "codex", appServerArgs: codexAppServerArgs(settings.sandboxMode, settings.networkAccess), ...settings, workingDirectory: "Run workspace" };
}

function roleConfig(database: DatabaseSync, role: RunAgentRole) {
  const config = toConfig(row(database, role, null));
  return { role, model: config.model ?? null, reasoningEffort: config.reasoningEffort ?? null, customArgs: config.customArgs ?? [] };
}

function row(database: DatabaseSync, role: string, projectId: string | null): RoleConfigRow | undefined {
  return database.prepare(`SELECT role, prompt, model, reasoning_effort, custom_args_json FROM role_configs WHERE role = ? AND ${projectId === null ? "project_id IS NULL" : "project_id = ?"}`)
    .get(...(projectId === null ? [role] : [role, projectId])) as RoleConfigRow | undefined;
}

function toConfig(value?: RoleConfigRow): CodexRoleConfig {
  return value ? { prompt: value.prompt, model: value.model, reasoningEffort: value.reasoning_effort, customArgs: JSON.parse(value.custom_args_json) as string[] } : { prompt: "", customArgs: [] };
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 200) throw badRequest(`${name} must be a string or null`);
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some((item) => typeof item !== "string" || !item || item.length > 256)) throw badRequest("customArgs must contain at most 32 non-empty strings of 256 characters");
  return value;
}

function enumValue<T extends string>(value: unknown, choices: readonly T[], name: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw badRequest(`${name} must be one of: ${choices.join(", ")}`);
  return value as T;
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export type AgentSettingsResponse = { health: CodexHealth; managed: ReturnType<typeof managedSettings>; configs: Array<ReturnType<typeof roleConfig>> };
