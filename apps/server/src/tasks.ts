import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { attachmentData, registerAttachmentParsers, removePendingAttachment, selectedTaskAttachments, storeAttachment } from "./attachments.ts";
import { addMainTaskComment, addTaskComment, mentionsAgent, type AgentMentionHandler } from "./comments.ts";
import { generateAcceptanceDocuments } from "./documents.ts";
import { notify } from "./notifications.ts";

const STATUSES = ["backlog", "todo", "in_progress", "done", "blocked", "archived"] as const;
const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
const OWNERS = ["human", "ai"] as const;
const ACTIVE_STATUSES = STATUSES.filter((status) => status !== "archived");
const PRIORITY_RANK = new Map(PRIORITIES.map((priority, index) => [priority, index]));

type TaskRow = {
  id: string;
  commission_id: string;
  parent_id: string | null;
  number_path: string;
  position: number;
  title: string;
  description: string;
  status: typeof STATUSES[number];
  priority: typeof PRIORITIES[number];
  due_date: string | null;
  owner_type: typeof OWNERS[number];
  acceptance_json: string;
  review_round_limit: number;
  review_round_used: number;
  blocked_reason: string | null;
  human_waiver_reason: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  read_only: number;
  auto_approve_permissions: number;
};

type CommissionRow = { id: string; project_id: string; main_task_id: string | null; status: string; archived_at: string | null; lifecycle_operation?: string | null };
type TaskView = TaskRow & { acceptanceCriteria: unknown[]; labels: Array<{ id: string; name: string; color: string }>; dependencyIds: string[]; latestRunStatus: string | null; children?: TaskView[] };
export type TaskPlan = { mainTask: Record<string, unknown>; tasks: Array<Record<string, unknown>> };

class CycleError extends Error {
  readonly path: string[];

  constructor(path: string[]) {
    super(`Dependency cycle: ${path.join(" -> ")}`);
    this.path = path;
  }
}

