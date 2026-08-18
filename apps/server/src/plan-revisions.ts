import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { addTaskComment } from "./comments.ts";
import { renumberTaskTree } from "./task-numbering.ts";

export const REVISION_INTERACTIONS = ["boolean", "single_choice", "multiple_choice", "text"] as const;
export type RevisionInteraction = typeof REVISION_INTERACTIONS[number];
export type RevisionQuestion = { type: RevisionInteraction; prompt: string; options: string[] };
export type RevisionProposal = { summary: string; changes: RevisionChange[] };
type RevisionChange =
  | { action: "create"; clientId: string; title: string; description?: string; ownerType?: "human" | "ai"; priority?: string; dueDate?: string | null; readOnly?: boolean; acceptanceCriteria?: unknown[]; parentTaskId?: string; position?: number; dependsOnTaskIds?: string[] }
  | { action: "update"; taskId: string; title?: string; description?: string; ownerType?: "human" | "ai"; priority?: string; dueDate?: string | null; readOnly?: boolean; acceptanceCriteria?: unknown[]; parentTaskId?: string; position?: number; dependsOnTaskIds?: string[]; reopen?: boolean }
  | { action: "delete"; taskId: string; reason: string };
type TaskPlacement = { taskId: string; parentId: string | null; position?: number };

type RevisionRow = { id: string; commission_id: string; base_coordination_revision: number; status: string; proposal_json: string | null };
type CardRow = { comment_id: string; plan_revision_id: string; interaction_type: RevisionInteraction; purpose: "question" | "final_confirmation"; options_json: string; status: string };
type TaskDeletion = { taskId: string; commissionId: string; mainTaskId: string; reason: string; revisionId?: string | null; deletingTaskIds?: ReadonlySet<string>; dependencyIds?: readonly string[]; now?: string; allowArchived?: boolean };

export function beginPlanRevision(database: DatabaseSync, commissionId: string, summary: string): string {
  const existing = database.prepare("SELECT id FROM plan_revisions WHERE commission_id = ? AND status IN ('collecting', 'reviewing', 'awaiting_confirmation')").get(commissionId) as { id: string } | undefined;
  if (existing) return existing.id;
  const commission = database.prepare("SELECT main_task_id, coordination_revision FROM commissions WHERE id = ? AND archived_at IS NULL").get(commissionId) as { main_task_id: string | null; coordination_revision: number } | undefined;
  if (!commission?.main_task_id) throw conflict("Commission has no active main task");
  const id = randomUUID();
  const now = new Date().toISOString();
  database.prepare("INSERT INTO plan_revisions (id, commission_id, base_coordination_revision, status, created_at, updated_at) VALUES (?, ?, ?, 'collecting', ?, ?)")
    .run(id, commissionId, commission.coordination_revision, now, now);
  createRevisionCard(database, id, commission.main_task_id, { type: "text", prompt: `## 计划修订待确认\n\n${summary}\n\n请说明希望如何调整任务方向。`, options: [] });
  return id;
}

export function createRevisionCard(database: DatabaseSync, revisionId: string, taskId: string, question: RevisionQuestion, purpose: "question" | "final_confirmation" = "question"): Record<string, unknown> {
  if (!REVISION_INTERACTIONS.includes(question.type) || !question.prompt.trim()) throw new Error("Invalid plan revision question");
  const options = question.options.map((option) => option.trim()).filter(Boolean);
  if (question.type === "boolean" && options.length !== 2) throw new Error("Plan revision boolean requires exactly two options");
  if (question.type === "single_choice" && options.length < 2) throw new Error("Plan revision choice requires at least two options");
  if (question.type === "multiple_choice" && !options.length) throw new Error("Plan revision multiple choice requires options");
  if (question.type === "text" && options.length) throw new Error("Plan revision text question cannot have options");
  database.prepare("UPDATE plan_revision_cards SET status = 'superseded' WHERE plan_revision_id = ? AND status = 'pending'").run(revisionId);
  const comment = addTaskComment(database, { taskId, authorType: "agent", agentRole: "supervisor", content: question.prompt });
  database.prepare("INSERT INTO plan_revision_cards (comment_id, plan_revision_id, interaction_type, purpose, options_json, status) VALUES (?, ?, ?, ?, ?, 'pending')")
    .run(String(comment.id), revisionId, question.type, purpose, JSON.stringify(options));
  return comment;
}

