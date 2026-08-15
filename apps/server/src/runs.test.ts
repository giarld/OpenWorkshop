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
import { answerRevisionCard, beginPlanRevision, saveRevisionProposal } from "./plan-revisions.ts";
import { appendRunEvent, approvalKind, codexTokenUsage, CodexRunController, EventHub, pruneRawRunEvents, registerProductionRunRoutes, registerRunRoutes, type RunClientLauncher, type RunController } from "./runs.ts";
import { registerTaskRoutes } from "./tasks.ts";

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

test("pausing an exclusive Run starts the next queued task", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-pause-queue-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  const calls: string[] = [];
  try {
    const { commissionId, taskId: mainTaskId } = seedTask(database, home);
    const now = new Date().toISOString();
    database.prepare("UPDATE commissions SET main_task_id = ? WHERE id = ?").run(mainTaskId, commissionId);
    database.prepare("UPDATE tasks SET status = 'backlog' WHERE id = ?").run(mainTaskId);
    for (const [numberPath, title] of [["1.1", "First"], ["1.2", "Second"]] as const) {
      database.prepare(`INSERT INTO tasks (id, commission_id, parent_id, number_path, position, title, description, status, priority, owner_type, acceptance_json, review_round_limit, review_round_used, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, ?, ?, 'backlog', 'high', 'ai', '[]', 1, 0, ?, ?)`).run(randomUUID(), commissionId, mainTaskId, numberPath, title, title, now, now);
    }
    await registerProductionRunRoutes(server, database, fakeRunClientLauncher(database, calls));

    const triggered = await server.inject({ method: "POST", url: `/api/tasks/${mainTaskId}/trigger` });
    assert.equal(triggered.statusCode, 200);
    const runIds = triggered.json().runIds as string[];
    assert.equal(runIds.length, 2);
    const runs = runIds.map((id) => database.prepare("SELECT id, task_id, status FROM runs WHERE id = ?").get(id) as { id: string; task_id: string; status: string });
    const active = runs.find(({ status }) => status === "waiting_approval")!;
    const queued = runs.find(({ status }) => status === "queued")!;

    const paused = await server.inject({ method: "POST", url: `/api/tasks/${active.task_id}/pause` });
    assert.equal(paused.statusCode, 200);
    assert.equal(paused.json().status, "interrupted");
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((database.prepare("SELECT status FROM runs WHERE id = ?").get(queued.id) as { status: string }).status !== "queued") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(["preparing", "running", "waiting_approval"].includes((database.prepare("SELECT status FROM runs WHERE id = ?").get(queued.id) as { status: string }).status));
    assert.ok(calls.includes(`interrupt:${active.id}`));
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

test("starts a scheduling Agent when the main task is mentioned", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-main-task-coordinate-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  const prompts: string[] = [];
  try {
    const { commissionId, taskId: mainTaskId } = seedTask(database, home);
    database.prepare("UPDATE commissions SET main_task_id = ? WHERE id = ?").run(mainTaskId, commissionId);
    const childTaskId = randomUUID();
    const previousRunId = randomUUID();
    const interruptedRunId = randomUUID();
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO tasks (id, commission_id, parent_id, number_path, position, title, description, status, priority, owner_type, acceptance_json, review_round_limit, review_round_used, created_at, updated_at)
      VALUES (?, ?, ?, '1.1', 0, 'Child', 'Child work', 'todo', 'high', 'ai', '[]', 1, 0, ?, ?)`).run(childTaskId, commissionId, mainTaskId, now, now);
    database.prepare("INSERT INTO runs (id, project_id, commission_id, task_id, role, trigger_type, status, attempt_no, config_snapshot_json, context_snapshot_json) SELECT ?, project_id, id, ?, 'reviewer', 'review', 'succeeded', 1, '{}', '{}' FROM commissions WHERE id = ?").run(previousRunId, childTaskId, commissionId);
    database.prepare("INSERT INTO runs (id, project_id, commission_id, task_id, role, trigger_type, status, attempt_no, config_snapshot_json, context_snapshot_json) SELECT ?, project_id, id, ?, 'developer', 'resume', 'interrupted', 2, '{}', '{}' FROM commissions WHERE id = ?").run(interruptedRunId, childTaskId, commissionId);
    database.prepare("INSERT INTO evidence (id, task_id, run_id, criterion_key, type, status, summary, payload_json, created_at) VALUES (?, ?, ?, '*', 'review', 'failed', 'Blocking review result', ?, ?)")
      .run(randomUUID(), childTaskId, previousRunId, JSON.stringify({ passed: false, findings: [{ severity: "blocking", message: "Missing regression test" }] }), now);
    const mentionAgent = await registerProductionRunRoutes(server, database, () => ({
      initialize: async () => undefined,
      startRun: async (options) => { prompts.push(options.prompt); return { threadId: "thread-coordinate", turnId: "turn-coordinate", completed: new Promise<NormalizedCodexEvent>(() => undefined) }; },
      steer: async () => undefined,
      interrupt: async () => undefined,
      close: async () => undefined
    }), join(home, "attachments"));
    database.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(childTaskId);

    const result = await mentionAgent(mainTaskId, "@Agent 请分析后推进");
    assert.equal(result.action, "triggered");
    const run = database.prepare("SELECT task_id, role, trigger_type FROM runs WHERE id = ?").get(result.runId!) as { task_id: string; role: string; trigger_type: string };
    assert.equal(run.task_id, mainTaskId);
    assert.equal(run.role, "supervisor");
    assert.equal(run.trigger_type, "coordinate");
    assert.match(prompts[0]!, /project scheduling Agent/);
    const taskTree = await readFile(join(home, ".openworkshop", "runs", result.runId!, "task-tree.md"), "utf8");
    assert.match(taskTree, /1\.1 Child/);
    assert.match(taskTree, new RegExp(childTaskId));
    assert.match(taskTree, new RegExp(`Latest Run: ${interruptedRunId} · developer · interrupted`));
    assert.match(taskTree, new RegExp(`Run history:.*${previousRunId}.*reviewer.*succeeded.*${interruptedRunId}.*developer.*interrupted`));
    assert.match(taskTree, new RegExp(`Evidence: review/failed · run:${previousRunId} · Blocking review result`));
    assert.match(taskTree, /Missing regression test/);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM runs WHERE task_id = ?").get(childTaskId) as { count: number }).count, 2);
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("retries an active plan revision instead of coordinating the main task", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-main-task-revision-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  try {
    const { commissionId, taskId } = seedTask(database, home);
    database.prepare("UPDATE commissions SET main_task_id = ? WHERE id = ?").run(taskId, commissionId);
    const revisionId = beginPlanRevision(database, commissionId, "调整计划");
    const card = database.prepare("SELECT comment_id FROM plan_revision_cards WHERE plan_revision_id = ? AND status = 'pending'").get(revisionId) as { comment_id: string };
    answerRevisionCard(database, taskId, card.comment_id, "合并任务");
    saveRevisionProposal(database, revisionId, { summary: "合并任务", changes: [] });
    const mentionAgent = await registerProductionRunRoutes(server, database, () => ({
      initialize: async () => undefined,
      startRun: async () => ({ threadId: "thread-revision", turnId: "turn-revision", completed: new Promise<NormalizedCodexEvent>(() => undefined) }),
      steer: async () => undefined,
      interrupt: async () => undefined,
      close: async () => undefined
    }), join(home, "attachments"));

    const result = await mentionAgent(taskId, "@Agent 再次尝试任务合并");

    assert.equal(result.action, "triggered");
    assert.equal((database.prepare("SELECT trigger_type FROM runs WHERE id = ?").get(result.runId!) as { trigger_type: string }).trigger_type, "plan_revision_review");
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM runs WHERE task_id = ? AND trigger_type = 'coordinate'").get(taskId) as { count: number }).count, 0);
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("final board move cancels the server Run and starts main-task coordination", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-final-board-move-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  const prompts: string[] = [];
  try {
    const { commissionId, taskId: mainTaskId } = seedTask(database, home);
    database.prepare("UPDATE commissions SET main_task_id = ? WHERE id = ?").run(mainTaskId, commissionId);
    const handler = await registerProductionRunRoutes(server, database, () => ({
      initialize: async () => undefined,
      startRun: async (options) => { prompts.push(options.prompt); return { threadId: "thread-final-coordinate", turnId: "turn-final-coordinate", completed: new Promise<NormalizedCodexEvent>(() => undefined) }; },
      steer: async () => undefined,
      interrupt: async () => undefined,
      close: async () => undefined
    }), join(home, "attachments"));
    registerTaskRoutes(server, database, handler, join(home, "attachments"));
    const childTaskId = randomUUID();
    const queuedRunId = randomUUID();
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO tasks (id, commission_id, parent_id, number_path, position, title, description, status, priority, owner_type, acceptance_json, review_round_limit, review_round_used, created_at, updated_at)
      VALUES (?, ?, ?, '1.1', 0, 'Child', 'Child work', 'in_progress', 'high', 'ai', '[]', 1, 0, ?, ?)`).run(childTaskId, commissionId, mainTaskId, now, now);
    database.prepare("INSERT INTO runs (id, project_id, commission_id, task_id, role, trigger_type, status, attempt_no, config_snapshot_json, context_snapshot_json) SELECT ?, project_id, id, ?, 'developer', 'scheduler', 'queued', 1, '{}', '{}' FROM commissions WHERE id = ?")
      .run(queuedRunId, childTaskId, commissionId);

    const moved = await server.inject({ method: "POST", url: `/api/tasks/${childTaskId}/move`, payload: { status: "done", boardMove: true } });

    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().status, "done");
    assert.equal((database.prepare("SELECT status FROM runs WHERE id = ?").get(queuedRunId) as { status: string }).status, "cancelled");
    assert.equal((database.prepare("SELECT status FROM commissions WHERE id = ?").get(commissionId) as { status: string }).status, "active");
    const coordinator = database.prepare("SELECT status FROM runs WHERE task_id = ? AND trigger_type = 'coordinate' ORDER BY rowid DESC LIMIT 1").get(mainTaskId) as { status: string } | undefined;
    assert.equal(coordinator?.status, "running");
    assert.match(prompts[0]!, /scan every Done child/);
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("reconcile context distinguishes a successful Reviewer Run from a failed review", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-review-reconcile-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  const prompts: string[] = [];
  try {
    const { commissionId, taskId } = seedTask(database, home);
    const reviewerRunId = randomUUID();
    const now = new Date().toISOString();
    const review = { passed: false, summary: "Reviewer found four blocking gaps", checks: [], findings: [{ severity: "blocking", file: "tests/example.cpp", line: 10, message: "Missing coverage" }] };
    database.prepare("UPDATE tasks SET status = 'blocked', blocked_reason = 'Review exhausted' WHERE id = ?").run(taskId);
    database.prepare("INSERT INTO runs (id, project_id, commission_id, task_id, role, trigger_type, status, attempt_no, config_snapshot_json, context_snapshot_json) SELECT ?, project_id, id, ?, 'reviewer', 'review', 'succeeded', 1, '{}', '{}' FROM commissions WHERE id = ?")
      .run(reviewerRunId, taskId, commissionId);
    database.prepare("INSERT INTO evidence (id, task_id, run_id, criterion_key, type, status, summary, payload_json, created_at) VALUES (?, ?, ?, '*', 'review', 'failed', ?, ?, ?)")
      .run(randomUUID(), taskId, reviewerRunId, review.summary, JSON.stringify(review), now);
    appendRunEvent(database, new EventHub(), reviewerRunId, "agent_message.completed", "agentMessage completed", { method: "item/completed", item: { type: "agentMessage", id: "review-message", text: JSON.stringify(review) } });
    addTaskComment(database, { taskId, authorType: "human", content: "人工已修复并测试通过" });
    const mentionAgent = await registerProductionRunRoutes(server, database, () => ({
      initialize: async () => undefined,
      startRun: async (options) => { prompts.push(options.prompt); return { threadId: "thread-reconcile", turnId: "turn-reconcile", completed: new Promise<NormalizedCodexEvent>(() => undefined) }; },
      steer: async () => undefined,
      interrupt: async () => undefined,
      close: async () => undefined
    }), join(home, "attachments"));

    const result = await mentionAgent(taskId, "@Agent 已人工修复并测试通过");
    assert.equal(result.action, "triggered");
    const previousRuns = await readFile(join(home, ".openworkshop", "runs", result.runId!, "previous-runs.md"), "utf8");
    assert.match(previousRuns, /Attempt 1 · reviewer · Run succeeded · review · Review failed · Reviewer found four blocking gaps/);
    assert.match(previousRuns, /agent_message\.completed/);
    assert.match(previousRuns, /Missing coverage/);
    assert.match(prompts[0]!, /distinguish Run execution status from the structured review result/);
    assert.match(prompts[0]!, /human or external process changed or validated the current workspace/);
    assert.match(prompts[0]!, /Never use wait_human for final acceptance or task closure of a child task/);
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Run validation policy keeps main-task instructions global and child instructions local", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-validation-scope-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  const prompts: string[] = [];
  try {
    const { commissionId, taskId: mainTaskId } = seedTask(database, home);
    const childTaskId = randomUUID();
    const siblingTaskId = randomUUID();
    const now = new Date().toISOString();
    database.prepare("UPDATE commissions SET main_task_id = ? WHERE id = ?").run(mainTaskId, commissionId);
    database.prepare(`INSERT INTO tasks (id, commission_id, parent_id, number_path, position, title, description, status, priority, owner_type, acceptance_json, review_round_limit, review_round_used, created_at, updated_at)
      VALUES (?, ?, ?, '1.1', 0, 'Child', '', 'todo', 'high', 'ai', '[]', 1, 0, ?, ?),
             (?, ?, ?, '1.2', 1, 'Sibling', '', 'todo', 'high', 'ai', '[]', 1, 0, ?, ?)`)
      .run(childTaskId, commissionId, mainTaskId, now, now, siblingTaskId, commissionId, mainTaskId, now, now);
    addTaskComment(database, { taskId: mainTaskId, authorType: "human", content: "主任务要求使用 Release 构建并运行 CTest" });
    addTaskComment(database, { taskId: childTaskId, authorType: "human", content: "仅此任务跳过慢速压力测试" });
    addTaskComment(database, { taskId: siblingTaskId, authorType: "human", content: "仅兄弟任务使用 Debug 构建" });
    const mentionAgent = await registerProductionRunRoutes(server, database, () => ({
      initialize: async () => undefined,
      startRun: async (options) => { prompts.push(options.prompt); return { threadId: "thread-policy", turnId: "turn-policy", completed: new Promise<NormalizedCodexEvent>(() => undefined) }; },
      steer: async () => undefined,
      interrupt: async () => undefined,
      close: async () => undefined
    }), join(home, "attachments"));

    const result = await mentionAgent(childTaskId, "@Agent 执行并验证");
    assert.equal(result.action, "triggered");
    const runDirectory = join(home, ".openworkshop", "runs", result.runId!);
    const policy = await readFile(join(runDirectory, "execution-policy.md"), "utf8");
    const messages = await readFile(join(runDirectory, "messages.md"), "utf8");
    assert.match(policy, /execute relevant build, test, and validation commands autonomously/);
    assert.match(policy, /主任务要求使用 Release 构建并运行 CTest/);
    assert.doesNotMatch(policy, /仅兄弟任务使用 Debug 构建/);
    assert.match(messages, /仅此任务跳过慢速压力测试/);
    assert.doesNotMatch(messages, /仅兄弟任务使用 Debug 构建/);
    assert.match(prompts[0]!, new RegExp(join(runDirectory, "execution-policy.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("recovered scheduling Agent rebuilds task Run context after restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-coordinate-recovery-context-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  try {
    const { commissionId, taskId: mainTaskId } = seedTask(database, home);
    const projectId = (database.prepare("SELECT project_id FROM commissions WHERE id = ?").get(commissionId) as { project_id: string }).project_id;
    const childTaskId = randomUUID();
    const childRunId = randomUUID();
    const coordinateRunId = randomUUID();
    const grantId = randomUUID();
    const now = new Date().toISOString();
    database.prepare("UPDATE commissions SET main_task_id = ?, status = 'active' WHERE id = ?").run(mainTaskId, commissionId);
    database.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(mainTaskId);
    database.prepare(`INSERT INTO tasks (id, commission_id, parent_id, number_path, position, title, description, status, priority, owner_type, acceptance_json, review_round_limit, review_round_used, created_at, updated_at)
      VALUES (?, ?, ?, '1.1', 0, 'Interrupted child', '', 'in_progress', 'high', 'ai', '[]', 1, 0, ?, ?)`).run(childTaskId, commissionId, mainTaskId, now, now);
    const coordinationRevision = (database.prepare("SELECT coordination_revision FROM commissions WHERE id = ?").get(commissionId) as { coordination_revision: number }).coordination_revision;
    database.prepare("UPDATE commissions SET coordination_pending = 1 WHERE id = ?").run(commissionId);
    database.prepare("INSERT INTO execution_grants (id, commission_id, root_task_id, scope, status, created_at) VALUES (?, ?, ?, 'commission_tree', 'active', ?)").run(grantId, commissionId, mainTaskId, now);
    database.prepare("INSERT INTO runs (id, project_id, commission_id, task_id, role, trigger_type, execution_grant_id, status, attempt_no, config_snapshot_json, context_snapshot_json, coordination_revision) VALUES (?, ?, ?, ?, 'supervisor', 'coordinate', ?, 'running', 1, '{}', ?, ?)")
      .run(coordinateRunId, projectId, commissionId, mainTaskId, grantId, JSON.stringify({ version: 1, files: { "task-tree.md": "STALE CHILD STATUS: running" } }), coordinationRevision);
    database.prepare("INSERT INTO runs (id, project_id, commission_id, task_id, role, trigger_type, status, attempt_no, config_snapshot_json, context_snapshot_json) VALUES (?, ?, ?, ?, 'developer', 'scheduler', 'running', 1, '{}', '{}')")
      .run(childRunId, projectId, commissionId, childTaskId);
    await registerProductionRunRoutes(server, database, () => ({
      initialize: async () => undefined,
      startRun: async () => ({ threadId: "thread-recovered-coordinate", turnId: "turn-recovered-coordinate", completed: new Promise<NormalizedCodexEvent>(() => undefined) }),
      steer: async () => undefined, interrupt: async () => undefined, close: async () => undefined
    }), join(home, "attachments"));

    const recovered = database.prepare("SELECT id FROM runs WHERE retry_root_run_id = ? AND trigger_type = 'coordinate'").get(coordinateRunId) as { id: string };
    const taskTree = await readFile(join(home, ".openworkshop", "runs", recovered.id, "task-tree.md"), "utf8");
    assert.doesNotMatch(taskTree, /STALE CHILD STATUS/);
    assert.match(taskTree, new RegExp(`Latest Run: ${childRunId} · developer · interrupted`));
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("main-task mention during acceptance does not queue a coordinator or change task status", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-coordinate-awaiting-acceptance-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  try {
    const { commissionId, taskId } = seedTask(database, home);
    const now = new Date().toISOString();
    database.prepare("UPDATE commissions SET main_task_id = ?, status = 'awaiting_acceptance' WHERE id = ?").run(taskId, commissionId);
    database.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(taskId);
    database.prepare("INSERT INTO execution_grants (id, commission_id, root_task_id, scope, status, created_at) VALUES (?, ?, ?, 'commission_tree', 'active', ?)").run(randomUUID(), commissionId, taskId, now);
    const mentionAgent = await registerProductionRunRoutes(server, database, () => { throw new Error("acceptance coordinator must not launch"); }, join(home, "attachments"));
    const result = await mentionAgent(taskId, "@Agent 继续");
    assert.equal(result.action, "unavailable");
    assert.equal((database.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string }).status, "in_progress");
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM runs WHERE task_id = ? AND trigger_type = 'coordinate'").get(taskId) as { count: number }).count, 0);
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

test("interrupts a Run cancelled while Codex is starting the turn", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-starting-run-cancel-"));
  const database = await openWorkshopDatabase(home);
  const { taskId } = seedTask(database, home);
  const runId = seedRun(database, taskId, 1);
  database.prepare("UPDATE runs SET status = 'preparing' WHERE id = ?").run(runId);
  let provideHandle!: (handle: CodexRunHandle) => void;
  let startRunEntered!: () => void;
  const entered = new Promise<void>((resolve) => { startRunEntered = resolve; });
  let complete!: (event: NormalizedCodexEvent) => void;
  const completed = new Promise<NormalizedCodexEvent>((resolve) => { complete = resolve; });
  const interrupts: string[] = [];
  const terminal: string[] = [];
  let reachTerminal!: () => void;
  const terminalReached = new Promise<void>((resolve) => { reachTerminal = resolve; });
  const controller = new CodexRunController(database, new EventHub(), () => ({
    initialize: async () => undefined,
    startRun: async () => {
      startRunEntered();
      return new Promise<CodexRunHandle>((resolve) => { provideHandle = resolve; });
    },
    steer: async () => undefined,
    interrupt: async (threadId, turnId) => {
      interrupts.push(`${threadId}:${turnId}`);
      complete(codexEvent("turn.interrupted", "Turn interrupted", "turn/completed", { turn: { id: turnId, status: "interrupted" } }));
    },
    close: async () => undefined
  }), async (id) => { terminal.push(id); reachTerminal(); });
  try {
    const starting = controller.start(runId, home);
    await entered;
    await controller.interrupt(runId, "cancel");
    provideHandle({ threadId: "thread-starting", turnId: "turn-starting", completed });
    await starting;
    await terminalReached;
    assert.deepEqual(interrupts, ["thread-starting:turn-starting"]);
    assert.deepEqual(terminal, [runId]);
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

test("restores pending approvals and Coordinator state when interrupting Codex fails", async () => {
  const fixture = await runFixture({ interrupt: async () => { throw new Error("interrupt failed"); } });
  try {
    const approvalId = randomUUID();
    const commissionId = (fixture.database.prepare("SELECT commission_id FROM runs WHERE id = ?").get(fixture.runId) as { commission_id: string }).commission_id;
    fixture.database.prepare("INSERT INTO approvals (id, run_id, codex_request_id, kind, request_json, status, created_at) VALUES (?, ?, 'request-failed-interrupt', 'command', '{}', 'pending', ?)")
      .run(approvalId, fixture.runId, new Date().toISOString());
    fixture.database.prepare("UPDATE runs SET status = 'waiting_approval', trigger_type = 'coordinate' WHERE id = ?").run(fixture.runId);
    fixture.database.prepare("UPDATE commissions SET coordination_pending = 1 WHERE id = ?").run(commissionId);

    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${fixture.taskId}/cancel` })).statusCode, 500);
    assert.deepEqual({ ...fixture.database.prepare("SELECT status, finished_at FROM runs WHERE id = ?").get(fixture.runId) }, { status: "waiting_approval", finished_at: null });
    assert.deepEqual({ ...fixture.database.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(approvalId) }, { status: "pending", decided_at: null });
    assert.equal((fixture.database.prepare("SELECT coordination_pending FROM commissions WHERE id = ?").get(commissionId) as { coordination_pending: number }).coordination_pending, 1);
  } finally { await fixture.close(); }
});

test("keeps a Run cancelled when Codex initialization later fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-initialize-cancel-"));
  const database = await openWorkshopDatabase(home);
  const { taskId } = seedTask(database, home);
  const runId = seedRun(database, taskId, 1);
  database.prepare("UPDATE runs SET status = 'preparing' WHERE id = ?").run(runId);
  let enteredInitialize!: () => void;
  let rejectInitialize!: (error: Error) => void;
  const initializeEntered = new Promise<void>((resolve) => { enteredInitialize = resolve; });
  const initializing = new Promise<void>((_resolve, reject) => { rejectInitialize = reject; });
  const hub = new EventHub();
  const controller = new CodexRunController(database, hub, () => ({
    initialize: async () => { enteredInitialize(); await initializing; },
    startRun: async () => ({ threadId: "unused", turnId: "unused", completed: new Promise<NormalizedCodexEvent>(() => undefined) }),
    steer: async () => undefined,
    interrupt: async () => undefined,
    close: async () => undefined
  }));
  const server = Fastify();
  registerRunRoutes(server, database, controller, hub);
  try {
    const starting = controller.start(runId, home);
    await initializeEntered;
    assert.equal((await server.inject({ method: "POST", url: `/api/tasks/${taskId}/cancel` })).json().status, "cancelled");
    rejectInitialize(new Error("initialize failed"));
    await assert.rejects(starting, /initialize failed/);
    assert.deepEqual({ ...database.prepare("SELECT status, failure_summary FROM runs WHERE id = ?").get(runId) }, { status: "cancelled", failure_summary: null });
  } finally {
    await controller.close();
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("releases claimed attachments when cancelling a queued Run", async () => {
  const fixture = await runFixture();
  try {
    const commissionId = (fixture.database.prepare("SELECT commission_id FROM tasks WHERE id = ?").get(fixture.taskId) as { commission_id: string }).commission_id;
    const attachment = await storeAttachment(fixture.database, join(fixture.home, "attachments"), { commissionId, taskId: fixture.taskId, originalName: "queued.txt", mediaType: "text/plain", data: Buffer.from("queued") });
    fixture.database.prepare("UPDATE runs SET status = 'queued', started_at = NULL WHERE id = ?").run(fixture.runId);
    fixture.database.prepare("UPDATE attachments SET run_id = ? WHERE id = ?").run(fixture.runId, attachment.id);

    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${fixture.taskId}/cancel` })).json().status, "cancelled");
    assert.equal((fixture.database.prepare("SELECT run_id FROM attachments WHERE id = ?").get(attachment.id) as { run_id: string | null }).run_id, null);
  } finally { await fixture.close(); }
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
    assert.deepEqual(runStatus, { queued: 0, active: 0, waiting: 1, tasks: [{ taskId: fixture.taskId, status: "waiting_approval", numberPath: "1", title: "Task", description: "Task", projectName: "Project" }] });

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
    const queuedRunId = seedRun(fixture.database, fixture.taskId, 4);
    fixture.database.prepare("UPDATE runs SET status = 'queued' WHERE id = ?").run(queuedRunId);
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${fixture.taskId}/cancel` })).json().status, "cancelled");
    const queuedInterruptRunId = seedRun(fixture.database, fixture.taskId, 5);
    fixture.database.prepare("UPDATE runs SET status = 'queued' WHERE id = ?").run(queuedInterruptRunId);
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/runs/${queuedInterruptRunId}/interrupt` })).json().status, "cancelled");

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
