export const PREFLIGHT_CHECKS = ["service", "auth", "projectRoots", "agent"] as const;
export type PreflightCheckName = typeof PREFLIGHT_CHECKS[number];
export type PreflightStatus = "ok" | "blocked" | "unavailable";
export type PreflightCheck = { status: PreflightStatus; detail?: string };
export type PreflightResult = {
  ok: boolean;
  checks: Record<PreflightCheckName, PreflightCheck>;
  capabilities: { readOnly: boolean; project: boolean; agent: boolean };
};

export function isAgentHealthResponse(value: unknown): value is Array<{ id?: unknown; ok?: unknown; error?: unknown }> {
  return Array.isArray(value) && value.length > 0 && value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item));
}

export function buildPreflightResult(checks: Record<PreflightCheckName, PreflightCheck>): PreflightResult {
  const readOnly = checks.service.status === "ok" && checks.auth.status === "ok";
  const project = readOnly && checks.projectRoots.status === "ok";
  const agent = project && checks.agent.status === "ok";
  return { ok: readOnly, checks, capabilities: { readOnly, project, agent } };
}

export function sameServerOrigin(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  try {
    const a = new URL(left);
    const b = new URL(right);
    if (a.protocol !== b.protocol || a.port !== b.port) return false;
    return loopbackHost(a.hostname) === loopbackHost(b.hostname) && (a.hostname === b.hostname || isLoopback(a.hostname) && isLoopback(b.hostname));
  } catch {
    return false;
  }
}

function loopbackHost(host: string): string {
  return isLoopback(host) ? "loopback" : host.toLowerCase();
}

function isLoopback(host: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host.toLowerCase());
}
