import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { instanceLockIsActive, readRuntimeState, type RuntimeState } from "./platform.ts";

export async function ensureBackgroundService(root: string, cliPath: string | undefined, host: string, port: number): Promise<RuntimeState> {
  return await readRuntimeState(root) ?? startBackgroundService(root, cliPath, host, port);
}

export async function startBackgroundService(root: string, cliPath: string | undefined, host: string, port: number, timeoutMs = 10_000): Promise<RuntimeState> {
  const current = await readRuntimeState(root);
  if (current) throw new Error(`OpenWorkshop is already running (pid ${current.pid})`);
  if (!cliPath) throw new Error("Cannot locate the OpenWorkshop CLI entry point");

  const child = spawn(process.execPath, [cliPath, "start", "--foreground", "--host", host, "--port", String(port)], {
    detached: true,
    env: { ...process.env, WORKSHOP_HOME: root },
    stdio: "ignore",
    windowsHide: true
  });
  let spawnError: Error | undefined;
  child.once("error", (error) => { spawnError = error; });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const state = await readRuntimeState(root);
    if (state && state.pid === child.pid) return state;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("OpenWorkshop failed to start; run workshop start --foreground for details");
    await delay(50);
  }
  throw new Error("Timed out waiting for OpenWorkshop to start; run workshop start --foreground for details");
}

export async function waitForServiceStop(root: string, timeoutMs = 10_000, isAlive?: (pid: number) => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const locked = await instanceLockIsActive(root, isAlive);
    if (!await readRuntimeState(root) && !locked) return;
    await delay(50);
  }
  throw new Error("Timed out waiting for OpenWorkshop to stop");
}

export function browserCommand(url: string, platform = process.platform): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}