export function registerTaskRoutes(server: FastifyInstance, database: DatabaseSync, mentionAgent?: AgentMentionHandler, attachmentsRoot = "attachments"): void {
  registerAttachmentParsers(server);
  server.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>("/api/projects/:id/tasks", async (request) => {
    projectExists(database, request.params.id);
    const tasks = queryTasks(database, request.params.id, request.query);
    if (request.query.view === "tree") return taskTree(tasks);
    if (request.query.view === "board") return Object.fromEntries(ACTIVE_STATUSES.map((status) => [status, tasks.filter((task) => task.status === status)]));
    return tasks;
  });

  server.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/commissions/:id/tasks", async (request, reply) => {
    const body = request.body ?? {};
    try {
      if (body.mainTask !== undefined || body.tasks !== undefined) {
        const created = createTaskPlan(database, request.params.id, body);
        return reply.code(201).send(created);
      }
      const id = transaction(database, () => createSingleTask(database, request.params.id, body));
      return reply.code(201).send(taskView(database, id));
    } catch (error) {
      if (error instanceof CycleError) return reply.code(409).send({ error: "Dependency cycle", path: error.path });
      throw error;
    }
  });

  server.get<{ Params: { id: string } }>("/api/tasks/:id", async (request) => taskView(database, request.params.id, true));

  server.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/tasks/:id", async (request) => {
    transaction(database, () => updateTask(database, request.params.id, request.body ?? {}));
    return taskView(database, request.params.id, true);
  });

  server.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/tasks/:id/move", async (request) => {
    transaction(database, () => {
      const before = activeTask(database, request.params.id);
      moveTask(database, request.params.id, request.body ?? {});
      const after = activeTask(database, request.params.id);
      if (before.status !== after.status && after.status === "done") {
        addMainTaskComment(database, { sourceTaskId: after.id, content: "子任务已由人工标记为完成。" });
        updateCommissionAcceptance(database, after.commission_id);
      }
      if (before.status !== after.status && after.status === "blocked") addMainTaskComment(database, { sourceTaskId: after.id, kind: "blocker", content: "子任务已由人工标记为阻塞。" });
    });
    return taskView(database, request.params.id, true);
  });

  server.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/tasks/:id/reorder", async (request) => {
    transaction(database, () => reorderTask(database, request.params.id, request.body ?? {}));
    return taskView(database, request.params.id, true);
  });

  server.post<{ Params: { id: string } }>("/api/tasks/:id/archive", async (request) => {
    transaction(database, () => {
      const task = activeTask(database, request.params.id);
      const commission = database.prepare("SELECT main_task_id FROM commissions WHERE id = ?").get(task.commission_id) as { main_task_id: string | null } | undefined;
      const archiveTree = commission?.main_task_id === task.id;
      if (archiveTree) {
        const running = database.prepare(`WITH RECURSIVE descendants(id) AS (
          SELECT id FROM tasks WHERE id = ? AND archived_at IS NULL
          UNION ALL
          SELECT child.id FROM tasks AS child JOIN descendants AS parent ON child.parent_id = parent.id WHERE child.archived_at IS NULL
        ) SELECT 1 FROM tasks JOIN descendants ON descendants.id = tasks.id WHERE tasks.status = 'in_progress' LIMIT 1`).get(task.id);
        if (running) throw conflict("In-progress tasks must be cancelled before archiving");
      } else {
        if (task.status === "in_progress") throw conflict("In-progress tasks must be cancelled before archiving");
        const activeDescendant = database.prepare(`WITH RECURSIVE descendants(id) AS (
          SELECT id FROM tasks WHERE parent_id = ? AND archived_at IS NULL
          UNION ALL
          SELECT child.id FROM tasks AS child JOIN descendants AS parent ON child.parent_id = parent.id WHERE child.archived_at IS NULL
        ) SELECT 1 FROM descendants LIMIT 1`).get(task.id);
        if (activeDescendant) throw conflict("Archive child tasks before archiving their parent");
      }
      const activeDependent = database.prepare(`WITH RECURSIVE archive_set(id) AS (
        SELECT id FROM tasks WHERE id = ?
        UNION ALL
        SELECT child.id FROM tasks AS child JOIN archive_set AS parent ON child.parent_id = parent.id WHERE ? = 1
      ) SELECT dependent.number_path, dependent.title FROM task_dependencies AS dependency
        JOIN archive_set ON archive_set.id = dependency.depends_on_task_id
        JOIN tasks AS dependent ON dependent.id = dependency.task_id
        WHERE dependent.archived_at IS NULL AND dependent.id NOT IN (SELECT id FROM archive_set)
        LIMIT 1`).get(task.id, archiveTree ? 1 : 0) as { number_path: string; title: string } | undefined;
      if (activeDependent) throw conflict(`Task is still required by active task ${activeDependent.number_path} ${activeDependent.title}`);
      const now = new Date().toISOString();
      if (archiveTree) {
        database.prepare(`WITH RECURSIVE descendants(id) AS (
          SELECT id FROM tasks WHERE id = ? AND archived_at IS NULL
          UNION ALL
          SELECT child.id FROM tasks AS child JOIN descendants AS parent ON child.parent_id = parent.id WHERE child.archived_at IS NULL
        ) UPDATE tasks SET status = 'archived', archived_at = ?, updated_at = ? WHERE id IN (SELECT id FROM descendants)`).run(task.id, now, now);
      } else {
        database.prepare("UPDATE tasks SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, task.id);
      }
      compactSiblings(database, task.commission_id, task.parent_id);
      renumberCommission(database, task.commission_id);
    });
    return taskView(database, request.params.id, true);
  });

  server.post<{ Params: { id: string } }>("/api/tasks/:id/unarchive", async (request) => {
    transaction(database, () => {
      const task = taskById(database, request.params.id);
      if (!task.archived_at) throw conflict("Task is not archived");
      const commission = database.prepare("SELECT main_task_id FROM commissions WHERE id = ?").get(task.commission_id) as { main_task_id: string | null } | undefined;
      const unarchiveTree = commission?.main_task_id === task.id;
      const now = new Date().toISOString();
      if (unarchiveTree) {
        database.prepare(`WITH RECURSIVE descendants(id) AS (
          SELECT id FROM tasks WHERE id = ?
          UNION ALL
          SELECT child.id FROM tasks AS child JOIN descendants AS parent ON child.parent_id = parent.id
        ) UPDATE tasks SET status = 'done', archived_at = NULL, updated_at = ? WHERE id IN (SELECT id FROM descendants)`).run(task.id, now);
      } else {
        const archivedAncestor = database.prepare(`WITH RECURSIVE ancestors(id, parent_id, archived_at) AS (
          SELECT id, parent_id, archived_at FROM tasks WHERE id = ?
          UNION ALL
          SELECT parent.id, parent.parent_id, parent.archived_at FROM tasks AS parent JOIN ancestors AS child ON parent.id = child.parent_id
        ) SELECT 1 FROM ancestors WHERE id <> ? AND archived_at IS NOT NULL LIMIT 1`).get(task.id, task.id);
        if (archivedAncestor) throw conflict("Unarchive parent tasks before unarchiving their children");
        database.prepare("UPDATE tasks SET status = 'done', archived_at = NULL, updated_at = ? WHERE id = ?").run(now, task.id);
      }
      renumberCommission(database, task.commission_id);
    });
    return taskView(database, request.params.id, true);
  });

  server.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/tasks/:id/dependencies", async (request, reply) => {
    try {
      transaction(database, () => setDependencies(database, request.params.id, request.body ?? {}));
    } catch (error) {
      if (error instanceof CycleError) return reply.code(409).send({ error: "Dependency cycle", path: error.path });
      throw error;
    }
    return taskView(database, request.params.id, true);
  });

  server.delete<{ Params: { id: string; dependencyId: string } }>("/api/tasks/:id/dependencies/:dependencyId", async (request, reply) => {
    activeTask(database, request.params.id);
    const result = database.prepare("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?").run(request.params.id, request.params.dependencyId);
    if (!result.changes) throw notFound("Dependency not found");
    return reply.code(204).send();
  });

  server.get<{ Params: { id: string } }>("/api/tasks/:id/comments", async (request) => {
    taskById(database, request.params.id);
    return commentsWithAttachments(database, request.params.id);
  });

  server.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/tasks/:id/comments", async (request, reply) => {
    const task = activeTask(database, request.params.id);
    const content = optionalString(request.body?.content, "content") ?? "";
    const parentId = nullableString(request.body?.parentId ?? request.body?.parent_id, "parentId", null);
    const attachmentIds = request.body?.attachmentIds === undefined && request.body?.attachment_ids === undefined ? [] : stringArray(request.body?.attachmentIds ?? request.body?.attachment_ids, "attachmentIds");
    const attachments = selectedTaskAttachments(database, task.id, attachmentIds, "unlinked");
    if (!content && !attachments.length) throw badRequest("content or attachmentIds is required");
    const comment = transaction(database, () => {
      const created = addTaskComment(database, { taskId: task.id, authorType: "human", content, parentId });
      if (attachments.length) {
        const claimed = database.prepare(`UPDATE attachments SET comment_id = ? WHERE task_id = ? AND comment_id IS NULL AND run_id IS NULL AND id IN (${attachments.map(() => "?").join(", ")})`)
          .run(String(created.id), task.id, ...attachments.map((attachment) => attachment.id));
        if (Number(claimed.changes) !== attachments.length) throw conflict("Attachment was already used by another request");
      }
      return created;
    });
    let agentMention;
    if (mentionsAgent(content)) {
      try {
        agentMention = mentionAgent
          ? await mentionAgent(task.id, content, attachments.map((attachment) => attachment.id))
          : { action: "unavailable" as const, message: "Agent runtime is unavailable" };
      } catch {
        agentMention = { action: "unavailable" as const, message: "Agent routing failed after the comment was saved" };
      }
    }
    return reply.code(201).send({ ...comment, attachments, ...(agentMention ? { agentMention } : {}) });
  });

  server.post<{ Params: { id: string }; Body: Buffer | string }>("/api/tasks/:id/attachments", async (request, reply) => {
    const task = activeTask(database, request.params.id);
    const originalName = decodedFileName(requiredHeader(request.headers["x-file-name"], "x-file-name"));
    const mediaType = String(request.headers["content-type"] ?? "application/octet-stream").split(";", 1)[0]!.toLowerCase();
    const data = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body ?? "", "utf8");
    return reply.code(201).send(await storeAttachment(database, attachmentsRoot, { commissionId: task.commission_id, taskId: task.id, originalName, mediaType, data }));
  });

  server.get<{ Params: { id: string; attachmentId: string } }>("/api/tasks/:id/attachments/:attachmentId", async (request, reply) => {
    taskById(database, request.params.id);
    const attachment = selectedTaskAttachments(database, request.params.id, [request.params.attachmentId])[0]!;
    if (attachment.comment_id && !attachment.run_id && database.prepare("SELECT deleted_at FROM comments WHERE id = ?").get(attachment.comment_id)?.deleted_at) throw notFound("Attachment not found");
    reply
      .header("Content-Type", attachment.media_type)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(attachment.original_name)}`);
    return reply.send(await attachmentData(attachment, attachmentsRoot));
  });

  server.delete<{ Params: { id: string; attachmentId: string } }>("/api/tasks/:id/attachments/:attachmentId", async (request, reply) => {
    activeTask(database, request.params.id);
    await removePendingAttachment(database, attachmentsRoot, request.params.id, request.params.attachmentId);
    return reply.code(204).send();
  });

  server.delete<{ Params: { id: string; commentId: string } }>("/api/tasks/:id/comments/:commentId", async (request, reply) => {
    activeTask(database, request.params.id);
    const result = database.prepare("UPDATE comments SET content = '', deleted_at = COALESCE(deleted_at, ?) WHERE id = ? AND task_id = ?")
      .run(new Date().toISOString(), request.params.commentId, request.params.id);
    if (!result.changes) throw notFound("Comment not found");
    return reply.code(204).send();
  });

  server.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/tasks/:id/waive", async (request) => {
    const reason = requiredString(request.body?.reason, "reason");
    transaction(database, () => {
      const task = activeTask(database, request.params.id);
      const commission = activeCommission(database, task.commission_id);
      if (commission.main_task_id === task.id) throw conflict("Main task cannot be waived");
      if (task.status === "done") throw conflict("Task is already done");
      const now = new Date().toISOString();
      database.prepare("UPDATE tasks SET status = 'done', blocked_reason = NULL, human_waiver_reason = ?, updated_at = ? WHERE id = ?").run(reason, now, task.id);
      database.prepare("INSERT INTO evidence (id, task_id, criterion_key, type, status, summary, payload_json, created_at) VALUES (?, ?, '*', 'human_waiver', 'waived', ?, ?, ?)")
        .run(randomUUID(), task.id, reason, JSON.stringify({ reason }), now);
      database.prepare("INSERT INTO comments (id, task_id, author_type, kind, content, created_at) VALUES (?, ?, 'human', 'waiver', ?, ?)").run(randomUUID(), task.id, reason, now);
      addMainTaskComment(database, { sourceTaskId: task.id, content: `子任务已由人工豁免并完成。\n\n${reason}` });
      updateCommissionAcceptance(database, task.commission_id);
    });
    return taskView(database, request.params.id);
  });

  server.get<{ Params: { id: string } }>("/api/tasks/:id/acceptance", async (request) => acceptanceDetails(database, request.params.id));

  server.post<{ Params: { id: string } }>("/api/tasks/:id/accept", async (request) => {
    transaction(database, () => {
      const task = activeTask(database, request.params.id);
      const commission = commissionForMainTask(database, task);
      if (commission.status !== "awaiting_acceptance") throw conflict("Main task is not awaiting acceptance");
      const now = new Date().toISOString();
      database.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?").run(now, task.id);
      database.prepare("UPDATE commissions SET status = 'done', updated_at = ? WHERE id = ?").run(now, commission.id);
      database.prepare("UPDATE execution_grants SET status = 'exhausted' WHERE commission_id = ? AND status = 'active'").run(commission.id);
      generateAcceptanceDocuments(database, commission.id);
      notify(database, "completed", `已验收：${task.title}`, "最终验收已批准。", "task", task.id);
    });
    return taskView(database, request.params.id);
  });

  server.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/tasks/:id/reject", async (request) => {
    const reason = requiredString(request.body?.reason, "reason");
    transaction(database, () => {
      const task = activeTask(database, request.params.id);
      const commission = commissionForMainTask(database, task);
      if (commission.status !== "awaiting_acceptance") throw conflict("Main task is not awaiting acceptance");
      const now = new Date().toISOString();
      database.prepare("INSERT INTO comments (id, task_id, author_type, kind, content, created_at) VALUES (?, ?, 'human', 'rejection', ?, ?)").run(randomUUID(), task.id, reason, now);
      database.prepare("UPDATE commissions SET status = 'active', updated_at = ? WHERE id = ?").run(now, commission.id);
      // ponytail: reopen the latest completed AI leaf; replace with supervisor-selected task routing when that role is scheduled directly.
      const rework = database.prepare("SELECT id FROM tasks WHERE commission_id = ? AND id <> ? AND status = 'done' AND owner_type = 'ai' AND archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM tasks AS child WHERE child.parent_id = tasks.id AND child.archived_at IS NULL) ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(commission.id, task.id) as { id: string } | undefined;
      if (rework) database.prepare("UPDATE tasks SET status = 'todo', blocked_reason = NULL, updated_at = ? WHERE id = ?").run(now, rework.id);
      generateAcceptanceDocuments(database, commission.id);
    });
    return taskView(database, request.params.id);
  });
}

function createSingleTask(database: DatabaseSync, commissionId: string, body: Record<string, unknown>): string {
  const commission = activeCommission(database, commissionId);
  const parentWasProvided = Object.hasOwn(body, "parentId") || Object.hasOwn(body, "parent_id");
  const parentId = nullableString(body.parentId ?? body.parent_id, "parentId", parentWasProvided ? null : commission.main_task_id);
  if (parentId) assertParent(database, parentId, commission.id);
  if (!parentId && commission.main_task_id) throw conflict("Commission already has a main task");
  const id = insertTask(database, commission, parentId, body);
  if (!commission.main_task_id) database.prepare("UPDATE commissions SET main_task_id = ?, updated_at = ? WHERE id = ?").run(id, new Date().toISOString(), commission.id);
  setTaskLabels(database, id, commission.project_id, body.labels);
  const dependencyIds = body.dependsOnTaskIds ?? body.depends_on_task_ids;
  if (dependencyIds !== undefined) replaceDependencies(database, id, stringArray(dependencyIds, "dependsOnTaskIds"), "human");
  renumberCommission(database, commission.id);
  return id;
}

export function createTaskPlan(database: DatabaseSync, commissionId: string, body: Record<string, unknown>) {
  return transaction(database, () => {
    const commission = activeCommission(database, commissionId);
    if (commission.main_task_id || database.prepare("SELECT 1 FROM tasks WHERE commission_id = ?").get(commission.id)) throw conflict("Commission already has tasks");
    const main = record(body.mainTask, "mainTask");
    const planned = array(body.tasks, "tasks").map((value, index) => ({ ...record(value, `tasks[${index}]`), index }) as Record<string, unknown> & { index: number });
    const byClientId = new Map<string, typeof planned[number]>();
    for (const task of planned) {
      const clientId = requiredString(task.clientId, `tasks[${task.index}].clientId`);
      if (byClientId.has(clientId)) throw badRequest(`Duplicate clientId: ${clientId}`);
      byClientId.set(clientId, task);
    }
    for (const [clientId, task] of byClientId) {
      const parentClientId = nullableString(task.parentClientId, `tasks[${task.index}].parentClientId`, null);
      if (parentClientId && !byClientId.has(parentClientId)) throw badRequest(`Unknown parentClientId: ${parentClientId}`);
      if (parentClientId === clientId) throw badRequest(`Task ${clientId} cannot be its own parent`);
      const dependencies = stringArray(task.dependsOn ?? [], `tasks[${task.index}].dependsOn`);
      for (const dependency of dependencies) if (!byClientId.has(dependency)) throw badRequest(`Unknown dependency clientId: ${dependency}`);
    }
    assertPlanParentsAcyclic(byClientId);

    const mainId = insertTask(database, commission, null, main);
    database.prepare("UPDATE commissions SET main_task_id = ?, updated_at = ? WHERE id = ?").run(mainId, new Date().toISOString(), commission.id);
    setTaskLabels(database, mainId, commission.project_id, main.labels);
    const ids = new Map<string, string>();
    const pending = new Set(byClientId.keys());
    while (pending.size) {
      let progressed = false;
      for (const clientId of [...pending]) {
        const task = byClientId.get(clientId)!;
        const parentClientId = nullableString(task.parentClientId, "parentClientId", null);
        if (parentClientId && !ids.has(parentClientId)) continue;
        const id = insertTask(database, commission, parentClientId ? ids.get(parentClientId)! : mainId, task);
        ids.set(clientId, id);
        pending.delete(clientId);
        setTaskLabels(database, id, commission.project_id, task.labels);
        progressed = true;
      }
      if (!progressed) throw badRequest("Task parent graph is invalid");
    }
    for (const [clientId, task] of byClientId) replaceDependencies(database, ids.get(clientId)!, stringArray(task.dependsOn ?? [], "dependsOn").map((dependency) => ids.get(dependency)!), "planner_agent");
    renumberCommission(database, commission.id);
    addTaskComment(database, { taskId: mainId, authorType: "agent", agentRole: "supervisor", content: plannerTaskComment(database, mainId) });
    for (const id of ids.values()) addTaskComment(database, { taskId: id, authorType: "agent", agentRole: "supervisor", content: plannerTaskComment(database, id) });
    const documentId = randomUUID();
    const versionId = randomUUID();
    const now = new Date().toISOString();
    database.prepare("INSERT INTO documents (id, project_id, commission_id, type, title, created_at) VALUES (?, ?, ?, 'plan', ?, ?)").run(documentId, commission.project_id, commission.id, `${requiredString(main.title, "mainTask.title")} plan`, now);
    database.prepare("INSERT INTO document_versions (id, document_id, version_no, content_markdown, source_json, locked, created_by, created_at) VALUES (?, ?, 1, ?, ?, 0, 'planner_agent', ?)")
      .run(versionId, documentId, planMarkdown(main, planned), JSON.stringify(body), now);
    database.prepare("UPDATE documents SET current_version_id = ? WHERE id = ?").run(versionId, documentId);
    return { mainTask: taskView(database, mainId, true), tasks: planned.map((task) => taskView(database, ids.get(requiredString(task.clientId, "clientId"))!, true)) };
  });
}

function plannerTaskComment(database: DatabaseSync, taskId: string): string {
  const task = database.prepare("SELECT title, description, owner_type, priority, due_date, read_only, acceptance_json FROM tasks WHERE id = ?").get(taskId) as { title: string; description: string; owner_type: string; priority: string; due_date: string | null; read_only: number; acceptance_json: string };
  const dependencies = database.prepare("SELECT required.number_path, required.title FROM task_dependencies dependency JOIN tasks required ON required.id = dependency.depends_on_task_id WHERE dependency.task_id = ? ORDER BY required.number_path").all(taskId) as Array<{ number_path: string; title: string }>;
  const acceptance = JSON.parse(task.acceptance_json) as unknown[];
  const constraints = [
    `负责人：${task.owner_type === "ai" ? "AI" : "人工"}`,
    `优先级：${task.priority}`,
    task.due_date ? `截止时间：${task.due_date}` : null,
    task.read_only ? "只读任务：不得修改项目文件" : null,
    dependencies.length ? `前置依赖：${dependencies.map((item) => `${item.number_path} ${item.title}`).join("、")}` : null,
    ...acceptance.map((item) => `验收要求：${typeof item === "string" ? item : JSON.stringify(item)}`)
  ].filter(Boolean);
  return `## 架构师任务分析\n\n${task.description || task.title}\n\n## 对执行者的约束要求\n\n${constraints.length ? constraints.map((item) => `- ${item}`).join("\n") : "- 按任务描述与项目规范完成。"}`;
}

