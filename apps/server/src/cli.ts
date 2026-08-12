#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { createServer } from "./app.js";
import { setPin } from "./auth.js";
import { checkCodexHealth } from "./codex.js";
import { backupDatabase, openWorkshopDatabase, restoreDatabase, SettingsStore } from "./database.js";
import { pruneRawRunEvents } from "./runs.js";
import { acquireInstanceLock, clearRuntimeState, consumeRuntimeStop, prepareWorkshopHome, pruneLogFiles, readLatestLog, readRuntimeState, requestRuntimeStop, writeRuntimeState, type RuntimeState } from "./platform.js";
import { browserCommand, startBackgroundService, waitForServiceStop } from "./service-control.js";
import { installWorkshopSkill } from "./skill-installer.js";
import { isVersionCommand, WORKSHOP_VERSION } from "./version.js";
import { familyHelp, parseWorkflowCommand, WORKFLOW_COMMANDS, workflowHelp, type WorkflowRequest } from "./workflow-cli.js";

const runFile = promisify(execFile);

async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? "help";
  if (["help", "--help", "-h"].includes(command)) {
    console.log(help());
    return;
  }
  if (argv[1] === "help" && Object.keys(WORKFLOW_COMMANDS).some((key) => key.startsWith(`${command} `))) {
    console.log(familyHelp(command));
    return;
  }
  if (isVersionCommand(command)) {
    console.log(WORKSHOP_VERSION);
    return;
  }
  if (command === "skill") {
    await skillCommand(argv.slice(1));
    return;
  }

  const home = await prepareWorkshopHome();
  if (command === "login" || command === "auth") {
    await authenticationCommand(home, command === "login" ? ["login", ...argv.slice(1)] : argv.slice(1));
    return;
  }
  if (command === "api" || Object.keys(WORKFLOW_COMMANDS).some((key) => key.startsWith(`${command} `))) {
    await executeWorkflow(home, argv);
    return;
  }

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8787" },
      foreground: { type: "boolean", default: false },
      lines: { type: "string", short: "n", default: "100" },
      output: { type: "string", default: "pretty" }
    }
  });
  if (command === "log") {
    const lines = Number(values.lines);
    const result = await readLatestLog(join(home, "logs"), lines);
    if (values.output === "json") printResult(result, "json");
    else {
      process.stdout.write(result.content);
      if (result.content && !result.content.endsWith("\n")) process.stdout.write("\n");
    }
    return;
  }
  if (command === "status") {
    const state = await readRuntimeState(home);
    if (values.output === "json") printResult({ status: state ? "running" : "stopped", ...(state ?? {}) }, "json");
    else console.log(state ? `running (pid ${state.pid}) at http://${state.host}:${state.port}` : "stopped");
    return;
  }
  if (command === "gui") {
    const state = await readRuntimeState(home);
    if (!state) throw new Error("OpenWorkshop is not running; run workshop start first");
    const url = serviceUrl(state);
    const [executable, args] = browserCommand(url);
    await runFile(executable, args, { windowsHide: true });
    if (values.output === "json") printResult({ ok: true, url }, "json");
    else console.log(`Opened ${url}`);
    return;
  }
  if (command === "stop") {
    const state = await requestRuntimeStop(home);
    await waitForServiceStop(home);
    if (values.output === "json") printResult({ ok: true, pid: state.pid }, "json");
    else console.log(`Stopped OpenWorkshop (pid ${state.pid})`);
    return;
  }
  if (command === "doctor") {
    const results = await doctor(home, values.host, Number(values.port));
    if (values.output === "json") printResult(results, "json");
    else for (const result of results) console.log(`${result.ok ? "OK" : "FAIL"} ${result.name}${result.detail ? `: ${result.detail}` : ""}`);
    if (results.some((result) => !result.ok)) process.exitCode = 1;
    return;
  }
  if (command === "backup") {
    console.log(await backupDatabase(join(home, "workshop.db"), positionals[0] && resolve(positionals[0])));
    return;
  }
  if (command === "restore") {
    if (!positionals[0]) throw new Error("Usage: workshop restore <path>");
    const releaseLock = await acquireInstanceLock(home);
    try {
      const safetyBackup = await restoreDatabase(join(home, "workshop.db"), positionals[0], join(home, "backups"), join(home, "runtime"));
      console.log(safetyBackup ? `Restored database; previous database backed up to ${safetyBackup}` : "Restored database");
    } finally {
      await releaseLock();
    }
    return;
  }
  if (command === "pin") {
    if (!['set', 'reset'].includes(positionals[0] ?? "")) throw new Error("Usage: workshop pin <set|reset>");
    const releaseLock = await acquireInstanceLock(home);
    let database: Awaited<ReturnType<typeof openWorkshopDatabase>> | undefined;
    try {
      const pin = await readSecret("New 6-digit PIN: ");
      const confirmation = await readSecret("Confirm PIN: ");
      if (pin !== confirmation) throw new Error("PIN confirmation does not match");
      database = await openWorkshopDatabase(home);
      await setPin(database, pin);
      console.log("PIN updated; all sessions revoked");
    } finally {
      database?.close();
      await releaseLock();
    }
    return;
  }
  if (command !== "start" && command !== "restart") throw new Error(`Unsupported command: ${command}`);

  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${values.port}`);
  if (command === "restart") {
    if (await readRuntimeState(home)) {
      await requestRuntimeStop(home);
      await waitForServiceStop(home);
    }
  }
  if (!values.foreground) {
    const state = await startBackgroundService(home, process.argv[1], values.host, port);
    if (values.output === "json") printResult({ status: "running", ...state }, "json");
    else console.log(`${command === "restart" ? "Restarted" : "Started"} OpenWorkshop in background (pid ${state.pid}) at http://${state.host}:${state.port}`);
    return;
  }

  const releaseLock = await acquireInstanceLock(home);
  let database: Awaited<ReturnType<typeof openWorkshopDatabase>> | undefined;
  const fileLog = createWriteStream(join(home, "logs", `workshop-${new Date().toISOString().slice(0, 10)}.log`), { flags: "a" });
  const logger = new Writable({
    write(chunk, encoding, callback) {
      process.stdout.write(chunk);
      fileLog.write(chunk, encoding, callback);
    }
  });
  try {
    database = await openWorkshopDatabase(home);
    const retentionDays = new SettingsStore(database).get<number>("logRetentionDays", 90) ?? 90;
    await pruneLogFiles(join(home, "logs"), retentionDays);
    pruneRawRunEvents(database, retentionDays);
    const server = await createServer(database, undefined, join(home, "attachments"), undefined, undefined, undefined, logger);
    const state = { pid: process.pid, host: values.host, port, startedAt: new Date().toISOString() };
    await clearRuntimeState(home);
    let closing: Promise<void> | undefined;
    let stopWatcher: NodeJS.Timeout | undefined;
    const retentionWatcher = setInterval(() => void Promise.all([pruneLogFiles(join(home, "logs"), retentionDays), Promise.resolve(pruneRawRunEvents(database!, retentionDays))]), 86_400_000);
    retentionWatcher.unref();
    const shutdown = async () => {
      closing ??= (async () => {
        if (stopWatcher) clearInterval(stopWatcher);
        clearInterval(retentionWatcher);
        await server.close();
        database?.close();
        await clearRuntimeState(home);
        await releaseLock();
        logger.end();
        fileLog.end();
      })();
      await closing;
    };
    stopWatcher = setInterval(() => void consumeRuntimeStop(home).then((requested) => { if (requested) return shutdown(); }), 250);
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    await server.listen({ host: values.host, port });
    try {
      await writeRuntimeState(home, state);
    } catch (error) {
      await server.close();
      throw error;
    }
  } catch (error) {
    database?.close();
    await clearRuntimeState(home);
    await releaseLock();
    logger.end();
    fileLog.end();
    throw error;
  }
}