export function pendingTextRevisionCard(database: DatabaseSync, taskId: string): CardRow | undefined {
  return database.prepare(`SELECT card.* FROM plan_revision_cards AS card
    JOIN comments AS comment ON comment.id = card.comment_id
    JOIN plan_revisions AS revision ON revision.id = card.plan_revision_id
    JOIN commissions AS commission ON commission.id = revision.commission_id
    WHERE comment.task_id = ? AND commission.main_task_id = ? AND card.status = 'pending' AND card.interaction_type = 'text'
    ORDER BY comment.rowid DESC LIMIT 1`).get(taskId, taskId) as CardRow | undefined;
}

export function answerRevisionCard(database: DatabaseSync, taskId: string, commentId: string, answer: unknown): { revisionId: string; finalAccepted: boolean } {
  const card = database.prepare(`SELECT card.* FROM plan_revision_cards AS card
    JOIN comments AS comment ON comment.id = card.comment_id
    JOIN plan_revisions AS revision ON revision.id = card.plan_revision_id
    JOIN commissions AS commission ON commission.id = revision.commission_id
    WHERE card.comment_id = ? AND comment.task_id = ? AND commission.main_task_id = ? AND card.status = 'pending'`).get(commentId, taskId, taskId) as CardRow | undefined;
  if (!card) throw conflict("Plan revision card is no longer awaiting an answer");
  const normalized = normalizeAnswer(card, answer);
  database.prepare("UPDATE plan_revision_cards SET status = 'answered', answer_json = ?, answered_at = ? WHERE comment_id = ? AND status = 'pending'")
    .run(JSON.stringify(normalized), new Date().toISOString(), card.comment_id);
  if (card.purpose === "final_confirmation" && normalized.accepted !== true) database.prepare("UPDATE plan_revisions SET status = 'collecting', updated_at = ? WHERE id = ?").run(new Date().toISOString(), card.plan_revision_id);
  return { revisionId: card.plan_revision_id, finalAccepted: card.purpose === "final_confirmation" && normalized.accepted === true };
}

export function respondRevisionCard(database: DatabaseSync, taskId: string, commentId: string, answer: unknown): { answered: { revisionId: string; finalAccepted: boolean }; comment: Record<string, unknown>; mainTaskId?: string } {
  return revisionTransaction(database, () => {
    const answered = answerRevisionCard(database, taskId, commentId, answer);
    const content = Array.isArray(answer) ? answer.join("、") : String(answer ?? "");
    const comment = addTaskComment(database, { taskId, authorType: "human", content: `计划修订回答：${content}`, parentId: commentId });
    const mainTaskId = answered.finalAccepted ? applyPlanRevisionUnsafe(database, answered.revisionId) : undefined;
    return { answered, comment, ...(mainTaskId ? { mainTaskId } : {}) };
  });
}

export function revisionForRun(database: DatabaseSync, revisionId: string): RevisionRow & { main_task_id: string } {
  const row = database.prepare(`SELECT revision.*, commission.main_task_id FROM plan_revisions AS revision
    JOIN commissions AS commission ON commission.id = revision.commission_id WHERE revision.id = ? AND commission.main_task_id IS NOT NULL`).get(revisionId) as RevisionRow & { main_task_id: string } | undefined;
  if (!row) throw conflict("Plan revision not found");
  return row;
}

export function saveRevisionProposal(database: DatabaseSync, revisionId: string, proposal: RevisionProposal): void {
  database.prepare("UPDATE plan_revisions SET proposal_json = ?, status = 'reviewing', updated_at = ? WHERE id = ? AND status = 'collecting'")
    .run(JSON.stringify(proposal), new Date().toISOString(), revisionId);
}