export function updateCommissionAcceptance(database: DatabaseSync, commissionId: string): boolean {
  const commission = database.prepare("SELECT main_task_id, status FROM commissions WHERE id = ?").get(commissionId) as { main_task_id: string | null; status: string } | undefined;
  if (!commission?.main_task_id || !["active", "blocked"].includes(commission.status)) return false;
  const unfinished = database.prepare("SELECT 1 FROM tasks WHERE commission_id = ? AND id <> ? AND archived_at IS NULL AND status <> 'done' LIMIT 1").get(commissionId, commission.main_task_id);
  if (unfinished) return false;
  const now = new Date().toISOString();
  database.prepare("UPDATE commissions SET status = 'awaiting_acceptance', updated_at = ? WHERE id = ?").run(now, commissionId);
  database.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ? AND status <> 'done'").run(now, commission.main_task_id);
  generateAcceptanceDocuments(database, commissionId);
  const main = database.prepare("SELECT title FROM tasks WHERE id = ?").get(commission.main_task_id) as { title: string };
  notify(database, "acceptance", `等待最终验收：${main.title}`, "所有执行任务已完成，请进行最终验收。", "task", commission.main_task_id);
  return true;
}

function insertTask(database: DatabaseSync, commission: CommissionRow, parentId: string | null, body: Record<string, unknown>): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  const position = nextPosition(database, commission.id, parentId);
  const priority = enumValue(body.priority ?? "none", PRIORITIES, "priority");
  const owner = enumValue(body.ownerType ?? body.owner_type ?? "ai", OWNERS, "ownerType");
  const acceptance = array(body.acceptanceCriteria ?? body.acceptance_json ?? [], "acceptanceCriteria");
  const dueDate = dueDateValue(body.dueDate ?? body.due_date);
  database.prepare(`
    INSERT INTO tasks (id, commission_id, parent_id, number_path, position, title, description, status, priority, due_date, owner_type, acceptance_json, review_round_limit, review_round_used, created_at, updated_at, read_only)
    VALUES (?, ?, ?, '', ?, ?, ?, 'backlog', ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(id, commission.id, parentId, position, requiredString(body.title, "title"), optionalString(body.description, "description") ?? "", priority, dueDate, owner, JSON.stringify(acceptance), nonNegativeInteger(body.reviewRoundLimit ?? body.review_round_limit ?? 2, "reviewRoundLimit"), now, now, booleanInteger(body.readOnly ?? body.read_only, "readOnly"));
  return id;
}

function updateTask(database: DatabaseSync, id: string, body: Record<string, unknown>): void {
  const task = activeTask(database, id);
  const title = body.title === undefined ? task.title : requiredString(body.title, "title");
  const description = body.description === undefined ? task.description : optionalString(body.description, "description") ?? "";
  const priority = body.priority === undefined ? task.priority : enumValue(body.priority, PRIORITIES, "priority");
  const dueDate = body.dueDate === undefined && body.due_date === undefined ? task.due_date : dueDateValue(body.dueDate ?? body.due_date);
  const owner = body.ownerType === undefined && body.owner_type === undefined ? task.owner_type : enumValue(body.ownerType ?? body.owner_type, OWNERS, "ownerType");
  const acceptance = body.acceptanceCriteria === undefined && body.acceptance_json === undefined ? task.acceptance_json : JSON.stringify(array(body.acceptanceCriteria ?? body.acceptance_json, "acceptanceCriteria"));
  const limit = body.reviewRoundLimit === undefined && body.review_round_limit === undefined ? task.review_round_limit : nonNegativeInteger(body.reviewRoundLimit ?? body.review_round_limit, "reviewRoundLimit");
  const autoApprovePermissions = body.autoApprovePermissions === undefined && body.auto_approve_permissions === undefined ? task.auto_approve_permissions : booleanInteger(body.autoApprovePermissions ?? body.auto_approve_permissions, "autoApprovePermissions");
  database.prepare("UPDATE tasks SET title = ?, description = ?, priority = ?, due_date = ?, owner_type = ?, acceptance_json = ?, review_round_limit = ?, auto_approve_permissions = ?, updated_at = ? WHERE id = ?")
    .run(title, description, priority, dueDate, owner, acceptance, limit, autoApprovePermissions, new Date().toISOString(), task.id);
  if (body.labels !== undefined) setTaskLabels(database, task.id, projectIdForTask(database, task.id), body.labels);
}

function moveTask(database: DatabaseSync, id: string, body: Record<string, unknown>): void {
  const task = activeTask(database, id);
  if (body.status !== undefined) {
    const status = enumValue(body.status, ACTIVE_STATUSES, "status");
    if (status !== task.status && task.status === "done") throw conflict(`Invalid task transition: ${task.status} -> ${status}`);
    if (status === "done" && database.prepare("SELECT main_task_id FROM commissions WHERE id = ?").get(task.commission_id) && (database.prepare("SELECT main_task_id FROM commissions WHERE id = ?").get(task.commission_id) as { main_task_id: string | null }).main_task_id === task.id) throw conflict("Main task requires human acceptance before completion");
    const blockedReason = status === "blocked" ? optionalString(body.blockedReason, "blockedReason") ?? null : null;
    database.prepare("UPDATE tasks SET status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?").run(status, blockedReason, new Date().toISOString(), task.id);
    if (status === "blocked") notify(database, "blocked", `任务阻塞：${task.title}`, blockedReason ?? "任务已阻塞。", "task", task.id);
    if (status === "done") notify(database, "completed", `任务完成：${task.title}`, "任务已完成。", "task", task.id);
  }
  if (Object.hasOwn(body, "parentId") || Object.hasOwn(body, "parent_id")) {
    const parentId = nullableString(body.parentId ?? body.parent_id, "parentId", null);
    if (!parentId) throw conflict("A commission main task cannot be reparented or duplicated");
    const parent = assertParent(database, parentId, task.commission_id);
    if (parent.id === task.id || isDescendant(database, parent.id, task.id)) throw conflict("Task parent cycle");
    const oldParent = task.parent_id;
    database.prepare("UPDATE tasks SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?").run(parent.id, nextPosition(database, task.commission_id, parent.id), new Date().toISOString(), task.id);
    compactSiblings(database, task.commission_id, oldParent);
    compactSiblings(database, task.commission_id, parent.id);
    renumberCommission(database, task.commission_id);
  }
}

function reorderTask(database: DatabaseSync, id: string, body: Record<string, unknown>): void {
  const task = activeTask(database, id);
  const siblings = database.prepare("SELECT id FROM tasks WHERE commission_id = ? AND parent_id IS ? AND archived_at IS NULL ORDER BY position, created_at, rowid").all(task.commission_id, task.parent_id) as Array<{ id: string }>;
  let ids: string[];
  if (body.orderedTaskIds !== undefined || body.ordered_task_ids !== undefined) {
    ids = stringArray(body.orderedTaskIds ?? body.ordered_task_ids, "orderedTaskIds");
    if (ids.length !== siblings.length || new Set(ids).size !== ids.length || ids.some((taskId) => !siblings.some((sibling) => sibling.id === taskId))) throw badRequest("orderedTaskIds must contain every active sibling exactly once");
  } else {
    const position = nonNegativeInteger(body.position, "position");
    ids = siblings.map((sibling) => sibling.id).filter((taskId) => taskId !== task.id);
    ids.splice(Math.min(position, ids.length), 0, task.id);
  }
  const update = database.prepare("UPDATE tasks SET position = ?, updated_at = ? WHERE id = ?");
  const now = new Date().toISOString();
  ids.forEach((taskId, position) => update.run(position, now, taskId));
  renumberCommission(database, task.commission_id);
}

function setDependencies(database: DatabaseSync, taskId: string, body: Record<string, unknown>): void {
  activeTask(database, taskId);
  const many = body.dependsOnTaskIds ?? body.depends_on_task_ids;
  if (many !== undefined) return replaceDependencies(database, taskId, stringArray(many, "dependsOnTaskIds"), enumValue(body.createdBy ?? body.created_by ?? "human", ["human", "planner_agent"] as const, "createdBy"));
  const dependencyId = requiredString(body.dependencyId ?? body.dependsOnTaskId ?? body.depends_on_task_id, "dependencyId");
  replaceDependencies(database, taskId, [...dependencyIds(database, taskId), dependencyId], enumValue(body.createdBy ?? body.created_by ?? "human", ["human", "planner_agent"] as const, "createdBy"));
}

function replaceDependencies(database: DatabaseSync, taskId: string, dependencies: string[], createdBy: "human" | "planner_agent"): void {
  const task = activeTask(database, taskId);
  if (new Set(dependencies).size !== dependencies.length) throw badRequest("Dependencies must be unique");
  for (const dependencyId of dependencies) {
    if (dependencyId === task.id) throw new CycleError([task.id, task.id]);
    const dependency = activeTask(database, dependencyId);
    if (projectIdForTask(database, dependency.id) !== projectIdForTask(database, task.id)) throw conflict("Cross-project dependencies are forbidden");
  }
  database.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(task.id);
  const insert = database.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id, created_by, created_at) VALUES (?, ?, ?, ?)");
  const now = new Date().toISOString();
  for (const dependencyId of dependencies) insert.run(task.id, dependencyId, createdBy, now);
  const cycle = dependencyCycle(database, projectIdForTask(database, task.id));
  if (cycle) throw new CycleError(cycle);
}

function queryTasks(database: DatabaseSync, projectId: string, query: Record<string, string | undefined>): TaskView[] {
  const conditions = ["commission.project_id = ?"];
  const parameters: SQLInputValue[] = [projectId];
  if (query.includeArchived !== "true") conditions.push("task.archived_at IS NULL");
  for (const [field, column, values] of [["status", "task.status", STATUSES], ["priority", "task.priority", PRIORITIES]] as const) {
    if (!query[field]) continue;
    const selected = query[field]!.split(",").map((value) => enumValue(value, values, field));
    conditions.push(`${column} IN (${selected.map(() => "?").join(", ")})`);
    parameters.push(...selected);
  }
  if (query.commissionId) { conditions.push("task.commission_id = ?"); parameters.push(query.commissionId); }
  const owner = query.ownerType ?? query.owner_type;
  if (owner !== undefined) { conditions.push("task.owner_type = ?"); parameters.push(enumValue(owner, OWNERS, "ownerType")); }
  if (query.label) { conditions.push("EXISTS (SELECT 1 FROM task_labels tl JOIN labels label ON label.id = tl.label_id WHERE tl.task_id = task.id AND label.name = ?)"); parameters.push(query.label); }
  if (query.search) { conditions.push("(task.title LIKE ? OR task.description LIKE ?)"); parameters.push(`%${query.search}%`, `%${query.search}%`); }
  const rows = database.prepare(`SELECT task.* FROM tasks task JOIN commissions commission ON commission.id = task.commission_id WHERE ${conditions.join(" AND ")}`).all(...parameters) as TaskRow[];
  const views = rows.map((task) => decorateTask(database, task));
  const sort = ({ dueDate: "due_date", createdAt: "created_at", updatedAt: "updated_at" } as Record<string, string>)[query.sort ?? ""] ?? query.sort ?? "manual";
  if (!["manual", "priority", "due_date", "created_at", "updated_at"].includes(sort)) throw badRequest("Invalid sort");
  const direction = query.order === "desc" ? -1 : 1;
  return views.sort((left, right) => direction * compareTasks(left, right, sort));
}

function compareTasks(left: TaskRow, right: TaskRow, sort: string): number {
  if (sort === "manual") return compareNumberPath(left.number_path, right.number_path);
  if (sort === "priority") return (PRIORITY_RANK.get(right.priority)! - PRIORITY_RANK.get(left.priority)!) || compareNumberPath(left.number_path, right.number_path);
  const leftValue = left[sort as "due_date" | "created_at" | "updated_at"];
  const rightValue = right[sort as "due_date" | "created_at" | "updated_at"];
  if (leftValue === rightValue) return compareNumberPath(left.number_path, right.number_path);
  if (leftValue === null) return 1;
  if (rightValue === null) return -1;
  return leftValue.localeCompare(rightValue);
}

function taskTree(tasks: TaskView[]): TaskView[] {
  const copies = new Map(tasks.map((task) => [task.id, { ...task, children: [] as TaskView[] }]));
  const roots: TaskView[] = [];
  for (const task of copies.values()) {
    const parent = task.parent_id ? copies.get(task.parent_id) : undefined;
    if (parent) parent.children!.push(task); else roots.push(task);
  }
  return roots;
}

function taskView(database: DatabaseSync, id: string, includeChildren = false): TaskView {
  const task = taskById(database, id);
  const view = decorateTask(database, task);
  if (includeChildren) view.children = (database.prepare("SELECT * FROM tasks WHERE parent_id = ? ORDER BY position, created_at, rowid").all(id) as TaskRow[]).map((child) => decorateTask(database, child));
  return view;
}

function decorateTask(database: DatabaseSync, task: TaskRow): TaskView {
  return {
    ...task,
    acceptanceCriteria: JSON.parse(task.acceptance_json) as unknown[],
    labels: database.prepare("SELECT label.id, label.name, label.color FROM labels label JOIN task_labels tl ON tl.label_id = label.id WHERE tl.task_id = ? ORDER BY label.name").all(task.id) as TaskView["labels"],
    dependencyIds: dependencyIds(database, task.id),
    latestRunStatus: (database.prepare("SELECT status FROM runs WHERE task_id = ? ORDER BY attempt_no DESC, rowid DESC LIMIT 1").get(task.id) as { status: string } | undefined)?.status ?? null
  };
}

function setTaskLabels(database: DatabaseSync, taskId: string, projectId: string, value: unknown): void {
  if (value === undefined) return;
  const labels = array(value, "labels").map((item, index) => typeof item === "string" ? { name: requiredString(item, `labels[${index}]`), color: "#808080" } : { name: requiredString(record(item, `labels[${index}]`).name, `labels[${index}].name`), color: colorValue(record(item, `labels[${index}]`).color) });
  const names = new Set<string>();
  database.prepare("DELETE FROM task_labels WHERE task_id = ?").run(taskId);
  for (const label of labels) {
    if (names.has(label.name)) continue;
    names.add(label.name);
    let row = database.prepare("SELECT id FROM labels WHERE project_id = ? AND name = ?").get(projectId, label.name) as { id: string } | undefined;
    if (!row) {
      row = { id: randomUUID() };
      database.prepare("INSERT INTO labels (id, project_id, name, color) VALUES (?, ?, ?, ?)").run(row.id, projectId, label.name, label.color);
    }
    database.prepare("INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)").run(taskId, row.id);
  }
}

function dependencyCycle(database: DatabaseSync, projectId: string): string[] | null {
  const edges = database.prepare(`SELECT dependency.task_id, dependency.depends_on_task_id FROM task_dependencies dependency JOIN tasks task ON task.id = dependency.task_id JOIN commissions commission ON commission.id = task.commission_id WHERE commission.project_id = ?`).all(projectId) as Array<{ task_id: string; depends_on_task_id: string }>;
  const graph = new Map<string, string[]>();
  for (const edge of edges) graph.set(edge.task_id, [...(graph.get(edge.task_id) ?? []), edge.depends_on_task_id]);
  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    if (active.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (visited.has(id)) return null;
    active.add(id); path.push(id);
    for (const next of graph.get(id) ?? []) { const cycle = visit(next); if (cycle) return cycle; }
    path.pop(); active.delete(id); visited.add(id);
    return null;
  };
  for (const id of graph.keys()) { const cycle = visit(id); if (cycle) return cycle; }
  return null;
}

function renumberCommission(database: DatabaseSync, commissionId: string): void {
  const rows = database.prepare("SELECT id, parent_id, position FROM tasks WHERE commission_id = ? AND archived_at IS NULL ORDER BY position, created_at, rowid").all(commissionId) as Array<{ id: string; parent_id: string | null; position: number }>;
  const children = new Map<string | null, typeof rows>();
  for (const row of rows) children.set(row.parent_id, [...(children.get(row.parent_id) ?? []), row]);
  const update = database.prepare("UPDATE tasks SET number_path = ? WHERE id = ?");
  const visit = (parentId: string | null, prefix: string) => (children.get(parentId) ?? []).forEach((task, index) => {
    const number = prefix ? `${prefix}.${index + 1}` : `${index + 1}`;
    if (task.position !== index) database.prepare("UPDATE tasks SET position = ? WHERE id = ?").run(index, task.id);
    update.run(number, task.id);
    visit(task.id, number);
  });
  visit(null, "");
}

function compactSiblings(database: DatabaseSync, commissionId: string, parentId: string | null): void {
  const rows = database.prepare("SELECT id FROM tasks WHERE commission_id = ? AND parent_id IS ? AND archived_at IS NULL ORDER BY position, created_at, rowid").all(commissionId, parentId) as Array<{ id: string }>;
  const update = database.prepare("UPDATE tasks SET position = ? WHERE id = ?");
  rows.forEach((row, index) => update.run(index, row.id));
}

function acceptanceDetails(database: DatabaseSync, id: string) {
  const task = taskById(database, id);
  const commission = commissionForMainTask(database, task);
  const deliveryDocument = database.prepare(`SELECT document.id, version.content_markdown AS contentMarkdown, version.version_no AS versionNo
    FROM documents AS document JOIN document_versions AS version ON version.id = document.current_version_id
    WHERE document.commission_id = ? AND document.type = 'delivery'`).get(task.commission_id) ?? null;
  return {
    task: taskView(database, id, true),
    commissionStatus: commission.status,
    deliveryDocument,
    tasks: database.prepare("SELECT id, number_path, title, status, blocked_reason, human_waiver_reason FROM tasks WHERE commission_id = ? AND id <> ? AND archived_at IS NULL ORDER BY number_path").all(task.commission_id, task.id),
    runs: database.prepare("SELECT id, task_id, role, trigger_type, status, attempt_no, failure_summary FROM runs WHERE commission_id = ? ORDER BY rowid").all(task.commission_id),
    evidence: database.prepare("SELECT evidence.* FROM evidence JOIN tasks ON tasks.id = evidence.task_id WHERE tasks.commission_id = ? ORDER BY evidence.created_at, evidence.rowid").all(task.commission_id)
  };
}

function commissionForMainTask(database: DatabaseSync, task: TaskRow): CommissionRow {
  const commission = database.prepare("SELECT id, project_id, main_task_id, status, archived_at FROM commissions WHERE id = ?").get(task.commission_id) as CommissionRow | undefined;
  if (!commission || commission.archived_at) throw conflict("Commission is not active");
  if (commission.main_task_id !== task.id) throw conflict("Acceptance is only available for the main task");
  return commission;
}

function planMarkdown(main: Record<string, unknown>, tasks: Array<Record<string, unknown>>): string {
  const lines = [`## ${requiredString(main.title, "mainTask.title")}`, optionalString(main.description, "mainTask.description") ?? "", "", "## Tasks", ""];
  for (const task of tasks) lines.push(`- ${requiredString(task.clientId, "clientId")}: ${requiredString(task.title, "title")}`);
  return lines.join("\n");
}

