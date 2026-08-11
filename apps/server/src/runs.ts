import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { APPROVAL_POLICIES, COMMAND_APPROVAL_POLICY, COMMAND_SANDBOX_MODE, SANDBOX_MODES, CodexAppServerClosedError, codexAppServerArgs, createRunContext, recoverRunContexts, validateCustomArgs, type ApprovalPolicy, type CodexAppServer, type CodexAppServerOptions, type CodexRunHandle, type NormalizedCodexEvent, type SandboxMode } from "./codex.ts";
import type { AgentMentionHandler } from "./comments.ts";
import { SettingsStore } from "./database.ts";
import { notify } from "./notifications.ts";
import { registerSchedulerRoutes, Scheduler } from "./scheduler.ts";
import { configuredSecrets, isHighRiskCommand, normalizeCommands, redactSensitive } from "./security.ts";

type RunStatus = "queued" | "preparing" | "running" | "waiting_approval" | "waiting_input" | "succeeded" | "failed" | "cancelled" | "interrupted";
type JsonObject = Record<string, unknown>;

type RunRow = {
  id: string;
  project_id: string;
  commission_id: string;
  task_id: string;
  role: string;
  trigger_type: string;
  trigger_ref_id: string | null;
  status: RunStatus;
  attempt_no: number;
  codex_version: string | null;
  config_snapshot_json: string;
  context_snapshot_json: string;
  pid: number | null;
  started_at: string | null;
  finished_at: string | null;
  failure_code: string | null;
  failure_summary: string | null;
  token_input: number | null;
  token_output: number | null;
  token_cached: number | null;
  workspace_path: string | null;
};

type ApprovalRow = {
  id: string;
  run_id: string;
  codex_request_id: string;
  kind: string;
  request_json: string;
  status: string;
  decision_json: string | null;
  created_at: string;
  decided_at: string | null;
};

export type RunEvent = {
  id: number;
  run_id: string;
  event_type: string;
  summary: string;
  payload: JsonObject;
  redacted: boolean;
  created_at: string;
};

export type RunController = {
  steer(runId: string, message: string): Promise<void>;
  interrupt(runId: string, mode: "pause" | "cancel"): Promise<void>;
  resume(taskId: string, previousRunId: string): Promise<string>;
  decideApproval(runId: string, requestId: string, decision: "accepted" | "declined", details?: JsonObject): Promise<void>;
  answerInput(runId: string, requestId: string, answers: UserInputAnswers): Promise<RunStatus | void>;
};

type UserInputAnswers = Record<string, { answers: string[] }>;

type TaskContext = {
  title: string; description: string; acceptance_json: string; read_only: number;
  commission_title: string; requirement: string; requirement_acceptance: string;
  project_name: string; project_root: string; vcs_type: string; vcs_root: string | null; profile_json: string | null;
};
type RunContextFiles = Parameters<typeof createRunContext>[2];

type RunClient = Pick<CodexAppServer, "initialize" | "startRun" | "steer" | "interrupt" | "close">;
export type RunClientLauncher = (options: CodexAppServerOptions) => RunClient;

type ActiveRun = { client: RunClient; handle?: CodexRunHandle; cleanupContext(): Promise<void> };

export class CodexRunController {
  private readonly active = new Map<string, ActiveRun>();
  private readonly pendingCompletions = new Set<Promise<void>>();
  private readonly approvalResponders = new Map<string, (decision: unknown) => void>();
  private readonly inputResponders = new Map<string, { respond: (answers: unknown) => void; questionIds: Set<string> }>();
  private readonly interruptModes = new Map<string, "pause" | "cancel">();
  private readonly database: DatabaseSync;
  private readonly hub: EventHub;
  private readonly launch: RunClientLauncher;
  private readonly onTerminal: (runId: string) => Promise<void>;
  private closing = false;

  constructor(database: DatabaseSync, hub: EventHub, launch: RunClientLauncher, onTerminal: (runId: string) => Promise<void> = async () => undefined) {
    this.database = database;
    this.hub = hub;
    this.launch = launch;
    this.onTerminal = onTerminal;
  }

  async steer(runId: string, message: string): Promise<void> {
    const run = this.activeRun(runId);
    await run.client.steer(run.handle!.threadId, run.handle!.turnId, message);
  }

  async interrupt(runId: string, mode: "pause" | "cancel"): Promise<void> {
    const run = this.activeRun(runId);
    this.interruptModes.set(runId, mode);
    try {
      await run.client.interrupt(run.handle!.threadId, run.handle!.turnId);
    } catch (error) {
      this.interruptModes.delete(runId);
      throw error;
    }
  }

