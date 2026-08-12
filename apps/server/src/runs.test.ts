import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { storeAttachment } from "./attachments.ts";
import { registerAuthentication } from "./auth.ts";
import { addTaskComment } from "./comments.ts";
import type { CodexAppServerOptions, CodexRunHandle, CodexRunOptions, NormalizedCodexEvent } from "./codex.ts";
import { openWorkshopDatabase, SettingsStore } from "./database.ts";
import { appendRunEvent, approvalKind, codexTokenUsage, CodexRunController, EventHub, pruneRawRunEvents, registerProductionRunRoutes, registerRunRoutes, type RunClientLauncher, type RunController } from "./runs.ts";

test("reads cumulative Codex token usage without double-counting cache", () => {
  assert.deepEqual(codexTokenUsage({ tokenUsage: { total: { totalTokens: 140, inputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 0, outputTokens: 40, reasoningOutputTokens: 10 } } }), { input: 100, output: 40, cached: 80 });
  assert.equal(codexTokenUsage({ tokenUsage: { total: { inputTokens: -1, outputTokens: 2, cachedInputTokens: 0 } } }), undefined);
});

test("replays persisted SSE events after Last-Event-ID and continues live", async () => {
  const fixture = await runFixture();
  try {
    const first = appendRunEvent(fixture.database, fixture.hub, fixture.runId, "run.status", "Running", { status: "running" });
    const second = appendRunEvent(fixture.database, fixture.hub, fixture.runId, "command.started", "npm test", { command: ["npm", "test"] });
    const third = appendRunEvent(fixture.database, fixture.hub, fixture.runId, "command.completed", "npm test passed", { exitCode: 0 });
    const address = await fixture.server.listen({ host: "127.0.0.1", port: 0 });
    const abort = new AbortController();
    const response = await fetch(`${address}/api/events?after=${second.id}`, { headers: { "Last-Event-ID": String(first.id) }, signal: abort.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const replay = await readUntil(reader, `id: ${third.id}`);
    assert.match(replay, /event: command\.completed/);
    assert.doesNotMatch(replay, new RegExp(`id: ${first.id}\\n`));
    assert.doesNotMatch(replay, new RegExp(`id: ${second.id}\\n`));

    const live = appendRunEvent(fixture.database, fixture.hub, fixture.runId, "file.changed", "Changed src/app.ts", { path: "src/app.ts" });
    assert.match(await readUntil(reader, `id: ${live.id}`), /event: file\.changed/);
    abort.abort();
    await reader.cancel().catch(() => undefined);
  } finally {
    await fixture.close();
  }
});

test("redacts secrets before persistence and only prunes expired raw command output", async () => {
  const fixture = await runFixture();
  try {
    const event = appendRunEvent(fixture.database, fixture.hub, fixture.runId, "command.output", "Authorization: Bearer top-secret", { pin: "123456", output: "api_key=abc123" });
    assert.equal(event.redacted, true);
    assert.doesNotMatch(JSON.stringify(event), /top-secret|123456|abc123/);
    fixture.database.prepare("UPDATE run_events SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(event.id);
    appendRunEvent(fixture.database, fixture.hub, fixture.runId, "run.status", "Permanent audit", { status: "running" });
    assert.equal(pruneRawRunEvents(fixture.database, 90), 1);
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM run_events").get() as { count: number }).count, 1);
    assert.equal(approvalKind("item/commandExecution/requestApproval", { command: "git reset --hard" }), "high_risk");
    assert.equal(approvalKind("item/commandExecution/requestApproval", { command: ["npm", "test"] }), "command");
    assert.equal(approvalKind("mcpServer/elicitation/request"), "mcp_tool_call");
  } finally {
    await fixture.close();
  }
});

test("production assembly wires Codex controls, approvals, and live events", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-production-runs-"));
  const database = await openWorkshopDatabase(home);
  const calls: string[] = [];
  const server = Fastify();
  try {
    const taskId = seedTask(database, home).taskId;
    const previousRunId = seedRun(database, taskId, 1);
    database.prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE id = ?").run(new Date().toISOString(), previousRunId);
    registerAuthentication(server, database);
    await registerProductionRunRoutes(server, database, fakeRunClientLauncher(database, calls));
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const initialized = await fetch(`${address}/api/auth/initialize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: "123456" })
    });
    const cookie = initialized.headers.get("set-cookie")!.split(";", 1)[0]!;
    const abort = new AbortController();
    const stream = await fetch(`${address}/api/events`, { headers: { cookie }, signal: abort.signal });
    const reader = stream.body!.getReader();

    const triggeredTaskId = seedTask(database, home).taskId;
    database.prepare("UPDATE tasks SET status = 'backlog' WHERE id = ?").run(triggeredTaskId);
    const triggered = await api(address, cookie, `/api/tasks/${triggeredTaskId}/trigger`);
    assert.equal(triggered.response.status, 200);
    const triggeredRunId = String((triggered.body.runIds as string[])[0]);
    assert.ok(triggeredRunId);
    assert.equal((database.prepare("SELECT status FROM runs WHERE id = ?").get(triggeredRunId) as { status: string }).status, "waiting_approval");
    assert.match(await readFile(join(home, ".openworkshop", "runs", triggeredRunId, "task.md"), "utf8"), /# Task: Task/);
    assert.match(await readFile(join(home, ".openworkshop", "runs", triggeredRunId, "requirement.md"), "utf8"), /Requirement/);
    assert.notEqual((database.prepare("SELECT context_snapshot_json FROM runs WHERE id = ?").get(triggeredRunId) as { context_snapshot_json: string }).context_snapshot_json, "{}");
    assert.ok(calls.some((call) => call.startsWith("prompt:") && call.includes(join(home, ".openworkshop", "runs", triggeredRunId, "task.md"))));
    const usage = database.prepare("SELECT token_input, token_output, token_cached FROM runs WHERE id = ?").get(triggeredRunId) as { token_input: number; token_output: number; token_cached: number };
    assert.deepEqual([usage.token_input, usage.token_output, usage.token_cached], [120, 30, 90]);
    const abandonedApproval = database.prepare("SELECT id FROM approvals WHERE run_id = ? AND status = 'pending'").get(triggeredRunId) as { id: string };
    assert.equal((await api(address, cookie, `/api/tasks/${triggeredTaskId}/cancel`)).body.status, "cancelled");
    assert.equal((database.prepare("SELECT status FROM approvals WHERE id = ?").get(abandonedApproval.id) as { status: string }).status, "expired");
    assert.ok((database.prepare("SELECT read_at FROM notifications WHERE entity_type = 'approval' AND entity_id = ?").get(abandonedApproval.id) as { read_at: string | null }).read_at);

    const autoTaskId = seedTask(database, home).taskId;
    database.prepare("UPDATE tasks SET status = 'backlog', auto_approve_permissions = 1 WHERE id = ?").run(autoTaskId);
    const autoRunId = String(((await api(address, cookie, `/api/tasks/${autoTaskId}/trigger`)).body.runIds as string[])[0]);
    assert.equal((database.prepare("SELECT status FROM runs WHERE id = ?").get(autoRunId) as { status: string }).status, "running");
    const automatic = database.prepare("SELECT kind, status, decision_json FROM approvals WHERE run_id = ?").get(autoRunId) as { kind: string; status: string; decision_json: string };
    assert.deepEqual([automatic.kind, automatic.status, JSON.parse(automatic.decision_json)], ["permission", "accepted", { automatic: true }]);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM notifications WHERE entity_type = 'approval' AND entity_id IN (SELECT id FROM approvals WHERE run_id = ?)").get(autoRunId) as { count: number }).count, 0);
    assert.equal((await api(address, cookie, `/api/tasks/${autoTaskId}/cancel`)).body.status, "cancelled");

    new SettingsStore(database).set("codexRuntime", { sandboxMode: "read-only", approvalPolicy: "never", networkAccess: false });
    const configuredTaskId = seedTask(database, home).taskId;
    database.prepare("UPDATE tasks SET status = 'backlog' WHERE id = ?").run(configuredTaskId);
    const configuredRunId = String(((await api(address, cookie, `/api/tasks/${configuredTaskId}/trigger`)).body.runIds as string[])[0]);
    assert.deepEqual(JSON.parse((database.prepare("SELECT config_snapshot_json FROM runs WHERE id = ?").get(configuredRunId) as { config_snapshot_json: string }).config_snapshot_json), { prompt: "", customArgs: [], sandboxMode: "read-only", approvalPolicy: "never", networkAccess: false });
    assert.ok(calls.includes("sandbox:read-only"));
    assert.ok(calls.includes('args:["app-server","-c","sandbox_mode=\\"read-only\\"","-c","approval_policy=\\"never\\""]'));
    assert.equal((await api(address, cookie, `/api/tasks/${configuredTaskId}/cancel`)).body.status, "cancelled");

    const resumed = await api(address, cookie, `/api/tasks/${taskId}/resume`);
    assert.equal(resumed.response.status, 200);
    const runId = String(resumed.body.runId);
    assert.ok(runId && runId !== previousRunId);
    assert.match(await readUntil(reader, "event: agent.message.delta"), /data:/);
    assert.equal((await api(address, cookie, `/api/runs/${runId}/steer`, { message: "Focus on production wiring" })).response.status, 200);

    const approvals = await fetch(`${address}/api/approvals?runId=${runId}`, { headers: { cookie } }).then((response) => response.json()) as Array<{ id: string }>;
    assert.equal(approvals.length, 1);
    assert.equal((await api(address, cookie, `/api/approvals/${approvals[0]!.id}/decide`, { decision: "accepted", details: { scope: "once" } })).response.status, 200);
    assert.equal((await api(address, cookie, `/api/tasks/${taskId}/pause`)).body.status, "interrupted");
    assert.deepEqual(terminalStatuses(database, runId), ["interrupted"]);

    const cancelTaskId = seedTask(database, home).taskId;
    const cancelPrevious = seedRun(database, cancelTaskId, 1);
    database.prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE id = ?").run(new Date().toISOString(), cancelPrevious);
    const cancelRunId = String((await api(address, cookie, `/api/tasks/${cancelTaskId}/resume`)).body.runId);
    assert.equal((await api(address, cookie, `/api/tasks/${cancelTaskId}/cancel`)).body.status, "cancelled");
    assert.deepEqual(terminalStatuses(database, cancelRunId), ["cancelled"]);

    const interruptTaskId = seedTask(database, home).taskId;
    const interruptPrevious = seedRun(database, interruptTaskId, 1);
    database.prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE id = ?").run(new Date().toISOString(), interruptPrevious);
    const interruptRunId = String((await api(address, cookie, `/api/tasks/${interruptTaskId}/resume`)).body.runId);
    assert.equal((await api(address, cookie, `/api/runs/${interruptRunId}/interrupt`)).body.status, "cancelled");
    assert.deepEqual(terminalStatuses(database, interruptRunId), ["cancelled"]);

    assert.ok(calls.includes(`steer:${runId}:Focus on production wiring`));
    assert.ok(calls.includes(`interrupt:${runId}`));
    assert.ok(calls.includes(`interrupt:${cancelRunId}`));
    assert.ok(calls.includes(`interrupt:${interruptRunId}`));
    assert.ok(calls.includes("approval:accept:once"));
    assert.ok(calls.includes("approval-policy:on-request"));
    assert.ok((database.prepare("SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?").get(runId) as { count: number }).count >= 5);
    abort.abort();
    await reader.cancel().catch(() => undefined);
    await server.close();
    await assert.rejects(access(join(home, ".openworkshop", "runs", runId)));
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("passes image attachments as initial visual input when an @Agent mention creates a Run", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-mentioned-run-image-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  const inputs: CodexRunOptions["input"][] = [];
  try {
    const { commissionId, taskId } = seedTask(database, home);
    database.prepare("UPDATE tasks SET status = 'backlog' WHERE id = ?").run(taskId);
    const attachment = await storeAttachment(database, join(home, "attachments"), { commissionId, taskId, originalName: "screen.png", mediaType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
    const comment = addTaskComment(database, { taskId, authorType: "human", content: "@Agent 请检查截图" });
    database.prepare("UPDATE attachments SET comment_id = ? WHERE id = ?").run(String(comment.id), attachment.id);
    const mentionAgent = await registerProductionRunRoutes(server, database, () => ({
      initialize: async () => undefined,
      startRun: async (options) => {
        inputs.push(options.input);
        return { threadId: "thread-image", turnId: "turn-image", completed: new Promise<NormalizedCodexEvent>(() => undefined) };
      },
      steer: async () => undefined,
      interrupt: async () => undefined,
      close: async () => undefined
    }), join(home, "attachments"));
    const result = await mentionAgent(taskId, "@Agent 请检查截图", [attachment.id]);
    assert.equal(result.action, "triggered");
    const runAttachmentPath = join(home, ".openworkshop", "runs", result.runId!, "attachments", attachment.id, attachment.original_name);
    assert.deepEqual(inputs[0]?.slice(1), [{ type: "localImage", path: runAttachmentPath }]);
    assert.equal((database.prepare("SELECT run_id FROM attachments WHERE id = ?").get(attachment.id) as { run_id: string }).run_id, result.runId);
    assert.deepEqual(await readFile(runAttachmentPath), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const messages = await readFile(join(home, ".openworkshop", "runs", result.runId!, "messages.md"), "utf8");
    assert.match(messages, /screen\.png/);
    assert.match(messages, new RegExp(runAttachmentPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(messages, new RegExp(attachment.storage_path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("associates a queued @Agent image with the reserved Run before its initial input is built", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-queued-run-image-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  const inputs: CodexRunOptions["input"][] = [];
  try {
    const { commissionId, taskId } = seedTask(database, home);
    const runId = seedRun(database, taskId, 1);
    database.prepare("UPDATE runs SET status = 'queued', started_at = NULL WHERE id = ?").run(runId);
    const blockerTaskId = seedTask(database, home).taskId;
    const blockerRunId = seedRun(database, blockerTaskId, 1);
    new SettingsStore(database).set("globalConcurrency", 1);
    const attachment = await storeAttachment(database, join(home, "attachments"), { commissionId, taskId, originalName: "queued.png", mediaType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
    const mentionAgent = await registerProductionRunRoutes(server, database, () => ({
      initialize: async () => undefined,
      startRun: async () => ({ threadId: "unused", turnId: "unused", completed: new Promise<NormalizedCodexEvent>(() => undefined) }),
      steer: async () => undefined,
      interrupt: async () => undefined,
      close: async () => undefined
    }), join(home, "attachments"));
    const result = await mentionAgent(taskId, "@Agent 排队截图", [attachment.id]);
    assert.deepEqual(result, { action: "queued", runId });
    assert.equal((database.prepare("SELECT run_id FROM attachments WHERE id = ?").get(attachment.id) as { run_id: string }).run_id, runId);
    await server.close();
    database.prepare("UPDATE runs SET status = 'failed', finished_at = ? WHERE id = ?").run(new Date().toISOString(), blockerRunId);
    database.prepare("UPDATE runs SET status = 'preparing' WHERE id = ?").run(runId);
    const controller = new CodexRunController(database, new EventHub(), () => ({
      initialize: async () => undefined,
      startRun: async (options) => {
        inputs.push(options.input);
        return { threadId: "thread-queued", turnId: "turn-queued", completed: new Promise<NormalizedCodexEvent>(() => undefined) };
      },
      steer: async () => undefined,
      interrupt: async () => undefined,
      close: async () => undefined
    }), undefined, join(home, "attachments"));
    await controller.start(runId, home);
    assert.deepEqual(inputs[0]?.slice(1), [{ type: "localImage", path: join(home, ".openworkshop", "runs", runId, "attachments", attachment.id, attachment.original_name) }]);
    await controller.close();
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("steers an @Agent image that arrives while a Run is preparing", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-preparing-run-image-"));
  const database = await openWorkshopDatabase(home);
  const { commissionId, taskId } = seedTask(database, home);
  const runId = seedRun(database, taskId, 1);
  database.prepare("UPDATE runs SET status = 'preparing' WHERE id = ?").run(runId);
  const attachment = await storeAttachment(database, join(home, "attachments"), { commissionId, taskId, originalName: "preparing.png", mediaType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
  let continueInitialize!: () => void;
  const initializing = new Promise<void>((resolve) => { continueInitialize = resolve; });
  const steers: Array<string | CodexRunOptions["input"]> = [];
  const controller = new CodexRunController(database, new EventHub(), () => ({
    initialize: async () => initializing,
    startRun: async () => ({ threadId: "thread-preparing", turnId: "turn-preparing", completed: new Promise<NormalizedCodexEvent>(() => undefined) }),
    steer: async (_threadId, _turnId, input) => { steers.push(input); },
    interrupt: async () => undefined,
    close: async () => undefined
  }), undefined, join(home, "attachments"));
  try {
    const starting = controller.start(runId, home);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.queuePreparingSteer(runId, "@Agent 准备中截图", [attachment.id]);
    continueInitialize();
    await starting;
    assert.deepEqual((steers[0] as CodexRunOptions["input"])?.slice(1), [{ type: "localImage", path: join(home, ".openworkshop", "runs", runId, "attachments", attachment.id, attachment.original_name) }]);
    assert.equal((database.prepare("SELECT run_id FROM attachments WHERE id = ?").get(attachment.id) as { run_id: string }).run_id, runId);
  } finally {
    await controller.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("does not steer an @Agent image already included in the initial Run snapshot", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-preparing-run-initial-image-"));
  const database = await openWorkshopDatabase(home);
  const { commissionId, taskId } = seedTask(database, home);
  const runId = seedRun(database, taskId, 1);
  database.prepare("UPDATE runs SET status = 'preparing' WHERE id = ?").run(runId);
  const attachment = await storeAttachment(database, join(home, "attachments"), { commissionId, taskId, originalName: "initial.png", mediaType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
  const inputs: CodexRunOptions["input"][] = [];
  const steers: Array<string | CodexRunOptions["input"]> = [];
  const controller = new CodexRunController(database, new EventHub(), () => ({
    initialize: async () => undefined,
    startRun: async (options) => {
      inputs.push(options.input);
      return { threadId: "thread-initial", turnId: "turn-initial", completed: new Promise<NormalizedCodexEvent>(() => undefined) };
    },
    steer: async (_threadId, _turnId, input) => { steers.push(input); },
    interrupt: async () => undefined,
    close: async () => undefined
  }), undefined, join(home, "attachments"));
  try {
    controller.queuePreparingSteer(runId, "@Agent 启动前截图", [attachment.id]);
    await controller.start(runId, home);
    assert.deepEqual(inputs[0]?.slice(1), [{ type: "localImage", path: join(home, ".openworkshop", "runs", runId, "attachments", attachment.id, attachment.original_name) }]);
    assert.deepEqual(steers, []);
    assert.equal((database.prepare("SELECT run_id FROM attachments WHERE id = ?").get(attachment.id) as { run_id: string }).run_id, runId);
  } finally {
    await controller.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("serves run details and executes steer, approval, pause, resume, interrupt, and cancel controls", async () => {
  const calls: string[] = [];
  const fixture = await runFixture({
    steer: async (runId, message) => { calls.push(`steer:${runId}:${message}`); },
    interrupt: async (runId, mode) => { calls.push(`interrupt:${runId}:${mode}`); },
    resume: async (taskId, runId) => { calls.push(`resume:${taskId}:${runId}`); return "resumed-run"; },
    decideApproval: async (runId, requestId, decision) => { calls.push(`approval:${runId}:${requestId}:${decision}`); },
    answerInput: async (runId, requestId, answers) => { calls.push(`input:${runId}:${requestId}:${answers.choice?.answers[0]}`); }
  });
  try {
    appendRunEvent(fixture.database, fixture.hub, fixture.runId, "tool.started", "Inspect source", { tool: "read" });
    appendRunEvent(fixture.database, fixture.hub, fixture.runId, "file.changed", "Changed file", { path: "src/app.ts" });
    const approvalId = randomUUID();
    fixture.database.prepare("INSERT INTO approvals (id, run_id, codex_request_id, kind, request_json, status, created_at) VALUES (?, ?, 'request-1', 'command', '{}', 'pending', ?)")
      .run(approvalId, fixture.runId, new Date().toISOString());
    fixture.database.prepare("UPDATE runs SET status = 'waiting_approval' WHERE id = ?").run(fixture.runId);

    const runStatus = (await fixture.server.inject({ method: "GET", url: "/api/runtime/run-status" })).json();
    assert.deepEqual(runStatus, { queued: 0, active: 0, waiting: 1 });

    const details = (await fixture.server.inject({ method: "GET", url: `/api/runs/${fixture.runId}` })).json();
    assert.equal(details.summaryTimeline.length, 2);
    assert.equal(details.fileChanges.length, 1);
    assert.equal(details.approvals[0].id, approvalId);

    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/runs/${fixture.runId}/steer`, payload: { message: "Check Windows too" } })).statusCode, 200);
    const decided = await fixture.server.inject({ method: "POST", url: `/api/approvals/${approvalId}/decide`, payload: { decision: "accepted", details: { scope: "once" } } });
    assert.equal(decided.statusCode, 200);
    assert.equal(decided.json().status, "accepted");

    fixture.database.prepare("UPDATE runs SET status = 'waiting_input' WHERE id = ?").run(fixture.runId);
    const answered = await fixture.server.inject({ method: "POST", url: `/api/runs/${fixture.runId}/input`, payload: { requestId: "input-1", answers: { choice: { answers: ["yes"] } } } });
    assert.equal(answered.statusCode, 200);
    assert.equal(answered.json().status, "running");

    const paused = await fixture.server.inject({ method: "POST", url: `/api/tasks/${fixture.taskId}/pause` });
    assert.equal(paused.json().status, "interrupted");
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${fixture.taskId}/resume` })).statusCode, 200);
    fixture.database.prepare("UPDATE runs SET status = 'succeeded', role = 'reviewer' WHERE id = ?").run(fixture.runId);
    fixture.database.prepare("UPDATE tasks SET status = 'blocked', review_round_used = review_round_limit WHERE id = ?").run(fixture.taskId);
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${fixture.taskId}/resume` })).statusCode, 200);

    const interruptRunId = seedRun(fixture.database, fixture.taskId, 2);
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/runs/${interruptRunId}/interrupt` })).json().status, "cancelled");
    const cancelRunId = seedRun(fixture.database, fixture.taskId, 3);
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${fixture.taskId}/cancel` })).json().status, "cancelled");

    assert.deepEqual(calls, [
      `steer:${fixture.runId}:Check Windows too`,
      `approval:${fixture.runId}:request-1:accepted`,
      `input:${fixture.runId}:input-1:yes`,
      `interrupt:${fixture.runId}:pause`,
      `resume:${fixture.taskId}:${fixture.runId}`,
      `resume:${fixture.taskId}:${fixture.runId}`,
      `interrupt:${interruptRunId}:cancel`,
      `interrupt:${cancelRunId}:cancel`
    ]);
    const timeline = (await fixture.server.inject({ method: "GET", url: `/api/runs/${fixture.runId}/events?after=0` })).json();
    assert.deepEqual(timeline.map((event: { event_type: string }) => event.event_type), ["tool.started", "file.changed", "human.message", "approval.resolved", "input.resolved", "run.status"]);
    assert.deepEqual(timeline.find((event: { event_type: string }) => event.event_type === "input.resolved").payload.answers, { choice: { answers: ["yes"] } });
  } finally {
    await fixture.close();
  }
});

