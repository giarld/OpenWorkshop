import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import Fastify from "fastify";
import { addTaskComment, type AgentMentionHandler } from "./comments.ts";
import { openWorkshopDatabase } from "./database.ts";
import { beginPlanRevision } from "./plan-revisions.ts";
import { registerTaskRoutes, updateCommissionAcceptance } from "./tasks.ts";

test("creates, queries, reorders, moves, labels, and archives a task tree", async () => {
  const fixture = await taskFixture();
  try {
    const response = await fixture.server.inject({
      method: "POST",
      url: `/api/commissions/${fixture.commissionA}/tasks`,
      payload: {
        mainTask: { title: "Main", description: "Delivery", priority: "high", acceptanceCriteria: ["Accepted"] },
        tasks: [
          { clientId: "A", parentClientId: null, title: "API", description: "Build API", priority: "urgent", dueDate: "2026-08-10", labels: [{ name: "backend", color: "#123456" }], ownerType: "ai", acceptanceCriteria: [], dependsOn: [] },
          { clientId: "B", parentClientId: "A", title: "Test", description: "Test API", priority: "medium", labels: ["backend"], ownerType: "human", acceptanceCriteria: [], dependsOn: ["A"] }
        ]
      }
    });
    assert.equal(response.statusCode, 201);
    const plan = response.json() as { mainTask: { id: string; status: string; number_path: string }; tasks: Array<{ id: string; status: string; number_path: string }> };
    assert.deepEqual([plan.mainTask, ...plan.tasks].map((task) => task.status), ["backlog", "backlog", "backlog"]);
    assert.deepEqual([plan.mainTask.number_path, ...plan.tasks.map((task) => task.number_path)], ["1", "1.1", "1.1.1"]);
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM comments WHERE agent_role = 'supervisor'").get() as { count: number }).count, 3);

    const extraResponse = await fixture.server.inject({ method: "POST", url: `/api/commissions/${fixture.commissionA}/tasks`, payload: { title: "Docs", priority: "low", labels: ["docs"] } });
    assert.equal(extraResponse.statusCode, 201);
    const extra = extraResponse.json() as { id: string; parent_id: string; number_path: string; status: string };
    assert.equal(extra.parent_id, plan.mainTask.id);
    assert.equal(extra.status, "backlog");
    assert.equal(extra.number_path, "1.2");

    const permissions = await fixture.server.inject({ method: "PUT", url: `/api/tasks/${extra.id}`, payload: { autoApprovePermissions: true } });
    assert.equal(permissions.statusCode, 200);
    assert.equal(permissions.json().auto_approve_permissions, 1);
    assert.equal((await fixture.server.inject({ method: "PUT", url: `/api/tasks/${extra.id}`, payload: { autoApprovePermissions: "yes" } })).statusCode, 400);

    const reorder = await fixture.server.inject({ method: "POST", url: `/api/tasks/${extra.id}/reorder`, payload: { orderedTaskIds: [extra.id, plan.tasks[0]!.id] } });
    assert.equal(reorder.statusCode, 200);
    assert.equal((await fixture.server.inject({ method: "GET", url: `/api/tasks/${extra.id}` })).json().number_path, "1.1");
    assert.equal((await fixture.server.inject({ method: "GET", url: `/api/tasks/${plan.tasks[1]!.id}` })).json().number_path, "1.2.1");

    const move = await fixture.server.inject({ method: "POST", url: `/api/tasks/${extra.id}/move`, payload: { status: "in_progress" } });
    assert.equal(move.statusCode, 200);
    assert.equal(move.json().status, "in_progress");
    const crossColumn = await fixture.server.inject({ method: "POST", url: `/api/tasks/${extra.id}/move`, payload: { status: "blocked" } });
    assert.equal(crossColumn.statusCode, 200);
    assert.equal(crossColumn.json().status, "blocked");
    assert.equal((await fixture.server.inject({ method: "GET", url: `/api/tasks/${plan.mainTask.id}` })).json().status, "backlog");
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.mainTask.id}/move`, payload: { status: "blocked" } })).statusCode, 409);

    const labeled = await fixture.server.inject({ method: "GET", url: `/api/projects/${fixture.projectId}/tasks?label=backend&sort=due_date` });
    assert.equal(labeled.statusCode, 200);
    assert.deepEqual((labeled.json() as Array<{ title: string }>).map((task) => task.title), ["API", "Test"]);
    assert.deepEqual((await fixture.server.inject({ method: "GET", url: `/api/projects/${fixture.projectId}/tasks?ownerType=human` })).json().map((task: { title: string }) => task.title), ["Test"]);
    assert.deepEqual(new Set((await fixture.server.inject({ method: "GET", url: `/api/projects/${fixture.projectId}/tasks?owner_type=ai` })).json().map((task: { title: string }) => task.title)), new Set(["Main", "Docs", "API"]));
    assert.equal((await fixture.server.inject({ method: "GET", url: `/api/projects/${fixture.projectId}/tasks?ownerType=robot` })).statusCode, 400);
    const board = (await fixture.server.inject({ method: "GET", url: `/api/projects/${fixture.projectId}/tasks?view=board` })).json() as Record<string, Array<{ id: string }>>;
    assert.ok(board.blocked.some((task) => task.id === extra.id));
    assert.ok(board.backlog.some((task) => task.id === plan.mainTask.id));

    const nonLeafArchive = await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.tasks[0]!.id}/archive` });
    assert.equal(nonLeafArchive.statusCode, 409);
    const leafArchive = await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.tasks[1]!.id}/archive` });
    assert.equal(leafArchive.statusCode, 200);
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.tasks[0]!.id}/archive` })).statusCode, 200);
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.tasks[1]!.id}/unarchive` })).statusCode, 409);
    const nonLeafUnarchive = await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.tasks[0]!.id}/unarchive` });
    assert.equal(nonLeafUnarchive.statusCode, 200);
    assert.equal(nonLeafUnarchive.json().status, "done");
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.tasks[1]!.id}/unarchive` })).statusCode, 200);
    assert.equal((await fixture.server.inject({ method: "GET", url: `/api/tasks/${plan.tasks[1]!.id}` })).json().status, "done");
    assert.equal((await fixture.server.inject({ method: "GET", url: `/api/tasks/${plan.tasks[1]!.id}` })).json().number_path, "1.2.1");

    const archived = await fixture.server.inject({ method: "POST", url: `/api/tasks/${extra.id}/archive` });
    assert.equal(archived.statusCode, 200);
    assert.equal(archived.json().status, "archived");
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE id = ?").get(extra.id) as { count: number }).count, 1);
    assert.equal((await fixture.server.inject({ method: "GET", url: `/api/projects/${fixture.projectId}/tasks` })).json().some((task: { id: string }) => task.id === extra.id), false);
  } finally {
    await fixture.close();
  }
});

test("CLI task writes stay direct but reject concurrent Runs and pending plan revisions", async () => {
  const fixture = await taskFixture();
  try {
    const plan = (await fixture.server.inject({ method: "POST", url: `/api/commissions/${fixture.commissionA}/tasks`, payload: {
      mainTask: { title: "Main", acceptanceCriteria: [] },
      tasks: [
        { clientId: "A", title: "Child", acceptanceCriteria: [], dependsOn: [] },
        { clientId: "B", title: "Parent", acceptanceCriteria: [], dependsOn: [] }
      ]
    } })).json() as { mainTask: { id: string }; tasks: Array<{ id: string }> };
    const child = plan.tasks[0]!.id;
    const parent = plan.tasks[1]!.id;
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM runs WHERE commission_id = ?").get(fixture.commissionA) as { count: number }).count, 0);

    const run = randomUUID(), now = new Date().toISOString();
    fixture.database.prepare("INSERT INTO runs (id, project_id, commission_id, task_id, role, trigger_type, status, attempt_no, config_snapshot_json, context_snapshot_json) VALUES (?, ?, ?, ?, 'developer', 'manual', 'queued', 1, '{}', '{}')")
      .run(run, fixture.projectId, fixture.commissionA, child);
    assert.equal((await fixture.server.inject({ method: "PUT", url: `/api/tasks/${child}`, payload: { title: "Blocked edit" } })).statusCode, 409);
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${child}/move`, payload: { parentId: parent } })).statusCode, 409);
    fixture.database.prepare("UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ?").run(now, run);

    const before = (fixture.database.prepare("SELECT coordination_revision FROM commissions WHERE id = ?").get(fixture.commissionA) as { coordination_revision: number }).coordination_revision;
    assert.equal((await fixture.server.inject({ method: "PUT", url: `/api/tasks/${child}`, payload: { title: "Direct CLI edit" } })).statusCode, 200);
    const after = (fixture.database.prepare("SELECT coordination_revision FROM commissions WHERE id = ?").get(fixture.commissionA) as { coordination_revision: number }).coordination_revision;
    assert.ok(after > before);
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM runs WHERE commission_id = ? AND role = 'supervisor'").get(fixture.commissionA) as { count: number }).count, 0);

    beginPlanRevision(fixture.database, fixture.commissionA, "等待人工确认");
    assert.equal((await fixture.server.inject({ method: "PUT", url: `/api/tasks/${child}`, payload: { title: "Revision race" } })).statusCode, 409);
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${child}/move`, payload: { parentId: parent } })).statusCode, 409);
  } finally { await fixture.close(); }
});

test("archives the complete task tree when the main task is archived", async () => {
  const fixture = await taskFixture();
  try {
    const response = await fixture.server.inject({
      method: "POST",
      url: `/api/commissions/${fixture.commissionA}/tasks`,
      payload: {
        mainTask: { title: "Main", acceptanceCriteria: ["Accepted"] },
        tasks: [
          { clientId: "A", parentClientId: null, title: "Child", acceptanceCriteria: [], dependsOn: [] },
          { clientId: "B", parentClientId: "A", title: "Grandchild", acceptanceCriteria: [], dependsOn: [] }
        ]
      }
    });
    assert.equal(response.statusCode, 201);
    const plan = response.json() as { mainTask: { id: string }; tasks: Array<{ id: string }> };
    const ids = [plan.mainTask.id, ...plan.tasks.map((task) => task.id)];
    fixture.database.prepare(`UPDATE tasks SET status = 'done' WHERE id IN (${ids.map(() => "?").join(", ")})`).run(...ids);

    const external = (await fixture.server.inject({ method: "POST", url: `/api/commissions/${fixture.commissionB}/tasks`, payload: { title: "External dependent" } })).json() as { id: string };
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${external.id}/dependencies`, payload: { dependsOnTaskIds: [plan.tasks[0]!.id] } })).statusCode, 200);
    const blockedArchive = await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.mainTask.id}/archive` });
    assert.equal(blockedArchive.statusCode, 409);
    assert.match(blockedArchive.json().message, /still required/);
    assert.ok((fixture.database.prepare(`SELECT status FROM tasks WHERE id IN (${ids.map(() => "?").join(", ")})`).all(...ids) as Array<{ status: string }>).every((task) => task.status === "done"));
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${external.id}/archive` })).statusCode, 200);

    const archived = await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.mainTask.id}/archive` });
    assert.equal(archived.statusCode, 200);
    assert.equal(archived.json().status, "archived");
    const rows = fixture.database.prepare(`SELECT id, status, archived_at FROM tasks WHERE id IN (${ids.map(() => "?").join(", ")})`).all(...ids) as Array<{ id: string; status: string; archived_at: string | null }>;
    assert.equal(rows.length, 3);
    assert.ok(rows.every((task) => task.status === "archived" && task.archived_at));

    const historicalAcceptance = await fixture.server.inject({ method: "GET", url: `/api/tasks/${plan.mainTask.id}/acceptance` });
    assert.equal(historicalAcceptance.statusCode, 200);
    assert.equal(historicalAcceptance.json().task.status, "archived");
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.mainTask.id}/accept` })).statusCode, 409);
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.mainTask.id}/reject`, payload: { reason: "Archived tasks are read-only" } })).statusCode, 409);

    const unarchived = await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.mainTask.id}/unarchive` });
    assert.equal(unarchived.statusCode, 200);
    assert.equal(unarchived.json().status, "done");
    const restored = fixture.database.prepare(`SELECT id, status, archived_at FROM tasks WHERE id IN (${ids.map(() => "?").join(", ")})`).all(...ids) as Array<{ id: string; status: string; archived_at: string | null }>;
    assert.ok(restored.every((task) => task.status === "done" && task.archived_at === null));
  } finally {
    await fixture.close();
  }
});