  async start(runId: string, cwd: string): Promise<void> {
    const run = runById(this.database, runId);
    const task = this.database.prepare(`
      SELECT tasks.title, tasks.description, tasks.acceptance_json, tasks.read_only,
        commissions.title AS commission_title, requirement.content_markdown AS requirement,
        requirement.acceptance_json AS requirement_acceptance, projects.name AS project_name,
        projects.real_path AS project_root, projects.vcs_type, projects.vcs_root, projects.profile_json
      FROM tasks
      JOIN commissions ON commissions.id = tasks.commission_id
      JOIN projects ON projects.id = commissions.project_id
      JOIN root_paths ON root_paths.id = projects.root_path_id
      JOIN requirement_versions AS requirement ON requirement.id = commissions.active_requirement_version_id
      WHERE tasks.id = ? AND tasks.archived_at IS NULL AND projects.archived_at IS NULL AND root_paths.enabled = 1
    `).get(run.task_id) as TaskContext | undefined;
    if (!task) throw notFound("Task not found");
    const contextFiles = runContextFiles(this.database, run, task);
    const context = await createRunContext(task.project_root, runId, contextFiles);
    const contextIndex = Object.keys(contextFiles).map((name) => `- ${join(context.directory, name)}`).join("\n");
    const config = object(JSON.parse(run.config_snapshot_json), "config snapshot");
    const customArgs = config.customArgs === undefined ? [] : stringArray(config.customArgs, "config customArgs");
    const sandboxMode = SANDBOX_MODES.includes(config.sandboxMode as SandboxMode) ? config.sandboxMode as SandboxMode : COMMAND_SANDBOX_MODE;
    const approvalPolicy = APPROVAL_POLICIES.includes(config.approvalPolicy as ApprovalPolicy) ? config.approvalPolicy as ApprovalPolicy : COMMAND_APPROVAL_POLICY;
    const networkAccess = typeof config.networkAccess === "boolean" ? config.networkAccess : true;
    validateCustomArgs(customArgs);
    let client: RunClient;
    try {
      client = this.launch({
        cwd,
        args: codexAppServerArgs(sandboxMode, networkAccess, customArgs),
        onEvent: (event) => this.onEvent(runId, event),
        onApproval: (event, respond) => this.onApproval(runId, event, respond),
        onInput: (event, respond) => this.onInput(runId, event, respond)
      });
    } catch (error) {
      await context.cleanup();
      throw error;
    }
    this.active.set(runId, { client, cleanupContext: context.cleanup });
    try {
      await client.initialize();
      const handle = await client.startRun({
        cwd,
        sandbox: sandboxMode,
        approvalPolicy,
        prompt: run.role === "supervisor"
          ? `You are the project supervisor Agent. Reconcile the current task before it is executed again so completed work is not repeated. Read every context file, inspect the current workspace without modifying it, distinguish infrastructure interruption from implementation or review failure, and choose exactly one next action.\n\nCurrent objective: ${task.title}\nExecution boundary: read-only coordination; do not modify project files, run destructive commands, or perform the task itself.\nContext files:\n${contextIndex}\n\nReturn JSON only: {"action":"resume_reviewer|resume_developer|rework_developer|restart_developer|replan|wait_human","summary":"string"}. Use resume_reviewer when review was interrupted or failed for infrastructure reasons; resume_developer when an interrupted developer should continue; rework_developer when review findings require code changes; restart_developer only when prior development cannot be reused; replan when the task definition or dependencies must change; wait_human when a human decision or operation is required.`
          : run.role === "reviewer"
            ? `You are the independent test/review Agent. Verify the current task against its acceptance criteria and project instructions. Read every context file before acting.\n\nCurrent objective: ${task.title}\nExecution boundary: inspect the current workspace; do not implement fixes.\nContext files:\n${contextIndex}\n\nReturn JSON only: {"passed":boolean,"summary":"string","checks":[],"findings":[{"severity":"blocking|warning","file":"path","line":null,"message":"string"}]}. Only blocking findings make passed false.`
            : `You are the developer Agent. Read every context file before acting.\n\nCurrent objective: ${task.title}\nExecution boundary: ${task.read_only ? "read-only analysis; do not modify project files" : "work only inside the provided workspace and complete the task acceptance criteria"}.\nContext files:\n${contextIndex}\n\nComplete the task and report the key result, checks, constraints, and remaining risks in the final message. The final message is saved to the task discussion; mention @负责人 when human attention or a decision is required.`,
        ...(typeof config.model === "string" ? { model: config.model } : {}),
        ...(typeof config.reasoningEffort === "string" ? { effort: config.reasoningEffort } : {})
      });
      if (handle.model && config.model !== handle.model) {
        config.model = handle.model;
        this.database.prepare("UPDATE runs SET config_snapshot_json = ? WHERE id = ?").run(JSON.stringify(config), runId);
      }
      this.active.set(runId, { client, handle, cleanupContext: context.cleanup });
      this.database.prepare("UPDATE runs SET status = 'running' WHERE id = ? AND status = 'preparing'").run(runId);
      appendRunEvent(this.database, this.hub, runId, "run.status", "Run running", { status: "running" });
      void handle.completed.then(
        (event) => this.trackCompletion(this.complete(runId, event)),
        (error) => this.trackCompletion(this.fail(runId, error))
      );
    } catch (error) {
      await this.fail(runId, error);
      throw error;
    }
  }

