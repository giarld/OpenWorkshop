import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentRegistry } from "./agent.ts";
import {
  COMMAND_APPROVAL_POLICY,
  CODEX_APP_SERVER_ARGS,
  codexAppServerArgs,
  codexAgentCompletion,
  codexAgentEvent,
  checkCodexHealth,
  CodexAppServer,
  CodexAppServerClosedError,
  createCodexPlugin,
  resolveInvocation,
  normalizeCodexEvent,
  snapshotRoleConfig,
  validateCodexConfig,
  validateCustomArgs,
  type NormalizedCodexEvent
} from "./codex.ts";
import { createRunContext, recoverRunContexts } from "./run-context.ts";

test("keeps destructive commands behind approval and separates user input events", () => {
  assert.equal(COMMAND_APPROVAL_POLICY, "on-request");
  assert.deepEqual(CODEX_APP_SERVER_ARGS, ["app-server", "-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"', "-c", "sandbox_workspace_write.network_access=true"]);
  assert.deepEqual(codexAppServerArgs("read-only", false), ["app-server", "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"']);
  assert.equal(normalizeCodexEvent("item/tool/requestUserInput", { questions: [] }, "input-1").type, "input.requested");
  assert.equal(normalizeCodexEvent("item/commandExecution/requestApproval", { command: "rm -rf target" }, "approval-1").type, "approval.requested");
  assert.equal(normalizeCodexEvent("mcpServer/elicitation/request", { _meta: { codex_request_type: "approval_request" } }, 0).type, "approval.requested");
});

test("fails closed for incomplete or unknown Codex Turn statuses", () => {
  for (const [status, type, completion] of [
    ["completed", "turn.completed", "succeeded"],
    ["interrupted", "turn.interrupted", "interrupted"],
    ["failed", "turn.failed", "failed"],
    ["inProgress", "turn.failed", "failed"],
    ["cancelled", "turn.failed", "failed"],
    ["", "turn.failed", "failed"],
    [undefined, "turn.failed", "failed"]
  ] as const) {
    const event = normalizeCodexEvent("turn/completed", { turn: status === undefined ? {} : { status } });
    assert.equal(event.type, type);
    assert.equal(codexAgentCompletion(event).status, completion);
  }
  assert.match(normalizeCodexEvent("turn/completed", { turn: { status: "cancelled" } }).summary, /unexpected status cancelled/);
});

const FAKE_APP_SERVER = String.raw`
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (process.env.FAKE_CRASH && message.method === "initialize") return process.exit(7);
  if (message.method === "initialize") {
    const stderrBytes = Number(process.env.FAKE_STDERR_BYTES ?? 0);
    if (stderrBytes) return process.stderr.write(Buffer.alloc(stderrBytes, 120), () => send({ id: message.id, result: { userAgent: "fake" } }));
    return send({ id: message.id, result: { userAgent: "fake" } });
  }
  if (message.method === "initialized") return;
  if (message.method === "model/list") return process.env.FAKE_MODEL_LIST_FAILURE ? send({ id: message.id, error: { message: "model discovery failed" } }) : send({ id: message.id, result: { data: [{ id: "fake-model", displayName: "Fake", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }], isDefault: true }, ...(message.params.includeHidden ? [{ id: "opencodex/custom-model", displayName: "OpenCodex Custom" }] : [])] } });
  if (message.method === "thread/start") {
    if (!["read-only", "workspace-write", "danger-full-access"].includes(message.params.sandbox)) return send({ id: message.id, error: { message: "invalid sandbox" } });
    send({ id: message.id, result: { thread: { id: "thread-1" } } });
    return send({ method: "thread/started", params: { thread: { id: "thread-1" } } });
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
    send({ method: "turn/started", params: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "working" } });
    return send(process.env.FAKE_MCP_APPROVAL
      ? { id: 0, method: "mcpServer/elicitation/request", params: { threadId: "thread-1", turnId: "turn-1", serverName: "computer-use", mode: "form", message: "Allow Computer Use?", requestedSchema: { type: "object", properties: {} }, _meta: { codex_request_type: "approval_request", codex_approval_kind: "mcp_tool_call" } } }
      : process.env.FAKE_UNKNOWN_APPROVAL
      ? { id: "unknown-1", method: "item/future/requestApproval", params: { threadId: "thread-1", turnId: "turn-1" } }
      : { id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "command-1", command: "npm test" } });
  }
  if (message.id === 0) {
    send({ method: "test/mcpApprovalResponse", params: message.result });
    return send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed", items: [] } } });
  }
  if (message.id === "unknown-1") {
    send({ method: "test/unknownApprovalResponse", params: message.result });
    return send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "interrupted", items: [] } } });
  }
  if (message.id === "approval-1") return send({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: "approval-1" } });
  if (message.method === "turn/steer") return send({ id: message.id, result: { turnId: "turn-1" } });
  if (message.method === "turn/interrupt") {
    if (process.env.FAKE_IGNORE_INTERRUPT_RPC) return;
    if (process.env.FAKE_REJECT_INTERRUPT) return send({ id: message.id, error: { message: "interrupt rejected" } });
    send({ id: message.id, result: {} });
    if (process.env.FAKE_IGNORE_INTERRUPT) return;
    return send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "interrupted", items: [] } } });
  }
});
`;

function launch(overrides: {
  crash?: boolean;
  ignoreInterrupt?: boolean;
  ignoreInterruptRpc?: boolean;
  rejectInterrupt?: boolean;
  stderrBytes?: number;
  unknownApproval?: boolean;
  mcpApproval?: boolean;
  modelListFailure?: boolean;
  requestTimeoutMs?: number;
  onEvent?: (event: NormalizedCodexEvent) => void;
  onApproval?: (event: NormalizedCodexEvent, respond: (decision: unknown) => void) => void;
} = {}) {
  return CodexAppServer.launch({
    command: process.execPath,
    args: ["-e", FAKE_APP_SERVER],
    env: {
      ...process.env,
      ...(overrides.crash ? { FAKE_CRASH: "1" } : {}),
      ...(overrides.ignoreInterrupt ? { FAKE_IGNORE_INTERRUPT: "1" } : {}),
      ...(overrides.ignoreInterruptRpc ? { FAKE_IGNORE_INTERRUPT_RPC: "1" } : {}),
      ...(overrides.rejectInterrupt ? { FAKE_REJECT_INTERRUPT: "1" } : {}),
      ...(overrides.stderrBytes ? { FAKE_STDERR_BYTES: String(overrides.stderrBytes) } : {}),
      ...(overrides.unknownApproval ? { FAKE_UNKNOWN_APPROVAL: "1" } : {}),
      ...(overrides.mcpApproval ? { FAKE_MCP_APPROVAL: "1" } : {}),
      ...(overrides.modelListFailure ? { FAKE_MODEL_LIST_FAILURE: "1" } : {})
    },
    ...(overrides.requestTimeoutMs ? { requestTimeoutMs: overrides.requestTimeoutMs } : {}),
    ...(overrides.onEvent ? { onEvent: overrides.onEvent } : {}),
    ...(overrides.onApproval ? { onApproval: overrides.onApproval } : {})
  });
}

test("streams a fake Run through approval, steer, and interrupt", async () => {
  const events: NormalizedCodexEvent[] = [];
  let approval: NormalizedCodexEvent | undefined;
  const client = launch({
    onEvent: (event) => events.push(event),
    onApproval: (event: NormalizedCodexEvent, respond: (decision: unknown) => void) => {
      approval = event;
      respond({ decision: "accept" });
    }
  });
  try {
    await client.initialize();
    assert.deepEqual((await client.models()).map((model) => model.id), ["fake-model", "opencodex/custom-model"]);
    const run = await client.startRun({ cwd: process.cwd(), prompt: "Do the work", model: "fake-model", effort: "medium" });
    assert.equal(run.model, "fake-model");
    await client.steer(run.threadId, run.turnId, [{ type: "text", text: "Focus on tests" }, { type: "localImage", path: join(process.cwd(), "screenshot.png") }]);
    await client.interrupt(run.threadId, run.turnId);
    assert.equal((await run.completed).type, "turn.interrupted");
    assert.equal(approval?.type, "approval.requested");
    assert.ok(events.some((event) => event.type === "agent.message.delta"));
    assert.ok(events.some((event) => event.type === "request.resolved"));
  } finally {
    await client.close();
  }
});

test("adapts MCP tool approval responses to the elicitation protocol", async () => {
  const events: NormalizedCodexEvent[] = [];
  const client = launch({
    mcpApproval: true,
    onEvent: (event) => events.push(event),
    onApproval: (_event, respond) => respond({ decision: "accept" })
  });
  try {
    await client.initialize();
    const run = await client.startRun({ cwd: process.cwd(), prompt: "Use Computer Use" });
    assert.equal(run.model, undefined);
    assert.equal((await run.completed).type, "turn.completed");
    assert.deepEqual(events.find((event) => event.method === "test/mcpApprovalResponse")?.payload, { action: "accept", content: {} });
  } finally {
    await client.close();
  }
});

test("reuses an existing thread for a later turn", async () => {
  const events: NormalizedCodexEvent[] = [];
  const client = launch({
    onEvent: (event) => events.push(event),
    onApproval: (_event, respond) => respond({ decision: "accept" })
  });
  try {
    await client.initialize();
    const first = await client.startRun({ cwd: process.cwd(), prompt: "First turn" });
    await client.interrupt(first.threadId, first.turnId);
    await first.completed;
    const second = await client.startRun({ cwd: process.cwd(), prompt: "Second turn", threadId: first.threadId });
    await client.interrupt(second.threadId, second.turnId);
    await second.completed;
    assert.equal(events.filter((event) => event.type === "thread.started").length, 1);
  } finally {
    await client.close();
  }
});

test("cancels unknown approval requests and emits a protocol error", async () => {
  const events: NormalizedCodexEvent[] = [];
  const client = launch({ unknownApproval: true, onEvent: (event) => events.push(event) });
  try {
    await client.initialize();
    const run = await client.startRun({ cwd: process.cwd(), prompt: "Do the work" });
    await run.completed;
    assert.deepEqual(events.find((event) => event.method === "test/unknownApprovalResponse")?.payload, { decision: "cancel" });
    assert.ok(events.some((event) => event.type === "approval.error" && event.method === "item/future/requestApproval"));
  } finally {
    await client.close();
  }
});

test("reports health and fails pending RPC calls when the child exits", async () => {
  const health = await checkCodexHealth({ runCommand: async () => "codex-cli 0.147.0", launch });
  assert.equal(health.ok, true);
  assert.equal(health.version, "0.147.0");
  assert.equal(health.models?.[0]?.defaultReasoningEffort, "medium");

  const crashed = launch({ crash: true });
  await assert.rejects(crashed.initialize(), /exited unexpectedly/);
  await crashed.close();
});

test("starts with the Codex default model when model discovery is unavailable", async () => {
  const client = launch({ modelListFailure: true, onApproval: (_event, respond) => respond({ decision: "accept" }) });
  try {
    await client.initialize();
    const run = await client.startRun({ cwd: process.cwd(), prompt: "Use the backend default" });
    assert.equal(run.model, undefined);
    await client.interrupt(run.threadId, run.turnId);
    await run.completed;
  } finally { await client.close(); }
});

test("normalizes Codex private event fields at the plugin boundary", () => {
  assert.equal(codexAgentEvent(normalizeCodexEvent("item/agentMessage/delta", { delta: "hello" }, "message")).text, "hello");
  assert.equal(codexAgentEvent(normalizeCodexEvent("item/completed", { item: { type: "agentMessage", text: "{\"action\":\"resume_reviewer\"}" } })).text, "{\"action\":\"resume_reviewer\"}");
  assert.equal(codexAgentEvent(normalizeCodexEvent("item/commandExecution/requestApproval", { command: "npm test" }, "approval")).approvalKind, "command");
  assert.deepEqual(codexAgentEvent(normalizeCodexEvent("item/tool/requestUserInput", { questions: [{ id: "q1" }] }, "input")).questions, [{ id: "q1" }]);
  assert.deepEqual(codexAgentEvent(normalizeCodexEvent("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3 } } })).tokenUsage, { input: 10, output: 4, cached: 3 });
});

test("enforces one health deadline and keeps model discovery failures non-fatal", async () => {
  const started = Date.now();
  const timedOut = await checkCodexHealth({ timeoutMs: 20, runCommand: () => new Promise(() => undefined) });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error, "Codex health check timed out after 20 ms");
  assert.ok(Date.now() - started < 250);

  const externalStarted = Date.now();
  const externalTimedOut = await checkCodexHealth({
    timeoutMs: 20,
    includeExternalModels: true,
    runCommand: async () => "codex-cli 0.147.0",
    runModelCommand: () => new Promise(() => undefined),
    launch: () => ({ initialize: async () => undefined, models: async () => [], close: async () => undefined }) as unknown as CodexAppServer
  });
  assert.equal(externalTimedOut.ok, true);
  assert.ok(Date.now() - externalStarted < 250);

  const missingCli = await checkCodexHealth({ runCommand: async () => { throw new Error("spawn codex ENOENT"); } });
  assert.equal(missingCli.error, "Codex CLI could not be started or queried: spawn codex ENOENT");

  const protocolFailure = await checkCodexHealth({
    runCommand: async () => "codex-cli 0.147.0",
    launch: () => ({ initialize: async () => { throw new Error("unsupported protocol version"); }, close: async () => undefined }) as unknown as CodexAppServer
  });
  assert.equal(protocolFailure.error, "Codex App Server initialization or protocol check failed: unsupported protocol version");

  const capabilityFailure = await checkCodexHealth({
    runCommand: async () => "codex-cli 0.147.0",
    launch: () => ({ initialize: async () => undefined, models: async () => { throw new Error("private path"); }, close: async () => undefined }) as unknown as CodexAppServer
  });
  assert.equal(capabilityFailure.ok, true);
  assert.equal(capabilityFailure.capabilities.ok, false);
  assert.equal(capabilityFailure.capabilities.error, "Codex model capabilities are unavailable");
});

test("keeps a slow model timeout and cleanup non-fatal at the registry boundary", async () => {
  const plugin = createCodexPlugin(() => checkCodexHealth({
    timeoutMs: 20,
    runCommand: async () => "codex-cli 0.147.0",
    launch: () => ({
      initialize: async () => undefined,
      models: () => new Promise(() => undefined),
      close: () => new Promise<void>((resolve) => setTimeout(resolve, 20))
    }) as unknown as CodexAppServer
  }));
  assert.equal(plugin.healthTimeoutMs, 7_500);
  plugin.healthTimeoutMs = 100;
  const health = await new AgentRegistry([plugin]).health("codex");
  assert.equal(health.ok, true);
  assert.equal(health.capabilities.ok, false);
});

test("resolves the global Windows Codex script without going through cmd.exe", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-workshop-path-"));
  try {
    const command = join(root, "codex.cmd");
    await writeFile(command, "@echo off\r\n");
    const invocation = resolveInvocation("codex", ["--version"], { PATH: root, PATHEXT: ".CMD;.EXE", ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "win32");
    assert.equal(invocation.file, "C:\\Windows\\System32\\cmd.exe");
    assert.match(invocation.args.at(-1) ?? "", /codex\.cmd.*--version/i);

    await mkdir(join(root, "node_modules", "@openai", "codex", "bin"), { recursive: true });
    const script = join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
    await writeFile(script, "");
    assert.deepEqual(resolveInvocation("codex", [], { PATH: root, PATHEXT: ".CMD;.EXE" }, "win32"), { file: process.execPath, args: [script] });
    assert.deepEqual(resolveInvocation(command, ["app-server"], {}, "win32"), { file: process.execPath, args: [script, "app-server"] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("merges OpenCodex custom models into Codex capabilities", async () => {
  const health = await checkCodexHealth({
    includeExternalModels: true,
    runCommand: async () => "codex-cli 0.147.0",
    runModelCommand: async () => JSON.stringify({ data: [{ id: "echo/gpt-5.6-sol", reasoning_efforts: [{ value: "high" }], reasoning_effort: "high" }] }),
    launch
  });
  assert.equal(health.capabilities.models.some((model) => model.id === "echo/gpt-5.6-sol"), true);
  assert.deepEqual(health.capabilities.models.find((model) => model.id === "echo/gpt-5.6-sol")?.supportedReasoningEfforts, [{ reasoningEffort: "high" }]);
});

test("returns after the interrupt RPC is accepted and propagates an RPC rejection", async () => {
  const accepted = launch({ ignoreInterrupt: true, onApproval: (_event, respond) => respond({ decision: "accept" }) });
  await accepted.initialize();
  const acceptedRun = await accepted.startRun({ cwd: process.cwd(), prompt: "Accept interrupt" });
  const acceptedCompletion = acceptedRun.completed.catch((error: Error) => error);
  await accepted.requestInterrupt(acceptedRun.threadId, acceptedRun.turnId, 25);
  assert.match((await acceptedCompletion).message, /exited unexpectedly/);
  await accepted.close();

  const rejected = launch({ rejectInterrupt: true, onApproval: (_event, respond) => respond({ decision: "accept" }) });
  await rejected.initialize();
  const rejectedRun = await rejected.startRun({ cwd: process.cwd(), prompt: "Reject interrupt" });
  const rejectedCompletion = rejectedRun.completed.catch((error: Error) => error);
  await assert.rejects(rejected.requestInterrupt(rejectedRun.threadId, rejectedRun.turnId), /interrupt rejected/);
  assert.match((await rejectedCompletion).message, /exited unexpectedly/);
  await rejected.close();
});

test("distinguishes an expected host close from an unexpected App Server exit", async () => {
  const events: NormalizedCodexEvent[] = [];
  const client = launch({ onEvent: (event) => events.push(event) });
  await client.initialize();
  const run = await client.startRun({ cwd: process.cwd(), prompt: "Keep running" });
  const completion = run.completed.catch((error: unknown) => error);
  await client.close();
  assert.ok(await completion instanceof CodexAppServerClosedError);
  assert.equal(events.find((event) => event.type === "process.exited")?.payload.expected, true);
});

test("reports spawn errors without crashing the host process", async () => {
  const client = CodexAppServer.launch({ command: "Z:\\definitely-missing\\codex.exe", requestTimeoutMs: 100 });
  await assert.rejects(client.initialize(), /ENOENT|spawn/);
  await client.close();
});

test("terminates an App Server that ignores turn interruption", async () => {
  const client = launch({ ignoreInterrupt: true, onApproval: (_event, respond) => respond({ decision: "accept" }) });
  await client.initialize();
  const run = await client.startRun({ cwd: process.cwd(), prompt: "Hang" });
  void run.completed.catch(() => undefined);
  await assert.rejects(client.interrupt(run.threadId, run.turnId, 25), /did not stop/);
  await client.close();
});

test("kills an App Server when the Interrupt RPC does not respond without leaking a waiter", async () => {
  const client = launch({ ignoreInterruptRpc: true, requestTimeoutMs: 5_000, onApproval: (_event, respond) => respond({ decision: "accept" }) });
  await client.initialize();
  const run = await client.startRun({ cwd: process.cwd(), prompt: "Hang before RPC response" });
  const completed = run.completed.catch((error: Error) => error);
  const started = Date.now();
  await assert.rejects(client.interrupt(run.threadId, run.turnId, 25), /did not stop within 25ms/);
  assert.ok(Date.now() - started < 2_500);
  assert.match((await completed).message, /exited unexpectedly/);
  await client.close();
});

test("drains large App Server stderr output while waiting for JSON-RPC", async () => {
  const client = launch({ stderrBytes: 16 * 1024 * 1024, requestTimeoutMs: 2_000 });
  try {
    await client.initialize();
  } finally {
    await client.close();
  }
});

test("validates role overrides and cleans current or stale Run context", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-workshop-codex-"));
  try {
    const role = snapshotRoleConfig({ prompt: "global", model: "base", backendOptions: { customArgs: ["--quiet"] } }, { prompt: "project", reasoningEffort: "high" });
    assert.deepEqual(role, { prompt: "project", model: "base", reasoningEffort: "high", backendOptions: { customArgs: ["--quiet"] } });
    assert.throws(() => validateCustomArgs(["--listen=ws://127.0.0.1:1"]), /conflicts/);
    assert.throws(() => validateCustomArgs(["-c", "approval_policy=\"never\""]), /conflicts/);
    assert.throws(() => validateCustomArgs(["-c", "sandbox_workspace_write.network_access=true"]), /conflicts/);
    assert.throws(() => validateCodexConfig({ backendOptions: { customArgs: Array.from({ length: 33 }, () => "--flag") } }), /at most 32/);
    assert.throws(() => validateCodexConfig({ backendOptions: { customArgs: [""] } }), /non-empty/);
    assert.throws(() => validateCodexConfig({ backendOptions: { customArgs: ["x".repeat(257)] } }), /256/);

    const context = await createRunContext(root, "run-1", { "task.md": "Task", "plan-revision.md": "Proposal", "messages.md": "Message" });
    assert.equal(await readFile(join(context.directory, "task.md"), "utf8"), "Task");
    assert.equal(await readFile(join(context.directory, "plan-revision.md"), "utf8"), "Proposal");
    await context.cleanup();
    await createRunContext(root, "stale-run", { "task.md": "Stale" });
    assert.equal(await recoverRunContexts(root), 1);
    assert.equal(await recoverRunContexts(root), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