test("supports issue-style replies, @Agent routing, and AI mentions of the human owner", async () => {
  const mentions: string[] = [];
  const fixture = await taskFixture(async (_taskId, message) => { mentions.push(message); return { action: "steered", runId: "run-1" }; });
  try {
    const task = (await fixture.server.inject({ method: "POST", url: `/api/commissions/${fixture.commissionA}/tasks`, payload: { title: "Discuss", ownerType: "ai" } })).json() as { id: string };
    const root = await fixture.server.inject({ method: "POST", url: `/api/tasks/${task.id}/comments`, payload: { content: "@Agent 请检查边界" } });
    assert.equal(root.statusCode, 201);
    assert.equal(root.json().agentMention.action, "steered");
    assert.deepEqual(mentions, ["@Agent 请检查边界"]);
    const reply = await fixture.server.inject({ method: "POST", url: `/api/tasks/${task.id}/comments`, payload: { content: "补充说明", parentId: root.json().id } });
    assert.equal(reply.statusCode, 201);
    assert.equal(reply.json().parent_id, root.json().id);
    assert.equal((await fixture.server.inject({ method: "DELETE", url: `/api/tasks/${task.id}/comments/${root.json().id}` })).statusCode, 204);
    const deletedRoot = (await fixture.server.inject({ method: "GET", url: `/api/tasks/${task.id}/comments` })).json().find((comment: { id: string }) => comment.id === root.json().id);
    assert.equal(deletedRoot.content, "");
    assert.ok(deletedRoot.deleted_at);
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM comments WHERE parent_id = ?").get(root.json().id) as { count: number }).count, 1);

    addTaskComment(fixture.database, { taskId: task.id, authorType: "agent", agentRole: "developer", content: "@负责人 请确认风险。" });
    assert.equal((fixture.database.prepare("SELECT kind FROM notifications WHERE entity_type = 'task' AND entity_id = ? ORDER BY rowid DESC LIMIT 1").get(task.id) as { kind: string }).kind, "mention");
    fixture.database.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${task.id}/archive` })).statusCode, 200);
    const archivedComments = await fixture.server.inject({ method: "GET", url: `/api/tasks/${task.id}/comments` });
    assert.equal(archivedComments.statusCode, 200);
    assert.equal(archivedComments.json().length, 3);
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${task.id}/comments`, payload: { content: "不应写入归档任务" } })).statusCode, 409);
  } finally { await fixture.close(); }
});