  async decideApproval(runId: string, requestId: string, decision: "accepted" | "declined", details?: JsonObject): Promise<void> {
    this.activeRun(runId);
    const key = approvalKey(runId, requestId);
    const respond = this.approvalResponders.get(key);
    if (!respond) throw conflict("Approval responder is not active");
    respond({ ...details, decision: decision === "accepted" ? "accept" : "decline" });
    this.approvalResponders.delete(key);
  }

  async answerInput(runId: string, requestId: string, answers: UserInputAnswers): Promise<RunStatus> {
    this.activeRun(runId);
    const key = approvalKey(runId, requestId);
    const input = this.inputResponders.get(key);
    if (!input) throw conflict("Input responder is not active");
    const answerIds = Object.keys(answers);
    if (!answerIds.length) throw badRequest("answers must not be empty");
    const unknown = answerIds.filter((id) => !input.questionIds.has(id));
    const missing = [...input.questionIds].filter((id) => !(id in answers));
    if (unknown.length) throw badRequest(`answers contain unknown question ids: ${unknown.join(", ")}`);
    if (missing.length) throw badRequest(`answers are missing question ids: ${missing.join(", ")}`);
    input.respond({ answers });
    this.inputResponders.delete(key);
    return this.refreshRunStatus(runId);
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.active.keys()].map((runId) => this.release(runId)));
    await Promise.allSettled([...this.pendingCompletions]);
  }

  private activeRun(runId: string): ActiveRun & { handle: CodexRunHandle } {
    const run = this.active.get(runId);
    if (!run?.handle) throw conflict("Run is not active in this server process");
    return run as ActiveRun & { handle: CodexRunHandle };
  }

  private onEvent(runId: string, event: NormalizedCodexEvent): void {
    if (event.type === "token.usage") {
      const usage = codexTokenUsage(event.payload);
      if (usage) this.database.prepare("UPDATE runs SET token_input = ?, token_output = ?, token_cached = ? WHERE id = ?")
        .run(usage.input, usage.output, usage.cached, runId);
    }
    appendRunEvent(this.database, this.hub, runId, event.type, event.summary, { method: event.method, ...(event.requestId === undefined ? {} : { requestId: event.requestId }), ...event.payload });
    if (event.type === "request.resolved") this.resolveRequest(runId, String(event.payload.requestId ?? ""));
  }

  private onApproval(runId: string, event: NormalizedCodexEvent, respond: (decision: unknown) => void): void {
    const requestId = String(event.requestId ?? "");
    if (!requestId) throw new Error("Codex approval is missing a request id");
    const approvalId = randomUUID();
    const kind = approvalKind(event.method, event.payload);
    const run = runById(this.database, runId);
    const request = redactForDatabase(this.database, approvalRequest(kind, event.payload, run.workspace_path));
    const now = new Date().toISOString();
    const automatic = kind === "permission" && Boolean((this.database.prepare("SELECT auto_approve_permissions FROM tasks WHERE id = ?").get(run.task_id) as { auto_approve_permissions: number }).auto_approve_permissions);
    if (automatic) {
      this.database.prepare("INSERT INTO approvals (id, run_id, codex_request_id, kind, request_json, status, decision_json, created_at, decided_at) VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?, ?)")
        .run(approvalId, runId, requestId, kind, JSON.stringify({ ...request.value, redacted: request.redacted }), JSON.stringify({ automatic: true }), now, now);
      respond({ decision: "accept" });
      appendRunEvent(this.database, this.hub, runId, "approval.resolved", "Sandbox permission automatically approved", { approvalId, decision: "accepted", automatic: true });
      return;
    }
    this.database.prepare("INSERT INTO approvals (id, run_id, codex_request_id, kind, request_json, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)")
      .run(approvalId, runId, requestId, kind, JSON.stringify({ ...request.value, redacted: request.redacted }), now);
    notify(this.database, "approval", "等待人工审批", event.summary, "approval", approvalId);
    this.approvalResponders.set(approvalKey(runId, requestId), respond);
    this.refreshRunStatus(runId);
    appendRunEvent(this.database, this.hub, runId, "approval.created", event.summary, { approvalId });
  }

  private onInput(runId: string, event: NormalizedCodexEvent, respond: (answers: unknown) => void): void {
    const requestId = String(event.requestId ?? "");
    if (!requestId) throw new Error("Codex user input request is missing a request id");
    const questions = Array.isArray(event.payload.questions) ? event.payload.questions : [];
    const questionIds = new Set(questions.flatMap((question) => question && typeof question === "object" && typeof (question as JsonObject).id === "string" && (question as JsonObject).id ? [String((question as JsonObject).id)] : []));
    this.inputResponders.set(approvalKey(runId, requestId), { respond, questionIds });
    this.refreshRunStatus(runId);
  }

  private resolveRequest(runId: string, requestId: string): void {
    if (!requestId) return;
    const key = approvalKey(runId, requestId);
    this.approvalResponders.delete(key);
    this.inputResponders.delete(key);
    this.database.prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE run_id = ? AND codex_request_id = ? AND status = 'pending'")
      .run(new Date().toISOString(), runId, requestId);
    this.refreshRunStatus(runId);
  }

  private refreshRunStatus(runId: string): RunStatus {
    const prefix = `${runId}:`;
    const status: RunStatus = [...this.inputResponders.keys()].some((key) => key.startsWith(prefix)) ? "waiting_input"
      : [...this.approvalResponders.keys()].some((key) => key.startsWith(prefix)) ? "waiting_approval"
      : "running";
    if (this.active.has(runId)) this.database.prepare("UPDATE runs SET status = ? WHERE id = ? AND status IN ('preparing', 'running', 'waiting_approval', 'waiting_input')").run(status, runId);
    return status;
  }

  private async complete(runId: string, event: NormalizedCodexEvent): Promise<void> {
    const status = event.type === "turn.interrupted" ? "interrupted" : event.type === "turn.failed" ? "failed" : "succeeded";
    if (!(event.type === "turn.interrupted" && this.interruptModes.has(runId))) {
      this.database.prepare("UPDATE runs SET status = ?, finished_at = ? WHERE id = ? AND status NOT IN ('cancelled', 'interrupted')").run(status, new Date().toISOString(), runId);
      appendRunEvent(this.database, this.hub, runId, "run.status", `Run ${status}`, { status });
    }
    await this.release(runId);
    await this.onTerminal(runId);
  }

  private async fail(runId: string, error: unknown): Promise<void> {
    if (this.closing || error instanceof CodexAppServerClosedError) {
      await this.release(runId);
      return;
    }
    const summary = error instanceof Error ? error.message : String(error);
    this.database.prepare("UPDATE runs SET status = 'failed', finished_at = ?, failure_summary = ? WHERE id = ?").run(new Date().toISOString(), summary, runId);
    appendRunEvent(this.database, this.hub, runId, "run.status", "Run failed", { status: "failed", summary });
    await this.release(runId);
    await this.onTerminal(runId);
  }

  private async release(runId: string): Promise<void> {
    const run = this.active.get(runId);
    this.active.delete(runId);
    this.interruptModes.delete(runId);
    for (const key of this.approvalResponders.keys()) if (key.startsWith(`${runId}:`)) this.approvalResponders.delete(key);
    for (const key of this.inputResponders.keys()) if (key.startsWith(`${runId}:`)) this.inputResponders.delete(key);
    if (run) await Promise.allSettled([run.client.close(), run.cleanupContext()]);
  }

  private trackCompletion(completion: Promise<void>): void {
    this.pendingCompletions.add(completion);
    void completion.then(() => this.pendingCompletions.delete(completion), () => this.pendingCompletions.delete(completion));
  }
};

