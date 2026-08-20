import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { generateAcceptanceDocuments } from "./documents.ts";
import { notify } from "./notifications.ts";
import type { CommandRunner, VcsInfo } from "./projects.ts";
import { ProjectLockManager } from "./scheduler.ts";
import { commissionAttributionSnapshot, contentHash, type WorkspaceChange, type WorkspaceSnapshot } from "./workspace-changes.ts";

const runFile = promisify(execFile);
const ACTIVE_DELIVERY_STATUSES = ["queued", "preparing", "running"] as const;
const ACTIVE_RUN_STATUSES = ["queued", "preparing", "running", "waiting_approval", "waiting_input"] as const;

export type DeliveryMethod = "document" | "vcs_commit" | "github_pr";
export type DeliveryStatus = typeof ACTIVE_DELIVERY_STATUSES[number] | "waiting_human" | "failed" | "cancelled" | "succeeded";
type StepStatus = "pending" | "running" | "succeeded" | "failed" | "unknown";
type JsonObject = Record<string, unknown>;

type DeliveryRequest = {
  method: DeliveryMethod;
  commitMessage: string | null;
  remote: string | null;
  sourceBranch: string | null;
  targetBranch: string | null;
  draft: boolean;
  prTitle: string | null;
  prBody: string | null;
};

type DeliveryProgress = {
  currentStep: string | null;
  reconcileRequired: boolean;
  steps: Record<string, { status: StepStatus; updatedAt: string; detail: string | null }>;
};