test("uploads attachments for comments and forwards them with @Agent mentions", async () => {
  const mentions: Array<{ message: string; attachmentIds: readonly string[] }> = [];
  const fixture = await taskFixture(async (_taskId, message, attachmentIds = []) => { mentions.push({ message, attachmentIds }); return { action: "steered", runId: "run-1" }; });
  try {
    const task = (await fixture.server.inject({ method: "POST", url: `/api/commissions/${fixture.commissionA}/tasks`, payload: { title: "Discuss files", ownerType: "ai" } })).json() as { id: string };
    const uploaded = await fixture.server.inject({ method: "POST", url: `/api/tasks/${task.id}/attachments`, headers: { "content-type": "text/plain", "x-file-name": encodeURIComponent("notes.txt") }, payload: Buffer.from("attachment body") });
    assert.equal(uploaded.statusCode, 201);
    const attachment = uploaded.json() as { id: string };
    const comment = await fixture.server.inject({ method: "POST", url: `/api/tasks/${task.id}/comments`, payload: { content: "@Agent 请阅读附件", attachmentIds: [attachment.id] } });
    assert.equal(comment.statusCode, 201);
    assert.equal(comment.json().attachments[0].original_name, "notes.txt");
    assert.deepEqual(mentions, [{ message: "@Agent 请阅读附件", attachmentIds: [attachment.id] }]);

    const comments = await fixture.server.inject({ method: "GET", url: `/api/tasks/${task.id}/comments` });
    assert.equal(comments.json().at(-1).attachments[0].id, attachment.id);
    const downloaded = await fixture.server.inject({ method: "GET", url: `/api/tasks/${task.id}/attachments/${attachment.id}` });
    assert.equal(downloaded.body, "attachment body");
    assert.equal(downloaded.headers["x-content-type-options"], "nosniff");
    const storedPath = (fixture.database.prepare("SELECT storage_path FROM attachments WHERE id = ?").get(attachment.id) as { storage_path: string }).storage_path;
    assert.equal((await readFile(storedPath, "utf8")), "attachment body");
    assert.equal((await fixture.server.inject({ method: "DELETE", url: `/api/tasks/${task.id}/attachments/${attachment.id}` })).statusCode, 400);
  } finally { await fixture.close(); }
});

