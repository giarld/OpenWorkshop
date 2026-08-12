import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { promisify } from "node:util";
import { gzip as gzipCallback, gunzip as gunzipCallback } from "node:zlib";

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);
const ACTIVE_RUN_STATUSES = ["queued", "preparing", "running", "waiting_approval", "waiting_input"];

type Row = Record<string, SQLInputValue>;
type AttachmentFile = { id: string; file: string; codec: "gzip" | "raw" };
type ArchiveSnapshot = {
  version: 1;
  commission: Row;
  attachmentFiles: AttachmentFile[];
  tables: {
    requirementVersions: Row[];
    requirementMessages: Row[];
    attachments: Row[];
    tasks: Row[];
    taskDependencies: Row[];
    taskLabels: Row[];
    comments: Row[];
    executionGrants: Row[];
    runs: Row[];
    runEvents: Row[];
    approvals: Row[];
    evidence: Row[];
    documents: Row[];
    documentVersions: Row[];
    notifications: Row[];
  };
};

export async function recoverCommissionLifecycleOperations(database: DatabaseSync, attachmentsRoot: string): Promise<string[]> {
  const claims = database.prepare("SELECT id, lifecycle_operation, archive_path, archive_sha256 FROM commissions WHERE lifecycle_operation IS NOT NULL ORDER BY rowid")
    .all() as Array<{ id: string; lifecycle_operation: "archiving" | "reactivating"; archive_path: string | null; archive_sha256: string | null }>;
  const recovered: string[] = [];
  const archiveRoot = join(dirname(attachmentsRoot), "archives");
  for (const claim of claims) {
    if (claim.lifecycle_operation === "archiving") {
      await removeMatchingDirectories(archiveRoot, (name) => name === claim.id || name.startsWith(`${claim.id}.`) && name.endsWith(".tmp"));
    } else {
      await removeMatchingDirectories(attachmentsRoot, (name) => name.startsWith(`.${claim.id}.`) && name.endsWith(".restore"));
      if (await validCommissionArchive(archiveRoot, claim)) await rm(safeChild(attachmentsRoot, claim.id), { recursive: true, force: true });
    }
    database.prepare("UPDATE commissions SET lifecycle_operation = NULL, lifecycle_token = NULL WHERE id = ? AND lifecycle_operation = ?")
      .run(claim.id, claim.lifecycle_operation);
    recovered.push(claim.id);
  }
  return recovered;
}

export async function archiveCommission(database: DatabaseSync, attachmentsRoot: string, commissionId: string): Promise<Row> {
  const lifecycleToken = randomUUID();
  const commission = claimArchive(database, commissionId, lifecycleToken);

  const archiveRoot = join(dirname(attachmentsRoot), "archives");
  const archivePath = safeChild(archiveRoot, commissionId);
  const temporaryPath = safeChild(archiveRoot, `${commissionId}.${randomUUID()}.tmp`);
  let snapshot: ArchiveSnapshot;
  let archiveCreated = false;
  try {
    await mkdir(archiveRoot, { recursive: true });
    if (await stat(archivePath).catch(() => undefined)) throw conflict("Commission archive already exists");
    await mkdir(temporaryPath);
    snapshot = snapshotCommission(database, commission);
    snapshot.attachmentFiles = await writeArchivedAttachments(snapshot.tables.attachments, temporaryPath);
    const metadata = await gzip(Buffer.from(JSON.stringify(snapshot), "utf8"));
    await writeFile(join(temporaryPath, "metadata.json.gz"), metadata, { flag: "wx" });
    await rename(temporaryPath, archivePath);
    archiveCreated = true;
    const archiveSize = await directorySize(archivePath, snapshot);

    const now = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const claimed = database.prepare(`UPDATE commissions SET status = 'archived', lifecycle_operation = NULL, lifecycle_token = NULL,
        active_requirement_version_id = NULL, main_task_id = NULL, archived_at = ?, updated_at = ?, archive_path = ?, archive_sha256 = ?, archive_size_bytes = ?
        WHERE id = ? AND lifecycle_operation = 'archiving' AND lifecycle_token = ?`)
        .run(now, now, archivePath, sha256(metadata), archiveSize, commissionId, lifecycleToken);
      if (!claimed.changes) throw conflict("Commission archive operation was not claimed");
      clearCommissionRows(database, commissionId, snapshot.tables.notifications);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true });
    if (archiveCreated) await rm(archivePath, { recursive: true, force: true });
    releaseLifecycleClaim(database, commissionId, lifecycleToken);
    throw error;
  }

  try { await rm(safeChild(attachmentsRoot, commissionId), { recursive: true, force: true }); } catch { /* The archive remains valid; stale source files can be retried by maintenance. */ }
  try { database.exec("VACUUM"); } catch { /* SQLite can reuse freed pages even if compaction is temporarily unavailable. */ }
  return commissionRow(database, commissionId);
}