export class EventHub {
  private readonly listeners = new Set<(event: RunEvent) => void>();

  publish(event: RunEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function appendRunEvent(database: DatabaseSync, hub: EventHub, runId: string, eventType: string, summary: string, payload: JsonObject = {}, redacted = false): RunEvent {
  runById(database, runId);
  const createdAt = new Date().toISOString();
  const safeSummary = redactForDatabase(database, summary);
  const safePayload = redactForDatabase(database, payload);
  const result = database.prepare("INSERT INTO run_events (run_id, event_type, summary, payload_json, redacted, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(runId, eventType, safeSummary.value, JSON.stringify(safePayload.value), redacted || safeSummary.redacted || safePayload.redacted ? 1 : 0, createdAt);
  const event = eventById(database, Number(result.lastInsertRowid));
  hub.publish(event);
  return event;
}

function runContextFiles(database: DatabaseSync, run: RunRow, task: TaskContext): RunContextFiles {
  const saved = storedContextFiles(run.context_snapshot_json);
  if (saved) return saved;
  const dependencies = database.prepare(`
    SELECT task.number_path, task.title, task.description, task.status, task.acceptance_json
    FROM task_dependencies AS dependency
    JOIN tasks AS task ON task.id = dependency.depends_on_task_id
    WHERE dependency.task_id = ? ORDER BY task.number_path
  `).all(run.task_id) as Array<{ number_path: string; title: string; description: string; status: string; acceptance_json: string }>;
  const previousRuns = database.prepare(`
    SELECT attempt_no, role, trigger_type, status, started_at, finished_at, failure_summary
    FROM runs WHERE task_id = ? AND id <> ? ORDER BY rowid DESC LIMIT 20
  `).all(run.task_id, run.id) as Array<Record<string, unknown>>;
  const evidence = run.trigger_ref_id ? database.prepare(`
    SELECT event_type, summary, payload_json, created_at FROM run_events
    WHERE run_id = ? AND event_type IN ('agent.message.delta', 'item.completed', 'file.changed', 'command.completed')
    ORDER BY id DESC LIMIT 50
  `).all(run.trigger_ref_id) as Array<Record<string, unknown>> : [];
  const requirementMessages = database.prepare("SELECT role, content, created_at FROM requirement_messages WHERE commission_id = ? ORDER BY created_at, rowid").all(run.commission_id) as Array<{ role: string; content: string; created_at: string }>;
  const comments = database.prepare("SELECT id, parent_id, run_id, author_type, agent_role, kind, content, created_at FROM comments WHERE task_id = ? AND deleted_at IS NULL ORDER BY created_at, rowid").all(run.task_id) as Array<{ id: string; parent_id: string | null; run_id: string | null; author_type: string; agent_role: string | null; kind: string; content: string; created_at: string }>;
  const files: RunContextFiles = {
    "requirement.md": `# Requirement: ${task.commission_title}\n\n${task.requirement}\n\n## Acceptance\n\n\`\`\`json\n${prettyJson(task.requirement_acceptance)}\n\`\`\`\n`,
    "task.md": `# Task: ${task.title}\n\n${task.description || "No description."}\n\n- Run role: ${run.role}\n- Trigger: ${run.trigger_type}\n- Read only: ${Boolean(task.read_only)}\n\n## Acceptance\n\n\`\`\`json\n${prettyJson(task.acceptance_json)}\n\`\`\`\n`,
    "dependencies.md": `# Dependencies\n\n${dependencies.length ? dependencies.map((item) => `## ${item.number_path} ${item.title}\n\n- Status: ${item.status}\n- Description: ${item.description || "No description."}\n- Acceptance: ${prettyJson(item.acceptance_json)}`).join("\n\n") : "No task dependencies."}\n`,
    "previous-runs.md": `# Previous Runs\n\n${previousRuns.length ? previousRuns.map((item) => `- Attempt ${item.attempt_no} · ${item.role} · ${item.status} · ${item.trigger_type}${item.failure_summary ? ` · ${item.failure_summary}` : ""}`).join("\n") : "No previous Runs."}${evidence.length ? `\n\n## Trigger Run Evidence\n\n${evidence.map((item) => `- ${item.created_at} · ${item.event_type} · ${item.summary}\n  ${item.payload_json}`).join("\n")}` : ""}\n`,
    "project-profile.md": `# Project: ${task.project_name}\n\n- Root: ${task.project_root}\n- VCS: ${task.vcs_type}\n- VCS root: ${task.vcs_root ?? "none"}\n\n## Profile\n\n\`\`\`json\n${prettyJson(task.profile_json ?? "{}")}\n\`\`\`\n`,
    "messages.md": `# Messages\n\n${requirementMessages.length ? requirementMessages.map((item) => `## ${item.role} · ${item.created_at}\n\n${item.content}`).join("\n\n") : "No requirement messages."}${comments.length ? `\n\n# Task Comments\n\n${comments.map((item) => `## ${item.id} · ${item.author_type}${item.agent_role ? `/${item.agent_role}` : ""} · ${item.kind} · ${item.created_at}${item.parent_id ? ` · reply-to:${item.parent_id}` : ""}${item.run_id ? ` · run:${item.run_id}` : ""}\n\n${item.content}`).join("\n\n")}` : ""}\n`
  };
  database.prepare("UPDATE runs SET context_snapshot_json = ? WHERE id = ?").run(JSON.stringify({ version: 1, files }), run.id);
  return files;
}

function storedContextFiles(snapshot: string): RunContextFiles | undefined {
  try {
    const value = JSON.parse(snapshot) as { files?: unknown };
    if (!value.files || typeof value.files !== "object" || Array.isArray(value.files)) return undefined;
    const files = value.files as Record<string, unknown>;
    return Object.values(files).every((content) => typeof content === "string") ? files as RunContextFiles : undefined;
  } catch { return undefined; }
}

function prettyJson(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2); }
  catch { return value; }
}

export async function registerProductionRunRoutes(server: FastifyInstance, database: DatabaseSync, launch: RunClientLauncher): Promise<AgentMentionHandler> {
  const hub = new EventHub();
  const projectRoots = database.prepare("SELECT real_path FROM projects WHERE archived_at IS NULL").all() as Array<{ real_path: string }>;
  await Promise.all(projectRoots.map(({ real_path }) => recoverRunContexts(real_path)));
  let scheduler!: Scheduler;
  const controller = new CodexRunController(database, hub, launch, (runId) => scheduler.terminal(runId));
  scheduler = new Scheduler(database, controller);
  const controls: RunController = {
    steer: (runId, message) => controller.steer(runId, message),
    interrupt: (runId, mode) => controller.interrupt(runId, mode),
    resume: (taskId, previousRunId) => scheduler.resume(taskId, previousRunId),
    decideApproval: (runId, requestId, decision, details) => controller.decideApproval(runId, requestId, decision, details),
    answerInput: (runId, requestId, answers) => controller.answerInput(runId, requestId, answers)
  };
  registerRunRoutes(server, database, controls, hub);
  registerSchedulerRoutes(server, scheduler);
  await scheduler.recover();
  server.addHook("onClose", () => controller.close());
  return async (taskId, message) => {
    const reserved = database.prepare("SELECT id, status FROM runs WHERE task_id = ? AND status IN ('queued', 'preparing', 'running', 'waiting_approval', 'waiting_input') ORDER BY rowid DESC LIMIT 1").get(taskId) as { id: string; status: RunStatus } | undefined;
    if (reserved && ["running", "waiting_approval", "waiting_input"].includes(reserved.status)) {
      try {
        await controller.steer(reserved.id, message);
        appendRunEvent(database, hub, reserved.id, "human.message", "Human mentioned Agent", { message });
        return { action: "steered", runId: reserved.id };
      } catch (error) { return { action: "unavailable", runId: reserved.id, message: error instanceof Error ? error.message : String(error) }; }
    }
    if (reserved) return { action: "queued", runId: reserved.id };
    const task = database.prepare("SELECT owner_type, status FROM tasks WHERE id = ? AND archived_at IS NULL").get(taskId) as { owner_type: string; status: string } | undefined;
    if (!task) return { action: "unavailable", message: "Task not found" };
    if (task.owner_type !== "ai") return { action: "unavailable", message: "人工任务没有可唤起的执行 Agent" };
    if (["done", "archived"].includes(task.status)) return { action: "unavailable", message: "已完成或归档任务不能启动 Agent" };
    if (["in_progress", "blocked"].includes(task.status)) database.prepare("UPDATE tasks SET status = 'todo', blocked_reason = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
    try {
      const result = await scheduler.trigger(taskId);
      return { action: "triggered", ...(result.runIds[0] ? { runId: result.runIds[0] } : {}) };
    } catch (error) { return { action: "unavailable", message: error instanceof Error ? error.message : String(error) }; }
  };
}

export function registerRunRoutes(server: FastifyInstance, database: DatabaseSync, controller: RunController, hub: EventHub): void {
  server.get("/api/runtime/run-status", async () => database.prepare(`SELECT
    COALESCE(SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
    COALESCE(SUM(CASE WHEN status IN ('preparing', 'running') THEN 1 ELSE 0 END), 0) AS active,
    COALESCE(SUM(CASE WHEN status IN ('waiting_approval', 'waiting_input') THEN 1 ELSE 0 END), 0) AS waiting
    FROM runs`).get());

  server.get<{ Params: { id: string }; Querystring: { scope?: string } }>("/api/tasks/:id/runs", async (request) => {
    const rows = request.query.scope === "tree"
      ? database.prepare(`WITH RECURSIVE tree(id) AS (
          SELECT id FROM tasks WHERE id = ? UNION ALL
          SELECT task.id FROM tasks AS task JOIN tree ON task.parent_id = tree.id
        ) SELECT run.* FROM runs AS run JOIN tree ON tree.id = run.task_id ORDER BY run.rowid DESC`).all(request.params.id)
      : database.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY attempt_no DESC, rowid DESC").all(request.params.id);
    return (rows as RunRow[]).map(decodeRun);
  });

  server.get<{ Params: { id: string } }>("/api/runs/:id", async (request) => runDetails(database, request.params.id));

  server.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/runs/:id/events", async (request) =>
    eventsAfter(database, cursor(request.query.after), "run_id = ?", request.params.id));

  server.post<{ Params: { id: string }; Body: { message?: unknown } }>("/api/runs/:id/steer", async (request) => {
    const run = activeRun(database, request.params.id);
    const message = requiredString(request.body?.message, "message");
    await controller.steer(run.id, message);
    appendRunEvent(database, hub, run.id, "human.message", "Human intervention", { message });
    return { ok: true };
  });

  server.post<{ Params: { id: string } }>("/api/runs/:id/interrupt", async (request) => {
    const run = activeRun(database, request.params.id);
    await interruptRun(database, hub, controller, run, "cancel");
    return runDetails(database, run.id);
  });

  server.post<{ Params: { id: string } }>("/api/tasks/:id/pause", async (request) => {
    const run = activeRunForTask(database, request.params.id);
    await interruptRun(database, hub, controller, run, "pause");
    return runDetails(database, run.id);
  });

  server.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (request) => {
    const run = activeRunForTask(database, request.params.id);
    await interruptRun(database, hub, controller, run, "cancel");
    return runDetails(database, run.id);
  });

