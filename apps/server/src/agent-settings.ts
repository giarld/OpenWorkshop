import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { APPROVAL_POLICIES, COMMAND_APPROVAL_POLICY, COMMAND_SANDBOX_MODE, SANDBOX_MODES, snapshotRoleConfig, type AgentBackendHealth, type AgentPlugin, type AgentRegistry, type AgentRoleConfig, type ApprovalPolicy, type SandboxMode } from "./agent.ts";
import { SettingsStore } from "./database.ts";
import { WORKSHOP_VERSION } from "./version.ts";

export const RUN_AGENT_ROLES = ["supervisor", "developer", "reviewer"] as const;
export type RunAgentRole = typeof RUN_AGENT_ROLES[number];

type RoleConfigRow = { role: string; prompt: string; model: string | null; reasoning_effort: string | null; custom_args_json: string };
type CodexRuntimeSettings = { sandboxMode: SandboxMode; approvalPolicy: ApprovalPolicy; networkAccess: boolean };
export type AgentRolePresetConfig = { model: string | null; reasoningEffort: string | null; backendOptions: Record<string, unknown> };
export type AgentPreset = CodexRuntimeSettings & { id: string; name: string; agentBackend: string; pluginVersion?: string; runtimeVersion?: string; backendOptions: Record<string, unknown>; model: string | null; reasoningEffort: string | null; roleConfigs: Record<RunAgentRole, AgentRolePresetConfig>; isDefault: boolean; legacy?: boolean };
type PresetInput = Omit<AgentPreset, "id" | "isDefault" | "legacy">;
const PRESETS_KEY = "agentPresets";
const ACTIVE_PRESET_KEY = "activeAgentPreset";

