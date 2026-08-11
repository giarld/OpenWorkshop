import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import Fastify from "fastify";
import { openWorkshopDatabase } from "./database.ts";
import { coveredTaskIds, createExecutionGrant, parseReviewResult, parseSupervisorDecision, ProjectLockManager, registerSchedulerRoutes, runnableTasks, Scheduler, workspacePlan } from "./scheduler.ts";
import { registerTaskRoutes } from "./tasks.ts";

const runFile = promisify(execFile);

test("task trigger creates the right grant and promotes only its authorized closure", async () => {
  const fixture = await schedulerFixture();
  const server = Fastify();
  try {
    const dependency = fixture.task("dependency", fixture.main, "backlog");
    const target = fixture.task("target", fixture.main, "backlog");
    const sibling = fixture.task("sibling", fixture.main, "backlog");
    fixture.depend(target, dependency);
    fixture.database.prepare("INSERT INTO role_configs (id, project_id, role, prompt, model, reasoning_effort, custom_args_json, updated_at) VALUES (?, NULL, 'developer', '', 'configured-model', 'high', '[\"--enable\",\"example\"]', ?)")
      .run(randomUUID(), new Date().toISOString());
    const started: string[] = [];
    const scheduler = new Scheduler(fixture.database, { start: async (runId) => {
      started.push(runId);
      fixture.database.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
    } }, async () => "dirty");
    registerSchedulerRoutes(server, scheduler);
    registerTaskRoutes(server, fixture.database);
    const response = await server.inject({ method: "POST", url: `/api/tasks/${target}/trigger` });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().grant.scope, "target_closure");
    assert.deepEqual(statuses(fixture.database, [dependency, target, sibling]), ["in_progress", "todo", "backlog"]);
    assert.equal(started.length, 1);
    assert.deepEqual(JSON.parse((fixture.database.prepare("SELECT config_snapshot_json FROM runs WHERE id = ?").get(started[0]!) as { config_snapshot_json: string }).config_snapshot_json), { prompt: "", model: "configured-model", reasoningEffort: "high", customArgs: ["--enable", "example"], sandboxMode: "workspace-write", approvalPolicy: "on-request", networkAccess: true });
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count, 1);
    assert.equal((await server.inject({ method: "GET", url: `/api/tasks/${dependency}` })).json().latestRunStatus, "running");
    assert.equal((await server.inject({ method: "POST", url: `/api/tasks/${target}/trigger` })).statusCode, 409);
  } finally { await server.close(); await fixture.close(); }
});

test("rejects execution grants for archived projects or disabled roots", async () => {
  const fixture = await schedulerFixture();
  try {
    const task = fixture.task("lifecycle-guard", fixture.main, "todo");
    fixture.database.prepare("UPDATE root_paths SET enabled = 0").run();
    assert.throws(() => createExecutionGrant(fixture.database, task), /root is disabled/);
    fixture.database.prepare("UPDATE root_paths SET enabled = 1").run();
    fixture.database.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), fixture.project);
    assert.throws(() => createExecutionGrant(fixture.database, task), /Project is archived/);
  } finally { await fixture.close(); }
});

test("main task trigger schedules runnable children and marks the main task in progress", async () => {
  const fixture = await schedulerFixture();
  try {
    const first = fixture.task("first", fixture.main, "backlog");
    const second = fixture.task("second", fixture.main, "backlog");
    const starts: string[] = [];
    const scheduler = new Scheduler(fixture.database, { start: async (runId) => {
      starts.push(runId);
      fixture.database.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
    } }, async () => "dirty");
    const result = await scheduler.trigger(fixture.main);
    assert.equal(result.runIds.length, 2);
    assert.equal(starts.length, 1);
    assert.equal((fixture.database.prepare("SELECT status FROM tasks WHERE id = ?").get(fixture.main) as { status: string }).status, "in_progress");
    assert.deepEqual(statuses(fixture.database, [first, second]), ["in_progress", "todo"]);
  } finally { await fixture.close(); }
});

test("main task trigger returns to todo when no child can advance past an explicit blocker", async () => {
  const fixture = await schedulerFixture();
  try {
    const blocked = fixture.task("blocked-child", fixture.main, "blocked");
    fixture.database.prepare("UPDATE tasks SET blocked_reason = 'Needs human input' WHERE id = ?").run(blocked);
    const scheduler = new Scheduler(fixture.database, { start: async () => assert.fail("blocked tree must not start a Run") });

    const result = await scheduler.trigger(fixture.main);

    assert.deepEqual(result.runIds, []);
    const main = fixture.database.prepare("SELECT status, blocked_reason FROM tasks WHERE id = ?").get(fixture.main) as { status: string; blocked_reason: string | null };
    assert.equal(main.status, "todo");
    assert.equal(main.blocked_reason, null);
    assert.equal((fixture.database.prepare("SELECT status FROM commissions WHERE main_task_id = ?").get(fixture.main) as { status: string }).status, "blocked");
    assert.equal((fixture.database.prepare("SELECT status FROM execution_grants WHERE id = ?").get(result.grant.id) as { status: string }).status, "exhausted");
    assert.equal((fixture.database.prepare("SELECT blocked_reason FROM tasks WHERE id = ?").get(blocked) as { blocked_reason: string }).blocked_reason, "Needs human input");
  } finally { await fixture.close(); }
});

