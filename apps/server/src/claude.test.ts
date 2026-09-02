import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { checkClaudeHealth, CLAUDE_MIN_VERSION, claudePermissionMode, claudePrompt, createClaudeCodePlugin, executeClaudeCommand, normalizeClaudeEvent, resolveClaudeCommand, validateClaudeConfig } from "./claude.ts";

test("normalizes Claude Code JSONL events at the plugin boundary", () => {
  assert.equal(normalizeClaudeEvent({ type: "system", session_id: "s1" }).type, "session.started");
  assert.equal(normalizeClaudeEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "hello" } } }).text, "hello");
  assert.equal(normalizeClaudeEvent({ type: "assistant", message: { content: [{ type: "text", text: "final answer" }] } }).text, "final answer");
  assert.deepEqual(normalizeClaudeEvent({ type: "result", subtype: "success", result: "done", usage: { input_tokens: 10, output_tokens: 4 } }).tokenUsage, { input: 10, output: 4, cached: 0 });
  assert.deepEqual(normalizeClaudeEvent({ type: "result", subtype: "success", result: "done", usage: { input_tokens: 2, cache_creation_input_tokens: 1_809, cache_read_input_tokens: 130_024, output_tokens: 187 } }).tokenUsage, { input: 131_835, output: 187, cached: 130_024 });
});

test("rejects an explicit Windows Claude command shim", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "project-workshop-claude-command-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const command = join(root, "claude.cmd");
  await writeFile(command, "@echo off\r\n");
  if (process.platform === "win32") assert.throws(() => resolveClaudeCommand({ WORKSHOP_CLAUDE_CODE_PATH: command }), /does not support/);
  else assert.equal(resolveClaudeCommand({ WORKSHOP_CLAUDE_CODE_PATH: command }), command);
});

test("validates Claude Code backend options", () => {
  validateClaudeConfig({ model: "claude-sonnet", backendOptions: { customArgs: ["--enable", "feature_name"] } });
  assert.throws(() => validateClaudeConfig({ backendOptions: { customArgs: ["--model", "other"] } }), /conflicts/);
  for (const argument of ["--settings", "--setting-sources", "--allowedTools", "--allowed-tools", "--tools", "--add-dir", "--mcp-config", "--plugin-dir", "--agents", "--agent", "--system-prompt", "--append-system-prompt", "--permission-mode", "-r", "--worktree", "-w", "--cloud", "--environment", "--exec", "--remote", "--remote-control", "--bg", "--chrome", "--dangerously-skip-permissions", "--restricted", "--safe-mode", "--bare"]) assert.throws(() => validateClaudeConfig({ backendOptions: { customArgs: [argument] } }), /conflicts/);
  assert.throws(() => validateClaudeConfig({ backendOptions: { customArgs: ["--resume=other-session"] } }), /conflicts/);
  assert.throws(() => validateClaudeConfig({ backendOptions: { endpoint: "private" } }), /Unsupported/);
});

test("maps Claude input and managed safety settings", () => {
  assert.match(claudePrompt({ prompt: "fallback", input: [{ type: "text", text: "user text" }, { type: "localImage", path: "C:/run/image.png" }] }), /user text/);
  assert.match(claudePrompt({ prompt: "fallback", input: [{ type: "text", text: "user text" }, { type: "localImage", path: "C:/run/image.png" }] }), /C:\/run\/image\.png/);
  assert.equal(claudePermissionMode("workspace-write", "never"), "dontAsk");
  assert.equal(claudePermissionMode("workspace-write", "untrusted"), "manual");
});