export function registerAgentSettingsRoutes(server: FastifyInstance, database: DatabaseSync, registry: AgentRegistry): void {
  server.get("/api/agents/backends", async () => registry.backends());
  server.get("/api/agents/health", async () => registry.healthAll());
  server.get("/api/agents/presets", async () => {
    const current = activePreset(database);
    const result = await registry.health(current.agentBackend);
    const active = saveHealthMetadata(database, current, result);
    return { health: result, activePresetId: active.id, presets: listPresets(database), managed: managedSettings(active), configs: RUN_AGENT_ROLES.map((role) => roleConfig(database, role)) };
  });

  server.post<{ Body: Partial<PresetInput> }>("/api/agents/presets", async (request, reply) => {
    try {
      const preset = await validatePreset(request.body, registry);
      const presets = listPresets(database);
      const created = { ...preset, id: randomUUID(), isDefault: false, legacy: false };
      savePresets(database, [...presets, created]);
      return reply.code(201).send(created);
    } catch (error) {
      const backend = typeof request.body?.agentBackend === "string" ? request.body.agentBackend : "";
      return reply.code((error as { statusCode?: number }).statusCode ?? 400).send({ error: registry.safeError(backend, error) });
    }
  });

  server.put<{ Params: { id: string }; Body: Partial<PresetInput> }>("/api/agents/presets/:id", async (request, reply) => {
    try {
      const current = listPresets(database).find((item) => item.id === request.params.id);
      if (!current) return reply.code(404).send({ error: "Preset not found" });
      const input = {
        ...current,
        ...request.body,
        roleConfigs: request.body?.roleConfigs ? { ...current.roleConfigs, ...request.body.roleConfigs } : current.roleConfigs
      };
      const updated = { ...current, ...(await validatePreset(input, registry)), id: current.id, legacy: false };
      transaction(database, () => {
        assertPresetCurrent(database, current);
        savePresets(database, listPresets(database).map((item) => item.id === current.id ? updated : item));
      });
      return updated;
    } catch (error) {
      const backend = typeof request.body?.agentBackend === "string" ? request.body.agentBackend : listPresets(database).find((item) => item.id === request.params.id)?.agentBackend ?? "";
      return reply.code((error as { statusCode?: number }).statusCode ?? 400).send({ error: registry.safeError(backend, error) });
    }
  });

  server.delete<{ Params: { id: string } }>("/api/agents/presets/:id", async (request, reply) => {
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

  server.put<{ Body: { presetId?: unknown } }>("/api/agents/active", async (request, reply) => {
    const preset = typeof request.body?.presetId === "string" ? listPresets(database).find((item) => item.id === request.body.presetId) : undefined;
    if (!preset) return reply.code(400).send({ error: "presetId is invalid" });
    const result = await registry.health(preset.agentBackend);
    if (!result.ok) return reply.code(503).send({ error: registry.safeError(preset.agentBackend, result.error ?? "Agent backend is unavailable") });
    transaction(database, () => {
      assertPresetCurrent(database, preset);
      saveHealthMetadata(database, preset, result);
      new SettingsStore(database).set(ACTIVE_PRESET_KEY, request.body.presetId);
    });
    return { activePresetId: request.body.presetId };
  });

  server.put<{ Body: { sandboxMode?: unknown; approvalPolicy?: unknown; networkAccess?: unknown } }>("/api/agents/runtime", async (request) => {
    const sandboxMode = enumValue(request.body?.sandboxMode, SANDBOX_MODES, "sandboxMode");
    const approvalPolicy = enumValue(request.body?.approvalPolicy, APPROVAL_POLICIES, "approvalPolicy");
    if (typeof request.body?.networkAccess !== "boolean") throw badRequest("networkAccess must be boolean");
    const settings = { sandboxMode, approvalPolicy, networkAccess: request.body.networkAccess };
    const current = activePreset(database);
    const result = await registry.health(current.agentBackend);
    if (!result.ok) throw Object.assign(new Error(registry.safeError(current.agentBackend, result.error ?? "Agent backend is unavailable")), { statusCode: 503 });
    transaction(database, () => {
      assertPresetCurrent(database, current);
      const active = saveHealthMetadata(database, current, result);
      savePresets(database, listPresets(database).map((item) => item.id === active.id ? { ...item, ...settings } : item));
    });
    return managedSettings(settings);
  });

  server.put<{ Params: { role: string }; Body: { model?: unknown; reasoningEffort?: unknown; backendOptions?: unknown } }>("/api/agents/roles/:role", async (request, reply) => {
    if (!RUN_AGENT_ROLES.includes(request.params.role as RunAgentRole)) return reply.code(404).send({ error: "Unsupported Agent role" });
    const model = nullableString(request.body?.model, "model");
    const reasoningEffort = nullableString(request.body?.reasoningEffort, "reasoningEffort");
    const backendOptions = objectValue(request.body?.backendOptions, "backendOptions");
    const preset = activePreset(database);
    const role = request.params.role as RunAgentRole;
    const roleConfigs = { ...preset.roleConfigs, [role]: { model, reasoningEffort, backendOptions } };
    const globalOptions = role === "supervisor" ? backendOptions : preset.backendOptions;
    let customArgs: string[];
    try {
      validateEffectiveRoleConfigs(registry.plugin(preset.agentBackend), globalOptions, roleConfigs);
      customArgs = backendCustomArgs(backendOptions);
    }
    catch (error) { return reply.code(400).send({ error: registry.safeError(preset.agentBackend, error) }); }

    const result = await registry.health(preset.agentBackend);
    if (!result.ok) return reply.code(503).send({ error: registry.safeError(preset.agentBackend, result.error ?? "Agent backend is unavailable") });

    const primary = roleConfigs.supervisor;
    transaction(database, () => {
      const latest = assertPresetCurrent(database, preset);
      const active = { ...latest, pluginVersion: result.pluginVersion, ...(result.runtimeVersion ? { runtimeVersion: result.runtimeVersion } : {}) };
      savePresets(database, listPresets(database).map((item) => item.id === active.id ? { ...item, ...active, model: primary.model, reasoningEffort: primary.reasoningEffort, backendOptions: globalOptions, roleConfigs, legacy: false } : item));
      const current = row(database, role, null);
      const now = new Date().toISOString();
      if (current) database.prepare("UPDATE role_configs SET model = ?, reasoning_effort = ?, custom_args_json = ?, updated_at = ? WHERE project_id IS NULL AND role = ?")
        .run(model, reasoningEffort, JSON.stringify(customArgs), now, role);
      else database.prepare("INSERT INTO role_configs (id, project_id, role, prompt, model, reasoning_effort, custom_args_json, updated_at) VALUES (?, NULL, ?, '', ?, ?, ?, ?)")
        .run(randomUUID(), role, model, reasoningEffort, JSON.stringify(customArgs), now);
    });
    return { role, ...roleConfigs[role] };
  });
}

export function resolvedRoleConfig(database: DatabaseSync, projectId: string, role: string): Readonly<AgentRoleConfig> {
  const global = row(database, role, null);
  const project = row(database, role, projectId);
  const config = snapshotRoleConfig(toConfig(global), project ? toConfig(project) : undefined);
  const preset = activePreset(database);
  const backend = { agentBackend: preset.agentBackend, ...(preset.pluginVersion ? { pluginVersion: preset.pluginVersion } : {}), ...(preset.runtimeVersion ? { runtimeVersion: preset.runtimeVersion } : {}) };
  if (preset.legacy || !RUN_AGENT_ROLES.includes(role as RunAgentRole)) return Object.freeze({ ...config, model: config.model ?? null, reasoningEffort: config.reasoningEffort ?? null, backendOptions: { ...preset.backendOptions, ...config.backendOptions }, ...presetRuntime(preset), ...backend });
  const roleConfig = preset.roleConfigs[role as RunAgentRole];
  const { model: _model, reasoningEffort: _reasoningEffort, backendOptions: _backendOptions, ...withoutRoleOptions } = config;
  return Object.freeze({ ...withoutRoleOptions, model: roleConfig.model, reasoningEffort: roleConfig.reasoningEffort, backendOptions: { ...preset.backendOptions, ...roleConfig.backendOptions }, ...presetRuntime(preset), ...backend });
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
    return [role, { model: config.model ?? null, reasoningEffort: config.reasoningEffort ?? null, backendOptions: { ...config.backendOptions } }];
  })) as Record<RunAgentRole, AgentRolePresetConfig>;
  const primary = roleConfigs.supervisor;
  const preset: AgentPreset = { id: randomUUID(), name: "默认预设", agentBackend: "codex", pluginVersion: WORKSHOP_VERSION, model: primary.model, reasoningEffort: primary.reasoningEffort, backendOptions: primary.backendOptions, roleConfigs, sandboxMode: SANDBOX_MODES.includes(runtime.sandboxMode as SandboxMode) ? runtime.sandboxMode as SandboxMode : COMMAND_SANDBOX_MODE, approvalPolicy: APPROVAL_POLICIES.includes(runtime.approvalPolicy as ApprovalPolicy) ? runtime.approvalPolicy as ApprovalPolicy : COMMAND_APPROVAL_POLICY, networkAccess: typeof runtime.networkAccess === "boolean" ? runtime.networkAccess : true, isDefault: true, legacy: true };
  savePresets(database, [preset]);
  settings.set(ACTIVE_PRESET_KEY, preset.id);
  return [preset];
}