async function skillCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      agent: { type: "string", default: "codex" },
      force: { type: "boolean", default: false },
      output: { type: "string", default: "pretty" }
    }
  });
  if (positionals[0] !== "install" || positionals.length !== 1) throw new Error("Usage: workshop skill install [--agent codex] [--force] [--output json]");
  if (!['pretty', 'json'].includes(values.output!)) throw new Error("--output must be pretty or json");
  const result = await installWorkshopSkill({ agent: values.agent, force: values.force });
  if (values.output === "json") printResult(result, "json");
  else if (result.status === "already-installed") console.log(`Workshop skill already exists at ${result.path}; use --force to update it`);
  else console.log(`${result.status === "updated" ? "Updated" : "Installed"} Workshop skill at ${result.path}`);
}

async function executeWorkflow(home: string, argv: string[]): Promise<void> {
  const request = await parseWorkflowCommand(argv);
  const { data } = await apiRequest(home, request);
  printResult(data, request.output, request.text);
}

async function authenticationCommand(home: string, argv: string[]): Promise<void> {
  const action = argv[0] ?? "status";
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      "server-url": { type: "string" },
      output: { type: "string", default: "pretty" }
    }
  });
  const connection = values["server-url"] ? { serverUrl: values["server-url"] } : {};
  if (action === "status") {
    const { data } = await apiRequest(home, { method: "GET", path: "/api/system/status", query: {}, output: values.output!, ...connection });
    printResult(data, values.output!);
    return;
  }
  if (action === "login" || action === "initialize") {
    const prompt = action === "login" ? "PIN: " : "New 6-digit PIN: ";
    const pin = await readSecret(prompt);
    if (action === "initialize" && pin !== await readSecret("Confirm PIN: ")) throw new Error("PIN confirmation does not match");
    const { data, response } = await apiRequest(home, { method: "POST", path: `/api/auth/${action}`, query: {}, body: JSON.stringify({ pin }), contentType: "application/json", output: values.output!, ...connection }, false);
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("Authentication succeeded without a session cookie");
    await writeFile(join(home, "runtime", "session.json"), `${JSON.stringify({ server: await serverBase(home, values["server-url"]), cookie })}\n`, { mode: 0o600 });
    printResult(data, values.output!);
    return;
  }
  if (action === "logout") {
    let result: Awaited<ReturnType<typeof apiRequest>>;
    try {
      result = await apiRequest(home, { method: "POST", path: "/api/auth/logout", query: {}, output: values.output!, ...connection });
    } finally {
      await rm(join(home, "runtime", "session.json"), { force: true });
    }
    printResult(result.data, values.output!);
    return;
  }
  throw new Error("Usage: workshop auth <status|initialize|login|logout>");
}