  server.post<{ Params: { id: string } }>("/api/tasks/:id/resume", async (request) => {
    const run = latestRunForTask(database, request.params.id);
    const runId = await controller.resume(request.params.id, run.id);
    return { ok: true, previousRunId: run.id, runId };
  });

  server.get<{ Querystring: { status?: string; runId?: string } }>("/api/approvals", async (request) => {
    const conditions: string[] = [];
    const values: string[] = [];
    if (request.query.status) { conditions.push("status = ?"); values.push(request.query.status); }
    if (request.query.runId) { conditions.push("run_id = ?"); values.push(request.query.runId); }
    return database.prepare(`SELECT * FROM approvals${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY created_at DESC`).all(...values).map(decodeApproval);
  });

  server.post<{ Params: { id: string }; Body: { decision?: unknown; details?: unknown } }>("/api/approvals/:id/decide", async (request) => {
    const approval = approvalById(database, request.params.id);
    if (approval.status !== "pending") throw conflict("Approval is already resolved");
    const decision = enumValue(request.body?.decision, ["accepted", "declined"] as const, "decision");
    const details = request.body?.details === undefined ? undefined : object(request.body.details, "details");
    await controller.decideApproval(approval.run_id, approval.codex_request_id, decision, details);
    const decidedAt = new Date().toISOString();
    database.prepare("UPDATE approvals SET status = ?, decision_json = ?, decided_at = ? WHERE id = ?")
      .run(decision, JSON.stringify(details ?? {}), decidedAt, approval.id);
    const pending = database.prepare("SELECT 1 FROM approvals WHERE run_id = ? AND status = 'pending'").get(approval.run_id);
    if (!pending) database.prepare("UPDATE runs SET status = 'running' WHERE id = ? AND status = 'waiting_approval'").run(approval.run_id);
    appendRunEvent(database, hub, approval.run_id, "approval.resolved", `Approval ${decision}`, { approvalId: approval.id, decision });
    return decodeApproval(approvalById(database, approval.id));
  });

