import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { openWorkshopDatabase } from "./database.ts";
import { answerRevisionCard, beginPlanRevision, createRevisionCard, publishRevisionConfirmation, saveRevisionProposal } from "./plan-revisions.ts";
import { createTaskPlan, registerTaskRoutes } from "./tasks.ts";
import { parsePlanRevisionDecision, parsePlanRevisionReview } from "./scheduler.ts";

test("parses supervisor plan-revision and independent review contracts", () => {
  assert.equal(parsePlanRevisionDecision('{"action":"ask","question":{"type":"text","prompt":"需要什么方向？","options":[]}}').action, "ask");
  assert.throws(() => parsePlanRevisionDecision('{"action":"ask","question":{"type":"boolean","prompt":"选择？","options":["一","二","三"]}}'), /exactly two/);
  assert.equal(parsePlanRevisionDecision('{"action":"review","proposal":{"summary":"调整","changes":[{"action":"delete","taskId":"task-1","reason":"失效"}]}}').action, "review");
  assert.deepEqual(parsePlanRevisionDecision('{"action":"review","proposal":{"summary":"调整字段","changes":[{"action":"create","clientId":"new","title":"新增","dueDate":"2026-09-01","readOnly":true},{"action":"update","taskId":"task-1","readOnly":false}]}}'), { action: "review", proposal: { summary: "调整字段", changes: [
    { action: "create", clientId: "new", title: "新增", dueDate: "2026-09-01", readOnly: true },
    { action: "update", taskId: "task-1", readOnly: false }
  ] } });
  assert.deepEqual(parsePlanRevisionReview('{"approved":true,"summary":"审查通过"}'), { approved: true, summary: "审查通过" });
  assert.deepEqual(parsePlanRevisionReview('{"approved":false,"summary":"缺少精确差异","question":{"type":"boolean","prompt":"是否重新提交？","options":[]}}'), { approved: false, summary: "缺少精确差异" });
});