test("reports Claude Code health from its version command", async () => {
  const healthy = await checkClaudeHealth({ runCommand: async (_file, args) => { assert.deepEqual(args, ["--version"]); return "Claude Code 2.1.10"; } });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.runtimeVersion, "2.1.10");
  assert.equal(healthy.capabilities.ok, true);
  assert.deepEqual(healthy.capabilities.models.map((model) => model.id), ["sonnet", "opus", "haiku"]);
  assert.deepEqual(healthy.capabilities.reasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
  const invalid = await checkClaudeHealth({ runCommand: async () => "Claude Code unknown" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.capabilities.ok, false);
  assert.deepEqual(invalid.capabilities.models, []);
  assert.deepEqual(invalid.capabilities.reasoningEfforts, []);
  assert.equal(CLAUDE_MIN_VERSION, "2.0.0");
});

test("registers Claude Code with explicit unsupported capabilities", () => {
  const plugin = createClaudeCodePlugin(async () => ({ id: "claude-code", ok: true, pluginVersion: "test", capabilities: { ok: true, models: [], reasoningEfforts: [] } }));
  assert.doesNotThrow(() => plugin.createSession({ networkAccess: false }));
  assert.equal(plugin.id, "claude-code");
  assert.equal(plugin.capabilities.steering, false);
  assert.equal(plugin.capabilities.approvals, false);
});

test("returns a Claude turn handle before process exit and interrupts the active process", async (context) => {
  const child = fakeClaudeProcess();
  const session = createClaudeCodePlugin(undefined, (() => child) as typeof spawn).createSession({});
  context.after(() => session.close().catch(() => undefined));

  const turn = await Promise.race([session.start({ cwd: process.cwd(), prompt: "wait" }), delay(2_000).then(() => { throw new Error("Claude start did not return"); })]);
  let settled = false;
  void turn.completed.then(() => { settled = true; });
  await delay(50);
  assert.equal(settled, false);
  await session.interrupt();
  assert.equal((await turn.completed).status, "interrupted");
});

test("reports cumulative standardized token usage across resumed Claude turns", async () => {
  const children: ChildProcess[] = [];
  const session = createClaudeCodePlugin(undefined, (() => { const child = fakeClaudeProcess(); children.push(child); return child; }) as typeof spawn).createSession({});
  const first = await session.start({ cwd: process.cwd(), prompt: "first" });
  const firstChild = children[0]!;
  writeClaudeResult(firstChild, { input_tokens: 2, cache_creation_input_tokens: 8, cache_read_input_tokens: 90, output_tokens: 4 });
  firstChild.stdout!.end();
  firstChild.emit("exit", 0, null);
  assert.deepEqual((await first.completed).event.tokenUsage, { input: 100, output: 4, cached: 90 });
  const second = await session.continue({ cwd: process.cwd(), prompt: "second" });
  const secondChild = children[1]!;
  writeClaudeResult(secondChild, { input_tokens: 3, cache_creation_input_tokens: 7, cache_read_input_tokens: 110, output_tokens: 5 });
  secondChild.stdout!.end();
  secondChild.emit("exit", 0, null);
  assert.deepEqual((await second.completed).event.tokenUsage, { input: 220, output: 9, cached: 200 });
});

test("drains Claude stdout after process exit before completing the turn", async () => {
  const child = fakeClaudeProcess();
  const session = createClaudeCodePlugin(undefined, (() => child) as typeof spawn).createSession({});
  const turn = await session.start({ cwd: process.cwd(), prompt: "finish" });

  child.emit("exit", 0, null);
  writeClaudeResult(child, { input_tokens: 3, output_tokens: 2 });
  child.stdout!.end();

  const completion = await turn.completed;
  assert.equal(completion.status, "succeeded");
  assert.equal(completion.event.type, "turn.completed");
  assert.deepEqual(completion.event.tokenUsage, { input: 3, output: 2, cached: 0 });
});

test("terminates a Claude version process when health checking times out", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workshop-claude-health-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const pidPath = join(directory, "pid.txt");
  const runner = join(directory, "runner.cjs");
  await writeFile(runner, `require("node:fs").writeFileSync(process.env.WORKSHOP_CLAUDE_TEST_PID, String(process.pid));\nsetInterval(() => undefined, 1000);\n`);
  await assert.rejects(executeClaudeCommand(process.execPath, [runner], 500, { ...process.env, WORKSHOP_CLAUDE_TEST_PID: pidPath }), /Timed out after 500 ms/);
  const pid = Number(await readFile(pidPath, "utf8"));
  assert.equal(processExists(pid), false);
});

function fakeClaudeProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: null, stdio: [], pid: undefined, connected: false, killed: false, exitCode: null, signalCode: null,
    kill(signal = "SIGTERM") {
      child.killed = true;
      queueMicrotask(() => { child.signalCode = signal as NodeJS.Signals; child.emit("exit", null, signal); });
      return true;
    }
  });
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

function writeClaudeResult(child: ChildProcess, usage: Record<string, number>): void {
  child.stdout!.write(`${JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: "session", usage })}\n`);
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
