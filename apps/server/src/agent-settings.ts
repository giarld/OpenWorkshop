import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { APPROVAL_POLICIES, COMMAND_APPROVAL_POLICY, COMMAND_SANDBOX_MODE, SANDBOX_MODES, checkCodexHealth, codexAppServerArgs, snapshotRoleConfig, validateCustomArgs, type ApprovalPolicy, type CodexHealth, type CodexRoleConfig, type SandboxMode } from "./codex.ts";
import { SettingsStore } from "./database.ts";

export const RUN_AGENT_ROLES = ["supervisor", "developer", "reviewer"] as const;
export type RunAgentRole = typeof RUN_AGENT_ROLES[number];

type RoleConfigRow = { role: string; prompt: string; model: string | null; reasoning_effort: string | null; custom_args_json: string };
type CodexRuntimeSettings = { sandboxMode: SandboxMode; approvalPolicy: ApprovalPolicy; networkAccess: boolean };
export type AgentRolePresetConfig = { model: string | null; reasoningEffort: string | null; customArgs: string[] };
export type AgentPreset = CodexRuntimeSettings & { id: string; name: string; agentBackend: "codex"; model: string | null; reasoningEffort: string | null; customArgs: string[]; roleConfigs: Record<RunAgentRole, AgentRolePresetConfig>; isDefault: boolean; legacy?: boolean };
type PresetInput = Omit<AgentPreset, "id" | "isDefault" | "legacy">;
const PRESETS_KEY = "agentPresets";
const ACTIVE_PRESET_KEY = "activeAgentPreset";

