import { createServer } from "node:net";
import type { AgentBackendHealth } from "./agent.ts";

export type DoctorResult = { name: string; ok: boolean; detail?: string; warning?: boolean };
type WorkshopPortState = { port: number };

export function doctorLabel(result: DoctorResult): "OK" | "WARN" | "FAIL" {
  return result.ok ? "OK" : result.warning ? "WARN" : "FAIL";
}

export function doctorFailed(results: DoctorResult[]): boolean {
  return results.some((result) => !result.ok && !result.warning);
}

export function agentDoctorResults(agents: readonly AgentBackendHealth[]): DoctorResult[] {
  const anyAgentOk = agents.some((agent) => agent.ok);
  return agents.map((agent) => ({ name: `agent ${agent.id}`, ok: agent.ok, ...(agent.runtimeVersion ?? agent.error ? { detail: agent.runtimeVersion ?? agent.error } : {}), ...(!agent.ok && anyAgentOk ? { warning: true } : {}) }));
}

export async function checkPort(host: string, port: number, workshop?: WorkshopPortState): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
  try {
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen({ host, port }, () => server.close((error) => error ? reject(error) : resolve()));
    });
  } catch (error) {
    if (workshop?.port === port && await isOpenWorkshop(host, port)) return;
    throw error;
  }
}

async function isOpenWorkshop(host: string, port: number): Promise<boolean> {
  const target = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : host.includes(":") ? `[${host}]` : host;
  try {
    const response = await fetch(`http://${target}:${port}/api/system/status`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return false;
    const status: unknown = await response.json();
    return Boolean(status && typeof status === "object"
      && typeof (status as Record<string, unknown>).initialized === "boolean"
      && typeof (status as Record<string, unknown>).authenticated === "boolean"
      && typeof (status as Record<string, unknown>).httpWarning === "boolean");
  } catch {
    return false;
  }
}
