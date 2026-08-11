import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browserCommand, startBackgroundService, waitForServiceStop } from "./service-control.ts";

test("uses each platform's native browser opener", () => {
  assert.deepEqual(browserCommand("http://127.0.0.1:8787", "darwin"), ["open", ["http://127.0.0.1:8787"]]);
  assert.deepEqual(browserCommand("http://127.0.0.1:8787", "win32"), ["rundll32.exe", ["url.dll,FileProtocolHandler", "http://127.0.0.1:8787"]]);
  assert.deepEqual(browserCommand("http://127.0.0.1:8787", "linux"), ["xdg-open", ["http://127.0.0.1:8787"]]);
});

test("starts a detached service and observes when it stops", async () => {
  const root = await mkdtemp(join(tmpdir(), "workshop-service-"));
  const cli = join(root, "fake-cli.mjs");
  let pid: number | undefined;
  try {
    await mkdir(join(root, "runtime"));
    await writeFile(cli, `import { rm, writeFile } from "node:fs/promises";\nconst root = process.env.WORKSHOP_HOME;\nconst host = process.argv[process.argv.indexOf("--host") + 1];\nconst port = Number(process.argv[process.argv.indexOf("--port") + 1]);\nawait writeFile(root + "/runtime/workshop.lock", String(process.pid));\nawait writeFile(root + "/runtime/workshop.json", JSON.stringify({ pid: process.pid, host, port, startedAt: new Date().toISOString() }));\nprocess.on("SIGTERM", async () => { await Promise.all([rm(root + "/runtime/workshop.lock"), rm(root + "/runtime/workshop.json")]); process.exit(); });\nsetInterval(() => {}, 1000);\n`);
    const state = await startBackgroundService(root, cli, "127.0.0.1", 9876, 2_000);
    pid = state.pid;
    assert.equal(state.port, 9876);
    process.kill(pid, "SIGTERM");
    await waitForServiceStop(root, 2_000);
  } finally {
    if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test("ignores dead or incomplete stale locks but waits for an active owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "workshop-stale-stop-"));
  const lock = join(root, "runtime", "workshop.lock");
  try {
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner"), "2147483647\nstale-token\n");
    await waitForServiceStop(root, 100, () => false);

    await writeFile(join(lock, "owner"), `${process.pid}\nactive-token\n`);
    await assert.rejects(waitForServiceStop(root, 100, (pid) => pid === process.pid), /Timed out waiting/);

    await rm(join(lock, "owner"));
    await waitForServiceStop(root, 100, () => true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
