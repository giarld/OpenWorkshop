import { createElement, Fragment, type ChangeEvent, type ReactElement, type ReactNode } from "react";
import type { Task } from "./task-board.ts";
import { deliveryWriteState, type DeliveryFormState, type DeliveryMethod } from "./delivery-workspace-state.ts";

export type Capability = { available: boolean; reason: string | null };

export type DeliveryPreview = {
  fingerprint: string;
  method: DeliveryMethod;
  request: Record<string, unknown>;
  files: Array<{ path: string; changeType: string; hash: string | null }>;
  baseline: { branch: string | null; head: string | null; svnRevision: string | null };
  remote: string | null;
  repository: string | null;
  sourceBranch: string | null;
  targetBranch: string | null;
  draft: boolean;
};

export type DeliveryAttempt = { attemptNo: number; status: string; failureSummary: string | null };

export type DeliveryRecord = {
  id: string;
  commissionId: string;
  mainTaskId: string;
  method: DeliveryMethod;
  status: string;
  request: Record<string, unknown>;
  progress: { currentStep: string | null; steps: Record<string, { status: string; detail: string | null }> };
  result: Record<string, unknown>;
  externalEffectStarted: boolean;
  attempts: DeliveryAttempt[];
};

export type Acceptance = {
  commissionStatus: string;
  task: Task;
  deliveryDocument: { id: string; contentMarkdown: string; versionNo: number } | null;
  tasks: Array<{ id: string; number_path: string; title: string; status: string; blocked_reason: string | null; human_waiver_reason: string | null }>;
  runs: Array<{ id: string; role: string; status: string; failure_summary: string | null }>;
  evidence: Array<{ id: string; type: string; status: string; summary: string }>;
  deliveryCapabilities: {
    vcsType: string;
    document: Capability;
    vcs_commit: Capability;
    github_pr: Capability;
    files: string[];
    unownedPaths: string[];
    driftedPaths: string[];
    git: { branch: string | null; head: string | null; detached: boolean } | null;
    github: { remotes: string[]; selectedRemote: string | null; repository: string | null; defaultBranch: string | null } | null;
  };
  currentDelivery: DeliveryRecord | null;
  deliveryAttempts: DeliveryAttempt[];
};

export type DeliveryControlsProps = {
  acceptance: Acceptance;
  preview: DeliveryPreview | null;
  form: DeliveryFormState;
  onFormChange(field: keyof DeliveryFormState, value: string | boolean): void;
  onPreview(): void;
  onDeliver(): void;
  onRetry(): void;
  onReconcile(): void;
  onCancel(): void;
};

export function DeliveryControls({ acceptance, preview, form, onFormChange, onPreview, onDeliver, onRetry, onReconcile, onCancel }: DeliveryControlsProps): ReactElement {
  const current = acceptance.currentDelivery;
  const capabilities = acceptance.deliveryCapabilities;
  const state = deliveryWriteState(acceptance.commissionStatus, current?.status ?? null, Boolean(current?.externalEffectStarted));
  const capability = capabilities[form.method];
  const attributionBlocked = form.method !== "document" && Boolean(capabilities.unownedPaths.length || capabilities.driftedPaths.length);
  const previewMatchesMethod = Boolean(preview && preview.method === form.method);
  const previewReady = Boolean(preview && previewMatchesMethod && state.canEdit && capability.available && !attributionBlocked);
  const failure = current?.attempts.find((attempt) => attempt.status === "failed" || attempt.status === "waiting_human");

  return createElement(
    "section",
    { className: "acceptance-report delivery-controls" },
    createElement("header", null, createElement("strong", null, "交付方式"), current ? createElement("span", null, deliveryStatusLabel(current.status)) : null),
    current?.status === "succeeded"
      ? createElement(DeliveryResult, { delivery: current })
      : createElement(
          Fragment,
          null,
          state.readOnly
            ? createElement("p", null, "交付已完成，交付写操作已关闭。以下保留历史结果。")
            : createElement(
                Fragment,
                null,
                createElement(
                  "div",
                  { className: "delivery-method-options" },
                  methodOption("document", "纯文档交付", capabilities.document, form, state.canEdit, onFormChange),
                  methodOption("vcs_commit", "提交并交付", capabilities.vcs_commit, form, state.canEdit, onFormChange),
                  methodOption("github_pr", "GitHub PR", capabilities.github_pr, form, state.canEdit, onFormChange)
                ),
                methodFields(form, capabilities, state.canEdit, onFormChange),
                !state.canEdit && !state.readOnly && !current
                  ? createElement("p", { role: "status" }, "交付将在主任务完成最终协调后开放。")
                  : null,
                createElement(
                  "div",
                  { className: "acceptance-actions" },
                  createElement(
                    "button",
                    {
                      type: "button",
                      disabled: !state.canEdit || !capability.available || attributionBlocked,
                      onClick: previewReady ? onDeliver : onPreview
                    },
                    previewReady ? "确认并交付" : preview ? "重新生成预览" : "生成交付预览"
                  ),
                  current?.status === "failed" ? createElement("button", { type: "button", className: "secondary", onClick: onRetry }, "重试") : null,
                  current?.status === "waiting_human" ? createElement("button", { type: "button", className: "secondary", onClick: onReconcile }, "确认无外部副作用并重试") : null,
                  state.cancellable ? createElement("button", { type: "button", className: "secondary", onClick: onCancel }, "取消") : null
                ),
                (capabilities.unownedPaths.length > 0 || capabilities.driftedPaths.length > 0)
                  ? createElement(
                      "div",
                      { className: "delivery-safety-alert", role: "alert" },
                      createElement("p", null, "仓库交付已阻止，存在不可安全归属的改动："),
                      createElement(
                        "ul",
                        null,
                        ...capabilities.unownedPaths.map((path) => createElement("li", { key: `unowned-${path}` }, `未归属：${path}`)),
                        ...capabilities.driftedPaths.map((path) => createElement("li", { key: `drifted-${path}` }, `内容漂移：${path}`))
                      )
                    )
                  : null,
                preview
                  ? createElement(DeliveryPreviewSummary, { preview, stale: !previewMatchesMethod })
                  : capabilities.files.length > 0 && form.method !== "document"
                  ? createElement("p", null, `可归属文件：${capabilities.files.join("、")}`)
                    : null,
              ),
          current?.progress.currentStep ? createElement("p", null, `当前步骤：${current.progress.currentStep}`) : null,
          failure?.failureSummary ? createElement("p", { role: "alert" }, failure.failureSummary) : null,
          createElement(AttemptHistory, { attempts: current?.attempts ?? [] })
        )
  );
}