export function publishRevisionConfirmation(database: DatabaseSync, revisionId: string, summary: string, runId: string): void {
  const revision = revisionForRun(database, revisionId);
  if (!revision.proposal_json) throw conflict("Plan revision has no proposal to confirm");
  const proposal = parseRevisionProposal(revision.proposal_json);
  database.prepare("UPDATE plan_revisions SET status = 'awaiting_confirmation', review_run_id = ?, updated_at = ? WHERE id = ? AND status = 'reviewing'")
    .run(runId, new Date().toISOString(), revisionId);
  createRevisionCard(database, revisionId, revision.main_task_id, { type: "boolean", prompt: `## 计划修订最终确认\n\n${proposal.summary}\n\n### 已审查任务变更\n\n\`\`\`json\n${JSON.stringify(proposal.changes, null, 2)}\n\`\`\`\n\n### 审查结论\n\n${summary}`, options: ["接受", "拒绝"] }, "final_confirmation");
}

export function applyPlanRevision(database: DatabaseSync, revisionId: string): string {
  return revisionTransaction(database, () => applyPlanRevisionUnsafe(database, revisionId));
}

function applyPlanRevisionUnsafe(database: DatabaseSync, revisionId: string): string {
  const revision = revisionForRun(database, revisionId);
  if (revision.status !== "awaiting_confirmation" || !revision.proposal_json) throw conflict("Plan revision is not ready to apply");
  if ((database.prepare("SELECT coordination_revision FROM commissions WHERE id = ?").get(revision.commission_id) as { coordination_revision: number }).coordination_revision !== revision.base_coordination_revision) throw staleConflict(revision.id);
  const proposal = parseRevisionProposal(revision.proposal_json);
  applyChanges(database, revision, proposal);
  const now = new Date().toISOString();
  database.prepare("UPDATE plan_revisions SET status = 'applied', applied_at = ?, updated_at = ? WHERE id = ?").run(now, now, revision.id);
  database.prepare("UPDATE commissions SET coordination_revision = ?, coordination_pending = 1, status = 'active', updated_at = ? WHERE id = ?").run(revision.base_coordination_revision + 1, now, revision.commission_id);
  database.prepare("UPDATE runs SET coordination_revision = ?, context_snapshot_json = '{}' WHERE commission_id = ? AND trigger_type = 'coordinate' AND status = 'queued'")
    .run(revision.base_coordination_revision + 1, revision.commission_id);
  const document = database.prepare("SELECT id FROM documents WHERE commission_id = ? AND type = 'plan' ORDER BY rowid LIMIT 1").get(revision.commission_id) as { id: string } | undefined;
  if (document) {
    const version = (database.prepare("SELECT COALESCE(MAX(version_no), 0) + 1 AS version FROM document_versions WHERE document_id = ?").get(document.id) as { version: number }).version;
    const versionId = randomUUID();
    database.prepare("INSERT INTO document_versions (id, document_id, version_no, content_markdown, source_json, locked, created_by, created_at) VALUES (?, ?, ?, ?, ?, 0, 'supervisor', ?)")
      .run(versionId, document.id, version, `# 计划修订\n\n${proposal.summary}`, revision.proposal_json, now);
    database.prepare("UPDATE documents SET current_version_id = ? WHERE id = ?").run(versionId, document.id);
  }
  addTaskComment(database, { taskId: revision.main_task_id, authorType: "system", content: `## 计划修订已应用\n\n${proposal.summary}` });
  return revision.main_task_id;
}

export function parseRevisionProposal(value: string | unknown): RevisionProposal {
  const data = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid plan revision proposal");
  const row = data as Record<string, unknown>;
  if (typeof row.summary !== "string" || !row.summary.trim() || !Array.isArray(row.changes) || !row.changes.length) throw new Error("Invalid plan revision proposal");
  const changes = row.changes.map((item) => parseChange(item));
  return { summary: row.summary.trim(), changes };
}