test("rejects attachment MIME spoofing and prevents reusing a comment attachment", async () => {
  const fixture = await taskFixture();
  try {
    const task = (await fixture.server.inject({ method: "POST", url: `/api/commissions/${fixture.commissionA}/tasks`, payload: { title: "Attachment ownership" } })).json() as { id: string };
    const spoofed = await fixture.server.inject({ method: "POST", url: `/api/tasks/${task.id}/attachments`, headers: { "content-type": "image/png", "x-file-name": encodeURIComponent("notes.txt") }, payload: Buffer.from("not an image") });
    assert.equal(spoofed.statusCode, 400);
    const fakeImage = await fixture.server.inject({ method: "POST", url: `/api/tasks/${task.id}/attachments`, headers: { "content-type": "image/png", "x-file-name": encodeURIComponent("screen.png") }, payload: Buffer.from("not an image") });
    assert.equal(fakeImage.statusCode, 400);

    const uploaded = await fixture.server.inject({ method: "POST", url: `/api/tasks/${task.id}/attachments`, headers: { "content-type": "text/plain", "x-file-name": encodeURIComponent("notes.txt") }, payload: Buffer.from("attachment body") });
    const attachmentId = String(uploaded.json().id);
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${task.id}/comments`, payload: { content: "First", attachmentIds: [attachmentId] } })).statusCode, 201);
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${task.id}/comments`, payload: { content: "Second", attachmentIds: [attachmentId] } })).statusCode, 400);
  } finally { await fixture.close(); }
});

test("hides attachments that only belong to a deleted comment", async () => {
  const fixture = await taskFixture();
  try {
    const task = (await fixture.server.inject({ method: "POST", url: `/api/commissions/${fixture.commissionA}/tasks`, payload: { title: "Deleted attachment" } })).json() as { id: string };
    const uploaded = await fixture.server.inject({ method: "POST", url: `/api/tasks/${task.id}/attachments`, headers: { "content-type": "text/plain", "x-file-name": encodeURIComponent("notes.txt") }, payload: Buffer.from("attachment body") });
    const attachmentId = String(uploaded.json().id);
    const comment = await fixture.server.inject({ method: "POST", url: `/api/tasks/${task.id}/comments`, payload: { content: "Temporary", attachmentIds: [attachmentId] } });
    assert.equal((await fixture.server.inject({ method: "GET", url: `/api/tasks/${task.id}/attachments/${attachmentId}` })).statusCode, 200);
    assert.equal((await fixture.server.inject({ method: "DELETE", url: `/api/tasks/${task.id}/comments/${comment.json().id}` })).statusCode, 204);
    assert.equal((await fixture.server.inject({ method: "GET", url: `/api/tasks/${task.id}/attachments/${attachmentId}` })).statusCode, 404);
    const deleted = (await fixture.server.inject({ method: "GET", url: `/api/tasks/${task.id}/comments` })).json().find((item: { id: string }) => item.id === comment.json().id);
    assert.deepEqual(deleted.attachments, []);
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM attachments WHERE id = ?").get(attachmentId) as { count: number }).count, 1);
  } finally { await fixture.close(); }
});

