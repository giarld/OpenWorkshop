import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { AgentError, APPROVAL_POLICIES, capabilityError, COMMAND_APPROVAL_POLICY, COMMAND_SANDBOX_MODE, normalizeSemver, SANDBOX_MODES, semverInRange, type AgentBackendHealth, type AgentCompletion, type AgentEvent, type AgentPlugin, type AgentPluginConfig, type AgentSession, type AgentSessionOptions, type AgentStartOptions, type AgentTurn, type ApprovalPolicy, type SandboxMode } from "./agent.ts";
import { WORKSHOP_VERSION } from "./version.ts";

const runFile = promisify(execFile);
const RESERVED_ARGS = new Set(["--listen", "--cwd", "-C", "--model", "-m", "--sandbox", "-s", "--ask-for-approval", "-a", "--output-schema", "--json"]);
export { APPROVAL_POLICIES, COMMAND_APPROVAL_POLICY, COMMAND_SANDBOX_MODE, SANDBOX_MODES, snapshotRoleConfig, type ApprovalPolicy, type SandboxMode } from "./agent.ts";
export function codexAppServerArgs(sandboxMode: SandboxMode = COMMAND_SANDBOX_MODE, networkAccess = true, customArgs: readonly string[] = []): string[] {
  return ["app-server", "-c", `sandbox_mode=${JSON.stringify(sandboxMode)}`, "-c", 'approval_policy="never"', ...(sandboxMode === "workspace-write" ? ["-c", `sandbox_workspace_write.network_access=${networkAccess}`] : []), ...customArgs];
}
export const CODEX_APP_SERVER_ARGS = codexAppServerArgs();

type JsonObject = Record<string, unknown>;
type RequestId = string | number;

export type NormalizedCodexEvent = {
  type: string;
  summary: string;
  method: string;
  payload: JsonObject;
  requestId?: RequestId;
};

export type CodexModel = {
  id: string;
  displayName?: string;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>;
  isDefault?: boolean;
};

export type CodexRoleConfig = {
  prompt: string;
  model?: string | null;
  reasoningEffort?: string | null;
  customArgs?: readonly string[];
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  networkAccess?: boolean;
};

export type CodexRunOptions = {
  cwd: string;
  prompt: string;
  developerInstructions?: string;
  input?: CodexInput[];
  threadId?: string;
  model?: string;
  effort?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
};

export type CodexInput = { type: "text"; text: string } | { type: "localImage"; path: string };

export type CodexRunHandle = {
  threadId: string;
  turnId: string;
  model?: string;
  completed: Promise<NormalizedCodexEvent>;
};

export type CodexAppServerOptions = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onEvent?: (event: NormalizedCodexEvent) => void;
  onApproval?: (event: NormalizedCodexEvent, respond: (decision: unknown) => void) => void | Promise<void>;
  onInput?: (event: NormalizedCodexEvent, respond: (answers: unknown) => void) => void | Promise<void>;
};

type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type TurnWaiter = { resolve: (event: NormalizedCodexEvent) => void; reject: (error: Error) => void };

export class CodexAppServerClosedError extends Error {
  constructor() {
    super("Codex App Server closed by the host");
    this.name = "CodexAppServerClosedError";
  }
}

export class CodexAppServer {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly options: CodexAppServerOptions;
  private nextId = 1;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly completedTurns = new Map<string, NormalizedCodexEvent>();
  private readonly turnWaiters = new Map<string, Set<TurnWaiter>>();
  private readonly threadModels = new Map<string, string>();
  private readonly requestTimeoutMs: number;
  private exited = false;
  private closing = false;

  private constructor(process: ChildProcessWithoutNullStreams, options: CodexAppServerOptions) {
    this.process = process;
    this.options = options;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    createInterface({ input: process.stdout }).on("line", (line) => this.receive(line));
    process.stderr.resume();
    process.once("error", (error) => this.finish(error, "process/error", {}));
    process.once("exit", (code, signal) => this.finish(this.closing ? new CodexAppServerClosedError() : new Error(`Codex App Server exited unexpectedly (${signal ?? code ?? "unknown"})`), "process/exit", { code, signal, expected: this.closing }));
  }

