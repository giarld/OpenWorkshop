import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";

const runFile = promisify(execFile);
const CONTEXT_FILES = ["requirement.md", "task.md", "dependencies.md", "previous-runs.md", "project-profile.md", "messages.md"] as const;
const RESERVED_ARGS = new Set(["--listen", "--cwd", "-C", "--model", "-m", "--sandbox", "-s", "--ask-for-approval", "-a", "--output-schema", "--json"]);
export const COMMAND_APPROVAL_POLICY = "on-request";
export const COMMAND_SANDBOX_MODE = "workspace-write" as const;
export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export const APPROVAL_POLICIES = ["untrusted", "on-request", "never"] as const;
export type SandboxMode = typeof SANDBOX_MODES[number];
export type ApprovalPolicy = typeof APPROVAL_POLICIES[number];
export function codexAppServerArgs(sandboxMode: SandboxMode = COMMAND_SANDBOX_MODE, networkAccess = true, customArgs: readonly string[] = []): string[] {
  return ["app-server", "-c", `sandbox_mode=${JSON.stringify(sandboxMode)}`, "-c", 'approval_policy="never"', ...(sandboxMode === "workspace-write" ? ["-c", `sandbox_workspace_write.network_access=${networkAccess}`] : []), ...customArgs];
}
export const CODEX_APP_SERVER_ARGS = codexAppServerArgs();