  server.post<{ Params: { id: string }; Body: { requestId?: unknown; answers?: unknown } }>("/api/runs/:id/input", async (request) => {
    const run = activeRun(database, request.params.id);
    if (run.status !== "waiting_input") throw conflict("Run is not waiting for input");
    const requestId = requiredString(request.body?.requestId, "requestId");
    const answers = userInputAnswers(request.body?.answers);
    const controllerStatus = await controller.answerInput(run.id, requestId, answers);
    const nextStatus = controllerStatus ?? (database.prepare("SELECT 1 FROM approvals WHERE run_id = ? AND status = 'pending'").get(run.id) ? "waiting_approval" : "running");
    if (!controllerStatus) database.prepare("UPDATE runs SET status = ? WHERE id = ? AND status = 'waiting_input'").run(nextStatus, run.id);
    appendRunEvent(database, hub, run.id, "input.resolved", "User input received", { requestId, answers });
    return { ok: true, status: nextStatus };
  });

  server.get<{ Querystring: { after?: string } }>("/api/events", async (request, reply) => {
    const after = Math.max(cursor(request.query.after), cursor(request.headers["last-event-id"]));
    startEventStream(request, reply, database, hub, after);
    return reply;
  });

}

function startEventStream(request: FastifyRequest, reply: FastifyReply, database: DatabaseSync, hub: EventHub, after: number): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  reply.raw.write(": connected\n\n");
  for (const event of eventsAfter(database, after)) reply.raw.write(encodeSse(event));
  const unsubscribe = hub.subscribe((event) => reply.raw.write(encodeSse(event)));
  request.raw.once("close", unsubscribe);
}

