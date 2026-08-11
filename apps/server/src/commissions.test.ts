import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import test from "node:test";
import Fastify from "fastify";
import { archiveCommission, reactivateCommission, recoverCommissionLifecycleOperations } from "./commission-archive.ts";
import { extractAttachmentText, registerCommissionRoutes, type RequirementAnalyzer } from "./commissions.ts";
import { openWorkshopDatabase } from "./database.ts";
import type { TaskPlanner } from "./planner-agent.ts";

test("deletes only commissions that are still in clarification", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-delete-commission-"));
  const server = Fastify();
  const database = await openWorkshopDatabase(home);
  try {
    const projectId = seedProject(database);
    const attachmentsRoot = join(home, "attachments");
    registerCommissionRoutes(server, database, attachmentsRoot);
    const commissionId = (await server.inject({ method: "POST", url: `/api/projects/${projectId}/commissions`, payload: { title: "Disposable", message: "Still clarifying" } })).json().id as string;
    const uploaded = (await server.inject({
      method: "POST",
      url: `/api/commissions/${commissionId}/attachments`,
      headers: { "content-type": "text/plain", "x-file-name": "note.txt" },
      payload: "temporary"
    })).json() as { storage_path: string };

    assert.equal((await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/archive` })).statusCode, 409);
    assert.equal((await server.inject({ method: "DELETE", url: `/api/commissions/${commissionId}` })).statusCode, 204);
    assert.equal(database.prepare("SELECT 1 FROM commissions WHERE id = ?").get(commissionId), undefined);
    assert.equal(database.prepare("SELECT 1 FROM requirement_messages WHERE commission_id = ?").get(commissionId), undefined);
    await assert.rejects(access(uploaded.storage_path));

    const plannedId = (await server.inject({ method: "POST", url: `/api/projects/${projectId}/commissions`, payload: { title: "Keep", message: "Clarified" } })).json().id as string;
    await server.inject({ method: "POST", url: `/api/commissions/${plannedId}/requirements/approved`, payload: { contentMarkdown: "# Approved", acceptanceCriteria: [] } });
    assert.equal((await server.inject({ method: "DELETE", url: `/api/commissions/${plannedId}` })).statusCode, 409);
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("compresses a clarified commission and restores its documents, tasks, history, and attachments", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-archive-commission-"));
  const server = Fastify();
  const database = await openWorkshopDatabase(home);
  try {
    const projectId = seedProject(database);
    const attachmentsRoot = join(home, "attachments");
    registerCommissionRoutes(server, database, attachmentsRoot);
    const commissionId = (await server.inject({ method: "POST", url: `/api/projects/${projectId}/commissions`, payload: { title: "Archive me", message: "Preserve everything" } })).json().id as string;
    const requirement = (await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/requirements/approved`, payload: { contentMarkdown: "# Approved", acceptanceCriteria: ["Restored"] } })).json() as { id: string };
    const attachment = (await server.inject({
      method: "POST",
      url: `/api/commissions/${commissionId}/attachments`,
      headers: { "content-type": "text/plain", "x-file-name": "archive.txt" },
      payload: "compressible content ".repeat(100)
    })).json() as { id: string; storage_path: string };
    const taskId = insertTask(database, commissionId);
    const otherCommissionId = (await server.inject({ method: "POST", url: `/api/projects/${projectId}/commissions`, payload: { title: "Dependent", message: "Keep active" } })).json().id as string;
    await server.inject({ method: "POST", url: `/api/commissions/${otherCommissionId}/requirements/approved`, payload: { contentMarkdown: "# Dependent", acceptanceCriteria: [] } });
    const dependentTaskId = insertTask(database, otherCommissionId);
    const now = new Date().toISOString();
    database.prepare("UPDATE commissions SET main_task_id = ? WHERE id = ?").run(taskId, commissionId);
    database.prepare("INSERT INTO comments (id, task_id, author_type, kind, content, created_at) VALUES (?, ?, 'human', 'normal', 'history', ?)").run(randomUUID(), taskId, now);
    const runId = randomUUID();
    database.prepare(`INSERT INTO runs (id, project_id, commission_id, task_id, role, trigger_type, status, attempt_no, config_snapshot_json, context_snapshot_json)
      VALUES (?, ?, ?, ?, 'developer', 'manual', 'running', 1, '{}', '{}')`)
      .run(runId, projectId, commissionId, taskId);
    database.prepare("INSERT INTO run_events (run_id, event_type, summary, payload_json, redacted, created_at) VALUES (?, 'result', 'done', '{}', 0, ?)").run(runId, now);
    const documentId = randomUUID();
    const versionId = randomUUID();
    database.prepare("INSERT INTO documents (id, project_id, commission_id, type, title, created_at) VALUES (?, ?, ?, 'requirement', 'Requirement', ?)").run(documentId, projectId, commissionId, now);
    database.prepare("INSERT INTO document_versions (id, document_id, version_no, content_markdown, source_json, locked, created_by, created_at) VALUES (?, ?, 1, '# Document', '{}', 1, 'human', ?)").run(versionId, documentId, now);
    database.prepare("UPDATE documents SET current_version_id = ? WHERE id = ?").run(versionId, documentId);

    assert.equal((await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/archive` })).statusCode, 409);
    database.prepare("UPDATE runs SET status = 'succeeded', finished_at = ? WHERE id = ?").run(now, runId);
    database.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id, created_by, created_at) VALUES (?, ?, 'human', ?)").run(dependentTaskId, taskId, now);
    assert.equal((await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/archive` })).statusCode, 409);
    database.prepare("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?").run(dependentTaskId, taskId);
    const abandonedArchive = join(home, "archives", commissionId);
    const abandonedArchiveTemp = join(home, "archives", `${commissionId}.crash.tmp`);
    database.prepare("UPDATE commissions SET lifecycle_operation = 'archiving', lifecycle_token = 'crashed' WHERE id = ?").run(commissionId);
    await Promise.all([mkdir(abandonedArchive, { recursive: true }), mkdir(abandonedArchiveTemp, { recursive: true })]);
    assert.deepEqual(await recoverCommissionLifecycleOperations(database, attachmentsRoot), [commissionId]);
    assert.equal((database.prepare("SELECT lifecycle_operation FROM commissions WHERE id = ?").get(commissionId) as { lifecycle_operation: string | null }).lifecycle_operation, null);
    await Promise.all([assert.rejects(access(abandonedArchive)), assert.rejects(access(abandonedArchiveTemp))]);
    assert.equal((database.prepare("SELECT content FROM comments WHERE task_id = ?").get(taskId) as { content: string }).content, "history");

    const archiving = archiveCommission(database, attachmentsRoot, commissionId);
    assert.equal((database.prepare("SELECT lifecycle_operation FROM commissions WHERE id = ?").get(commissionId) as { lifecycle_operation: string }).lifecycle_operation, "archiving");
    assert.throws(() => database.prepare("INSERT INTO comments (id, task_id, author_type, kind, content, created_at) VALUES (?, ?, 'human', 'normal', 'late write', ?)").run(randomUUID(), taskId, now), /lifecycle operation/i);
    const archivedCommission = await archiving as { archive_path: string; archive_size_bytes: number; status: string };
    assert.equal(archivedCommission.status, "archived");
    assert.ok(archivedCommission.archive_size_bytes > 0);
    await access(join(archivedCommission.archive_path, "metadata.json.gz"));
    await assert.rejects(access(attachment.storage_path));
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE commission_id = ?").get(commissionId) as { count: number }).count, 0);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM documents WHERE commission_id = ?").get(commissionId) as { count: number }).count, 0);
    assert.equal(((await server.inject({ method: "GET", url: `/api/projects/${projectId}/commissions` })).json() as unknown[]).length, 1);
    assert.equal(((await server.inject({ method: "GET", url: `/api/projects/${projectId}/commissions?archived=true` })).json() as Array<{ id: string }>)[0]?.id, commissionId);

    const abandonedRestore = join(attachmentsRoot, commissionId);
    const abandonedRestoreTemp = join(attachmentsRoot, `.${commissionId}.crash.restore`);
    database.prepare("UPDATE commissions SET lifecycle_operation = 'reactivating', lifecycle_token = 'crashed' WHERE id = ?").run(commissionId);
    await Promise.all([mkdir(abandonedRestore, { recursive: true }), mkdir(abandonedRestoreTemp, { recursive: true })]);
    await writeFile(join(abandonedRestore, "stale"), "stale");
    assert.deepEqual(await recoverCommissionLifecycleOperations(database, attachmentsRoot), [commissionId]);
    await Promise.all([assert.rejects(access(abandonedRestore)), assert.rejects(access(abandonedRestoreTemp))]);
    await access(join(archivedCommission.archive_path, "metadata.json.gz"));

    await mkdir(abandonedRestore, { recursive: true });
    await writeFile(join(abandonedRestore, "stale-source-file"), "left behind after archive cleanup failed");

    const reactivationResults = await Promise.allSettled([
      reactivateCommission(database, attachmentsRoot, commissionId),
      reactivateCommission(database, attachmentsRoot, commissionId)
    ]);
    assert.equal(reactivationResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(reactivationResults.filter((result) => result.status === "rejected").length, 1);
    const restored = reactivationResults.find((result): result is PromiseFulfilledResult<Record<string, unknown>> => result.status === "fulfilled")!.value as { status: string; active_requirement_version_id: string; main_task_id: string; archive_path: null };
    assert.deepEqual({ status: restored.status, requirement: restored.active_requirement_version_id, task: restored.main_task_id, archive: restored.archive_path }, { status: "planned", requirement: requirement.id, task: taskId, archive: null });
    assert.equal((database.prepare("SELECT content FROM comments WHERE task_id = ?").get(taskId) as { content: string }).content, "history");
    assert.equal((database.prepare("SELECT summary FROM run_events WHERE run_id = ?").get(runId) as { summary: string }).summary, "done");
    assert.equal((database.prepare("SELECT content_markdown FROM document_versions WHERE id = ?").get(versionId) as { content_markdown: string }).content_markdown, "# Document");
    assert.equal(await readFile(attachment.storage_path, "utf8"), "compressible content ".repeat(100));
    await assert.rejects(access(join(abandonedRestore, "stale-source-file")));
    await assert.rejects(access(archivedCommission.archive_path));
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("approving a requirement automatically writes the planning Agent task tree", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-planning-"));
  const server = Fastify();
  const database = await openWorkshopDatabase(home);
  let analyzedWith: unknown;
  let plannedWith: unknown;
  const analyzer: RequirementAnalyzer = async (input) => {
    analyzedWith = input.agentConfig;
    return { contentMarkdown: "## Goal\nShip it", acceptanceCriteria: ["Done"] };
  };
  const planner: TaskPlanner = async (input) => {
    plannedWith = input.agentConfig;
    return ({
    mainTask: { title: "Delivery", description: "Human acceptance", priority: "high", acceptanceCriteria: ["Accepted"] },
    tasks: [{ clientId: "T1", parentClientId: null, title: "Implement", description: "Build it", priority: "medium", ownerType: "ai", readOnly: false, acceptanceCriteria: ["Reviewed"], dependsOn: [] }]
    });
  };
  try {
    const projectId = seedProject(database);
    database.prepare("INSERT INTO role_configs (id, project_id, role, prompt, model, reasoning_effort, custom_args_json, updated_at) VALUES (?, NULL, 'supervisor', '', 'supervisor-model', 'high', '[]', ?)")
      .run(randomUUID(), new Date().toISOString());
    registerCommissionRoutes(server, database, join(home, "attachments"), analyzer, planner);
    const commissionId = (await server.inject({ method: "POST", url: `/api/projects/${projectId}/commissions`, payload: { title: "Feature", message: "Ship it" } })).json().id;
    const requirementId = (await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/analyze` })).json().requirement.id;
    assert.equal((await server.inject({ method: "POST", url: `/api/requirements/${requirementId}/approve` })).statusCode, 200);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE commission_id = ? AND status = 'backlog'").get(commissionId) as { count: number }).count, 2);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM documents WHERE commission_id = ? AND type = 'plan'").get(commissionId) as { count: number }).count, 1);
    assert.deepEqual(analyzedWith, { prompt: "", model: "supervisor-model", reasoningEffort: "high", customArgs: [], sandboxMode: "workspace-write", approvalPolicy: "on-request", networkAccess: true });
    assert.deepEqual(plannedWith, analyzedWith);
  } finally { await server.close(); database.close(); await rm(home, { recursive: true, force: true }); }
});

test("runs one-question clarification and versions approved requirements", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-commissions-"));
  const server = Fastify();
  const database = await openWorkshopDatabase(home);
  let analysis = 0;
  const analyzer: RequirementAnalyzer = async () => ++analysis === 1
    ? { question: "Which platform is required?", options: ["Windows", "macOS"] }
    : analysis === 2 ? { completionQuestion: true }
    : { contentMarkdown: "## Goal\nShip the feature.", acceptanceCriteria: ["Tests pass"] };
  try {
    const projectId = seedProject(database);
    registerCommissionRoutes(server, database, join(home, "attachments"), analyzer);
    const created = await server.inject({ method: "POST", url: `/api/projects/${projectId}/commissions`, payload: { title: "First", message: "Build it" } });
    assert.equal(created.statusCode, 201);
    const commissionId = (created.json() as { id: string }).id;
    const second = await server.inject({ method: "POST", url: `/api/projects/${projectId}/commissions`, payload: { title: "Second" } });
    assert.equal(second.statusCode, 201);
    const commissions = (await server.inject({ method: "GET", url: `/api/projects/${projectId}/commissions` })).json() as Array<{ title: string; summary: string | null }>;
    assert.equal(commissions.length, 2);
    assert.equal(commissions.find((commission) => commission.title === "First")?.summary, "Build it");
    assert.equal(commissions.find((commission) => commission.title === "Second")?.summary, null);

    const question = await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/analyze` });
    assert.equal(question.statusCode, 200);
    assert.equal((question.json() as { kind: string }).kind, "question");
    assert.deepEqual(JSON.parse((question.json() as { message: { options_json: string } }).message.options_json), ["Windows", "macOS"]);
    await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/messages`, payload: { content: "Windows and macOS" } });
    const completion = await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/analyze` });
    assert.match((completion.json() as { message: { content: string } }).message.content, /确认结束需求澄清/);
    assert.equal((await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/analyze` })).statusCode, 409);
    await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/messages`, payload: { content: "同意结束澄清" } });
    const generated = await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/analyze` });
    assert.equal(generated.statusCode, 201);
    const requirementId = (generated.json() as { requirement: { id: string } }).requirement.id;

    assert.throws(() => insertTask(database, commissionId), /requirement is not approved/);
    assert.equal((await server.inject({ method: "POST", url: `/api/requirements/${requirementId}/approve` })).statusCode, 200);
    insertTask(database, commissionId);

    await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/messages`, payload: { content: "Also support Linux" } });
    assert.throws(() => insertTask(database, commissionId), /requirement is not approved/);
    const changed = await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/analyze` });
    const changedId = (changed.json() as { requirement: { id: string } }).requirement.id;
    await server.inject({ method: "POST", url: `/api/requirements/${changedId}/approve` });
    const versions = (await server.inject({ method: "GET", url: `/api/commissions/${commissionId}/requirements` })).json() as Array<{ id: string; status: string }>;
    assert.equal(versions.find((version) => version.id === requirementId)?.status, "superseded");
    assert.equal(versions.find((version) => version.id === changedId)?.status, "approved");

    await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/messages`, payload: { content: "Remove Linux again" } });
    const rejected = await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/analyze` });
    const rejectedId = (rejected.json() as { requirement: { id: string } }).requirement.id;
    assert.equal((await server.inject({ method: "POST", url: `/api/requirements/${rejectedId}/reject`, payload: { reason: "Keep the current version" } })).statusCode, 200);
    assert.equal((database.prepare("SELECT status FROM requirement_versions WHERE id = ?").get(rejectedId) as { status: string }).status, "rejected");
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("accumulates requirement clarification token usage on the commission", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-clarification-tokens-"));
  const server = Fastify();
  const database = await openWorkshopDatabase(home);
  let analysis = 0;
  const analyzer: RequirementAnalyzer = async () => ++analysis === 1
    ? { question: "Which platform?", tokenUsage: { input: 120, output: 20, cached: 80 } }
    : { contentMarkdown: "## Goal\nShip it.", acceptanceCriteria: ["Done"], tokenUsage: { input: 70, output: 30, cached: 40 } };
  try {
    const projectId = seedProject(database);
    registerCommissionRoutes(server, database, join(home, "attachments"), analyzer);
    const commissionId = (await server.inject({ method: "POST", url: `/api/projects/${projectId}/commissions`, payload: { title: "Tokens", message: "Build it" } })).json().id;

    assert.equal((await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/analyze` })).statusCode, 200);
    await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/messages`, payload: { content: "Windows" } });
    assert.equal((await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/analyze` })).statusCode, 201);

    const details = (await server.inject({ method: "GET", url: `/api/commissions/${commissionId}` })).json() as {
      clarification_token_input: number;
      clarification_token_output: number;
      clarification_token_cached: number;
    };
    assert.deepEqual([
      details.clarification_token_input,
      details.clarification_token_output,
      details.clarification_token_cached
    ], [190, 50, 120]);
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("creates an approved requirement directly before manual task planning", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-direct-requirement-"));
  const server = Fastify();
  const database = await openWorkshopDatabase(home);
  try {
    const projectId = seedProject(database);
    registerCommissionRoutes(server, database, join(home, "attachments"));
    const commissionId = (await server.inject({ method: "POST", url: `/api/projects/${projectId}/commissions`, payload: { title: "Direct", message: "Use the supplied specification" } })).json().id;
    const created = await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/requirements/approved`, payload: { contentMarkdown: "# Goal\nShip directly.", acceptanceCriteria: ["Tests pass"] } });
    assert.equal(created.statusCode, 201);
    const requirement = created.json() as { id: string; status: string; created_by: string };
    assert.equal(requirement.status, "approved");
    assert.equal(requirement.created_by, "human");
    assert.deepEqual({ ...database.prepare("SELECT status, active_requirement_version_id FROM commissions WHERE id = ?").get(commissionId) }, { status: "planned", active_requirement_version_id: requirement.id });
    insertTask(database, commissionId);
    assert.equal((await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/requirements/approved`, payload: { contentMarkdown: "Replacement", acceptanceCriteria: [] } })).statusCode, 409);
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("does not accept another commission's approved requirement", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-task-gate-"));
  const database = await openWorkshopDatabase(home);
  try {
    const projectId = seedProject(database);
    const now = new Date().toISOString();
    const first = randomUUID();
    const second = randomUUID();
    const requirement = randomUUID();
    database.prepare("INSERT INTO commissions (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'planned', ?, ?)").run(first, projectId, "First", now, now);
    database.prepare("INSERT INTO commissions (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'planned', ?, ?)").run(second, projectId, "Second", now, now);
    database.prepare("INSERT INTO requirement_versions (id, commission_id, version_no, content_markdown, acceptance_json, status, created_by, created_at, approved_at) VALUES (?, ?, 1, 'Approved', '[]', 'approved', 'human', ?, ?)").run(requirement, first, now, now);
    database.prepare("UPDATE commissions SET active_requirement_version_id = ? WHERE id = ?").run(requirement, second);
    assert.throws(() => insertTask(database, second), /requirement is not approved/);
  } finally {
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("keeps exactly one current requirement candidate", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-requirement-candidate-"));
  const server = Fastify();
  const database = await openWorkshopDatabase(home);
  const analyzer: RequirementAnalyzer = async () => ({ contentMarkdown: "## Goal\nShip it.", acceptanceCriteria: ["Done"] });
  try {
    const projectId = seedProject(database);
    registerCommissionRoutes(server, database, join(home, "attachments"), analyzer);
    const created = await server.inject({ method: "POST", url: `/api/projects/${projectId}/commissions`, payload: { title: "Candidate", message: "Build it" } });
    const commissionId = (created.json() as { id: string }).id;
    const first = await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/analyze` });
    const firstId = (first.json() as { requirement: { id: string } }).requirement.id;
    assert.equal((await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/analyze` })).statusCode, 409);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM requirement_versions WHERE commission_id = ? AND status = 'awaiting_approval'").get(commissionId) as { count: number }).count, 1);
    await server.inject({ method: "POST", url: `/api/requirements/${firstId}/approve` });
    await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/messages`, payload: { content: "Change it" } });
    const changed = await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/analyze` });
    const changedId = (changed.json() as { requirement: { id: string } }).requirement.id;
    await server.inject({ method: "POST", url: `/api/requirements/${changedId}/reject`, payload: { reason: "Keep v1" } });
    const commission = database.prepare("SELECT status, active_requirement_version_id FROM commissions WHERE id = ?").get(commissionId) as { status: string; active_requirement_version_id: string };
    assert.equal(commission.status, "planned");
    assert.equal(commission.active_requirement_version_id, firstId);
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("keeps a pending candidate actionable by rejecting new messages", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-pending-message-"));
  const server = Fastify();
  const database = await openWorkshopDatabase(home);
  const analyzer: RequirementAnalyzer = async () => ({ contentMarkdown: "## Goal\nShip it.", acceptanceCriteria: ["Done"] });
  try {
    const projectId = seedProject(database);
    registerCommissionRoutes(server, database, join(home, "attachments"), analyzer);
    const created = await server.inject({ method: "POST", url: `/api/projects/${projectId}/commissions`, payload: { title: "Candidate", message: "Build it" } });
    const commissionId = (created.json() as { id: string }).id;
    const first = await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/analyze` });
    const firstId = (first.json() as { requirement: { id: string } }).requirement.id;

    assert.equal((await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/messages`, payload: { content: "Change during approval" } })).statusCode, 409);
    assert.equal((database.prepare("SELECT status FROM commissions WHERE id = ?").get(commissionId) as { status: string }).status, "awaiting_requirement_approval");
    assert.equal((await server.inject({ method: "POST", url: `/api/requirements/${firstId}/approve` })).statusCode, 200);

    assert.equal((await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/messages`, payload: { content: "Change after approval" } })).statusCode, 201);
    const second = await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/analyze` });
    const secondId = (second.json() as { requirement: { id: string } }).requirement.id;
    assert.equal((await server.inject({ method: "POST", url: `/api/requirements/${secondId}/reject`, payload: { reason: "Keep approved version" } })).statusCode, 200);

    assert.equal((await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/messages`, payload: { content: "Try another change" } })).statusCode, 201);
    assert.equal((await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/analyze` })).statusCode, 201);
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("stores extracted text under generated paths and enforces attachment limits", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-attachments-"));
  const server = Fastify();
  const database = await openWorkshopDatabase(home);
  try {
    const projectId = seedProject(database);
    registerCommissionRoutes(server, database, join(home, "attachments"));
    const created = await server.inject({ method: "POST", url: `/api/projects/${projectId}/commissions`, payload: { title: "Files" } });
    const commissionId = (created.json() as { id: string }).id;
    const uploaded = await server.inject({
      method: "POST",
      url: `/api/commissions/${commissionId}/attachments`,
      headers: { "content-type": "text/plain", "x-file-name": encodeURIComponent("需求说明.txt") },
      payload: Buffer.from("hello")
    });
    assert.equal(uploaded.statusCode, 201);
    const attachment = uploaded.json() as { original_name: string; storage_path: string; extracted_text: string };
    assert.equal(attachment.original_name, "需求说明.txt");
    assert.equal(attachment.extracted_text, "hello");
    assert.equal(await readFile(attachment.storage_path, "utf8"), "hello");
    assert.equal(attachment.storage_path.includes("notes.txt"), false);
    assert.equal((await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/attachments`, headers: { "content-type": "text/plain", "x-file-name": "../bad.txt" }, payload: "bad" })).statusCode, 400);
    assert.equal((await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/attachments`, headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "x-file-name": "broken.docx" }, payload: Buffer.alloc(4) })).statusCode, 400);
    assert.equal((await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/attachments`, headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "x-file-name": "bomb.docx" }, payload: storedDocx("x", 5 * 1024 * 1024 + 1) })).statusCode, 400);
    const compressed = deflateSync(Buffer.alloc(5 * 1024 * 1024 + 1, "A"));
    const pdfBomb = Buffer.concat([Buffer.from("<< /Filter /FlateDecode >>\nstream\n"), compressed, Buffer.from("\nendstream")]);
    assert.equal((await server.inject({ method: "POST", url: `/api/commissions/${commissionId}/attachments`, headers: { "content-type": "application/pdf", "x-file-name": "bomb.pdf" }, payload: pdfBomb })).statusCode, 400);

    const insertAttachment = database.prepare("INSERT INTO attachments (id, commission_id, original_name, media_type, size_bytes, storage_path, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const otherCommission = (await server.inject({ method: "POST", url: `/api/projects/${projectId}/commissions`, payload: { title: "Limits" } })).json() as { id: string };
    const now = new Date().toISOString();
    for (let index = 0; index < 4; index += 1) insertAttachment.run(randomUUID(), otherCommission.id, `${index}.txt`, "text/plain", 50 * 1024 * 1024, `${index}`, `${index}`, now);
    assert.throws(() => insertAttachment.run(randomUUID(), otherCommission.id, "extra.txt", "text/plain", 1, "extra", "extra", now), /exceed 200 MB/);
    assert.throws(() => insertAttachment.run(randomUUID(), commissionId, "large.txt", "text/plain", 50 * 1024 * 1024 + 1, "large", "large", now), /CHECK constraint failed/);
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("extracts simple PDF and DOCX text without extra dependencies", () => {
  assert.equal(extractAttachmentText(".pdf", Buffer.from("BT (Hello\\nPDF) Tj ET", "latin1")), "Hello\nPDF");
  assert.equal(extractAttachmentText(".docx", storedDocx("<w:document><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p></w:body></w:document>")), "Hello DOCX");
});

function seedProject(database: Awaited<ReturnType<typeof openWorkshopDatabase>>): string {
  const rootId = randomUUID();
  const projectId = randomUUID();
  const now = new Date().toISOString();
  database.prepare("INSERT INTO root_paths (id, path, real_path, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)").run(rootId, "root", `root-${rootId}`, now, now);
  database.prepare("INSERT INTO projects (id, name, path, real_path, root_path_id, vcs_type, created_at, updated_at) VALUES (?, 'Project', ?, ?, ?, 'none', ?, ?)").run(projectId, `project-${projectId}`, `project-${projectId}`, rootId, now, now);
  return projectId;
}

function insertTask(database: Awaited<ReturnType<typeof openWorkshopDatabase>>, commissionId: string): string {
  const now = new Date().toISOString();
  const id = randomUUID();
  database.prepare(`
    INSERT INTO tasks (id, commission_id, number_path, position, title, description, status, priority, owner_type, acceptance_json, review_round_limit, review_round_used, created_at, updated_at)
    VALUES (?, ?, '1', 0, 'Task', '', 'backlog', 'medium', 'ai', '[]', 2, 0, ?, ?)
  `).run(id, commissionId, now, now);
  return id;
}

function storedDocx(xml: string, declaredSize = Buffer.byteLength(xml)): Buffer {
  const name = Buffer.from("word/document.xml");
  const content = Buffer.from(xml);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(name.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(local.length + name.length + content.length, 16);
  return Buffer.concat([local, name, content, central, name, eocd]);
}
