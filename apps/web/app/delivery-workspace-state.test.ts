import assert from "node:assert/strict";
import test from "node:test";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DeliveryControls, type Acceptance, type DeliveryPreview, type DeliveryRecord } from "./delivery-workspace-controls.ts";
import { DELIVERY_POLL_INTERVAL_MS, deliveryEntries, deliveryFormFromRequest, deliveryRequestFromForm, deliveryWriteState, EMPTY_DELIVERY_FORM, shouldPollDelivery, shouldRefreshDeliveryEntries, startDeliveryPolling, type DeliveryCommission } from "./delivery-workspace-state.ts";
import type { Task } from "./task-board.ts";

const task = (overrides: Partial<Task>): Task => ({
  id: "main",
  commission_id: "commission",
  parent_id: null,
  number_path: "1",
  position: 0,
  title: "交付主任务",
  description: "",
  status: "in_progress",
  priority: "medium",
  due_date: null,
  owner_type: "ai",
  created_at: "2026-08-10T00:00:00.000Z",
  updated_at: "2026-08-10T00:00:00.000Z",
  archived_at: null,
  read_only: 0,
  acceptanceCriteria: [],
  dependencyIds: [],
  auto_approve_permissions: 0,
  labels: [],
  ...overrides
});

const commission = (overrides: Partial<DeliveryCommission> = {}): DeliveryCommission => ({
  id: "commission",
  title: "客户需求",
  status: "active",
  summary: "交付一个可验收功能",
  main_task_id: "main",
  archived_at: null,
  ...overrides
});

const capabilities = (overrides: Partial<Acceptance["deliveryCapabilities"]> = {}): Acceptance["deliveryCapabilities"] => ({
  vcsType: "git",
  document: { available: true, reason: null },
  vcs_commit: { available: true, reason: null },
  github_pr: { available: true, reason: null },
  files: ["src/change.ts"],
  unownedPaths: [],
  driftedPaths: [],
  git: { branch: "main", head: "base", detached: false },
  github: { remotes: ["origin"], selectedRemote: "origin", repository: "owner/repo", defaultBranch: "main" },
  ...overrides
});

const acceptance = (overrides: Partial<Acceptance> = {}): Acceptance => ({
  commissionStatus: "awaiting_acceptance",
  task: task({}),
  deliveryDocument: null,
  tasks: [],
  runs: [],
  evidence: [],
  deliveryCapabilities: capabilities(),
  currentDelivery: null,
  deliveryAttempts: [],
  ...overrides
});

const delivery = (overrides: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  id: "delivery",
  commissionId: "commission",
  mainTaskId: "main",
  method: "document",
  status: "queued",
  request: { method: "document" },
  progress: { currentStep: null, steps: {} },
  result: {},
  externalEffectStarted: false,
  attempts: [],
  ...overrides
});

const preview = (overrides: Partial<DeliveryPreview> = {}): DeliveryPreview => ({
  fingerprint: "fingerprint",
  method: "vcs_commit",
  request: { method: "vcs_commit", commitMessage: "Ship change" },
  files: [{ path: "src/change.ts", changeType: "modified", hash: "hash" }],
  baseline: { branch: "main", head: "base", svnRevision: null },
  remote: null,
  repository: null,
  sourceBranch: null,
  targetBranch: null,
  draft: false,
  ...overrides
});

type ButtonProps = { children?: ReactNode; disabled?: boolean; onClick?: () => void };

function buttons(node: ReactNode): Array<ReactElement<ButtonProps>> {
  if (!isValidElement(node)) return [];
  const props = node.props as unknown as ButtonProps;
  const current = node.type === "button" ? [node as ReactElement<ButtonProps>] : [];
  return [...current, ...Children.toArray(props.children).flatMap(buttons)];
}

function buttonByText(node: ReactNode, text: string): ReactElement<ButtonProps> {
  const button = buttons(node).find((item) => Children.toArray(item.props.children).join("").includes(text));
  assert.ok(button, `找不到按钮：${text}`);
  return button;
}

function controlTree(options: { acceptance?: Acceptance; form?: typeof EMPTY_DELIVERY_FORM; preview?: DeliveryPreview | null; onPreview?: () => void; onDeliver?: () => void; onRetry?: () => void; onReconcileRetry?: () => void; onReconcileComplete?: () => void; onCancel?: () => void }): ReactElement {
  return DeliveryControls({
    acceptance: options.acceptance ?? acceptance(),
    preview: options.preview ?? null,
    form: options.form ?? EMPTY_DELIVERY_FORM,
    onFormChange: () => undefined,
    onPreview: options.onPreview ?? (() => undefined),
    onDeliver: options.onDeliver ?? (() => undefined),
    onRetry: options.onRetry ?? (() => undefined),
    onReconcileRetry: options.onReconcileRetry ?? (() => undefined),
    onReconcileComplete: options.onReconcileComplete ?? (() => undefined),
    onCancel: options.onCancel ?? (() => undefined)
  });
}