function methodOption(value: DeliveryMethod, label: string, item: Capability, form: DeliveryFormState, canEdit: boolean, onFormChange: DeliveryControlsProps["onFormChange"]): ReactElement {
  return createElement(
    "label",
    { key: value, className: "delivery-method-option" },
    createElement("input", { type: "radio", name: "delivery-method", checked: form.method === value, disabled: !canEdit || !item.available, onChange: () => onFormChange("method", value) }),
    createElement("span", null, label),
    !item.available ? createElement("small", null, `（${item.reason ?? "不可用"}）`) : null
  );
}

function methodFields(form: DeliveryFormState, capabilities: Acceptance["deliveryCapabilities"], canEdit: boolean, onFormChange: DeliveryControlsProps["onFormChange"]): ReactElement | null {
  if (form.method === "document") return null;
  return createElement(
    Fragment,
    null,
    createElement("input", {
      "aria-label": "Commit 信息",
      placeholder: "Commit 信息",
      value: form.commitMessage,
      disabled: !canEdit,
      onChange: (event: ChangeEvent<HTMLInputElement>) => onFormChange("commitMessage", event.currentTarget.value)
    }),
    form.method === "github_pr"
      ? createElement(
          Fragment,
          null,
          createElement("input", { "aria-label": "Remote", placeholder: capabilities.github?.selectedRemote ?? "Remote", value: form.remote, disabled: !canEdit, onChange: (event: ChangeEvent<HTMLInputElement>) => onFormChange("remote", event.currentTarget.value) }),
          createElement("input", { "aria-label": "源分支", placeholder: "源分支", value: form.sourceBranch, disabled: !canEdit, onChange: (event: ChangeEvent<HTMLInputElement>) => onFormChange("sourceBranch", event.currentTarget.value) }),
          createElement("input", { "aria-label": "目标分支", placeholder: capabilities.github?.defaultBranch ?? "目标分支", value: form.targetBranch, disabled: !canEdit, onChange: (event: ChangeEvent<HTMLInputElement>) => onFormChange("targetBranch", event.currentTarget.value) }),
          createElement("input", { "aria-label": "PR 标题", placeholder: "PR 标题", value: form.prTitle, disabled: !canEdit, onChange: (event: ChangeEvent<HTMLInputElement>) => onFormChange("prTitle", event.currentTarget.value) }),
          createElement("textarea", { "aria-label": "PR 正文", placeholder: "PR 正文", value: form.prBody, disabled: !canEdit, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => onFormChange("prBody", event.currentTarget.value) }),
          createElement("label", null, createElement("input", { type: "checkbox", checked: form.draft, disabled: !canEdit, onChange: (event: ChangeEvent<HTMLInputElement>) => onFormChange("draft", event.currentTarget.checked) }), " Draft")
        )
      : null
  );
}