test("main task returns to todo after its remaining runnable child finishes before a blocker", async () => {
  const fixture = await schedulerFixture();
  try {
    const runnable = fixture.task("runnable-child", fixture.main, "backlog");
    const blocked = fixture.task("blocked-child", fixture.main, "blocked");
    fixture.database.prepare("UPDATE tasks SET blocked_reason = 'Needs human input' WHERE id = ?").run(blocked);
    const scheduler = new Scheduler(fixture.database, { start: async (runId) => {
      fixture.database.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
    } }, async () => "dirty");

    const result = await scheduler.trigger(fixture.main);
    assert.equal(result.runIds.length, 1);
    fixture.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(result.runIds[0]!);
    fixture.database.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(runnable);
    await scheduler.wake(result.grant.id);

    assert.equal((fixture.database.prepare("SELECT status FROM tasks WHERE id = ?").get(fixture.main) as { status: string }).status, "todo");
    assert.equal((fixture.database.prepare("SELECT status FROM commissions WHERE main_task_id = ?").get(fixture.main) as { status: string }).status, "blocked");
    assert.equal((fixture.database.prepare("SELECT status FROM execution_grants WHERE id = ?").get(result.grant.id) as { status: string }).status, "exhausted");
  } finally { await fixture.close(); }
});

test("a rejected trigger does not move an awaiting-acceptance main task back to todo", async () => {
  const fixture = await schedulerFixture();
  try {
    fixture.database.prepare("UPDATE commissions SET status = 'awaiting_acceptance' WHERE main_task_id = ?").run(fixture.main);
    fixture.database.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(fixture.main);
    await assert.rejects(() => new Scheduler(fixture.database, { start: async () => undefined }).trigger(fixture.main), /cannot be executed/);
    assert.equal((fixture.database.prepare("SELECT status FROM tasks WHERE id = ?").get(fixture.main) as { status: string }).status, "in_progress");
    assert.equal((fixture.database.prepare("SELECT status FROM commissions WHERE main_task_id = ?").get(fixture.main) as { status: string }).status, "awaiting_acceptance");
  } finally { await fixture.close(); }
});

test("authorization stays inside its commission and target closure", async () => {
  const fixture = await schedulerFixture();
  try {
    const dependency = fixture.task("dependency", fixture.main, "todo");
    const target = fixture.task("target", fixture.main, "todo");
    const sibling = fixture.task("sibling", fixture.main, "todo");
    fixture.depend(target, dependency);

    const targetGrant = createExecutionGrant(fixture.database, target);
    assert.equal(targetGrant.scope, "target_closure");
    assert.deepEqual(new Set(coveredTaskIds(fixture.database, targetGrant.id)), new Set([target, dependency]));
    assert.deepEqual(runnableTasks(fixture.database, targetGrant.id).map(({ id }) => id), [dependency]);

    fixture.done(dependency);
    assert.deepEqual(runnableTasks(fixture.database, targetGrant.id).map(({ id }) => id), [target]);
    assert.ok(!coveredTaskIds(fixture.database, targetGrant.id).includes(sibling));

    const treeGrant = createExecutionGrant(fixture.database, fixture.main);
    assert.equal(treeGrant.scope, "commission_tree");
    assert.deepEqual(new Set(coveredTaskIds(fixture.database, treeGrant.id)), new Set([fixture.main, dependency, target, sibling]));

    fixture.database.prepare("UPDATE commissions SET status = 'awaiting_acceptance' WHERE id = (SELECT commission_id FROM tasks WHERE id = ?)").run(fixture.main);
    assert.throws(() => createExecutionGrant(fixture.database, fixture.main), /cannot be executed/);
    fixture.database.prepare("UPDATE commissions SET status = 'active' WHERE id = (SELECT commission_id FROM tasks WHERE id = ?)").run(fixture.main);

    const other = fixture.commission("planned");
    const otherMain = fixture.task("other-main", null, "todo", other);
    fixture.database.prepare("UPDATE commissions SET main_task_id = ? WHERE id = ?").run(otherMain, other);
    assert.throws(() => createExecutionGrant(fixture.database, otherMain), /another active commission/);
  } finally { await fixture.close(); }
});

test("startup restores acceptance when every child task is done", async () => {
  const fixture = await schedulerFixture();
  try {
    const child = fixture.task("completed", fixture.main, "done");
    fixture.database.prepare("UPDATE commissions SET status = 'active' WHERE main_task_id = ?").run(fixture.main);
    await new Scheduler(fixture.database, { start: async () => undefined }).recover();
    assert.equal((fixture.database.prepare("SELECT status FROM commissions WHERE main_task_id = ?").get(fixture.main) as { status: string }).status, "awaiting_acceptance");
    assert.equal((fixture.database.prepare("SELECT status FROM tasks WHERE id = ?").get(fixture.main) as { status: string }).status, "in_progress");
    assert.equal((fixture.database.prepare("SELECT status FROM tasks WHERE id = ?").get(child) as { status: string }).status, "done");
  } finally { await fixture.close(); }
});