async function apiRequest(home: string, request: WorkflowRequest, authenticated = true): Promise<{ data: unknown; response: Response }> {
  const base = await serverBase(home, request.serverUrl);
  const url = new URL(request.path, `${base}/`);
  for (const [key, value] of Object.entries(request.query)) {
    for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined && item !== null) url.searchParams.append(key, String(item));
  }
  const headers = new Headers();
  if (request.contentType) headers.set("Content-Type", request.contentType);
  for (const [name, value] of Object.entries(request.headers ?? {})) headers.set(name, value);
  if (authenticated) {
    const session: { server?: unknown; cookie?: unknown } = await readFile(join(home, "runtime", "session.json"), "utf8").then((value) => JSON.parse(value) as { server?: unknown; cookie?: unknown }).catch(() => ({}));
    if (session.server === base && typeof session.cookie === "string") headers.set("Cookie", session.cookie);
  }
  const response = await fetch(url, { method: request.method, headers, redirect: "error", ...(request.body === undefined ? {} : { body: typeof request.body === "string" ? request.body : Buffer.from(request.body) }) });
  const text = await response.text();
  let data: unknown = text;
  if (response.headers.get("content-type")?.includes("application/json") && text) data = JSON.parse(text);
  if (!response.ok) {
    const message = data && typeof data === "object" && "error" in data ? String(data.error) : text || response.statusText;
    throw new Error(`HTTP ${response.status}: ${message}`);
  }
  return { data: response.status === 204 ? { ok: true } : data, response };
}

