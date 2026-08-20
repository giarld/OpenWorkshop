import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { openWorkshopDatabase } from "./database.ts";
import { captureWorkspaceSnapshot, commissionAttributionSnapshot, diffWorkspaceSnapshots } from "./workspace-changes.ts";

const command = promisify(execFile);

test("change attribution rejects pre-existing and drifted Git changes", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-attribution-"));
  const root = join(home, "project");
  await mkdir(root);
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, "init");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "base");
  const database = await openWorkshopDatabase(home);
  try {
    const ids = seed(database, root);
    await writeFile(join(root, "user.txt"), "pre-existing\n");
    const baseline = await captureWorkspaceSnapshot(root, "git", run);
    await writeFile(join(root, "feature.txt"), "owned\n");
    await writeFile(join(root, "user.txt"), "changed during Run\n");
    const after = await captureWorkspaceSnapshot(root, "git", run);
    const diff = diffWorkspaceSnapshots(baseline, after, new Map());
    assert.deepEqual(diff.unownedPaths, ["user.txt"]);
    assert.equal(diff.changes.find((change) => change.path === "user.txt")?.safe, false);
    assert.equal(diff.changes.find((change) => change.path === "feature.txt")?.safe, true);

    database.prepare("INSERT INTO evidence (id, task_id, criterion_key, type, status, summary, payload_json, created_at) VALUES (?, ?, '*', 'diff', 'passed', 'owned', ?, ?)")
      .run(randomUUID(), ids.task, JSON.stringify({ changes: [{ path: "feature.txt", changeType: "added", baselineHash: null, hash: diff.changes.find((change) => change.path === "feature.txt")?.hash, safe: true }] }), new Date().toISOString());
    const owned = await commissionAttributionSnapshot(database, ids.commission, root, "git", run);
    assert.deepEqual(owned.ownedPaths, ["feature.txt"]);
    await writeFile(join(root, "feature.txt"), "drifted\n");
    const drifted = await commissionAttributionSnapshot(database, ids.commission, root, "git", run);
    assert.deepEqual(drifted.driftedPaths, ["feature.txt"]);
    await rm(join(root, "feature.txt"));
    assert.deepEqual((await commissionAttributionSnapshot(database, ids.commission, root, "git", run)).driftedPaths, ["feature.txt"]);
  } finally {
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("restoring an owned tracked file records its clean content hash without drift", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-restored-attribution-"));
  const root = join(home, "project");
  await mkdir(root);
  await writeFile(join(root, "feature.txt"), "base\n");
  await git(root, "init");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "base");
  const database = await openWorkshopDatabase(home);
  try {
    const ids = seed(database, root);
    const clean = await captureWorkspaceSnapshot(root, "git", run);
    await writeFile(join(root, "feature.txt"), "owned\n");
    const owned = await captureWorkspaceSnapshot(root, "git", run);
    const first = diffWorkspaceSnapshots(clean, owned, new Map()).changes[0]!;
    database.prepare("INSERT INTO evidence (id, task_id, criterion_key, type, status, summary, payload_json, created_at) VALUES (?, ?, '*', 'diff', 'passed', 'owned', ?, ?)")
      .run(randomUUID(), ids.task, JSON.stringify({ changes: [first] }), new Date().toISOString());

    await git(root, "checkout", "--", "feature.txt");
    const restored = diffWorkspaceSnapshots(owned, await captureWorkspaceSnapshot(root, "git", run, ["feature.txt"]), new Map([["feature.txt", first.hash]])).changes[0]!;
    assert.equal(restored.changeType, "clean");
    assert.match(restored.hash!, /^[a-f0-9]{64}$/);
    database.prepare("INSERT INTO evidence (id, task_id, criterion_key, type, status, summary, payload_json, created_at) VALUES (?, ?, '*', 'diff', 'passed', 'restored', ?, ?)")
      .run(randomUUID(), ids.task, JSON.stringify({ changes: [restored] }), new Date().toISOString());

    assert.deepEqual(await commissionAttributionSnapshot(database, ids.commission, root, "git", run), {
      snapshot: { version: 1, vcs: "git", changes: [] }, ownedPaths: [], unownedPaths: [], driftedPaths: []
    });
  } finally {
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("applied Worktree hashes replace Worktree-local hashes for attribution", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-applied-attribution-"));
  const root = join(home, "project");
  await mkdir(root);
  await writeFile(join(root, "feature.txt"), "merged result\n");
  await git(root, "init");
  const database = await openWorkshopDatabase(home);
  try {
    const ids = seed(database, root);
    const applied = await captureWorkspaceSnapshot(root, "git", run);
    database.prepare("INSERT INTO evidence (id, task_id, criterion_key, type, status, summary, payload_json, created_at) VALUES (?, ?, '*', 'diff', 'passed', 'applied', ?, ?)")
      .run(randomUUID(), ids.task, JSON.stringify({
        changes: [{ path: "feature.txt", changeType: "added", baselineHash: null, hash: "worktree-hash", safe: true }],
        appliedChanges: [{ path: "feature.txt", changeType: "added", baselineHash: null, hash: applied.changes[0]!.hash, safe: true }]
      }), new Date().toISOString());

    assert.deepEqual((await commissionAttributionSnapshot(database, ids.commission, root, "git", run)).ownedPaths, ["feature.txt"]);
  } finally {
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("latest unsafe Evidence revokes older safe attribution", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-unsafe-attribution-"));
  const root = join(home, "project");
  await mkdir(root);
  await writeFile(join(root, "feature.txt"), "base\n");
  await git(root, "init");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "base");
  const database = await openWorkshopDatabase(home);
  try {
    const ids = seed(database, root);
    await writeFile(join(root, "feature.txt"), "owned\n");
    const owned = (await captureWorkspaceSnapshot(root, "git", run)).changes[0]!;
    database.prepare("INSERT INTO evidence (id, task_id, criterion_key, type, status, summary, payload_json, created_at) VALUES (?, ?, '*', 'diff', 'passed', 'owned', ?, ?)")
      .run(randomUUID(), ids.task, JSON.stringify({ changes: [{ ...owned, baselineHash: null, safe: true }] }), new Date().toISOString());

    await writeFile(join(root, "feature.txt"), "user drift\n");
    const drifted = (await captureWorkspaceSnapshot(root, "git", run)).changes[0]!;
    database.prepare("INSERT INTO evidence (id, task_id, criterion_key, type, status, summary, payload_json, created_at) VALUES (?, ?, '*', 'diff', 'failed', 'unsafe', ?, ?)")
      .run(randomUUID(), ids.task, JSON.stringify({ changes: [{ ...drifted, baselineHash: owned.hash, safe: false, reason: "preexisting_change" }] }), new Date().toISOString());

    assert.deepEqual(await commissionAttributionSnapshot(database, ids.commission, root, "git", run), {
      snapshot: { version: 1, vcs: "git", changes: [{ path: "feature.txt", changeType: "modified", hash: drifted.hash }] },
      ownedPaths: [],
      unownedPaths: ["feature.txt"],
      driftedPaths: []
    });
  } finally {
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("delivery JSON and active-attempt constraints are enforced", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-delivery-schema-"));
  const database = await openWorkshopDatabase(home);
  try {
    const ids = seed(database, join(home, "project"));
    const now = new Date().toISOString();
    database.prepare("INSERT INTO deliveries (id, commission_id, main_task_id, method, status, request_json, preview_json, progress_json, result_json, external_effect_started, created_at, updated_at) VALUES (?, ?, ?, 'document', 'queued', '{}', '{}', '{}', '{}', 0, ?, ?)")
      .run(randomUUID(), ids.commission, ids.task, now, now);
    const delivery = database.prepare("SELECT id FROM deliveries").get() as { id: string };
    database.prepare("INSERT INTO delivery_attempts (id, delivery_id, attempt_no, status, request_json, preview_json, progress_json, result_json, created_at) VALUES (?, ?, 1, 'running', '{}', '{}', '{}', '{}', ?)")
      .run(randomUUID(), delivery.id, now);
    assert.throws(() => database.prepare("INSERT INTO delivery_attempts (id, delivery_id, attempt_no, status, request_json, preview_json, progress_json, result_json, created_at) VALUES (?, ?, 2, 'preparing', '{}', '{}', '{}', '{}', ?)").run(randomUUID(), delivery.id, now), /UNIQUE/);
    database.prepare("UPDATE delivery_attempts SET status = 'waiting_human' WHERE delivery_id = ?").run(delivery.id);
    assert.throws(() => database.prepare("INSERT INTO delivery_attempts (id, delivery_id, attempt_no, status, request_json, preview_json, progress_json, result_json, created_at) VALUES (?, ?, 2, 'queued', '{}', '{}', '{}', '{}', ?)").run(randomUUID(), delivery.id, now), /UNIQUE/);
    assert.throws(() => database.prepare("UPDATE delivery_attempts SET request_json = '{\"changed\":true}' WHERE delivery_id = ?").run(delivery.id), /immutable/);
    assert.throws(() => database.prepare("INSERT INTO deliveries (id, commission_id, main_task_id, method, status, request_json, preview_json, progress_json, result_json, external_effect_started, created_at, updated_at) VALUES (?, ?, ?, 'document', 'queued', '[]', '{}', '{}', '{}', 0, ?, ?)").run(randomUUID(), ids.commission, ids.task, now, now), /CHECK/);
  } finally {
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("SVN snapshots record exclusive-workspace deltas conservatively", async () => {
  const home = await mkdtemp(join(process.cwd(), ".project-workshop-svn-attribution-"));
  const repository = join(home, "repository"), workingCopy = join(home, "working-copy");
  try {
    await command("svnadmin", ["create", repository], { windowsHide: true });
    await command("svn", ["checkout", pathToFileURL(repository).href, workingCopy, "--non-interactive"], { windowsHide: true });
    await writeFile(join(workingCopy, "base.txt"), "base\n");
    await command("svn", ["add", "base.txt"], { cwd: workingCopy, windowsHide: true });
    await command("svn", ["commit", "-m", "base", "--non-interactive"], { cwd: workingCopy, windowsHide: true });
    await writeFile(join(workingCopy, "base.txt"), "user change\n");
    const baseline = await captureWorkspaceSnapshot(workingCopy, "svn", run);
    await writeFile(join(workingCopy, "base.txt"), "Run touched user file\n");
    await writeFile(join(workingCopy, "feature.txt"), "Run change\n");
    const diff = diffWorkspaceSnapshots(baseline, await captureWorkspaceSnapshot(workingCopy, "svn", run), new Map());
    assert.deepEqual(diff.unownedPaths, ["base.txt"]);
    assert.equal(diff.changes.find(({ path }) => path === "base.txt")?.safe, false);
    assert.equal(diff.changes.find(({ path }) => path === "feature.txt")?.safe, true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

async function git(cwd: string, ...args: string[]): Promise<void> { await command("git", args, { cwd, windowsHide: true }); }
async function run(file: string, args: string[], cwd: string): Promise<string> { return (await command(file, args, { cwd, encoding: "utf8", windowsHide: true })).stdout; }

function seed(database: Awaited<ReturnType<typeof openWorkshopDatabase>>, root: string) {
  const now = new Date().toISOString();
  const rootId = randomUUID(), project = randomUUID(), commission = randomUUID(), requirement = randomUUID(), task = randomUUID();
  database.prepare("INSERT INTO root_paths (id, path, real_path, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)").run(rootId, root, root, now, now);
  database.prepare("INSERT INTO projects (id, name, path, real_path, root_path_id, vcs_type, vcs_root, created_at, updated_at) VALUES (?, 'Project', ?, ?, ?, 'git', ?, ?, ?)").run(project, root, root, rootId, root, now, now);
  database.prepare("INSERT INTO commissions (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, 'Commission', 'active', ?, ?)").run(commission, project, now, now);
  database.prepare("INSERT INTO requirement_versions (id, commission_id, version_no, content_markdown, acceptance_json, status, created_by, created_at) VALUES (?, ?, 1, 'Requirement', '[]', 'approved', 'human', ?)").run(requirement, commission, now);
  database.prepare("UPDATE commissions SET active_requirement_version_id = ? WHERE id = ?").run(requirement, commission);
  database.prepare("INSERT INTO tasks (id, commission_id, number_path, position, title, description, status, priority, owner_type, acceptance_json, review_round_limit, review_round_used, created_at, updated_at) VALUES (?, ?, '1', 0, 'Task', '', 'in_progress', 'medium', 'ai', '[]', 1, 0, ?, ?)").run(task, commission, now, now);
  return { commission, task };
}
