import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { resolvedRoleConfig } from "./agent-settings.ts";
import { addMainTaskComment, addRunCommentOnce } from "./comments.ts";
import { notify } from "./notifications.ts";
import { REVISION_INTERACTIONS, beginPlanRevision, createRevisionCard, parseRevisionProposal, publishRevisionConfirmation, revisionForRun, saveRevisionProposal, type RevisionProposal, type RevisionQuestion } from "./plan-revisions.ts";
import type { CommandRunner, VcsInfo } from "./projects.ts";
import { updateCommissionAcceptance } from "./tasks.ts";

const runFile = promisify(execFile);
const ACTIVE_RUN_STATUSES = ["preparing", "running", "waiting_approval", "waiting_input"] as const;
const RESERVED_RUN_STATUSES = ["queued", ...ACTIVE_RUN_STATUSES] as const;
const MAX_CONSECUTIVE_FAILED_REVIEWS = 3;
type GrantScope = "commission_tree" | "target_closure";
type LockMode = "read" | "worktree" | "exclusive";

type GrantRow = { id: string; commission_id: string; root_task_id: string; scope: GrantScope; status: "active" | "exhausted" | "revoked" };
type RunRow = {
  id: string; project_id: string; commission_id: string; task_id: string; role: string; trigger_type: string; trigger_ref_id: string | null;
  execution_grant_id: string | null; retry_root_run_id: string | null; status: string; attempt_no: number; config_snapshot_json: string;
  context_snapshot_json: string; workspace_path: string | null; workspace_mode: LockMode | null; coordination_revision: number | null;
};
export type RunnableTask = { id: string; projectId: string; commissionId: string; readOnly: boolean };
export type WorkspacePlan = { cwd: string; lock: LockMode; worktree: boolean };
export type RunStarter = { start(runId: string, cwd: string): Promise<void> };

export class Scheduler {
  private readonly locks = new ProjectLockManager();
  private readonly workspaces = new Map<string, { plan: WorkspacePlan; projectRoot: string; release: () => void }>();
  private drain: Promise<void> | null = null;
  private drainRequested = false;
  private readonly database: DatabaseSync;
  private readonly starter: RunStarter;
  private readonly runner: CommandRunner;

  constructor(database: DatabaseSync, starter: RunStarter, runner: CommandRunner = execute) {
    this.database = database;
    this.starter = starter;
    this.runner = runner;
  }

  async trigger(taskId: string, beforeStart?: (runIds: readonly string[]) => void) {
    const { grant, runIds } = transaction(this.database, () => {
      const grant = createExecutionGrantUnsafe(this.database, taskId);
      if (grant.scope === "commission_tree") {
        this.database.prepare("UPDATE tasks SET status = 'in_progress', blocked_reason = NULL, updated_at = ? WHERE id = ? AND status <> 'done'")
          .run(new Date().toISOString(), taskId);
      } else {
        this.database.prepare("UPDATE tasks SET status = 'todo', blocked_reason = NULL, updated_at = ? WHERE id = ? AND status IN ('in_progress', 'blocked')")
          .run(new Date().toISOString(), taskId);
      }
      const covered = coveredTaskIds(this.database, grant.id);
      if (covered.length) this.database.prepare(`UPDATE tasks SET status = 'todo', blocked_reason = NULL, updated_at = ? WHERE id IN (${covered.map(() => "?").join(", ")}) AND status = 'backlog'`)
        .run(new Date().toISOString(), ...covered);
      const runIds = runnableTasks(this.database, grant.id).map((task) => reserveRoutedRun(this.database, grant.id, task.id));
      settleBlockedCommissionTree(this.database, grant);
      beforeStart?.(runIds);
      return { grant, runIds };
    });
    await this.startQueued();
    return { grant, runIds };
  }