function assertPlanParentsAcyclic(tasks: Map<string, Record<string, unknown>>): void {
  for (const start of tasks.keys()) {
    const path = new Set<string>();
    let current: string | null = start;
    while (current) {
      if (path.has(current)) throw badRequest(`Task parent cycle includes ${current}`);
      path.add(current);
      const task = tasks.get(current);
      current = task ? nullableString(task.parentClientId, "parentClientId", null) : null;
    }
  }
}

function isDescendant(database: DatabaseSync, candidateId: string, ancestorId: string): boolean {
  let current: string | null = candidateId;
  while (current) {
    if (current === ancestorId) return true;
    current = (database.prepare("SELECT parent_id FROM tasks WHERE id = ?").get(current) as { parent_id: string | null } | undefined)?.parent_id ?? null;
  }
  return false;
}

function activeCommission(database: DatabaseSync, id: string): CommissionRow {
  const commission = database.prepare("SELECT id, project_id, main_task_id, status, archived_at, lifecycle_operation FROM commissions WHERE id = ?").get(id) as CommissionRow & { lifecycle_operation: string | null } | undefined;
  if (!commission) throw notFound("Commission not found");
  if (commission.lifecycle_operation) throw conflict("Commission lifecycle operation is in progress");
  if (commission.archived_at || !["planned", "backlog", "active", "paused", "blocked", "awaiting_acceptance"].includes(commission.status)) throw conflict("Commission cannot accept tasks");
  if (!database.prepare("SELECT 1 FROM requirement_versions WHERE id = (SELECT active_requirement_version_id FROM commissions WHERE id = ?) AND commission_id = ? AND status = 'approved'").get(id, id)) throw conflict("Commission requirement is not approved");
  return commission;
}

