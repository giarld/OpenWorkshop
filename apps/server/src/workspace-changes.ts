import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CommandRunner, VcsInfo } from "./projects.ts";

export type WorkspaceChange = { path: string; changeType: string; hash: string | null };
export type WorkspaceSnapshot = { version: 1; vcs: VcsInfo["type"]; changes: WorkspaceChange[] };
export type DiffEvidenceChange = WorkspaceChange & { baselineHash: string | null; safe: boolean; reason?: "preexisting_change" };

export async function captureWorkspaceSnapshot(root: string, vcs: VcsInfo["type"], runner: CommandRunner, includePaths: readonly string[] = []): Promise<WorkspaceSnapshot> {
  const states = vcs === "git" ? parseGitStatus(await runner("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], root))
    : vcs === "svn" ? parseSvnStatus(await runner("svn", ["status", "--xml"], root)) : [];
  const changes = await Promise.all(states.map(async ({ path, changeType }) => {
    const projectPath = normalizePath(root, path);
    return { path: projectPath, changeType, hash: await contentHash(resolve(root, projectPath)) };
  }));
  const captured = new Set(changes.map(({ path }) => path));
  for (const path of includePaths) {
    const projectPath = normalizePath(root, path);
    if (!captured.has(projectPath)) changes.push({ path: projectPath, changeType: "clean", hash: await contentHash(resolve(root, projectPath)) });
  }
  return { version: 1, vcs, changes: changes.sort(byPath) };
}

export function diffWorkspaceSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot, previouslyOwned: ReadonlyMap<string, string | null>): { changes: DiffEvidenceChange[]; unownedPaths: string[] } {
  const baseline = new Map(before.changes.map((change) => [change.path, change]));
  const current = new Map(after.changes.map((change) => [change.path, change]));
  const unownedPaths = before.changes.filter((change) => !previouslyOwned.has(change.path) || previouslyOwned.get(change.path) !== change.hash).map(({ path }) => path);
  const changes: DiffEvidenceChange[] = [];
  for (const path of new Set([...baseline.keys(), ...current.keys()])) {
    const prior = baseline.get(path);
    const next = current.get(path);
    if (prior?.changeType === next?.changeType && prior?.hash === next?.hash) continue;
    const safe = !prior || previouslyOwned.get(path) === prior.hash;
    changes.push({ path, changeType: next?.changeType ?? "deleted", baselineHash: prior?.hash ?? null, hash: next?.hash ?? null, safe, ...(safe ? {} : { reason: "preexisting_change" as const }) });
  }
  return { changes: changes.sort(byPath), unownedPaths: [...new Set(unownedPaths)].sort() };
}

export function latestCommissionHashes(database: DatabaseSync, commissionId: string): Map<string, string | null> {
  const rows = database.prepare(`SELECT evidence.payload_json FROM evidence JOIN tasks ON tasks.id = evidence.task_id
    WHERE tasks.commission_id = ? AND evidence.type = 'diff' ORDER BY evidence.rowid DESC`).all(commissionId) as Array<{ payload_json: string }>;
  const hashes = new Map<string, string | null>();
  const seen = new Set<string>();
  for (const { payload_json } of rows) {
    const payload = JSON.parse(payload_json) as { changes?: DiffEvidenceChange[]; appliedChanges?: DiffEvidenceChange[] };
    for (const change of [...payload.appliedChanges ?? [], ...payload.changes ?? []]) {
      if (seen.has(change.path)) continue;
      seen.add(change.path);
      if (change.safe) hashes.set(change.path, change.hash);
    }
  }
  return hashes;
}

export async function commissionAttributionSnapshot(database: DatabaseSync, commissionId: string, root: string, vcs: VcsInfo["type"], runner: CommandRunner) {
  const current = await captureWorkspaceSnapshot(root, vcs, runner);
  const expected = latestCommissionHashes(database, commissionId);
  const ownedPaths: string[] = [], unownedPaths: string[] = [], driftedPaths: string[] = [];
  const currentPaths = new Set(current.changes.map(({ path }) => path));
  for (const change of current.changes) {
    if (!expected.has(change.path)) unownedPaths.push(change.path);
    else if (expected.get(change.path) !== change.hash) driftedPaths.push(change.path);
    else ownedPaths.push(change.path);
  }
  for (const [path, hash] of expected) if (!currentPaths.has(path) && await contentHash(resolve(root, path)) !== hash) driftedPaths.push(path);
  return { snapshot: current, ownedPaths, unownedPaths, driftedPaths };
}

function parseGitStatus(output: string): Array<{ path: string; changeType: string }> {
  const entries = output.split("\0").filter(Boolean);
  const changes: Array<{ path: string; changeType: string }> = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.length < 4 || entry[2] !== " ") continue;
    const status = entry.slice(0, 2);
    changes.push({ path: entry.slice(3), changeType: gitChangeType(status) });
    if (status.includes("R") || status.includes("C")) {
      const source = entries[index + 1];
      if (source && status.includes("R")) changes.push({ path: source, changeType: "deleted" });
      index += 1;
    }
  }
  return changes;
}

function gitChangeType(status: string): string {
  if (status === "??") return "added";
  if (status.includes("D")) return "deleted";
  if (status.includes("R")) return "renamed";
  if (status.includes("C")) return "copied";
  if (status.includes("A")) return "added";
  return "modified";
}

function parseSvnStatus(output: string): Array<{ path: string; changeType: string }> {
  return [...output.matchAll(/<entry\s+path="([^"]+)"[\s\S]*?<wc-status\b[^>]*\bitem="([^"]+)"/g)]
    .filter((match) => !["normal", "none", "external", "ignored"].includes(match[2]!))
    .map((match) => ({ path: decodeXml(match[1]!), changeType: match[2] === "unversioned" ? "added" : match[2]! }));
}

export async function contentHash(path: string): Promise<string | null> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return null;
  const content = info.isSymbolicLink() ? Buffer.from(await readlink(path)) : info.isFile() ? await readFile(path) : info.isDirectory()
    ? Buffer.from((await Promise.all((await readdir(path)).sort().map(async (name) => `${name}\0${await contentHash(resolve(path, name)) ?? ""}`))).join("\0")) : undefined;
  return content ? createHash("sha256").update(content).digest("hex") : null;
}

function normalizePath(root: string, path: string): string {
  const projectPath = relative(root, resolve(root, path));
  if (isAbsolute(projectPath) || projectPath === ".." || projectPath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new Error(`VCS path escapes project root: ${path}`);
  return projectPath.replaceAll("\\", "/");
}

function decodeXml(value: string): string {
  return value.replaceAll("&quot;", "\"").replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function byPath(left: { path: string }, right: { path: string }): number { return left.path.localeCompare(right.path); }
