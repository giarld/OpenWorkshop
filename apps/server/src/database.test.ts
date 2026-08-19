import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import Fastify from "fastify";
import { registerCommissionRoutes } from "./commissions.ts";
import { backupDatabase, openWorkshopDatabase, restoreDatabase, SettingsStore } from "./database.ts";

function dropAttachmentLinkColumns(database: DatabaseSync): void {
  database.exec("DROP INDEX attachments_run_created; DROP INDEX attachments_comment_created; DROP INDEX attachments_task_created; ALTER TABLE attachments DROP COLUMN run_id; ALTER TABLE attachments DROP COLUMN comment_id; ALTER TABLE attachments DROP COLUMN task_id");
}

function dropSystemNotificationColumn(database: DatabaseSync): void {
  database.exec("ALTER TABLE notifications DROP COLUMN system_notified_at");
}

function dropCoordinationRevisionMigration(database: DatabaseSync): void {
  database.exec("DROP TRIGGER IF EXISTS task_dependencies_revision_delete; DROP TRIGGER IF EXISTS task_dependencies_revision_insert; DROP TRIGGER IF EXISTS tasks_structure_revision_update; DROP TRIGGER IF EXISTS tasks_structure_revision_insert; DROP INDEX plan_revision_cards_one_pending; DROP TABLE plan_revision_cards; ALTER TABLE tasks DROP COLUMN deleted_dependency_ids_json; ALTER TABLE tasks DROP COLUMN deleted_revision_id; ALTER TABLE tasks DROP COLUMN deleted_reason; ALTER TABLE tasks DROP COLUMN deleted_at; DROP INDEX plan_revisions_one_active; DROP TABLE plan_revisions; DROP TRIGGER tasks_revision_coordination; ALTER TABLE runs DROP COLUMN coordination_revision; ALTER TABLE commissions DROP COLUMN coordination_pending; ALTER TABLE commissions DROP COLUMN coordination_revision");
}

function dropProjectTaskSequence(database: DatabaseSync): void {
  database.exec("DROP TABLE project_task_sequences");
}