test("runnable checks dependencies, approvals, and global/project slots", async () => {
  const fixture = await schedulerFixture();
  try {
    const first = fixture.task("first", fixture.main, "todo", undefined, true);
    const second = fixture.task("second", fixture.main, "todo");
    fixture.done(fixture.main);
    const grant = createExecutionGrant(fixture.database, fixture.main);
    assert.deepEqual(runnableTasks(fixture.database, grant.id, 4, 1).map(({ id, readOnly }) => [id, readOnly]), [[first, true]]);

    const run = fixture.run(first, "running");
    assert.deepEqual(runnableTasks(fixture.database, grant.id, 4, 1), []);
    fixture.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(run);
    const approvalRun = fixture.run(first, "waiting_approval");
    fixture.database.prepare("INSERT INTO approvals (id, run_id, codex_request_id, kind, request_json, status, created_at) VALUES (?, ?, 'risk', 'high_risk', '{}', 'pending', ?)")
      .run(randomUUID(), approvalRun, new Date().toISOString());
    assert.deepEqual(runnableTasks(fixture.database, grant.id, 4, 2), []);
    assert.ok(second);
  } finally { await fixture.close(); }
});

test("project locks and VCS workspace plans preserve isolation", () => {
  const locks = new ProjectLockManager();
  const releaseRead = locks.tryAcquire("project", "read");
  const releaseWorktree = locks.tryAcquire("project", "worktree");
  assert.ok(releaseRead && releaseWorktree);
  assert.equal(locks.tryAcquire("project", "exclusive"), undefined);
  releaseRead(); releaseWorktree();
  const releaseWrite = locks.tryAcquire("project", "exclusive");
  assert.ok(releaseWrite);
  assert.equal(locks.tryAcquire("project", "read"), undefined);
  releaseWrite();

  assert.equal(workspacePlan("root", "git", false, true, "run").worktree, true);
  assert.equal(workspacePlan("root", "git", false, false, "run").lock, "exclusive");
  assert.equal(workspacePlan("root", "svn", false, true, "run").lock, "exclusive");
  assert.equal(workspacePlan("root", "none", false, true, "run").lock, "exclusive");
  assert.equal(workspacePlan("root", "none", true, false, "run").lock, "read");

});

test("production Scheduler starts and cleans an isolated Git Worktree", async () => {
  const fixture = await schedulerFixture();
  try {
    fixture.done(fixture.main);
    const task = fixture.task("git-write", fixture.main, "backlog");
    const commands: string[][] = [];
    const starts: Array<{ runId: string; cwd: string }> = [];
    const scheduler = new Scheduler(fixture.database, { start: async (runId, cwd) => {
      starts.push({ runId, cwd });
      fixture.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(runId);
    } }, async (_file, args) => { commands.push(args); return ""; });
    const result = await scheduler.trigger(task);
    assert.equal(starts.length, 1);
    assert.match(starts[0]!.cwd, /\.openworkshop[\\/]worktrees/);
    await scheduler.terminal(result.runIds[0]!);
    assert.deepEqual(commands.map(([command]) => command), ["status", "worktree"]);
    assert.equal((fixture.database.prepare("SELECT role FROM runs ORDER BY rowid DESC LIMIT 1").get() as { role: string }).role, "reviewer");
    assert.match((fixture.database.prepare("SELECT content FROM comments WHERE task_id = ? AND author_type = 'system' ORDER BY rowid DESC LIMIT 1").get(task) as { content: string }).content, /触发独立代码审查/);
  } finally { await fixture.close(); }
});

test("exclusive workspaces serialize queued Runs and expire obsolete approvals", async () => {
  const fixture = await schedulerFixture();
  try {
    fixture.database.prepare("UPDATE projects SET vcs_type = 'none' WHERE id = ?").run(fixture.project);
    fixture.done(fixture.main);
    fixture.task("first-write", fixture.main, "backlog");
    fixture.task("second-write", fixture.main, "backlog");
    const starts: string[] = [];
    const scheduler = new Scheduler(fixture.database, { start: async (runId) => {
      starts.push(runId);
      fixture.database.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
    } });
    const result = await scheduler.trigger(fixture.main);
    assert.equal(starts.length, 1);
    const first = starts[0]!;
    const approval = randomUUID();
    fixture.database.prepare("INSERT INTO approvals (id, run_id, codex_request_id, kind, request_json, status, created_at) VALUES (?, ?, 'risk', 'high_risk', '{}', 'pending', ?)")
      .run(approval, first, new Date().toISOString());
    fixture.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(first);
    await scheduler.terminal(first);
    assert.equal(starts.length, 2);
    assert.equal((fixture.database.prepare("SELECT status FROM approvals WHERE id = ?").get(approval) as { status: string }).status, "expired");
    await scheduler.wake(result.grant.id);
    assert.equal(starts.length, 2);
  } finally { await fixture.close(); }
});

test("concurrent wake drains do not leak the first Run lock", async () => {
  const fixture = await schedulerFixture();
  try {
    fixture.database.prepare("UPDATE projects SET vcs_type = 'none' WHERE id = ?").run(fixture.project);
    fixture.database.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('projectConcurrency', '1', ?)").run(new Date().toISOString());
    fixture.done(fixture.main);
    const first = fixture.task("read-first", fixture.main, "todo", undefined, true);
    const second = fixture.task("write-second", fixture.main, "todo");
    fixture.depend(second, first);
    const starts: string[] = [];
    const scheduler = new Scheduler(fixture.database, { start: async (runId) => {
      starts.push(runId);
      fixture.database.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
    } });
    const grant = createExecutionGrant(fixture.database, fixture.main);
    await Promise.all([scheduler.wake(grant.id), scheduler.wake(grant.id)]);
    assert.equal(starts.length, 1);
    fixture.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(starts[0]!);
    await scheduler.terminal(starts[0]!);
    assert.equal(starts.length, 2);
  } finally { await fixture.close(); }
});