function DeliveryResult({ delivery }: { delivery: DeliveryRecord }): ReactElement {
  const attemptNo = delivery.attempts[delivery.attempts.length - 1]?.attemptNo;
  return createElement(
    "div",
    null,
    createElement("p", null, "交付已完成。"),
    createElement(
      "dl",
      { className: "acceptance-summary" },
      summaryItem("交付方式", deliveryMethodLabel(delivery.method)),
      summaryItem("执行结果", "成功"),
      attemptNo ? summaryItem("完成情况", `第 ${attemptNo} 次尝试完成`) : null,
      ...deliveryResultDetails(delivery.result)
    ),
    createElement(AttemptHistory, { attempts: delivery.attempts })
  );
}

function summaryItem(label: string, value: ReactNode, key = label): ReactElement {
  return createElement("div", { key }, createElement("dt", null, label), createElement("dd", null, value));
}

function deliveryResultDetails(result: DeliveryRecord["result"]): ReactElement[] {
  const labels: Record<string, string> = { prUrl: "GitHub PR", prNumber: "PR 编号", commitHash: "提交版本", svnRevision: "SVN 版本", commitId: "SVN 版本", remote: "远程仓库", branch: "分支", sourceBranch: "源分支", targetBranch: "目标分支", draft: "草稿 PR" };
  return Object.entries(result)
    .filter(([key]) => key !== "method" && (key !== "commitId" || result.svnRevision === undefined))
    .map(([key, value]) => summaryItem(labels[key] ?? key, key === "prUrl" && typeof value === "string" ? createElement("a", { href: value, target: "_blank", rel: "noreferrer" }, value) : displayDeliveryValue(value), key));
}

function DeliveryPreviewSummary({ preview, stale }: { preview: DeliveryPreview; stale: boolean }): ReactElement {
  const baseline = preview.baseline.svnRevision !== null ? `SVN r${preview.baseline.svnRevision}` : preview.baseline.branch ?? "Git";
  const title = typeof preview.request.prTitle === "string" ? preview.request.prTitle : typeof preview.request.commitMessage === "string" ? preview.request.commitMessage : null;
  return createElement(
    "div",
    { className: "acceptance-report" },
    createElement("strong", null, `交付预览${stale ? "（已失效）" : ""}`),
    createElement(
      "dl",
      { className: "acceptance-summary" },
      createElement("div", null, createElement("dt", null, "文件"), createElement("dd", null, preview.files.length ? createElement("ul", null, ...preview.files.map((file) => createElement("li", { key: file.path }, `${file.path} · ${changeTypeLabel(file.changeType)}`))) : "不修改仓库")),
      createElement("div", null, createElement("dt", null, "基线"), createElement("dd", null, `${baseline} · ${preview.baseline.head ?? "—"}`)),
      createElement("div", null, createElement("dt", null, "Commit/PR 标题"), createElement("dd", null, title ?? "—")),
      createElement("div", null, createElement("dt", null, "Remote"), createElement("dd", null, preview.remote ?? "—")),
      createElement("div", null, createElement("dt", null, "Repository"), createElement("dd", null, preview.repository ?? "—")),
      createElement("div", null, createElement("dt", null, "源分支"), createElement("dd", null, preview.sourceBranch ?? "—")),
      createElement("div", null, createElement("dt", null, "目标分支"), createElement("dd", null, preview.targetBranch ?? "—")),
      createElement("div", null, createElement("dt", null, "Draft"), createElement("dd", null, preview.draft ? "是" : "否")),
      createElement("div", null, createElement("dt", null, "指纹"), createElement("dd", null, preview.fingerprint))
    ),
    stale ? createElement("p", { role: "alert" }, "表单或交付方式已变化，请重新生成预览。") : null
  );
}

function AttemptHistory({ attempts }: { attempts: DeliveryAttempt[] }): ReactElement | null {
  return attempts.length
    ? createElement("div", null, createElement("strong", null, "交付尝试历史"), createElement("ul", null, ...attempts.map((attempt) => createElement("li", { key: attempt.attemptNo }, `第 ${attempt.attemptNo} 次：${deliveryStatusLabel(attempt.status)}${attempt.failureSummary ? `：${attempt.failureSummary}` : ""}`))))
    : null;
}

function deliveryMethodLabel(method: DeliveryMethod): string {
  return method === "document" ? "纯文档交付" : method === "github_pr" ? "GitHub PR" : "提交并交付";
}

function deliveryStatusLabel(status: string): string {
  return ({ queued: "排队中", preparing: "准备中", running: "执行中", waiting_human: "等待人工核对", failed: "失败", cancelled: "已取消", succeeded: "成功" } as Record<string, string>)[status] ?? status;
}

function changeTypeLabel(changeType: string): string {
  return ({ added: "新增", modified: "修改", deleted: "删除", renamed: "重命名", clean: "无变化" } as Record<string, string>)[changeType] ?? changeType;
}

function displayDeliveryValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