export async function reactivateCommission(database: DatabaseSync, attachmentsRoot: string, commissionId: string): Promise<Row> {
  const lifecycleToken = randomUUID();
  const commission = claimReactivation(database, commissionId, lifecycleToken);
  const archiveRoot = join(dirname(attachmentsRoot), "archives");
  const archivePath = safeChild(archiveRoot, commissionId);
  const restoredPath = safeChild(attachmentsRoot, commissionId);
  const temporaryPath = safeChild(attachmentsRoot, `.${commissionId}.${randomUUID()}.restore`);
  let restoredCreated = false;
  try {
    if (resolve(String(commission.archive_path)) !== resolve(archivePath)) throw conflict("Commission archive path is invalid");
    const metadata = await readFile(join(archivePath, "metadata.json.gz")).catch((error: unknown) => {
      throw conflict("Commission archive is missing", error);
    });
    if (sha256(metadata) !== commission.archive_sha256) throw conflict("Commission archive integrity check failed");
    const snapshot = parseSnapshot(await gunzip(metadata), commissionId);
    const originalStatus = requiredSnapshotString(snapshot.commission.status, "commission.status");
    if (originalStatus === "active" && database.prepare("SELECT 1 FROM commissions WHERE project_id = ? AND status = 'active' AND id <> ?").get(sqlValue(commission, "project_id"), commissionId)) {
      throw conflict("Another commission is already active for this project");
    }
    await mkdir(attachmentsRoot, { recursive: true });
    await mkdir(temporaryPath);
    await restoreAttachments(snapshot, archivePath, temporaryPath, attachmentsRoot, commissionId);
    await rm(restoredPath, { recursive: true, force: true });
    await rename(temporaryPath, restoredPath);
    restoredCreated = true;

    database.exec("BEGIN IMMEDIATE");
    try {
      const claimed = database.prepare(`UPDATE commissions SET lifecycle_operation = NULL, lifecycle_token = NULL
        WHERE id = ? AND lifecycle_operation = 'reactivating' AND lifecycle_token = ?`).run(commissionId, lifecycleToken);
      if (!claimed.changes) throw conflict("Commission reactivation operation was not claimed");
      restoreCommissionRows(database, snapshot, attachmentsRoot, commissionId);
      database.prepare(`UPDATE commissions SET status = ?, active_requirement_version_id = ?, main_task_id = ?, archived_at = NULL,
        updated_at = ?, archive_path = NULL, archive_sha256 = NULL, archive_size_bytes = NULL WHERE id = ?`)
        .run(originalStatus, snapshot.commission.active_requirement_version_id ?? null, snapshot.commission.main_task_id ?? null, new Date().toISOString(), commissionId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true });
    if (restoredCreated) await rm(restoredPath, { recursive: true, force: true });
    releaseLifecycleClaim(database, commissionId, lifecycleToken);
    throw error;
  }

  try { await rm(archivePath, { recursive: true, force: true }); } catch { /* Reactivation is committed; a duplicate archive is safe to clean later. */ }
  return commissionRow(database, commissionId);
}

