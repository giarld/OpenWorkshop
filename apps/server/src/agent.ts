import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { redactSensitive } from "./security.ts";

export const AGENT_CAPABILITIES = ["continuation", "steering", "interruption", "approvals", "userInput", "tokenUsage", "structuredFileEvents"] as const;
export type AgentCapability = typeof AGENT_CAPABILITIES[number];
export type AgentCapabilities = Record<AgentCapability, boolean>;
export type AgentBackendId = string;
export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export const APPROVAL_POLICIES = ["untrusted", "on-request", "never"] as const;
export const COMMAND_SANDBOX_MODE = "workspace-write" as const;
export const COMMAND_APPROVAL_POLICY = "on-request" as const;
export type SandboxMode = typeof SANDBOX_MODES[number];
export type ApprovalPolicy = typeof APPROVAL_POLICIES[number];
export type AgentInput = { type: "text"; text: string } | { type: "localImage"; path: string };
export type AgentTokenUsage = { input: number; output: number; cached: number };
export type AgentApprovalKind = "command" | "file_change" | "permission" | "mcp_tool_call";
export type AgentQuestion = { id: string; [key: string]: unknown };
export type AgentEvent = {
  type: string; summary: string; sourceType: string; payload: Record<string, unknown>; requestId?: string | number;
  text?: string; tokenUsage?: AgentTokenUsage; approvalKind?: AgentApprovalKind; questions?: AgentQuestion[];
};
export type AgentCompletion = { status: "succeeded" | "failed" | "cancelled" | "interrupted"; event: AgentEvent };
export type AgentTurn = { model?: string; completed: Promise<AgentCompletion> };
export type AgentStartOptions = {
  cwd: string; prompt: string; input?: AgentInput[]; model?: string; reasoningEffort?: string;
  approvalPolicy?: "untrusted" | "on-request" | "never"; sandbox?: "read-only" | "workspace-write" | "danger-full-access";
};
export type AgentRoleConfig = {
  prompt: string; agentBackend?: AgentBackendId; pluginVersion?: string; runtimeVersion?: string; model?: string | null; reasoningEffort?: string | null;
  backendOptions?: Record<string, unknown>; sandboxMode?: AgentStartOptions["sandbox"]; approvalPolicy?: AgentStartOptions["approvalPolicy"]; networkAccess?: boolean;
};
export type AgentSessionOptions = {
  cwd?: string; backendOptions?: Record<string, unknown>; sandboxMode?: AgentStartOptions["sandbox"]; networkAccess?: boolean;
  onEvent?: (event: AgentEvent) => void;
  onApproval?: (event: AgentEvent, respond: (decision: unknown) => void) => void | Promise<void>;
  onInput?: (event: AgentEvent, respond: (answers: unknown) => void) => void | Promise<void>;
};

export interface AgentSession {
  initialize(): Promise<void>;
  start(options: AgentStartOptions): Promise<AgentTurn>;
  continue(options: AgentStartOptions): Promise<AgentTurn>;
  steer(input: string | AgentInput[]): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export type AgentModel = { id: string; displayName?: string; defaultReasoningEffort?: string; supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>; isDefault?: boolean };
export type AgentBackendHealth = {
  id: AgentBackendId; ok: boolean; pluginVersion: string; runtimeVersion?: string; capabilities: { ok: boolean; models: AgentModel[]; reasoningEfforts: string[]; error?: string }; error?: string;
};
export type AgentPluginConfig = { model?: string | null; reasoningEffort?: string | null; backendOptions?: Record<string, unknown> };
export type AgentPlugin = {
  id: AgentBackendId; displayName: string; pluginVersion: string; defaultCommand: string; executableEnvKey: string;
  runtimeVersion: { min: string; max?: string }; capabilities: AgentCapabilities; description: string;
  backendOptions: Record<string, unknown>; healthTimeoutMs?: number; validateConfig(config: AgentPluginConfig): void; health(): Promise<AgentBackendHealth>; createSession(options: AgentSessionOptions): AgentSession;
};
export type AgentBackendInfo = Omit<AgentPlugin, "health" | "createSession" | "validateConfig"> & { executable: { defaultCommand: string; environmentKey: string; configured: boolean; valid: boolean } };

export function snapshotRoleConfig(globalConfig: AgentRoleConfig, projectConfig?: Partial<AgentRoleConfig>): Readonly<AgentRoleConfig> {
  return Object.freeze(Object.fromEntries(Object.entries({
    prompt: projectConfig?.prompt ?? globalConfig.prompt,
    model: projectConfig?.model ?? globalConfig.model,
    reasoningEffort: projectConfig?.reasoningEffort ?? globalConfig.reasoningEffort,
    backendOptions: projectConfig?.backendOptions ?? globalConfig.backendOptions,
    sandboxMode: projectConfig?.sandboxMode ?? globalConfig.sandboxMode,
    approvalPolicy: projectConfig?.approvalPolicy ?? globalConfig.approvalPolicy,
    networkAccess: projectConfig?.networkAccess ?? globalConfig.networkAccess
  }).filter(([, value]) => value !== undefined && value !== null))) as Readonly<AgentRoleConfig>;
}

export class AgentError extends Error {
  readonly code: "agent_session_busy" | "agent_capability_unsupported" | "agent_backend_unavailable";
  readonly statusCode: number;
  constructor(code: AgentError["code"], message: string, statusCode = 409) { super(message); this.code = code; this.statusCode = statusCode; }
}

export function capabilityError(): AgentError {
  return new AgentError("agent_capability_unsupported", "当前 Agent 后端不支持该操作");
}

export function agentErrorBody(error: unknown, message: string): { error: string; code?: AgentError["code"] } {
  return { error: message, ...(error instanceof AgentError ? { code: error.code } : {}) };
}

export function safeAgentError(registry: AgentRegistry, backend: string, error: unknown, fallbackStatus = 502): Error {
  const status = error && typeof error === "object" && "statusCode" in error ? (error as { statusCode?: unknown }).statusCode : undefined;
  const statusCode = typeof status === "number" ? status : fallbackStatus;
  const message = registry.safeError(backend, error);
  return error instanceof AgentError ? new AgentError(error.code, message, statusCode) : Object.assign(new Error(message), { statusCode });
}

export class AgentRegistry {
  private readonly plugins = new Map<AgentBackendId, AgentPlugin>();
  private readonly healthChecks = new Map<AgentBackendId, Promise<AgentBackendHealth>>();

