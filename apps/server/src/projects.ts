import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";

const runFile = promisify(execFile);
const SCAN_IGNORES = new Set([".git", ".svn", ".openworkshop", "node_modules", "vendor", "dist", "build", "target", ".cache"]);
const RESERVED_RUN_STATUSES = ["queued", "preparing", "running", "waiting_approval", "waiting_input"] as const;
export const PROJECT_NAME_MAX_LENGTH = 100;
const BUILD_HINTS: Record<string, string[]> = {
  "CMakeLists.txt": ["cmake -S . -B build", "cmake --build build"],
  Makefile: ["make"],
  "Cargo.toml": ["cargo build", "cargo test"],
  "pom.xml": ["mvn test", "mvn package"],
  "build.gradle": ["gradle build"],
  "build.gradle.kts": ["gradle build"],
  "pyproject.toml": ["python -m pytest"],
  "requirements.txt": ["python -m pytest"]
};

export type VcsInfo = { type: "git" | "svn" | "none"; root: string | null };
export type CommandRunner = (file: string, args: string[], cwd: string) => Promise<string>;

type RootRow = {
  id: string;
  path: string;
  real_path: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type ProjectRow = {
  id: string;
  name: string;
  path: string;
  real_path: string;
  root_path_id: string;
  vcs_type: VcsInfo["type"];
  vcs_root: string | null;
  profile_json: string | null;
  profile_updated_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  if (!(await stat(canonical)).isDirectory()) throw badRequest(`${path} is not a directory`);
  return canonical;
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const offset = relative(root, candidate);
  return offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}

export async function resolveWithinRoot(root: string, selected = "."): Promise<string> {
  const canonicalRoot = await canonicalDirectory(root);
  const candidate = await canonicalDirectory(resolve(canonicalRoot, selected));
  if (!isWithinRoot(canonicalRoot, candidate)) throw forbidden("Path escapes the enabled root");
  return candidate;
}

export async function browseDirectory(root: string, selected = ".") {
  const canonicalRoot = await canonicalDirectory(root);
  const directory = await resolveWithinRoot(canonicalRoot, selected);
  const entries = await Promise.all((await readdir(directory, { withFileTypes: true })).map(async (entry) => {
    const path = join(directory, entry.name);
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return undefined;
    const directoryEntry = entry.isDirectory() || await stat(path).then((value) => value.isDirectory(), () => false);
    if (!directoryEntry) return undefined;
    const selectable = await realpath(path).then((target) => isWithinRoot(canonicalRoot, target), () => false);
    return { name: entry.name, path: relative(canonicalRoot, path) || ".", symbolicLink: entry.isSymbolicLink(), selectable };
  }));
  return { path: relative(canonicalRoot, directory) || ".", entries: entries.filter((entry) => entry !== undefined).sort((left, right) => left.name.localeCompare(right.name)) };
}

export async function detectVcs(directory: string, runner: CommandRunner = execute): Promise<VcsInfo> {
  try {
    const root = await runner("git", ["rev-parse", "--show-toplevel"], directory);
    return { type: "git", root: await canonicalDirectory(root.trim()) };
  } catch {}

  try {
    const root = await runner("svn", ["info", "--show-item", "wc-root"], directory);
    return { type: "svn", root: await canonicalDirectory(root.trim()) };
  } catch {
    try {
      const info = await runner("svn", ["info"], directory);
      const root = /^Working Copy Root Path:\s*(.+)$/m.exec(info)?.[1]?.trim();
      if (root) return { type: "svn", root: await canonicalDirectory(root) };
    } catch {}
  }
  return { type: "none", root: null };
}

export async function scanProject(root: string, maxDepth = 4) {
  const canonicalRoot = await canonicalDirectory(root);
  const agentsFiles: string[] = [];
  const buildFiles: string[] = [];
  const suggestedCommands = new Set<string>();

  async function visit(directory: string, depth: number): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || SCAN_IGNORES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) await visit(path, depth + 1);
        continue;
      }
      const projectPath = relative(canonicalRoot, path);
      if (entry.name === "AGENTS.md" || entry.name === "AGENTS.override.md") agentsFiles.push(projectPath);
      if (entry.name === "package.json") {
        buildFiles.push(projectPath);
        try {
          const scripts = JSON.parse(await readFile(path, "utf8")).scripts as Record<string, unknown> | undefined;
          for (const name of Object.keys(scripts ?? {})) if (/^(build|test|check|lint)(:|$)/.test(name)) suggestedCommands.add(`npm run ${name}`);
        } catch {}
      }
      for (const command of BUILD_HINTS[entry.name] ?? []) {
        buildFiles.push(projectPath);
        suggestedCommands.add(command);
      }
      if (/\.sln$/i.test(entry.name)) {
        buildFiles.push(projectPath);
        suggestedCommands.add(`dotnet build ${projectPath}`);
      }
    }
  }

  await visit(canonicalRoot, 0);
  return { agentsFiles: [...new Set(agentsFiles)].sort(), buildFiles: [...new Set(buildFiles)].sort(), suggestedCommands: [...suggestedCommands].sort() };
}