test("restart consumes one persisted automatic retry without extending its lineage", async () => {
  const fixture = await schedulerFixture();
  try {
    const task = fixture.task("restart", fixture.main, "in_progress");
    const grant = createExecutionGrant(fixture.database, task);
    const run = fixture.run(task, "running", grant.id, "reviewer");
    const starter = { start: async (runId: string) => { fixture.database.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId); } };
    const scheduler = new Scheduler(fixture.database, starter, async () => "dirty");
    const [retry] = await scheduler.recover();
    assert.equal((fixture.database.prepare("SELECT status FROM runs WHERE id = ?").get(run) as { status: string }).status, "interrupted");
    assert.equal((fixture.database.prepare("SELECT status FROM runs WHERE id = ?").get(retry) as { status: string }).status, "running");
    assert.equal((fixture.database.prepare("SELECT role FROM runs WHERE id = ?").get(retry) as { role: string }).role, "reviewer");
    assert.deepEqual(await new Scheduler(fixture.database, starter, async () => "dirty").recover(), []);
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM runs WHERE trigger_type = 'auto_retry' AND trigger_ref_id = ?").get(run) as { count: number }).count, 1);
    assert.equal((fixture.database.prepare("SELECT MAX(attempt_no) AS attempt FROM runs WHERE task_id = ?").get(task) as { attempt: number }).attempt, 2);
  } finally { await fixture.close(); }
});

test("manual resume preserves the interrupted Run role", async () => {
  const fixture = await schedulerFixture();
  try {
    const task = fixture.task("resume-review", fixture.main, "in_progress");
    const previous = fixture.run(task, "interrupted", null, "reviewer");
    const scheduler = new Scheduler(fixture.database, { start: async (runId) => { fixture.database.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId); } }, async () => "dirty");
    const resumed = await scheduler.resume(task, previous);
    const run = fixture.database.prepare("SELECT role, trigger_type, trigger_ref_id FROM runs WHERE id = ?").get(resumed) as { role: string; trigger_type: string; trigger_ref_id: string };
    assert.deepEqual([run.role, run.trigger_type, run.trigger_ref_id], ["reviewer", "resume", previous]);
  } finally { await fixture.close(); }
});

test("re-execution reconciles with a read-only supervisor before choosing the next role", async () => {
  const fixture = await schedulerFixture();
  try {
    fixture.done(fixture.main);
    const task = fixture.task("reconcile-review", fixture.main, "blocked");
    const failedReviewer = fixture.run(task, "failed", null, "reviewer");
    fixture.database.prepare("UPDATE tasks SET blocked_reason = 'Run failed' WHERE id = ?").run(task);
    const starts: string[] = [];
    const scheduler = new Scheduler(fixture.database, { start: async (runId) => {
      starts.push(runId);
      fixture.database.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
    } }, async () => "dirty");

    const triggered = await scheduler.trigger(task);
    const supervisor = triggered.runIds[0]!;
    const supervisorRun = fixture.database.prepare("SELECT role, trigger_type, trigger_ref_id, config_snapshot_json FROM runs WHERE id = ?").get(supervisor) as { role: string; trigger_type: string; trigger_ref_id: string; config_snapshot_json: string };
    assert.deepEqual([supervisorRun.role, supervisorRun.trigger_type, supervisorRun.trigger_ref_id], ["supervisor", "reconcile", failedReviewer]);
    assert.deepEqual(JSON.parse(supervisorRun.config_snapshot_json), { prompt: "", customArgs: [], sandboxMode: "read-only", approvalPolicy: "never", networkAccess: false });

    fixture.database.prepare("INSERT INTO run_events (run_id, event_type, summary, payload_json, redacted, created_at) VALUES (?, 'agent.message.delta', 'decision', ?, 0, ?)")
      .run(supervisor, JSON.stringify({ delta: '{"action":"resume_reviewer","summary":"The review process was interrupted by infrastructure shutdown."}' }), new Date().toISOString());
    fixture.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(supervisor);
    await scheduler.terminal(supervisor);

    assert.deepEqual(starts.map((id) => (fixture.database.prepare("SELECT role FROM runs WHERE id = ?").get(id) as { role: string }).role), ["supervisor", "reviewer"]);
    const reviewer = starts[1]!;
    const reviewerRun = fixture.database.prepare("SELECT trigger_type, trigger_ref_id FROM runs WHERE id = ?").get(reviewer) as { trigger_type: string; trigger_ref_id: string };
    assert.deepEqual([reviewerRun.trigger_type, reviewerRun.trigger_ref_id], ["resume", supervisor]);
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM runs WHERE task_id = ? AND role = 'developer'").get(task) as { count: number }).count, 0);
  } finally { await fixture.close(); }
});