async function serverBase(home: string, explicit?: string): Promise<string> {
  const configured = explicit ?? process.env.WORKSHOP_SERVER_URL;
  if (configured) {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Server URL must use http or https");
    return url.origin;
  }
  const state = await readRuntimeState(home);
  if (!state) throw new Error("OpenWorkshop is not running; use --server-url for a remote server");
  return serviceUrl(state);
}

function serviceUrl(state: RuntimeState): string {
  const host = state.host === "0.0.0.0" || state.host === "::" ? "127.0.0.1" : state.host.includes(":") ? `[${state.host}]` : state.host;
  return `http://${host}:${state.port}`;
}

function printResult(data: unknown, output: string, text = false): void {
  if (text || typeof data === "string") console.log(data);
  else console.log(JSON.stringify(data, null, output === "json" ? undefined : 2));
}

function help(): string {
  return `OpenWorkshop ${WORKSHOP_VERSION}\n\nService commands:\n  start [--foreground] [--host HOST] [--port PORT]\n  stop, restart, status, gui, log [-n LINES], doctor, backup, restore, pin, version\n\nAgent integration:\n  skill install [--agent codex] [--force]\n\nAuthentication:\n  auth status|initialize|login|logout\n  login (alias for auth login)\n\n${workflowHelp()}\n\nEnvironment:\n  WORKSHOP_HOME, WORKSHOP_SERVER_URL`;
}

type DoctorResult = { name: string; ok: boolean; detail?: string };

async function doctor(home: string, host: string, port: number): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];
  results.push(await check("database directory", () => access(home)));
  let database: Awaited<ReturnType<typeof openWorkshopDatabase>> | undefined;
  try {
    database = await openWorkshopDatabase(home);
    const quickCheck = database.prepare("PRAGMA quick_check").get() as { quick_check: string };
    results.push({ name: "database", ok: quickCheck.quick_check === "ok", detail: quickCheck.quick_check });
    for (const root of database.prepare("SELECT real_path FROM root_paths WHERE enabled = 1 ORDER BY real_path").all() as Array<{ real_path: string }>) {
      results.push(await check(`project root ${root.real_path}`, () => access(root.real_path)));
    }
  } catch (error) {
    results.push({ name: "database", ok: false, detail: error instanceof Error ? error.message : String(error) });
  } finally {
    database?.close();
  }
  for (const command of ["git", "svn"]) results.push(await check(command, async () => void await runFile(command, ["--version"], { windowsHide: true })));
  const codex = await checkCodexHealth();
  results.push({ name: "codex app-server", ok: codex.ok, ...(codex.version ?? codex.error ? { detail: codex.version ?? codex.error } : {}) });
  results.push(await check(`port ${host}:${port}`, () => checkPort(host, port)));
  return results;
}

async function check(name: string, action: () => Promise<unknown>): Promise<DoctorResult> {
  try {
    await action();
    return { name, ok: true };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function checkPort(host: string, port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
  await new Promise<void>((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen({ host, port }, () => server.close((error) => error ? reject(error) : resolve()));
  });
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error("PIN input requires an interactive terminal");
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      error ? reject(error) : resolve(value);
    };
    const onData = (data: Buffer) => {
      for (const character of data.toString("utf8")) {
        if (character === "\u0003") return finish(new Error("Cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\b" || character === "\u007f") {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else if (character >= " " && character <= "~" && value.length < 128) {
          value += character;
          process.stdout.write("*");
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