function savePresets(database: DatabaseSync, presets: AgentPreset[]): void { new SettingsStore(database).set(PRESETS_KEY, presets); }

function saveHealthMetadata(database: DatabaseSync, preset: AgentPreset, health: AgentBackendHealth): AgentPreset {
  if (!health.ok) return preset;
  const current = listPresets(database).find((item) => item.id === preset.id);
  if (!current || current.agentBackend !== health.id) return current ?? preset;
  const updated = { ...current, pluginVersion: health.pluginVersion, ...(health.runtimeVersion ? { runtimeVersion: health.runtimeVersion } : {}) };
  savePresets(database, listPresets(database).map((item) => item.id === preset.id ? updated : item));
  return updated;
}

export async function refreshActiveAgentHealth(database: DatabaseSync, registry: AgentRegistry): Promise<AgentBackendHealth> {
  const preset = activePreset(database);
  const health = await registry.health(preset.agentBackend);
  if (!health.ok) throw Object.assign(new Error(health.error ?? "Agent backend is unavailable"), { statusCode: 503 });
  saveHealthMetadata(database, preset, health);
  return health;
}

export async function refreshAgentHealth(database: DatabaseSync, registry: AgentRegistry, configSnapshotJson?: string): Promise<AgentBackendHealth> {
  if (!configSnapshotJson) return refreshActiveAgentHealth(database, registry);
  const config = JSON.parse(configSnapshotJson) as Record<string, unknown>;
  const backend = typeof config.agentBackend === "string" ? config.agentBackend : "codex";
  const health = await registry.health(backend);
  if (!health.ok) throw Object.assign(new Error(health.error ?? "Agent backend is unavailable"), { statusCode: 503 });
  return health;
}