  static launch(options: CodexAppServerOptions = {}): CodexAppServer {
    const invocation = resolveInvocation(options.command ?? "codex", options.args ?? [...CODEX_APP_SERVER_ARGS], options.env);
    const child = spawn(invocation.file, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32"
    });
    return new CodexAppServer(child, options);
  }

  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "project_workshop", title: "OpenWorkshop", version: "0.1.0" } });
    this.notify("initialized", {});
  }

  async models(): Promise<CodexModel[]> {
    const result = asObject(await this.request("model/list", { includeHidden: true }));
    return Array.isArray(result.data) ? result.data.filter(isObject).map((model) => model as CodexModel) : [];
  }

  async startRun(options: CodexRunOptions): Promise<CodexRunHandle> {
    let model = options.model ?? (options.threadId ? this.threadModels.get(options.threadId) : undefined);
    const started = options.threadId ? undefined : asObject(await this.request("thread/start", compact({
      cwd: options.cwd,
      model,
      developerInstructions: options.developerInstructions,
      approvalPolicy: options.approvalPolicy ?? COMMAND_APPROVAL_POLICY,
      sandbox: options.sandbox ?? COMMAND_SANDBOX_MODE,
      serviceName: "project_workshop"
    })));
    const threadId = options.threadId ?? requiredString(asObject(started?.thread).id, "thread id");
    const turn = asObject(asObject(await this.request("turn/start", compact({
      threadId,
      input: options.input ?? [{ type: "text", text: options.prompt }],
      cwd: options.cwd,
      model,
      effort: options.effort
    }))).turn);
    const turnId = requiredString(turn.id, "turn id");
    if (typeof started?.model === "string") model = started.model;
    if (model) this.threadModels.set(threadId, model);
    return { threadId, turnId, ...(model ? { model } : {}), completed: this.waitForTurn(turnId) };
  }

  async steer(threadId: string, turnId: string, input: string | CodexInput[]): Promise<void> {
    await this.request("turn/steer", { threadId, expectedTurnId: turnId, input: typeof input === "string" ? [{ type: "text", text: input }] : input });
  }

  async interrupt(threadId: string, turnId: string, timeoutMs = 5_000): Promise<void> {
    await this.interruptTurn(threadId, turnId, timeoutMs, true);
  }

  async requestInterrupt(threadId: string, turnId: string, timeoutMs = 5_000): Promise<void> {
    await this.interruptTurn(threadId, turnId, timeoutMs, false);
  }

  private async interruptTurn(threadId: string, turnId: string, timeoutMs: number, waitForCompletion: boolean): Promise<void> {
    const completed = this.createTurnWaiter(turnId);
    const deadline = Date.now() + timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      const accepted = await Promise.race([
        this.request("turn/interrupt", { threadId, turnId }).then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })
      ]);
      if (!accepted) throw new Error(`Codex turn ${turnId} did not stop within ${timeoutMs}ms`);
    } catch (error) {
      completed.cancel();
      await terminateProcessTree(this.process);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const stopping = this.waitForInterruptCompletion(turnId, completed, timeoutMs, deadline);
    if (waitForCompletion) await stopping;
    else void stopping.catch(() => undefined);
  }

  private async waitForInterruptCompletion(turnId: string, completed: { promise: Promise<NormalizedCodexEvent>; cancel: () => void }, timeoutMs: number, deadline: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const stopped = await Promise.race([completed.promise.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())); })]);
      if (!stopped) {
        await terminateProcessTree(this.process);
        throw new Error(`Codex turn ${turnId} did not stop within ${timeoutMs}ms`);
      }
    } finally {
      if (timer) clearTimeout(timer);
      completed.cancel();
    }
  }

  request(method: string, params: JsonObject): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error("Codex App Server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  respond(id: RequestId, result: unknown): void {
    this.send({ id, result });
  }

  async close(): Promise<void> {
    if (this.exited) return;
    this.closing = true;
    this.process.stdin.end();
    if (!await waitForExit(this.process, 1_000)) await terminateProcessTree(this.process);
  }

  private notify(method: string, params: JsonObject): void {
    this.send({ method, params });
  }

  private send(message: JsonObject): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: JsonObject;
    try {
      message = asObject(JSON.parse(line));
    } catch {
      this.emit({ type: "protocol.error", summary: "Invalid JSON from Codex App Server", method: "protocol/error", payload: { line } });
      return;
    }
    if (message.id !== undefined && ("result" in message || "error" in message) && typeof message.method !== "string") {
      const pending = this.pending.get(message.id as RequestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id as RequestId);
      if (message.error) pending.reject(new Error(String(asObject(message.error).message ?? "Codex App Server request failed")));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") return;
    const event = normalizeCodexEvent(message.method, asObject(message.params), message.id as RequestId | undefined);
    this.emit(event);
    if (message.method === "turn/completed") {
      const turnId = String(asObject(asObject(message.params).turn).id ?? "");
      const waiters = this.turnWaiters.get(turnId);
      if (waiters) {
        this.turnWaiters.delete(turnId);
        for (const waiter of waiters) waiter.resolve(event);
      } else if (turnId) this.completedTurns.set(turnId, event);
    }
    const payload = asObject(message.params);
    if (message.id !== undefined && isApprovalRequest(message.method, payload) && !isApprovalMethod(message.method, payload)) {
      this.respond(message.id as RequestId, { decision: "cancel" });
      this.emit({ type: "approval.error", summary: `Unsupported approval method: ${message.method}`, method: message.method, payload, requestId: message.id as RequestId });
      return;
    }
    if (message.id !== undefined && (isApprovalMethod(message.method, payload) || isUserInputMethod(message.method))) {
      const method = message.method;
      const respond = (decision: unknown) => this.respond(message.id as RequestId, approvalResponse(method, decision));
      const callback = isUserInputMethod(method) ? this.options.onInput : this.options.onApproval;
      if (callback) void Promise.resolve(callback(event, respond)).catch((error) => {
        respond(isUserInputMethod(method) ? { answers: {} } : { decision: "cancel" });
        this.emit({ type: isUserInputMethod(method) ? "input.error" : "approval.error", summary: error instanceof Error ? error.message : String(error), method, payload: asObject(message.params), requestId: message.id as RequestId });
      });
    }
  }

  private waitForTurn(turnId: string): Promise<NormalizedCodexEvent> {
    return this.createTurnWaiter(turnId).promise;
  }

  private createTurnWaiter(turnId: string): { promise: Promise<NormalizedCodexEvent>; cancel: () => void } {
    const completed = this.completedTurns.get(turnId);
    if (completed) {
      this.completedTurns.delete(turnId);
      return { promise: Promise.resolve(completed), cancel: () => undefined };
    }
    let waiter: TurnWaiter;
    const promise = new Promise<NormalizedCodexEvent>((resolve, reject) => {
      waiter = { resolve, reject };
      const waiters = this.turnWaiters.get(turnId) ?? new Set();
      waiters.add(waiter);
      this.turnWaiters.set(turnId, waiters);
    });
    return {
      promise,
      cancel: () => {
        const waiters = this.turnWaiters.get(turnId);
        waiters?.delete(waiter);
        if (!waiters?.size) this.turnWaiters.delete(turnId);
      }
    };
  }

  private emit(event: NormalizedCodexEvent): void {
    this.options.onEvent?.(event);
  }

  private finish(error: Error, method: string, payload: JsonObject): void {
    if (this.exited) return;
    this.exited = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiters of this.turnWaiters.values()) for (const waiter of waiters) waiter.reject(error);
    this.turnWaiters.clear();
    this.emit({ type: method === "process/error" ? "process.error" : "process.exited", summary: error.message, method, payload });
  }
}

