import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireInstanceLock, clearRuntimeState, consumeRuntimeStop, getWorkshopHome, prepareWorkshopHome, pruneLogFiles, readLatestLog, readRuntimeState, requestRuntimeStop, writeRuntimeState } from "./platform.ts";

test("uses the target platform's path rules", () => {
  assert.equal(getWorkshopHome({ APPDATA: "C:\\Users\\tester\\AppData\\Roaming" }, "win32", "C:\\Users\\tester"), "C:\\Users\\tester\\AppData\\Roaming\\OpenWorkshop");
  assert.equal(getWorkshopHome({}, "darwin", "/Users/tester"), "/Users/tester/Library/Application Support/OpenWorkshop");
  assert.equal(getWorkshopHome({ XDG_DATA_HOME: "/data/tester" }, "linux", "/home/tester"), "/data/tester/OpenWorkshop");
});

test("recovers a stale instance lock and fails closed for active or concurrent locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-workshop-"));
  try {
    await prepareWorkshopHome(root);
    const lockPath = join(root, "runtime", "workshop.lock");
    await writeFile(lockPath, "2147483647");
    const concurrentResults = await Promise.allSettled(Array.from({ length: 32 }, () => acquireInstanceLock(root, (pid) => pid === process.pid)));
    const acquired = concurrentResults.filter((result) => result.status === "fulfilled");
    assert.equal(acquired.length, 1);
    assert.equal((await readFile(join(lockPath, "owner"), "utf8")).split(/\r?\n/, 1)[0], String(process.pid));
    await assert.rejects(acquireInstanceLock(root, () => true), /already using/);
    if (acquired[0]?.status === "fulfilled") await acquired[0].value();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers a stale or incomplete instance-lock recovery claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-workshop-recovery-"));
  try {
    await prepareWorkshopHome(root);
    const lockPath = join(root, "runtime", "workshop.lock");
    const recoveryPath = join(root, "runtime", "workshop.lock.recovery");
    await writeFile(lockPath, "2147483647");
    await mkdir(recoveryPath);
    await writeFile(join(recoveryPath, "owner"), "2147483646\nstale-token\n");
    const release = await acquireInstanceLock(root, (pid) => pid === process.pid);
    assert.equal(await readFileExists(recoveryPath), false);
    await release();

    await writeFile(lockPath, "2147483647");
    await mkdir(recoveryPath);
    const releaseIncomplete = await acquireInstanceLock(root, (pid) => pid === process.pid);
    assert.equal(await readFileExists(recoveryPath), false);
    await releaseIncomplete();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses portable runtime control files and prunes expired logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-workshop-runtime-"));
  try {
    await prepareWorkshopHome(root);
    const state = { pid: process.pid, host: "127.0.0.1", port: 8787, startedAt: new Date().toISOString() };
    await writeRuntimeState(root, state);
    assert.deepEqual(await readRuntimeState(root), state);
    assert.doesNotMatch(await readFile(join(root, "runtime", "workshop.json"), "utf8"), /token|secret/i);
    assert.equal((await requestRuntimeStop(root)).pid, process.pid);
    if (process.platform !== "win32") assert.equal((await stat(join(root, "runtime", "stop.request"))).mode & 0o777, 0o600);
    assert.equal(await consumeRuntimeStop(root), true);
    assert.equal(await consumeRuntimeStop(root), false);
    assert.equal(await readRuntimeState(root, () => false), undefined);
    if (process.platform !== "win32") {
      assert.equal((await stat(join(root, "runtime"))).mode & 0o777, 0o700);
      assert.equal((await stat(join(root, "runtime", "workshop.json"))).mode & 0o777, 0o600);
    }

    const oldLog = join(root, "logs", "old.log");
    const currentLog = join(root, "logs", "current.log");
    await Promise.all([writeFile(oldLog, "old"), writeFile(currentLog, "current")]);
    await utimes(oldLog, new Date(0), new Date(0));
    assert.equal(await pruneLogFiles(join(root, "logs"), 90), 1);
    assert.equal(await readFileExists(oldLog), false);
    assert.equal(await readFileExists(currentLog), true);
    await clearRuntimeState(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads the requested tail of the latest Workshop log", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-workshop-log-"));
  try {
    await prepareWorkshopHome(root);
    await writeFile(join(root, "logs", "workshop-2026-08-08.log"), "old\n");
    const latest = join(root, "logs", "workshop-2026-08-09.log");
    await writeFile(latest, "first\n中文\nlast\n");
    assert.deepEqual(await readLatestLog(join(root, "logs"), 2), { path: latest, content: "中文\nlast\n" });
    await assert.rejects(readLatestLog(join(root, "logs"), 0), /positive integer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function readFileExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}