function encodeSse(event: RunEvent): string {
  return `id: ${event.id}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function interruptRun(database: DatabaseSync, hub: EventHub, controller: RunController, run: RunRow, mode: "pause" | "cancel"): Promise<void> {
  await controller.interrupt(run.id, mode);
  const status = mode === "pause" ? "interrupted" : "cancelled";
  database.prepare("UPDATE runs SET status = ?, finished_at = ? WHERE id = ?").run(status, new Date().toISOString(), run.id);
  appendRunEvent(database, hub, run.id, "run.status", `Run ${status}`, { status, reason: mode });
}

function runDetails(database: DatabaseSync, id: string) {
  const run = runById(database, id);
  const events = eventsAfter(database, 0, "run_id = ?", id);
  const approvals = database.prepare("SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at").all(id).map(decodeApproval);
  return {
    ...decodeRun(run),
    elapsedMs: elapsedMs(run),
    summaryTimeline: events.map(({ id: eventId, event_type, summary, created_at }) => ({ id: eventId, eventType: event_type, summary, createdAt: created_at })),
    fileChanges: events.filter((event) => event.event_type.includes("file") || event.event_type.includes("patch")),
    approvals
  };
}

function eventsAfter(database: DatabaseSync, after: number, condition = "1 = 1", ...values: string[]): RunEvent[] {
  return (database.prepare(`SELECT * FROM run_events WHERE id > ? AND ${condition} ORDER BY id`).all(after, ...values) as Array<Record<string, unknown>>).map(decodeEvent);
}

function eventById(database: DatabaseSync, id: number): RunEvent {
  const row = database.prepare("SELECT * FROM run_events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Run event ${id} was not persisted`);
  return decodeEvent(row);
}

function decodeEvent(row: Record<string, unknown>): RunEvent {
  return {
    id: Number(row.id),
    run_id: String(row.run_id),
    event_type: String(row.event_type),
    summary: String(row.summary),
    payload: object(JSON.parse(String(row.payload_json)), "payload"),
    redacted: Boolean(row.redacted),
    created_at: String(row.created_at)
  };
}

function decodeRun(run: RunRow) {
  return {
    ...run,
    configSnapshot: JSON.parse(run.config_snapshot_json),
    contextSnapshot: JSON.parse(run.context_snapshot_json),
    config_snapshot_json: undefined,
    context_snapshot_json: undefined
  };
}

function decodeApproval(value: unknown) {
  const row = value as ApprovalRow;
  return { ...row, request: JSON.parse(row.request_json), decision: row.decision_json ? JSON.parse(row.decision_json) : null, request_json: undefined, decision_json: undefined };
}