test("builds one delivery entry per active commission with a main task", () => {
  const entries = deliveryEntries([commission()], [task({}), task({ id: "child", parent_id: "main", number_path: "1.1", status: "done" })]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.title, "客户需求");
  assert.equal(entries[0]?.completedTasks, 1);
  assert.equal(entries[0]?.totalTasks, 2);
});

test("omits archived commissions and commissions without a resolvable main task", () => {
  assert.deepEqual(deliveryEntries([commission({ archived_at: "2026-08-10T00:00:00.000Z" }), commission({ id: "missing", main_task_id: "missing" })], [task({})]), []);
});

test("refreshes delivery entries whenever the delivery view becomes visible", () => {
  assert.equal(shouldRefreshDeliveryEntries(false, "delivery"), true);
  assert.equal(shouldRefreshDeliveryEntries(true, "delivery"), false);
  assert.equal(shouldRefreshDeliveryEntries(false, "notifications"), false);
});

test("maps every persisted delivery request field back into the form", () => {
  const form = deliveryFormFromRequest({ method: "github_pr", commitMessage: "ship", remote: "origin", sourceBranch: "openworkshop/change", targetBranch: "main", prTitle: "Ship it", prBody: "Details", draft: true });
  assert.deepEqual(form, { method: "github_pr", commitMessage: "ship", remote: "origin", sourceBranch: "openworkshop/change", targetBranch: "main", prTitle: "Ship it", prBody: "Details", draft: true });
  assert.deepEqual(deliveryRequestFromForm(form), form);
});

test("keeps delivery writes read-only after success and enforces cancellation boundaries", () => {
  assert.deepEqual(deliveryWriteState("done", "succeeded", false), { readOnly: true, canEdit: false, cancellable: false });
  assert.deepEqual(deliveryWriteState("awaiting_acceptance", "queued", false), { readOnly: false, canEdit: false, cancellable: true });
  assert.deepEqual(deliveryWriteState("awaiting_acceptance", "running", true), { readOnly: false, canEdit: false, cancellable: false });
  assert.deepEqual(deliveryWriteState("awaiting_acceptance", "failed", true), { readOnly: false, canEdit: false, cancellable: false });
});

test("keeps VCS preview available while excluding unrelated workspace changes", () => {
  const tree = controlTree({
    acceptance: acceptance({ deliveryCapabilities: capabilities({ unownedPaths: ["notes.txt"] }) }),
    form: { ...EMPTY_DELIVERY_FORM, method: "vcs_commit" }
  });
  const html = renderToStaticMarkup(tree);
  assert.equal(buttonByText(tree, "生成交付预览").props.disabled, false);
  assert.match(html, /以下额外修改不会纳入本次交付/);
  assert.match(html, /notes.txt/);
  assert.doesNotMatch(html, /delivery-safety-alert/);
});

test("blocks VCS preview when task-owned content has drifted", () => {
  const tree = controlTree({
    acceptance: acceptance({ deliveryCapabilities: capabilities({ vcs_commit: { available: false, reason: "委托变更内容已漂移" }, driftedPaths: ["src/change.ts"] }) }),
    form: { ...EMPTY_DELIVERY_FORM, method: "vcs_commit" }
  });
  const html = renderToStaticMarkup(tree);
  assert.equal(buttonByText(tree, "生成交付预览").props.disabled, true);
  assert.match(html, /委托变更内容已漂移/);
  assert.match(html, /内容漂移：src\/change\.ts/);
  assert.match(html, /生成交付预览/);
  assert.match(html, /delivery-safety-alert/);
});

test("explains why delivery remains unavailable before final coordination", () => {
  const html = renderToStaticMarkup(controlTree({ acceptance: acceptance({ commissionStatus: "active" }) }));
  assert.match(html, /交付将在主任务完成最终协调后开放。/);
  assert.match(html, /生成交付预览/);
});

test("renders an expired preview as regeneration and never invokes delivery confirmation", () => {
  let previewCalls = 0;
  let deliverCalls = 0;
  const tree = controlTree({
    form: { ...EMPTY_DELIVERY_FORM, method: "vcs_commit" },
    preview: preview({ method: "github_pr" }),
    onPreview: () => { previewCalls += 1; },
    onDeliver: () => { deliverCalls += 1; }
  });
  const html = renderToStaticMarkup(tree);
  assert.match(html, /交付预览（已失效）/);
  assert.match(html, /表单或交付方式已变化，请重新生成预览。/);
  assert.match(html, /重新生成预览/);
  assert.doesNotMatch(html, /确认并交付/);
  buttonByText(tree, "重新生成预览").props.onClick?.();
  assert.equal(previewCalls, 1);
  assert.equal(deliverCalls, 0);
  const validTree = controlTree({ form: { ...EMPTY_DELIVERY_FORM, method: "vcs_commit" }, preview: preview(), onDeliver: () => { deliverCalls += 1; } });
  assert.match(renderToStaticMarkup(validTree), /确认并交付/);
  buttonByText(validTree, "确认并交付").props.onClick?.();
  assert.equal(deliverCalls, 1);
});

