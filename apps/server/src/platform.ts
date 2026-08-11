import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

const DATA_DIRECTORIES = ["attachments", "logs", "backups", "runtime"];
const STATE_FILE = "workshop.json";
const STOP_FILE = "stop.request";

export type RuntimeState = { pid: number; host: string; port: number; startedAt: string };

export function getWorkshopHome(env = process.env, platform = process.platform, userHome = homedir()): string {
  if (env.WORKSHOP_HOME) return env.WORKSHOP_HOME;
  if (platform === "win32") return win32.join(env.APPDATA ?? win32.join(userHome, "AppData", "Roaming"), "OpenWorkshop");
  if (platform === "darwin") return posix.join(userHome, "Library", "Application Support", "OpenWorkshop");
  return posix.join(env.XDG_DATA_HOME ?? posix.join(userHome, ".local", "share"), "OpenWorkshop");
}

export async function prepareWorkshopHome(root = getWorkshopHome()): Promise<string> {
  await mkdir(root, { recursive: true });
  await Promise.all(DATA_DIRECTORIES.map((directory) => mkdir(join(root, directory), { recursive: true })));
  if (process.platform !== "win32") await chmod(join(root, "runtime"), 0o700);
  return root;
}

export async function acquireInstanceLock(root: string, isAlive: (pid: number) => boolean = processIsAlive): Promise<() => Promise<void>> {
  const lockPath = join(root, "runtime", "workshop.lock");
  const recoveryPath = join(root, "runtime", "workshop.lock.recovery");
  const ownerToken = randomUUID();
  await createLockDirectory(lockPath, recoveryPath, root, isAlive, ownerToken);
  return async () => {
    const owner = await readLockOwner(lockPath);
    if (owner?.token === ownerToken) await rm(lockPath, { recursive: true, force: true });
  };
}

async function createLockDirectory(lockPath: string, recoveryPath: string, root: string, isAlive: (pid: number) => boolean, ownerToken: string): Promise<void> {
  await clearStaleRecovery(recoveryPath, root, isAlive);
  try {
    await mkdir(lockPath, { mode: 0o700 });
    if (await pathExists(recoveryPath)) {
      await rm(lockPath, { recursive: true, force: true });
      throw new Error(`OpenWorkshop is recovering an instance lock for ${root}`);
    }
    await writeFile(join(lockPath, "owner"), `${process.pid}\n${ownerToken}\n`, { flag: "wx", mode: 0o600 });
    return;
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
  }

  const observed = await readLockOwner(lockPath);
  if (!observed || isAlive(observed.pid)) throw new Error(`OpenWorkshop is already using ${root}`);

  const recoveryToken = randomUUID();
  await acquireRecoveryClaim(recoveryPath, root, isAlive, recoveryToken);

  try {
    const recoveryOwner = await readLockOwner(recoveryPath);
    if (recoveryOwner?.token !== recoveryToken) throw new Error(`OpenWorkshop lost its instance lock recovery claim for ${root}`);
    const claimed = await readLockOwner(lockPath);
    if (!claimed || claimed.pid !== observed.pid || claimed.token !== observed.token || isAlive(claimed.pid)) {
      throw new Error(`OpenWorkshop is already using ${root}`);
    }
    await rm(lockPath, { recursive: true, force: true });
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(join(lockPath, "owner"), `${process.pid}\n${ownerToken}\n`, { flag: "wx", mode: 0o600 });
  } finally {
    const recoveryOwner = await readLockOwner(recoveryPath);
    if (recoveryOwner?.token === recoveryToken) await rm(recoveryPath, { recursive: true, force: true });
  }
}

async function acquireRecoveryClaim(recoveryPath: string, root: string, isAlive: (pid: number) => boolean, token: string): Promise<void> {
  const temporaryPath = `${recoveryPath}.${token}.tmp`;
  await mkdir(temporaryPath, { mode: 0o700 });
  try {
    await writeFile(join(temporaryPath, "owner"), `${process.pid}\n${token}\n`, { flag: "wx", mode: 0o600 });
    try {
      await rename(temporaryPath, recoveryPath);
      return;
    } catch (error) {
      if (!isFileExistsError(error) && !hasCode(error, "ENOTEMPTY")) throw error;
    }
  } finally {
    await rm(temporaryPath, { recursive: true, force: true });
  }
  await clearStaleRecovery(recoveryPath, root, isAlive);
  throw new Error(`OpenWorkshop is already recovering a stale instance lock for ${root}`);
}