  constructor(plugins: readonly AgentPlugin[] = []) { for (const plugin of plugins) this.register(plugin); }

  register(plugin: AgentPlugin): void {
    if (plugin.healthTimeoutMs !== undefined && (!Number.isSafeInteger(plugin.healthTimeoutMs) || plugin.healthTimeoutMs <= 0 || plugin.healthTimeoutMs > 2_147_483_647)) throw new TypeError("Agent backend health timeout must be a positive integer no greater than 2147483647 ms");
    if (this.plugins.has(plugin.id)) throw new Error(`Agent backend already registered: ${plugin.id}`);
    this.plugins.set(plugin.id, plugin);
  }

  list(): AgentPlugin[] { return [...this.plugins.values()]; }
  backends(): AgentBackendInfo[] { return this.list().map((plugin) => ({
    id: plugin.id, displayName: plugin.displayName, pluginVersion: plugin.pluginVersion, defaultCommand: plugin.defaultCommand, executableEnvKey: plugin.executableEnvKey,
    runtimeVersion: plugin.runtimeVersion, capabilities: plugin.capabilities, description: plugin.description, backendOptions: plugin.backendOptions,
    ...(plugin.healthTimeoutMs === undefined ? {} : { healthTimeoutMs: plugin.healthTimeoutMs }), executable: executableStatus(plugin)
  })); }

  plugin(id: string): AgentPlugin {
    const plugin = this.plugins.get(id as AgentBackendId);
    if (!plugin) throw new AgentError("agent_backend_unavailable", `Agent backend is not registered: ${id}`, 503);
    return plugin;
  }

  health(id: string): Promise<AgentBackendHealth> {
    const plugin = this.plugin(id);
    const existing = this.healthChecks.get(plugin.id);
    if (existing) return existing;
    const check = healthWithTimeout(plugin).finally(() => this.healthChecks.delete(plugin.id));
    this.healthChecks.set(plugin.id, check);
    return check;
  }

  async healthAll(): Promise<AgentBackendHealth[]> { return Promise.all(this.list().map((plugin) => this.health(plugin.id))); }

  createSession(id: string, options: AgentSessionOptions): AgentSession {
    const plugin = this.plugin(id);
    plugin.validateConfig(options.backendOptions ? { backendOptions: options.backendOptions } : {});
    return guardedSession(plugin.createSession(options), plugin, options.backendOptions);
  }

  safeError(id: string, error: unknown): string {
    return sanitizePluginError(this.plugins.get(id), error);
  }