test("keeps a saved comment and its attachments when @Agent routing fails", async () => {
  const fixture = await taskFixture(async () => { throw new Error("runtime offline"); });
  try {
    const task = (await fixture.server.inject({ method: "POST", url: `/api/commissions/${fixture.commissionA}/tasks`, payload: { title: "Unavailable Agent", ownerType: "ai" } })).json() as { id: string };
    const uploaded = await fixture.server.inject({ method: "POST", url: `/api/tasks/${task.id}/attachments`, headers: { "content-type": "text/plain", "x-file-name": encodeURIComponent("notes.txt") }, payload: Buffer.from("attachment body") });
    const attachmentId = String(uploaded.json().id);
    const comment = await fixture.server.inject({ method: "POST", url: `/api/tasks/${task.id}/comments`, payload: { content: "@Agent 稍后处理", attachmentIds: [attachmentId] } });
    assert.equal(comment.statusCode, 201);
    assert.equal(comment.json().agentMention.action, "unavailable");
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM comments WHERE task_id = ? AND content = ?").get(task.id, "@Agent 稍后处理") as { count: number }).count, 1);
    assert.ok((fixture.database.prepare("SELECT comment_id FROM attachments WHERE id = ?").get(attachmentId) as { comment_id: string | null }).comment_id);
  } finally { await fixture.close(); }
});

test("allows cross-commission dependencies and rolls back cycles with their path", async () => {
  const fixture = await taskFixture();
  try {
    const first = (await fixture.server.inject({ method: "POST", url: `/api/commissions/${fixture.commissionA}/tasks`, payload: { title: "First" } })).json() as { id: string };
    const second = (await fixture.server.inject({ method: "POST", url: `/api/commissions/${fixture.commissionB}/tasks`, payload: { title: "Second" } })).json() as { id: string };
    const crossCommission = await fixture.server.inject({ method: "POST", url: `/api/tasks/${first.id}/dependencies`, payload: { dependsOnTaskIds: [second.id] } });
    assert.equal(crossCommission.statusCode, 200);
    assert.deepEqual(crossCommission.json().dependencyIds, [second.id]);

    const cycle = await fixture.server.inject({ method: "POST", url: `/api/tasks/${second.id}/dependencies`, payload: { dependsOnTaskIds: [first.id] } });
    assert.equal(cycle.statusCode, 409);
    const error = cycle.json() as { error: string; path: string[] };
    assert.equal(error.error, "Dependency cycle");
    assert.equal(error.path[0], error.path.at(-1));
    assert.deepEqual(new Set(error.path.slice(0, -1)), new Set([first.id, second.id]));
    assert.deepEqual((await fixture.server.inject({ method: "GET", url: `/api/tasks/${second.id}` })).json().dependencyIds, []);
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM task_dependencies").get() as { count: number }).count, 1);

    const otherRoot = randomUUID();
    const otherProject = randomUUID();
    const otherCommission = seedApprovedCommission(fixture.database, otherRoot, otherProject);
    const otherTask = (await fixture.server.inject({ method: "POST", url: `/api/commissions/${otherCommission}/tasks`, payload: { title: "Other project" } })).json() as { id: string };
    const crossProject = await fixture.server.inject({ method: "POST", url: `/api/tasks/${second.id}/dependencies`, payload: { dependsOnTaskIds: [otherTask.id] } });
    assert.equal(crossProject.statusCode, 409);
    assert.match(crossProject.json().message, /Cross-project dependencies/);
    assert.deepEqual((await fixture.server.inject({ method: "GET", url: `/api/tasks/${second.id}` })).json().dependencyIds, []);
  } finally {
    await fixture.close();
  }
});