function normalizePreset(preset: AgentPreset, defaultFallback = false): AgentPreset {
  const legacy = preset as AgentPreset & { customArgs?: string[]; roleConfigs?: Partial<Record<RunAgentRole, AgentRolePresetConfig & { customArgs?: string[] }>> };
  const fallback = { model: preset.model ?? null, reasoningEffort: preset.reasoningEffort ?? null, backendOptions: { ...(preset.backendOptions ?? {}), ...(legacy.customArgs ? { customArgs: legacy.customArgs } : {}) } };
  const roleConfigs = Object.fromEntries(RUN_AGENT_ROLES.map((role) => {
    const value = legacy.roleConfigs?.[role];
    const backendOptions = { ...(preset.legacy ? fallback.backendOptions : {}), ...(value?.backendOptions ?? {}), ...(value?.customArgs ? { customArgs: value.customArgs } : {}) };
    return [role, { model: value ? value.model : fallback.model, reasoningEffort: value ? value.reasoningEffort : fallback.reasoningEffort, backendOptions }];
  })) as Record<RunAgentRole, AgentRolePresetConfig>;
  const { customArgs: _customArgs, ...withoutLegacy } = legacy;
  return { ...withoutLegacy, ...fallback, roleConfigs, isDefault: preset.isDefault ?? (preset.legacy === true || defaultFallback) };
}

async function validatePreset(input: Partial<PresetInput>, registry: AgentRegistry): Promise<PresetInput> {
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : (() => { throw badRequest("name must be a non-empty string"); })();
  if (typeof input.agentBackend !== "string" || !input.agentBackend) throw badRequest("agentBackend must name a registered backend");
  const backendOptions = objectValue(input.backendOptions, "backendOptions");
  const fallback = { model: nullableString(input.model, "model"), reasoningEffort: nullableString(input.reasoningEffort, "reasoningEffort"), backendOptions };
  const plugin = registry.plugin(input.agentBackend);
  const roleConfigs = Object.fromEntries(RUN_AGENT_ROLES.map((role) => {
    const value = input.roleConfigs?.[role] ?? fallback;
    const model = nullableString(value.model, "model");
    const reasoningEffort = nullableString(value.reasoningEffort, "reasoningEffort");
    const roleBackendOptions = objectValue(value.backendOptions, "backendOptions");
    return [role, { model, reasoningEffort, backendOptions: roleBackendOptions }];
  })) as Record<RunAgentRole, AgentRolePresetConfig>;
  validateEffectiveRoleConfigs(plugin, backendOptions, roleConfigs);
  const sandboxMode = enumValue(input.sandboxMode, SANDBOX_MODES, "sandboxMode");
  const approvalPolicy = enumValue(input.approvalPolicy, APPROVAL_POLICIES, "approvalPolicy");
  if (typeof input.networkAccess !== "boolean") throw badRequest("networkAccess must be boolean");
  const result = await registry.health(input.agentBackend);
  if (!result.ok) throw Object.assign(new Error(result.error ?? "Agent backend is unavailable"), { statusCode: 503 });
  const primary = roleConfigs.supervisor;
  return { name, agentBackend: input.agentBackend, pluginVersion: result.pluginVersion, ...(result.runtimeVersion ? { runtimeVersion: result.runtimeVersion } : {}), model: primary.model, reasoningEffort: primary.reasoningEffort, backendOptions, roleConfigs, sandboxMode, approvalPolicy, networkAccess: input.networkAccess };
}

