import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import Fastify from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { openWorkshopDatabase } from "./database.ts";
import { registerDeliveryRoutes } from "./deliveries.ts";
import { generateAcceptanceDocuments } from "./documents.ts";

const runFile = promisify(execFile);

test("document delivery completes atomically without repository commands", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-delivery-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  const calls: string[] = [];
  const runner = async (file: string): Promise<string> => { calls.push(file); throw new Error(`unexpected ${file}`); };
  const fixture = seed(database, home, "none");
  generateAcceptanceDocuments(database, fixture.commissionId);
  const worker = registerDeliveryRoutes(server, database, undefined, runner);
  database.prepare("UPDATE commissions SET status = 'awaiting_acceptance' WHERE id = ?").run(fixture.commissionId);
  database.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(fixture.taskId);
  try {
    const preview = await server.inject({ method: "POST", url: `/api/tasks/${fixture.taskId}/delivery-preview`, payload: { method: "document" } });
    assert.equal(preview.statusCode, 200);
    const previewBody = preview.json() as { fingerprint: string };
    const queued = await server.inject({ method: "POST", url: `/api/tasks/${fixture.taskId}/deliver`, payload: { method: "document", previewFingerprint: previewBody.fingerprint } });
    assert.equal(queued.statusCode, 202);
    await worker.wake();
    const deliveryId = queued.json().id as string;
    const delivery = (await server.inject({ method: "GET", url: `/api/deliveries/${deliveryId}` })).json() as { status: string; result: { method: string } };
    assert.equal(delivery.status, "succeeded");
    assert.equal(delivery.result.method, "document");
    assert.deepEqual(calls, []);
    assert.equal((database.prepare("SELECT status FROM commissions WHERE id = ?").get(fixture.commissionId) as { status: string }).status, "done");
    assert.equal((database.prepare("SELECT status FROM tasks WHERE id = ?").get(fixture.taskId) as { status: string }).status, "done");
    const notification = database.prepare("SELECT entity_type, entity_id, body FROM notifications ORDER BY created_at DESC LIMIT 1").get() as { entity_type: string; entity_id: string; body: string };
    assert.deepEqual({ entity_type: notification.entity_type, entity_id: notification.entity_id }, { entity_type: "delivery", entity_id: deliveryId });
    assert.match(notification.body, /纯文档交付已完成/);
  } finally { await server.close(); database.close(); await rm(home, { recursive: true, force: true }); }
});