function taskById(database: DatabaseSync, id: string): TaskRow {
  const task = database.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  if (!task) throw notFound("Task not found");
  return task;
}

function activeTask(database: DatabaseSync, id: string): TaskRow {
  const task = taskById(database, id);
  if (task.archived_at) throw conflict("Task is archived");
  const commission = database.prepare("SELECT lifecycle_operation FROM commissions WHERE id = ?").get(task.commission_id) as { lifecycle_operation: string | null } | undefined;
  if (commission?.lifecycle_operation) throw conflict("Commission lifecycle operation is in progress");
  return task;
}

function commentsWithAttachments(database: DatabaseSync, taskId: string): Array<Record<string, unknown>> {
  const comments = database.prepare("SELECT * FROM comments WHERE task_id = ? ORDER BY created_at, rowid").all(taskId) as Array<Record<string, unknown>>;
  const attachments = database.prepare("SELECT * FROM attachments WHERE task_id = ? AND comment_id IS NOT NULL ORDER BY created_at, rowid").all(taskId) as Array<Record<string, unknown>>;
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const attachment of attachments) {
    const commentId = String(attachment.comment_id);
    const items = grouped.get(commentId) ?? [];
    items.push(attachment);
    grouped.set(commentId, items);
  }
  return comments.map((comment) => ({ ...comment, attachments: comment.deleted_at ? [] : grouped.get(String(comment.id)) ?? [] }));
}