function applyChanges(database: DatabaseSync, revision: RevisionRow & { main_task_id: string }, proposal: RevisionProposal): void {
  const now = new Date().toISOString();
  const ids = new Map<string, string>();
  const placements: TaskPlacement[] = [];
  for (const change of proposal.changes) if (change.action === "create") {
    if (ids.has(change.clientId)) throw conflict(`Duplicate task clientId: ${change.clientId}`);
    const id = randomUUID(); ids.set(change.clientId, id);
    const parentId = change.parentTaskId ?? revision.main_task_id;
    assertActiveTask(database, parentId, revision.commission_id);
    const position = nextPosition(database, revision.commission_id, parentId);
    database.prepare(`INSERT INTO tasks (id, commission_id, parent_id, number_path, position, title, description, status, priority, due_date, owner_type, acceptance_json, review_round_limit, review_round_used, created_at, updated_at, read_only, auto_approve_permissions)
      VALUES (?, ?, ?, '', ?, ?, ?, 'todo', ?, ?, ?, ?, 2, 0, ?, ?, ?, 0)`)
      .run(id, revision.commission_id, parentId, position, change.title, change.description ?? "", priority(change.priority), change.dueDate ?? null, change.ownerType ?? "ai", JSON.stringify(change.acceptanceCriteria ?? []), now, now, change.readOnly ? 1 : 0);
    if (change.position !== undefined) placements.push({ taskId: id, parentId, position: change.position });
  }
  const ref = (id: string) => ids.get(id) ?? id;
  for (const change of proposal.changes) if (change.action === "update") {
    const task = assertActiveTask(database, change.taskId, revision.commission_id);
    if (task.id === revision.main_task_id) throw conflict("Main task cannot be structurally changed");
    const directional = change.description !== undefined || change.acceptanceCriteria !== undefined || change.ownerType !== undefined || change.readOnly !== undefined || change.parentTaskId !== undefined || change.dependsOnTaskIds !== undefined;
    if (task.status === "done" && directional && change.reopen !== true) throw conflict(`Done task requires reopen: ${task.id}`);
    if (hasActiveRun(database, task.id)) throw conflict(`Task has an active Run: ${task.id}`);
    if (task.status === "done" && directional && change.reopen === true) {
      const dependentRun = database.prepare(`WITH RECURSIVE dependents(id) AS (
        SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ?
        UNION
        SELECT dependency.task_id FROM task_dependencies AS dependency JOIN dependents ON dependency.depends_on_task_id = dependents.id
      ) SELECT run.task_id FROM runs AS run JOIN dependents ON dependents.id = run.task_id
        WHERE run.status IN ('queued', 'preparing', 'running', 'waiting_approval', 'waiting_input') LIMIT 1`).get(task.id) as { task_id: string } | undefined;
      if (dependentRun) throw conflict(`Dependent task has an active Run: ${dependentRun.task_id}`);
    }
    const parentId = change.parentTaskId ?? task.parent_id;
    if (change.parentTaskId !== undefined) assertActiveTask(database, change.parentTaskId, revision.commission_id);
    database.prepare(`UPDATE tasks SET title = COALESCE(?, title), description = COALESCE(?, description), owner_type = COALESCE(?, owner_type), priority = COALESCE(?, priority), due_date = CASE WHEN ? THEN ? ELSE due_date END,
      read_only = CASE WHEN ? THEN ? ELSE read_only END, acceptance_json = COALESCE(?, acceptance_json), parent_id = COALESCE(?, parent_id), status = CASE WHEN ? THEN 'todo' ELSE status END, blocked_reason = CASE WHEN ? THEN NULL ELSE blocked_reason END, updated_at = ? WHERE id = ?`)
      .run(change.title ?? null, change.description ?? null, change.ownerType ?? null, change.priority ? priority(change.priority) : null, Object.hasOwn(change, "dueDate") ? 1 : 0, change.dueDate ?? null, Object.hasOwn(change, "readOnly") ? 1 : 0, change.readOnly ? 1 : 0, change.acceptanceCriteria ? JSON.stringify(change.acceptanceCriteria) : null, change.parentTaskId ?? null, change.reopen ? 1 : 0, change.reopen ? 1 : 0, now, task.id);
    if (change.parentTaskId !== undefined || change.position !== undefined) placements.push({ taskId: task.id, parentId, ...(change.position !== undefined ? { position: change.position } : {}) });
    if (change.dependsOnTaskIds) replaceDependencies(database, task.id, change.dependsOnTaskIds.map(ref), revision.commission_id, now);
  }
  for (const change of proposal.changes) if (change.action === "create" && change.dependsOnTaskIds) replaceDependencies(database, ids.get(change.clientId)!, change.dependsOnTaskIds.map(ref), revision.commission_id, now);
  const deleting = new Set(proposal.changes.flatMap((change) => change.action === "delete" ? [change.taskId] : []));
  const dependencySnapshots = new Map([...deleting].map((taskId) => [taskId, (database.prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY created_at, depends_on_task_id").all(taskId) as Array<{ depends_on_task_id: string }>).map((row) => row.depends_on_task_id)]));
  for (const change of proposal.changes) if (change.action === "delete") {
    const dependencyIds = dependencySnapshots.get(change.taskId);
    deleteTaskRecord(database, { taskId: change.taskId, commissionId: revision.commission_id, mainTaskId: revision.main_task_id, reason: change.reason, revisionId: revision.id, deletingTaskIds: deleting, ...(dependencyIds ? { dependencyIds } : {}), now });
  }
  applyPlacements(database, revision.commission_id, placements);
  validateGraphs(database, revision.commission_id, revision.main_task_id);
  renumberTaskTree(database, revision.commission_id);
}

export function deleteTaskRecord(database: DatabaseSync, input: TaskDeletion): void {
  const task = database.prepare("SELECT id, archived_at, deleted_at FROM tasks WHERE id = ? AND commission_id = ?").get(input.taskId, input.commissionId) as { id: string; archived_at: string | null; deleted_at: string | null } | undefined;
  if (!task || task.deleted_at || (!input.allowArchived && task.archived_at)) throw conflict(`Active task not found: ${input.taskId}`);
  if (task.id === input.mainTaskId) throw conflict("Main task cannot be deleted");
  if (hasActiveRun(database, task.id)) throw conflict(`Task has an active Run: ${task.id}`);
  const deleting = input.deletingTaskIds ?? new Set([task.id]);
  const child = database.prepare("SELECT id FROM tasks WHERE parent_id = ? AND archived_at IS NULL AND deleted_at IS NULL LIMIT 1").get(task.id) as { id: string } | undefined;
  if (child && !deleting.has(child.id)) throw conflict(`Delete or move child task first: ${child.id}`);
  const dependents = database.prepare(`SELECT task.id, task.number_path, task.title FROM task_dependencies AS dependency
    JOIN tasks AS task ON task.id = dependency.task_id
    WHERE dependency.depends_on_task_id = ? AND task.archived_at IS NULL AND task.deleted_at IS NULL`).all(task.id) as Array<{ id: string; number_path: string; title: string }>;
  const dependent = dependents.find((candidate) => !deleting.has(candidate.id));
  if (dependent) throw conflict(`Task is still required by active task ${dependent.number_path} ${dependent.title}`);
  const dependencyIds = input.dependencyIds ?? (database.prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY created_at, depends_on_task_id").all(task.id) as Array<{ depends_on_task_id: string }>).map((row) => row.depends_on_task_id);
  const now = input.now ?? new Date().toISOString();
  database.prepare("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?").run(task.id, task.id);
  database.prepare("UPDATE tasks SET status = 'archived', archived_at = COALESCE(archived_at, ?), deleted_at = ?, deleted_reason = ?, deleted_revision_id = ?, deleted_dependency_ids_json = ?, updated_at = ? WHERE id = ?")
    .run(now, now, input.reason, input.revisionId ?? null, JSON.stringify(dependencyIds), now, task.id);
}

function applyPlacements(database: DatabaseSync, commissionId: string, placements: TaskPlacement[]): void {
  const groups = new Map<string | null, TaskPlacement[]>();
  for (const placement of placements) groups.set(placement.parentId, [...(groups.get(placement.parentId) ?? []), placement]);
  const update = database.prepare("UPDATE tasks SET position = ? WHERE id = ?");
  for (const [parentId, group] of groups) {
    const moving = new Set(group.map((placement) => placement.taskId));
    const taskIds = (database.prepare("SELECT id FROM tasks WHERE commission_id = ? AND parent_id IS ? AND archived_at IS NULL ORDER BY position, created_at, rowid").all(commissionId, parentId) as Array<{ id: string }>).map((row) => row.id).filter((id) => !moving.has(id));
    for (const placement of group.toSorted((left, right) => (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER))) taskIds.splice(Math.min(placement.position ?? taskIds.length, taskIds.length), 0, placement.taskId);
    taskIds.forEach((taskId, position) => update.run(position, taskId));
  }
}

function replaceDependencies(database: DatabaseSync, taskId: string, dependencyIds: string[], commissionId: string, now: string): void {
  database.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(taskId);
  const insert = database.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id, created_by, created_at) VALUES (?, ?, 'planner_agent', ?)");
  for (const dependencyId of [...new Set(dependencyIds)]) {
    if (dependencyId === taskId) throw conflict("Task cannot depend on itself");
    const dependency = database.prepare(`SELECT task.id FROM tasks AS task
      JOIN commissions AS dependency_commission ON dependency_commission.id = task.commission_id
      JOIN commissions AS source_commission ON source_commission.id = ?
      WHERE task.id = ? AND task.archived_at IS NULL AND dependency_commission.project_id = source_commission.project_id`).get(commissionId, dependencyId);
    if (!dependency) throw conflict(`Active dependency not found in project: ${dependencyId}`);
    insert.run(taskId, dependencyId, now);
  }
}

function validateGraphs(database: DatabaseSync, commissionId: string, mainTaskId: string): void {
  const rows = database.prepare("SELECT id, parent_id FROM tasks WHERE commission_id = ? AND archived_at IS NULL").all(commissionId) as Array<{ id: string; parent_id: string | null }>;
  const parents = new Map(rows.map((row) => [row.id, row.parent_id]));
  for (const row of rows) {
    const seen = new Set<string>(); let id: string | null = row.id;
    while (id) { if (seen.has(id)) throw conflict("Task parent cycle"); seen.add(id); id = parents.get(id) ?? null; }
    if (row.id !== mainTaskId && !seen.has(mainTaskId)) throw conflict(`Task is outside the main task tree: ${row.id}`);
  }
  const projectId = (database.prepare("SELECT project_id FROM commissions WHERE id = ?").get(commissionId) as { project_id: string }).project_id;
  const edges = database.prepare(`SELECT dependency.task_id, dependency.depends_on_task_id FROM task_dependencies AS dependency
    JOIN tasks AS task ON task.id = dependency.task_id JOIN tasks AS required ON required.id = dependency.depends_on_task_id
    JOIN commissions AS commission ON commission.id = task.commission_id
    WHERE commission.project_id = ? AND task.archived_at IS NULL AND required.archived_at IS NULL`).all(projectId) as Array<{ task_id: string; depends_on_task_id: string }>;
  const graph = new Map<string, string[]>(); for (const edge of edges) graph.set(edge.task_id, [...(graph.get(edge.task_id) ?? []), edge.depends_on_task_id]);
  const visit = (id: string, active = new Set<string>(), done = new Set<string>()): void => { if (active.has(id)) throw conflict("Task dependency cycle"); if (done.has(id)) return; active.add(id); for (const next of graph.get(id) ?? []) visit(next, active, done); active.delete(id); done.add(id); };
  const done = new Set<string>(); for (const id of graph.keys()) visit(id, new Set(), done);
}

function parseChange(value: unknown): RevisionChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid plan revision change");
  const row = value as Record<string, unknown>;
  if (row.action === "delete") return { action: "delete", taskId: text(row.taskId, "taskId"), reason: text(row.reason, "reason") };
  if (row.action === "create") return { action: "create", clientId: text(row.clientId, "clientId"), title: text(row.title, "title"), ...optionalFields(row) };
  if (row.action === "update") return { action: "update", taskId: text(row.taskId, "taskId"), ...optionalFields(row), ...(typeof row.reopen === "boolean" ? { reopen: row.reopen } : {}) };
  throw new Error("Invalid plan revision action");
}

function optionalFields(row: Record<string, unknown>): Omit<Extract<RevisionChange, { action: "update" }>, "action" | "taskId" | "reopen"> {
  const result: Record<string, unknown> = {};
  for (const key of ["title", "ownerType", "priority", "parentTaskId"] as const) if (row[key] !== undefined) result[key] = text(row[key], key);
  if (row.description !== undefined) { if (typeof row.description !== "string") throw new Error("description must be a string"); result.description = row.description.trim(); }
  if (result.ownerType !== undefined && !["human", "ai"].includes(String(result.ownerType))) throw new Error("ownerType is invalid");
  if (result.priority !== undefined) priority(String(result.priority));
  if (row.dueDate === null) result.dueDate = null;
  else if (row.dueDate !== undefined) {
    const dueDate = text(row.dueDate, "dueDate");
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate);
    const parsed = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
    if (!parsed || parsed.toISOString().slice(0, 10) !== dueDate) throw new Error("dueDate must use YYYY-MM-DD");
    result.dueDate = dueDate;
  }
  if (row.readOnly !== undefined) { if (typeof row.readOnly !== "boolean") throw new Error("readOnly must be a boolean"); result.readOnly = row.readOnly; }
  if (row.acceptanceCriteria !== undefined) { if (!Array.isArray(row.acceptanceCriteria)) throw new Error("acceptanceCriteria must be an array"); result.acceptanceCriteria = row.acceptanceCriteria; }
  if (row.position !== undefined) { if (!Number.isInteger(row.position) || Number(row.position) < 0) throw new Error("position must be a non-negative integer"); result.position = row.position; }
  if (row.dependsOnTaskIds !== undefined) { if (!Array.isArray(row.dependsOnTaskIds) || row.dependsOnTaskIds.some((id) => typeof id !== "string" || !id)) throw new Error("dependsOnTaskIds must be strings"); result.dependsOnTaskIds = row.dependsOnTaskIds; }
  return result as Omit<Extract<RevisionChange, { action: "update" }>, "action" | "taskId" | "reopen">;
}

function normalizeAnswer(card: CardRow, answer: unknown): Record<string, unknown> {
  const options = JSON.parse(card.options_json) as string[];
  if (card.interaction_type === "text") return { text: text(answer, "answer") };
  if (card.interaction_type === "multiple_choice") {
    if (!Array.isArray(answer) || !answer.length || answer.some((item) => typeof item !== "string" || !options.includes(item))) throw conflict("Invalid plan revision answer");
    return { values: [...new Set(answer)] };
  }
  const value = text(answer, "answer");
  if (!options.includes(value)) throw conflict("Invalid plan revision answer");
  return { value, ...(card.purpose === "final_confirmation" ? { accepted: value === options[0] } : {}) };
}

function assertActiveTask(database: DatabaseSync, taskId: string, commissionId: string): { id: string; status: string; parent_id: string | null } {
  const task = database.prepare("SELECT id, status, parent_id FROM tasks WHERE id = ? AND commission_id = ? AND archived_at IS NULL").get(taskId, commissionId) as { id: string; status: string; parent_id: string | null } | undefined;
  if (!task) throw conflict(`Active task not found: ${taskId}`); return task;
}
function nextPosition(database: DatabaseSync, commissionId: string, parentId: string | null): number { return (database.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM tasks WHERE commission_id = ? AND parent_id IS ? AND archived_at IS NULL").get(commissionId, parentId) as { position: number }).position; }
function hasActiveRun(database: DatabaseSync, taskId: string): boolean { return Boolean(database.prepare("SELECT 1 FROM runs WHERE task_id = ? AND status IN ('queued', 'preparing', 'running', 'waiting_approval', 'waiting_input')").get(taskId)); }
function priority(value: string | undefined): string { const result = value ?? "none"; if (!["none", "low", "medium", "high", "urgent"].includes(result)) throw conflict("Invalid priority"); return result; }
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`); return value.trim(); }
function statusError(message: string, statusCode: number): Error { return Object.assign(new Error(message), { statusCode }); }
function staleConflict(revisionId: string): Error { return Object.assign(conflict("Task plan changed while the revision was awaiting confirmation"), { staleRevisionId: revisionId }); }
const conflict = (message: string) => statusError(message, 409);

function revisionTransaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try { const result = action(); database.exec("COMMIT"); return result; }
  catch (error) {
    database.exec("ROLLBACK");
    const revisionId = error && typeof error === "object" && "staleRevisionId" in error ? String(error.staleRevisionId) : undefined;
    if (revisionId) {
      database.prepare("UPDATE plan_revisions SET status = 'stale', updated_at = ? WHERE id = ?").run(new Date().toISOString(), revisionId);
      database.prepare("UPDATE plan_revision_cards SET status = 'superseded' WHERE plan_revision_id = ? AND status = 'pending'").run(revisionId);
    }
    throw error;
  }
}