function runById(database: DatabaseSync, id: string): RunRow {
  const run = database.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
  if (!run) throw notFound("Run not found");
  return run;
}

function activeRun(database: DatabaseSync, id: string): RunRow {
  const run = runById(database, id);
  if (!["preparing", "running", "waiting_approval", "waiting_input"].includes(run.status)) throw conflict("Run is not active");
  return run;
}

function activeRunForTask(database: DatabaseSync, taskId: string): RunRow {
  const run = database.prepare("SELECT * FROM runs WHERE task_id = ? AND status IN ('preparing', 'running', 'waiting_approval', 'waiting_input') ORDER BY attempt_no DESC, rowid DESC LIMIT 1").get(taskId) as RunRow | undefined;
  if (!run) throw conflict("Task has no active run");
  return run;
}

function latestRunForTask(database: DatabaseSync, taskId: string): RunRow {
  const run = database.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY attempt_no DESC, rowid DESC LIMIT 1").get(taskId) as RunRow | undefined;
  if (!run) throw notFound("Task has no runs");
  return run;
}

function approvalById(database: DatabaseSync, id: string) {
  const approval = database.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
  if (!approval) throw notFound("Approval not found");
  return approval;
}

function elapsedMs(run: RunRow): number | null {
  if (!run.started_at) return null;
  return Math.max(0, Date.parse(run.finished_at ?? new Date().toISOString()) - Date.parse(run.started_at));
}

function cursor(value: unknown): number {
  if (value === undefined) return 0;
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed)) throw badRequest("Event cursor must be a non-negative integer");
  return parsed;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${name} must be a non-empty string`);
  return value.trim();
}

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest(`${name} must be an object`);
  return value as JsonObject;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw badRequest(`${name} must be a string array`);
  return value;
}

function enumValue<T extends string>(value: unknown, choices: readonly T[], name: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw badRequest(`${name} must be one of: ${choices.join(", ")}`);
  return value as T;
}

export function approvalKind(method: string, payload: JsonObject = {}): "command" | "file_change" | "permission" | "high_risk" | "mcp_tool_call" {
  if (method.includes("commandExecution")) return isHighRiskCommand(payload) ? "high_risk" : "command";
  if (method.includes("fileChange")) return "file_change";
  if (method.includes("permissions")) return "permission";
  if (method === "mcpServer/elicitation/request") return "mcp_tool_call";
  throw new TypeError(`Unsupported approval method: ${method}`);
}

export function codexTokenUsage(payload: JsonObject): { input: number; output: number; cached: number } | undefined {
  const tokenUsage = record(payload.tokenUsage);
  const total = record(tokenUsage?.total);
  const input = tokenCount(total?.inputTokens);
  const output = tokenCount(total?.outputTokens);
  const cached = tokenCount(total?.cachedInputTokens);
  return input === undefined || output === undefined || cached === undefined ? undefined : { input, output, cached };
}

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function userInputAnswers(value: unknown): UserInputAnswers {
  const input = object(value, "answers");
  if (!Object.keys(input).length) throw badRequest("answers must not be empty");
  return Object.fromEntries(Object.entries(input).map(([id, answer]) => {
    if (!id) throw badRequest("answer ids must be non-empty");
    const values = object(answer, `answer ${id}`).answers;
    if (!Array.isArray(values) || values.some((item) => typeof item !== "string")) throw badRequest(`answer ${id} must contain a string array`);
    return [id, { answers: values }];
  }));
}

export function pruneRawRunEvents(database: DatabaseSync, retentionDays = new SettingsStore(database).get<number>("logRetentionDays", 90) ?? 90, now = Date.now()): number {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new TypeError("logRetentionDays must be a positive integer");
  const cutoff = new Date(now - retentionDays * 86_400_000).toISOString();
  return Number(database.prepare("DELETE FROM run_events WHERE event_type = 'command.output' AND created_at < ?").run(cutoff).changes);
}

function redactForDatabase<T>(database: DatabaseSync, value: T) {
  return redactSensitive(value, configuredSecrets(new SettingsStore(database).all()));
}

function approvalRequest(kind: ApprovalRow["kind"], payload: JsonObject, workspacePath: string | null): JsonObject {
  if (kind !== "high_risk") return payload;
  const commands = normalizeCommands(payload);
  const command = commands.find(({ executable, arguments: args }) => isHighRiskCommand({ command: [executable, ...args] })) ?? commands[0];
  return {
    ...payload,
    executable: command?.executable ?? "",
    arguments: command?.arguments ?? [],
    cwd: payload.cwd ?? workspacePath,
    reason: payload.reason ?? "Codex requested a high-risk operation",
    impactScope: payload.impactScope ?? payload.cwd ?? workspacePath ?? "unknown"
  };
}

function approvalKey(runId: string, requestId: string): string { return `${runId}:${requestId}`; }

function statusError(message: string, statusCode: number): Error { return Object.assign(new Error(message), { statusCode }); }
const badRequest = (message: string) => statusError(message, 400);
const notFound = (message: string) => statusError(message, 404);
const conflict = (message: string) => statusError(message, 409);
