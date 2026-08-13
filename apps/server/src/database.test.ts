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

test("migrates a temporary database and stores JSON settings", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-db-"));
  try {
    const database = await openWorkshopDatabase(home);
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 18);
    assert.equal((database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
    assert.equal((database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => (row as { name: string }).name);
    assert.ok(["settings", "projects", "commissions", "tasks", "runs", "documents"].every((table) => tables.includes(table)));
    assert.match((database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approvals'").get() as { sql: string }).sql, /mcp_tool_call/);
    const commissionColumns = database.prepare("PRAGMA table_info(commissions)").all().map((row) => (row as { name: string }).name);
    assert.ok(["clarification_token_input", "clarification_token_output", "clarification_token_cached", "archive_path", "archive_sha256", "archive_size_bytes", "lifecycle_operation", "lifecycle_token"].every((column) => commissionColumns.includes(column)));
    assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'comments_lifecycle_insert'").get());
    const attachmentColumns = database.prepare("PRAGMA table_info(attachments)").all().map((row) => (row as { name: string }).name);
    assert.ok(["task_id", "comment_id", "run_id"].every((column) => attachmentColumns.includes(column)));

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
    database.exec("DROP TRIGGER approvals_resolve_notifications; DROP TRIGGER runs_expire_pending_approvals; ALTER TABLE comments DROP COLUMN deleted_at; DROP INDEX comments_run_created; DROP INDEX comments_task_parent_created; ALTER TABLE comments DROP COLUMN run_id; ALTER TABLE comments DROP COLUMN parent_id; ALTER TABLE requirement_messages DROP COLUMN options_json; DROP INDEX runs_one_reserved_per_task; ALTER TABLE runs DROP COLUMN workspace_mode; ALTER TABLE runs DROP COLUMN workspace_path; ALTER TABLE runs DROP COLUMN retry_root_run_id; ALTER TABLE runs DROP COLUMN execution_grant_id; ALTER TABLE tasks DROP COLUMN auto_approve_permissions; ALTER TABLE tasks DROP COLUMN read_only; ALTER TABLE commissions DROP COLUMN archive_size_bytes; ALTER TABLE commissions DROP COLUMN archive_sha256; ALTER TABLE commissions DROP COLUMN archive_path; ALTER TABLE commissions DROP COLUMN clarification_token_cached; ALTER TABLE commissions DROP COLUMN clarification_token_output; ALTER TABLE commissions DROP COLUMN clarification_token_input; PRAGMA user_version = 2");
    database.close();

    const migrated = await openWorkshopDatabase(home);
    const versions = migrated.prepare("SELECT version_no, status FROM requirement_versions WHERE commission_id = ? ORDER BY version_no").all(commissionId) as Array<{ version_no: number; status: string }>;
    assert.deepEqual(versions.map((version) => [version.version_no, version.status]), [[1, "rejected"], [2, "awaiting_approval"]]);
    assert.equal((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 18);
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
  database.exec("DROP TRIGGER approvals_resolve_notifications; DROP TRIGGER runs_expire_pending_approvals; ALTER TABLE comments DROP COLUMN deleted_at; DROP INDEX comments_run_created; DROP INDEX comments_task_parent_created; ALTER TABLE comments DROP COLUMN run_id; ALTER TABLE comments DROP COLUMN parent_id; ALTER TABLE requirement_messages DROP COLUMN options_json; DROP INDEX requirement_versions_one_pending; DROP INDEX runs_one_reserved_per_task; ALTER TABLE runs DROP COLUMN workspace_mode; ALTER TABLE runs DROP COLUMN workspace_path; ALTER TABLE runs DROP COLUMN retry_root_run_id; ALTER TABLE runs DROP COLUMN execution_grant_id; ALTER TABLE tasks DROP COLUMN auto_approve_permissions; ALTER TABLE tasks DROP COLUMN read_only; ALTER TABLE commissions DROP COLUMN archive_size_bytes; ALTER TABLE commissions DROP COLUMN archive_sha256; ALTER TABLE commissions DROP COLUMN archive_path; ALTER TABLE commissions DROP COLUMN clarification_token_cached; ALTER TABLE commissions DROP COLUMN clarification_token_output; ALTER TABLE commissions DROP COLUMN clarification_token_input; PRAGMA user_version = 2");
  database.close();

  const server = Fastify();
  try {
    database = await openWorkshopDatabase(home);
    registerCommissionRoutes(server, database, join(home, "attachments"));
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 18);
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
  database.exec("DROP TRIGGER approvals_resolve_notifications; DROP TRIGGER runs_expire_pending_approvals; ALTER TABLE comments DROP COLUMN deleted_at; DROP INDEX comments_run_created; DROP INDEX comments_task_parent_created; ALTER TABLE comments DROP COLUMN run_id; ALTER TABLE comments DROP COLUMN parent_id; ALTER TABLE requirement_messages DROP COLUMN options_json; DROP INDEX runs_one_reserved_per_task; ALTER TABLE runs DROP COLUMN workspace_mode; ALTER TABLE runs DROP COLUMN workspace_path; ALTER TABLE runs DROP COLUMN retry_root_run_id; ALTER TABLE runs DROP COLUMN execution_grant_id; ALTER TABLE tasks DROP COLUMN auto_approve_permissions; ALTER TABLE tasks DROP COLUMN read_only; ALTER TABLE commissions DROP COLUMN archive_size_bytes; ALTER TABLE commissions DROP COLUMN archive_sha256; ALTER TABLE commissions DROP COLUMN archive_path; ALTER TABLE commissions DROP COLUMN clarification_token_cached; ALTER TABLE commissions DROP COLUMN clarification_token_output; ALTER TABLE commissions DROP COLUMN clarification_token_input; PRAGMA user_version = 3");
  database.close();

  const server = Fastify();
  try {
    database = await openWorkshopDatabase(home);
    registerCommissionRoutes(server, database, join(home, "attachments"));
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 18);
    assert.equal((database.prepare("SELECT status FROM commissions WHERE id = ?").get(commissionId) as { status: string }).status, "awaiting_requirement_approval");
    assert.equal((await server.inject({ method: "POST", url: `/api/requirements/${requirementId}/reject`, payload: { reason: "Not ready" } })).statusCode, 200);
  } finally {
    await server.close();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

function removeLifecycleMigration(database: DatabaseSync): void {
  const triggers = database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_lifecycle_%'").all() as Array<{ name: string }>;
  for (const { name } of triggers) database.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  database.exec("ALTER TABLE commissions DROP COLUMN lifecycle_token; ALTER TABLE commissions DROP COLUMN lifecycle_operation");
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