type DeliveryRow = {
  id: string;
  commission_id: string;
  main_task_id: string;
  method: DeliveryMethod;
  status: DeliveryStatus;
  request_json: string;
  preview_json: string;
  progress_json: string;
  result_json: string;
  external_effect_started: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type AttemptRow = {
  id: string;
  delivery_id: string;
  attempt_no: number;
  status: DeliveryStatus;
  request_json: string;
  preview_json: string;
  progress_json: string;
  result_json: string;
  failure_code: string | null;
  failure_summary: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

type DeliveryContext = {
  taskId: string;
  taskTitle: string;
  taskArchivedAt: string | null;
  commissionId: string;
  commissionTitle: string;
  commissionStatus: string;
  commissionArchivedAt: string | null;
  lifecycleOperation: string | null;
  projectId: string;
  projectRoot: string;
  projectArchivedAt: string | null;
  rootEnabled: number;
  vcsType: VcsInfo["type"];
};

type Capability = { available: boolean; reason: string | null };
type DeliveryCapabilities = {
  vcsType: VcsInfo["type"];
  document: Capability;
  vcs_commit: Capability;
  github_pr: Capability;
  files: string[];
  unownedPaths: string[];
  driftedPaths: string[];
  git: { branch: string | null; head: string | null; detached: boolean } | null;
  github: { remotes: string[]; selectedRemote: string | null; repository: string | null; defaultBranch: string | null } | null;
};

type PreviewFile = WorkspaceChange;
type DeliveryPreview = {
  version: 1;
  fingerprint: string;
  taskId: string;
  commissionId: string;
  projectId: string;
  method: DeliveryMethod;
  request: DeliveryRequest;
  files: PreviewFile[];
  snapshot: WorkspaceSnapshot | null;
  baseline: { branch: string | null; head: string | null; svnRevision: string | null };
  remote: string | null;
  repository: string | null;
  sourceBranch: string | null;
  targetBranch: string | null;
  draft: boolean;
};

type ActiveDelivery = { delivery: DeliveryRow; attempt: AttemptRow };
type GitState = { branch: string | null; head: string; detached: boolean; upstreamRemote: string | null };
type GitHubRemote = { name: string; repository: string };

class DeliveryFailure extends Error {
  readonly code: string;
  readonly waitingHuman: boolean;

  constructor(code: string, message: string, waitingHuman = false) {
    super(message);
    this.code = code;
    this.waitingHuman = waitingHuman;
  }
}

export class DeliveryWorker {
  readonly acceptanceDetails = async (taskId: string): Promise<Record<string, unknown>> => {
    const context = deliveryContext(this.database, taskId, true);
    const delivery = deliveryForCommission(this.database, context.commissionId);
    const attempts = delivery ? attemptsForDelivery(this.database, delivery.id) : [];
    return {
      deliveryCapabilities: await this.capabilities(context),
      delivery: delivery ? deliveryView(delivery, attempts) : null,
      currentDelivery: delivery ? deliveryView(delivery, attempts) : null,
      deliveryAttempts: attempts.map(attemptView)
    };
  };

  private readonly database: DatabaseSync;
  private readonly locks: ProjectLockManager;
  private readonly runner: CommandRunner;
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  private wakeAgain = false;
  private started = false;
  private stopped = false;

  constructor(database: DatabaseSync, locks = new ProjectLockManager(), runner: CommandRunner = execute) {
    this.database = database;
    this.locks = locks;
    this.runner = runner;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    markRecoveryRequired(this.database);
    this.timer = setInterval(() => void this.wake(), 500);
    this.timer.unref();
    void this.wake();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }

  async wake(): Promise<void> {
    if (this.stopped) return;
    if (this.active) {
      this.wakeAgain = true;
      await this.active;
      return;
    }
    this.active = this.drain();
    try { await this.active; }
    finally {
      this.active = undefined;
      if (this.wakeAgain && !this.stopped) {
        this.wakeAgain = false;
        void this.wake();
      }
    }
  }

  async preview(taskId: string, body: Record<string, unknown>): Promise<DeliveryPreview & { capabilities: DeliveryCapabilities }> {
    const context = deliveryContext(this.database, taskId);
    const existing = deliveryForCommission(this.database, context.commissionId);
    const request = normalizedRequest(body, context, currentDeliveryDocument(this.database, context.commissionId), existing);
    const { preview, capabilities } = await this.createPreview(context, request);
    return { ...preview, capabilities };
  }

  async create(taskId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const context = deliveryContext(this.database, taskId);
    assertAwaitingAcceptance(context);
    const existing = deliveryForCommission(this.database, context.commissionId);
    const input = requestBody(body);
    const request = normalizedRequest(input, context, currentDeliveryDocument(this.database, context.commissionId), existing);
    const expectedFingerprint = requiredString(input.previewFingerprint ?? input.preview_fingerprint ?? input.fingerprint ?? record(input.preview).fingerprint, "previewFingerprint");
    const { preview } = await this.createPreview(context, request);
    if (preview.fingerprint !== expectedFingerprint) throw conflict("Delivery preview expired; generate a new preview");
    assertNoActiveWriteRun(this.database, context.projectId);
    const release = this.locks.tryAcquire(context.projectId, "exclusive");
    if (!release) throw conflict("Project is busy; retry delivery after the active workspace operation finishes");
    release();

    const delivery = transaction(this.database, () => {
      const current = deliveryForCommission(this.database, context.commissionId);
      if (current?.status === "succeeded" || context.commissionStatus === "done") throw conflict("Commission is already delivered");
      if (current && !["failed", "cancelled"].includes(current.status)) throw conflict("Delivery already has an active or unresolved attempt");
      if (current?.external_effect_started) assertLockedRequest(current, request);
      const now = new Date().toISOString();
      const id = current?.id ?? randomUUID();
      const attemptNo = current ? nextAttemptNo(this.database, current.id) : 1;
      const progress = initialProgress(request.method);
      if (current) {
        this.database.prepare("UPDATE deliveries SET method = ?, status = 'queued', request_json = ?, preview_json = ?, progress_json = ?, result_json = '{}', updated_at = ?, completed_at = NULL WHERE id = ?")
          .run(request.method, JSON.stringify(request), JSON.stringify(preview), JSON.stringify(progress), now, current.id);
      } else {
        this.database.prepare("INSERT INTO deliveries (id, commission_id, main_task_id, method, status, request_json, preview_json, progress_json, result_json, external_effect_started, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, '{}', 0, ?, ?)")
          .run(id, context.commissionId, context.taskId, request.method, JSON.stringify(request), JSON.stringify(preview), JSON.stringify(progress), now, now);
      }
      this.database.prepare("INSERT INTO delivery_attempts (id, delivery_id, attempt_no, status, request_json, preview_json, progress_json, result_json, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)")
        .run(randomUUID(), id, attemptNo, JSON.stringify(request), JSON.stringify(preview), JSON.stringify(progress), "{}", now);
      return deliveryById(this.database, id);
    });
    this.start();
    void this.wake();
    return deliveryView(delivery, attemptsForDelivery(this.database, delivery.id));
  }

  get(id: string): Record<string, unknown> {
    const delivery = deliveryById(this.database, id);
    return deliveryView(delivery, attemptsForDelivery(this.database, delivery.id));
  }

  retry(id: string): Record<string, unknown> {
    const delivery = transaction(this.database, () => {
      const current = deliveryById(this.database, id);
      if (current.status === "succeeded") throw conflict("Delivery already succeeded");
      if (current.status === "waiting_human") throw conflict("Delivery requires human reconciliation before retry");
      if (current.status !== "failed") throw conflict("Only a failed delivery can be retried");
      const now = new Date().toISOString();
      const progress = readProgress(current.progress_json);
      progress.reconcileRequired = Boolean(current.external_effect_started);
      this.database.prepare("UPDATE deliveries SET status = 'queued', progress_json = ?, updated_at = ?, completed_at = NULL WHERE id = ?")
        .run(JSON.stringify(progress), now, current.id);
      this.database.prepare("INSERT INTO delivery_attempts (id, delivery_id, attempt_no, status, request_json, preview_json, progress_json, result_json, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)")
        .run(randomUUID(), current.id, nextAttemptNo(this.database, current.id), current.request_json, current.preview_json, JSON.stringify(progress), current.result_json, now);
      return deliveryById(this.database, current.id);
    });
    this.start();
    void this.wake();
    return deliveryView(delivery, attemptsForDelivery(this.database, delivery.id));
  }

  reconcile(id: string, body: Record<string, unknown>): Record<string, unknown> {
    const decision = requiredString(body.decision, "decision");
    const current = deliveryById(this.database, id);
    if (current.status !== "waiting_human") throw conflict("Only a waiting_human delivery can be reconciled");
    if (decision === "retry") {
      if (body.confirmedNoExternalEffect !== true) throw badRequest("confirmedNoExternalEffect must be true");
      const waitingAttempt = activeAttempt(this.database, id);
      if (!waitingAttempt) throw conflict("Delivery has no waiting attempt");
      const delivery = transaction(this.database, () => {
        const now = new Date().toISOString();
        const progress = readProgress(current.progress_json);
        for (const step of Object.values(progress.steps)) if (step.status === "unknown") step.status = "pending";
        progress.currentStep = null;
        progress.reconcileRequired = false;
        this.database.prepare("UPDATE delivery_attempts SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'waiting_human'").run(now, waitingAttempt.id);
        this.database.prepare("UPDATE deliveries SET status = 'queued', external_effect_started = 0, progress_json = ?, updated_at = ?, completed_at = NULL WHERE id = ? AND status = 'waiting_human'")
          .run(JSON.stringify(progress), now, id);
        this.database.prepare("INSERT INTO delivery_attempts (id, delivery_id, attempt_no, status, request_json, preview_json, progress_json, result_json, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)")
          .run(randomUUID(), id, nextAttemptNo(this.database, id), current.request_json, current.preview_json, JSON.stringify(progress), current.result_json, now);
        return deliveryById(this.database, id);
      });
      this.start();
      void this.wake();
      return deliveryView(delivery, attemptsForDelivery(this.database, id));
    }
    if (decision !== "complete") throw badRequest("decision must be retry or complete");
    const context = deliveryContextForCommission(this.database, current.commission_id);
    const result = record(body.result);
    validateReconciledResult(current.method, context.vcsType, result);
    const attempt = activeAttempt(this.database, id);
    if (!attempt) throw conflict("Delivery has no waiting attempt");
    this.finishSuccess({ delivery: current, attempt }, context, result);
    return this.get(id);
  }

  cancel(id: string): Record<string, unknown> {
    const delivery = transaction(this.database, () => {
      const current = deliveryById(this.database, id);
      if (current.external_effect_started || !["queued", "preparing"].includes(current.status)) throw conflict("Delivery cannot be cancelled after external work starts");
      const attempt = activeAttempt(this.database, current.id);
      if (!attempt || !["queued", "preparing"].includes(attempt.status)) throw conflict("Delivery has no cancellable attempt");
      const now = new Date().toISOString();
      this.database.prepare("UPDATE delivery_attempts SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('queued', 'preparing')").run(now, attempt.id);
      this.database.prepare("UPDATE deliveries SET status = 'cancelled', updated_at = ?, completed_at = ? WHERE id = ? AND status IN ('queued', 'preparing') AND external_effect_started = 0").run(now, now, current.id);
      return deliveryById(this.database, current.id);
    });
    return deliveryView(delivery, attemptsForDelivery(this.database, delivery.id));
  }

  private async drain(): Promise<void> {
    const rows = this.database.prepare("SELECT id FROM deliveries WHERE status IN ('queued', 'preparing', 'running') ORDER BY created_at, rowid").all() as Array<{ id: string }>;
    for (const { id } of rows) {
      if (this.stopped) return;
      await this.process(id);
    }
  }

  private async process(deliveryId: string): Promise<void> {
    let active = activeDelivery(this.database, deliveryId);
    if (!active || !ACTIVE_DELIVERY_STATUSES.includes(active.attempt.status as typeof ACTIVE_DELIVERY_STATUSES[number])) return;
    const context = deliveryContextForCommission(this.database, active.delivery.commission_id);
    const release = this.locks.tryAcquire(context.projectId, "exclusive");
    if (!release) {
      this.finishFailure(active, new DeliveryFailure("project_busy", "项目写锁被占用，请稍后重试。", Boolean(active.delivery.external_effect_started)));
      return;
    }
    try {
      assertNoActiveWriteRun(this.database, context.projectId);
      if (!claimPreparing(this.database, active)) return;
      active = activeDelivery(this.database, deliveryId);
      if (!active) return;
      const request = parseRequest(active.attempt.request_json);
      const preview = parsePreview(active.attempt.preview_json);
      if (!claimRunning(this.database, active)) return;
      active = activeDelivery(this.database, deliveryId);
      if (!active) return;
      if (request.method === "document") {
        this.setStep(active, "complete", "running");
        this.finishSuccess(active, context, { method: "document" });
        return;
      }
      if (!active.delivery.external_effect_started) {
        const current = await this.createPreview(context, request);
        if (current.preview.fingerprint !== preview.fingerprint) throw new DeliveryFailure("preview_expired", "交付预览已失效，请重新生成预览并确认。");
        markExternalStarted(this.database, active);
        active = activeDelivery(this.database, deliveryId)!;
      }
      const result = request.method === "github_pr"
        ? await this.githubDelivery(active, context, request, preview)
        : context.vcsType === "git"
          ? await this.gitCommit(active, context, request, preview)
          : await this.svnCommit(active, context, request, preview);
      this.finishSuccess(activeDelivery(this.database, deliveryId)!, context, result);
    } catch (error) {
      const current = activeDelivery(this.database, deliveryId);
      if (current) this.finishFailure(current, deliveryFailure(error, current.delivery.method));
    } finally { release(); }
  }

  private async capabilities(context: DeliveryContext, requestedRemote: string | null = null): Promise<DeliveryCapabilities> {
    const unavailable = unavailableReason(context);
    if (unavailable) return disabledCapabilities(context.vcsType, unavailable);
    if (context.vcsType === "none") return { ...disabledCapabilities("none", "项目没有版本控制"), document: { available: true, reason: null } };
    try {
      const attribution = await commissionAttributionSnapshot(this.database, context.commissionId, context.projectRoot, context.vcsType, this.runner);
      const files = attribution.ownedPaths;
      const attributionReason = attribution.driftedPaths.length ? `委托变更内容已漂移：${attribution.driftedPaths.join(", ")}` : null;
      const busyReason = hasActiveWriteRun(this.database, context.projectId) ? "项目存在活动写 Run" : null;
      if (context.vcsType === "svn") {
        const reason = busyReason ?? attributionReason;
        return {
          vcsType: "svn",
          document: { available: true, reason: null },
          vcs_commit: { available: !reason, reason },
          github_pr: { available: false, reason: "GitHub PR 仅支持 Git 项目" },
          files, unownedPaths: attribution.unownedPaths, driftedPaths: attribution.driftedPaths, git: null, github: null
        };
      }
      const git = await gitState(this.runner, context.projectRoot);
      const gitReason = busyReason ?? attributionReason ?? (git.detached ? "detached HEAD 无法提交交付" : null);
      const remotes = await githubRemotes(this.runner, context.projectRoot);
      const selected = selectGithubRemote(remotes, requestedRemote, git.upstreamRemote);
      let githubReason = gitReason ?? (!files.some(isCodePath) ? "当前委托没有可归属的代码变更" : null) ?? (!selected ? "没有 GitHub.com Remote" : null);
      let defaultBranch: string | null = null;
      if (!githubReason && selected) {
        try {
          await this.runner("gh", ["auth", "status", "--hostname", "github.com"], context.projectRoot);
          const repository = JSON.parse(await this.runner("gh", ["repo", "view", selected.repository, "--json", "defaultBranchRef"], context.projectRoot)) as { defaultBranchRef?: { name?: unknown } | null };
          defaultBranch = typeof repository.defaultBranchRef?.name === "string" ? repository.defaultBranchRef.name : null;
          if (!defaultBranch) githubReason = "无法读取 GitHub 仓库默认分支";
        } catch { githubReason = "gh 未登录或没有该 GitHub.com 仓库的访问权限"; }
      }
      return {
        vcsType: "git",
        document: { available: true, reason: null },
        vcs_commit: { available: !gitReason, reason: gitReason },
        github_pr: { available: !githubReason, reason: githubReason },
        files, unownedPaths: attribution.unownedPaths, driftedPaths: attribution.driftedPaths,
        git: { branch: git.branch, head: git.head, detached: git.detached },
        github: { remotes: remotes.map(({ name }) => name), selectedRemote: selected?.name ?? null, repository: selected?.repository ?? null, defaultBranch }
      };
    } catch {
      return { ...disabledCapabilities(context.vcsType, "无法读取项目版本控制状态"), document: { available: true, reason: null } };
    }
  }

  private async createPreview(context: DeliveryContext, request: DeliveryRequest): Promise<{ preview: DeliveryPreview; capabilities: DeliveryCapabilities }> {
    assertAwaitingAcceptance(context);
    const capabilities = await this.capabilities(context, request.remote);
    const capability = capabilities[request.method];
    if (!capability.available) throw conflict(capability.reason ?? "Delivery method is unavailable");
    if (request.method === "document") {
      const core = { version: 1, taskId: context.taskId, commissionId: context.commissionId, projectId: context.projectId, method: request.method, request, files: [], snapshot: null, baseline: { branch: null, head: null, svnRevision: null }, remote: null, repository: null, sourceBranch: null, targetBranch: null, draft: false } satisfies Omit<DeliveryPreview, "fingerprint">;
      return { preview: { ...core, fingerprint: fingerprint(core) }, capabilities };
    }
    const attribution = await commissionAttributionSnapshot(this.database, context.commissionId, context.projectRoot, context.vcsType, this.runner);
    if (attribution.driftedPaths.length) throw conflict(`Commission changes conflict with additional workspace changes: ${attribution.driftedPaths.join(", ")}`);
    const owned = new Set(attribution.ownedPaths);
    const files = attribution.snapshot.changes.filter(({ path }) => owned.has(path));
    if (!files.length) throw conflict("Current commission has no attributable repository changes");
    let branch: string | null = null, head: string | null = null, svnRevision: string | null = null;
    if (context.vcsType === "git") {
      const git = await gitState(this.runner, context.projectRoot);
      branch = git.branch; head = git.head;
    } else svnRevision = (await this.runner("svn", ["info", "--show-item", "revision"], context.projectRoot)).trim();
    const selectedRemote = request.method === "github_pr" ? capabilities.github?.selectedRemote ?? null : null;
    const repository = request.method === "github_pr" ? capabilities.github?.repository ?? null : null;
    const sourceBranch = request.method === "github_pr" ? request.sourceBranch ?? defaultSourceBranch(context) : null;
    const targetBranch = request.method === "github_pr" ? request.targetBranch ?? capabilities.github?.defaultBranch ?? null : null;
    if (request.method === "github_pr") {
      validRemote(selectedRemote);
      validBranch(sourceBranch, "sourceBranch");
      validBranch(targetBranch, "targetBranch");
    }
    const normalized = request.method === "github_pr" ? { ...request, remote: selectedRemote, sourceBranch, targetBranch } : request;
    const snapshot = { ...attribution.snapshot, changes: files };
    const core = { version: 1, taskId: context.taskId, commissionId: context.commissionId, projectId: context.projectId, method: request.method, request: normalized, files, snapshot, baseline: { branch, head, svnRevision }, remote: selectedRemote, repository, sourceBranch, targetBranch, draft: normalized.draft } satisfies Omit<DeliveryPreview, "fingerprint">;
    return { preview: { ...core, fingerprint: fingerprint(core) }, capabilities };
  }

  private async gitCommit(active: ActiveDelivery, context: DeliveryContext, request: DeliveryRequest, preview: DeliveryPreview): Promise<JsonObject> {
    const result = parseObject(active.delivery.result_json);
    const existingHash = optionalStoredString(result.commitHash);
    if (existingHash) {
      await verifyCommitExists(this.runner, context.projectRoot, existingHash);
      this.setStep(active, "commit", "succeeded", { commitHash: existingHash });
      return { ...result, method: request.method, commitHash: existingHash, branch: preview.sourceBranch ?? preview.baseline.branch };
    }
    const recoveredHash = await committedHead(this.runner, context.projectRoot, preview.baseline.head, request.commitMessage!);
    if (recoveredHash) {
      if (!await recoveredCommitMatchesPreview(this.database, context, preview, this.runner, recoveredHash)) {
        throw new DeliveryFailure("git_commit_unknown", "候选 Commit 与原交付预览不一致，无法确认外部结果，请人工核对。", true);
      }
      this.setStep(active, "commit", "succeeded", { commitHash: recoveredHash });
      return { ...result, method: request.method, commitHash: recoveredHash, branch: preview.sourceBranch ?? preview.baseline.branch };
    }
    await this.verifyCommitPreview(active, context, request, preview);
    this.setStep(active, "commit", "running");
    const message = request.commitMessage!;
    try {
      await this.runner("git", ["add", "--", ...preview.files.map(({ path }) => path)], context.projectRoot);
      await this.runner("git", ["commit", "--only", "-m", message, "--", ...preview.files.map(({ path }) => path)], context.projectRoot);
    } catch {
      const recovered = await committedHead(this.runner, context.projectRoot, preview.baseline.head, message);
      if (!recovered) throw new DeliveryFailure("git_commit_failed", "Git Commit 失败，请在终端检查 Hook、GPG 与本机 Git 配置后重试。");
      if (!await recoveredCommitMatchesPreview(this.database, context, preview, this.runner, recovered)) {
        throw new DeliveryFailure("git_commit_unknown", "候选 Commit 与原交付预览不一致，无法确认外部结果，请人工核对。", true);
      }
    }
    const commitHash = (await this.runner("git", ["rev-parse", "HEAD"], context.projectRoot)).trim();
    this.setStep(active, "commit", "succeeded", { commitHash });
    return { ...parseObject(deliveryById(this.database, active.delivery.id).result_json), method: request.method, commitHash, branch: preview.sourceBranch ?? preview.baseline.branch };
  }

  private async svnCommit(active: ActiveDelivery, context: DeliveryContext, request: DeliveryRequest, preview: DeliveryPreview): Promise<JsonObject> {
    const result = parseObject(active.delivery.result_json);
    const existingRevision = optionalStoredString(result.svnRevision) ?? optionalStoredString(result.commitId);
    if (existingRevision) {
      this.setStep(active, "commit", "succeeded", { svnRevision: existingRevision });
      return { ...result, method: request.method, svnRevision: existingRevision, commitId: existingRevision };
    }
    const currentRevision = (await this.runner("svn", ["info", "--show-item", "revision"], context.projectRoot)).trim();
    if (currentRevision !== preview.baseline.svnRevision) {
      throw new DeliveryFailure("svn_commit_unknown", "SVN 工作副本版本已变化，无法确认是否已发生本次提交，请人工核对。", true);
    }
    await this.verifyCommitPreview(active, context, request, preview);
    this.setStep(active, "commit", "running");
    let output: string;
    try {
      output = await this.runner("svn", ["commit", "--non-interactive", "--no-auth-cache", "-m", request.commitMessage!, ...preview.files.map(({ path }) => path)], context.projectRoot);
    } catch {
      const revision = (await this.runner("svn", ["info", "--show-item", "revision"], context.projectRoot).catch(() => "")).trim();
      if (revision && revision !== preview.baseline.svnRevision) throw new DeliveryFailure("svn_commit_unknown", "SVN 版本号已变化但无法确认是否为本次提交，请人工核对。", true);
      throw new DeliveryFailure("svn_commit_failed", "SVN Commit 失败，请先在终端完成凭据或工作副本处理后重试。");
    }
    const svnRevision = /(?:Committed revision|版本)\s*(\d+)/i.exec(output)?.[1] ?? (await this.runner("svn", ["info", "--show-item", "revision"], context.projectRoot)).trim();
    if (!svnRevision) throw new DeliveryFailure("svn_commit_unknown", "SVN Commit 已返回但无法确认版本号，请人工核对。", true);
    this.setStep(active, "commit", "succeeded", { svnRevision });
    return { method: request.method, svnRevision, commitId: svnRevision };
  }

  private async verifyCommitPreview(active: ActiveDelivery, context: DeliveryContext, request: DeliveryRequest, preview: DeliveryPreview): Promise<void> {
    const recovering = readProgress(active.delivery.progress_json).reconcileRequired;
    if (request.method === "vcs_commit" && context.vcsType === "git") {
      const git = await gitState(this.runner, context.projectRoot);
      if (git.branch !== preview.baseline.branch || git.head !== preview.baseline.head) {
        throw new DeliveryFailure(
          recovering ? "git_commit_unknown" : "preview_expired",
          recovering ? "恢复前 Git 分支或基线已变化，无法确认外部结果，请人工核对。" : "交付预览已失效，请重新生成预览并确认。",
          recovering,
        );
      }
    }
    const attribution = await commissionAttributionSnapshot(this.database, context.commissionId, context.projectRoot, context.vcsType, this.runner);
    const expected = new Map(preview.files.map((change) => [change.path, change]));
    const owned = new Set(attribution.ownedPaths);
    const actual = new Map(attribution.snapshot.changes.filter(({ path }) => owned.has(path)).map((change) => [change.path, change]));
    const matches = expected.size === actual.size && [...expected].every(([path, change]) => {
      const current = actual.get(path);
      return current?.changeType === change.changeType && current.hash === change.hash;
    });
    if (!attribution.driftedPaths.length && matches) return;
    throw new DeliveryFailure(
      recovering ? "delivery_state_unknown" : "preview_expired",
      recovering ? "恢复前无法确认工作区仍对应原交付预览，请人工核对外部结果。" : "交付预览已失效，请重新生成预览并确认。",
      recovering,
    );
  }

  private async githubDelivery(active: ActiveDelivery, context: DeliveryContext, request: DeliveryRequest, preview: DeliveryPreview): Promise<JsonObject> {
    const remote = validRemote(preview.remote);
    const repository = requiredString(preview.repository, "repository");
    const sourceBranch = validBranch(preview.sourceBranch, "sourceBranch");
    const targetBranch = validBranch(preview.targetBranch, "targetBranch");
    const originalBranch = requiredString(preview.baseline.branch, "baseline.branch");
    try {
      let result = parseObject(active.delivery.result_json);

      this.setStep(active, "branch", "running");
      const currentBranch = (await this.runner("git", ["branch", "--show-current"], context.projectRoot)).trim();
      if (currentBranch !== sourceBranch) {
        const local = (await this.runner("git", ["branch", "--list", sourceBranch], context.projectRoot)).trim();
        if (local) {
          const branchHead = (await this.runner("git", ["rev-parse", sourceBranch], context.projectRoot)).trim();
          const knownCommit = optionalStoredString(result.commitHash);
          if (branchHead !== preview.baseline.head && branchHead !== knownCommit) throw new DeliveryFailure("source_branch_unknown", "源分支已存在且指向未知 Commit，请人工核对。", true);
          await this.runner("git", ["switch", sourceBranch], context.projectRoot);
        } else {
          const remoteHead = await remoteBranchHead(this.runner, context.projectRoot, remote, sourceBranch).catch(() => null);
          if (remoteHead) throw new DeliveryFailure("source_branch_exists_remote", "远程源分支已存在但本地状态未知，请人工核对。", true);
          await this.runner("git", ["switch", "-c", sourceBranch], context.projectRoot);
        }
      }
      this.setStep(active, "branch", "succeeded", { sourceBranch, originalBranch });

      result = await this.gitCommit(active, context, request, preview);
      const commitHash = requiredString(result.commitHash, "commitHash");

      this.setStep(active, "push", "running");
      let remoteHead: string | null;
      try { remoteHead = await remoteBranchHead(this.runner, context.projectRoot, remote, sourceBranch); }
      catch { throw new DeliveryFailure("push_status_unknown", "无法确认远程分支状态，请人工核对网络与 Remote。", true); }
      if (remoteHead && remoteHead !== commitHash) throw new DeliveryFailure("remote_branch_conflict", "远程源分支指向其他 Commit，请人工核对。", true);
      if (!remoteHead) {
        try { await this.runner("git", ["push", "--set-upstream", remote, sourceBranch], context.projectRoot); }
        catch {
          remoteHead = await remoteBranchHead(this.runner, context.projectRoot, remote, sourceBranch).catch(() => null);
          if (remoteHead !== commitHash) throw new DeliveryFailure("git_push_failed", "Git Push 失败，请检查网络、Remote 与本机凭据后重试。");
        }
        remoteHead = await remoteBranchHead(this.runner, context.projectRoot, remote, sourceBranch).catch(() => null);
        if (remoteHead !== commitHash) throw new DeliveryFailure("push_status_unknown", "Push 后无法确认远程分支 Commit，请人工核对。", true);
      }
      this.setStep(active, "push", "succeeded", { remote, sourceBranch, commitHash });

      this.setStep(active, "pr", "running");
      let pr = await existingPullRequest(this.runner, context.projectRoot, repository, sourceBranch).catch(() => undefined);
      if (!pr) {
        const args = ["pr", "create", "--repo", repository, "--head", sourceBranch, "--base", targetBranch, "--title", request.prTitle!, "--body", request.prBody!];
        if (request.draft) args.push("--draft");
        try {
          const output = await this.runner("gh", args, context.projectRoot);
          const url = output.match(/https:\/\/github\.com\/[^\s]+/i)?.[0];
          if (url) pr = { url, number: null };
        } catch { /* Query below prevents duplicate PR creation after an uncertain response. */ }
        pr ??= await existingPullRequest(this.runner, context.projectRoot, repository, sourceBranch).catch(() => undefined);
        if (!pr) throw new DeliveryFailure("github_pr_failed", "GitHub PR 创建失败；已确认没有可识别的现有 PR，请检查 gh 后重试。");
      }
      this.setStep(active, "pr", "succeeded", { prUrl: pr.url, prNumber: pr.number });
      return { ...parseObject(deliveryById(this.database, active.delivery.id).result_json), method: request.method, commitHash, remote, sourceBranch, targetBranch, draft: request.draft, prUrl: pr.url, prNumber: pr.number };
    } finally {
      const currentBranch = (await this.runner("git", ["branch", "--show-current"], context.projectRoot).catch(() => "")).trim();
      if (currentBranch && currentBranch !== originalBranch) {
        try { await this.runner("git", ["switch", originalBranch], context.projectRoot); }
        catch { throw new DeliveryFailure("workspace_restore_failed", "PR 交付后无法恢复原分支；其他工作区修改仍保留，请人工核对。", true); }
      }
    }
  }

  private setStep(active: ActiveDelivery, step: string, status: StepStatus, resultPatch: JsonObject = {}): void {
    transaction(this.database, () => {
      const delivery = deliveryById(this.database, active.delivery.id);
      const attempt = attemptById(this.database, active.attempt.id);
      const progress = readProgress(delivery.progress_json);
      progress.currentStep = status === "succeeded" ? null : step;
      progress.reconcileRequired = false;
      progress.steps[step] = { status, updatedAt: new Date().toISOString(), detail: status === "failed" || status === "unknown" ? "需要处理" : null };
      const result = { ...parseObject(delivery.result_json), ...resultPatch };
      this.database.prepare("UPDATE deliveries SET progress_json = ?, result_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(progress), JSON.stringify(result), new Date().toISOString(), delivery.id);
      this.database.prepare("UPDATE delivery_attempts SET progress_json = ?, result_json = ? WHERE id = ?").run(JSON.stringify(progress), JSON.stringify({ ...parseObject(attempt.result_json), ...resultPatch }), attempt.id);
    });
  }

  private finishSuccess(active: ActiveDelivery, context: DeliveryContext, result: JsonObject): void {
    transaction(this.database, () => {
      const now = new Date().toISOString();
      const delivery = deliveryById(this.database, active.delivery.id);
      const attempt = attemptById(this.database, active.attempt.id);
      const mergedResult = { ...parseObject(delivery.result_json), ...result, method: delivery.method };
      const progress = readProgress(delivery.progress_json);
      progress.currentStep = null;
      progress.reconcileRequired = false;
      for (const step of Object.values(progress.steps)) if (step.status !== "succeeded") { step.status = "succeeded"; step.updatedAt = now; step.detail = null; }
      this.database.prepare("UPDATE delivery_attempts SET status = 'succeeded', progress_json = ?, result_json = ?, failure_code = NULL, failure_summary = NULL, finished_at = ? WHERE id = ?")
        .run(JSON.stringify(progress), JSON.stringify(mergedResult), now, attempt.id);
      this.database.prepare("UPDATE deliveries SET status = 'succeeded', progress_json = ?, result_json = ?, updated_at = ?, completed_at = ? WHERE id = ?")
        .run(JSON.stringify(progress), JSON.stringify(mergedResult), now, now, delivery.id);
      this.database.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?").run(now, context.taskId);
      this.database.prepare("UPDATE commissions SET status = 'done', updated_at = ? WHERE id = ?").run(now, context.commissionId);
      this.database.prepare("UPDATE execution_grants SET status = 'exhausted' WHERE commission_id = ? AND status = 'active'").run(context.commissionId);
      generateAcceptanceDocuments(this.database, context.commissionId);
      notify(this.database, "completed", `交付成功：${context.taskTitle}`, successSummary(active.delivery.method, mergedResult), "delivery", delivery.id);
    });
  }

  private finishFailure(active: ActiveDelivery, failure: DeliveryFailure): void {
    transaction(this.database, () => {
      const now = new Date().toISOString();
      const status = failure.waitingHuman ? "waiting_human" : "failed";
      const delivery = deliveryById(this.database, active.delivery.id);
      const progress = readProgress(delivery.progress_json);
      const failedStep = progress.currentStep ?? "未知步骤";
      if (progress.currentStep) progress.steps[progress.currentStep] = { status: failure.waitingHuman ? "unknown" : "failed", updatedAt: now, detail: failure.message };
      progress.reconcileRequired = failure.waitingHuman;
      this.database.prepare("UPDATE delivery_attempts SET status = ?, progress_json = ?, failure_code = ?, failure_summary = ?, finished_at = ? WHERE id = ? AND status IN ('queued', 'preparing', 'running')")
        .run(status, JSON.stringify(progress), failure.code, failure.message, now, active.attempt.id);
      this.database.prepare("UPDATE deliveries SET status = ?, progress_json = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'preparing', 'running')")
        .run(status, JSON.stringify(progress), now, active.delivery.id);
      notify(this.database, "blocked", `交付失败：${active.delivery.method}`, `${failure.message} 失败步骤：${failedStep}。交付记录：${active.delivery.id}`, "delivery", delivery.id);
    });
  }
}

export function registerDeliveryRoutes(server: FastifyInstance, database: DatabaseSync, locks = new ProjectLockManager(), runner: CommandRunner = execute): DeliveryWorker {
  const worker = new DeliveryWorker(database, locks, runner);
  server.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/tasks/:id/delivery-preview", async (request) => worker.preview(request.params.id, request.body ?? {}));
  server.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/tasks/:id/deliver", async (request, reply) => reply.code(202).send(await worker.create(request.params.id, request.body ?? {})));
  server.get<{ Params: { id: string } }>("/api/deliveries/:id", async (request) => worker.get(request.params.id));
  server.post<{ Params: { id: string } }>("/api/deliveries/:id/retry", async (request, reply) => reply.code(202).send(worker.retry(request.params.id)));
  server.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/deliveries/:id/reconcile", async (request, reply) => {
    const result = worker.reconcile(request.params.id, request.body ?? {});
    return reply.code(request.body?.decision === "complete" ? 200 : 202).send(result);
  });
  server.post<{ Params: { id: string } }>("/api/deliveries/:id/cancel", async (request) => worker.cancel(request.params.id));
  server.addHook("onClose", () => worker.stop());
  return worker;
}

function deliveryContext(database: DatabaseSync, taskId: string, allowArchived = false): DeliveryContext {
  const row = database.prepare(`SELECT task.id AS task_id, task.title AS task_title, task.archived_at AS task_archived_at,
      commission.id AS commission_id, commission.title AS commission_title, commission.status AS commission_status, commission.archived_at AS commission_archived_at, commission.lifecycle_operation, commission.main_task_id,
      project.id AS project_id, project.real_path AS project_root, project.vcs_type, project.archived_at AS project_archived_at, root.enabled AS root_enabled
    FROM tasks AS task JOIN commissions AS commission ON commission.id = task.commission_id
    JOIN projects AS project ON project.id = commission.project_id JOIN root_paths AS root ON root.id = project.root_path_id
    WHERE task.id = ?`).get(taskId) as { task_id: string; task_title: string; task_archived_at: string | null; commission_id: string; commission_title: string; commission_status: string; commission_archived_at: string | null; lifecycle_operation: string | null; main_task_id: string | null; project_id: string; project_root: string; vcs_type: VcsInfo["type"]; project_archived_at: string | null; root_enabled: number } | undefined;
  if (!row) throw notFound("Task not found");
  if (row.main_task_id !== row.task_id) throw conflict("Delivery is only available for the main task");
  if (row.task_archived_at && !allowArchived) throw conflict("Task is archived");
  return { taskId: row.task_id, taskTitle: row.task_title, taskArchivedAt: row.task_archived_at, commissionId: row.commission_id, commissionTitle: row.commission_title, commissionStatus: row.commission_status, commissionArchivedAt: row.commission_archived_at, lifecycleOperation: row.lifecycle_operation, projectId: row.project_id, projectRoot: row.project_root, projectArchivedAt: row.project_archived_at, rootEnabled: row.root_enabled, vcsType: row.vcs_type };
}

function deliveryContextForCommission(database: DatabaseSync, commissionId: string): DeliveryContext {
  const main = database.prepare("SELECT main_task_id FROM commissions WHERE id = ?").get(commissionId) as { main_task_id: string | null } | undefined;
  if (!main?.main_task_id) throw new DeliveryFailure("delivery_context_missing", "交付关联的主任务不存在。", true);
  return deliveryContext(database, main.main_task_id);
}

function assertAwaitingAcceptance(context: DeliveryContext): void {
  const reason = unavailableReason(context);
  if (reason) throw conflict(reason);
}

function unavailableReason(context: DeliveryContext): string | null {
  if (context.taskArchivedAt) return "Task is archived";
  if (context.lifecycleOperation) return "Commission lifecycle operation is in progress";
  if (context.commissionArchivedAt || context.projectArchivedAt) return "Commission or project is archived";
  if (!context.rootEnabled) return "Project root is disabled";
  if (context.commissionStatus === "done") return "Commission is already delivered";
  return context.commissionStatus === "awaiting_acceptance" ? null : "Main task is not awaiting acceptance";
}

function disabledCapabilities(vcsType: VcsInfo["type"], reason: string): DeliveryCapabilities {
  return { vcsType, document: { available: false, reason }, vcs_commit: { available: false, reason }, github_pr: { available: false, reason }, files: [], unownedPaths: [], driftedPaths: [], git: null, github: null };
}

function normalizedRequest(body: Record<string, unknown>, context: DeliveryContext, deliveryDocument: string, existing?: DeliveryRow): DeliveryRequest {
  const method = enumValue(body.method, ["document", "vcs_commit", "github_pr"] as const, "method");
  const previous = existing ? parseRequest(existing.request_json) : null;
  const commitMessage = method === "document" ? null : optionalString(body.commitMessage ?? body.commit_message, "commitMessage") ?? `交付：${context.commissionTitle}`;
  const prTitle = method === "github_pr" ? optionalString(body.prTitle ?? body.pr_title, "prTitle") ?? context.commissionTitle : null;
  const prBody = method === "github_pr" ? optionalString(body.prBody ?? body.pr_body, "prBody") ?? deliveryDocument : null;
  const request: DeliveryRequest = {
    method, commitMessage,
    remote: optionalString(body.remote, "remote") ?? (existing?.external_effect_started ? previous?.remote ?? null : null),
    sourceBranch: optionalString(body.sourceBranch ?? body.source_branch, "sourceBranch") ?? (existing?.external_effect_started ? previous?.sourceBranch ?? null : null),
    targetBranch: optionalString(body.targetBranch ?? body.target_branch, "targetBranch") ?? null,
    draft: booleanValue(body.draft, false),
    prTitle, prBody
  };
  if (request.commitMessage && request.commitMessage.length > 2000) throw badRequest("commitMessage is too long");
  if (request.prTitle && request.prTitle.length > 256) throw badRequest("prTitle is too long");
  if (request.prBody && request.prBody.length > 60000) throw badRequest("prBody is too long");
  return request;
}

function requestBody(body: Record<string, unknown>): Record<string, unknown> {
  const preview = record(body.preview);
  const previewRequest = record(preview.request);
  const explicit = record(body.request);
  return { ...previewRequest, ...explicit, ...body };
}

function assertLockedRequest(current: DeliveryRow, next: DeliveryRequest): void {
  const previous = parseRequest(current.request_json);
  if (previous.method !== next.method) throw conflict("Delivery method is locked after external work starts");
  if (previous.sourceBranch && next.sourceBranch !== previous.sourceBranch) throw conflict("Source branch is locked after Push starts");
  if (previous.remote && next.remote !== previous.remote) throw conflict("Remote is locked after external work starts");
}

function initialProgress(method: DeliveryMethod): DeliveryProgress {
  const names = method === "document" ? ["complete"] : method === "github_pr" ? ["branch", "commit", "push", "pr"] : ["commit"];
  const now = new Date().toISOString();
  return { currentStep: null, reconcileRequired: false, steps: Object.fromEntries(names.map((name) => [name, { status: "pending" as const, updatedAt: now, detail: null }])) };
}

function markRecoveryRequired(database: DatabaseSync): void {
  const attempts = database.prepare("SELECT id, delivery_id, progress_json FROM delivery_attempts WHERE status IN ('preparing', 'running')").all() as Array<{ id: string; delivery_id: string; progress_json: string }>;
  for (const attempt of attempts) {
    const progress = readProgress(attempt.progress_json);
    progress.reconcileRequired = true;
    database.prepare("UPDATE delivery_attempts SET progress_json = ? WHERE id = ?").run(JSON.stringify(progress), attempt.id);
    database.prepare("UPDATE deliveries SET progress_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(progress), new Date().toISOString(), attempt.delivery_id);
  }
}

function claimPreparing(database: DatabaseSync, active: ActiveDelivery): boolean {
  if (active.attempt.status !== "queued") return active.attempt.status === "preparing" || active.attempt.status === "running";
  return transaction(database, () => {
    const now = new Date().toISOString();
    const claimed = database.prepare("UPDATE delivery_attempts SET status = 'preparing', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'queued'").run(now, active.attempt.id).changes;
    if (!claimed) return false;
    database.prepare("UPDATE deliveries SET status = 'preparing', updated_at = ? WHERE id = ? AND status = 'queued'").run(now, active.delivery.id);
    return true;
  });
}

function claimRunning(database: DatabaseSync, active: ActiveDelivery): boolean {
  if (active.attempt.status === "running") return true;
  return transaction(database, () => {
    const now = new Date().toISOString();
    const claimed = database.prepare("UPDATE delivery_attempts SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'preparing'").run(now, active.attempt.id).changes;
    if (!claimed) return false;
    database.prepare("UPDATE deliveries SET status = 'running', updated_at = ? WHERE id = ? AND status = 'preparing'").run(now, active.delivery.id);
    return true;
  });
}

function markExternalStarted(database: DatabaseSync, active: ActiveDelivery): void {
  transaction(database, () => {
    const now = new Date().toISOString();
    database.prepare("UPDATE deliveries SET external_effect_started = 1, status = 'running', updated_at = ? WHERE id = ?").run(now, active.delivery.id);
    database.prepare("UPDATE delivery_attempts SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?").run(now, active.attempt.id);
  });
}

function hasActiveWriteRun(database: DatabaseSync, projectId: string): boolean {
  return Boolean(database.prepare(`SELECT 1 FROM runs AS run JOIN tasks AS task ON task.id = run.task_id
    WHERE run.project_id = ? AND run.status IN (${ACTIVE_RUN_STATUSES.map(() => "?").join(", ")}) AND run.role <> 'supervisor' AND task.read_only = 0 LIMIT 1`).get(projectId, ...ACTIVE_RUN_STATUSES));
}

function assertNoActiveWriteRun(database: DatabaseSync, projectId: string): void {
  if (hasActiveWriteRun(database, projectId)) throw new DeliveryFailure("project_busy", "项目存在活动写 Run，请等待完成后重试。");
}

async function gitState(runner: CommandRunner, root: string): Promise<GitState> {
  const branchOutput = (await runner("git", ["branch", "--show-current"], root)).trim();
  const head = (await runner("git", ["rev-parse", "HEAD"], root)).trim();
  let upstreamRemote: string | null = null;
  try {
    const upstream = (await runner("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root)).trim();
    upstreamRemote = upstream.includes("/") ? upstream.slice(0, upstream.indexOf("/")) : null;
  } catch {}
  return { branch: branchOutput || null, head, detached: !branchOutput, upstreamRemote };
}

async function githubRemotes(runner: CommandRunner, root: string): Promise<GitHubRemote[]> {
  const names = (await runner("git", ["remote"], root)).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const remotes: GitHubRemote[] = [];
  for (const name of names) {
    const url = (await runner("git", ["remote", "get-url", "--push", name], root).catch(() => runner("git", ["remote", "get-url", name], root))).trim();
    const repository = githubRepository(url);
    if (repository) remotes.push({ name, repository });
  }
  return remotes;
}

function selectGithubRemote(remotes: GitHubRemote[], requested: string | null, upstream: string | null): GitHubRemote | undefined {
  if (requested) return remotes.find(({ name }) => name === requested);
  return remotes.find(({ name }) => name === upstream) ?? remotes.find(({ name }) => name === "origin") ?? remotes[0];
}

function githubRepository(value: string): string | null {
  const trimmed = value.trim();
  const scp = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(trimmed);
  if (scp) return scp[1]!;
  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const repository = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
    return /^[^/]+\/[^/]+$/.test(repository) ? repository : null;
  } catch { return null; }
}

function defaultSourceBranch(context: DeliveryContext): string {
  const slug = context.commissionTitle.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "delivery";
  return `openworkshop/${context.commissionId.slice(0, 8)}-${slug}`;
}

function validRemote(value: unknown): string {
  const remote = requiredString(value, "remote");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(remote)) throw badRequest("remote is invalid");
  return remote;
}

function validBranch(value: unknown, name: string): string {
  const branch = requiredString(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/.test(branch) || branch.includes("..") || branch.includes("//") || branch.endsWith(".lock") || branch.endsWith("/")) throw badRequest(`${name} is invalid`);
  return branch;
}

async function committedHead(runner: CommandRunner, root: string, baseline: string | null, message: string): Promise<string | null> {
  try {
    const output = await runner("git", ["show", "-s", "--format=%H%x00%s%x00%P", "HEAD"], root);
    const [hash, subject, parents] = output.trim().split("\0");
    if (!hash || subject !== message.split(/\r?\n/, 1)[0]) return null;
    if (baseline && parents?.split(" ")[0] !== baseline) return null;
    return hash;
  } catch { return null; }
}

async function verifyCommitExists(runner: CommandRunner, root: string, hash: string): Promise<void> {
  try { await runner("git", ["cat-file", "-e", `${hash}^{commit}`], root); }
  catch { throw new DeliveryFailure("commit_missing", "已记录的 Commit 在本地仓库中不存在，请人工核对。", true); }
}

async function remoteBranchHead(runner: CommandRunner, root: string, remote: string, branch: string): Promise<string | null> {
  const output = await runner("git", ["ls-remote", "--heads", remote, `refs/heads/${branch}`], root);
  return output.trim().split(/\s+/, 1)[0] || null;
}

async function existingPullRequest(runner: CommandRunner, root: string, repository: string, branch: string): Promise<{ url: string; number: number | null } | undefined> {
  const output = await runner("gh", ["pr", "list", "--repo", repository, "--head", branch, "--state", "all", "--json", "url,number"], root);
  const rows = JSON.parse(output) as Array<{ url?: unknown; number?: unknown }>;
  const row = rows.find((item) => typeof item.url === "string");
  return row ? { url: row.url as string, number: typeof row.number === "number" ? row.number : null } : undefined;
}

function isCodePath(path: string): boolean {
  return !/\.(?:md|txt|rst|adoc|pdf|png|jpe?g|gif|webp|svg|lock)$/i.test(path) && !path.startsWith("docs/") && !path.startsWith(".memory/");
}

function successSummary(method: DeliveryMethod, result: JsonObject): string {
  if (method === "document") return "纯文档交付已完成。";
  if (method === "github_pr") return `GitHub PR 已创建：${String(result.prUrl ?? "已记录")}`;
  return result.svnRevision ? `SVN Commit 已完成：r${String(result.svnRevision)}` : `Git Commit 已完成：${String(result.commitHash ?? "已记录")}`;
}

function deliveryFailure(error: unknown, method: DeliveryMethod): DeliveryFailure {
  if (error instanceof DeliveryFailure) return error;
  return new DeliveryFailure("delivery_failed", `${method === "document" ? "文档" : "仓库"}交付执行失败，请检查本机工具配置后重试。`);
}

function currentDeliveryDocument(database: DatabaseSync, commissionId: string): string {
  return (database.prepare(`SELECT version.content_markdown FROM documents AS document JOIN document_versions AS version ON version.id = document.current_version_id
    WHERE document.commission_id = ? AND document.type = 'delivery'`).get(commissionId) as { content_markdown: string } | undefined)?.content_markdown ?? "";
}

function deliveryForCommission(database: DatabaseSync, commissionId: string): DeliveryRow | undefined {
  return database.prepare("SELECT * FROM deliveries WHERE commission_id = ?").get(commissionId) as DeliveryRow | undefined;
}

function deliveryById(database: DatabaseSync, id: string): DeliveryRow {
  const row = database.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as DeliveryRow | undefined;
  if (!row) throw notFound("Delivery not found");
  return row;
}

function attemptById(database: DatabaseSync, id: string): AttemptRow {
  const row = database.prepare("SELECT * FROM delivery_attempts WHERE id = ?").get(id) as AttemptRow | undefined;
  if (!row) throw notFound("Delivery attempt not found");
  return row;
}

function activeAttempt(database: DatabaseSync, deliveryId: string): AttemptRow | undefined {
  return database.prepare("SELECT * FROM delivery_attempts WHERE delivery_id = ? AND status IN ('queued', 'preparing', 'running', 'waiting_human') ORDER BY attempt_no DESC LIMIT 1").get(deliveryId) as AttemptRow | undefined;
}

function activeDelivery(database: DatabaseSync, id: string): ActiveDelivery | undefined {
  const delivery = database.prepare("SELECT * FROM deliveries WHERE id = ? AND status IN ('queued', 'preparing', 'running')").get(id) as DeliveryRow | undefined;
  if (!delivery) return undefined;
  const attempt = activeAttempt(database, id);
  return attempt ? { delivery, attempt } : undefined;
}

function attemptsForDelivery(database: DatabaseSync, deliveryId: string): AttemptRow[] {
  return database.prepare("SELECT * FROM delivery_attempts WHERE delivery_id = ? ORDER BY attempt_no DESC").all(deliveryId) as AttemptRow[];
}

function nextAttemptNo(database: DatabaseSync, deliveryId: string): number {
  return (database.prepare("SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt FROM delivery_attempts WHERE delivery_id = ?").get(deliveryId) as { attempt: number }).attempt;
}

function deliveryView(row: DeliveryRow, attempts: AttemptRow[]): Record<string, unknown> {
  return { id: row.id, commissionId: row.commission_id, mainTaskId: row.main_task_id, method: row.method, status: row.status, request: parseObject(row.request_json), preview: parseObject(row.preview_json), progress: parseObject(row.progress_json), result: parseObject(row.result_json), externalEffectStarted: Boolean(row.external_effect_started), createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at, attempts: attempts.map(attemptView) };
}

function attemptView(row: AttemptRow): Record<string, unknown> {
  return { id: row.id, deliveryId: row.delivery_id, attemptNo: row.attempt_no, status: row.status, request: parseObject(row.request_json), preview: parseObject(row.preview_json), progress: parseObject(row.progress_json), result: parseObject(row.result_json), failureCode: row.failure_code, failureSummary: row.failure_summary, startedAt: row.started_at, finishedAt: row.finished_at, createdAt: row.created_at };
}

function parseRequest(value: string): DeliveryRequest { return JSON.parse(value) as DeliveryRequest; }
function parsePreview(value: string): DeliveryPreview { return JSON.parse(value) as DeliveryPreview; }
function parseObject(value: string): JsonObject { return JSON.parse(value) as JsonObject; }
function readProgress(value: string): DeliveryProgress { return JSON.parse(value) as DeliveryProgress; }
function optionalStoredString(value: unknown): string | null { return typeof value === "string" && value ? value : null; }

function validateReconciledResult(method: DeliveryMethod, vcsType: VcsInfo["type"], result: JsonObject): void {
  if (method === "vcs_commit") {
    if (vcsType === "git" && !/^[0-9a-f]{40}$/.test(requiredString(result.commitHash, "result.commitHash"))) throw badRequest("result.commitHash must be a Git commit hash");
    if (vcsType === "svn" && ![result.svnRevision, result.commitId].some(validSvnIdentifier)) throw badRequest("result.svnRevision or result.commitId must be a non-empty SVN identifier");
    if (vcsType === "none") throw badRequest("vcs_commit reconciliation requires a Git or SVN project");
  }
  if (method === "github_pr") {
    if (vcsType !== "git") throw badRequest("github_pr reconciliation requires a Git project");
    if (!/^https:\/\/github\.com\/[^\s]+$/.test(requiredString(result.prUrl, "result.prUrl"))) throw badRequest("result.prUrl must be a GitHub URL");
    if (result.commitHash !== undefined && !/^[0-9a-f]{40}$/.test(requiredString(result.commitHash, "result.commitHash"))) throw badRequest("result.commitHash must be a Git commit hash");
  }
  if (method === "document") throw badRequest("Document delivery does not require reconciliation");
  if (method === "vcs_commit" && result.branch !== undefined) requiredString(result.branch, "result.branch");
  if (method === "github_pr" && result.sourceBranch !== undefined) requiredString(result.sourceBranch, "result.sourceBranch");
}

async function recoveredCommitMatchesPreview(database: DatabaseSync, context: DeliveryContext, preview: DeliveryPreview, runner: CommandRunner, commitHash: string): Promise<boolean> {
  try {
    const expectedBranch = preview.sourceBranch ?? preview.baseline.branch;
    const branch = (await runner("git", ["branch", "--show-current"], context.projectRoot)).trim() || null;
    if (!preview.baseline.head || branch !== expectedBranch) return false;
    const expectedPaths = preview.files.map(({ path }) => path).sort();
    const committedPaths = (await runner("git", ["diff", "--name-only", "--no-renames", "-z", preview.baseline.head, commitHash, "--"], context.projectRoot))
      .split("\0").filter(Boolean).sort();
    if (expectedPaths.length !== committedPaths.length || expectedPaths.some((path, index) => path !== committedPaths[index])) return false;
    const attribution = await commissionAttributionSnapshot(database, context.commissionId, context.projectRoot, context.vcsType, runner);
    if (attribution.driftedPaths.length) return false;
    for (const change of preview.files) if (await contentHash(resolve(context.projectRoot, change.path)) !== change.hash) return false;
    await runner("git", ["diff", "--quiet", commitHash, "--", ...expectedPaths], context.projectRoot);
    return true;
  } catch {
    return false;
  }
}

function validSvnIdentifier(value: unknown): boolean {
  return (typeof value === "string" && Boolean(value.trim())) || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function transaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try { const result = action(); database.exec("COMMIT"); return result; }
  catch (error) { database.exec("ROLLBACK"); throw error; }
}

async function execute(file: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await runFile(file, args, { cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" } });
  return stdout;
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw badRequest(`${name} must be a non-empty string`); return value.trim(); }
function optionalString(value: unknown, name: string): string | undefined { if (value === undefined || value === null || value === "") return undefined; if (typeof value !== "string") throw badRequest(`${name} must be a string`); return value.trim() || undefined; }
function booleanValue(value: unknown, fallback: boolean): boolean { if (value === undefined) return fallback; if (typeof value !== "boolean") throw badRequest("draft must be boolean"); return value; }
function enumValue<T extends readonly string[]>(value: unknown, values: T, name: string): T[number] { if (typeof value !== "string" || !values.includes(value)) throw badRequest(`${name} must be one of ${values.join(", ")}`); return value as T[number]; }
function statusError(message: string, statusCode: number): Error { return Object.assign(new Error(message), { statusCode }); }
const badRequest = (message: string) => statusError(message, 400);
const notFound = (message: string) => statusError(message, 404);
const conflict = (message: string) => statusError(message, 409);