test("collects all card forms and applies a reviewed task revision without exposing deleted tasks to execution", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-plan-revision-"));
  const database = await openWorkshopDatabase(home);
  try {
    const root = randomUUID(), project = randomUUID(), commission = randomUUID(), requirement = randomUUID(), now = new Date().toISOString();
    database.prepare("INSERT INTO root_paths (id, path, real_path, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)").run(root, home, home, now, now);
    database.prepare("INSERT INTO projects (id, root_path_id, name, path, real_path, vcs_type, created_at, updated_at) VALUES (?, ?, 'Project', '.', ?, 'none', ?, ?)").run(project, root, home, now, now);
    database.prepare("INSERT INTO commissions (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, 'Commission', 'planned', ?, ?)").run(commission, project, now, now);
    database.prepare("INSERT INTO requirement_versions (id, commission_id, version_no, content_markdown, acceptance_json, status, created_by, created_at, approved_at) VALUES (?, ?, 1, 'Requirement', '[]', 'approved', 'human', ?, ?)").run(requirement, commission, now, now);
    database.prepare("UPDATE commissions SET active_requirement_version_id = ? WHERE id = ?").run(requirement, commission);
    const plan = createTaskPlan(database, commission, {
      mainTask: { title: "Main", acceptanceCriteria: [] },
      tasks: [
        { clientId: "A", title: "Keep", acceptanceCriteria: [], dependsOn: [] },
        { clientId: "B", title: "Delete", acceptanceCriteria: [], dependsOn: ["A"] },
        { clientId: "C", title: "Delete dependent", acceptanceCriteria: [], dependsOn: ["B"] }
      ]
    });
    const mainTaskId = String(plan.mainTask.id), keptTaskId = String(plan.tasks[0]!.id), deletedTaskId = String(plan.tasks[1]!.id), deletedDependentTaskId = String(plan.tasks[2]!.id);
    database.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(keptTaskId);
    const deletedEvidenceId = randomUUID();
    database.prepare("INSERT INTO evidence (id, task_id, criterion_key, type, status, summary, payload_json, created_at) VALUES (?, ?, '*', 'review', 'failed', 'Historical deleted review', '{}', ?)").run(deletedEvidenceId, deletedTaskId, now);
    const otherCommission = randomUUID(), otherRequirement = randomUUID();
    database.prepare("INSERT INTO commissions (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, 'Other commission', 'planned', ?, ?)").run(otherCommission, project, now, now);
    database.prepare("INSERT INTO requirement_versions (id, commission_id, version_no, content_markdown, acceptance_json, status, created_by, created_at, approved_at) VALUES (?, ?, 1, 'Requirement', '[]', 'approved', 'human', ?, ?)").run(otherRequirement, otherCommission, now, now);
    database.prepare("UPDATE commissions SET active_requirement_version_id = ? WHERE id = ?").run(otherRequirement, otherCommission);
    const otherPlan = createTaskPlan(database, otherCommission, { mainTask: { title: "Other main", acceptanceCriteria: [] }, tasks: [{ clientId: "dependent", title: "External dependent", acceptanceCriteria: [], dependsOn: [] }] });
    const externalDependentId = String(otherPlan.tasks[0]!.id);
    database.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id, created_by, created_at) VALUES (?, ?, 'planner_agent', ?)").run(externalDependentId, deletedTaskId, now);
    database.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id, created_by, created_at) VALUES (?, ?, 'planner_agent', ?)").run(externalDependentId, keptTaskId, now);
    database.prepare("UPDATE commissions SET status = 'active' WHERE id = ?").run(commission);

    const revisionId = beginPlanRevision(database, commission, "需要调整任务方向");
    const textCard = database.prepare("SELECT comment_id FROM plan_revision_cards WHERE plan_revision_id = ? AND status = 'pending'").get(revisionId) as { comment_id: string };
    assert.equal(answerRevisionCard(database, mainTaskId, textCard.comment_id, "删除无效任务并补充替代任务").finalAccepted, false);

    for (const [type, options, answer] of [
      ["boolean", ["是", "否"], "是"],
      ["single_choice", ["方案一", "方案二"], "方案一"],
      ["multiple_choice", ["API", "文档"], ["API", "文档"]]
    ] as const) {
      const card = createRevisionCard(database, revisionId, mainTaskId, { type, prompt: `选择 ${type}`, options: [...options] });
      assert.equal(answerRevisionCard(database, mainTaskId, String(card.id), answer).finalAccepted, false);
    }

    saveRevisionProposal(database, revisionId, {
      summary: "删除失效任务并创建替代任务",
      changes: [
        { action: "update", taskId: keptTaskId, readOnly: true, position: 1, reopen: true },
        { action: "delete", taskId: deletedTaskId, reason: "方向已失效" },
        { action: "delete", taskId: deletedDependentTaskId, reason: "依赖方向已失效" },
        { action: "create", clientId: "replacement", title: "Replacement", description: "新方向", ownerType: "ai", priority: "high", dueDate: "2026-09-01", readOnly: true, acceptanceCriteria: [], dependsOnTaskIds: [externalDependentId] }
      ]
    });
    const grant = randomUUID(), reviewRun = randomUUID();
    database.prepare("INSERT INTO execution_grants (id, commission_id, root_task_id, scope, status, created_at) VALUES (?, ?, ?, 'commission_tree', 'active', ?)").run(grant, commission, mainTaskId, now);
    database.prepare("INSERT INTO runs (id, project_id, commission_id, task_id, role, trigger_type, trigger_ref_id, execution_grant_id, status, attempt_no, config_snapshot_json, context_snapshot_json) VALUES (?, ?, ?, ?, 'supervisor', 'plan_revision_review', ?, ?, 'succeeded', 1, '{}', '{}')").run(reviewRun, project, commission, mainTaskId, revisionId, grant);
    publishRevisionConfirmation(database, revisionId, "确认删除失效任务并创建 Replacement。", reviewRun);
    const finalCard = database.prepare("SELECT comment_id FROM plan_revision_cards WHERE plan_revision_id = ? AND purpose = 'final_confirmation' AND status = 'pending'").get(revisionId) as { comment_id: string };
    const finalCardContent = (database.prepare("SELECT content FROM comments WHERE id = ?").get(finalCard.comment_id) as { content: string }).content;
    assert.match(finalCardContent, /删除失效任务并创建替代任务/);
    assert.match(finalCardContent, new RegExp(deletedTaskId));
    assert.match(finalCardContent, /"action": "create"/);
    const server = Fastify();
    registerTaskRoutes(server, database, Object.assign(async () => ({ action: "unavailable" as const }), { coordinateTask: async () => { throw new Error("routing failed"); } }));
    assert.equal((await server.inject({ method: "POST", url: `/api/tasks/${mainTaskId}/comments/${finalCard.comment_id}/respond`, payload: { answer: "接受" } })).statusCode, 409);
    assert.deepEqual({ ...database.prepare("SELECT status, answer_json FROM plan_revision_cards WHERE comment_id = ?").get(finalCard.comment_id) }, { status: "pending", answer_json: null });
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM comments WHERE parent_id = ? AND author_type = 'human'").get(finalCard.comment_id) as { count: number }).count, 0);

    database.prepare("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?").run(externalDependentId, deletedTaskId);
    const dependentRun = randomUUID();
    database.prepare("INSERT INTO runs (id, project_id, commission_id, task_id, role, trigger_type, status, attempt_no, config_snapshot_json, context_snapshot_json) VALUES (?, ?, ?, ?, 'developer', 'manual', 'running', 1, '{}', '{}')")
      .run(dependentRun, project, otherCommission, externalDependentId);
    assert.equal((await server.inject({ method: "POST", url: `/api/tasks/${mainTaskId}/comments/${finalCard.comment_id}/respond`, payload: { answer: "接受" } })).statusCode, 409);
    assert.deepEqual({ ...database.prepare("SELECT status, answer_json FROM plan_revision_cards WHERE comment_id = ?").get(finalCard.comment_id) }, { status: "pending", answer_json: null });
    database.prepare("UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ?").run(now, dependentRun);
    const activeRun = randomUUID();
    database.prepare("INSERT INTO runs (id, project_id, commission_id, task_id, role, trigger_type, status, attempt_no, config_snapshot_json, context_snapshot_json) VALUES (?, ?, ?, ?, 'developer', 'manual', 'queued', 1, '{}', '{}')")
      .run(activeRun, project, commission, deletedTaskId);
    assert.equal((await server.inject({ method: "POST", url: `/api/tasks/${mainTaskId}/comments/${finalCard.comment_id}/respond`, payload: { answer: "接受" } })).statusCode, 409);
    assert.deepEqual({ ...database.prepare("SELECT status, answer_json FROM plan_revision_cards WHERE comment_id = ?").get(finalCard.comment_id) }, { status: "pending", answer_json: null });
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM comments WHERE parent_id = ? AND author_type = 'human'").get(finalCard.comment_id) as { count: number }).count, 0);
    database.prepare("UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ?").run(now, activeRun);
    const accepted = await server.inject({ method: "POST", url: `/api/tasks/${mainTaskId}/comments/${finalCard.comment_id}/respond`, payload: { answer: "接受" } });
    assert.equal(accepted.statusCode, 201);
    assert.equal(accepted.json().agentMention.action, "unavailable");

    const deleted = database.prepare("SELECT status, deleted_at, deleted_reason FROM tasks WHERE id = ?").get(deletedTaskId) as { status: string; deleted_at: string | null; deleted_reason: string | null };
    assert.equal(deleted.status, "archived");
    assert.ok(deleted.deleted_at);
    assert.equal(deleted.deleted_reason, "方向已失效");
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?").get(deletedTaskId, deletedTaskId) as { count: number }).count, 0);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE commission_id = ? AND archived_at IS NULL AND title = 'Replacement'").get(commission) as { count: number }).count, 1);
    const replacement = database.prepare("SELECT id, due_date, read_only, position FROM tasks WHERE commission_id = ? AND archived_at IS NULL AND title = 'Replacement'").get(commission) as { id: string; due_date: string | null; read_only: number; position: number };
    const replacementId = replacement.id;
    assert.deepEqual({ dueDate: replacement.due_date, readOnly: replacement.read_only, position: replacement.position }, { dueDate: "2026-09-01", readOnly: 1, position: 0 });
    assert.deepEqual({ ...database.prepare("SELECT status, read_only, position FROM tasks WHERE id = ?").get(keptTaskId) }, { status: "todo", read_only: 1, position: 1 });
    assert.ok(database.prepare("SELECT 1 FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?").get(replacementId, externalDependentId));
    assert.equal((await server.inject({ method: "GET", url: `/api/projects/${project}/tasks?includeArchived=true` })).json().some((task: { id: string }) => task.id === deletedTaskId), false);
    const history = (await server.inject({ method: "GET", url: `/api/projects/${project}/task-history` })).json() as Array<{ id: string; dependencyIds: string[] }>;
    assert.deepEqual(new Set(history.map((task) => task.id)), new Set([deletedTaskId, deletedDependentTaskId]));
    assert.deepEqual(history.find((task) => task.id === deletedTaskId)!.dependencyIds, [keptTaskId]);
    assert.deepEqual(history.find((task) => task.id === deletedDependentTaskId)!.dependencyIds, [deletedTaskId]);
    assert.deepEqual((await server.inject({ method: "GET", url: `/api/tasks/${deletedTaskId}/evidence` })).json().map((item: { id: string }) => item.id), [deletedEvidenceId]);
    assert.equal((await server.inject({ method: "POST", url: `/api/tasks/${deletedTaskId}/unarchive` })).statusCode, 409);
    database.prepare("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?").run(externalDependentId, keptTaskId);
    assert.equal((await server.inject({ method: "POST", url: `/api/tasks/${mainTaskId}/archive` })).statusCode, 200);
    assert.equal((await server.inject({ method: "POST", url: `/api/tasks/${mainTaskId}/unarchive` })).statusCode, 200);
    assert.deepEqual({ ...database.prepare("SELECT status, archived_at IS NOT NULL AS archived FROM tasks WHERE id = ?").get(deletedTaskId) }, { status: "archived", archived: 1 });
    await server.close();
  } finally {
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});