export function registerAgentSettingsRoutes(server: FastifyInstance, database: DatabaseSync, health = checkCodexHealth): void {
  server.get("/api/settings/agents", async () => {
    const result = await health();
    const active = activePreset(database);
    return { health: result, activePresetId: active.id, presets: listPresets(database), managed: managedSettings(active), configs: RUN_AGENT_ROLES.map((role) => roleConfig(database, role)) };
  });

  server.post<{ Body: Partial<PresetInput> }>("/api/settings/agents/presets", async (request, reply) => {
    try {
      const preset = await validatePreset(request.body, health);
      const presets = listPresets(database);
      const created = { ...preset, id: randomUUID(), isDefault: false, legacy: false };
      savePresets(database, [...presets, created]);
      return reply.code(201).send(created);
    } catch (error) { return reply.code((error as { statusCode?: number }).statusCode ?? 400).send({ error: (error as Error).message }); }
  });

  server.put<{ Params: { id: string }; Body: Partial<PresetInput> }>("/api/settings/agents/presets/:id", async (request, reply) => {
    try {
      const current = listPresets(database).find((item) => item.id === request.params.id);
      if (!current) return reply.code(404).send({ error: "Preset not found" });
      const input = {
        ...current,
        ...request.body,
        roleConfigs: request.body?.roleConfigs ? { ...current.roleConfigs, ...request.body.roleConfigs } : current.roleConfigs
      };
      const updated = { ...current, ...(await validatePreset(input, health)), id: current.id, legacy: false };
      savePresets(database, listPresets(database).map((item) => item.id === current.id ? updated : item));
      return updated;
    } catch (error) { return reply.code((error as { statusCode?: number }).statusCode ?? 400).send({ error: (error as Error).message }); }
  });

  server.delete<{ Params: { id: string } }>("/api/settings/agents/presets/:id", async (request, reply) => {
    const presets = listPresets(database);
    const preset = presets.find((item) => item.id === request.params.id);
    if (!preset) return reply.code(404).send({ error: "Preset not found" });
    if (preset.isDefault) return reply.code(400).send({ error: "Default preset cannot be deleted" });
    if (presets.length === 1) return reply.code(400).send({ error: "At least one preset is required" });
    const remaining = presets.filter((item) => item.id !== request.params.id);
    savePresets(database, remaining);
    if (activePresetId(database) === request.params.id) new SettingsStore(database).set(ACTIVE_PRESET_KEY, remaining[0]!.id);
    return { ok: true };
  });

  server.put<{ Body: { presetId?: unknown } }>("/api/settings/agents/active", async (request, reply) => {
    if (typeof request.body?.presetId !== "string" || !listPresets(database).some((item) => item.id === request.body.presetId)) return reply.code(400).send({ error: "presetId is invalid" });
    new SettingsStore(database).set(ACTIVE_PRESET_KEY, request.body.presetId);
    return { activePresetId: request.body.presetId };
  });

  server.put<{ Body: { sandboxMode?: unknown; approvalPolicy?: unknown; networkAccess?: unknown } }>("/api/settings/agents/runtime", async (request) => {
    const sandboxMode = enumValue(request.body?.sandboxMode, SANDBOX_MODES, "sandboxMode");
    const approvalPolicy = enumValue(request.body?.approvalPolicy, APPROVAL_POLICIES, "approvalPolicy");
    if (typeof request.body?.networkAccess !== "boolean") throw badRequest("networkAccess must be boolean");
    const settings = { sandboxMode, approvalPolicy, networkAccess: request.body.networkAccess };
    const active = activePreset(database);
    savePresets(database, listPresets(database).map((item) => item.id === active.id ? { ...item, ...settings } : item));
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
    const active = activePreset(database);
    const roleConfigs = { ...active.roleConfigs, [role]: { model, reasoningEffort, customArgs } };
    const primary = roleConfigs.supervisor;
    savePresets(database, listPresets(database).map((item) => item.id === active.id ? { ...item, ...primary, roleConfigs, legacy: false } : item));
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
  const config = snapshotRoleConfig(toConfig(global), project ? toConfig(project) : undefined);
  const preset = activePreset(database);
  if (preset.legacy || !RUN_AGENT_ROLES.includes(role as RunAgentRole)) return Object.freeze({ ...config, ...presetRuntime(preset) });
  const roleConfig = preset.roleConfigs[role as RunAgentRole];
  const { model: _model, reasoningEffort: _reasoningEffort, customArgs: _customArgs, ...withoutRoleOptions } = config;
  return Object.freeze({ ...withoutRoleOptions, ...(roleConfig.model ? { model: roleConfig.model } : {}), ...(roleConfig.reasoningEffort ? { reasoningEffort: roleConfig.reasoningEffort } : {}), customArgs: roleConfig.customArgs, ...presetRuntime(preset) });
}

export function codexRuntimeSettings(database: DatabaseSync): CodexRuntimeSettings {
  return presetRuntime(activePreset(database));
}

function presetRuntime(preset: AgentPreset): CodexRuntimeSettings {
  return { sandboxMode: preset.sandboxMode, approvalPolicy: preset.approvalPolicy, networkAccess: preset.networkAccess };
}

function activePreset(database: DatabaseSync): AgentPreset {
  const presets = listPresets(database);
  const id = activePresetId(database);
  return presets.find((item) => item.id === id) ?? presets[0]!;
}

function activePresetId(database: DatabaseSync): string | undefined {
  return new SettingsStore(database).get<string>(ACTIVE_PRESET_KEY);
}

function listPresets(database: DatabaseSync): AgentPreset[] {
  const settings = new SettingsStore(database);
  const stored = settings.get<AgentPreset[]>(PRESETS_KEY);
  if (stored?.length) return stored.map((preset, index) => normalizePreset(preset, index === 0));
  const runtime = settings.get<Partial<CodexRuntimeSettings>>("codexRuntime", {}) ?? {};
  const roleConfigs = Object.fromEntries(RUN_AGENT_ROLES.map((role) => {
    const config = toConfig(row(database, role, null));
    return [role, { model: config.model ?? null, reasoningEffort: config.reasoningEffort ?? null, customArgs: [...(config.customArgs ?? [])] }];
  })) as Record<RunAgentRole, AgentRolePresetConfig>;
  const primary = roleConfigs.supervisor;
  const preset: AgentPreset = { id: randomUUID(), name: "默认预设", agentBackend: "codex", ...primary, roleConfigs, sandboxMode: SANDBOX_MODES.includes(runtime.sandboxMode as SandboxMode) ? runtime.sandboxMode as SandboxMode : COMMAND_SANDBOX_MODE, approvalPolicy: APPROVAL_POLICIES.includes(runtime.approvalPolicy as ApprovalPolicy) ? runtime.approvalPolicy as ApprovalPolicy : COMMAND_APPROVAL_POLICY, networkAccess: typeof runtime.networkAccess === "boolean" ? runtime.networkAccess : true, isDefault: true, legacy: true };
  savePresets(database, [preset]);
  settings.set(ACTIVE_PRESET_KEY, preset.id);
  return [preset];
}

function savePresets(database: DatabaseSync, presets: AgentPreset[]): void { new SettingsStore(database).set(PRESETS_KEY, presets); }

function normalizePreset(preset: AgentPreset, defaultFallback = false): AgentPreset {
  const fallback = { model: preset.model ?? null, reasoningEffort: preset.reasoningEffort ?? null, customArgs: [...(preset.customArgs ?? [])] };
  const roleConfigs = Object.fromEntries(RUN_AGENT_ROLES.map((role) => [role, { ...fallback, ...(preset.roleConfigs?.[role] ?? {}) }])) as Record<RunAgentRole, AgentRolePresetConfig>;
  return { ...preset, ...fallback, roleConfigs, isDefault: preset.isDefault ?? (preset.legacy === true || defaultFallback) };
}

async function validatePreset(input: Partial<PresetInput>, health: typeof checkCodexHealth): Promise<PresetInput> {
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : (() => { throw badRequest("name must be a non-empty string"); })();
  if (input.agentBackend !== "codex") throw badRequest("Only codex backend is supported");
  const fallback = { model: nullableString(input.model, "model"), reasoningEffort: nullableString(input.reasoningEffort, "reasoningEffort"), customArgs: stringArray(input.customArgs ?? []) };
  validateCustomArgs(fallback.customArgs);
  const roleConfigs = Object.fromEntries(RUN_AGENT_ROLES.map((role) => {
    const value = input.roleConfigs?.[role] ?? fallback;
    const model = nullableString(value.model, "model");
    const reasoningEffort = nullableString(value.reasoningEffort, "reasoningEffort");
    const customArgs = stringArray(value.customArgs);
    validateCustomArgs(customArgs);
    return [role, { model, reasoningEffort, customArgs }];
  })) as Record<RunAgentRole, AgentRolePresetConfig>;
  const sandboxMode = enumValue(input.sandboxMode, SANDBOX_MODES, "sandboxMode");
  const approvalPolicy = enumValue(input.approvalPolicy, APPROVAL_POLICIES, "approvalPolicy");
  if (typeof input.networkAccess !== "boolean") throw badRequest("networkAccess must be boolean");
  if (Object.values(roleConfigs).some((config) => config.model || config.reasoningEffort)) {
    const result = await health();
    if (!result.ok) throw Object.assign(new Error(result.error ?? "Codex is unavailable"), { statusCode: 503 });
    for (const config of Object.values(roleConfigs)) {
      const selected = config.model ? result.models?.find((item) => item.id === config.model) : result.models?.find((item) => item.isDefault);
      if (!selected) throw badRequest(config.model ? "Model is not available" : "Codex default model is unavailable");
      if (config.reasoningEffort && !selected.supportedReasoningEfforts?.some((item) => item.reasoningEffort === config.reasoningEffort)) throw badRequest("Reasoning effort is not supported by this model");
    }
  }
  const primary = roleConfigs.supervisor;
  return { name, agentBackend: "codex", ...primary, roleConfigs, sandboxMode, approvalPolicy, networkAccess: input.networkAccess };
}

function managedSettings(settings: CodexRuntimeSettings) {
  return { command: "codex", appServerArgs: codexAppServerArgs(settings.sandboxMode, settings.networkAccess), sandboxMode: settings.sandboxMode, approvalPolicy: settings.approvalPolicy, networkAccess: settings.networkAccess, workingDirectory: "Run workspace" };
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

export type AgentSettingsResponse = { health: CodexHealth; activePresetId: string; presets: AgentPreset[]; managed: ReturnType<typeof managedSettings>; configs: Array<ReturnType<typeof roleConfig>> };