test("releases an intervention attachment when Codex rejects steer", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-run-attachment-steer-"));
  const database = await openWorkshopDatabase(home);
  const { commissionId, taskId } = seedTask(database, home);
  const runId = seedRun(database, taskId, 1);
  database.prepare("UPDATE runs SET status = 'preparing' WHERE id = ?").run(runId);
  const attachment = await storeAttachment(database, join(home, "attachments"), { commissionId, taskId, originalName: "notes.txt", mediaType: "text/plain", data: Buffer.from("notes") });
  const steers: Array<string | CodexRunOptions["input"]> = [];
  const controller = new CodexRunController(database, new EventHub(), () => ({
    initialize: async () => undefined,
    startRun: async () => ({ threadId: "thread-steer", turnId: "turn-steer", completed: new Promise<NormalizedCodexEvent>(() => undefined) }),
    steer: async (_threadId, _turnId, input) => { steers.push(input); throw new Error("steer failed"); },
    interrupt: async () => undefined,
    close: async () => undefined
  }), undefined, join(home, "attachments"));
  try {
    await controller.start(runId, home);
    await assert.rejects(controller.steer(runId, "Read this", [attachment.id]), /steer failed/);
    const copyPath = join(home, ".openworkshop", "runs", runId, "attachments", attachment.id, attachment.original_name);
    assert.match(String((steers[0] as CodexRunOptions["input"])?.[0] && (steers[0] as NonNullable<CodexRunOptions["input"]>)[0]!.type === "text" ? (steers[0] as NonNullable<CodexRunOptions["input"]>)[0]!.text : ""), new RegExp(copyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(await readFile(copyPath, "utf8"), "notes");
    assert.equal((database.prepare("SELECT run_id FROM attachments WHERE id = ?").get(attachment.id) as { run_id: string | null }).run_id, null);
  } finally {
    await controller.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("releases initial Run attachments when the Codex turn cannot start", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-run-attachment-start-"));
  const database = await openWorkshopDatabase(home);
  const { commissionId, taskId } = seedTask(database, home);
  const runId = seedRun(database, taskId, 1);
  database.prepare("UPDATE runs SET status = 'preparing' WHERE id = ?").run(runId);
  const attachment = await storeAttachment(database, join(home, "attachments"), { commissionId, taskId, originalName: "notes.txt", mediaType: "text/plain", data: Buffer.from("notes") });
  database.prepare("UPDATE attachments SET run_id = ? WHERE id = ?").run(runId, attachment.id);
  const controller = new CodexRunController(database, new EventHub(), () => ({
    initialize: async () => undefined,
    startRun: async () => { throw new Error("turn start failed"); },
    steer: async () => undefined,
    interrupt: async () => undefined,
    close: async () => undefined
  }), undefined, join(home, "attachments"));
  try {
    await assert.rejects(controller.start(runId, home), /turn start failed/);
    assert.equal((database.prepare("SELECT run_id FROM attachments WHERE id = ?").get(attachment.id) as { run_id: string | null }).run_id, null);
    await assert.rejects(access(join(home, ".openworkshop", "runs", runId)));
  } finally {
    await controller.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("main task Run tree includes descendant Token data", async () => {
  const fixture = await runFixture();
  try {
    const childId = randomUUID();
    const now = new Date().toISOString();
    fixture.database.prepare(`INSERT INTO tasks (id, commission_id, parent_id, number_path, position, title, description, status, priority, owner_type, acceptance_json, review_round_limit, review_round_used, created_at, updated_at)
      SELECT ?, commission_id, id, '1.1', 1, 'Child', '', 'in_progress', 'medium', 'ai', '[]', 2, 0, ?, ? FROM tasks WHERE id = ?`).run(childId, now, now, fixture.taskId);
    const childRun = seedRun(fixture.database, childId, 1);
    fixture.database.prepare("UPDATE runs SET status = 'succeeded', token_input = 120, token_output = 30, token_cached = 80 WHERE id = ?").run(childRun);
    const own = (await fixture.server.inject({ method: "GET", url: `/api/tasks/${fixture.taskId}/runs` })).json() as Array<{ id: string }>;
    const tree = (await fixture.server.inject({ method: "GET", url: `/api/tasks/${fixture.taskId}/runs?scope=tree` })).json() as Array<{ id: string }>;
    assert.deepEqual(own.map((run) => run.id), [fixture.runId]);
    assert.deepEqual(new Set(tree.map((run) => run.id)), new Set([fixture.runId, childRun]));
    fixture.database.prepare("UPDATE tasks SET status = 'archived', archived_at = ? WHERE id IN (?, ?)").run(now, fixture.taskId, childId);
    const archivedTree = (await fixture.server.inject({ method: "GET", url: `/api/tasks/${fixture.taskId}/runs?scope=tree` })).json() as Array<{ id: string }>;
    assert.deepEqual(new Set(archivedTree.map((run) => run.id)), new Set([fixture.runId, childRun]));
  } finally { await fixture.close(); }
});

test("expires resolved input requests and validates their exact question set", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-input-runs-"));
  const database = await openWorkshopDatabase(home);
  const { taskId } = seedTask(database);
  const runId = seedRun(database, taskId, 1);
  const hub = new EventHub();
  let options!: CodexAppServerOptions;
  const answers: unknown[] = [];
  const approvalResponses: unknown[] = [];
  const completed = new Promise<NormalizedCodexEvent>(() => undefined);
  const controller = new CodexRunController(database, hub, (value) => {
    options = value;
    return {
      initialize: async () => undefined,
      startRun: async () => ({ threadId: "thread-input", turnId: "turn-input", model: "resolved-model", completed }),
      steer: async () => undefined,
      interrupt: async () => undefined,
      close: async () => undefined
    };
  });
  const server = Fastify();
  registerRunRoutes(server, database, controller, hub);
  const requestInput = (requestId: string, ids: string[]) => {
    const event = codexEvent("input.requested", "User input requested", "item/tool/requestUserInput", { questions: ids.map((id) => ({ id })) }, requestId);
    options.onEvent?.(event);
    void options.onInput?.(event, (response) => answers.push(response));
  };
  try {
    await controller.start(runId, process.cwd());
    assert.equal(JSON.parse((database.prepare("SELECT config_snapshot_json FROM runs WHERE id = ?").get(runId) as { config_snapshot_json: string }).config_snapshot_json).model, "resolved-model");
    const approval = codexEvent("approval.requested", "Command approval requested", "item/commandExecution/requestApproval", {
      commandActions: [{ command: "bash -lc \"rm -rf target\"" }], cwd: "/workspace", reason: "Remove generated output", impactScope: "target"
    }, "approval-wrapped");
    options.onEvent?.(approval);
    void options.onApproval?.(approval, () => undefined);
    const storedApproval = database.prepare("SELECT kind, request_json FROM approvals WHERE codex_request_id = 'approval-wrapped'").get() as { kind: string; request_json: string };
    assert.equal(storedApproval.kind, "high_risk");
    assert.deepEqual(JSON.parse(storedApproval.request_json), {
      commandActions: [{ command: "bash -lc \"rm -rf target\"" }], cwd: "/workspace", reason: "Remove generated output", impactScope: "target",
      executable: "rm", arguments: ["-rf", "target"], redacted: false
    });
    options.onEvent?.(codexEvent("request.resolved", "Server request resolved", "serverRequest/resolved", { requestId: "approval-wrapped" }));

    const mcpApproval = codexEvent("approval.requested", "MCP tool approval requested", "mcpServer/elicitation/request", {
      serverName: "computer-use", mode: "form", message: "Allow Computer Use?", requestedSchema: { type: "object", properties: {} },
      _meta: { codex_request_type: "approval_request", codex_approval_kind: "mcp_tool_call" }
    }, "mcp-approval");
    options.onEvent?.(mcpApproval);
    void options.onApproval?.(mcpApproval, (response) => approvalResponses.push(response));
    const storedMcpApproval = database.prepare("SELECT id, kind FROM approvals WHERE codex_request_id = 'mcp-approval'").get() as { id: string; kind: string };
    assert.equal(storedMcpApproval.kind, "mcp_tool_call");
    assert.equal((database.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status, "waiting_approval");
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM notifications WHERE entity_type = 'approval' AND entity_id = ? AND read_at IS NULL").get(storedMcpApproval.id) as { count: number }).count, 1);
    assert.equal((await server.inject({ method: "POST", url: `/api/approvals/${storedMcpApproval.id}/decide`, payload: { decision: "accepted" } })).statusCode, 200);
    assert.deepEqual(approvalResponses, [{ decision: "accept" }]);
    assert.equal((database.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status, "running");

    requestInput("input-1", ["choice", "reason"]);
    assert.equal((await server.inject({ method: "POST", url: `/api/runs/${runId}/input`, payload: { requestId: "input-1", answers: {} } })).statusCode, 400);
    assert.equal((await server.inject({ method: "POST", url: `/api/runs/${runId}/input`, payload: { requestId: "input-1", answers: { choice: { answers: ["yes"] }, other: { answers: ["x"] } } } })).statusCode, 400);
    assert.equal((await server.inject({ method: "POST", url: `/api/runs/${runId}/input`, payload: { requestId: "input-1", answers: { choice: { answers: ["yes"] } } } })).statusCode, 400);
    options.onEvent?.(codexEvent("request.resolved", "Server request resolved", "serverRequest/resolved", { requestId: "input-1" }));
    assert.equal((database.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status, "running");
    assert.equal((await server.inject({ method: "POST", url: `/api/runs/${runId}/input`, payload: { requestId: "input-1", answers: { choice: { answers: ["yes"] }, reason: { answers: ["ok"] } } } })).statusCode, 409);

    requestInput("input-2", ["choice"]);
    assert.equal((await server.inject({ method: "POST", url: `/api/runs/${runId}/input`, payload: { requestId: "input-2", answers: { choice: { answers: ["yes"] } } } })).statusCode, 200);
    assert.deepEqual(answers, [{ answers: { choice: { answers: ["yes"] } } }]);
  } finally {
    await controller.close();
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("keeps an active Run recoverable when the controller closes normally", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-run-shutdown-"));
  const database = await openWorkshopDatabase(home);
  const { taskId } = seedTask(database, home);
  const runId = seedRun(database, taskId, 1);
  database.prepare("UPDATE runs SET status = 'preparing' WHERE id = ?").run(runId);
  let rejectCompletion!: (error: Error) => void;
  const completed = new Promise<NormalizedCodexEvent>((_resolve, reject) => { rejectCompletion = reject; });
  const terminal: string[] = [];
  const controller = new CodexRunController(database, new EventHub(), () => ({
    initialize: async () => undefined,
    startRun: async () => ({ threadId: "thread-shutdown", turnId: "turn-shutdown", completed }),
    steer: async () => undefined,
    interrupt: async () => undefined,
    close: async () => { rejectCompletion(new Error("closed by test host")); }
  }), async (id) => { terminal.push(id); });
  try {
    await controller.start(runId, home);
    await controller.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const run = database.prepare("SELECT status, finished_at, failure_summary FROM runs WHERE id = ?").get(runId) as { status: string; finished_at: string | null; failure_summary: string | null };
    assert.equal(run.status, "running");
    assert.equal(run.finished_at, null);
    assert.equal(run.failure_summary, null);
    assert.deepEqual(terminal, []);
  } finally {
    await controller.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

async function runFixture(overrides: Partial<RunController> = {}) {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-runs-"));
  const database = await openWorkshopDatabase(home);
  const { taskId } = seedTask(database);
  const runId = seedRun(database, taskId, 1);
  const controller: RunController = {
    steer: overrides.steer ?? (async () => undefined),
    interrupt: overrides.interrupt ?? (async () => undefined),
    resume: overrides.resume ?? (async () => "resumed-run"),
    decideApproval: overrides.decideApproval ?? (async () => undefined),
    answerInput: overrides.answerInput ?? (async () => undefined)
  };
  const server = Fastify();
  const hub = new EventHub();
  registerRunRoutes(server, database, controller, hub);
  return {
    home, database, server, hub, taskId, runId,
    close: async () => { await server.close(); database.close(); await rm(home, { recursive: true, force: true }); }
  };
}

function seedTask(database: Awaited<ReturnType<typeof openWorkshopDatabase>>, projectPath?: string) {
  const now = new Date().toISOString();
  const rootId = randomUUID();
  const projectId = randomUUID();
  const commissionId = randomUUID();
  const requirementId = randomUUID();
  const taskId = randomUUID();
  database.prepare("INSERT INTO root_paths (id, path, real_path, enabled, created_at, updated_at) VALUES (?, 'root', ?, 1, ?, ?)").run(rootId, `root-${rootId}`, now, now);
  database.prepare("INSERT INTO projects (id, name, path, real_path, root_path_id, vcs_type, created_at, updated_at) VALUES (?, 'Project', 'project', ?, ?, 'none', ?, ?)").run(projectId, projectPath ?? `project-${projectId}`, rootId, now, now);
  database.prepare("INSERT INTO commissions (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, 'Commission', 'active', ?, ?)").run(commissionId, projectId, now, now);
  database.prepare("INSERT INTO requirement_versions (id, commission_id, version_no, content_markdown, acceptance_json, status, created_by, created_at, approved_at) VALUES (?, ?, 1, 'Requirement', '[]', 'approved', 'human', ?, ?)").run(requirementId, commissionId, now, now);
  database.prepare("UPDATE commissions SET active_requirement_version_id = ? WHERE id = ?").run(requirementId, commissionId);
  database.prepare("INSERT INTO tasks (id, commission_id, number_path, position, title, description, status, priority, owner_type, acceptance_json, review_round_limit, review_round_used, created_at, updated_at) VALUES (?, ?, '1', 0, 'Task', 'Task', 'in_progress', 'high', 'ai', '[]', 1, 0, ?, ?)").run(taskId, commissionId, now, now);
  return { projectId, commissionId, taskId };
}

function seedRun(database: Awaited<ReturnType<typeof openWorkshopDatabase>>, taskId: string, attempt: number): string {
  const task = database.prepare("SELECT commission_id FROM tasks WHERE id = ?").get(taskId) as { commission_id: string };
  const project = database.prepare("SELECT project_id FROM commissions WHERE id = ?").get(task.commission_id) as { project_id: string };
  const id = randomUUID();
  database.prepare("INSERT INTO runs (id, project_id, commission_id, task_id, role, trigger_type, status, attempt_no, config_snapshot_json, context_snapshot_json, started_at) VALUES (?, ?, ?, ?, 'developer', 'manual', 'running', ?, '{}', '{}', ?)")
    .run(id, project.project_id, task.commission_id, taskId, attempt, new Date().toISOString());
  return id;
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes(marker)) {
    const result = await reader.read();
    if (result.done) break;
    output += decoder.decode(result.value, { stream: true });
  }
  return output;
}

function fakeRunClientLauncher(database: Awaited<ReturnType<typeof openWorkshopDatabase>>, calls: string[]): RunClientLauncher {
  let sequence = 0;
  return (options: CodexAppServerOptions) => {
    const id = ++sequence;
    const runId = (database.prepare("SELECT id FROM runs WHERE status = 'preparing' ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id;
    const automaticPermission = Boolean((database.prepare("SELECT task.auto_approve_permissions FROM tasks AS task JOIN runs AS run ON run.task_id = task.id WHERE run.id = ?").get(runId) as { auto_approve_permissions: number }).auto_approve_permissions);
    let complete!: (event: NormalizedCodexEvent) => void;
    const completed = new Promise<NormalizedCodexEvent>((resolve) => { complete = resolve; });
    const handle: CodexRunHandle = { threadId: `thread-${id}`, turnId: `turn-${id}`, completed };
    if (options.args) calls.push(`args:${JSON.stringify(options.args)}`);
    return {
      initialize: async () => { calls.push(`initialize:${runId}`); },
      startRun: async (run: CodexRunOptions) => {
        calls.push(`approval-policy:${run.approvalPolicy}`);
        calls.push(`sandbox:${run.sandbox}`);
        if (run.model) calls.push(`model:${run.model}`);
        if (run.effort) calls.push(`effort:${run.effort}`);
        calls.push(`prompt:${run.prompt}`);
        options.onEvent?.(codexEvent("turn.started", "Turn started", "turn/started", { turn: { id: handle.turnId } }));
        options.onEvent?.(codexEvent("token.usage", "Token usage updated", "thread/tokenUsage/updated", { threadId: handle.threadId, turnId: handle.turnId, tokenUsage: { total: { totalTokens: 150, inputTokens: 120, cachedInputTokens: 90, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 10 }, last: { totalTokens: 150, inputTokens: 120, cachedInputTokens: 90, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 10 }, modelContextWindow: 200000 } }));
        options.onEvent?.(codexEvent("agent.message.delta", "Agent message", "item/agentMessage/delta", { delta: "working" }));
        const approval = automaticPermission
          ? codexEvent("approval.requested", "Sandbox permission requested", "item/permissions/requestApproval", { permissions: ["network"] }, `approval-${id}`)
          : codexEvent("approval.requested", "Command approval requested", "item/commandExecution/requestApproval", { command: "npm test" }, `approval-${id}`);
        options.onEvent?.(approval);
        await options.onApproval?.(approval, (decision) => {
          const value = decision as { decision?: string; scope?: string };
          calls.push(`approval:${value.decision}:${value.scope}`);
        });
        return handle;
      },
      steer: async (_threadId, _turnId, message) => { calls.push(`steer:${runId}:${message}`); },
      interrupt: async () => {
        calls.push(`interrupt:${runId}`);
        const event = codexEvent("turn.interrupted", "Turn interrupted", "turn/completed", { turn: { id: handle.turnId, status: "interrupted" } });
        options.onEvent?.(event);
        complete(event);
      },
      close: async () => { calls.push(`close:${runId}`); }
    };
  };
}

function codexEvent(type: string, summary: string, method: string, payload: Record<string, unknown>, requestId?: string): NormalizedCodexEvent {
  return { type, summary, method, payload, ...(requestId ? { requestId } : {}) };
}

async function api(address: string, cookie: string, path: string, payload?: Record<string, unknown>) {
  const response = await fetch(`${address}${path}`, {
    method: "POST",
    headers: { cookie, ...(payload ? { "Content-Type": "application/json" } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

function terminalStatuses(database: Awaited<ReturnType<typeof openWorkshopDatabase>>, runId: string): string[] {
  return (database.prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND event_type = 'run.status' ORDER BY id").all(runId) as Array<{ payload_json: string }>)
    .map(({ payload_json }) => String((JSON.parse(payload_json) as { status?: string }).status))
    .filter((status) => ["succeeded", "failed", "cancelled", "interrupted"].includes(status));
}