test("polls only active delivery states at the shared interval", () => {
  assert.equal(DELIVERY_POLL_INTERVAL_MS, 2_000);
  assert.equal(shouldPollDelivery("queued", true), true);
  assert.equal(shouldPollDelivery("preparing", true), true);
  assert.equal(shouldPollDelivery("running", true), true);
  assert.equal(shouldPollDelivery("failed", true), false);
  assert.equal(shouldPollDelivery("succeeded", true), false);
  assert.equal(shouldPollDelivery("running", false), false);
});

test("refreshes active delivery on the polling timer and clears it on teardown", () => {
  let scheduled: (() => void) | null = null;
  let delay = 0;
  let cancelled = 0;
  let refreshes = 0;
  const stop = startDeliveryPolling("running", true, () => { refreshes += 1; }, (callback, timeout) => { scheduled = callback; delay = timeout; return 17; }, (timer) => { cancelled = timer; });
  assert.equal(delay, DELIVERY_POLL_INTERVAL_MS);
  const pollCallback = scheduled as (() => void) | null;
  if (!pollCallback) throw new Error("未注册交付轮询回调");
  pollCallback();
  assert.equal(refreshes, 1);
  stop();
  assert.equal(cancelled, 17);
});

test("exposes retry and cancellation buttons only at their persisted boundaries", () => {
  let retryCalls = 0;
  let cancelCalls = 0;
  const failedTree = controlTree({ acceptance: acceptance({ currentDelivery: delivery({ status: "failed", externalEffectStarted: true, attempts: [{ attemptNo: 1, status: "failed", failureSummary: "提交失败" }] }) }), onRetry: () => { retryCalls += 1; } });
  buttonByText(failedTree, "重试").props.onClick?.();
  assert.equal(retryCalls, 1);
  const queuedTree = controlTree({ acceptance: acceptance({ currentDelivery: delivery({ status: "queued" }) }), onCancel: () => { cancelCalls += 1; } });
  buttonByText(queuedTree, "取消").props.onClick?.();
  assert.equal(cancelCalls, 1);
  const preparingTree = controlTree({ acceptance: acceptance({ currentDelivery: delivery({ status: "preparing" }) }), onCancel: () => { cancelCalls += 1; } });
  buttonByText(preparingTree, "取消").props.onClick?.();
  assert.equal(cancelCalls, 2);
  const runningHtml = renderToStaticMarkup(controlTree({ acceptance: acceptance({ currentDelivery: delivery({ status: "running", externalEffectStarted: true }) }) }));
  assert.doesNotMatch(runningHtml, /取消/);
});

test("offers both human reconciliation outcomes for an unknown external result", () => {
  let retryCalls = 0;
  let completeCalls = 0;
  const tree = controlTree({
    acceptance: acceptance({ currentDelivery: delivery({ method: "github_pr", status: "waiting_human", externalEffectStarted: true }) }),
    onReconcileRetry: () => { retryCalls += 1; },
    onReconcileComplete: () => { completeCalls += 1; }
  });
  buttonByText(tree, "确认外部交付已完成").props.onClick?.();
  buttonByText(tree, "确认无外部副作用并重试").props.onClick?.();
  assert.equal(completeCalls, 1);
  assert.equal(retryCalls, 1);
});

test("renders succeeded delivery as read-only result with no write controls", () => {
  const html = renderToStaticMarkup(controlTree({ acceptance: acceptance({ commissionStatus: "done", currentDelivery: delivery({ method: "github_pr", status: "succeeded", result: { method: "github_pr", prUrl: "https://github.com/owner/repo/pull/7" }, progress: { currentStep: null, steps: { pr: { status: "succeeded", detail: null } } }, attempts: [{ attemptNo: 1, status: "succeeded", failureSummary: null }] }) }) }));
  assert.match(html, /交付已完成。/);
  assert.match(html, /交付方式/);
  assert.match(html, /GitHub PR/);
  assert.match(html, /执行结果/);
  assert.match(html, /第 1 次尝试完成/);
  assert.match(html, /https:\/\/github\.com\/owner\/repo\/pull\/7/);
  assert.doesNotMatch(html, /method|步骤 pr|succeeded/);
  assert.doesNotMatch(html, /生成交付预览|重新生成预览|确认并交付|重试|取消/);
});
