export type RequirementTokenUsage = { input: number; output: number; cached: number };

export function requirementTokenUsage(payload: Record<string, unknown>): RequirementTokenUsage | undefined {
  const tokenUsage = objectRecord(payload.tokenUsage);
  const total = objectRecord(tokenUsage?.total);
  const input = tokenCount(total?.inputTokens);
  const output = tokenCount(total?.outputTokens);
  const cached = tokenCount(total?.cachedInputTokens);
  return input === undefined || output === undefined || cached === undefined ? undefined : { input, output, cached };
}

export function requirementUsageDelta(before: RequirementTokenUsage, after: RequirementTokenUsage): RequirementTokenUsage {
  return {
    input: Math.max(0, after.input - before.input),
    output: Math.max(0, after.output - before.output),
    cached: Math.max(0, after.cached - before.cached)
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