test("supervisor can keep an ambiguous re-execution blocked for human action", async () => {
  const fixture = await schedulerFixture();
  try {
    fixture.done(fixture.main);
    const task = fixture.task("reconcile-human", fixture.main, "blocked");
    fixture.run(task, "cancelled", null, "developer");
    fixture.database.prepare("UPDATE tasks SET blocked_reason = 'Cancelled' WHERE id = ?").run(task);
    const starts: string[] = [];
    const scheduler = new Scheduler(fixture.database, { start: async (runId) => {
      starts.push(runId);
      fixture.database.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
    } }, async () => "dirty");
    const supervisor = (await scheduler.trigger(task)).runIds[0]!;
    fixture.database.prepare("INSERT INTO run_events (run_id, event_type, summary, payload_json, redacted, created_at) VALUES (?, 'agent.message.delta', 'decision', ?, 0, ?)")
      .run(supervisor, JSON.stringify({ delta: '{"action":"wait_human","summary":"Confirm whether the external operation completed."}' }), new Date().toISOString());
    fixture.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(supervisor);
    await scheduler.terminal(supervisor);
    const state = fixture.database.prepare("SELECT status, blocked_reason FROM tasks WHERE id = ?").get(task) as { status: string; blocked_reason: string };
    assert.equal(state.status, "blocked");
    assert.match(state.blocked_reason, /等待人工处理/);
    assert.equal(starts.length, 1);
  } finally { await fixture.close(); }
});

test("parses the supervisor reconciliation contract", () => {
  assert.deepEqual(parseSupervisorDecision('{"action":"rework_developer","summary":"Apply the blocking review findings."}'), { action: "rework_developer", summary: "Apply the blocking review findings." });
  assert.throws(() => parseSupervisorDecision('{"action":"developer","summary":"wrong"}'), /invalid decision/);
});

test("failed reviews trigger rework without consuming required successful rounds", async () => {
  const fixture = await schedulerFixture();
  try {
    fixture.done(fixture.main);
    const task = fixture.task("reviewed", fixture.main, "backlog");
    const starts: string[] = [];
    const scheduler = new Scheduler(fixture.database, { start: async (runId) => {
      starts.push(runId);
      fixture.database.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
    } }, async () => "dirty");
    await scheduler.trigger(task);
    for (let round = 0; round < 2; round += 1) {
      const developer = starts.at(-1)!;
      fixture.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(developer);
      await scheduler.terminal(developer);
      const reviewer = starts.at(-1)!;
      assert.equal((fixture.database.prepare("SELECT role FROM runs WHERE id = ?").get(reviewer) as { role: string }).role, "reviewer");
      const review = JSON.stringify({ passed: false, summary: `round ${round + 1} failed`, checks: [], findings: [{ severity: "blocking", file: "src.ts", line: null, message: "fix" }] });
      fixture.database.prepare("INSERT INTO run_events (run_id, event_type, summary, payload_json, redacted, created_at) VALUES (?, 'agent.message.delta', 'review', ?, 0, ?)").run(reviewer, JSON.stringify({ delta: review }), new Date().toISOString());
      fixture.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(reviewer);
      await scheduler.terminal(reviewer);
    }
    assert.deepEqual(starts.map((id) => (fixture.database.prepare("SELECT role FROM runs WHERE id = ?").get(id) as { role: string }).role), ["developer", "reviewer", "developer", "reviewer", "developer"]);
    const blocked = fixture.database.prepare("SELECT status, review_round_used, blocked_reason FROM tasks WHERE id = ?").get(task) as { status: string; review_round_used: number; blocked_reason: string };
    assert.deepEqual([blocked.status, blocked.review_round_used, blocked.blocked_reason], ["in_progress", 0, null]);
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM evidence WHERE task_id = ? AND type = 'review'").get(task) as { count: number }).count, 2);
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM comments WHERE task_id = ? AND agent_role = 'reviewer'").get(task) as { count: number }).count, 2);
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM notifications WHERE entity_type = 'task' AND entity_id = ? AND kind = 'mention'").get(task) as { count: number }).count, 2);
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM runs WHERE task_id = ? AND trigger_type = 'rework'").get(task) as { count: number }).count, 2);
    assert.equal(parseReviewResult('{"passed":true,"summary":"ok","checks":[],"findings":[]}').passed, true);
    assert.equal(parseReviewResult('{"passed":false,"summary":"warning","checks":[],"findings":[{"severity":"warning"}]}').passed, true);
  } finally { await fixture.close(); }
});