  async coordinate(taskId: string, beforeStart?: (runIds: readonly string[]) => void) {
    const { grant, runId } = transaction(this.database, () => {
      const task = this.database.prepare("SELECT task.commission_id, commission.status FROM tasks AS task JOIN commissions AS commission ON commission.id = task.commission_id WHERE task.id = ? AND task.archived_at IS NULL AND task.id = commission.main_task_id").get(taskId) as { commission_id: string; status: string } | undefined;
      if (!task) throw conflict("Coordination is only available for the main task");
      if (this.database.prepare("SELECT 1 FROM plan_revisions WHERE commission_id = ? AND status IN ('collecting', 'reviewing', 'awaiting_confirmation')").get(task.commission_id)) throw conflict("Answer the pending plan revision card before coordinating again");
      let grant = task.status === "active" ? this.database.prepare("SELECT * FROM execution_grants WHERE commission_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(task.commission_id) as GrantRow | undefined : undefined;
      if (grant?.scope === "target_closure") {
        this.database.prepare("UPDATE execution_grants SET root_task_id = ?, scope = 'commission_tree' WHERE id = ?").run(taskId, grant.id);
        grant = { ...grant, root_task_id: taskId, scope: "commission_tree" };
      }
      grant ??= createExecutionGrantUnsafe(this.database, taskId);
      if (grant.scope !== "commission_tree") throw conflict("Coordination is only available for the main task");
      const now = new Date().toISOString();
      this.database.prepare("UPDATE tasks SET status = 'in_progress', blocked_reason = NULL, updated_at = ? WHERE id = ? AND status <> 'done'").run(now, taskId);
      const covered = coveredTaskIds(this.database, grant.id);
      if (covered.length) this.database.prepare(`UPDATE tasks SET status = 'todo', blocked_reason = NULL, updated_at = ? WHERE id IN (${covered.map(() => "?").join(", ")}) AND status = 'backlog'`).run(now, ...covered);
      const revision = (this.database.prepare("SELECT coordination_revision FROM commissions WHERE id = ?").get(task.commission_id) as { coordination_revision: number }).coordination_revision;
      this.database.prepare("UPDATE commissions SET coordination_pending = 1 WHERE id = ?").run(task.commission_id);
      const existing = this.database.prepare(`SELECT id FROM runs WHERE task_id = ? AND trigger_type = 'coordinate' AND status IN (${RESERVED_RUN_STATUSES.map(() => "?").join(", ")}) ORDER BY rowid DESC LIMIT 1`).get(taskId, ...RESERVED_RUN_STATUSES) as { id: string } | undefined;
      const runId = existing?.id ?? reserveRun(this.database, grant.id, taskId, "coordinate", grant.id, null, undefined, "{}", "supervisor", revision);
      beforeStart?.([runId]);
      return { grant, runId };
    });
    await this.startQueued();
    return { grant, runIds: [runId] };
  }

  async coordinateFinal(commissionId: string): Promise<boolean> {
    const mainTaskId = finalCoordinationMainTask(this.database, commissionId);
    if (!mainTaskId) return false;
    this.database.prepare("UPDATE commissions SET coordination_pending = 1 WHERE id = ?").run(commissionId);
    await this.coordinate(mainTaskId);
    return true;
  }

  async revise(revisionId: string): Promise<string> {
    const runId = transaction(this.database, () => {
      const revision = revisionForRun(this.database, revisionId);
      if (!["collecting", "reviewing"].includes(revision.status)) throw conflict("Plan revision is not ready for supervisor work");
      let grant = this.database.prepare("SELECT * FROM execution_grants WHERE commission_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(revision.commission_id) as GrantRow | undefined;
      if (grant?.scope === "target_closure") {
        this.database.prepare("UPDATE execution_grants SET root_task_id = ?, scope = 'commission_tree' WHERE id = ?").run(revision.main_task_id, grant.id);
        grant = { ...grant, root_task_id: revision.main_task_id, scope: "commission_tree" };
      }
      grant ??= createExecutionGrantUnsafe(this.database, revision.main_task_id);
      if (grant.scope !== "commission_tree") throw conflict("Plan revision requires a commission-tree grant");
      const trigger = revision.status === "reviewing" ? "plan_revision_review" : "plan_revision";
      const existing = this.database.prepare(`SELECT id FROM runs WHERE task_id = ? AND trigger_type = ? AND status IN (${RESERVED_RUN_STATUSES.map(() => "?").join(", ")}) ORDER BY rowid DESC LIMIT 1`).get(revision.main_task_id, trigger, ...RESERVED_RUN_STATUSES) as { id: string } | undefined;
      if (existing) return existing.id;
      this.database.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ? AND status <> 'done'").run(new Date().toISOString(), revision.main_task_id);
      return reserveRun(this.database, grant.id, revision.main_task_id, trigger, revision.id, null, undefined, JSON.stringify({ revisionId }), "supervisor");
    });
    await this.startQueued();
    return runId;
  }

  async resume(taskId: string, previousRunId: string): Promise<string> {
    const previous = runById(this.database, previousRunId);
    const task = this.database.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
    const interrupted = previous.task_id === taskId && previous.status === "interrupted";
    const reviewBlocked = previous.task_id === taskId && previous.status === "succeeded" && previous.role === "reviewer" && task?.status === "blocked"
      && Boolean(this.database.prepare("SELECT 1 FROM evidence WHERE run_id = ? AND type = 'review' AND status = 'failed'").get(previous.id));
    if (!interrupted && !reviewBlocked) throw conflict("Only an interrupted task or a task blocked after review can be resumed");
    const runId = transaction(this.database, () => {
      this.database.prepare("UPDATE tasks SET status = 'todo', blocked_reason = NULL, updated_at = ? WHERE id = ? AND status IN ('in_progress', 'blocked')").run(new Date().toISOString(), taskId);
      const grant = createExecutionGrantUnsafe(this.database, taskId);
      if (!runnableTasks(this.database, grant.id).some(({ id }) => id === taskId)) throw conflict("Task is not runnable");
      return reviewBlocked
        ? reserveRun(this.database, grant.id, taskId, "resume", previousRunId)
        : reserveRun(this.database, grant.id, taskId, "resume", previousRunId, null, previous.config_snapshot_json, previous.context_snapshot_json, previous.role);
    });
    await this.startQueued();
    return runId;
  }

  async recover(): Promise<string[]> {
    const blocked: string[] = [];
    const retries = recoverInterruptedRuns(this.database, blocked);
    const commissions = this.database.prepare("SELECT id FROM commissions WHERE status IN ('active', 'blocked') AND archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM plan_revisions WHERE plan_revisions.commission_id = commissions.id AND plan_revisions.status IN ('collecting', 'reviewing', 'awaiting_confirmation'))").all() as Array<{ id: string }>;
    for (const { id } of commissions) {
      if (!blocked.includes(id)) await this.coordinateFinal(id);
    }
    const pending = this.database.prepare("SELECT main_task_id FROM commissions WHERE coordination_pending = 1 AND status IN ('active', 'blocked') AND archived_at IS NULL AND main_task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM plan_revisions WHERE plan_revisions.commission_id = commissions.id AND plan_revisions.status IN ('collecting', 'reviewing', 'awaiting_confirmation'))").all() as Array<{ main_task_id: string }>;
    for (const { main_task_id } of pending) await this.coordinate(main_task_id);
    await this.startQueued();
    return retries;
  }

  async wake(grantId?: string): Promise<string[]> {
    const grants = grantId ? [grantById(this.database, grantId)] : this.database.prepare("SELECT * FROM execution_grants WHERE status = 'active' ORDER BY created_at").all() as GrantRow[];
    const reserved: string[] = [];
    for (const grant of grants) {
      reserved.push(...transaction(this.database, () => {
        const runIds = runnableTasks(this.database, grant.id).map((task) => reserveRoutedRun(this.database, grant.id, task.id));
        settleBlockedCommissionTree(this.database, grant);
        return runIds;
      }));
    }
    await this.startQueued();
    return reserved;
  }

  async terminal(runId: string): Promise<void> {
    const run = runById(this.database, runId);
    if (run.trigger_type === "coordinate") {
      const coordination = this.database.prepare("SELECT coordination_revision FROM commissions WHERE id = ?").get(run.commission_id) as { coordination_revision: number };
      if (run.coordination_revision !== coordination.coordination_revision) {
        await this.cleanup(run.id, run.status === "cancelled");
        const pending = (this.database.prepare("SELECT coordination_pending FROM commissions WHERE id = ?").get(run.commission_id) as { coordination_pending: number }).coordination_pending;
        if (pending) await this.coordinate(run.task_id); else await this.startQueued();
        return;
      }
      this.database.prepare("UPDATE commissions SET coordination_pending = 0 WHERE id = ? AND coordination_revision = ?").run(run.commission_id, coordination.coordination_revision);
    }
    if (["interrupted", "cancelled"].includes(run.status)) {
      await this.cleanup(run.id, run.status === "cancelled");
      await this.startQueued();
      return;
    }
    if (["plan_revision", "plan_revision_review"].includes(run.trigger_type)) {
      if (run.status !== "succeeded") {
        await this.cleanup(run.id);
        transaction(this.database, () => {
          const revision = revisionForRun(this.database, run.trigger_ref_id!);
          this.database.prepare("UPDATE plan_revisions SET status = 'collecting', updated_at = ? WHERE id = ?").run(new Date().toISOString(), revision.id);
          createRevisionCard(this.database, revision.id, revision.main_task_id, { type: "text", prompt: "## 计划修订待确认\n\n主管 Agent 未能完成本轮分析，请补充调整要求后重试。", options: [] });
        });
        return;
      }
      if (run.trigger_type === "plan_revision") {
        let decision: PlanRevisionDecision;
        try { decision = parsePlanRevisionDecision(runAgentOutput(this.database, run.id)); }
        catch (error) {
          transaction(this.database, () => {
            const revision = revisionForRun(this.database, run.trigger_ref_id!);
            createRevisionCard(this.database, revision.id, revision.main_task_id, { type: "text", prompt: `## 计划修订待确认\n\n主管 Agent 返回了无效结果：${error instanceof Error ? error.message : "未知错误"}\n\n请补充调整要求后重试。`, options: [] });
          });
          await this.cleanup(run.id, false);
          return;
        }
        transaction(this.database, () => {
          const revision = revisionForRun(this.database, run.trigger_ref_id!);
          if (decision.action === "ask") createRevisionCard(this.database, revision.id, revision.main_task_id, decision.question);
          else saveRevisionProposal(this.database, revision.id, decision.proposal);
        });
        await this.cleanup(run.id, false);
        if (decision.action === "review") await this.revise(run.trigger_ref_id!);
        return;
      }
      let decision: PlanRevisionReview;
      try { decision = parsePlanRevisionReview(runAgentOutput(this.database, run.id)); }
      catch (error) {
        transaction(this.database, () => {
          const revision = revisionForRun(this.database, run.trigger_ref_id!);
          this.database.prepare("UPDATE plan_revisions SET status = 'collecting', updated_at = ? WHERE id = ?").run(new Date().toISOString(), revision.id);
          createRevisionCard(this.database, revision.id, revision.main_task_id, { type: "text", prompt: `## 计划修订待确认\n\n审查结果无效：${error instanceof Error ? error.message : "未知错误"}\n\n请补充信息后重新审查。`, options: [] });
        });
        await this.cleanup(run.id, false);
        return;
      }
      try {
        transaction(this.database, () => {
          const revision = revisionForRun(this.database, run.trigger_ref_id!);
          if (decision.approved) publishRevisionConfirmation(this.database, revision.id, decision.summary, run.id);
          else {
            this.database.prepare("UPDATE plan_revisions SET status = 'collecting', updated_at = ? WHERE id = ?").run(new Date().toISOString(), revision.id);
            const question = decision.question
              ? { ...decision.question, prompt: `## 计划修订审查未通过\n\n${decision.summary}\n\n${decision.question.prompt}` }
              : { type: "text" as const, prompt: `## 计划修订审查未通过\n\n${decision.summary}\n\n请补充必要信息。`, options: [] };
            createRevisionCard(this.database, revision.id, revision.main_task_id, question);
          }
        });
      } finally { await this.cleanup(run.id, false); }
      return;
    }
    if (run.status === "failed" && run.trigger_type === "coordinate" && run.execution_grant_id) {
      await this.cleanup(run.id);
      transaction(this.database, () => {
        const now = new Date().toISOString();
        this.database.prepare("UPDATE tasks SET status = 'todo', blocked_reason = NULL, updated_at = ? WHERE id = ?").run(now, run.task_id);
        this.database.prepare("UPDATE commissions SET status = 'blocked', updated_at = ? WHERE id = ?").run(now, run.commission_id);
        this.database.prepare("UPDATE execution_grants SET status = 'exhausted' WHERE id = ?").run(run.execution_grant_id);
        addRunCommentOnce(this.database, { taskId: run.task_id, runId: run.id, authorType: "system", kind: "blocker", content: "调度 Run 失败，已停止自动推进，请人工检查运行详情后重新触发调度。" });
        notify(this.database, "blocked", "调度需要人工处理", "调度 Run 执行失败。", "task", run.task_id);
      });
      return;
    }
    if (run.status === "failed") {
      await this.cleanup(runId);
      this.database.prepare("UPDATE tasks SET status = 'blocked', blocked_reason = 'Run failed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), run.task_id);
      const task = this.database.prepare("SELECT title FROM tasks WHERE id = ?").get(run.task_id) as { title: string };
      addRunCommentOnce(this.database, { taskId: run.task_id, runId: run.id, authorType: "system", kind: "blocker", content: `任务执行失败：${run.trigger_type} Run 未成功完成。` });
      addMainTaskComment(this.database, { sourceTaskId: run.task_id, runId: run.id, kind: "blocker", content: "子任务执行失败并进入阻塞。" });
      notify(this.database, "blocked", `任务阻塞：${task.title}`, "Run 执行失败。", "task", run.task_id);
    }
    if (run.status === "succeeded" && run.role === "supervisor" && run.trigger_type === "coordinate" && run.execution_grant_id) {
      let decision: CoordinatorDecision;
      try { decision = parseCoordinatorDecision(runAgentOutput(this.database, run.id)); }
      catch (error) { decision = { action: "wait_human", summary: error instanceof Error ? error.message : "调度 Agent 返回了无效结果" }; }
      let outcome: "queued" | "settled" | "blocked" | "revision";
      try { outcome = transaction(this.database, () => applyCoordinatorDecision(this.database, run, decision)); }
      catch (error) {
        decision = { action: "wait_human", summary: error instanceof Error ? error.message : "调度决策无法执行" };
        outcome = transaction(this.database, () => applyCoordinatorDecision(this.database, run, decision));
      }
      await this.cleanup(run.id, false);
      if (outcome === "queued") await this.startQueued();
      return;
    }
    if (run.status === "succeeded" && run.role === "supervisor" && run.execution_grant_id) {
      const existing = this.database.prepare("SELECT id FROM runs WHERE trigger_ref_id = ? ORDER BY rowid LIMIT 1").get(run.id) as { id: string } | undefined;
      if (existing) {
        await this.cleanup(run.id, false);
        await this.startQueued();
        return;
      }
      let decision: SupervisorDecision;
      try { decision = parseSupervisorDecision(runAgentOutput(this.database, run.id)); }
      catch (error) {
        decision = { action: "wait_human", summary: error instanceof Error ? error.message : "主管 Agent 返回了无效结果" };
      }
      const outcome = transaction(this.database, () => applySupervisorDecision(this.database, run, decision));
      await this.cleanup(run.id, decision.action === "restart_developer");
      if (outcome === "blocked") return;
      await this.startQueued();
      return;
    }
    if (run.status === "succeeded" && run.role === "developer" && run.execution_grant_id) {
      const result = runAgentOutput(this.database, run.id).trim();
      transaction(this.database, () => {
        if (result) addRunCommentOnce(this.database, { taskId: run.task_id, runId: run.id, authorType: "agent", agentRole: "developer", content: result.slice(0, 12000) });
        addRunCommentOnce(this.database, { taskId: run.task_id, runId: run.id, authorType: "system", content: "开发执行已完成，已触发独立代码审查。" });
        return databaseRunTriggeredBy(this.database, run.id, "reviewer") ?? reserveRun(this.database, run.execution_grant_id!, run.task_id, "review", run.id, null, undefined, "{}", "reviewer");
      });
      await this.startQueued();
      return;
    }
    if (run.status === "succeeded" && run.role === "reviewer" && run.execution_grant_id) {
      const existing = this.database.prepare("SELECT status FROM evidence WHERE run_id = ? AND type = 'review'").get(run.id) as { status: "passed" | "failed" } | undefined;
      if (existing) {
        if (existing.status === "passed") await this.cleanup(run.id);
        else if ((this.database.prepare("SELECT status FROM tasks WHERE id = ?").get(run.task_id) as { status: string }).status === "blocked") await this.cleanup(run.id, false);
        else await this.startQueued();
        return;
      }
      let review: ReviewResult;
      try { review = reviewResult(this.database, run.id); }
      catch (error) {
        review = { passed: false, summary: error instanceof Error ? error.message : "Reviewer returned invalid output", checks: [], findings: [{ severity: "blocking", file: null, line: null, message: "Reviewer output did not match the JSON contract" }] };
      }
      const now = new Date().toISOString();
      const task = this.database.prepare("SELECT review_round_limit, review_round_used FROM tasks WHERE id = ?").get(run.task_id) as { review_round_limit: number; review_round_used: number };
      const successful = task.review_round_used + (review.passed ? 1 : 0);
      const complete = review.passed && successful >= task.review_round_limit;
      if (complete) await this.deliver(run.id);
      const outcome = transaction(this.database, () => {
        this.database.prepare("INSERT INTO evidence (id, task_id, run_id, criterion_key, type, status, summary, payload_json, created_at) VALUES (?, ?, ?, '*', 'review', ?, ?, ?, ?)")
          .run(randomUUID(), run.task_id, run.id, review.passed ? "passed" : "failed", review.summary, JSON.stringify(review), now);
        addRunCommentOnce(this.database, { taskId: run.task_id, runId: run.id, authorType: "agent", agentRole: "reviewer", content: reviewComment(review) });
        if (review.passed) {
          this.database.prepare("UPDATE tasks SET review_round_used = ?, updated_at = ? WHERE id = ?").run(successful, now, run.task_id);
          if (!complete) {
            addRunCommentOnce(this.database, { taskId: run.task_id, runId: run.id, authorType: "system", content: `第 ${successful}/${task.review_round_limit} 轮代码审查通过，已触发下一轮独立审查。` });
            reserveRun(this.database, run.execution_grant_id!, run.task_id, "review", run.id, null, undefined, "{}", "reviewer");
            return "review" as const;
          }
          this.database.prepare("UPDATE tasks SET status = 'done', blocked_reason = NULL, updated_at = ? WHERE id = ?").run(now, run.task_id);
          const completedTask = this.database.prepare("SELECT title FROM tasks WHERE id = ?").get(run.task_id) as { title: string };
          addRunCommentOnce(this.database, { taskId: run.task_id, runId: run.id, authorType: "system", content: `任务完成：代码审查通过。\n\n${review.summary}` });
          addMainTaskComment(this.database, { sourceTaskId: run.task_id, runId: run.id, content: `子任务已完成，代码审查通过。\n\n${review.summary}` });
          notify(this.database, "completed", `任务完成：${completedTask.title}`, review.summary, "task", run.task_id);
          return "passed" as const;
        }
        const failedReviews = consecutiveFailedReviewCount(this.database, run.task_id);
        if (failedReviews >= MAX_CONSECUTIVE_FAILED_REVIEWS) {
          const reason = `连续 ${failedReviews} 轮代码审查未通过：${review.summary}`;
          this.database.prepare("UPDATE tasks SET status = 'blocked', blocked_reason = ?, updated_at = ? WHERE id = ?").run(reason, now, run.task_id);
          const blockedTask = this.database.prepare("SELECT title FROM tasks WHERE id = ?").get(run.task_id) as { title: string };
          addRunCommentOnce(this.database, { taskId: run.task_id, runId: run.id, authorType: "system", kind: "blocker", content: `${reason}\n\n已停止自动返工，请人工处理阻塞原因后重新执行。` });
          addMainTaskComment(this.database, { sourceTaskId: run.task_id, runId: run.id, kind: "blocker", content: `子任务连续 ${failedReviews} 轮代码审查未通过，已停止自动返工。\n\n${review.summary}` });
          notify(this.database, "blocked", `任务阻塞：${blockedTask.title}`, reason, "task", run.task_id);
          return "blocked" as const;
        }
        addRunCommentOnce(this.database, { taskId: run.task_id, runId: run.id, authorType: "system", content: `代码审查未通过，本轮不计入成功次数，已触发返工（连续失败 ${failedReviews}/${MAX_CONSECUTIVE_FAILED_REVIEWS}）。` });
        reserveRun(this.database, run.execution_grant_id!, run.task_id, "rework", run.id);
        return "rework" as const;
      });
      if (outcome === "passed") {
        await this.cleanup(run.id);
        if (await this.coordinateFinal(run.commission_id)) return;
      }
      else if (outcome === "blocked") await this.cleanup(run.id, false);
      else await this.startQueued();
    }
    if (run.execution_grant_id && ["succeeded", "failed"].includes(run.status)) await this.wake(run.execution_grant_id);
  }

  private async startQueued(): Promise<void> {
    this.drainRequested = true;
    return this.drain ??= this.drainLoop();
  }

  private async drainLoop(): Promise<void> {
    try {
      do {
        this.drainRequested = false;
        await this.drainQueued();
      } while (this.drainRequested);
    } finally {
      this.drain = null;
      if (this.drainRequested) await this.startQueued();
    }
  }

  private async drainQueued(): Promise<void> {
    const queued = this.database.prepare("SELECT * FROM runs WHERE status = 'queued' ORDER BY rowid").all() as RunRow[];
    for (const run of queued) {
      if (!canStartRun(this.database, run)) continue;
      const workspace = await this.prepareWorkspace(run);
      if (!workspace) continue;
      const claimed = this.database.prepare("UPDATE runs SET status = 'preparing', workspace_path = ?, workspace_mode = ?, started_at = ? WHERE id = ? AND status = 'queued'")
        .run(workspace.plan.cwd, workspace.plan.lock, new Date().toISOString(), run.id).changes;
      if (!claimed) { await this.cleanup(run.id); continue; }
      this.database.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?").run(new Date().toISOString(), run.task_id);
      await this.starter.start(run.id, workspace.plan.cwd);
    }
  }

  private async prepareWorkspace(run: RunRow): Promise<{ plan: WorkspacePlan } | undefined> {
    const project = this.database.prepare(`SELECT project.real_path, project.vcs_type FROM projects AS project
      JOIN root_paths AS root ON root.id = project.root_path_id
      WHERE project.id = ? AND project.archived_at IS NULL AND root.enabled = 1`).get(run.project_id) as { real_path: string; vcs_type: VcsInfo["type"] } | undefined;
    const task = this.database.prepare("SELECT read_only FROM tasks WHERE id = ? AND archived_at IS NULL").get(run.task_id) as { read_only: number } | undefined;
    if (!project || !task) throw new Error("Reserved Run lost its project or task");
    const continued = await this.continueWorkspace(run, project.real_path);
    if (continued) return { plan: continued.plan };
    let clean = false;
    const readOnly = run.role === "supervisor" || Boolean(task.read_only);
    if (project.vcs_type === "git" && !readOnly) clean = !(await this.runner("git", ["status", "--porcelain=v2"], project.real_path)).trim();
    const plan = workspacePlan(project.real_path, project.vcs_type, readOnly, clean, run.id);
    const release = this.locks.tryAcquire(run.project_id, plan.lock);
    if (!release) return undefined;
    try {
      if (plan.worktree) {
        await mkdir(join(project.real_path, ".openworkshop", "worktrees"), { recursive: true });
        await this.runner("git", ["worktree", "add", "--detach", plan.cwd, "HEAD"], project.real_path);
      }
      this.workspaces.set(run.id, { plan, projectRoot: project.real_path, release });
      return { plan };
    } catch (error) {
      release();
      throw error;
    }
  }

  private async continueWorkspace(run: RunRow, projectRoot: string) {
    if (run.trigger_type === "restart") return undefined;
    const latest = (this.database.prepare("SELECT id FROM runs WHERE task_id = ? AND id <> ? AND workspace_mode = 'worktree' AND workspace_path IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(run.task_id, run.id) as { id: string } | undefined)?.id;
    for (const sourceId of [...new Set([run.trigger_ref_id, latest].filter((id): id is string => Boolean(id)))]) {
      const active = this.workspaces.get(sourceId);
      if (active) {
        this.workspaces.delete(sourceId);
        this.workspaces.set(run.id, active);
        return active;
      }
      const previous = this.database.prepare("SELECT workspace_path, workspace_mode FROM runs WHERE id = ?").get(sourceId) as { workspace_path: string | null; workspace_mode: LockMode | null } | undefined;
      if (previous?.workspace_mode !== "worktree" || !previous.workspace_path || !await access(previous.workspace_path).then(() => true, () => false)) continue;
      const release = this.locks.tryAcquire(run.project_id, "worktree");
      if (!release) return undefined;
      const workspace = { plan: { cwd: previous.workspace_path, lock: "worktree" as const, worktree: true }, projectRoot, release };
      this.workspaces.set(run.id, workspace);
      return workspace;
    }
    return undefined;
  }

  private async deliver(runId: string): Promise<void> {
    const workspace = this.workspaces.get(runId);
    if (!workspace?.plan.worktree) return;
    await this.runner("git", ["add", "-N", "."], workspace.plan.cwd);
    const patch = await this.runner("git", ["diff", "--binary", "HEAD"], workspace.plan.cwd);
    if (!patch.trim()) return;
    const directory = join(workspace.projectRoot, ".openworkshop", "patches");
    const path = join(directory, `${runId}.patch`);
    await mkdir(directory, { recursive: true });
    await writeFile(path, patch);
    try {
      try {
        await this.runner("git", ["apply", "--check", path], workspace.projectRoot);
        await this.runner("git", ["apply", "--whitespace=nowarn", path], workspace.projectRoot);
      } catch (error) {
        await this.runner("git", ["apply", "--reverse", "--check", path], workspace.projectRoot).catch(() => { throw error; });
      }
    } finally { await rm(path, { force: true }); }
  }

  private async cleanup(runId: string, removeWorktree = true): Promise<void> {
    const workspace = this.workspaces.get(runId);
    if (!workspace) return;
    this.workspaces.delete(runId);
    try { if (removeWorktree && workspace.plan.worktree) await this.runner("git", ["worktree", "remove", "--force", workspace.plan.cwd], workspace.projectRoot); }
    catch {} finally { workspace.release(); }
  }
}

export function registerSchedulerRoutes(server: FastifyInstance, scheduler: Scheduler): void {
  server.post<{ Params: { id: string } }>("/api/tasks/:id/trigger", async (request) => scheduler.trigger(request.params.id));
  server.post<{ Params: { id: string } }>("/api/tasks/:id/coordinate", async (request) => scheduler.coordinate(request.params.id));
}

export function createExecutionGrant(database: DatabaseSync, taskId: string): GrantRow {
  return transaction(database, () => createExecutionGrantUnsafe(database, taskId));
}

function createExecutionGrantUnsafe(database: DatabaseSync, taskId: string): GrantRow {
    const task = database.prepare(`SELECT task.id, task.commission_id, commission.main_task_id, commission.project_id, commission.status,
        project.archived_at AS project_archived_at, root.enabled AS root_enabled
      FROM tasks AS task
      JOIN commissions AS commission ON commission.id = task.commission_id
      JOIN projects AS project ON project.id = commission.project_id
      JOIN root_paths AS root ON root.id = project.root_path_id
      WHERE task.id = ? AND task.archived_at IS NULL AND commission.archived_at IS NULL`).get(taskId) as { id: string; commission_id: string; main_task_id: string | null; project_id: string; status: string; project_archived_at: string | null; root_enabled: number } | undefined;
    if (!task) throw new Error("Task not found");
    if (task.project_archived_at) throw conflict("Project is archived");
    if (!task.root_enabled) throw conflict("Project root is disabled");
    if (database.prepare("SELECT 1 FROM commissions WHERE project_id = ? AND status = 'active' AND id <> ?").get(task.project_id, task.commission_id)) throw conflict("Project already has another active commission");
    if (database.prepare(`SELECT 1 FROM runs WHERE commission_id = ? AND status IN (${RESERVED_RUN_STATUSES.map(() => "?").join(", ")}) LIMIT 1`).get(task.commission_id, ...RESERVED_RUN_STATUSES)) throw conflict("Commission already has reserved Runs");
    if (["draft", "clarifying", "awaiting_requirement_approval", "awaiting_acceptance", "done", "archived"].includes(task.status)) throw conflict("Commission cannot be executed");
    const now = new Date().toISOString();
    database.prepare("UPDATE execution_grants SET status = 'revoked', revoked_at = ? WHERE commission_id = ? AND status = 'active'").run(now, task.commission_id);
    database.prepare("UPDATE commissions SET status = 'active', updated_at = ? WHERE id = ?").run(now, task.commission_id);
    const grant: GrantRow = { id: randomUUID(), commission_id: task.commission_id, root_task_id: task.id, scope: task.id === task.main_task_id ? "commission_tree" : "target_closure", status: "active" };
    database.prepare("INSERT INTO execution_grants (id, commission_id, root_task_id, scope, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)").run(grant.id, grant.commission_id, grant.root_task_id, grant.scope, now);
    return grant;
}

export function coveredTaskIds(database: DatabaseSync, grantId: string): string[] {
  const grant = grantById(database, grantId);
  const rows = grant.scope === "commission_tree" ? database.prepare(`WITH RECURSIVE covered(id) AS (
    SELECT id FROM tasks WHERE id = ? AND commission_id = ? AND archived_at IS NULL UNION ALL
    SELECT task.id FROM tasks AS task JOIN covered ON task.parent_id = covered.id WHERE task.commission_id = ? AND task.archived_at IS NULL
  ) SELECT id FROM covered`).all(grant.root_task_id, grant.commission_id, grant.commission_id) : database.prepare(`WITH RECURSIVE covered(id) AS (
    SELECT id FROM tasks WHERE id = ? AND commission_id = ? AND archived_at IS NULL UNION
    SELECT dependency.depends_on_task_id FROM task_dependencies AS dependency JOIN covered ON dependency.task_id = covered.id
    JOIN tasks AS task ON task.id = dependency.depends_on_task_id WHERE task.commission_id = ? AND task.archived_at IS NULL AND task.status <> 'done'
  ) SELECT id FROM covered`).all(grant.root_task_id, grant.commission_id, grant.commission_id);
  return (rows as Array<{ id: string }>).map(({ id }) => id);
}

export function runnableTasks(database: DatabaseSync, grantId: string, globalLimit = setting(database, "globalConcurrency", 4), projectLimit = setting(database, "projectConcurrency", 2)): RunnableTask[] {
  const grant = grantById(database, grantId);
  if (grant.status !== "active") return [];
  const commission = database.prepare(`SELECT commission.project_id, commission.status FROM commissions AS commission
    JOIN projects AS project ON project.id = commission.project_id
    JOIN root_paths AS root ON root.id = project.root_path_id
    WHERE commission.id = ? AND commission.archived_at IS NULL AND project.archived_at IS NULL AND root.enabled = 1`).get(grant.commission_id) as { project_id: string; status: string } | undefined;
  if (!commission || commission.status !== "active") return [];
  if (database.prepare("SELECT 1 FROM plan_revisions WHERE commission_id = ? AND status IN ('collecting', 'reviewing', 'awaiting_confirmation')").get(grant.commission_id)) return [];
  if (grant.scope === "target_closure" && (database.prepare("SELECT status FROM tasks WHERE id = ?").get(grant.root_task_id) as { status: string }).status === "done") {
    database.prepare("UPDATE execution_grants SET status = 'exhausted' WHERE id = ?").run(grant.id); return [];
  }
  const active = ACTIVE_RUN_STATUSES.map(() => "?").join(", ");
  let slots = Math.min(globalLimit - count(database, `SELECT COUNT(*) AS count FROM runs WHERE status IN (${active})`, ...ACTIVE_RUN_STATUSES), projectLimit - count(database, `SELECT COUNT(*) AS count FROM runs WHERE project_id = ? AND status IN (${active})`, commission.project_id, ...ACTIVE_RUN_STATUSES));
  if (slots <= 0 || database.prepare(`SELECT 1 FROM approvals JOIN runs ON runs.id = approvals.run_id WHERE runs.project_id = ? AND approvals.kind = 'high_risk' AND approvals.status = 'pending' LIMIT 1`).get(commission.project_id)) return [];
  const reserved = RESERVED_RUN_STATUSES.map(() => "?").join(", ");
  const covered = new Set(coveredTaskIds(database, grantId));
  const candidates = database.prepare(`SELECT task.id, task.commission_id, task.read_only FROM tasks AS task
    WHERE task.commission_id = ? AND (task.status = 'todo' OR (task.status = 'blocked' AND task.blocked_reason IS NULL)) AND task.owner_type = 'ai' AND task.archived_at IS NULL
      AND (SELECT main_task_id FROM commissions WHERE id = task.commission_id) IS NOT task.id
    AND NOT EXISTS (SELECT 1 FROM task_dependencies AS dependency JOIN tasks AS required ON required.id = dependency.depends_on_task_id WHERE dependency.task_id = task.id AND required.status <> 'done')
    AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.task_id = task.id AND runs.status IN (${reserved})) ORDER BY task.position, task.created_at`)
    .all(grant.commission_id, ...RESERVED_RUN_STATUSES) as Array<{ id: string; commission_id: string; read_only: number }>;
  const result: RunnableTask[] = [];
  for (const task of candidates) { if (!covered.has(task.id)) continue; result.push({ id: task.id, projectId: commission.project_id, commissionId: task.commission_id, readOnly: Boolean(task.read_only) }); if (--slots === 0) break; }
  return result;
}

function settleBlockedCommissionTree(database: DatabaseSync, grant: GrantRow): boolean {
  if (grant.scope !== "commission_tree" || grant.status !== "active") return false;
  const reserved = database.prepare(`SELECT 1 FROM runs WHERE execution_grant_id = ? AND status IN (${RESERVED_RUN_STATUSES.map(() => "?").join(", ")}) LIMIT 1`)
    .get(grant.id, ...RESERVED_RUN_STATUSES);
  if (reserved) return false;
  const runnable = database.prepare(`SELECT 1 FROM tasks AS task
    WHERE task.commission_id = ? AND task.id <> ? AND (task.status = 'todo' OR (task.status = 'blocked' AND task.blocked_reason IS NULL))
      AND task.owner_type = 'ai' AND task.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM task_dependencies AS dependency JOIN tasks AS required ON required.id = dependency.depends_on_task_id WHERE dependency.task_id = task.id AND required.status <> 'done')
    LIMIT 1`).get(grant.commission_id, grant.root_task_id);
  if (runnable) return false;
  const blocked = database.prepare(`SELECT number_path, title FROM tasks
    WHERE commission_id = ? AND id <> ? AND status = 'blocked' AND blocked_reason IS NOT NULL AND archived_at IS NULL
    ORDER BY number_path LIMIT 1`).get(grant.commission_id, grant.root_task_id) as { number_path: string; title: string } | undefined;
  if (!blocked) return false;
  const now = new Date().toISOString();
  database.prepare("UPDATE tasks SET status = 'todo', blocked_reason = NULL, updated_at = ? WHERE id = ? AND status <> 'done'").run(now, grant.root_task_id);
  database.prepare("UPDATE commissions SET status = 'blocked', updated_at = ? WHERE id = ?").run(now, grant.commission_id);
  database.prepare("UPDATE execution_grants SET status = 'exhausted' WHERE id = ? AND status = 'active'").run(grant.id);
  return true;
}

export class ProjectLockManager {
  private readonly locks = new Map<string, { shared: number; exclusive: boolean }>();
  tryAcquire(projectId: string, mode: LockMode): (() => void) | undefined {
    const current = this.locks.get(projectId) ?? { shared: 0, exclusive: false };
    if (mode === "exclusive" ? current.exclusive || current.shared > 0 : current.exclusive) return undefined;
    if (mode === "exclusive") current.exclusive = true; else current.shared += 1;
    this.locks.set(projectId, current); let released = false;
    return () => { if (released) return; released = true; if (mode === "exclusive") current.exclusive = false; else current.shared -= 1; if (!current.exclusive && current.shared === 0) this.locks.delete(projectId); };
  }
}

export function workspacePlan(projectRoot: string, vcs: VcsInfo["type"], readOnly: boolean, gitClean: boolean, runId: string): WorkspacePlan {
  if (readOnly) return { cwd: projectRoot, lock: "read", worktree: false };
  if (vcs === "git" && gitClean) return { cwd: join(projectRoot, ".openworkshop", "worktrees", runId), lock: "worktree", worktree: true };
  return { cwd: projectRoot, lock: "exclusive", worktree: false };
}

export function recoverInterruptedRuns(database: DatabaseSync, blockedCommissions: string[] = []): string[] {
  return transaction(database, () => {
    const interrupted = database.prepare(`SELECT * FROM runs WHERE status IN (${ACTIVE_RUN_STATUSES.map(() => "?").join(", ")})`).all(...ACTIVE_RUN_STATUSES) as RunRow[];
    const now = new Date().toISOString(); const retries: string[] = [];
    for (const run of interrupted) {
      database.prepare("UPDATE runs SET status = 'interrupted', finished_at = ?, failure_code = 'server_restart' WHERE id = ?").run(now, run.id);
      if (["plan_revision", "plan_revision_review"].includes(run.trigger_type)) {
        if (!run.execution_grant_id || grantById(database, run.execution_grant_id).status !== "active") continue;
        database.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?").run(now, run.task_id);
        retries.push(reserveRun(database, run.execution_grant_id, run.task_id, run.trigger_type, run.trigger_ref_id ?? "", run.id, run.config_snapshot_json, run.context_snapshot_json, "supervisor"));
        continue;
      }
      if (run.trigger_type === "coordinate") {
        const revision = (database.prepare("SELECT coordination_revision FROM commissions WHERE id = ?").get(run.commission_id) as { coordination_revision: number }).coordination_revision;
        if (run.coordination_revision !== revision) continue;
      }
      const root = run.retry_root_run_id ?? run.id;
      if (run.trigger_type === "coordinate" && run.retry_root_run_id) {
        database.prepare("UPDATE tasks SET status = 'todo', blocked_reason = NULL, updated_at = ? WHERE id = ?").run(now, run.task_id);
        database.prepare("UPDATE commissions SET status = 'blocked', coordination_pending = 0, updated_at = ? WHERE id = ?").run(now, run.commission_id);
        if (run.execution_grant_id) database.prepare("UPDATE execution_grants SET status = 'exhausted' WHERE id = ? AND status = 'active'").run(run.execution_grant_id);
        addRunCommentOnce(database, { taskId: run.task_id, runId: run.id, authorType: "system", kind: "blocker", content: "调度 Run 连续两次因服务重启中断，已停止自动恢复，请人工检查后重新触发调度。" });
        notify(database, "blocked", "调度需要人工处理", "调度 Run 连续两次因服务重启中断。", "task", run.task_id);
        blockedCommissions.push(run.commission_id);
        continue;
      }
      if (run.retry_root_run_id || database.prepare("SELECT 1 FROM runs WHERE retry_root_run_id = ?").get(root)) continue;
      if (!run.execution_grant_id || grantById(database, run.execution_grant_id).status !== "active") continue;
      database.prepare("UPDATE tasks SET status = ?, blocked_reason = NULL, updated_at = ? WHERE id = ?").run(run.trigger_type === "coordinate" ? "in_progress" : "todo", now, run.task_id);
      retries.push(reserveRun(database, run.execution_grant_id, run.task_id, run.trigger_type === "coordinate" ? "coordinate" : "auto_retry", run.id, root, run.config_snapshot_json, run.trigger_type === "coordinate" ? "{}" : run.context_snapshot_json, run.role, run.coordination_revision));
    }
    return retries;
  });
}

function reserveRoutedRun(database: DatabaseSync, grantId: string, taskId: string): string {
  const previous = database.prepare("SELECT id FROM runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1").get(taskId) as { id: string } | undefined;
  return previous
    ? reserveRun(database, grantId, taskId, "reconcile", previous.id, null, undefined, "{}", "supervisor")
    : reserveRun(database, grantId, taskId, "scheduler", grantId);
}

function reserveRun(database: DatabaseSync, grantId: string, taskId: string, triggerType: string, triggerRefId: string, retryRootRunId: string | null = null, config?: string, context = "{}", role = "developer", coordinationRevision: number | null = null): string {
  const task = database.prepare("SELECT commission.project_id, task.commission_id FROM tasks AS task JOIN commissions AS commission ON commission.id = task.commission_id WHERE task.id = ?").get(taskId) as { project_id: string; commission_id: string };
  const id = randomUUID();
  const attempt = count(database, "SELECT COALESCE(MAX(attempt_no), 0) AS count FROM runs WHERE task_id = ?", taskId) + 1;
  const resolved = resolvedRoleConfig(database, task.project_id, role);
  const configSnapshot = config ?? JSON.stringify(role === "supervisor" ? { ...resolved, sandboxMode: "read-only", approvalPolicy: "never", networkAccess: false } : resolved);
  database.prepare(`INSERT OR IGNORE INTO runs (id, project_id, commission_id, task_id, role, trigger_type, trigger_ref_id, execution_grant_id, retry_root_run_id, status, attempt_no, config_snapshot_json, context_snapshot_json, coordination_revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`).run(id, task.project_id, task.commission_id, taskId, role, triggerType, triggerRefId, grantId, retryRootRunId, attempt, configSnapshot, context, coordinationRevision);
  const reserved = database.prepare(`SELECT id FROM runs WHERE task_id = ? AND status IN (${RESERVED_RUN_STATUSES.map(() => "?").join(", ")})`).get(taskId, ...RESERVED_RUN_STATUSES) as { id: string } | undefined;
  if (!reserved) throw new Error("Run reservation failed");
  return reserved.id;
}

export const SUPERVISOR_ACTIONS = ["resume_reviewer", "resume_developer", "rework_developer", "restart_developer", "replan", "wait_human"] as const;
export type SupervisorAction = typeof SUPERVISOR_ACTIONS[number];
export type SupervisorDecision = { action: SupervisorAction; summary: string };

export function parseSupervisorDecision(output: string): SupervisorDecision {
  const json = /```(?:json)?\s*([\s\S]*?)```/i.exec(output)?.[1] ?? output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error("Supervisor returned invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Supervisor returned invalid decision");
  const decision = value as Record<string, unknown>;
  if (!SUPERVISOR_ACTIONS.includes(decision.action as SupervisorAction) || typeof decision.summary !== "string" || !decision.summary.trim()) throw new Error("Supervisor returned invalid decision");
  return { action: decision.action as SupervisorAction, summary: decision.summary.trim() };
}

const COORDINATOR_ACTIONS = ["proceed", "complete", "block", "replan", "wait_human"] as const;
const COORDINATOR_TASK_ACTIONS = ["start", "retry", "resume", "block"] as const;
type CoordinatorTaskAction = { taskId: string; action: typeof COORDINATOR_TASK_ACTIONS[number]; reason?: string };
type CoordinatorDecision = { action: typeof COORDINATOR_ACTIONS[number]; summary: string; tasks?: CoordinatorTaskAction[] };
type PlanRevisionDecision = { action: "ask"; question: RevisionQuestion } | { action: "review"; proposal: RevisionProposal };
type PlanRevisionReview = { approved: boolean; summary: string; question?: RevisionQuestion };

function parseCoordinatorDecision(output: string): CoordinatorDecision {
  const json = /```(?:json)?\s*([\s\S]*?)```/i.exec(output)?.[1] ?? output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error("Coordinator returned invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Coordinator returned invalid decision");
  const decision = value as Record<string, unknown>;
  if (!COORDINATOR_ACTIONS.includes(decision.action as CoordinatorDecision["action"]) || typeof decision.summary !== "string" || !decision.summary.trim()) throw new Error("Coordinator returned invalid decision");
  const tasks = decision.tasks === undefined ? [] : Array.isArray(decision.tasks) ? decision.tasks.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Coordinator returned invalid task action");
    const action = item as Record<string, unknown>;
    if (typeof action.taskId !== "string" || !action.taskId || !COORDINATOR_TASK_ACTIONS.includes(action.action as CoordinatorTaskAction["action"])) throw new Error("Coordinator returned invalid task action");
    if (action.action === "block" && (typeof action.reason !== "string" || !action.reason.trim())) throw new Error("Coordinator block action requires a reason");
    return { taskId: action.taskId, action: action.action as CoordinatorTaskAction["action"], ...(action.action === "block" ? { reason: String(action.reason).trim() } : {}) };
  }) : (() => { throw new Error("Coordinator returned invalid tasks"); })();
  if (decision.action === "proceed" && !tasks.length) throw new Error("Coordinator proceed decision requires task actions");
  if (decision.action === "block" && (!tasks.length || tasks.some(({ action }) => action !== "block"))) throw new Error("Coordinator block decision requires block actions");
  if (decision.action !== "proceed" && decision.action !== "block" && tasks.length) throw new Error("Coordinator task actions require proceed or block");
  if (decision.action === "proceed" && tasks.some(({ action }) => action === "block")) throw new Error("Coordinator block actions require a block decision");
  if (new Set(tasks.map(({ taskId }) => taskId)).size !== tasks.length) throw new Error("Coordinator task actions must be unique");
  return { action: decision.action as CoordinatorDecision["action"], summary: decision.summary.trim(), ...(tasks.length ? { tasks } : {}) };
}

function applyCoordinatorDecision(database: DatabaseSync, run: RunRow, decision: CoordinatorDecision): "queued" | "settled" | "blocked" | "revision" {
  const now = new Date().toISOString();
  addRunCommentOnce(database, { taskId: run.task_id, runId: run.id, authorType: "agent", agentRole: "supervisor", content: `## 调度决策：${decision.action}\n\n${decision.action === "wait_human" ? "@负责人 " : ""}${decision.summary}` });
  if (decision.action === "block") {
    for (const { taskId, reason } of decision.tasks ?? []) {
      const task = database.prepare(`SELECT task.id, task.title, task.status, commission.main_task_id FROM tasks AS task JOIN commissions AS commission ON commission.id = task.commission_id WHERE task.id = ? AND task.commission_id = ?`).get(taskId, run.commission_id) as { id: string; title: string; status: string; main_task_id: string | null } | undefined;
      if (!task || task.id === task.main_task_id || task.status !== "done") throw conflict(`只能阻塞待复核的 Done 子任务：${taskId}`);
      const blockedReason = reason ?? decision.summary;
      database.prepare("UPDATE tasks SET status = 'blocked', blocked_reason = ?, human_waiver_reason = NULL, updated_at = ? WHERE id = ?").run(blockedReason, now, task.id);
      addMainTaskComment(database, { sourceTaskId: task.id, runId: run.id, kind: "blocker", content: `收口复核发现子任务实际未完成。\n\n${blockedReason}` });
      notify(database, "blocked", `任务阻塞：${task.title}`, blockedReason, "task", task.id);
    }
    database.prepare("UPDATE tasks SET status = 'todo', blocked_reason = NULL, updated_at = ? WHERE id = ?").run(now, run.task_id);
    database.prepare("UPDATE commissions SET status = 'blocked', updated_at = ? WHERE id = ?").run(now, run.commission_id);
    database.prepare("UPDATE execution_grants SET status = 'exhausted' WHERE id = ?").run(run.execution_grant_id);
    return "blocked";
  }
  if (decision.action === "proceed") {
    const actions = decision.tasks ?? [];
    const rows = actions.map(({ taskId, action }) => {
      const task = database.prepare(`SELECT task.id, task.status, task.owner_type, task.archived_at, commission.main_task_id
        FROM tasks AS task JOIN commissions AS commission ON commission.id = task.commission_id
        WHERE task.id = ? AND task.commission_id = ?`).get(taskId, run.commission_id) as { id: string; status: string; owner_type: string; archived_at: string | null; main_task_id: string | null } | undefined;
      if (!task || task.archived_at || task.id === task.main_task_id || task.owner_type !== "ai") throw conflict(`调度目标不可执行：${taskId}`);
      if (database.prepare("SELECT 1 FROM task_dependencies AS dependency JOIN tasks AS required ON required.id = dependency.depends_on_task_id WHERE dependency.task_id = ? AND required.status <> 'done' LIMIT 1").get(task.id)) throw conflict(`调度目标依赖未完成：${taskId}`);
      if (database.prepare(`SELECT 1 FROM runs WHERE task_id = ? AND status IN (${RESERVED_RUN_STATUSES.map(() => "?").join(", ")})`).get(task.id, ...RESERVED_RUN_STATUSES)) throw conflict(`调度目标已有 Run：${taskId}`);
      const previous = database.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1").get(task.id) as RunRow | undefined;
      if (action === "start" && !["todo", "in_progress"].includes(task.status)) throw conflict(`调度目标不能启动：${taskId}`);
      if (action === "retry" && task.status !== "blocked") throw conflict(`调度目标不是 Blocked：${taskId}`);
      if (action === "resume" && (task.status !== "in_progress" || previous?.status !== "interrupted")) throw conflict(`调度目标没有可恢复的 Interrupted Run：${taskId}`);
      return { task, action, previous };
    });
    for (const { task, action, previous } of rows) {
      if (action !== "start" || task.status !== "todo") database.prepare("UPDATE tasks SET status = 'todo', blocked_reason = NULL, human_waiver_reason = NULL, updated_at = ? WHERE id = ?").run(now, task.id);
      if (action === "resume") reserveRun(database, run.execution_grant_id!, task.id, "resume", previous!.id, null, previous!.config_snapshot_json, previous!.context_snapshot_json, previous!.role);
      else reserveRoutedRun(database, run.execution_grant_id!, task.id);
    }
    return "queued";
  }
  if (decision.action === "complete") {
    if (!updateCommissionAcceptance(database, run.commission_id)) throw conflict("委托仍有未完成任务，不能进入验收");
    database.prepare("UPDATE execution_grants SET status = 'exhausted' WHERE id = ?").run(run.execution_grant_id);
    return "settled";
  }
  if (decision.action === "replan") {
    beginPlanRevision(database, run.commission_id, decision.summary);
    database.prepare("UPDATE tasks SET status = 'in_progress', blocked_reason = NULL, updated_at = ? WHERE id = ?").run(now, run.task_id);
    notify(database, "blocked", "计划修订等待确认", decision.summary, "task", run.task_id);
    return "revision";
  }
  const reason = `等待人工处理：${decision.summary}`;
  database.prepare("UPDATE tasks SET status = 'todo', blocked_reason = NULL, updated_at = ? WHERE id = ?").run(now, run.task_id);
  database.prepare("UPDATE commissions SET status = 'blocked', updated_at = ? WHERE id = ?").run(now, run.commission_id);
  database.prepare("UPDATE execution_grants SET status = 'exhausted' WHERE id = ?").run(run.execution_grant_id);
  notify(database, "blocked", "调度需要人工处理", reason, "task", run.task_id);
  return "blocked";
}

export function parsePlanRevisionDecision(output: string): PlanRevisionDecision {
  const value = parseJsonObject(output, "Plan revision supervisor");
  if (value.action === "ask") return { action: "ask", question: parseRevisionQuestion(value.question) };
  if (value.action === "review") return { action: "review", proposal: parseRevisionProposal(value.proposal) };
  throw new Error("Plan revision supervisor returned an invalid action");
}

export function parsePlanRevisionReview(output: string): PlanRevisionReview {
  const value = parseJsonObject(output, "Plan revision reviewer");
  if (typeof value.approved !== "boolean" || typeof value.summary !== "string" || !value.summary.trim()) throw new Error("Plan revision reviewer returned an invalid decision");
  const decision: PlanRevisionReview = { approved: value.approved, summary: value.summary.trim() };
  if (!value.approved && value.question !== undefined) {
    try { decision.question = parseRevisionQuestion(value.question); } catch { /* fall back to a text card carrying the review summary */ }
  }
  return decision;
}

function parseRevisionQuestion(value: unknown): RevisionQuestion {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Plan revision question is invalid");
  const question = value as Record<string, unknown>;
  const type = question.type;
  const options = question.options === undefined ? [] : question.options;
  if (!REVISION_INTERACTIONS.includes(type as RevisionQuestion["type"]) || typeof question.prompt !== "string" || !question.prompt.trim() || !Array.isArray(options) || options.some((option) => typeof option !== "string" || !option.trim())) throw new Error("Plan revision question is invalid");
  if (type === "boolean" && options.length !== 2) throw new Error("Plan revision boolean requires exactly two options");
  if (type === "single_choice" && options.length < 2) throw new Error("Plan revision question requires at least two options");
  if (type === "multiple_choice" && !options.length) throw new Error("Plan revision question requires options");
  if (type === "text" && options.length) throw new Error("Plan revision text question cannot have options");
  return { type: type as RevisionQuestion["type"], prompt: question.prompt.trim(), options: options.map(String) };
}

function parseJsonObject(output: string, label: string): Record<string, unknown> {
  const json = /```(?:json)?\s*([\s\S]*?)```/i.exec(output)?.[1] ?? output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error(`${label} returned invalid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} returned invalid JSON`);
  return value as Record<string, unknown>;
}

function applySupervisorDecision(database: DatabaseSync, run: RunRow, decision: SupervisorDecision): "queued" | "blocked" {
  const now = new Date().toISOString();
  addRunCommentOnce(database, { taskId: run.task_id, runId: run.id, authorType: "agent", agentRole: "supervisor", content: `## 主管恢复决策：${decision.action}\n\n${decision.summary}` });
  if (decision.action === "wait_human" || decision.action === "replan") {
    const reason = decision.action === "replan" ? `主管建议重新规划：${decision.summary}` : `等待人工处理：${decision.summary}`;
    database.prepare("UPDATE tasks SET status = 'blocked', blocked_reason = ?, updated_at = ? WHERE id = ?").run(reason, now, run.task_id);
    const task = database.prepare("SELECT title FROM tasks WHERE id = ?").get(run.task_id) as { title: string };
    addRunCommentOnce(database, { taskId: run.task_id, runId: run.id, authorType: "system", kind: "blocker", content: reason });
    if (decision.action === "replan") beginPlanRevision(database, run.commission_id, decision.summary);
    else addMainTaskComment(database, { sourceTaskId: run.task_id, runId: run.id, kind: "blocker", content: `主管恢复判断要求人工处理。\n\n${decision.summary}` });
    notify(database, "blocked", `任务阻塞：${task.title}`, reason, "task", run.task_id);
    return "blocked";
  }
  if (["resume_reviewer", "resume_developer", "restart_developer"].includes(decision.action)) {
    database.prepare("UPDATE tasks SET status = 'todo', blocked_reason = NULL, updated_at = ? WHERE id = ?").run(now, run.task_id);
  }
  if (decision.action === "restart_developer") {
    reserveRun(database, run.execution_grant_id!, run.task_id, "restart", run.id);
  } else if (decision.action === "resume_reviewer") {
    reserveRun(database, run.execution_grant_id!, run.task_id, "resume", run.id, null, undefined, "{}", "reviewer");
  } else if (decision.action === "resume_developer") {
    reserveRun(database, run.execution_grant_id!, run.task_id, "resume", run.id);
  } else {
    reserveRun(database, run.execution_grant_id!, run.task_id, "rework", run.id);
  }
  addRunCommentOnce(database, { taskId: run.task_id, runId: run.id, authorType: "system", content: `主管已完成恢复协调，下一步：${decision.action}。` });
  return "queued";
}

function databaseRunTriggeredBy(database: DatabaseSync, runId: string, role: string): string | undefined {
  return (database.prepare("SELECT id FROM runs WHERE trigger_ref_id = ? AND role = ? ORDER BY rowid LIMIT 1").get(runId, role) as { id: string } | undefined)?.id;
}

function finalCoordinationMainTask(database: DatabaseSync, commissionId: string): string | undefined {
  const main = database.prepare("SELECT main_task_id FROM commissions WHERE id = ? AND status IN ('active', 'blocked') AND archived_at IS NULL").get(commissionId) as { main_task_id: string | null } | undefined;
  if (!main?.main_task_id) return undefined;
  const state = database.prepare("SELECT COUNT(*) AS total, SUM(status <> 'done') AS unfinished FROM tasks WHERE commission_id = ? AND id <> ? AND archived_at IS NULL").get(commissionId, main.main_task_id) as { total: number; unfinished: number | null };
  return state.total > 0 && !state.unfinished ? main.main_task_id : undefined;
}

export type ReviewResult = { passed: boolean; summary: string; checks: unknown[]; findings: unknown[] };

export function parseReviewResult(output: string): ReviewResult {
  const json = /```(?:json)?\s*([\s\S]*?)```/i.exec(output)?.[1] ?? output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error("Reviewer returned invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Reviewer returned invalid result");
  const result = value as Record<string, unknown>;
  if (typeof result.passed !== "boolean" || typeof result.summary !== "string" || !Array.isArray(result.checks) || !Array.isArray(result.findings)) throw new Error("Reviewer returned invalid result");
  const blocking = result.findings.some((finding) => finding && typeof finding === "object" && (finding as Record<string, unknown>).severity === "blocking");
  return { passed: !blocking, summary: result.summary, checks: result.checks, findings: result.findings };
}

function reviewResult(database: DatabaseSync, runId: string): ReviewResult {
  return parseReviewResult(runAgentOutput(database, runId));
}

function consecutiveFailedReviewCount(database: DatabaseSync, taskId: string): number {
  const reviews = database.prepare("SELECT status FROM evidence WHERE task_id = ? AND type = 'review' ORDER BY rowid DESC").all(taskId) as Array<{ status: string }>;
  let failed = 0;
  for (const review of reviews) {
    if (review.status !== "failed") break;
    failed += 1;
  }
  return failed;
}

function runAgentOutput(database: DatabaseSync, runId: string): string {
  const rows = database.prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND event_type IN ('agent.message.delta', 'item.completed') ORDER BY id").all(runId) as Array<{ payload_json: string }>;
  let output = "";
  let itemId: string | undefined;
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    if (typeof payload.delta === "string") {
      if (typeof payload.itemId === "string" && payload.itemId !== itemId) {
        itemId = payload.itemId;
        output = "";
      }
      output += payload.delta;
    }
    const item = payload.item as Record<string, unknown> | undefined;
    if (item?.type === "agentMessage" && typeof item.content === "string") {
      itemId = typeof item.id === "string" ? item.id : itemId;
      output = item.content;
    }
  }
  return output;
}

function reviewComment(review: ReviewResult): string {
  const findings = review.findings.map((finding) => typeof finding === "string" ? finding : JSON.stringify(finding));
  return `## 代码审查结果：${review.passed ? "通过" : "未通过"}\n\n${review.summary}${findings.length ? `\n\n### 发现\n\n${findings.map((finding) => `- ${finding}`).join("\n")}` : ""}${review.passed ? "" : "\n\n@负责人 请关注审查结论与后续返工。"}`;
}

function canStartRun(database: DatabaseSync, run: RunRow): boolean {
  if (!run.execution_grant_id || grantById(database, run.execution_grant_id).status !== "active") return false;
  if (run.trigger_type === "coordinate" && !database.prepare("SELECT 1 FROM commissions WHERE id = ? AND coordination_revision = ? AND coordination_pending = 1").get(run.commission_id, run.coordination_revision)) return false;
  if (!database.prepare(`SELECT 1 FROM commissions AS commission
    JOIN projects AS project ON project.id = commission.project_id
    JOIN root_paths AS root ON root.id = project.root_path_id
    WHERE commission.id = ? AND commission.status = 'active' AND commission.archived_at IS NULL AND project.archived_at IS NULL AND root.enabled = 1`).get(run.commission_id)) return false;
  const taskStatus = ["review", "rework", "coordinate", "plan_revision", "plan_revision_review"].includes(run.trigger_type) ? "in_progress" : "todo";
  if (!database.prepare("SELECT 1 FROM tasks WHERE id = ? AND status = ? AND archived_at IS NULL").get(run.task_id, taskStatus)) return false;
  if (database.prepare("SELECT 1 FROM task_dependencies AS dependency JOIN tasks AS required ON required.id = dependency.depends_on_task_id WHERE dependency.task_id = ? AND required.status <> 'done' LIMIT 1").get(run.task_id)) return false;
  if (database.prepare("SELECT 1 FROM approvals JOIN runs ON runs.id = approvals.run_id WHERE runs.project_id = ? AND approvals.kind = 'high_risk' AND approvals.status = 'pending' LIMIT 1").get(run.project_id)) return false;
  const placeholders = ACTIVE_RUN_STATUSES.map(() => "?").join(", ");
  return count(database, `SELECT COUNT(*) AS count FROM runs WHERE status IN (${placeholders})`, ...ACTIVE_RUN_STATUSES) < setting(database, "globalConcurrency", 4)
    && count(database, `SELECT COUNT(*) AS count FROM runs WHERE project_id = ? AND status IN (${placeholders})`, run.project_id, ...ACTIVE_RUN_STATUSES) < setting(database, "projectConcurrency", 2);
}

function grantById(database: DatabaseSync, id: string): GrantRow { const grant = database.prepare("SELECT * FROM execution_grants WHERE id = ?").get(id) as GrantRow | undefined; if (!grant) throw new Error("Execution grant not found"); return grant; }
function runById(database: DatabaseSync, id: string): RunRow { const run = database.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined; if (!run) throw new Error("Run not found"); return run; }
function count(database: DatabaseSync, sql: string, ...values: string[]): number { return Number((database.prepare(sql).get(...values) as { count: number }).count); }
function setting(database: DatabaseSync, key: string, fallback: number): number { const row = database.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined; const value = row && JSON.parse(row.value_json); return Number.isInteger(value) && value > 0 ? value : fallback; }
function transaction<T>(database: DatabaseSync, action: () => T): T { database.exec("BEGIN IMMEDIATE"); try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } }
async function execute(file: string, args: string[], cwd: string): Promise<string> { return (await runFile(file, args, { cwd, encoding: "utf8", windowsHide: true })).stdout; }
function statusError(message: string, statusCode: number): Error { return Object.assign(new Error(message), { statusCode }); }
const conflict = (message: string) => statusError(message, 409);