export function normalizeCodexEvent(method: string, payload: JsonObject, requestId?: RequestId): NormalizedCodexEvent {
  const item = asObject(payload.item);
  const turn = asObject(payload.turn);
  const itemType = String(item.type ?? "item");
  const turnStatus = String(turn.status ?? "");
  const mapped = method === "thread/started" ? ["thread.started", "Thread started"]
    : method === "turn/started" ? ["turn.started", "Turn started"]
    : method === "turn/completed" ? normalizeTurnCompletion(turnStatus)
    : method === "item/agentMessage/delta" ? ["agent.message.delta", "Agent message"]
    : method === "item/commandExecution/outputDelta" ? ["command.output", "Command output"]
    : method === "item/started" ? [`${snake(itemType)}.started`, `${itemType} started`]
    : method === "item/completed" ? [`${snake(itemType)}.completed`, `${itemType} completed`]
    : method === "thread/tokenUsage/updated" ? ["token.usage", "Token usage updated"]
    : method === "error" ? ["error", String(asObject(payload.error).message ?? "Codex error")]
    : method === "serverRequest/resolved" ? ["request.resolved", "Server request resolved"]
    : isUserInputMethod(method) ? ["input.requested", "User input requested"]
    : isApprovalMethod(method, payload) ? ["approval.requested", approvalSummary(method)]
    : ["codex.event", method];
  return { type: mapped[0]!, summary: mapped[1]!, method, payload, ...(requestId === undefined ? {} : { requestId }) };
}

