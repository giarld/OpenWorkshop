import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { isAbsolute } from "node:path";
import { AgentError, COMMAND_SANDBOX_MODE, normalizeSemver, capabilityError, type AgentBackendHealth, type AgentCompletion, type AgentEvent, type AgentModel, type AgentPlugin, type AgentPluginConfig, type AgentSession, type AgentSessionOptions, type AgentStartOptions, type AgentTurn, type SandboxMode } from "./agent.ts";
import { terminateProcessTree, waitForExit } from "./codex.ts";
import { WORKSHOP_VERSION } from "./version.ts";

const RESERVED_ARGS = new Set([
  "-p", "--print", "--output-format", "--input-format", "--include-partial-messages", "--verbose", "--model", "--effort", "--resume", "-r",
  "--permission-mode", "--settings", "--setting-sources", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools",
  "--tools", "--add-dir", "--mcp-config", "--strict-mcp-config", "--plugin-dir", "--plugin-url", "--agents", "--agent",
  "--system-prompt", "--system-prompt-file", "--append-system-prompt", "--append-system-prompt-file", "--append-subagent-system-prompt",
  "--append-subagent-system-prompt-file", "--permission-prompt-tool", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--restricted",
  "--safe-mode", "--bare", "--json-schema", "--fallback-model", "--max-budget-usd", "--no-session-persistence", "--continue", "-c", "--session-id", "--fork-session", "--replay-user-messages",
  "--worktree", "-w", "--cloud", "--remote", "--environment", "--ref", "--remote-control", "--rc", "--bg", "--background", "--exec", "--teleport",
  "--version", "-v", "--help", "-h", "--init", "--init-only", "--maintenance", "--chrome", "--ide", "--tmux", "--teammate-mode"
]);
export const CLAUDE_MIN_VERSION = "2.0.0";
export const CLAUDE_HEALTH_TIMEOUT_MS = 5_000;
const CLAUDE_OUTPUT_DRAIN_TIMEOUT_MS = 5_000;
const CLAUDE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_MODELS: AgentModel[] = ["sonnet", "opus", "haiku"].map((id) => ({ id, displayName: id[0]!.toUpperCase() + id.slice(1), defaultReasoningEffort: "high", supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS.map((reasoningEffort) => ({ reasoningEffort })) }));

type JsonObject = Record<string, unknown>;
export type NormalizedClaudeEvent = { type: string; summary: string; sourceType: string; payload: JsonObject; text?: string; sessionId?: string; tokenUsage?: { input: number; output: number; cached: number } };

export function normalizeClaudeEvent(payload: JsonObject): NormalizedClaudeEvent {
  const type = typeof payload.type === "string" ? payload.type : "unknown";
  const event = payload.event && typeof payload.event === "object" ? payload.event as JsonObject : undefined;
  const eventType = typeof event?.type === "string" ? event.type : "";
  const delta = event?.delta && typeof event.delta === "object" ? event.delta as JsonObject : undefined;
  const message = payload.message && typeof payload.message === "object" ? payload.message as JsonObject : undefined;
  const content = Array.isArray(message?.content) ? message.content.filter((item): item is JsonObject => Boolean(item) && typeof item === "object").map((item) => typeof item.text === "string" ? item.text : "").join("") : undefined;
  const text = typeof payload.result === "string" ? payload.result : typeof payload.delta === "string" ? payload.delta : typeof delta?.text === "string" ? delta.text : content || undefined;
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;
  const usage = payload.usage && typeof payload.usage === "object" ? payload.usage as JsonObject : undefined;
  const uncached = numberValue(usage?.input_tokens); const created = numberValue(usage?.cache_creation_input_tokens) ?? 0; const output = numberValue(usage?.output_tokens); const cached = numberValue(usage?.cache_read_input_tokens) ?? 0;
  const input = uncached === undefined ? undefined : uncached + created + cached;
  const tokenUsage = input === undefined || !Number.isSafeInteger(input) || output === undefined ? undefined : { input, output, cached };
  const mapped = type === "system" ? ["session.started", "Claude Code session started"] : type === "stream_event" && eventType === "content_block_delta" ? ["agent.message.delta", "Agent message"] : type === "assistant" ? ["agent.message", "Agent message"] : type === "result" ? [payload.subtype === "success" ? "turn.completed" : "turn.failed", payload.subtype === "success" ? "Turn completed" : "Turn failed"] : ["claude.event", type];
  return { type: mapped[0]!, summary: mapped[1]!, sourceType: type, payload, ...(text === undefined ? {} : { text }), ...(sessionId ? { sessionId } : {}), ...(tokenUsage ? { tokenUsage } : {}) };
}