test("three consecutive failed reviews block the task instead of scheduling endless rework", async () => {
  const fixture = await schedulerFixture();
  try {
    fixture.done(fixture.main);
    const task = fixture.task("review-loop", fixture.main, "backlog");
    const starts: string[] = [];
    const scheduler = new Scheduler(fixture.database, { start: async (runId) => {
      starts.push(runId);
      fixture.database.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
    } }, async () => "dirty");
    await scheduler.trigger(task);

    for (let round = 1; round <= 3; round += 1) {
      const developer = starts.at(-1)!;
      fixture.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(developer);
      await scheduler.terminal(developer);
      const reviewer = starts.at(-1)!;
      const review = JSON.stringify({ passed: false, summary: `same blocker round ${round}`, checks: [], findings: [{ severity: "blocking", file: "SceneBox.exe", line: null, message: "Needs human build approval" }] });
      fixture.database.prepare("INSERT INTO run_events (run_id, event_type, summary, payload_json, redacted, created_at) VALUES (?, 'agent.message.delta', 'review', ?, 0, ?)").run(reviewer, JSON.stringify({ delta: review }), new Date().toISOString());
      fixture.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(reviewer);
      await scheduler.terminal(reviewer);
    }

    assert.deepEqual(starts.map((id) => (fixture.database.prepare("SELECT role FROM runs WHERE id = ?").get(id) as { role: string }).role), ["developer", "reviewer", "developer", "reviewer", "developer", "reviewer"]);
    const state = fixture.database.prepare("SELECT status, review_round_used, blocked_reason FROM tasks WHERE id = ?").get(task) as { status: string; review_round_used: number; blocked_reason: string };
    assert.equal(state.status, "blocked");
    assert.equal(state.review_round_used, 0);
    assert.match(state.blocked_reason, /连续 3 轮代码审查未通过/);
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM runs WHERE task_id = ? AND trigger_type = 'rework'").get(task) as { count: number }).count, 2);
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM evidence WHERE task_id = ? AND type = 'review' AND status = 'failed'").get(task) as { count: number }).count, 3);
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM notifications WHERE entity_type = 'task' AND entity_id = ? AND kind = 'blocked'").get(task) as { count: number }).count, 1);
    assert.match((fixture.database.prepare("SELECT content FROM comments WHERE task_id = ? AND kind = 'blocker' ORDER BY rowid DESC LIMIT 1").get(task) as { content: string }).content, /已停止自动返工/);
  } finally { await fixture.close(); }
});

test("Git development changes reach reviewer and project root before worktree cleanup", async () => {
  const fixture = await schedulerFixture();
  try {
    await writeFile(join(fixture.projectPath, "base.txt"), "base\n");
    await git(fixture.projectPath, "init");
    await git(fixture.projectPath, "config", "user.email", "test@example.com");
    await git(fixture.projectPath, "config", "user.name", "Test");
    await git(fixture.projectPath, "add", ".");
    await git(fixture.projectPath, "commit", "-m", "base");
    fixture.done(fixture.main);
    const task = fixture.task("git-chain", fixture.main, "backlog");
    const starts: Array<{ id: string; role: string; cwd: string }> = [];
    let reviewerSawChange = false;
    const scheduler = new Scheduler(fixture.database, { start: async (runId, cwd) => {
      const role = (fixture.database.prepare("SELECT role FROM runs WHERE id = ?").get(runId) as { role: string }).role;
      starts.push({ id: runId, role, cwd });
      if (role === "developer") await writeFile(join(cwd, "feature.txt"), "reviewed change\n");
      else {
        reviewerSawChange = await readFile(join(cwd, "feature.txt"), "utf8").then((text) => text === "reviewed change\n", () => false);
        fixture.database.prepare("INSERT INTO run_events (run_id, event_type, summary, payload_json, redacted, created_at) VALUES (?, 'agent.message.delta', 'review', ?, 0, ?)")
          .run(runId, JSON.stringify({ delta: '{"passed":true,"summary":"ok","checks":[],"findings":[]}' }), new Date().toISOString());
      }
      fixture.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(runId);
    } });
    const triggered = await scheduler.trigger(task);
    await scheduler.terminal(triggered.runIds[0]!);
    assert.equal(reviewerSawChange, true);
    assert.equal(starts[0]!.cwd, starts[1]!.cwd);
    await scheduler.terminal(starts[1]!.id);
    assert.equal(await access(starts[0]!.cwd).then(() => true, () => false), true);
    assert.equal(starts[2]!.role, "reviewer");
    await scheduler.terminal(starts[2]!.id);
    assert.equal((await readFile(join(fixture.projectPath, "feature.txt"), "utf8")).trim(), "reviewed change");
    assert.equal(await access(starts[0]!.cwd).then(() => true, () => false), false);
    assert.match((fixture.database.prepare("SELECT content FROM comments WHERE task_id = ? ORDER BY rowid DESC LIMIT 1").get(fixture.main) as { content: string }).content, /@任务1[\s\S]*已完成/);
  } finally { await fixture.close(); }
});

test("review evidence and round roll back when rework reservation fails", async () => {
  const fixture = await schedulerFixture();
  try {
    fixture.done(fixture.main);
    const task = fixture.task("atomic-review", fixture.main, "backlog");
    const starts: string[] = [];
    const scheduler = new Scheduler(fixture.database, { start: async (runId) => {
      starts.push(runId);
      fixture.database.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
    } }, async () => "dirty");
    await scheduler.trigger(task);
    fixture.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(starts[0]!);
    await scheduler.terminal(starts[0]!);
    const reviewer = starts[1]!;
    const review = '{"passed":false,"summary":"fix","checks":[],"findings":[{"severity":"blocking"}]}';
    fixture.database.prepare("INSERT INTO run_events (run_id, event_type, summary, payload_json, redacted, created_at) VALUES (?, 'agent.message.delta', 'review', ?, 0, ?)").run(reviewer, JSON.stringify({ delta: review }), new Date().toISOString());
    fixture.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(reviewer);
    fixture.database.exec("CREATE TRIGGER fail_rework BEFORE INSERT ON runs WHEN NEW.trigger_type = 'rework' BEGIN SELECT RAISE(ABORT, 'forced rework failure'); END;");
    await assert.rejects(() => scheduler.terminal(reviewer), /forced rework failure/);
    assert.deepEqual(reviewState(fixture.database, task), [0, 0, 0]);
    fixture.database.exec("DROP TRIGGER fail_rework");
    await scheduler.terminal(reviewer);
    assert.deepEqual(reviewState(fixture.database, task), [1, 0, 1]);
  } finally { await fixture.close(); }
});