function normalizeTurnCompletion(status: string): [string, string] {
  if (status === "completed") return ["turn.completed", "Turn completed"];
  if (status === "interrupted") return ["turn.interrupted", "Turn interrupted"];
  if (status === "failed") return ["turn.failed", "Turn failed"];
  return ["turn.failed", `Turn failed: unexpected status ${status || "<missing>"}`];
}

export function validateCustomArgs(args: readonly string[]): void {
  const managedConfig = new Set(["model", "model_reasoning_effort", "approval_policy", "sandbox_mode", "sandbox_workspace_write"]);
  const conflict = args.find((arg, index) => {
    if (RESERVED_ARGS.has(arg.split("=", 1)[0]!)) return true;
    if (arg !== "-c" && !arg.startsWith("-c=")) return false;
    const override = arg === "-c" ? args[index + 1] : arg.slice(3);
    const key = override?.split("=", 1)[0];
    return key ? [...managedConfig].some((managed) => key === managed || key.startsWith(`${managed}.`)) : false;
  });
  if (conflict) throw new TypeError(`Custom Codex argument conflicts with managed settings: ${conflict}`);
}

export type CodexHealth = AgentBackendHealth & { version?: string; models?: CodexModel[] };

function mergeModels(primary: CodexModel[], extra: CodexModel[]): CodexModel[] {
  const models = new Map(primary.map((model) => [model.id, model]));
  for (const model of extra) if (!models.has(model.id)) models.set(model.id, model);
  return [...models.values()];
}

async function discoverExternalModels(options: { runModelCommand?: (file: string, args: string[]) => Promise<string>; env?: NodeJS.ProcessEnv }, deadline: number): Promise<CodexModel[]> {
  try {
    const raw = options.runModelCommand
      ? await withTimeout(options.runModelCommand("ocx", ["access", "models", "--json"]), remaining(deadline))
      : await fetchExternalModels(deadline).catch(() => execute("ocx", ["access", "models", "--json"], remaining(deadline), options.env));
    return parseExternalModels(raw);
  } catch {
    return [];
  }
}

async function fetchExternalModels(deadline: number): Promise<string> {
  const response = await fetch("http://127.0.0.1:10100/v1/models", { signal: AbortSignal.timeout(Math.min(2_000, remaining(deadline))) });
  if (!response.ok) throw new Error(`External model catalog returned HTTP ${response.status}`);
  return response.text();
}

function parseExternalModels(raw: string): CodexModel[] {
  const data = asObject(JSON.parse(raw)).data;
  if (!Array.isArray(data)) return [];
  return data.filter(isObject).flatMap((model) => {
    if (typeof model.id !== "string" || !model.id.trim()) return [];
    const efforts = Array.isArray(model.reasoning_efforts) ? model.reasoning_efforts.map((item) => typeof item === "string" ? item : asObject(item).value).filter((item): item is string => typeof item === "string" && Boolean(item)) : [];
    return [{ id: model.id, ...(typeof model.reasoning_effort === "string" ? { defaultReasoningEffort: model.reasoning_effort } : {}), ...(efforts.length ? { supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })) } : {}) }];
  });
}