export function claudeAgentEvent(event: NormalizedClaudeEvent): AgentEvent { return { type: event.type, summary: event.summary, sourceType: event.sourceType, payload: event.payload, ...(event.text === undefined ? {} : { text: event.text }), ...(event.tokenUsage ? { tokenUsage: event.tokenUsage } : {}) }; }
export function claudeAgentCompletion(event: NormalizedClaudeEvent): AgentCompletion { return { status: event.type === "turn.completed" ? "succeeded" : event.type === "turn.interrupted" ? "interrupted" : "failed", event: claudeAgentEvent(event) }; }

export function validateClaudeConfig(config: AgentPluginConfig): void {
  if (config.model !== undefined && config.model !== null && !config.model.trim()) throw new TypeError("Claude Code model must not be empty");
  const backend = config.backendOptions ?? {};
  const unknown = Object.keys(backend).find((key) => key !== "customArgs");
  if (unknown) throw new TypeError("Unsupported Claude Code backend option: " + unknown);
  const args = backend.customArgs;
  if (args !== undefined && (!Array.isArray(args) || args.length > 32 || args.some((item) => typeof item !== "string" || !item || item.length > 256))) throw new TypeError("Claude Code backend customArgs must contain at most 32 non-empty strings of 256 characters");
  const conflict = (args as string[] | undefined)?.find((arg) => RESERVED_ARGS.has(arg.split("=", 1)[0]!));
  if (conflict) throw new TypeError("Custom Claude Code argument conflicts with managed settings: " + conflict);
}

export function claudePrompt(options: Pick<AgentStartOptions, "prompt" | "input">): string {
  const input = options.input ?? [];
  const text = input.filter((item): item is { type: "text"; text: string } => item.type === "text").map((item) => item.text).join("\n\n").trim();
  const images = input.filter((item): item is { type: "localImage"; path: string } => item.type === "localImage");
  const prompt = text || options.prompt;
  if (!images.length) return prompt;
  return `${prompt}\n\nLocal image attachments (use the Read tool to inspect them):\n${images.map((item) => `- ${item.path}`).join("\n")}`;
}

export function claudePermissionMode(sandbox: SandboxMode, approvalPolicy: AgentStartOptions["approvalPolicy"] = "on-request"): string {
  if (sandbox === "read-only") return "plan";
  if (sandbox === "danger-full-access") return "bypassPermissions";
  return approvalPolicy === "never" ? "dontAsk" : approvalPolicy === "untrusted" ? "manual" : "acceptEdits";
}

function claudeSettings(networkAccess: boolean | undefined): string[] {
  return networkAccess === false && process.platform !== "win32" ? ["--settings", JSON.stringify({ sandbox: { enabled: true, network: { allowedDomains: [] }, allowUnsandboxedCommands: false, failIfUnavailable: true } })] : [];
}

export function resolveClaudeCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.WORKSHOP_CLAUDE_CODE_PATH?.trim();
  if (!configured) return "claude";
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(configured)) throw new Error("WORKSHOP_CLAUDE_CODE_PATH does not support .cmd or .bat command shims");
  if (!isAbsolute(configured) || !existsSync(configured) || !statSync(configured).isFile()) throw new Error("WORKSHOP_CLAUDE_CODE_PATH must name an existing absolute executable path");
  return configured;
}