test("human waiver requests final coordination before main-task acceptance", async () => {
  const handler = (async () => ({ action: "unavailable" as const })) as AgentMentionHandler;
  const fixture = await taskFixture(handler);
  const coordinated: string[] = [];
  handler.coordinateFinal = async (commissionId) => { coordinated.push(commissionId); return true; };
  try {
    const response = await fixture.server.inject({ method: "POST", url: `/api/commissions/${fixture.commissionA}/tasks`, payload: {
      mainTask: { title: "Main", acceptanceCriteria: ["Human approval"] },
      tasks: [
        { clientId: "T1", parentClientId: null, title: "Child", acceptanceCriteria: ["Reviewed"], dependsOn: [] },
        { clientId: "T2", parentClientId: null, title: "Archived child", acceptanceCriteria: ["Historical"], dependsOn: [] }
      ]
    } });
    const plan = response.json() as { mainTask: { id: string }; tasks: Array<{ id: string }> };
    fixture.database.prepare("UPDATE commissions SET status = 'active' WHERE id = ?").run(fixture.commissionA);
    fixture.database.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(plan.tasks[1]!.id);
    const archivedRun = randomUUID();
    fixture.database.prepare("INSERT INTO runs (id, project_id, commission_id, task_id, role, trigger_type, status, attempt_no, config_snapshot_json, context_snapshot_json) SELECT ?, project_id, id, ?, 'reviewer', 'review', 'succeeded', 1, '{}', '{}' FROM commissions WHERE id = ?")
      .run(archivedRun, plan.tasks[1]!.id, fixture.commissionA);
    fixture.database.prepare("INSERT INTO evidence (id, task_id, run_id, criterion_key, type, status, summary, payload_json, created_at) VALUES (?, ?, ?, '*', 'review', 'failed', 'Archived evidence must be excluded', '{}', ?)")
      .run(randomUUID(), plan.tasks[1]!.id, archivedRun, new Date().toISOString());
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.tasks[1]!.id}/archive` })).statusCode, 200);
    const waived = await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.tasks[0]!.id}/waive`, payload: { reason: "Verified externally" } });
    assert.equal(waived.statusCode, 200);
    assert.equal(waived.json().human_waiver_reason, "Verified externally");
    const repeatedDone = await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.tasks[0]!.id}/move`, payload: { status: "done" } });
    assert.equal(repeatedDone.statusCode, 200);
    assert.equal(repeatedDone.json().human_waiver_reason, "Verified externally");
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM evidence WHERE task_id = ? AND type = 'human_waiver'").get(plan.tasks[0]!.id) as { count: number }).count, 1);
    assert.equal((fixture.database.prepare("SELECT status FROM commissions WHERE id = ?").get(fixture.commissionA) as { status: string }).status, "active");
    assert.deepEqual(coordinated, [fixture.commissionA]);
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM documents WHERE commission_id = ? AND type = 'plan'").get(fixture.commissionA) as { count: number }).count, 1);
    assert.match((fixture.database.prepare("SELECT content FROM comments WHERE task_id = ? ORDER BY rowid DESC LIMIT 1").get(plan.mainTask.id) as { content: string }).content, /@任务1\.1[\s\S]*人工豁免/);

    assert.equal(updateCommissionAcceptance(fixture.database, fixture.commissionA), true);
    const acceptance = await fixture.server.inject({ method: "GET", url: `/api/tasks/${plan.mainTask.id}/acceptance` });
    assert.equal(acceptance.statusCode, 200);
    assert.equal(acceptance.json().runs.length, 0);
    assert.equal(acceptance.json().evidence.length, 1);
    assert.equal(acceptance.json().evidence[0].status, "waived");
    assert.match(acceptance.json().deliveryDocument.contentMarkdown, /## 变更摘要[\s\S]*## 文件清单[\s\S]*## 已知风险[\s\S]*## 未完成项[\s\S]*## 人工操作/);
    assert.doesNotMatch(acceptance.json().deliveryDocument.contentMarkdown, /Archived child/);
    assert.doesNotMatch(acceptance.json().deliveryDocument.contentMarkdown, /Archived evidence must be excluded/);
    const rejected = await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.mainTask.id}/reject`, payload: { reason: "补充交付说明" } });
    assert.equal(rejected.statusCode, 200);
    assert.equal((fixture.database.prepare("SELECT status FROM tasks WHERE id = ?").get(plan.tasks[0]!.id) as { status: string }).status, "todo");
    assert.equal((fixture.database.prepare("SELECT kind FROM comments WHERE task_id = ? ORDER BY rowid DESC LIMIT 1").get(plan.mainTask.id) as { kind: string }).kind, "rejection");
    assert.match(currentDelivery(fixture.database, fixture.commissionA).content_markdown, /已拒绝：补充交付说明/);
    await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.tasks[0]!.id}/waive`, payload: { reason: "返工已复核" } });
    assert.equal(updateCommissionAcceptance(fixture.database, fixture.commissionA), true);
    const accepted = await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.mainTask.id}/accept` });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().status, "done");
    assert.equal((fixture.database.prepare("SELECT status FROM commissions WHERE id = ?").get(fixture.commissionA) as { status: string }).status, "done");
    const delivery = currentDelivery(fixture.database, fixture.commissionA);
    assert.ok(delivery.version_no > 1);
    assert.match(delivery.content_markdown, /## 人工验收结果\n\n- 已批准。/);
  } finally { await fixture.close(); }
});