export async function checkCodexHealth(options: {
  command?: string;
  runCommand?: (file: string, args: string[]) => Promise<string>;
  runModelCommand?: (file: string, args: string[]) => Promise<string>;
  launch?: () => CodexAppServer;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  includeExternalModels?: boolean;
} = {}): Promise<CodexHealth> {
  let client: CodexAppServer | undefined;
  let stage: "cli" | "app-server" = "cli";
  const emptyCapabilities = { ok: false, models: [] as CodexModel[], reasoningEfforts: [] as string[] };
  const timeoutMs = options.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  try {
    const command = options.command ?? resolveCodexCommand(options.env ?? process.env);
    const rawVersion = options.runCommand ? await withTimeout(options.runCommand(command, ["--version"]), remaining(deadline)) : await execute(command, ["--version"], remaining(deadline), options.env);
    const version = normalizeSemver(rawVersion);
    if (!version) return healthFailure("Codex runtime version could not be parsed", emptyCapabilities);
    if (!semverInRange(version, CODEX_MIN_VERSION)) return healthFailure(`Codex runtime ${version} is incompatible; requires >= ${CODEX_MIN_VERSION}`, emptyCapabilities, version);
    const externalModels = options.includeExternalModels ? discoverExternalModels(options, deadline) : Promise.resolve([] as CodexModel[]);
    stage = "app-server";
    client = options.launch?.() ?? CodexAppServer.launch({ command, ...(options.env ? { env: options.env } : {}), requestTimeoutMs: remaining(deadline) });
    await withTimeout(client.initialize(), remaining(deadline));
    try {
      const models = await withTimeout(client.models(), remaining(deadline));
      const allModels = mergeModels(models, await externalModels);
      const reasoningEfforts = [...new Set(allModels.flatMap((model) => model.supportedReasoningEfforts?.map((item) => item.reasoningEffort) ?? []))];
      return { id: "codex", ok: true, pluginVersion: WORKSHOP_VERSION, runtimeVersion: version, version, models: allModels, capabilities: { ok: true, models: allModels, reasoningEfforts } };
    } catch {
      return { id: "codex", ok: true, pluginVersion: WORKSHOP_VERSION, runtimeVersion: version, version, models: [], capabilities: { ...emptyCapabilities, error: "Codex model capabilities are unavailable" } };
    }
  } catch (error) {
    return healthFailure(safeHealthError(error, stage, timeoutMs), emptyCapabilities);
  } finally {
    await client?.close().catch(() => undefined);
  }
}

export function validateCodexConfig(config: AgentPluginConfig): void {
  if (config.model !== undefined && config.model !== null && !config.model.trim()) throw new TypeError("Codex model must not be empty");
  if (config.reasoningEffort !== undefined && config.reasoningEffort !== null && !config.reasoningEffort.trim()) throw new TypeError("Codex reasoning effort must not be empty");
  const backend = config.backendOptions ?? {};
  const unknown = Object.keys(backend).find((key) => key !== "customArgs");
  if (unknown) throw new TypeError(`Unsupported Codex backend option: ${unknown}`);
  if (backend.customArgs !== undefined && (!Array.isArray(backend.customArgs) || backend.customArgs.length > 32 || backend.customArgs.some((item) => typeof item !== "string" || !item || item.length > 256))) throw new TypeError("Codex backend customArgs must contain at most 32 non-empty strings of 256 characters");
  validateCustomArgs(backend.customArgs as string[] | undefined ?? []);
}

async function execute(file: string, args: string[], timeout = 5_000, env = process.env): Promise<string> {
  const invocation = resolveInvocation(file, args, env);
  const { stdout } = await runFile(invocation.file, invocation.args, { encoding: "utf8", windowsHide: true, timeout, env });
  return stdout;
}

export function resolveInvocation(file: string, args: string[], env = process.env, platform = process.platform): { file: string; args: string[] } {
  let resolved = file;
  if (platform === "win32" && !isAbsolute(file) && !file.includes("\\") && !file.includes("/")) {
    const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    const suffixes = /\.[^\\/]+$/.test(file) ? [""] : extensions;
    resolved = (env.PATH ?? "").split(";").filter(Boolean).flatMap((directory) => suffixes.map((extension) => join(directory, file + extension))).find(existsSync) ?? file;
  }
  if (platform === "win32" && /^(?:codex)\.(?:cmd|bat)$/i.test(basename(resolved))) {
    const script = join(dirname(resolved), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(script)) return { file: process.execPath, args: [script, ...args] };
  }
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(resolved)) return { file: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", [resolved, ...args].map(cmdQuote).join(" ")] };
  return { file: resolved, args };
}

export const CODEX_MIN_VERSION = "0.147.0";

export function resolveCodexCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.WORKSHOP_CODEX_PATH?.trim();
  if (!configured) return "codex";
  if (!isAbsolute(configured) || !existsSync(configured) || !statSync(configured).isFile()) throw new Error("WORKSHOP_CODEX_PATH must name an existing absolute executable path");
  return configured;
}