export async function deleteClarifyingCommission(database: DatabaseSync, attachmentsRoot: string, commissionId: string): Promise<void> {
  const commission = commissionRow(database, commissionId);
  if (commission.archived_at || !["draft", "clarifying"].includes(String(commission.status))) throw conflict("Only a commission in clarification can be deleted");
  assertNoActiveRuns(database, commissionId);
  const snapshot = snapshotCommission(database, commission);
  database.exec("BEGIN IMMEDIATE");
  try {
    clearCommissionRows(database, commissionId, snapshot.tables.notifications);
    database.prepare("DELETE FROM commissions WHERE id = ?").run(commissionId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  try { await rm(safeChild(attachmentsRoot, commissionId), { recursive: true, force: true }); } catch { /* The database record is deleted; stale files can be cleaned later. */ }
}

function snapshotCommission(database: DatabaseSync, commission: Row): ArchiveSnapshot {
  const commissionId = String(commission.id);
  const tasks = rows(database, "SELECT * FROM tasks WHERE commission_id = ? ORDER BY rowid", commissionId);
  const taskIds = ids(tasks);
  const runs = rows(database, "SELECT * FROM runs WHERE commission_id = ? ORDER BY rowid", commissionId);
  const runIds = ids(runs);
  const approvals = selectBy(database, "approvals", "run_id", runIds);
  const documents = rows(database, "SELECT * FROM documents WHERE commission_id = ? ORDER BY rowid", commissionId);
  const requirementVersions = rows(database, "SELECT * FROM requirement_versions WHERE commission_id = ? ORDER BY rowid", commissionId);
  const entityIds = [commissionId, ...taskIds, ...runIds, ...ids(approvals), ...ids(documents), ...ids(requirementVersions)];
  return {
    version: 1,
    commission,
    attachmentFiles: [],
    tables: {
      requirementVersions,
      requirementMessages: rows(database, "SELECT * FROM requirement_messages WHERE commission_id = ? ORDER BY rowid", commissionId),
      attachments: rows(database, "SELECT * FROM attachments WHERE commission_id = ? ORDER BY rowid", commissionId),
      tasks,
      taskDependencies: taskIds.length ? rows(database, `SELECT * FROM task_dependencies WHERE task_id IN (${taskIds.map(() => "?").join(", ")}) OR depends_on_task_id IN (${taskIds.map(() => "?").join(", ")}) ORDER BY rowid`, ...taskIds, ...taskIds) : [],
      taskLabels: selectBy(database, "task_labels", "task_id", taskIds),
      comments: selectBy(database, "comments", "task_id", taskIds),
      executionGrants: rows(database, "SELECT * FROM execution_grants WHERE commission_id = ? ORDER BY rowid", commissionId),
      runs,
      runEvents: selectBy(database, "run_events", "run_id", runIds),
      approvals,
      evidence: selectBy(database, "evidence", "task_id", taskIds),
      documents,
      documentVersions: selectBy(database, "document_versions", "document_id", ids(documents)),
      notifications: selectBy(database, "notifications", "entity_id", entityIds)
    }
  };
}

async function writeArchivedAttachments(attachments: Row[], archivePath: string): Promise<AttachmentFile[]> {
  const files: AttachmentFile[] = [];
  for (const attachment of attachments) {
    const id = requiredSnapshotString(attachment.id, "attachment.id");
    const data = await readFile(requiredSnapshotString(attachment.storage_path, "attachment.storage_path"));
    if (sha256(data) !== attachment.sha256) throw conflict(`Attachment integrity check failed: ${String(attachment.original_name)}`);
    const compressed = await gzip(data);
    const useGzip = compressed.length < data.length;
    const file = `${id}.${useGzip ? "gz" : "bin"}`;
    await writeFile(join(archivePath, file), useGzip ? compressed : data, { flag: "wx" });
    files.push({ id, file, codec: useGzip ? "gzip" : "raw" });
  }
  return files;
}

async function restoreAttachments(snapshot: ArchiveSnapshot, archivePath: string, temporaryPath: string, attachmentsRoot: string, commissionId: string): Promise<void> {
  const files = new Map(snapshot.attachmentFiles.map((file) => [file.id, file]));
  for (const attachment of snapshot.tables.attachments) {
    const id = requiredSnapshotString(attachment.id, "attachment.id");
    const archived = files.get(id);
    if (!archived) throw conflict(`Archived attachment is missing: ${String(attachment.original_name)}`);
    const stored = await readFile(join(archivePath, archived.file));
    const data = archived.codec === "gzip" ? await gunzip(stored) : stored;
    if (sha256(data) !== attachment.sha256) throw conflict(`Archived attachment integrity check failed: ${String(attachment.original_name)}`);
    await writeFile(join(temporaryPath, id), data, { flag: "wx" });
    attachment.storage_path = join(attachmentsRoot, commissionId, id);
  }
}

function clearCommissionRows(database: DatabaseSync, commissionId: string, notifications: Row[]): void {
  database.prepare("UPDATE commissions SET active_requirement_version_id = NULL, main_task_id = NULL WHERE id = ?").run(commissionId);
  deleteByIds(database, "notifications", ids(notifications));
  database.prepare("DELETE FROM approvals WHERE run_id IN (SELECT id FROM runs WHERE commission_id = ?)").run(commissionId);
  database.prepare("DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE commission_id = ?)").run(commissionId);
  database.prepare("DELETE FROM evidence WHERE task_id IN (SELECT id FROM tasks WHERE commission_id = ?)").run(commissionId);
  database.prepare("DELETE FROM comments WHERE task_id IN (SELECT id FROM tasks WHERE commission_id = ?)").run(commissionId);
  database.prepare("DELETE FROM task_labels WHERE task_id IN (SELECT id FROM tasks WHERE commission_id = ?)").run(commissionId);
  database.prepare("DELETE FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE commission_id = ?) OR depends_on_task_id IN (SELECT id FROM tasks WHERE commission_id = ?)").run(commissionId, commissionId);
  database.prepare("DELETE FROM runs WHERE commission_id = ?").run(commissionId);
  database.prepare("DELETE FROM execution_grants WHERE commission_id = ?").run(commissionId);
  database.prepare("UPDATE documents SET current_version_id = NULL WHERE commission_id = ?").run(commissionId);
  database.prepare("DELETE FROM document_versions WHERE document_id IN (SELECT id FROM documents WHERE commission_id = ?)").run(commissionId);
  database.prepare("DELETE FROM documents WHERE commission_id = ?").run(commissionId);
  database.prepare("DELETE FROM attachments WHERE commission_id = ?").run(commissionId);
  database.prepare("DELETE FROM tasks WHERE commission_id = ?").run(commissionId);
  database.prepare("DELETE FROM requirement_messages WHERE commission_id = ?").run(commissionId);
  database.prepare("DELETE FROM requirement_versions WHERE commission_id = ?").run(commissionId);
}

function restoreCommissionRows(database: DatabaseSync, snapshot: ArchiveSnapshot, attachmentsRoot: string, commissionId: string): void {
  const tables = snapshot.tables;
  insertRows(database, "requirement_versions", tables.requirementVersions);
  insertRows(database, "requirement_messages", tables.requirementMessages);
  if (tables.tasks.length) {
    database.prepare("UPDATE commissions SET status = 'planned', active_requirement_version_id = ? WHERE id = ?")
      .run(snapshot.commission.active_requirement_version_id ?? null, commissionId);
  }
  insertRows(database, "tasks", tables.tasks.map((row) => ({ ...row, parent_id: null })));
  for (const row of tables.tasks) if (row.parent_id) database.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(sqlValue(row, "parent_id"), sqlValue(row, "id"));
  insertRows(database, "attachments", tables.attachments.map((row) => ({ ...row, storage_path: join(attachmentsRoot, commissionId, String(row.id)), comment_id: null, run_id: null })));
  insertRows(database, "task_dependencies", tables.taskDependencies);
  insertRows(database, "task_labels", tables.taskLabels);
  insertRows(database, "execution_grants", tables.executionGrants);
  insertRows(database, "runs", tables.runs.map((row) => ({ ...row, retry_root_run_id: null })));
  for (const row of tables.runs) if (row.retry_root_run_id) database.prepare("UPDATE runs SET retry_root_run_id = ? WHERE id = ?").run(sqlValue(row, "retry_root_run_id"), sqlValue(row, "id"));
  insertRows(database, "comments", tables.comments.map((row) => ({ ...row, parent_id: null })));
  for (const row of tables.comments) if (row.parent_id) database.prepare("UPDATE comments SET parent_id = ? WHERE id = ?").run(sqlValue(row, "parent_id"), sqlValue(row, "id"));
  for (const row of tables.attachments) database.prepare("UPDATE attachments SET comment_id = ?, run_id = ? WHERE id = ?").run(row.comment_id ?? null, row.run_id ?? null, sqlValue(row, "id"));
  insertRows(database, "run_events", tables.runEvents);
  insertRows(database, "approvals", tables.approvals);
  insertRows(database, "evidence", tables.evidence);
  insertRows(database, "documents", tables.documents.map((row) => ({ ...row, current_version_id: null })));
  insertRows(database, "document_versions", tables.documentVersions);
  for (const row of tables.documents) if (row.current_version_id) database.prepare("UPDATE documents SET current_version_id = ? WHERE id = ?").run(sqlValue(row, "current_version_id"), sqlValue(row, "id"));
  insertRows(database, "notifications", tables.notifications);
}

function insertRows(database: DatabaseSync, table: string, values: Row[]): void {
  for (const row of values) {
    const columns = Object.keys(row);
    const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
    database.prepare(sql).run(...columns.map((column) => row[column] ?? null));
  }
}

function selectBy(database: DatabaseSync, table: string, column: string, values: string[]): Row[] {
  if (!values.length) return [];
  return rows(database, `SELECT * FROM ${table} WHERE ${column} IN (${values.map(() => "?").join(", ")}) ORDER BY rowid`, ...values);
}

function deleteByIds(database: DatabaseSync, table: string, values: string[]): void {
  if (values.length) database.prepare(`DELETE FROM ${table} WHERE id IN (${values.map(() => "?").join(", ")})`).run(...values);
}

function rows(database: DatabaseSync, sql: string, ...parameters: SQLInputValue[]): Row[] {
  return database.prepare(sql).all(...parameters) as Row[];
}

function sqlValue(row: Row, column: string): SQLInputValue {
  return row[column] ?? null;
}

function ids(values: Row[]): string[] {
  return values.map((row) => String(row.id));
}

function commissionRow(database: DatabaseSync, id: string): Row {
  const commission = database.prepare("SELECT * FROM commissions WHERE id = ?").get(id) as Row | undefined;
  if (!commission) throw notFound("Commission not found");
  return commission;
}

function claimArchive(database: DatabaseSync, commissionId: string, lifecycleToken: string): Row {
  database.exec("BEGIN IMMEDIATE");
  try {
    const commission = commissionRow(database, commissionId);
    if (commission.lifecycle_operation) throw conflict("Commission lifecycle operation is already in progress");
    if (commission.archived_at || commission.status === "archived") throw conflict("Commission is already archived");
    if (["draft", "clarifying"].includes(String(commission.status))) throw conflict("Commission clarification is not complete");
    assertNoActiveRuns(database, commissionId);
    assertNoCrossCommissionDependencies(database, commissionId);
    const claimed = database.prepare("UPDATE commissions SET lifecycle_operation = 'archiving', lifecycle_token = ? WHERE id = ? AND lifecycle_operation IS NULL")
      .run(lifecycleToken, commissionId);
    if (!claimed.changes) throw conflict("Commission lifecycle operation is already in progress");
    database.exec("COMMIT");
    return commission;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function claimReactivation(database: DatabaseSync, commissionId: string, lifecycleToken: string): Row {
  database.exec("BEGIN IMMEDIATE");
  try {
    const commission = commissionRow(database, commissionId);
    if (commission.lifecycle_operation) throw conflict("Commission lifecycle operation is already in progress");
    if (!commission.archived_at || commission.status !== "archived") throw conflict("Commission is not archived");
    const claimed = database.prepare("UPDATE commissions SET lifecycle_operation = 'reactivating', lifecycle_token = ? WHERE id = ? AND lifecycle_operation IS NULL")
      .run(lifecycleToken, commissionId);
    if (!claimed.changes) throw conflict("Commission lifecycle operation is already in progress");
    database.exec("COMMIT");
    return commission;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function releaseLifecycleClaim(database: DatabaseSync, commissionId: string, lifecycleToken: string): void {
  database.prepare("UPDATE commissions SET lifecycle_operation = NULL, lifecycle_token = NULL WHERE id = ? AND lifecycle_token = ?")
    .run(commissionId, lifecycleToken);
}

function assertNoActiveRuns(database: DatabaseSync, commissionId: string): void {
  const placeholders = ACTIVE_RUN_STATUSES.map(() => "?").join(", ");
  if (database.prepare(`SELECT 1 FROM runs WHERE commission_id = ? AND status IN (${placeholders}) LIMIT 1`).get(commissionId, ...ACTIVE_RUN_STATUSES)) {
    throw conflict("Commission has an active run");
  }
}

function assertNoCrossCommissionDependencies(database: DatabaseSync, commissionId: string): void {
  if (database.prepare(`SELECT 1 FROM task_dependencies AS dependency
    JOIN tasks AS task ON task.id = dependency.task_id
    JOIN tasks AS required ON required.id = dependency.depends_on_task_id
    WHERE (task.commission_id = ? AND required.commission_id <> ?)
       OR (required.commission_id = ? AND task.commission_id <> ?)
    LIMIT 1`).get(commissionId, commissionId, commissionId, commissionId)) {
    throw conflict("Commission has cross-commission task dependencies");
  }
}

function parseSnapshot(data: Buffer, commissionId: string): ArchiveSnapshot {
  let snapshot: unknown;
  try { snapshot = JSON.parse(data.toString("utf8")); } catch (error) { throw conflict("Commission archive metadata is invalid", error); }
  if (!snapshot || typeof snapshot !== "object" || (snapshot as ArchiveSnapshot).version !== 1 || String((snapshot as ArchiveSnapshot).commission?.id) !== commissionId) {
    throw conflict("Commission archive metadata is invalid");
  }
  return snapshot as ArchiveSnapshot;
}

function requiredSnapshotString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw conflict(`Commission archive is missing ${name}`);
  return value;
}

function safeChild(root: string, name: string): string {
  const target = resolve(root, name);
  if (dirname(target) !== resolve(root)) throw new Error("Unsafe archive path");
  return target;
}

async function directorySize(path: string, snapshot: ArchiveSnapshot): Promise<number> {
  let total = (await stat(join(path, "metadata.json.gz"))).size;
  for (const file of snapshot.attachmentFiles) total += (await stat(join(path, file.file))).size;
  return total;
}

async function removeMatchingDirectories(root: string, matches: (name: string) => boolean): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  });
  await Promise.all(entries.filter((entry) => entry.isDirectory() && matches(entry.name)).map((entry) => rm(safeChild(root, entry.name), { recursive: true, force: true })));
}

async function validCommissionArchive(archiveRoot: string, claim: { id: string; archive_path: string | null; archive_sha256: string | null }): Promise<boolean> {
  const archivePath = safeChild(archiveRoot, claim.id);
  if (!claim.archive_path || resolve(claim.archive_path) !== resolve(archivePath) || !claim.archive_sha256) return false;
  const metadata = await readFile(join(archivePath, "metadata.json.gz")).catch(() => undefined);
  return Boolean(metadata && sha256(metadata) === claim.archive_sha256);
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function httpError(statusCode: number, message: string, cause?: unknown): Error & { statusCode: number } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { statusCode });
}

function notFound(message: string): Error & { statusCode: number } { return httpError(404, message); }
function conflict(message: string, cause?: unknown): Error & { statusCode: number } { return httpError(409, message, cause); }