async function clearStaleRecovery(recoveryPath: string, root: string, isAlive: (pid: number) => boolean): Promise<void> {
  const owner = await readLockOwner(recoveryPath);
  if (!owner) {
    if (await pathExists(recoveryPath)) await rm(recoveryPath, { recursive: true, force: true });
    return;
  }
  if (isAlive(owner.pid)) throw new Error(`OpenWorkshop is already recovering a stale instance lock for ${root}`);
  await rm(recoveryPath, { recursive: true, force: true });
}

async function readLockOwner(path: string): Promise<{ pid: number; token: string | undefined } | undefined> {
  try {
    const info = await stat(path);
    const value = (await readFile(info.isDirectory() ? join(path, "owner") : path, "utf8")).trim().split(/\r?\n/);
    if (!/^\d+$/.test(value[0] ?? "")) return undefined;
    const pid = Number(value[0]);
    return Number.isSafeInteger(pid) && pid > 0 ? { pid, token: value[1] } : undefined;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, (error: unknown) => {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  });
}

export async function writeRuntimeState(root: string, state: RuntimeState): Promise<void> {
  const runtime = join(root, "runtime");
  const temporary = join(runtime, `${STATE_FILE}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, join(runtime, STATE_FILE));
}

export async function readRuntimeState(root: string, isAlive: (pid: number) => boolean = processIsAlive): Promise<RuntimeState | undefined> {
  try {
    const state = JSON.parse(await readFile(join(root, "runtime", STATE_FILE), "utf8")) as RuntimeState;
    if (!Number.isInteger(state.pid) || state.pid < 1 || typeof state.host !== "string" || !Number.isInteger(state.port) || typeof state.startedAt !== "string") return undefined;
    return isAlive(state.pid) ? state : undefined;
  } catch (error) {
    if (hasCode(error, "ENOENT") || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export async function requestRuntimeStop(root: string): Promise<RuntimeState> {
  const state = await readRuntimeState(root);
  if (!state) throw new Error("OpenWorkshop is not running");
  await writeFile(join(root, "runtime", STOP_FILE), "stop\n", { mode: 0o600 });
  return state;
}

export async function consumeRuntimeStop(root: string): Promise<boolean> {
  const path = join(root, "runtime", STOP_FILE);
  try {
    const requested = (await readFile(path, "utf8")).trim() === "stop";
    await rm(path, { force: true });
    return requested;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

export async function clearRuntimeState(root: string): Promise<void> {
  await Promise.all([rm(join(root, "runtime", STATE_FILE), { force: true }), rm(join(root, "runtime", STOP_FILE), { force: true })]);
}

export async function pruneLogFiles(directory: string, retentionDays: number, now = Date.now()): Promise<number> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new TypeError("logRetentionDays must be a positive integer");
  const cutoff = now - retentionDays * 86_400_000;
  const entries = await readdir(directory, { withFileTypes: true });
  const expired = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => ({ path: join(directory, entry.name), modified: (await stat(join(directory, entry.name))).mtimeMs })));
  await Promise.all(expired.filter((entry) => entry.modified < cutoff).map((entry) => rm(entry.path, { force: true })));
  return expired.filter((entry) => entry.modified < cutoff).length;
}

export async function readLatestLog(directory: string, lines = 100): Promise<{ path: string; content: string }> {
  if (!Number.isInteger(lines) || lines < 1) throw new TypeError("lines must be a positive integer");
  const name = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^workshop-\d{4}-\d{2}-\d{2}\.log$/.test(entry.name))
    .map((entry) => entry.name).sort().at(-1);
  if (!name) throw new Error("No OpenWorkshop logs found");
  const path = join(directory, name);
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    let position = size;
    let needed = lines;
    let newlines = 0;
    const chunks: Buffer[] = [];
    while (position > 0 && newlines < needed) {
      const length = Math.min(64 * 1024, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      const chunk = buffer.subarray(0, bytesRead);
      if (!chunks.length && chunk.at(-1) === 10) needed += 1;
      for (const byte of chunk) if (byte === 10) newlines += 1;
      chunks.unshift(chunk);
    }
    const data = Buffer.concat(chunks);
    if (newlines < needed) return { path, content: data.toString("utf8") };
    for (let index = data.length - 1, remaining = needed; index >= 0; index -= 1) {
      if (data[index] === 10 && --remaining === 0) return { path, content: data.subarray(index + 1).toString("utf8") };
    }
    return { path, content: data.toString("utf8") };
  } finally {
    await handle.close();
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