class CodexAgentSession implements AgentSession {
  private readonly client: CodexAppServer;
  private threadId?: string;
  private active: CodexRunHandle | undefined;
  private busy = false;

  constructor(options: AgentSessionOptions) {
    const backend = options.backendOptions ?? {};
    const customArgs = Array.isArray(backend.customArgs) ? backend.customArgs.filter((item): item is string => typeof item === "string") : [];
    validateCustomArgs(customArgs);
    const sandboxMode = options.sandboxMode ?? COMMAND_SANDBOX_MODE;
    const networkAccess = options.networkAccess ?? true;
    const command = resolveCodexCommand();
    this.client = CodexAppServer.launch({
      command, ...(options.cwd ? { cwd: options.cwd } : {}), args: codexAppServerArgs(sandboxMode, networkAccess, customArgs),
      ...(options.onEvent ? { onEvent: (event) => options.onEvent?.(codexAgentEvent(event)) } : {}),
      ...(options.onApproval ? { onApproval: (event, respond) => options.onApproval?.(codexAgentEvent(event), respond) } : {}),
      ...(options.onInput ? { onInput: (event, respond) => options.onInput?.(codexAgentEvent(event), respond) } : {})
    });
  }

  initialize(): Promise<void> { return this.client.initialize(); }
  start(options: AgentStartOptions): Promise<AgentTurn> { return this.run(options, false); }
  continue(options: AgentStartOptions): Promise<AgentTurn> {
    if (!this.threadId) throw capabilityError();
    return this.run(options, true);
  }
  async steer(input: string | CodexInput[]): Promise<void> {
    if (!this.active) throw new AgentError("agent_session_busy", "Agent session has no active turn");
    await this.client.steer(this.active.threadId, this.active.turnId, input);
  }
  async interrupt(): Promise<void> {
    if (!this.active) throw new AgentError("agent_session_busy", "Agent session has no active turn");
    const active = this.active;
    await this.client.requestInterrupt(active.threadId, active.turnId);
  }
  close(): Promise<void> { return this.client.close(); }

  private async run(options: AgentStartOptions, continuation: boolean): Promise<AgentTurn> {
    if (this.busy) throw new AgentError("agent_session_busy", "Agent session is already running");
    this.busy = true;
    try {
      const handle = await this.client.startRun({
        cwd: options.cwd, prompt: options.prompt, ...(options.developerInstructions ? { developerInstructions: options.developerInstructions } : {}), ...(options.input ? { input: options.input } : {}),
        ...(continuation && this.threadId ? { threadId: this.threadId } : {}), ...(options.model ? { model: options.model } : {}),
        ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}), ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
        ...(options.sandbox ? { sandbox: options.sandbox } : {})
      });
      this.threadId = handle.threadId;
      this.active = handle;
      const completed = handle.completed.then((event) => codexAgentCompletion(event));
      void completed.then(() => this.finish(handle), () => this.finish(handle));
      return { ...(handle.model ? { model: handle.model } : {}), completed };
    } catch (error) {
      this.busy = false;
      throw error;
    }
  }

  private finish(handle: CodexRunHandle): void { if (this.active === handle) { this.active = undefined; this.busy = false; } }
}

const defaultCodexHealth = () => checkCodexHealth({ includeExternalModels: true });

export function createCodexPlugin(health = defaultCodexHealth): AgentPlugin {
  return {
    id: "codex", displayName: "Codex", pluginVersion: WORKSHOP_VERSION, defaultCommand: "codex", executableEnvKey: "WORKSHOP_CODEX_PATH",
    runtimeVersion: { min: CODEX_MIN_VERSION }, capabilities: { continuation: true, steering: true, interruption: true, approvals: true, userInput: true, tokenUsage: true, structuredFileEvents: true },
    description: "Codex App Server", backendOptions: { customArgs: { type: "string[]" } }, healthTimeoutMs: 7_500, validateConfig: validateCodexConfig, health, createSession: (options) => new CodexAgentSession(options)
  };
}