function assertParent(database: DatabaseSync, id: string, commissionId: string): TaskRow {
  const parent = activeTask(database, id);
  if (parent.commission_id !== commissionId) throw conflict("Parent task must belong to the same commission");
  return parent;
}

function projectExists(database: DatabaseSync, id: string): void {
  if (!database.prepare("SELECT 1 FROM projects WHERE id = ?").get(id)) throw notFound("Project not found");
}

function projectIdForTask(database: DatabaseSync, taskId: string): string {
  const row = database.prepare("SELECT commission.project_id FROM tasks task JOIN commissions commission ON commission.id = task.commission_id WHERE task.id = ?").get(taskId) as { project_id: string } | undefined;
  if (!row) throw notFound("Task not found");
  return row.project_id;
}

function dependencyIds(database: DatabaseSync, taskId: string): string[] {
  return (database.prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY created_at, depends_on_task_id").all(taskId) as Array<{ depends_on_task_id: string }>).map((row) => row.depends_on_task_id);
}

function nextPosition(database: DatabaseSync, commissionId: string, parentId: string | null): number {
  return (database.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM tasks WHERE commission_id = ? AND parent_id IS ? AND archived_at IS NULL").get(commissionId, parentId) as { position: number }).position;
}

function transaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try { const result = action(); database.exec("COMMIT"); return result; }
  catch (error) { database.exec("ROLLBACK"); throw error; }
}

function compareNumberPath(left: string, right: string): number {
  const a = left.split(".").map(Number); const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) { const difference = (a[index] ?? -1) - (b[index] ?? -1); if (difference) return difference; }
  return 0;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw badRequest(`${name} must be an array`);
  return value;
}