test("migrates a temporary database and stores JSON settings", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-db-"));
  try {
    const database = await openWorkshopDatabase(home);
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 28);
    assert.equal((database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
    assert.equal((database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => (row as { name: string }).name);
    assert.ok(["settings", "projects", "project_task_sequences", "commissions", "tasks", "runs", "documents"].every((table) => tables.includes(table)));
    assert.match((database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approvals'").get() as { sql: string }).sql, /mcp_tool_call/);
    const commissionColumns = database.prepare("PRAGMA table_info(commissions)").all().map((row) => (row as { name: string }).name);
    assert.ok(["clarification_token_input", "clarification_token_output", "clarification_token_cached", "archive_path", "archive_sha256", "archive_size_bytes", "lifecycle_operation", "lifecycle_token", "coordination_revision", "coordination_pending"].every((column) => commissionColumns.includes(column)));
    assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'comments_lifecycle_insert'").get());
    const attachmentColumns = database.prepare("PRAGMA table_info(attachments)").all().map((row) => (row as { name: string }).name);
    assert.ok(["task_id", "comment_id", "run_id"].every((column) => attachmentColumns.includes(column)));
    const taskColumns = database.prepare("PRAGMA table_info(tasks)").all().map((row) => (row as { name: string }).name);
    assert.ok(taskColumns.includes("deleted_dependency_ids_json"));

    const settings = new SettingsStore(database);
    settings.set("globalConcurrency", 4);
    settings.set("logRetentionDays", 90);
    assert.deepEqual(settings.all(), { globalConcurrency: 4, logRetentionDays: 90 });
    assert.equal(settings.get("globalConcurrency"), 4);
    assert.equal(settings.delete("globalConcurrency"), true);
    database.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("v26 migration resolves conflicting active delivery attempts conservatively", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-delivery-migration-"));
  let database = await openWorkshopDatabase(home);
  try {
    const now = new Date().toISOString();
    const root = randomUUID(), project = randomUUID(), commission = randomUUID(), requirement = randomUUID(), task = randomUUID(), delivery = randomUUID();
    database.prepare("INSERT INTO root_paths (id, path, real_path, enabled, created_at, updated_at) VALUES (?, 'root', 'root', 1, ?, ?)").run(root, now, now);
    database.prepare("INSERT INTO projects (id, name, path, real_path, root_path_id, vcs_type, created_at, updated_at) VALUES (?, 'Project', 'project', 'project', ?, 'none', ?, ?)").run(project, root, now, now);
    database.prepare("INSERT INTO commissions (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, 'Commission', 'active', ?, ?)").run(commission, project, now, now);
    database.prepare("INSERT INTO requirement_versions (id, commission_id, version_no, content_markdown, acceptance_json, status, created_by, created_at, approved_at) VALUES (?, ?, 1, 'Requirement', '[]', 'approved', 'human', ?, ?)").run(requirement, commission, now, now);
    database.prepare("UPDATE commissions SET active_requirement_version_id = ? WHERE id = ?").run(requirement, commission);
    database.prepare("INSERT INTO tasks (id, commission_id, number_path, position, title, description, status, priority, owner_type, acceptance_json, review_round_limit, review_round_used, created_at, updated_at) VALUES (?, ?, '1', 0, 'Task', '', 'in_progress', 'medium', 'ai', '[]', 1, 0, ?, ?)").run(task, commission, now, now);
    database.prepare("UPDATE commissions SET main_task_id = ? WHERE id = ?").run(task, commission);
    database.prepare("INSERT INTO deliveries (id, commission_id, main_task_id, method, status, request_json, preview_json, progress_json, result_json, external_effect_started, created_at, updated_at) VALUES (?, ?, ?, 'document', 'waiting_human', '{}', '{}', '{}', '{}', 0, ?, ?)").run(delivery, commission, task, now, now);
    database.exec("DROP TRIGGER delivery_attempts_audit_snapshot_immutable; DROP INDEX deliveries_one_active_attempt; CREATE UNIQUE INDEX deliveries_one_active_attempt ON delivery_attempts(delivery_id) WHERE status IN ('queued', 'preparing', 'running'); PRAGMA user_version = 26");
    database.prepare("INSERT INTO delivery_attempts (id, delivery_id, attempt_no, status, request_json, preview_json, progress_json, result_json, created_at) VALUES (?, ?, 1, 'waiting_human', '{}', '{}', '{}', '{}', ?)").run(randomUUID(), delivery, now);
    database.prepare("INSERT INTO delivery_attempts (id, delivery_id, attempt_no, status, request_json, preview_json, progress_json, result_json, created_at) VALUES (?, ?, 2, 'queued', '{}', '{}', '{}', '{}', ?)").run(randomUUID(), delivery, now);
    database.prepare("UPDATE commissions SET lifecycle_operation = 'archiving' WHERE id = ?").run(commission);
    database.close();

    database = await openWorkshopDatabase(home);
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 28);
    assert.deepEqual(database.prepare("SELECT attempt_no, status, failure_code FROM delivery_attempts ORDER BY attempt_no").all().map((row) => ({ ...row })), [
      { attempt_no: 1, status: "waiting_human", failure_code: null },
      { attempt_no: 2, status: "cancelled", failure_code: "migration_active_attempt_conflict" }
    ]);
    assert.equal((database.prepare("SELECT lifecycle_operation FROM commissions WHERE id = ?").get(commission) as { lifecycle_operation: string }).lifecycle_operation, "archiving");
    assert.throws(() => database.prepare("UPDATE delivery_attempts SET status = 'failed' WHERE delivery_id = ?").run(delivery), /lifecycle operation/);
    assert.throws(() => database.prepare("INSERT INTO notifications (id, kind, title, body, entity_type, entity_id, created_at) VALUES (?, 'completed', 'Delivery', '', 'delivery', ?, ?)").run(randomUUID(), delivery, now), /lifecycle operation/);
    assert.throws(() => database.prepare("UPDATE delivery_attempts SET id = ? WHERE delivery_id = ?").run(randomUUID(), delivery), /immutable/);
  } finally {
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("v26 migration removes duplicate historical diff Evidence before indexing", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-diff-migration-"));
  let database = await openWorkshopDatabase(home);
  try {
    const now = new Date().toISOString();
    const root = randomUUID(), project = randomUUID(), commission = randomUUID(), requirement = randomUUID(), task = randomUUID(), run = randomUUID();
    database.prepare("INSERT INTO root_paths (id, path, real_path, enabled, created_at, updated_at) VALUES (?, 'root', 'root', 1, ?, ?)").run(root, now, now);
    database.prepare("INSERT INTO projects (id, name, path, real_path, root_path_id, vcs_type, created_at, updated_at) VALUES (?, 'Project', 'project', 'project', ?, 'none', ?, ?)").run(project, root, now, now);
    database.prepare("INSERT INTO commissions (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, 'Commission', 'active', ?, ?)").run(commission, project, now, now);
    database.prepare("INSERT INTO requirement_versions (id, commission_id, version_no, content_markdown, acceptance_json, status, created_by, created_at, approved_at) VALUES (?, ?, 1, 'Requirement', '[]', 'approved', 'human', ?, ?)").run(requirement, commission, now, now);
    database.prepare("UPDATE commissions SET active_requirement_version_id = ? WHERE id = ?").run(requirement, commission);
    database.prepare("INSERT INTO tasks (id, commission_id, number_path, position, title, description, status, priority, owner_type, acceptance_json, review_round_limit, review_round_used, created_at, updated_at) VALUES (?, ?, '1', 0, 'Task', '', 'in_progress', 'medium', 'ai', '[]', 1, 0, ?, ?)").run(task, commission, now, now);
    database.prepare("INSERT INTO runs (id, project_id, commission_id, task_id, role, trigger_type, trigger_ref_id, status, attempt_no, config_snapshot_json, context_snapshot_json) VALUES (?, ?, ?, ?, 'developer', 'scheduler', 'grant', 'succeeded', 1, '{}', '{}')").run(run, project, commission, task);
    dropDeliveryMigration(database);
    database.prepare("INSERT INTO evidence (id, task_id, run_id, criterion_key, type, status, summary, payload_json, created_at) VALUES (?, ?, ?, '*', 'diff', 'passed', 'old', ?, ?)").run(randomUUID(), task, run, JSON.stringify({ marker: "old" }), now);
    database.prepare("INSERT INTO evidence (id, task_id, run_id, criterion_key, type, status, summary, payload_json, created_at) VALUES (?, ?, ?, '*', 'diff', 'passed', 'new', ?, ?)").run(randomUUID(), task, run, JSON.stringify({ marker: "new" }), now);
    database.prepare("UPDATE commissions SET lifecycle_operation = 'archiving' WHERE id = ?").run(commission);
    database.exec("PRAGMA user_version = 25");
    database.close();

    database = await openWorkshopDatabase(home);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM evidence WHERE run_id = ? AND type = 'diff'").get(run) as { count: number }).count, 1);
    assert.equal((database.prepare("SELECT summary FROM evidence WHERE run_id = ? AND type = 'diff'").get(run) as { summary: string }).summary, "new");
    assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'evidence_one_diff_per_run'").get());
    assert.equal((database.prepare("SELECT lifecycle_operation FROM commissions WHERE id = ?").get(commission) as { lifecycle_operation: string }).lifecycle_operation, "archiving");
    assert.throws(() => database.prepare("DELETE FROM evidence WHERE run_id = ?").run(run), /lifecycle operation/);
  } finally {
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("migration initializes immutable project task-number sequences", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-task-numbering-migration-"));
  let database = await openWorkshopDatabase(home);
  try {
    const now = new Date().toISOString();
    const root = randomUUID(), project = randomUUID(), commissionA = randomUUID(), commissionB = randomUUID(), requirementA = randomUUID(), requirementB = randomUUID(), taskA = randomUUID(), childA = randomUUID(), taskB = randomUUID();
    database.prepare("INSERT INTO root_paths (id, path, real_path, enabled, created_at, updated_at) VALUES (?, 'root', ?, 1, ?, ?)").run(root, join(home, "project"), now, now);
    database.prepare("INSERT INTO projects (id, name, path, real_path, root_path_id, vcs_type, created_at, updated_at) VALUES (?, 'Project', 'project', ?, ?, 'none', ?, ?)").run(project, join(home, "project"), root, now, now);
    database.prepare("INSERT INTO commissions (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, 'First', 'planned', ?, ?)").run(commissionA, project, now, now);
    database.prepare("INSERT INTO commissions (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, 'Second', 'planned', ?, ?)").run(commissionB, project, now, now);
    database.prepare("INSERT INTO requirement_versions (id, commission_id, version_no, content_markdown, acceptance_json, status, created_by, created_at, approved_at) VALUES (?, ?, 1, 'Requirement', '[]', 'approved', 'human', ?, ?)").run(requirementA, commissionA, now, now);
    database.prepare("INSERT INTO requirement_versions (id, commission_id, version_no, content_markdown, acceptance_json, status, created_by, created_at, approved_at) VALUES (?, ?, 1, 'Requirement', '[]', 'approved', 'human', ?, ?)").run(requirementB, commissionB, now, now);
    database.prepare("UPDATE commissions SET active_requirement_version_id = CASE id WHEN ? THEN ? ELSE ? END WHERE id IN (?, ?)").run(commissionA, requirementA, requirementB, commissionA, commissionB);
    const insert = database.prepare("INSERT INTO tasks (id, commission_id, parent_id, number_path, position, title, description, status, priority, owner_type, acceptance_json, review_round_limit, review_round_used, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '', 'backlog', 'none', 'ai', '[]', 2, 0, ?, ?)");
    insert.run(taskA, commissionA, null, "1", 0, "First", now, now);
    insert.run(childA, commissionA, taskA, "1.1", 0, "Child", now, now);
    insert.run(taskB, commissionB, null, "1", 0, "Second", now, now);
    dropProjectTaskSequence(database);
    dropDeliveryMigration(database);
    database.exec("PRAGMA user_version = 23");
    database.close();
    database = await openWorkshopDatabase(home);
    assert.deepEqual(database.prepare("SELECT number_path FROM tasks WHERE id IN (?, ?, ?) ORDER BY number_path").all(taskA, childA, taskB).map((row) => (row as { number_path: string }).number_path), ["1", "1.1", "2"]);
    assert.equal((database.prepare("SELECT next_number FROM project_task_sequences WHERE project_id = ?").get(project) as { next_number: number }).next_number, 3);
  } finally {
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("backs up before migration and before restore", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-restore-"));
  const sourceHome = await mkdtemp(join(tmpdir(), "project-workshop-source-"));
  try {
    const legacy = new DatabaseSync(join(home, "workshop.db"));
    legacy.exec("CREATE TABLE legacy (value TEXT)");
    legacy.close();
    const migrated = await openWorkshopDatabase(home);
    new SettingsStore(migrated).set("marker", "current");
    migrated.close();
    assert.equal((await readdir(join(home, "backups"))).filter((name) => name.includes("migration")).length, 1);

    const source = await openWorkshopDatabase(sourceHome);
    new SettingsStore(source).set("marker", "restored");
    source.close();
    const sourceBackup = await backupDatabase(join(sourceHome, "workshop.db"));
    const safetyBackup = await restoreDatabase(join(home, "workshop.db"), sourceBackup, join(home, "backups"), join(home, "runtime"));
    assert.ok(safetyBackup);

    const restored = await openWorkshopDatabase(home);
    assert.equal(new SettingsStore(restored).get("marker"), "restored");
    restored.close();
    const previous = new DatabaseSync(safetyBackup!, { readOnly: true });
    assert.equal(new SettingsStore(previous).get("marker"), "current");
    previous.close();
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(sourceHome, { recursive: true, force: true });
  }
});

test("restores committed data that is still in the source WAL", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-wal-target-"));
  const sourceHome = await mkdtemp(join(tmpdir(), "project-workshop-wal-source-"));
  let source: DatabaseSync | undefined;
  try {
    const target = await openWorkshopDatabase(home);
    target.close();
    source = await openWorkshopDatabase(sourceHome);
    source.exec("PRAGMA wal_autocheckpoint = 0");
    new SettingsStore(source).set("walMarker", "committed");
    assert.ok((await stat(join(sourceHome, "workshop.db-wal"))).size > 0);

    await restoreDatabase(join(home, "workshop.db"), join(sourceHome, "workshop.db"), join(home, "backups"), join(home, "runtime"));
    const restored = await openWorkshopDatabase(home);
    assert.equal(new SettingsStore(restored).get("walMarker"), "committed");
    restored.close();
  } finally {
    source?.close();
    await rm(home, { recursive: true, force: true });
    await rm(sourceHome, { recursive: true, force: true });
  }
});

test("migration expires approvals left pending by terminal Runs", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-approval-migration-"));
  let database = await openWorkshopDatabase(home);
  try {
    const now = new Date().toISOString();
    const root = randomUUID(), project = randomUUID(), commission = randomUUID(), requirement = randomUUID(), task = randomUUID(), run = randomUUID(), approval = randomUUID(), notification = randomUUID();
    database.prepare("INSERT INTO root_paths (id, path, real_path, enabled, created_at, updated_at) VALUES (?, 'root', ?, 1, ?, ?)").run(root, join(home, "project"), now, now);
    database.prepare("INSERT INTO projects (id, name, path, real_path, root_path_id, vcs_type, created_at, updated_at) VALUES (?, 'Project', 'project', ?, ?, 'none', ?, ?)").run(project, join(home, "project"), root, now, now);
    database.prepare("INSERT INTO commissions (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, 'Commission', 'active', ?, ?)").run(commission, project, now, now);
    database.prepare("INSERT INTO requirement_versions (id, commission_id, version_no, content_markdown, acceptance_json, status, created_by, created_at, approved_at) VALUES (?, ?, 1, 'Requirement', '[]', 'approved', 'human', ?, ?)").run(requirement, commission, now, now);
    database.prepare("UPDATE commissions SET active_requirement_version_id = ? WHERE id = ?").run(requirement, commission);
    database.prepare("INSERT INTO tasks (id, commission_id, number_path, position, title, description, status, priority, owner_type, acceptance_json, review_round_limit, review_round_used, created_at, updated_at) VALUES (?, ?, '1', 0, 'Task', '', 'in_progress', 'medium', 'ai', '[]', 1, 0, ?, ?)").run(task, commission, now, now);
    database.prepare("INSERT INTO runs (id, project_id, commission_id, task_id, role, trigger_type, status, attempt_no, config_snapshot_json, context_snapshot_json, finished_at) VALUES (?, ?, ?, ?, 'developer', 'manual', 'interrupted', 1, '{}', '{}', ?)").run(run, project, commission, task, now);
    database.prepare("INSERT INTO approvals (id, run_id, codex_request_id, kind, request_json, status, created_at) VALUES (?, ?, 'old-request', 'command', '{}', 'pending', ?)").run(approval, run, now);
    database.prepare("INSERT INTO notifications (id, kind, title, body, entity_type, entity_id, created_at) VALUES (?, 'approval', 'Approval', '', 'approval', ?, ?)").run(notification, approval, now);
    removeLifecycleMigration(database);
    dropAttachmentLinkColumns(database);
    dropSystemNotificationColumn(database);
    dropCoordinationRevisionMigration(database);
    dropProjectTaskSequence(database);
    dropDeliveryMigration(database);
    database.exec("DROP TRIGGER approvals_resolve_notifications; DROP TRIGGER runs_expire_pending_approvals; ALTER TABLE comments DROP COLUMN deleted_at; DROP INDEX comments_run_created; DROP INDEX comments_task_parent_created; ALTER TABLE comments DROP COLUMN run_id; ALTER TABLE comments DROP COLUMN parent_id; ALTER TABLE tasks DROP COLUMN auto_approve_permissions; ALTER TABLE commissions DROP COLUMN archive_size_bytes; ALTER TABLE commissions DROP COLUMN archive_sha256; ALTER TABLE commissions DROP COLUMN archive_path; ALTER TABLE commissions DROP COLUMN clarification_token_cached; ALTER TABLE commissions DROP COLUMN clarification_token_output; ALTER TABLE commissions DROP COLUMN clarification_token_input; PRAGMA user_version = 7");
    database.close();
    database = await openWorkshopDatabase(home);
    assert.equal((database.prepare("SELECT status FROM approvals WHERE id = ?").get(approval) as { status: string }).status, "expired");
    assert.ok((database.prepare("SELECT read_at FROM notifications WHERE id = ?").get(notification) as { read_at: string | null }).read_at);
  } finally {
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("migration keeps only the newest pending requirement candidate", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-pending-migration-"));
  try {
    const database = await openWorkshopDatabase(home);
    const rootId = randomUUID();
    const projectId = randomUUID();
    const commissionId = randomUUID();
    const now = new Date().toISOString();
    database.exec("DROP INDEX requirement_versions_one_pending");
    database.prepare("INSERT INTO root_paths (id, path, real_path, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)").run(rootId, "root", `root-${rootId}`, now, now);
    database.prepare("INSERT INTO projects (id, name, path, real_path, root_path_id, vcs_type, created_at, updated_at) VALUES (?, 'Project', ?, ?, ?, 'none', ?, ?)").run(projectId, `project-${projectId}`, `project-${projectId}`, rootId, now, now);
    database.prepare("INSERT INTO commissions (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, 'Commission', 'awaiting_requirement_approval', ?, ?)").run(commissionId, projectId, now, now);
    const insert = database.prepare("INSERT INTO requirement_versions (id, commission_id, version_no, content_markdown, acceptance_json, status, created_by, created_at) VALUES (?, ?, ?, 'Requirement', '[]', 'awaiting_approval', 'requirement_agent', ?)");
    insert.run(randomUUID(), commissionId, 1, now);
    insert.run(randomUUID(), commissionId, 2, now);
    removeLifecycleMigration(database);
    dropAttachmentLinkColumns(database);
    dropSystemNotificationColumn(database);
    dropCoordinationRevisionMigration(database);
    dropProjectTaskSequence(database);
    dropDeliveryMigration(database);
    database.exec("DROP TRIGGER approvals_resolve_notifications; DROP TRIGGER runs_expire_pending_approvals; ALTER TABLE comments DROP COLUMN deleted_at; DROP INDEX comments_run_created; DROP INDEX comments_task_parent_created; ALTER TABLE comments DROP COLUMN run_id; ALTER TABLE comments DROP COLUMN parent_id; ALTER TABLE requirement_messages DROP COLUMN options_json; DROP INDEX runs_one_reserved_per_task; ALTER TABLE runs DROP COLUMN workspace_mode; ALTER TABLE runs DROP COLUMN workspace_path; ALTER TABLE runs DROP COLUMN retry_root_run_id; ALTER TABLE runs DROP COLUMN execution_grant_id; ALTER TABLE tasks DROP COLUMN auto_approve_permissions; ALTER TABLE tasks DROP COLUMN read_only; ALTER TABLE commissions DROP COLUMN archive_size_bytes; ALTER TABLE commissions DROP COLUMN archive_sha256; ALTER TABLE commissions DROP COLUMN archive_path; ALTER TABLE commissions DROP COLUMN clarification_token_cached; ALTER TABLE commissions DROP COLUMN clarification_token_output; ALTER TABLE commissions DROP COLUMN clarification_token_input; PRAGMA user_version = 2");
    database.close();

    const migrated = await openWorkshopDatabase(home);
    const versions = migrated.prepare("SELECT version_no, status FROM requirement_versions WHERE commission_id = ? ORDER BY version_no").all(commissionId) as Array<{ version_no: number; status: string }>;
    assert.deepEqual(versions.map((version) => [version.version_no, version.status]), [[1, "rejected"], [2, "awaiting_approval"]]);
    assert.equal((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 28);
    migrated.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("v2 migration restores a historical pending candidate for approval", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-v2-pending-"));
  let database = await openWorkshopDatabase(home);
  const { commissionId, requirementId } = seedHistoricalPending(database);
  removeLifecycleMigration(database);
  dropAttachmentLinkColumns(database);
  dropSystemNotificationColumn(database);
  dropCoordinationRevisionMigration(database);
  dropProjectTaskSequence(database);
  dropDeliveryMigration(database);
  database.exec("DROP TRIGGER approvals_resolve_notifications; DROP TRIGGER runs_expire_pending_approvals; ALTER TABLE comments DROP COLUMN deleted_at; DROP INDEX comments_run_created; DROP INDEX comments_task_parent_created; ALTER TABLE comments DROP COLUMN run_id; ALTER TABLE comments DROP COLUMN parent_id; ALTER TABLE requirement_messages DROP COLUMN options_json; DROP INDEX requirement_versions_one_pending; DROP INDEX runs_one_reserved_per_task; ALTER TABLE runs DROP COLUMN workspace_mode; ALTER TABLE runs DROP COLUMN workspace_path; ALTER TABLE runs DROP COLUMN retry_root_run_id; ALTER TABLE runs DROP COLUMN execution_grant_id; ALTER TABLE tasks DROP COLUMN auto_approve_permissions; ALTER TABLE tasks DROP COLUMN read_only; ALTER TABLE commissions DROP COLUMN archive_size_bytes; ALTER TABLE commissions DROP COLUMN archive_sha256; ALTER TABLE commissions DROP COLUMN archive_path; ALTER TABLE commissions DROP COLUMN clarification_token_cached; ALTER TABLE commissions DROP COLUMN clarification_token_output; ALTER TABLE commissions DROP COLUMN clarification_token_input; PRAGMA user_version = 2");
  database.close();

  const server = Fastify();
  try {
    database = await openWorkshopDatabase(home);
    registerCommissionRoutes(server, database, join(home, "attachments"));
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 28);
    assert.equal((database.prepare("SELECT status FROM commissions WHERE id = ?").get(commissionId) as { status: string }).status, "awaiting_requirement_approval");
    assert.equal((await server.inject({ method: "POST", url: `/api/requirements/${requirementId}/approve` })).statusCode, 200);
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("v3 migration restores a historical pending candidate for rejection", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-v3-pending-"));
  let database = await openWorkshopDatabase(home);
  const { commissionId, requirementId } = seedHistoricalPending(database);
  removeLifecycleMigration(database);
  dropAttachmentLinkColumns(database);
  dropSystemNotificationColumn(database);
  dropCoordinationRevisionMigration(database);
  dropProjectTaskSequence(database);
  dropDeliveryMigration(database);
  database.exec("DROP TRIGGER approvals_resolve_notifications; DROP TRIGGER runs_expire_pending_approvals; ALTER TABLE comments DROP COLUMN deleted_at; DROP INDEX comments_run_created; DROP INDEX comments_task_parent_created; ALTER TABLE comments DROP COLUMN run_id; ALTER TABLE comments DROP COLUMN parent_id; ALTER TABLE requirement_messages DROP COLUMN options_json; DROP INDEX runs_one_reserved_per_task; ALTER TABLE runs DROP COLUMN workspace_mode; ALTER TABLE runs DROP COLUMN workspace_path; ALTER TABLE runs DROP COLUMN retry_root_run_id; ALTER TABLE runs DROP COLUMN execution_grant_id; ALTER TABLE tasks DROP COLUMN auto_approve_permissions; ALTER TABLE tasks DROP COLUMN read_only; ALTER TABLE commissions DROP COLUMN archive_size_bytes; ALTER TABLE commissions DROP COLUMN archive_sha256; ALTER TABLE commissions DROP COLUMN archive_path; ALTER TABLE commissions DROP COLUMN clarification_token_cached; ALTER TABLE commissions DROP COLUMN clarification_token_output; ALTER TABLE commissions DROP COLUMN clarification_token_input; PRAGMA user_version = 3");
  database.close();

  const server = Fastify();
  try {
    database = await openWorkshopDatabase(home);
    registerCommissionRoutes(server, database, join(home, "attachments"));
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 28);
    assert.equal((database.prepare("SELECT status FROM commissions WHERE id = ?").get(commissionId) as { status: string }).status, "awaiting_requirement_approval");
    assert.equal((await server.inject({ method: "POST", url: `/api/requirements/${requirementId}/reject`, payload: { reason: "Not ready" } })).statusCode, 200);
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

function removeLifecycleMigration(database: DatabaseSync): void {
  database.exec("DROP TRIGGER IF EXISTS task_dependencies_revision_delete; DROP TRIGGER IF EXISTS task_dependencies_revision_insert; DROP TRIGGER IF EXISTS tasks_structure_revision_update; DROP TRIGGER IF EXISTS tasks_structure_revision_insert");
  const triggers = database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_lifecycle_%'").all() as Array<{ name: string }>;
  for (const { name } of triggers) database.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  database.exec("ALTER TABLE commissions DROP COLUMN lifecycle_token; ALTER TABLE commissions DROP COLUMN lifecycle_operation");
}

function dropDeliveryMigration(database: DatabaseSync): void {
  database.exec("DROP TRIGGER IF EXISTS notifications_lifecycle_insert; DROP TRIGGER IF EXISTS notifications_lifecycle_update; DROP TRIGGER IF EXISTS notifications_lifecycle_delete; DROP INDEX IF EXISTS evidence_one_diff_per_run; DROP TABLE IF EXISTS delivery_attempts; DROP TABLE IF EXISTS deliveries; ALTER TABLE runs DROP COLUMN workspace_baseline_json");
}

function seedHistoricalPending(database: DatabaseSync): { commissionId: string; requirementId: string } {
  const rootId = randomUUID();
  const projectId = randomUUID();
  const commissionId = randomUUID();
  const requirementId = randomUUID();
  const now = new Date().toISOString();
  database.prepare("INSERT INTO root_paths (id, path, real_path, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)").run(rootId, "root", `root-${rootId}`, now, now);
  database.prepare("INSERT INTO projects (id, name, path, real_path, root_path_id, vcs_type, created_at, updated_at) VALUES (?, 'Project', ?, ?, ?, 'none', ?, ?)").run(projectId, `project-${projectId}`, `project-${projectId}`, rootId, now, now);
  database.prepare("INSERT INTO commissions (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, 'Commission', 'clarifying', ?, ?)").run(commissionId, projectId, now, now);
  database.prepare("INSERT INTO requirement_versions (id, commission_id, version_no, content_markdown, acceptance_json, status, created_by, created_at) VALUES (?, ?, 1, 'Requirement', '[]', 'awaiting_approval', 'requirement_agent', ?)").run(requirementId, commissionId, now);
  return { commissionId, requirementId };
}