test("manually completing the final child requests final coordination", async () => {
  const handler = (async () => ({ action: "unavailable" as const })) as AgentMentionHandler;
  const fixture = await taskFixture(handler);
  const coordinated: string[] = [];
  handler.coordinateFinal = async (commissionId) => { coordinated.push(commissionId); return true; };
  try {
    const response = await fixture.server.inject({ method: "POST", url: `/api/commissions/${fixture.commissionA}/tasks`, payload: {
      mainTask: { title: "Main", acceptanceCriteria: ["Human approval"] },
      tasks: [
        { clientId: "T1", parentClientId: null, title: "Completed child", acceptanceCriteria: ["Reviewed"], dependsOn: [] },
        { clientId: "T2", parentClientId: null, title: "Manual child", acceptanceCriteria: ["Checked"], dependsOn: ["T1"] }
      ]
    } });
    const plan = response.json() as { mainTask: { id: string }; tasks: Array<{ id: string }> };
    fixture.database.prepare("UPDATE commissions SET status = 'active' WHERE id = ?").run(fixture.commissionA);
    fixture.database.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(plan.mainTask.id);
    fixture.database.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(plan.tasks[0]!.id);

    const moved = await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.tasks[1]!.id}/move`, payload: { status: "done" } });

    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().status, "done");
    assert.equal((fixture.database.prepare("SELECT status FROM commissions WHERE id = ?").get(fixture.commissionA) as { status: string }).status, "active");
    assert.equal((fixture.database.prepare("SELECT status FROM tasks WHERE id = ?").get(plan.mainTask.id) as { status: string }).status, "in_progress");
    assert.deepEqual(coordinated, [fixture.commissionA]);
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM notifications WHERE entity_type = 'task' AND entity_id = ? AND kind = 'acceptance'").get(plan.mainTask.id) as { count: number }).count, 0);
    assert.equal((fixture.database.prepare("SELECT COUNT(*) AS count FROM documents WHERE commission_id = ? AND type = 'delivery'").get(fixture.commissionA) as { count: number }).count, 0);
  } finally { await fixture.close(); }
});

test("moving work to In Progress coordinates on the server except for human child tasks", async () => {
  const handler = (async () => ({ action: "unavailable" as const })) as AgentMentionHandler;
  const fixture = await taskFixture(handler);
  const coordinated: string[] = [];
  handler.coordinateTask = async (taskId) => { coordinated.push(taskId); };
  try {
    const response = await fixture.server.inject({ method: "POST", url: `/api/commissions/${fixture.commissionA}/tasks`, payload: {
      mainTask: { title: "Main" },
      tasks: [
        { clientId: "AI", parentClientId: null, title: "AI child", ownerType: "ai", dependsOn: [] },
        { clientId: "H", parentClientId: null, title: "Human child", ownerType: "human", dependsOn: [] }
      ]
    } });
    const plan = response.json() as { mainTask: { id: string }; tasks: Array<{ id: string }> };

    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.mainTask.id}/move`, payload: { status: "in_progress" } })).statusCode, 200);
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.tasks[0]!.id}/move`, payload: { status: "in_progress" } })).statusCode, 200);
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.tasks[1]!.id}/move`, payload: { status: "in_progress" } })).statusCode, 200);
    assert.deepEqual(coordinated, [plan.mainTask.id, plan.mainTask.id]);
  } finally { await fixture.close(); }
});

test("a failed coordination attempt leaves a durable pending revision after the state move", async () => {
  const handler = (async () => ({ action: "unavailable" as const })) as AgentMentionHandler;
  const fixture = await taskFixture(handler);
  handler.coordinateTask = async () => { throw new Error("Coordinator unavailable"); };
  try {
    const response = await fixture.server.inject({ method: "POST", url: `/api/commissions/${fixture.commissionA}/tasks`, payload: {
      mainTask: { title: "Main" },
      tasks: [{ clientId: "AI", parentClientId: null, title: "AI child", ownerType: "ai", dependsOn: [] }]
    } });
    const plan = response.json() as { mainTask: { id: string }; tasks: Array<{ id: string }> };

    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.tasks[0]!.id}/move`, payload: { status: "in_progress" } })).statusCode, 500);
    assert.equal((fixture.database.prepare("SELECT status FROM tasks WHERE id = ?").get(plan.tasks[0]!.id) as { status: string }).status, "in_progress");
    assert.equal((fixture.database.prepare("SELECT coordination_pending FROM commissions WHERE id = ?").get(fixture.commissionA) as { coordination_pending: number }).coordination_pending, 1);

    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.tasks[0]!.id}/move`, payload: { status: "todo" } })).statusCode, 200);
    assert.equal((fixture.database.prepare("SELECT coordination_pending FROM commissions WHERE id = ?").get(fixture.commissionA) as { coordination_pending: number }).coordination_pending, 1);
  } finally { await fixture.close(); }
});