test("blocked task can resume after review exhaustion and reuse its preserved Git worktree", async () => {
  const fixture = await schedulerFixture();
  try {
    await writeFile(join(fixture.projectPath, "base.txt"), "base\n");
    await git(fixture.projectPath, "init");
    await git(fixture.projectPath, "config", "user.email", "test@example.com");
    await git(fixture.projectPath, "config", "user.name", "Test");
    await git(fixture.projectPath, "add", ".");
    await git(fixture.projectPath, "commit", "-m", "base");
    fixture.done(fixture.main);
    const task = fixture.task("blocked-resume", fixture.main, "backlog");
    fixture.database.prepare("UPDATE tasks SET review_round_limit = 1 WHERE id = ?").run(task);
    const starts: Array<{ role: string; cwd: string }> = [];
    let resumedSawChange = false;
    const scheduler = new Scheduler(fixture.database, { start: async (runId, cwd) => {
      const role = (fixture.database.prepare("SELECT role FROM runs WHERE id = ?").get(runId) as { role: string }).role;
      starts.push({ role, cwd });
      if (role === "developer" && starts.length === 1) await writeFile(join(cwd, "pending.txt"), "preserved\n");
      else if (role === "developer") resumedSawChange = await readFile(join(cwd, "pending.txt"), "utf8").then((text) => text.trim() === "preserved", () => false);
      else fixture.database.prepare("INSERT INTO run_events (run_id, event_type, summary, payload_json, redacted, created_at) VALUES (?, 'agent.message.delta', 'review', ?, 0, ?)")
        .run(runId, JSON.stringify({ delta: '{"passed":false,"summary":"blocked","checks":[],"findings":[{"severity":"blocking"}]}' }), new Date().toISOString());
      fixture.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(runId);
    } });
    const first = await scheduler.trigger(task);
    await scheduler.terminal(first.runIds[0]!);
    const reviewer = (fixture.database.prepare("SELECT id FROM runs WHERE task_id = ? AND role = 'reviewer'").get(task) as { id: string }).id;
    fixture.database.prepare("INSERT INTO evidence (id, task_id, run_id, criterion_key, type, status, summary, payload_json, created_at) VALUES (?, ?, ?, '*', 'review', 'failed', 'legacy block', '{}', ?)")
      .run(randomUUID(), task, reviewer, new Date().toISOString());
    fixture.database.prepare("UPDATE tasks SET status = 'blocked', blocked_reason = 'legacy block' WHERE id = ?").run(task);
    assert.equal((fixture.database.prepare("SELECT status FROM tasks WHERE id = ?").get(task) as { status: string }).status, "blocked");
    assert.equal(await access(starts[0]!.cwd).then(() => true, () => false), true);

    const resumed = await scheduler.resume(task, reviewer);
    assert.equal(resumedSawChange, true);
    assert.equal((fixture.database.prepare("SELECT role FROM runs WHERE id = ?").get(resumed) as { role: string }).role, "developer");
    assert.equal(starts.at(-1)!.cwd, starts[0]!.cwd);
  } finally { await fixture.close(); }
});

test("restart_developer removes the previous Worktree and starts from a clean checkout", async () => {
  const fixture = await schedulerFixture();
  try {
    await writeFile(join(fixture.projectPath, "base.txt"), "base\n");
    await git(fixture.projectPath, "init");
    await git(fixture.projectPath, "config", "user.email", "test@example.com");
    await git(fixture.projectPath, "config", "user.name", "Test");
    await git(fixture.projectPath, "add", ".");
    await git(fixture.projectPath, "commit", "-m", "base");
    fixture.done(fixture.main);
    const task = fixture.task("restart-clean", fixture.main, "blocked");
    fixture.database.prepare("UPDATE tasks SET blocked_reason = 'Needs a clean restart' WHERE id = ?").run(task);
    const previous = fixture.run(task, "failed");
    const previousWorktree = join(fixture.projectPath, ".openworkshop", "worktrees", previous);
    await mkdir(join(fixture.projectPath, ".openworkshop", "worktrees"), { recursive: true });
    await git(fixture.projectPath, "worktree", "add", "--detach", previousWorktree, "HEAD");
    await writeFile(join(previousWorktree, "pending.txt"), "must not continue\n");
    fixture.database.prepare("UPDATE runs SET workspace_path = ?, workspace_mode = 'worktree' WHERE id = ?").run(previousWorktree, previous);

    const starts: Array<{ id: string; role: string; trigger: string; cwd: string; sawPending: boolean }> = [];
    const scheduler = new Scheduler(fixture.database, { start: async (runId, cwd) => {
      const run = fixture.database.prepare("SELECT role, trigger_type FROM runs WHERE id = ?").get(runId) as { role: string; trigger_type: string };
      starts.push({ id: runId, role: run.role, trigger: run.trigger_type, cwd, sawPending: await access(join(cwd, "pending.txt")).then(() => true, () => false) });
      fixture.database.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
    } });
    const supervisor = (await scheduler.trigger(task)).runIds[0]!;
    assert.equal(starts[0]?.cwd, previousWorktree);
    fixture.database.prepare("INSERT INTO run_events (run_id, event_type, summary, payload_json, redacted, created_at) VALUES (?, 'agent.message.delta', 'decision', ?, 0, ?)")
      .run(supervisor, JSON.stringify({ delta: '{"action":"restart_developer","summary":"Discard the previous workspace and restart from HEAD."}' }), new Date().toISOString());
    fixture.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(supervisor);
    await scheduler.terminal(supervisor);

    assert.deepEqual(starts.map(({ role, trigger, sawPending }) => [role, trigger, sawPending]), [
      ["supervisor", "reconcile", true],
      ["developer", "restart", false]
    ]);
    assert.notEqual(starts[1]?.cwd, previousWorktree);
    assert.equal(await access(previousWorktree).then(() => true, () => false), false);
  } finally { await fixture.close(); }
});