export type ClaudeHealthOptions = { command?: string; runCommand?: (file: string, args: string[]) => Promise<string>; env?: NodeJS.ProcessEnv; timeoutMs?: number };
export async function checkClaudeHealth(options: ClaudeHealthOptions = {}): Promise<AgentBackendHealth> {
  try {
    const command = options.command ?? resolveClaudeCommand(options.env ?? process.env);
    const raw = options.runCommand ? await options.runCommand(command, ["--version"]) : await executeClaudeCommand(command, ["--version"], options.timeoutMs ?? CLAUDE_HEALTH_TIMEOUT_MS, options.env);
    const runtimeVersion = normalizeSemver(raw);
    if (!runtimeVersion) return claudeHealth(false, "Claude Code runtime version could not be parsed");
    if (compareVersion(runtimeVersion, CLAUDE_MIN_VERSION) < 0) return claudeHealth(false, "Claude Code runtime " + runtimeVersion + " is incompatible; requires >= " + CLAUDE_MIN_VERSION, runtimeVersion);
    return claudeHealth(true, undefined, runtimeVersion);
  } catch (error) { return claudeHealth(false, "Claude Code CLI could not be started or queried: " + (error instanceof Error ? error.message : String(error))); }
}

class ClaudeCodeSession implements AgentSession {
  private process: ChildProcess | undefined;
  private sessionId?: string;
  private interrupted = false;
  private tokenUsage = { input: 0, output: 0, cached: 0 };
  private readonly options: AgentSessionOptions;
  private readonly launch: typeof spawn;
  constructor(options: AgentSessionOptions, launch: typeof spawn) { this.options = options; this.launch = launch; }
  initialize(): Promise<void> { return Promise.resolve(); }
  start(options: AgentStartOptions): Promise<AgentTurn> { return this.run(options); }
  continue(options: AgentStartOptions): Promise<AgentTurn> { return this.sessionId ? this.run(options) : Promise.reject(capabilityError()); }
  steer(): Promise<void> { return Promise.reject(capabilityError()); }
  async interrupt(): Promise<void> {
    const child = this.process;
    if (!child) throw new AgentError("agent_session_busy", "Agent session has no active turn");
    this.interrupted = true;
    child.kill("SIGINT");
    if (!await waitForExit(child, 1_000)) await terminateProcessTree(child);
  }
  async close(): Promise<void> {
    const child = this.process;
    if (child) await terminateProcessTree(child);
  }

