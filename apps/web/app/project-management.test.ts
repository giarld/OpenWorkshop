import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_NAME_MAX_LENGTH, activeProjects, createKeyedSingleFlight, createProjectDataRequestGate, initialWorkspaceView, isStaleWorkspaceHash, projectIdAfterArchive, projectNameError, projectRunLabels, storedWorkspaceView, workspaceContentState, type ManagedProject } from "./project-management.ts";

const project = (id: string, archivedAt: string | null = null): ManagedProject => ({ id, name: id, path: `C:/${id}`, real_path: `C:/${id}`, archived_at: archivedAt, task_total: 0, task_completed: 0, run_queued: 0, run_active: 0, run_waiting: 0 });

test("project management only lists active associations", () => {
  assert.deepEqual(activeProjects([project("active"), project("archived", "2026-08-10T00:00:00.000Z")]).map((item) => item.id), ["active"]);
});

test("lists every active project run state", () => {
  assert.deepEqual(projectRunLabels({ ...project("active"), run_active: 2, run_queued: 1, run_waiting: 3 }), ["运行 2", "排队 1", "等待 3"]);
  assert.deepEqual(projectRunLabels(project("idle")), []);
});

test("validates project name length consistently", () => {
  assert.equal(projectNameError("Project"), null);
  assert.equal(projectNameError(" "), "项目名称不能为空。");
  assert.equal(projectNameError("项".repeat(PROJECT_NAME_MAX_LENGTH)), null);
  assert.equal(projectNameError("项".repeat(PROJECT_NAME_MAX_LENGTH + 1)), `项目名称不能超过 ${PROJECT_NAME_MAX_LENGTH} 个字符。`);
});

test("archiving the active project selects the next available project", () => {
  assert.equal(projectIdAfterArchive([project("first"), project("second")], "first", "first"), "second");
  assert.equal(projectIdAfterArchive([project("first")], "first", "first"), "");
});

test("archiving another project preserves the current selection", () => {
  assert.equal(projectIdAfterArchive([project("first"), project("second")], "first", "second"), "first");
});

test("restores a valid workspace page and rejects stale values", () => {
  assert.equal(storedWorkspaceView("projects"), "projects");
  assert.equal(storedWorkspaceView("settings"), "settings");
  assert.equal(storedWorkspaceView("usage"), "usage");
  assert.equal(storedWorkspaceView("history"), "board");
  assert.equal(storedWorkspaceView("removed-page"), "commissions");
  assert.equal(storedWorkspaceView(null), "commissions");
});

test("keeps the saved workspace page on refresh instead of letting a stale hash override it", () => {
  assert.equal(initialWorkspaceView("delivery", "#task-old"), "delivery");
  assert.equal(initialWorkspaceView("settings", "#approval-old"), "settings");
  assert.equal(initialWorkspaceView("history", ""), "board");
  assert.equal(initialWorkspaceView(null, "#task-current"), "board");
  assert.equal(initialWorkspaceView("removed-page", "#approval-current"), "notifications");
  assert.equal(initialWorkspaceView(null, ""), "commissions");
});

test("clears a stale notification hash only when restoring a saved workspace page", () => {
  assert.equal(isStaleWorkspaceHash("delivery", "#task-old"), true);
  assert.equal(isStaleWorkspaceHash("settings", "#approval-old"), true);
  assert.equal(isStaleWorkspaceHash(null, "#task-current"), false);
  assert.equal(isStaleWorkspaceHash("removed-page", "#approval-current"), false);
  assert.equal(isStaleWorkspaceHash("delivery", "#section"), false);
});

test("keeps settings available while project data is loading", () => {
  assert.equal(workspaceContentState("settings", true), "settings");
  assert.equal(workspaceContentState("commissions", true), "loading");
  assert.equal(workspaceContentState("settings", false), "settings");
  assert.equal(workspaceContentState("commissions", false), "ready");
});

test("only accepts the latest project data request", () => {
  const gate = createProjectDataRequestGate();
  const older = gate.begin("project-a");
  const newer = gate.begin("project-a");

  assert.equal(gate.accepts(older, "project-a"), false);
  assert.equal(gate.accepts(newer, "project-a"), true);
  assert.equal(gate.accepts(newer, "project-b"), false);
});

test("keeps project loading ownership separate from data refresh requests", () => {
  const dataGate = createProjectDataRequestGate();
  const loadingGate = createProjectDataRequestGate();
  const loadingRequest = loadingGate.begin("project-b");
  const snapshotRequest = dataGate.begin("project-b");
  const taskRefreshRequest = dataGate.begin("project-b");

  assert.equal(dataGate.accepts(snapshotRequest, "project-b"), false);
  assert.equal(dataGate.accepts(taskRefreshRequest, "project-b"), true);
  assert.equal(loadingGate.accepts(loadingRequest, "project-b"), true);
});

test("invalidating project data requests rejects in-flight responses", () => {
  const gate = createProjectDataRequestGate();
  const request = gate.begin("project-a");

  gate.invalidate();

  assert.equal(gate.accepts(request, "project-a"), false);
});

test("keeps a slow project snapshot single-flight across polling ticks", async () => {
  const singleFlight = createKeyedSingleFlight();
  let calls = 0;
  let resolveSlowRequest: (() => void) | undefined;
  const operation = () => {
    calls += 1;
    return new Promise<void>((resolve) => { resolveSlowRequest = resolve; });
  };

  const first = singleFlight.run("project-a", operation);
  const afterOneInterval = singleFlight.run("project-a", operation);
  const afterTwoIntervals = singleFlight.run("project-a", operation);

  assert.equal(calls, 1);
  assert.equal(afterOneInterval, first);
  assert.equal(afterTwoIntervals, first);
  resolveSlowRequest?.();
  await first;

  await singleFlight.run("project-a", async () => { calls += 1; });
  assert.equal(calls, 2);
});

test("allows a new project snapshot while the previous project is still loading", async () => {
  const singleFlight = createKeyedSingleFlight();
  let resolveFirst: (() => void) | undefined;
  const first = singleFlight.run("project-a", () => new Promise<void>((resolve) => { resolveFirst = resolve; }));
  let secondStarted = false;

  await singleFlight.run("project-b", async () => { secondStarted = true; });

  assert.equal(secondStarted, true);
  resolveFirst?.();
  await first;
});