export async function ensureWorkshopOwnership(projectRoot: string, installationId: string, projectId: string) {
  const root = await canonicalDirectory(projectRoot);
  const workshop = join(root, ".openworkshop");
  const ownerPath = join(workshop, ".owner.json");
  let created = false;
  try {
    await mkdir(workshop);
    created = true;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }

  const expected = { installation_id: installationId, project_id: projectId };
  const workshopInfo = await lstat(workshop).catch((error) => { throw conflict("Existing .openworkshop is not a regular directory", error); });
  if (workshopInfo.isSymbolicLink() || !workshopInfo.isDirectory()) throw conflict("Existing .openworkshop must not be a symbolic link and must be a directory");
  const workshopRealPath = await realpath(workshop);
  if (!isWithinRoot(root, workshopRealPath)) throw conflict("Existing .openworkshop escapes the project root");
  if (created) {
    try {
      await writeFile(ownerPath, `${JSON.stringify(expected, null, 2)}\n`, { flag: "wx" });
      return { path: workshop, created: true };
    } catch (error) {
      await rm(workshop, { recursive: false }).catch(() => undefined);
      throw error;
    }
  }

  const ownerInfo = await lstat(ownerPath).catch((error) => { throw conflict("Existing .openworkshop owner is missing", error); });
  if (ownerInfo.isSymbolicLink() || !ownerInfo.isFile()) throw conflict("Existing .openworkshop owner must be a non-symbolic regular file");
  if (!isWithinRoot(workshopRealPath, await realpath(ownerPath))) throw conflict("Existing .openworkshop owner escapes .openworkshop");
  let owner: unknown;
  try {
    owner = JSON.parse(await readFile(ownerPath, "utf8"));
  } catch (error) {
    throw conflict("Existing .openworkshop is not owned by OpenWorkshop", error);
  }
  if (!owner || typeof owner !== "object" || (owner as Record<string, unknown>).installation_id !== installationId || (owner as Record<string, unknown>).project_id !== projectId) {
    throw conflict("Existing .openworkshop owner does not match this installation and project");
  }
  return { path: workshop, created: false };
}

