import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { openWorkshopDatabase } from "./database.ts";
import { PROJECT_NAME_MAX_LENGTH, browseDirectory, detectVcs, ensureWorkshopOwnership, registerProjectRoutes, resolveWithinRoot, scanProject, type CommandRunner } from "./projects.ts";

test("rejects lexical and realpath escapes from an allowed root", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-paths-"));
  const root = join(home, "allowed");
  const outside = join(home, "outside");
  try {
    await Promise.all([mkdir(join(root, "project"), { recursive: true }), mkdir(outside)]);
    await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    assert.equal(await resolveWithinRoot(root, "project"), await realpath(join(root, "project")));
    await assert.rejects(resolveWithinRoot(root, "../outside"), /escapes the enabled root/);
    await assert.rejects(resolveWithinRoot(root, "escape"), /escapes the enabled root/);
    const browse = await browseDirectory(root);
    assert.equal(browse.entries.find((entry) => entry.name === "escape")?.selectable, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("recognizes Git, SVN, and projects without version control", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-workshop-vcs-"));
  try {
    const canonicalRoot = await realpath(root);
    const runner = (responses: Record<string, string | Error>): CommandRunner => async (file, args) => {
      const response = responses[`${file} ${args.join(" ")}`];
      if (response instanceof Error || response === undefined) throw response ?? new Error("missing command");
      return response;
    };
    assert.deepEqual(await detectVcs(root, runner({ "git rev-parse --show-toplevel": root })), { type: "git", root: canonicalRoot });
    assert.deepEqual(await detectVcs(root, runner({ "svn info --show-item wc-root": root })), { type: "svn", root: canonicalRoot });
    assert.deepEqual(await detectVcs(root, runner({})), { type: "none", root: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scans instructions and build hints without executing them and protects .openworkshop ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-workshop-scan-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "Do not build without approval.\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "node --test", start: "node ." } }));
    const profile = await scanProject(root);
    assert.deepEqual(profile.agentsFiles, ["AGENTS.md"]);
    assert.deepEqual(profile.suggestedCommands, ["npm run build", "npm run test"]);

    assert.equal((await ensureWorkshopOwnership(root, "installation", "project")).created, true);
    assert.equal((await ensureWorkshopOwnership(root, "installation", "project")).created, false);
    await assert.rejects(ensureWorkshopOwnership(root, "other", "project"), /owner does not match/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symbolic links for .openworkshop and its owner file", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-owner-links-"));
  const linkedProject = join(home, "linked-project");
  const ownerProject = join(home, "owner-project");
  const outsideWorkshop = join(home, "outside-workshop");
  const outsideOwner = join(home, "outside-owner.json");
  const owner = `${JSON.stringify({ installation_id: "installation", project_id: "project" })}\n`;
  try {
    await Promise.all([mkdir(linkedProject), mkdir(ownerProject), mkdir(outsideWorkshop)]);
    await writeFile(join(outsideWorkshop, ".owner.json"), owner);
    await symlink(outsideWorkshop, join(linkedProject, ".openworkshop"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(ensureWorkshopOwnership(linkedProject, "installation", "project"), /symbolic link|escapes/);

    await mkdir(join(ownerProject, ".openworkshop"));
    await writeFile(outsideOwner, owner);
    await context.test("owner file link", async (ownerContext) => {
      try {
        await symlink(outsideOwner, join(ownerProject, ".openworkshop", ".owner.json"), "file");
      } catch (error) {
        if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") {
          ownerContext.skip("Windows symbolic-link privilege is unavailable");
          return;
        }
        throw error;
      }
      await assert.rejects(ensureWorkshopOwnership(ownerProject, "installation", "project"), /symbolic link|regular file/);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("associates and archives a project without deleting its record", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-projects-"));
  const allowed = join(home, "allowed");
  const project = join(allowed, "project");
  const data = join(home, "data");
  const server = Fastify();
  let database;
  try {
    await Promise.all([mkdir(project, { recursive: true }), mkdir(data)]);
    database = await openWorkshopDatabase(data);
    registerProjectRoutes(server, database);
    const rootResponse = await server.inject({ method: "POST", url: "/api/roots", payload: { path: allowed } });
    assert.equal(rootResponse.statusCode, 201);
    const root = rootResponse.json() as { id: string };
    const projectResponse = await server.inject({ method: "POST", url: "/api/projects", payload: { name: "Example", path: project, rootPathId: root.id } });
    assert.equal(projectResponse.statusCode, 201);
    const associated = projectResponse.json() as { id: string; vcs_type: string };
    assert.equal(associated.vcs_type, "none");

    const now = new Date().toISOString();
    const commission = randomUUID(), requirement = randomUUID(), task = randomUUID(), grant = randomUUID(), run = randomUUID();
    database.prepare("INSERT INTO commissions (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, 'Commission', 'planned', ?, ?)").run(commission, associated.id, now, now);
    database.prepare("INSERT INTO requirement_versions (id, commission_id, version_no, content_markdown, acceptance_json, status, created_by, created_at, approved_at) VALUES (?, ?, 1, 'Requirement', '[]', 'approved', 'human', ?, ?)").run(requirement, commission, now, now);
    database.prepare("UPDATE commissions SET active_requirement_version_id = ?, status = 'active' WHERE id = ?").run(requirement, commission);
    database.prepare("INSERT INTO tasks (id, commission_id, number_path, position, title, description, status, priority, owner_type, acceptance_json, review_round_limit, review_round_used, created_at, updated_at) VALUES (?, ?, '1', 0, 'Task', '', 'todo', 'medium', 'ai', '[]', 2, 0, ?, ?)").run(task, commission, now, now);
    database.prepare("UPDATE commissions SET main_task_id = ? WHERE id = ?").run(task, commission);
    database.prepare("INSERT INTO execution_grants (id, commission_id, root_task_id, scope, status, created_at) VALUES (?, ?, ?, 'commission_tree', 'active', ?)").run(grant, commission, task, now);
    database.prepare("INSERT INTO runs (id, project_id, commission_id, task_id, role, trigger_type, execution_grant_id, status, attempt_no, config_snapshot_json, context_snapshot_json) VALUES (?, ?, ?, ?, 'developer', 'manual', ?, 'queued', 1, '{}', '{}')").run(run, associated.id, commission, task, grant);
    const listed = (await server.inject({ method: "GET", url: "/api/projects" })).json() as Array<{ id: string; task_total: number; task_completed: number; run_queued: number; run_active: number; run_waiting: number }>;
    const summary = listed.find((item) => item.id === associated.id)!;
    assert.deepEqual({ task_total: summary.task_total, task_completed: summary.task_completed, run_queued: summary.run_queued, run_active: summary.run_active, run_waiting: summary.run_waiting }, { task_total: 1, task_completed: 0, run_queued: 1, run_active: 0, run_waiting: 0 });
    assert.equal((await server.inject({ method: "PUT", url: `/api/roots/${root.id}`, payload: { enabled: false } })).statusCode, 409);
    assert.equal((await server.inject({ method: "POST", url: `/api/projects/${associated.id}/archive` })).statusCode, 409);
    database.prepare("UPDATE runs SET status = 'cancelled' WHERE id = ?").run(run);
    assert.equal((await server.inject({ method: "PUT", url: `/api/roots/${root.id}`, payload: { enabled: false } })).statusCode, 200);
    assert.equal((database.prepare("SELECT status FROM execution_grants WHERE id = ?").get(grant) as { status: string }).status, "revoked");
    assert.equal((await server.inject({ method: "PUT", url: `/api/roots/${root.id}`, payload: { enabled: true } })).statusCode, 200);
    const archivedResponse = await server.inject({ method: "POST", url: `/api/projects/${associated.id}/archive` });
    assert.equal(archivedResponse.statusCode, 200);
    assert.ok((archivedResponse.json() as { archived_at: string | null }).archived_at);
    const restoredResponse = await server.inject({ method: "POST", url: "/api/projects", payload: { name: "Restored", path: project, rootPathId: root.id } });
    assert.equal(restoredResponse.statusCode, 200);
    const restored = restoredResponse.json() as { id: string; name: string; archived_at: string | null };
    assert.equal(restored.id, associated.id);
    assert.equal(restored.name, "Restored");
    assert.equal(restored.archived_at, null);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?").get(associated.id) as { count: number }).count, 1);
  } finally {
    await server.close();
    database?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("rejects project names over the configured length limit", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-project-name-"));
  const allowed = join(home, "allowed");
  const project = join(allowed, "project");
  const data = join(home, "data");
  const server = Fastify();
  let database;
  try {
    await Promise.all([mkdir(project, { recursive: true }), mkdir(data)]);
    database = await openWorkshopDatabase(data);
    registerProjectRoutes(server, database);
    const root = (await server.inject({ method: "POST", url: "/api/roots", payload: { path: allowed } })).json() as { id: string };
    const tooLong = "P".repeat(PROJECT_NAME_MAX_LENGTH + 1);
    const create = await server.inject({ method: "POST", url: "/api/projects", payload: { name: tooLong, path: project, rootPathId: root.id } });
    assert.equal(create.statusCode, 400);
    assert.match(create.json().message as string, new RegExp(`at most ${PROJECT_NAME_MAX_LENGTH}`));

    const created = await server.inject({ method: "POST", url: "/api/projects", payload: { name: "Valid", path: project, rootPathId: root.id } });
    assert.equal(created.statusCode, 201);
    const update = await server.inject({ method: "PUT", url: `/api/projects/${created.json().id as string}`, payload: { name: tooLong } });
    assert.equal(update.statusCode, 400);
    assert.match(update.json().message as string, new RegExp(`at most ${PROJECT_NAME_MAX_LENGTH}`));
  } finally {
    await server.close();
    database?.close();
    await rm(home, { recursive: true, force: true });
  }
});