  explicitSecrets(id: string): string[] {
    const plugin = this.plugins.get(id as AgentBackendId);
    const value = plugin ? configuredExecutable(plugin) : undefined;
    return value ? [value] : [];
  }
}

function executableStatus(plugin: AgentPlugin): AgentBackendInfo["executable"] {
  const value = configuredExecutable(plugin);
  if (!value) return { defaultCommand: plugin.defaultCommand, environmentKey: plugin.executableEnvKey, configured: false, valid: true };
  let valid = false;
  try { valid = isAbsolute(value) && statSync(value).isFile(); if (valid) accessSync(value, process.platform === "win32" ? constants.F_OK : constants.X_OK); } catch { valid = false; }
  return { defaultCommand: plugin.defaultCommand, environmentKey: plugin.executableEnvKey, configured: true, valid };
}

function sanitizePluginError(plugin: AgentPlugin | undefined, error: unknown): string {
  const executable = plugin ? configuredExecutable(plugin) : undefined;
  return redactSensitive(error instanceof Error ? error.message : String(error), executable ? [executable] : []).value;
}

function configuredExecutable(plugin: AgentPlugin): string | undefined {
  return process.env[plugin.executableEnvKey]?.trim() || undefined;
}

function unavailableHealth(plugin: AgentPlugin): AgentBackendHealth {
  return { id: plugin.id, ok: false, pluginVersion: plugin.pluginVersion, capabilities: { ok: false, models: [], reasoningEfforts: [] }, error: "Agent backend health check failed" };
}

async function healthWithTimeout(plugin: AgentPlugin): Promise<AgentBackendHealth> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutMs = plugin.healthTimeoutMs ?? 5_000;
  try {
    const health = await Promise.race([plugin.health(), new Promise<AgentBackendHealth>((resolve) => { timer = setTimeout(() => resolve({ ...unavailableHealth(plugin), error: `Agent backend health check timed out after ${timeoutMs} ms` }), timeoutMs); })]);
    const sanitized = { ...health, ...(health.error ? { error: sanitizePluginError(plugin, health.error) } : {}), capabilities: { ...health.capabilities, ...(health.capabilities.error ? { error: sanitizePluginError(plugin, health.capabilities.error) } : {}) } };
    if (!health.ok) return sanitized;
    const min = normalizeSemver(plugin.runtimeVersion.min);
    const max = plugin.runtimeVersion.max ? normalizeSemver(plugin.runtimeVersion.max) : undefined;
    if (!min || (plugin.runtimeVersion.max !== undefined && !max)) return { ...unavailableHealth(plugin), error: "Agent plugin runtime version requirement is invalid" };
    const requirement = max ? `>= ${min} and <= ${max}` : `>= ${min}`;
    if (!health.runtimeVersion) return { ...unavailableHealth(plugin), error: `Agent runtime version is missing; requires ${requirement}` };
    const runtimeVersion = normalizeSemver(health.runtimeVersion);
    if (!runtimeVersion) return { ...unavailableHealth(plugin), error: `Agent runtime version could not be parsed; requires ${requirement}` };
    if (!semverInRange(runtimeVersion, min, max)) return { ...unavailableHealth(plugin), runtimeVersion, error: `Agent runtime ${runtimeVersion} is incompatible; requires ${requirement}` };
    return { ...sanitized, runtimeVersion };
  } catch (error) { return { ...unavailableHealth(plugin), error: `Agent backend health check failed: ${sanitizePluginError(plugin, error)}` }; }
  finally { if (timer) clearTimeout(timer); }
}

function guardedSession(session: AgentSession, plugin: AgentPlugin, backendOptions?: Record<string, unknown>): AgentSession {
  const capabilities = plugin.capabilities;
  let busy = false;
  const run = async (action: () => Promise<AgentTurn>) => {
    if (busy) throw new AgentError("agent_session_busy", "Agent session is already running");
    busy = true;
    try {
      const turn = await action();
      void turn.completed.then(() => { busy = false; }, () => { busy = false; });
      return turn;
    } catch (error) { busy = false; throw error; }
  };
  return {
    initialize: () => session.initialize(), start: (options) => run(() => { plugin.validateConfig({ ...(options.model !== undefined ? { model: options.model } : {}), ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}), ...(backendOptions ? { backendOptions } : {}) }); return session.start(options); }),
    continue: (options) => capabilities.continuation ? run(() => { plugin.validateConfig({ ...(options.model !== undefined ? { model: options.model } : {}), ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}), ...(backendOptions ? { backendOptions } : {}) }); return session.continue(options); }) : Promise.reject(capabilityError()),
    steer: (input) => capabilities.steering ? session.steer(input) : Promise.reject(capabilityError()),
    interrupt: () => capabilities.interruption ? session.interrupt() : Promise.reject(capabilityError()),
    close: () => session.close()
  };
}

export function normalizeSemver(value: string): string | undefined {
  const match = /(?:^|\s|v)((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?=\s|$)/.exec(value.trim());
  return match?.[1];
}

export function semverInRange(version: string, min: string, max?: string): boolean {
  return compareSemver(version, min) >= 0 && (max === undefined || compareSemver(version, max) <= 0);
}

function compareSemver(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
    if (!match) throw new TypeError(`Invalid SemVer: ${value}`);
    return { core: [match[1]!, match[2]!, match[3]!], prerelease: match[4]?.split(".") };
  };
  const a = parse(left); const b = parse(right);
  for (let index = 0; index < 3; index++) { const comparison = compareNumericIdentifier(a.core[index]!, b.core[index]!); if (comparison) return comparison; }
  if (!a.prerelease || !b.prerelease) return a.prerelease ? -1 : b.prerelease ? 1 : 0;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index]; const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x); const yn = /^\d+$/.test(y);
    if (xn && yn) return compareNumericIdentifier(x, y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function compareNumericIdentifier(left: string, right: string): number {
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
}