async function schedulerFixture() {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-scheduler-"));
  const database = await openWorkshopDatabase(home);
  const now = new Date().toISOString();
  const root = randomUUID();
  const project = randomUUID();
  const projectPath = join(home, "project");
  await mkdir(projectPath);
  database.prepare("INSERT INTO root_paths (id, path, real_path, enabled, created_at, updated_at) VALUES (?, 'root', ?, 1, ?, ?)").run(root, `root-${root}`, now, now);
  database.prepare("INSERT INTO projects (id, name, path, real_path, root_path_id, vcs_type, created_at, updated_at) VALUES (?, 'Project', ?, ?, ?, 'git', ?, ?)").run(project, projectPath, projectPath, root, now, now);

  const commission = (status = "planned") => {
    const id = randomUUID();
    const requirement = randomUUID();
    database.prepare("INSERT INTO commissions (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, 'Commission', ?, ?, ?)").run(id, project, status, now, now);
    database.prepare("INSERT INTO requirement_versions (id, commission_id, version_no, content_markdown, acceptance_json, status, created_by, created_at, approved_at) VALUES (?, ?, 1, 'Requirement', '[]', 'approved', 'human', ?, ?)").run(requirement, id, now, now);
    database.prepare("UPDATE commissions SET active_requirement_version_id = ? WHERE id = ?").run(requirement, id);
    return id;
  };
  const primary = commission();
  const task = (title: string, parent: string | null, status: string, commissionId = primary, readOnly = false) => {
    const id = randomUUID();
    database.prepare(`
      INSERT INTO tasks (id, commission_id, parent_id, number_path, position, title, description, status, priority, owner_type, acceptance_json, review_round_limit, review_round_used, created_at, updated_at, read_only)
      VALUES (?, ?, ?, '1', ?, ?, '', ?, 'medium', 'ai', '[]', 2, 0, ?, ?, ?)
    `).run(id, commissionId, parent, countTasks(database, commissionId), title, status, now, now, readOnly ? 1 : 0);
    return id;
  };
  const main = task("main", null, "todo");
  database.prepare("UPDATE commissions SET main_task_id = ? WHERE id = ?").run(main, primary);
  return {
    home, database, project, projectPath, commission: (status?: string) => commission(status), task, main,
    depend: (taskId: string, dependencyId: string) => database.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id, created_by, created_at) VALUES (?, ?, 'human', ?)").run(taskId, dependencyId, now),
    done: (taskId: string) => database.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId),
    run: (taskId: string, status: string, grantId: string | null = null, role = "developer") => {
      const id = randomUUID();
      database.prepare("INSERT INTO runs (id, project_id, commission_id, task_id, role, trigger_type, execution_grant_id, status, attempt_no, config_snapshot_json, context_snapshot_json) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, 1, '{}', '{}')")
        .run(id, project, (database.prepare("SELECT commission_id FROM tasks WHERE id = ?").get(taskId) as { commission_id: string }).commission_id, taskId, role, grantId, status);
      return id;
    },
    close: async () => { database.close(); await rm(home, { recursive: true, force: true }); }
  };
}

async function git(cwd: string, ...args: string[]): Promise<void> { await runFile("git", args, { cwd, windowsHide: true }); }

function reviewState(database: Awaited<ReturnType<typeof openWorkshopDatabase>>, taskId: string): number[] {
  return [
    Number((database.prepare("SELECT COUNT(*) AS count FROM evidence WHERE task_id = ? AND type = 'review'").get(taskId) as { count: number }).count),
    Number((database.prepare("SELECT review_round_used FROM tasks WHERE id = ?").get(taskId) as { review_round_used: number }).review_round_used),
    Number((database.prepare("SELECT COUNT(*) AS count FROM runs WHERE task_id = ? AND trigger_type = 'rework'").get(taskId) as { count: number }).count)
  ];
}

function countTasks(database: Awaited<ReturnType<typeof openWorkshopDatabase>>, commissionId: string): number {
  return Number((database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE commission_id = ?").get(commissionId) as { count: number }).count);
}

function statuses(database: Awaited<ReturnType<typeof openWorkshopDatabase>>, ids: string[]): string[] {
  return ids.map((id) => (database.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string }).status);
}