function stringArray(value: unknown, name: string): string[] { return array(value, name).map((item, index) => requiredString(item, `${name}[${index}]`)); }
function requiredHeader(value: string | string[] | undefined, name: string): string { if (Array.isArray(value)) value = value[0]; return requiredString(value, name); }
function decodedFileName(value: string): string { try { return decodeURIComponent(value); } catch { throw badRequest("x-file-name must be URI encoded"); } }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw badRequest(`${name} must be a non-empty string`); return value.trim(); }
function optionalString(value: unknown, name: string): string | undefined { if (value === undefined || value === null) return undefined; if (typeof value !== "string") throw badRequest(`${name} must be a string`); return value.trim(); }
function nullableString(value: unknown, name: string, fallback: string | null): string | null { if (value === undefined) return fallback; if (value === null) return null; return requiredString(value, name); }
function enumValue<T extends string>(value: unknown, choices: readonly T[], name: string): T { if (typeof value !== "string" || !choices.includes(value as T)) throw badRequest(`${name} must be one of: ${choices.join(", ")}`); return value as T; }
function nonNegativeInteger(value: unknown, name: string): number { if (!Number.isInteger(value) || (value as number) < 0) throw badRequest(`${name} must be a non-negative integer`); return value as number; }
function booleanInteger(value: unknown, name: string): number { if (value === undefined) return 0; if (typeof value !== "boolean") throw badRequest(`${name} must be boolean`); return value ? 1 : 0; }
function dueDateValue(value: unknown): string | null { if (value === undefined || value === null || value === "") return null; const date = requiredString(value, "dueDate"); const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date); const parsed = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null; if (!match || parsed!.toISOString().slice(0, 10) !== date) throw badRequest("dueDate must use YYYY-MM-DD"); return date; }
function colorValue(value: unknown): string { if (value === undefined) return "#808080"; const color = requiredString(value, "color"); if (!/^#[0-9a-f]{6}$/i.test(color)) throw badRequest("color must be a six-digit hex value"); return color.toLowerCase(); }
function statusError(message: string, statusCode: number): Error { return Object.assign(new Error(message), { statusCode }); }
const badRequest = (message: string) => statusError(message, 400);
const notFound = (message: string) => statusError(message, 404);
const conflict = (message: string) => statusError(message, 409);
