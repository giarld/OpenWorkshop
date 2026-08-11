import assert from "node:assert/strict";
import test from "node:test";
import { activeProjects, projectIdAfterArchive, storedWorkspaceView, type ManagedProject } from "./project-management.ts";

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