  private run(options: AgentStartOptions): Promise<AgentTurn> {
    if (this.process) return Promise.reject(new AgentError("agent_session_busy", "Agent session is already running"));
    this.interrupted = false;
    const backend = this.options.backendOptions ?? {};
    const sandbox = options.sandbox ?? this.options.sandboxMode ?? COMMAND_SANDBOX_MODE;
    if (this.options.networkAccess === false && process.platform === "win32") this.options.onEvent?.({ type: "configuration.warning", summary: "Claude Code network isolation is unavailable on native Windows", sourceType: "claude", payload: { networkAccess: false } });
    const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose", ...(options.model ? ["--model", options.model] : []), ...(options.reasoningEffort ? ["--effort", options.reasoningEffort] : []), "--permission-mode", claudePermissionMode(sandbox, options.approvalPolicy), ...claudeSettings(this.options.networkAccess), ...(options.developerInstructions ? ["--append-system-prompt", options.developerInstructions] : []), ...(this.sessionId ? ["--resume", this.sessionId] : []), ...(Array.isArray(backend.customArgs) ? backend.customArgs as string[] : []), claudePrompt(options)];
    const command = resolveClaudeCommand();
    const child = this.launch(command, args, { cwd: options.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    this.process = child;
    child.stderr.resume();
    let resolveCompletion!: (completion: AgentCompletion) => void;
    const completed = new Promise<AgentCompletion>((resolve) => { resolveCompletion = resolve; });
    return new Promise<AgentTurn>((resolve, reject) => {
      let startSettled = false;
      let turnCompleted = false;
      let stdoutClosed = false;
      let exitResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      let drainTimer: NodeJS.Timeout | undefined;
      const release = () => { if (this.process === child) this.process = undefined; };
      const finish = (event: NormalizedClaudeEvent) => { if (turnCompleted) return; turnCompleted = true; if (drainTimer) clearTimeout(drainTimer); if (event.sessionId) this.sessionId = event.sessionId; if (exitResult) release(); resolveCompletion(claudeAgentCompletion(event)); };
      const finishExited = () => {
        if (!exitResult || turnCompleted) return;
        const { code, signal } = exitResult;
        if (this.interrupted) finish({ type: "turn.interrupted", summary: "Turn interrupted", sourceType: "process", payload: { code, signal } });
        else if (code !== 0) finish({ type: "turn.failed", summary: "Claude Code exited unexpectedly (" + (signal ?? code ?? "unknown") + ")", sourceType: "process", payload: { code, signal } });
        else if (stdoutClosed) finish({ type: "turn.failed", summary: "Claude Code exited without a result", sourceType: "process", payload: { code, signal } });
        else if (!drainTimer) drainTimer = setTimeout(() => finish({ type: "turn.failed", summary: "Claude Code stdout did not close after exit", sourceType: "process", payload: { code, signal } }), CLAUDE_OUTPUT_DRAIN_TIMEOUT_MS);
      };
      createInterface({ input: child.stdout }).on("line", (line) => { try { let event = normalizeClaudeEvent(JSON.parse(line) as JsonObject); if (event.tokenUsage && (event.type === "turn.completed" || event.type === "turn.failed")) { this.tokenUsage = { input: this.tokenUsage.input + event.tokenUsage.input, output: this.tokenUsage.output + event.tokenUsage.output, cached: this.tokenUsage.cached + event.tokenUsage.cached }; event = { ...event, tokenUsage: this.tokenUsage }; } if (event.sessionId) this.sessionId = event.sessionId; this.options.onEvent?.(claudeAgentEvent(event)); if (event.type === "turn.completed" || event.type === "turn.failed") finish(event); } catch { this.options.onEvent?.({ type: "protocol.error", summary: "Invalid JSON from Claude Code", sourceType: "stdout", payload: { line } }); } }).on("close", () => { stdoutClosed = true; finishExited(); });
      child.once("spawn", () => { startSettled = true; resolve({ completed }); });
      child.once("error", (error) => { if (this.process === child) this.process = undefined; void terminateProcessTree(child); if (!startSettled) { startSettled = true; reject(error); } else finish({ type: "turn.failed", summary: "Claude Code process failed: " + error.message, sourceType: "process", payload: {} }); });
      child.once("exit", (code, signal) => { exitResult = { code, signal }; if (turnCompleted) release(); else finishExited(); });
    });
  }
}

export function createClaudeCodePlugin(health = () => checkClaudeHealth(), launch: typeof spawn = spawn): AgentPlugin {
  return { id: "claude-code", displayName: "Claude Code", pluginVersion: WORKSHOP_VERSION, defaultCommand: "claude", executableEnvKey: "WORKSHOP_CLAUDE_CODE_PATH", runtimeVersion: { min: CLAUDE_MIN_VERSION }, capabilities: { continuation: true, steering: false, interruption: true, approvals: false, userInput: false, tokenUsage: true, structuredFileEvents: false }, description: "Claude Code headless CLI", backendOptions: { customArgs: { type: "string[]" } }, healthTimeoutMs: 7_500, validateConfig: validateClaudeConfig, health, createSession: (options) => new ClaudeCodeSession(options, launch) };
}

function claudeHealth(ok: boolean, error?: string, runtimeVersion?: string): AgentBackendHealth { return { id: "claude-code", ok, pluginVersion: WORKSHOP_VERSION, ...(runtimeVersion ? { runtimeVersion } : {}), capabilities: { ok, models: ok ? CLAUDE_MODELS : [], reasoningEfforts: ok ? CLAUDE_REASONING_EFFORTS : [] }, ...(error ? { error } : {}) }; }
export function executeClaudeCommand(file: string, args: string[], timeoutMs: number, env = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let stdout = "";
    let stderr = "";
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env, detached: process.platform !== "win32" });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; if (stdout.length > 1_048_576) fail(new Error("Claude Code version output exceeded 1 MiB")); });
    child.stderr.on("data", (chunk: string) => { if (stderr.length <= 1_048_576) stderr += chunk; });
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(stdout); else reject(new Error("Command failed (" + (signal ?? code ?? "unknown") + ")" + (stderr ? ": " + stderr.trim() : "")));
    });
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void terminateProcessTree(child).finally(() => reject(new Error("Timed out after " + timeoutMs + " ms")));
    }, timeoutMs);

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      void terminateProcessTree(child).finally(() => reject(error));
    }
  });
}
function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function compareVersion(left: string, right: string): number { const a = left.split(".").map(Number); const b = right.split(".").map(Number); return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!; }