function validateEffectiveRoleConfigs(plugin: AgentPlugin, globalOptions: Record<string, unknown>, roleConfigs: Record<RunAgentRole, AgentRolePresetConfig>): void {
  plugin.validateConfig({ backendOptions: globalOptions });
  for (const config of Object.values(roleConfigs)) plugin.validateConfig({ model: config.model, reasoningEffort: config.reasoningEffort, backendOptions: { ...globalOptions, ...config.backendOptions } });
}

function managedSettings(settings: CodexRuntimeSettings) {
  return { sandboxMode: settings.sandboxMode, approvalPolicy: settings.approvalPolicy, networkAccess: settings.networkAccess };
}

function roleConfig(database: DatabaseSync, role: RunAgentRole) {
  const config = toConfig(row(database, role, null));
  return { role, model: config.model ?? null, reasoningEffort: config.reasoningEffort ?? null, backendOptions: config.backendOptions ?? {} };
}

function row(database: DatabaseSync, role: string, projectId: string | null): RoleConfigRow | undefined {
  return database.prepare(`SELECT role, prompt, model, reasoning_effort, custom_args_json FROM role_configs WHERE role = ? AND ${projectId === null ? "project_id IS NULL" : "project_id = ?"}`)
    .get(...(projectId === null ? [role] : [role, projectId])) as RoleConfigRow | undefined;
}

function toConfig(value?: RoleConfigRow): AgentRoleConfig {
  return value ? { prompt: value.prompt, model: value.model, reasoningEffort: value.reasoning_effort, backendOptions: { customArgs: JSON.parse(value.custom_args_json) as string[] } } : { prompt: "", backendOptions: { customArgs: [] } };
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw badRequest(`${name} must be a string or null`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 200) throw badRequest(`${name} must be a string or null`);
  return normalized;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some((item) => typeof item !== "string" || !item || item.length > 256)) throw badRequest("customArgs must contain at most 32 non-empty strings of 256 characters");
  return value;
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function backendCustomArgs(options: Record<string, unknown>): string[] {
  return options.customArgs === undefined ? [] : stringArray(options.customArgs);
}

function enumValue<T extends string>(value: unknown, choices: readonly T[], name: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw badRequest(`${name} must be one of: ${choices.join(", ")}`);
  return value as T;
}

function transaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try { const result = action(); database.exec("COMMIT"); return result; }
  catch (error) { database.exec("ROLLBACK"); throw error; }
}

function assertPresetCurrent(database: DatabaseSync, expected: AgentPreset): AgentPreset {
  const current = listPresets(database).find((item) => item.id === expected.id);
  const withoutHealth = ({ pluginVersion: _pluginVersion, runtimeVersion: _runtimeVersion, ...preset }: AgentPreset) => preset;
  if (!current || JSON.stringify(withoutHealth(current)) !== JSON.stringify(withoutHealth(expected))) throw Object.assign(new Error("Agent preset changed; retry the request"), { statusCode: 409 });
  return current;
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export type AgentSettingsResponse = { health: AgentBackendHealth; activePresetId: string; presets: AgentPreset[]; managed: ReturnType<typeof managedSettings>; configs: Array<ReturnType<typeof roleConfig>> };