test("Git commit delivery uses only attributed paths and creates no push command", async () => {
  const project = await mkdtemp(join(tmpdir(), "project-workshop-git-delivery-"));
  const databaseHome = await mkdtemp(join(tmpdir(), "project-workshop-git-db-"));
  const database = await openWorkshopDatabase(databaseHome);
  const server = Fastify();
  const fixture = seed(database, project, "git");
  const filePath = join(project, "change.txt");
  await writeFile(filePath, "before\n", "utf8");
  await runFile("git", ["init"], { cwd: project });
  await runFile("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
  await runFile("git", ["config", "user.name", "Test"], { cwd: project });
  await runFile("git", ["add", "change.txt"], { cwd: project });
  await runFile("git", ["commit", "-m", "base"], { cwd: project });
  await writeFile(filePath, "after\n", "utf8");
  const hash = createHash("sha256").update(await readFile(filePath)).digest("hex");
  database.prepare("INSERT INTO evidence (id, task_id, criterion_key, type, status, summary, payload_json, created_at) VALUES (?, ?, '*', 'diff', 'passed', 'attributed', ?, ?)")
    .run(randomUUID(), fixture.taskId, JSON.stringify({ changes: [{ path: "change.txt", changeType: "modified", hash, baselineHash: null, safe: true }] }), new Date().toISOString());
  generateAcceptanceDocuments(database, fixture.commissionId);
  const worker = registerDeliveryRoutes(server, database);
  database.prepare("UPDATE commissions SET status = 'awaiting_acceptance' WHERE id = ?").run(fixture.commissionId);
  database.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(fixture.taskId);
  try {
    const preview = await server.inject({ method: "POST", url: `/api/tasks/${fixture.taskId}/delivery-preview`, payload: { method: "vcs_commit", commitMessage: "deliver change" } });
    assert.equal(preview.statusCode, 200);
    const previewBody = preview.json() as { fingerprint: string; files: Array<{ path: string }> };
    assert.deepEqual(previewBody.files.map(({ path }) => path), ["change.txt"]);
    const queued = await server.inject({ method: "POST", url: `/api/tasks/${fixture.taskId}/deliver`, payload: { method: "vcs_commit", commitMessage: "deliver change", previewFingerprint: previewBody.fingerprint } });
    assert.equal(queued.statusCode, 202);
    await worker.wake();
    const delivery = (await server.inject({ method: "GET", url: `/api/deliveries/${queued.json().id as string}` })).json() as { status: string; result: { commitHash: string } };
    assert.equal(delivery.status, "succeeded");
    assert.match(delivery.result.commitHash, /^[0-9a-f]{40}$/);
    assert.equal((await runFile("git", ["log", "-1", "--pretty=%s"], { cwd: project })).stdout.trim(), "deliver change");
  } finally { await server.close(); database.close(); await rm(project, { recursive: true, force: true }); await rm(databaseHome, { recursive: true, force: true }); }
});

test("Git recovery accepts a Commit that was created before the command reported failure", async () => {
  const project = await mkdtemp(join(tmpdir(), "project-workshop-git-recovery-success-"));
  const databaseHome = await mkdtemp(join(tmpdir(), "project-workshop-recovery-success-db-"));
  const database = await openWorkshopDatabase(databaseHome);
  const server = Fastify();
  const fixture = seed(database, project, "git");
  const filePath = join(project, "change.txt");
  await writeFile(filePath, "before\n", "utf8");
  await runFile("git", ["init"], { cwd: project });
  await runFile("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
  await runFile("git", ["config", "user.name", "Test"], { cwd: project });
  await runFile("git", ["add", "change.txt"], { cwd: project });
  await runFile("git", ["commit", "-m", "base"], { cwd: project });
  await writeFile(filePath, "after\n", "utf8");
  const hash = createHash("sha256").update(await readFile(filePath)).digest("hex");
  database.prepare("INSERT INTO evidence (id, task_id, criterion_key, type, status, summary, payload_json, created_at) VALUES (?, ?, '*', 'diff', 'passed', 'attributed', ?, ?)")
    .run(randomUUID(), fixture.taskId, JSON.stringify({ changes: [{ path: "change.txt", changeType: "modified", hash, baselineHash: null, safe: true }] }), new Date().toISOString());
  database.prepare("UPDATE commissions SET status = 'awaiting_acceptance' WHERE id = ?").run(fixture.commissionId);
  let reportedFailure = false;
  const runner = async (file: string, args: string[], cwd: string): Promise<string> => {
    const output = (await runFile(file, args, { cwd })).stdout;
    if (file === "git" && args[0] === "commit" && !reportedFailure) { reportedFailure = true; throw new Error("reported after commit"); }
    return output;
  };
  const worker = registerDeliveryRoutes(server, database, undefined, runner);
  try {
    const preview = await server.inject({ method: "POST", url: "/api/tasks/" + fixture.taskId + "/delivery-preview", payload: { method: "vcs_commit", commitMessage: "deliver change" } });
    const queued = await server.inject({ method: "POST", url: "/api/tasks/" + fixture.taskId + "/deliver", payload: { method: "vcs_commit", commitMessage: "deliver change", previewFingerprint: preview.json().fingerprint } });
    await worker.wake();
    const delivery = await server.inject({ method: "GET", url: "/api/deliveries/" + (queued.json().id as string) });
    assert.equal(delivery.json().status, "succeeded");
  } finally { await server.close(); database.close(); await rm(project, { recursive: true, force: true }); await rm(databaseHome, { recursive: true, force: true }); }
});

test("delivery capabilities fail closed and reject a stale Git preview", async () => {
  const project = await mkdtemp(join(tmpdir(), "project-workshop-git-preview-"));
  const databaseHome = await mkdtemp(join(tmpdir(), "project-workshop-preview-db-"));
  const database = await openWorkshopDatabase(databaseHome);
  const server = Fastify();
  const fixture = seed(database, project, "git");
  const filePath = join(project, "change.txt");
  await writeFile(filePath, "before\n", "utf8");
  await runFile("git", ["init"], { cwd: project });
  await runFile("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
  await runFile("git", ["config", "user.name", "Test"], { cwd: project });
  await runFile("git", ["add", "change.txt"], { cwd: project });
  await runFile("git", ["commit", "-m", "base"], { cwd: project });
  const worker = registerDeliveryRoutes(server, database);
  database.prepare("UPDATE commissions SET status = 'awaiting_acceptance' WHERE id = ?").run(fixture.commissionId);
  try {
    const unavailable = await worker.acceptanceDetails(fixture.taskId) as { deliveryCapabilities: { vcs_commit: { available: boolean; reason: string } } };
    assert.equal(unavailable.deliveryCapabilities.vcs_commit.available, false);
    assert.match(unavailable.deliveryCapabilities.vcs_commit.reason, /没有可归属/);
    await writeFile(filePath, "after\n", "utf8");
    const hash = createHash("sha256").update(await readFile(filePath)).digest("hex");
    database.prepare("INSERT INTO evidence (id, task_id, criterion_key, type, status, summary, payload_json, created_at) VALUES (?, ?, '*', 'diff', 'passed', 'attributed', ?, ?)")
      .run(randomUUID(), fixture.taskId, JSON.stringify({ changes: [{ path: "change.txt", changeType: "modified", hash, baselineHash: null, safe: true }] }), new Date().toISOString());
    const preview = await server.inject({ method: "POST", url: `/api/tasks/${fixture.taskId}/delivery-preview`, payload: { method: "vcs_commit", commitMessage: "deliver change" } });
    assert.equal(preview.statusCode, 200);
    await writeFile(filePath, "changed after preview\n", "utf8");
    const delivered = await server.inject({ method: "POST", url: `/api/tasks/${fixture.taskId}/deliver`, payload: { method: "vcs_commit", commitMessage: "deliver change", previewFingerprint: preview.json().fingerprint } });
    assert.equal(delivered.statusCode, 409);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM deliveries").get() as { count: number }).count, 0);
  } finally { await server.close(); database.close(); await rm(project, { recursive: true, force: true }); await rm(databaseHome, { recursive: true, force: true }); }
});

test("delivery cancellation and retry enforce persisted status boundaries", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-delivery-status-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  registerDeliveryRoutes(server, database);
  const now = new Date().toISOString();
  const queued = seed(database, join(home, "queued"), "none");
  const running = seed(database, join(home, "running"), "none");
  const failed = seed(database, join(home, "failed"), "none");
  const waiting = seed(database, join(home, "waiting"), "none");
  const insert = (fixture: { commissionId: string; taskId: string }, status: "queued" | "running" | "failed" | "waiting_human", externalEffectStarted: number, method: "document" | "vcs_commit" | "github_pr" = "document", result: Record<string, unknown> = {}) => {
    const id = randomUUID();
    const stepNames = method === "github_pr" ? ["branch", "commit", "push", "pr"] : method === "vcs_commit" ? ["commit"] : ["complete"];
    const progress = JSON.stringify({ currentStep: stepNames[stepNames.length - 1] ?? null, reconcileRequired: true, steps: Object.fromEntries(stepNames.map((step) => [step, { status: "unknown", updatedAt: now, detail: "需要处理" }])) });
    const request = JSON.stringify({ method, commitMessage: method === "document" ? null : "deliver", remote: method === "github_pr" ? "origin" : null, sourceBranch: method === "github_pr" ? "openworkshop/test" : null, targetBranch: method === "github_pr" ? "main" : null, draft: false, prTitle: method === "github_pr" ? "PR" : null, prBody: method === "github_pr" ? "Body" : null });
    database.prepare("INSERT INTO deliveries (id, commission_id, main_task_id, method, status, request_json, preview_json, progress_json, result_json, external_effect_started, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)")
      .run(id, fixture.commissionId, fixture.taskId, method, status, request, progress, JSON.stringify(result), externalEffectStarted, now, now);
    database.prepare("INSERT INTO delivery_attempts (id, delivery_id, attempt_no, status, request_json, preview_json, progress_json, result_json, created_at) VALUES (?, ?, 1, ?, ?, '{}', ?, ?, ?)").run(randomUUID(), id, status, request, progress, JSON.stringify(result), now);
    return id;
  };
  try {
    const queuedId = insert(queued, "queued", 0);
    assert.equal((await server.inject({ method: "POST", url: `/api/deliveries/${queuedId}/cancel` })).statusCode, 200);
    assert.equal((database.prepare("SELECT status FROM deliveries WHERE id = ?").get(queuedId) as { status: string }).status, "cancelled");
    const runningId = insert(running, "running", 1);
    assert.equal((await server.inject({ method: "POST", url: `/api/deliveries/${runningId}/cancel` })).statusCode, 409);
    const failedId = insert(failed, "failed", 0);
    const retried = await server.inject({ method: "POST", url: `/api/deliveries/${failedId}/retry` });
    assert.equal(retried.statusCode, 202);
    assert.equal(retried.json().attempts.length, 2);
    const waitingId = insert(waiting, "waiting_human", 1);
    assert.equal((await server.inject({ method: "POST", url: `/api/deliveries/${waitingId}/retry` })).statusCode, 409);
    const reconciled = await server.inject({ method: "POST", url: `/api/deliveries/${waitingId}/reconcile`, payload: { decision: "retry", confirmedNoExternalEffect: true } });
    assert.equal(reconciled.statusCode, 202);
    assert.equal(reconciled.json().status, "queued");
    assert.equal(reconciled.json().externalEffectStarted, false);
    assert.equal(reconciled.json().attempts.length, 2);

    const svn = seed(database, join(home, "svn"), "svn");
    const pr = seed(database, join(home, "pr"), "git");
    database.prepare("UPDATE commissions SET status = 'awaiting_acceptance' WHERE id IN (?, ?)").run(svn.commissionId, pr.commissionId);
    generateAcceptanceDocuments(database, svn.commissionId);
    generateAcceptanceDocuments(database, pr.commissionId);
    const svnId = insert(svn, "waiting_human", 1, "vcs_commit");
    const svnCompleted = await server.inject({ method: "POST", url: "/api/deliveries/" + svnId + "/reconcile", payload: { decision: "complete", result: { svnRevision: 17 } } });
    assert.equal(svnCompleted.statusCode, 200);
    const svnBody = svnCompleted.json() as { status: string; result: Record<string, unknown> };
    assert.equal(svnBody.status, "succeeded");
    assert.equal(svnBody.result.method, "vcs_commit");
    assert.equal(svnBody.result.svnRevision, 17);

    const existingPrResult = { commitHash: "a".repeat(40), remote: "origin", sourceBranch: "openworkshop/test", targetBranch: "main" };
    const prId = insert(pr, "waiting_human", 1, "github_pr", existingPrResult);
    const prCompleted = await server.inject({ method: "POST", url: "/api/deliveries/" + prId + "/reconcile", payload: { decision: "complete", result: { prUrl: "https://github.com/example/project/pull/7" } } });
    assert.equal(prCompleted.statusCode, 200);
    const prBody = prCompleted.json() as { status: string; result: Record<string, unknown>; attempts: Array<{ result: Record<string, unknown> }> };
    assert.equal(prBody.status, "succeeded");
    assert.equal(prBody.result.prUrl, "https://github.com/example/project/pull/7");
    assert.equal(prBody.result.commitHash, existingPrResult.commitHash);
    assert.equal(prBody.result.remote, existingPrResult.remote);
    assert.equal(prBody.result.sourceBranch, existingPrResult.sourceBranch);
    assert.equal(prBody.result.targetBranch, existingPrResult.targetBranch);
    assert.deepEqual(prBody.attempts[0]!.result, prBody.result);
  } finally { await server.close(); database.close(); await rm(home, { recursive: true, force: true }); }
});

test("delivery failures stay awaiting acceptance and do not persist command secrets", async () => {
  const project = await mkdtemp(join(tmpdir(), "project-workshop-git-failure-"));
  const databaseHome = await mkdtemp(join(tmpdir(), "project-workshop-failure-db-"));
  const database = await openWorkshopDatabase(databaseHome);
  const server = Fastify();
  const fixture = seed(database, project, "git");
  const filePath = join(project, "change.txt");
  await writeFile(filePath, "before\n", "utf8");
  await runFile("git", ["init"], { cwd: project });
  await runFile("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
  await runFile("git", ["config", "user.name", "Test"], { cwd: project });
  await runFile("git", ["add", "change.txt"], { cwd: project });
  await runFile("git", ["commit", "-m", "base"], { cwd: project });
  await writeFile(filePath, "after\n", "utf8");
  const hash = createHash("sha256").update(await readFile(filePath)).digest("hex");
  database.prepare("INSERT INTO evidence (id, task_id, criterion_key, type, status, summary, payload_json, created_at) VALUES (?, ?, '*', 'diff', 'passed', 'attributed', ?, ?)")
    .run(randomUUID(), fixture.taskId, JSON.stringify({ changes: [{ path: "change.txt", changeType: "modified", hash, baselineHash: null, safe: true }] }), new Date().toISOString());
  database.prepare("UPDATE commissions SET status = 'awaiting_acceptance' WHERE id = ?").run(fixture.commissionId);
  const runner = async (file: string, args: string[], cwd: string): Promise<string> => {
    if (file === "git" && args[0] === "commit") throw new Error("token=ghp_do_not_store");
    return (await runFile(file, args, { cwd })).stdout;
  };
  const worker = registerDeliveryRoutes(server, database, undefined, runner);
  try {
    const preview = await server.inject({ method: "POST", url: `/api/tasks/${fixture.taskId}/delivery-preview`, payload: { method: "vcs_commit", commitMessage: "deliver change" } });
    const queued = await server.inject({ method: "POST", url: `/api/tasks/${fixture.taskId}/deliver`, payload: { method: "vcs_commit", commitMessage: "deliver change", previewFingerprint: preview.json().fingerprint } });
    await worker.wake();
    const deliveryId = queued.json().id as string;
    const delivery = (await server.inject({ method: "GET", url: `/api/deliveries/${deliveryId}` })).json() as { status: string; attempts: Array<{ failureSummary: string }> };
    assert.equal(delivery.status, "failed");
    assert.doesNotMatch(delivery.attempts[0]!.failureSummary, /ghp_do_not_store/);
    const notification = database.prepare("SELECT entity_type, entity_id, body FROM notifications ORDER BY created_at DESC LIMIT 1").get() as { entity_type: string; entity_id: string; body: string };
    assert.deepEqual({ entity_type: notification.entity_type, entity_id: notification.entity_id }, { entity_type: "delivery", entity_id: deliveryId });
    assert.match(notification.body, /失败步骤/);
    assert.equal((database.prepare("SELECT status FROM commissions WHERE id = ?").get(fixture.commissionId) as { status: string }).status, "awaiting_acceptance");
  } finally { await server.close(); database.close(); await rm(project, { recursive: true, force: true }); await rm(databaseHome, { recursive: true, force: true }); }
});

test("Git recovery rejects a same-message commit whose content drifted from the preview", async () => {
  const project = await mkdtemp(join(tmpdir(), "project-workshop-git-recovery-"));
  const databaseHome = await mkdtemp(join(tmpdir(), "project-workshop-recovery-db-"));
  const database = await openWorkshopDatabase(databaseHome);
  const server = Fastify();
  const fixture = seed(database, project, "git");
  const filePath = join(project, "change.txt");
  await writeFile(filePath, "before\n", "utf8");
  await runFile("git", ["init"], { cwd: project });
  await runFile("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
  await runFile("git", ["config", "user.name", "Test"], { cwd: project });
  await runFile("git", ["add", "change.txt"], { cwd: project });
  await runFile("git", ["commit", "-m", "base"], { cwd: project });
  await writeFile(filePath, "after\n", "utf8");
  const hash = createHash("sha256").update(await readFile(filePath)).digest("hex");
  database.prepare("INSERT INTO evidence (id, task_id, criterion_key, type, status, summary, payload_json, created_at) VALUES (?, ?, '*', 'diff', 'passed', 'attributed', ?, ?)")
    .run(randomUUID(), fixture.taskId, JSON.stringify({ changes: [{ path: "change.txt", changeType: "modified", hash, baselineHash: null, safe: true }] }), new Date().toISOString());
  database.prepare("UPDATE commissions SET status = 'awaiting_acceptance' WHERE id = ?").run(fixture.commissionId);
  let failCommit = true;
  const runner = async (file: string, args: string[], cwd: string): Promise<string> => {
    if (file === "git" && args[0] === "commit" && failCommit) { failCommit = false; throw new Error("simulated commit failure"); }
    return (await runFile(file, args, { cwd })).stdout;
  };
  const worker = registerDeliveryRoutes(server, database, undefined, runner);
  const url = "/api/tasks/" + fixture.taskId + "/delivery-preview";
  const deliverUrl = "/api/tasks/" + fixture.taskId + "/deliver";
  const idUrl = (id: string) => "/api/deliveries/" + id;
  try {
    const preview = await server.inject({ method: "POST", url, payload: { method: "vcs_commit", commitMessage: "deliver change" } });
    const queued = await server.inject({ method: "POST", url: deliverUrl, payload: { method: "vcs_commit", commitMessage: "deliver change", previewFingerprint: preview.json().fingerprint } });
    await worker.wake();
    const failed = await server.inject({ method: "GET", url: idUrl(queued.json().id as string) });
    assert.equal(failed.json().status, "failed");
    await writeFile(filePath, "user changed\n", "utf8");
    await runFile("git", ["add", "change.txt"], { cwd: project });
    await runFile("git", ["commit", "-m", "deliver change"], { cwd: project });
    const retried = await server.inject({ method: "POST", url: idUrl(queued.json().id as string) + "/retry" });
    assert.equal(retried.statusCode, 202);
    await worker.wake();
    const recovered = await server.inject({ method: "GET", url: idUrl(queued.json().id as string) });
    assert.equal(recovered.json().status, "waiting_human");
    assert.equal((database.prepare("SELECT status FROM commissions WHERE id = ?").get(fixture.commissionId) as { status: string }).status, "awaiting_acceptance");
  } finally { await server.close(); database.close(); await rm(project, { recursive: true, force: true }); await rm(databaseHome, { recursive: true, force: true }); }
});

function seed(database: DatabaseSync, projectRoot: string, vcsType: "none" | "git" | "svn"): { commissionId: string; taskId: string } {
  const now = new Date().toISOString();
  const rootId = randomUUID();
  const projectId = randomUUID();
  const commissionId = randomUUID();
  const requirementId = randomUUID();
  const taskId = randomUUID();
  database.prepare("INSERT INTO root_paths (id, path, real_path, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)").run(rootId, projectRoot, projectRoot, now, now);
  database.prepare("INSERT INTO projects (id, name, path, real_path, root_path_id, vcs_type, vcs_root, created_at, updated_at) VALUES (?, 'Project', ?, ?, ?, ?, ?, ?, ?)").run(projectId, projectRoot, projectRoot, rootId, vcsType, vcsType === "none" ? null : projectRoot, now, now);
  database.prepare("INSERT INTO commissions (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, 'Commission', 'planned', ?, ?)").run(commissionId, projectId, now, now);
  database.prepare("INSERT INTO requirement_versions (id, commission_id, version_no, content_markdown, acceptance_json, status, created_by, created_at, approved_at) VALUES (?, ?, 1, 'Requirement', '[]', 'approved', 'human', ?, ?)").run(requirementId, commissionId, now, now);
  database.prepare("UPDATE commissions SET active_requirement_version_id = ? WHERE id = ?").run(requirementId, commissionId);
  database.prepare("INSERT INTO tasks (id, commission_id, number_path, position, title, description, status, priority, owner_type, acceptance_json, review_round_limit, review_round_used, created_at, updated_at) VALUES (?, ?, '1', 0, 'Main', '', 'in_progress', 'none', 'human', '[]', 0, 0, ?, ?)").run(taskId, commissionId, now, now);
  database.prepare("UPDATE commissions SET active_requirement_version_id = ?, main_task_id = ? WHERE id = ?").run(requirementId, taskId, commissionId);
  return { commissionId, taskId };
}