export function registerProjectRoutes(server: FastifyInstance, database: DatabaseSync): void {
  server.get("/api/roots", async () => database.prepare("SELECT * FROM root_paths ORDER BY path").all());

  server.post<{ Body: { path?: unknown; enabled?: unknown } }>("/api/roots", async (request, reply) => {
    const path = requiredString(request.body?.path, "path");
    if (request.body?.enabled !== undefined && typeof request.body.enabled !== "boolean") throw badRequest("enabled must be boolean");
    const realPath = await canonicalDirectory(path);
    const now = new Date().toISOString();
    const id = randomUUID();
    database.prepare("INSERT INTO root_paths (id, path, real_path, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, resolve(path), realPath, request.body?.enabled === false ? 0 : 1, now, now);
    return reply.code(201).send(database.prepare("SELECT * FROM root_paths WHERE id = ?").get(id));
  });

  server.put<{ Params: { id: string }; Body: { path?: unknown; enabled?: unknown } }>("/api/roots/:id", async (request) => {
    const current = rootById(database, request.params.id);
    const path = request.body?.path === undefined ? current.path : requiredString(request.body.path, "path");
    const realPath = await canonicalDirectory(path);
    const projects = database.prepare("SELECT real_path FROM projects WHERE root_path_id = ? AND archived_at IS NULL").all(current.id) as Array<{ real_path: string }>;
    if (projects.some((project) => !isWithinRoot(realPath, project.real_path))) throw conflict("The new root would exclude an associated project");
    const enabled = request.body?.enabled === undefined ? current.enabled : request.body.enabled === true ? 1 : request.body.enabled === false ? 0 : (() => { throw badRequest("enabled must be boolean"); })();
    transaction(database, () => {
      const lockedCurrent = rootById(database, current.id);
      if (lockedCurrent.enabled && !enabled) assertNoReservedRuns(database, "project.root_path_id = ?", current.id, "Root has reserved Runs and cannot be disabled");
      const now = new Date().toISOString();
      database.prepare("UPDATE root_paths SET path = ?, real_path = ?, enabled = ?, updated_at = ? WHERE id = ?")
        .run(resolve(path), realPath, enabled, now, current.id);
      if (!enabled) database.prepare(`UPDATE execution_grants SET status = 'revoked', revoked_at = ? WHERE status = 'active' AND commission_id IN (
        SELECT commission.id FROM commissions AS commission JOIN projects AS project ON project.id = commission.project_id WHERE project.root_path_id = ?
      )`).run(now, current.id);
    });
    return rootById(database, current.id);
  });

  server.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/roots/:id/browse", async (request) => {
    const root = enabledRootById(database, request.params.id);
    return browseDirectory(root.real_path, request.query.path);
  });

  server.get("/api/projects", async () => database.prepare("SELECT * FROM projects ORDER BY archived_at IS NOT NULL, name").all());

  server.post<{ Body: { name?: unknown; path?: unknown; rootPathId?: unknown } }>("/api/projects", async (request, reply) => {
    const name = limitedString(request.body?.name, "name", PROJECT_NAME_MAX_LENGTH);
    const path = requiredString(request.body?.path, "path");
    const root = enabledRootById(database, requiredString(request.body?.rootPathId, "rootPathId"));
    const realPath = await resolveWithinRoot(root.real_path, path);
    if (database.prepare("SELECT 1 FROM projects WHERE real_path = ? AND archived_at IS NULL").get(realPath)) throw conflict("Project is already associated");
    const archived = database.prepare("SELECT * FROM projects WHERE real_path = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC LIMIT 1").get(realPath) as ProjectRow | undefined;
    const vcs = await detectVcs(realPath);
    if (vcs.root && !isWithinRoot(root.real_path, vcs.root)) throw forbidden("VCS root escapes the enabled root");
    const id = archived?.id ?? randomUUID();
    await ensureWorkshopOwnership(realPath, installationId(database), id);
    const now = new Date().toISOString();
    if (archived) {
      database.prepare("UPDATE projects SET name = ?, path = ?, root_path_id = ?, vcs_type = ?, vcs_root = ?, archived_at = NULL, updated_at = ? WHERE id = ?")
        .run(name, resolve(realPath), root.id, vcs.type, vcs.root, now, id);
      return reply.send(projectById(database, id));
    }
    database.prepare("INSERT INTO projects (id, name, path, real_path, root_path_id, vcs_type, vcs_root, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, name, resolve(realPath), realPath, root.id, vcs.type, vcs.root, now, now);
    return reply.code(201).send(projectById(database, id));
  });

  server.get<{ Params: { id: string } }>("/api/projects/:id", async (request) => projectById(database, request.params.id));

  server.put<{ Params: { id: string }; Body: { name?: unknown } }>("/api/projects/:id", async (request) => {
    const project = activeProjectById(database, request.params.id);
    const name = limitedString(request.body?.name, "name", PROJECT_NAME_MAX_LENGTH);
    database.prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?").run(name, new Date().toISOString(), project.id);
    return projectById(database, project.id);
  });

  server.post<{ Params: { id: string } }>("/api/projects/:id/scan", async (request) => {
    const project = activeProjectById(database, request.params.id);
    const root = enabledRootById(database, project.root_path_id);
    await resolveWithinRoot(root.real_path, project.real_path);
    const profile = { vcs: await detectVcs(project.real_path), ...await scanProject(project.real_path) };
    if (profile.vcs.root && !isWithinRoot(root.real_path, profile.vcs.root)) throw forbidden("VCS root escapes the enabled root");
    const now = new Date().toISOString();
    database.prepare("UPDATE projects SET vcs_type = ?, vcs_root = ?, profile_json = ?, profile_updated_at = ?, updated_at = ? WHERE id = ?")
      .run(profile.vcs.type, profile.vcs.root, JSON.stringify(profile), now, now, project.id);
    return profile;
  });

  server.post<{ Params: { id: string } }>("/api/projects/:id/archive", async (request) => {
    const project = activeProjectById(database, request.params.id);
    transaction(database, () => {
      assertNoReservedRuns(database, "project.id = ?", project.id, "Project has reserved Runs and cannot be archived");
      const now = new Date().toISOString();
      database.prepare("UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, project.id);
      database.prepare(`UPDATE execution_grants SET status = 'revoked', revoked_at = ? WHERE status = 'active' AND commission_id IN (
        SELECT id FROM commissions WHERE project_id = ?
      )`).run(now, project.id);
    });
    return projectById(database, project.id);
  });
}

function assertNoReservedRuns(database: DatabaseSync, projectPredicate: string, value: string, message: string): void {
  const placeholders = RESERVED_RUN_STATUSES.map(() => "?").join(", ");
  const reserved = database.prepare(`SELECT 1 FROM runs AS run JOIN projects AS project ON project.id = run.project_id
    WHERE ${projectPredicate} AND run.status IN (${placeholders}) LIMIT 1`).get(value, ...RESERVED_RUN_STATUSES);
  if (reserved) throw conflict(message);
}

function transaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function execute(file: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await runFile(file, args, { cwd, encoding: "utf8", windowsHide: true });
  return stdout;
}

function installationId(database: DatabaseSync): string {
  const existing = database.prepare("SELECT value_json FROM settings WHERE key = 'installationId'").get() as { value_json: string } | undefined;
  if (existing) return JSON.parse(existing.value_json) as string;
  const id = randomUUID();
  database.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('installationId', ?, ?)").run(JSON.stringify(id), new Date().toISOString());
  return id;
}

function rootById(database: DatabaseSync, id: string): RootRow {
  const root = database.prepare("SELECT * FROM root_paths WHERE id = ?").get(id) as RootRow | undefined;
  if (!root) throw notFound("Root not found");
  return root;
}

function enabledRootById(database: DatabaseSync, id: string): RootRow {
  const root = rootById(database, id);
  if (!root.enabled) throw forbidden("Root is disabled");
  return root;
}

function projectById(database: DatabaseSync, id: string): ProjectRow {
  const project = database.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  if (!project) throw notFound("Project not found");
  return project;
}

function activeProjectById(database: DatabaseSync, id: string): ProjectRow {
  const project = projectById(database, id);
  if (project.archived_at) throw conflict("Project is archived");
  return project;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${name} must be a non-empty string`);
  return value.trim();
}

function limitedString(value: unknown, name: string, maxLength: number): string {
  const result = requiredString(value, name);
  if (result.length > maxLength) throw badRequest(`${name} must be at most ${maxLength} characters`);
  return result;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function statusError(message: string, statusCode: number, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { statusCode });
}

const badRequest = (message: string) => statusError(message, 400);
const forbidden = (message: string) => statusError(message, 403);
const notFound = (message: string) => statusError(message, 404);
const conflict = (message: string, cause?: unknown) => statusError(message, 409, cause);