type JsonObject = Record<string, unknown>;
type RequestId = string | number;
type ContextFile = typeof CONTEXT_FILES[number];

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
  threadId?: string;
  model?: string;
  effort?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
};

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

  private constructor(process: ChildProcessWithoutNullStreams, options: CodexAppServerOptions) {
    this.process = process;
    this.options = options;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    createInterface({ input: process.stdout }).on("line", (line) => this.receive(line));
    process.stderr.resume();
    process.once("error", (error) => this.finish(error, "process/error", {}));
    process.once("exit", (code, signal) => this.finish(new Error(`Codex App Server exited unexpectedly (${signal ?? code ?? "unknown"})`), "process/exit", { code, signal }));
  }

  static launch(options: CodexAppServerOptions = {}): CodexAppServer {
    const invocation = resolveInvocation(options.command ?? "codex", options.args ?? [...CODEX_APP_SERVER_ARGS], options.env);
    const child = spawn(invocation.file, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    return new CodexAppServer(child, options);
  }

  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "project_workshop", title: "OpenWorkshop", version: "0.1.0" } });
    this.notify("initialized", {});
  }

  async models(): Promise<CodexModel[]> {
    const result = asObject(await this.request("model/list", { includeHidden: false }));
    return Array.isArray(result.data) ? result.data.filter(isObject).map((model) => model as CodexModel) : [];
  }

  async startRun(options: CodexRunOptions): Promise<CodexRunHandle> {
    let model = options.model ?? (options.threadId ? this.threadModels.get(options.threadId) : (await this.models()).find((item) => item.isDefault)?.id);
    const started = options.threadId ? undefined : asObject(await this.request("thread/start", compact({
      cwd: options.cwd,
      model,
      approvalPolicy: options.approvalPolicy ?? COMMAND_APPROVAL_POLICY,
      sandbox: options.sandbox ?? COMMAND_SANDBOX_MODE,
      serviceName: "project_workshop"
    })));
    const threadId = options.threadId ?? requiredString(asObject(started?.thread).id, "thread id");
    const turn = asObject(asObject(await this.request("turn/start", compact({
      threadId,
      input: [{ type: "text", text: options.prompt }],
      cwd: options.cwd,
      model,
      effort: options.effort
    }))).turn);
    const turnId = requiredString(turn.id, "turn id");
    if (typeof started?.model === "string") model = started.model;
    if (model) this.threadModels.set(threadId, model);
    return { threadId, turnId, ...(model ? { model } : {}), completed: this.waitForTurn(turnId) };
  }

  async steer(threadId: string, turnId: string, text: string): Promise<void> {
    await this.request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text }] });
  }

  async interrupt(threadId: string, turnId: string, timeoutMs = 5_000): Promise<void> {
    const completed = this.createTurnWaiter(turnId);
    let timer: NodeJS.Timeout | undefined;
    try {
      const stopped = await Promise.race([
        Promise.all([this.request("turn/interrupt", { threadId, turnId }), completed.promise]).then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })
      ]);
      if (!stopped) throw new Error(`Codex turn ${turnId} did not stop within ${timeoutMs}ms`);
    } catch (error) {
      if (!this.exited) this.process.kill();
      throw error;
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
    this.process.stdin.end();
    this.process.kill();
    await new Promise<void>((resolve) => this.process.once("exit", () => resolve()));
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
    : method === "turn/completed" ? [turnStatus === "interrupted" ? "turn.interrupted" : turnStatus === "failed" ? "turn.failed" : "turn.completed", `Turn ${turnStatus || "completed"}`]
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

export function snapshotRoleConfig(globalConfig: CodexRoleConfig, projectConfig?: Partial<CodexRoleConfig>): Readonly<CodexRoleConfig> {
  const customArgs = [...(projectConfig?.customArgs ?? globalConfig.customArgs ?? [])];
  validateCustomArgs(customArgs);
  return Object.freeze(compact({
    prompt: projectConfig?.prompt ?? globalConfig.prompt,
    model: projectConfig?.model ?? globalConfig.model,
    reasoningEffort: projectConfig?.reasoningEffort ?? globalConfig.reasoningEffort,
    customArgs: Object.freeze(customArgs),
    sandboxMode: projectConfig?.sandboxMode ?? globalConfig.sandboxMode,
    approvalPolicy: projectConfig?.approvalPolicy ?? globalConfig.approvalPolicy,
    networkAccess: projectConfig?.networkAccess ?? globalConfig.networkAccess
  })) as Readonly<CodexRoleConfig>;
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

export async function createRunContext(projectRoot: string, runId: string, files: Partial<Record<ContextFile, string>>) {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new TypeError("runId contains unsupported characters");
  const runsRoot = join(projectRoot, ".openworkshop", "runs");
  const directory = join(runsRoot, runId);
  await mkdir(runsRoot, { recursive: true });
  await mkdir(directory);
  try {
    const names = CONTEXT_FILES.filter((name) => files[name] !== undefined);
    await Promise.all(names.map((name) => writeFile(join(directory, name), files[name]!, { flag: "wx" })));
    await writeFile(join(directory, "context-manifest.json"), `${JSON.stringify({ runId, files: names })}\n`, { flag: "wx" });
    return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function recoverRunContexts(projectRoot: string): Promise<number> {
  const runsRoot = join(projectRoot, ".openworkshop", "runs");
  const entries = await readdir(runsRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const stale = entries.filter((entry) => entry.isDirectory());
  await Promise.all(stale.map((entry) => rm(join(runsRoot, entry.name), { recursive: true, force: true })));
  return stale.length;
}

export type CodexHealth = { ok: boolean; version?: string; models?: CodexModel[]; error?: string };

export async function checkCodexHealth(options: {
  command?: string;
  runCommand?: (file: string, args: string[]) => Promise<string>;
  launch?: () => CodexAppServer;
} = {}): Promise<CodexHealth> {
  let client: CodexAppServer | undefined;
  try {
    const command = options.command ?? "codex";
    const version = (await (options.runCommand ?? execute)(command, ["--version"])).trim();
    client = options.launch?.() ?? CodexAppServer.launch({ command });
    await client.initialize();
    const models = await client.models();
    return { ok: true, version, models };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client?.close();
  }
}

export function registerCodexRoutes(server: FastifyInstance, health = checkCodexHealth): void {
  server.get("/api/runtime/codex-health", async () => health());
}

async function execute(file: string, args: string[]): Promise<string> {
  const invocation = resolveInvocation(file, args);
  const { stdout } = await runFile(invocation.file, invocation.args, { encoding: "utf8", windowsHide: true });
  return stdout;
}

function resolveInvocation(file: string, args: string[], env = process.env): { file: string; args: string[] } {
  if (process.platform !== "win32" || isAbsolute(file) || file.includes("\\") || file.includes("/")) return { file, args };
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const executable = join(directory, `${file}.exe`);
    if (existsSync(executable)) return { file: executable, args };
    if (file.toLowerCase() === "codex") {
      const script = join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (existsSync(script)) return { file: process.execPath, args: [script, ...args] };
    }
  }
  return { file, args };
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