export function codexAgentEvent(event: NormalizedCodexEvent): AgentEvent {
  const item = asObject(event.payload.item);
  const text = event.type === "agent.message.delta" ? event.payload.delta : event.type === "agent_message.completed" ? agentMessageText(item.text ?? item.content) : undefined;
  const usage = event.type === "token.usage" ? codexTokenUsage(event.payload) : undefined;
  const questions = event.type === "input.requested" && Array.isArray(event.payload.questions) ? event.payload.questions.filter(isObject).filter((question): question is JsonObject & { id: string } => typeof question.id === "string" && Boolean(question.id)) : undefined;
  return {
    type: event.type, summary: event.summary, sourceType: event.method, payload: event.payload, ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
    ...(typeof text === "string" ? { text } : {}), ...(usage ? { tokenUsage: usage } : {}), ...(questions ? { questions } : {}),
    ...(event.type === "approval.requested" ? { approvalKind: codexApprovalKind(event.method) } : {})
  };
}

function agentMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part) => isObject(part) && typeof part.text === "string" ? part.text : "").join("") : "";
}

function codexApprovalKind(method: string): NonNullable<AgentEvent["approvalKind"]> {
  if (method.includes("commandExecution")) return "command";
  if (method.includes("fileChange")) return "file_change";
  if (method.includes("permissions")) return "permission";
  return "mcp_tool_call";
}

function codexTokenUsage(payload: JsonObject) {
  const total = asObject(asObject(payload.tokenUsage).total);
  const input = tokenCount(total.inputTokens); const output = tokenCount(total.outputTokens); const cached = tokenCount(total.cachedInputTokens);
  return input === undefined || output === undefined || cached === undefined ? undefined : { input, output, cached };
}

function tokenCount(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }

export function codexAgentCompletion(event: NormalizedCodexEvent): AgentCompletion {
  const status = event.type === "turn.completed" ? "succeeded" : event.type === "turn.interrupted" ? "interrupted" : "failed";
  return { status, event: codexAgentEvent(event) };
}

function healthFailure(error: string, capabilities: AgentBackendHealth["capabilities"], runtimeVersion?: string): CodexHealth {
  return { id: "codex", ok: false, pluginVersion: WORKSHOP_VERSION, ...(runtimeVersion ? { runtimeVersion, version: runtimeVersion } : {}), capabilities, error };
}

function safeHealthError(error: unknown, stage: "cli" | "app-server", timeoutMs: number): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Timed out") return `Codex health check timed out after ${timeoutMs} ms`;
  return stage === "cli" ? `Codex CLI could not be started or queried: ${message}` : `Codex App Server initialization or protocol check failed: ${message}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out")), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}

function remaining(deadline: number): number {
  const timeout = deadline - Date.now();
  if (timeout <= 0) throw new Error("Timed out");
  return timeout;
}

function cmdQuote(value: string): string { return `"${value.replaceAll('\"', '\"\"')}"`; }

async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    await runFile("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }).catch(() => { child.kill("SIGKILL"); });
  } else if (child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { child.kill("SIGKILL"); }
  }
  await waitForExit(child, 1_000);
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([new Promise<true>((resolve) => child.once("exit", () => resolve(true))), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}

function isApprovalMethod(method: string, payload: JsonObject = {}): boolean {
  return method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval" || method === "item/permissions/requestApproval"
    || method === "mcpServer/elicitation/request" && asObject(payload._meta).codex_request_type === "approval_request";
}

function isApprovalRequest(method: string, payload: JsonObject): boolean { return method.endsWith("/requestApproval") || isApprovalMethod(method, payload); }

function isUserInputMethod(method: string): boolean { return method === "item/tool/requestUserInput"; }

function approvalSummary(method: string): string {
  if (method.includes("commandExecution")) return "Command approval requested";
  if (method.includes("fileChange")) return "File change approval requested";
  if (method.includes("permissions")) return "Permission approval requested";
  if (method === "mcpServer/elicitation/request") return "MCP tool approval requested";
  throw new Error(`Unsupported approval method: ${method}`);
}

function approvalResponse(method: string, response: unknown): unknown {
  if (method !== "mcpServer/elicitation/request") return response;
  const value = asObject(response);
  const action = value.decision === "accept" ? "accept" : value.decision === "decline" ? "decline" : "cancel";
  return action === "accept" ? { action, content: asObject(value.content) } : { action };
}

function snake(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Codex App Server did not return a ${name}`);
  return value;
}

function compact<T extends JsonObject>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null)) as T;
}