test("server cancels a reserved Run before moving its task across columns", async () => {
  const handler = (async () => ({ action: "unavailable" as const })) as AgentMentionHandler;
  const fixture = await taskFixture(handler);
  const cancelled: string[] = [];
  handler.cancelTaskRun = async (taskId) => {
    cancelled.push(taskId);
    fixture.database.prepare("UPDATE runs SET status = 'cancelled', finished_at = ? WHERE task_id = ? AND status IN ('queued', 'preparing', 'running', 'waiting_approval', 'waiting_input')").run(new Date().toISOString(), taskId);
    return true;
  };
  try {
    const response = await fixture.server.inject({ method: "POST", url: `/api/commissions/${fixture.commissionA}/tasks`, payload: {
      mainTask: { title: "Main" },
      tasks: [{ clientId: "T1", parentClientId: null, title: "Child", dependsOn: [] }]
    } });
    const plan = response.json() as { mainTask: { id: string }; tasks: Array<{ id: string }> };
    fixture.database.prepare("UPDATE commissions SET status = 'active' WHERE id = ?").run(fixture.commissionA);
    fixture.database.prepare("UPDATE tasks SET status = 'in_progress' WHERE id IN (?, ?)").run(plan.mainTask.id, plan.tasks[0]!.id);
    fixture.database.prepare("INSERT INTO runs (id, project_id, commission_id, task_id, role, trigger_type, status, attempt_no, config_snapshot_json, context_snapshot_json) SELECT ?, project_id, id, ?, 'developer', 'scheduler', 'running', 1, '{}', '{}' FROM commissions WHERE id = ?")
      .run(randomUUID(), plan.tasks[0]!.id, fixture.commissionA);

    const moved = await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.tasks[0]!.id}/move`, payload: { status: "todo", boardMove: true } });

    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().status, "todo");
    assert.deepEqual(cancelled, [plan.tasks[0]!.id]);
    assert.equal((fixture.database.prepare("SELECT status FROM runs WHERE task_id = ?").get(plan.tasks[0]!.id) as { status: string }).status, "cancelled");
  } finally { await fixture.close(); }
});

test("board moves can reopen a child for main-task coordination", async () => {
  const fixture = await taskFixture();
  try {
    const response = await fixture.server.inject({ method: "POST", url: `/api/commissions/${fixture.commissionA}/tasks`, payload: {
      mainTask: { title: "Main", acceptanceCriteria: ["Human approval"] },
      tasks: [{ clientId: "T1", parentClientId: null, title: "Child", acceptanceCriteria: ["Reviewed"], dependsOn: [] }]
    } });
    const plan = response.json() as { mainTask: { id: string }; tasks: Array<{ id: string }> };
    fixture.database.prepare("UPDATE commissions SET status = 'awaiting_acceptance' WHERE id = ?").run(fixture.commissionA);
    fixture.database.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(plan.mainTask.id);
    fixture.database.prepare("UPDATE tasks SET status = 'done', human_waiver_reason = 'stale' WHERE id = ?").run(plan.tasks[0]!.id);

    const moved = await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.tasks[0]!.id}/move`, payload: { status: "todo", boardMove: true } });

    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().status, "todo");
    assert.equal(moved.json().human_waiver_reason, null);
    assert.equal((fixture.database.prepare("SELECT status FROM commissions WHERE id = ?").get(fixture.commissionA) as { status: string }).status, "active");
    fixture.database.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(plan.mainTask.id);
    assert.equal((await fixture.server.inject({ method: "POST", url: `/api/tasks/${plan.tasks[0]!.id}/move`, payload: { status: "in_progress", boardMove: true } })).statusCode, 409);
  } finally { await fixture.close(); }
});

async function taskFixture(mentionAgent?: AgentMentionHandler) {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-tasks-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  registerTaskRoutes(server, database, mentionAgent, join(home, "attachments"));
  const rootId = randomUUID();
  const projectId = randomUUID();
  const commissionA = seedApprovedCommission(database, rootId, projectId);
  const commissionB = seedApprovedCommission(database, rootId, projectId);
  return {
    home, database, server, projectId, commissionA, commissionB,
    close: async () => { await server.close(); database.close(); await rm(home, { recursive: true, force: true }); }
  };
}

function seedApprovedCommission(database: DatabaseSync, rootId: string, projectId: string): string {
  const now = new Date().toISOString();
  if (!database.prepare("SELECT 1 FROM root_paths WHERE id = ?").get(rootId)) {
    database.prepare("INSERT INTO root_paths (id, path, real_path, enabled, created_at, updated_at) VALUES (?, 'root', ?, 1, ?, ?)").run(rootId, `root-${rootId}`, now, now);
    database.prepare("INSERT INTO projects (id, name, path, real_path, root_path_id, vcs_type, created_at, updated_at) VALUES (?, 'Project', ?, ?, ?, 'none', ?, ?)").run(projectId, `project-${projectId}`, `project-${projectId}`, rootId, now, now);
  }
  const commissionId = randomUUID();
  const requirementId = randomUUID();
  database.prepare("INSERT INTO commissions (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, 'Commission', 'planned', ?, ?)").run(commissionId, projectId, now, now);
  database.prepare("INSERT INTO requirement_versions (id, commission_id, version_no, content_markdown, acceptance_json, status, created_by, created_at, approved_at) VALUES (?, ?, 1, 'Requirement', '[]', 'approved', 'human', ?, ?)").run(requirementId, commissionId, now, now);
  database.prepare("UPDATE commissions SET active_requirement_version_id = ? WHERE id = ?").run(requirementId, commissionId);
  return commissionId;
}

function currentDelivery(database: DatabaseSync, commissionId: string): { version_no: number; content_markdown: string } {
  return database.prepare("SELECT version.version_no, version.content_markdown FROM documents AS document JOIN document_versions AS version ON version.id = document.current_version_id WHERE document.commission_id = ? AND document.type = 'delivery'").get(commissionId) as { version_no: number; content_markdown: string };
}
