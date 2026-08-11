import assert from "node:assert/strict";
import test from "node:test";
import { activeProjects, createKeyedSingleFlight, createProjectDataRequestGate, projectIdAfterArchive, storedWorkspaceView, workspaceContentState, type ManagedProject } from "./project-management.ts";

const project = (id: string, archivedAt: string | null = null): ManagedProject => ({ id, name: id, path: `C:/${id}`, real_path: `C:/${id}`, archived_at: archivedAt });

test("project management only lists active associations", () => {
  assert.deepEqual(activeProjects([project("active"), project("archived", "2026-08-10T00:00:00.000Z")]).map((item) => item.id), ["active"]);
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
  assert.equal(storedWorkspaceView("removed-page"), "commissions");
  assert.equal(storedWorkspaceView(null), "commissions");
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
