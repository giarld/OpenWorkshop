import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";

export const USAGE_RANGES = ["1d", "7d", "30d"] as const;
export type UsageRange = typeof USAGE_RANGES[number];

type RunUsageRow = {
  task_id: string;
  started_at: string;
  finished_at: string | null;
  token_input: number | null;
  token_output: number | null;
  token_cached: number | null;
  config_snapshot_json: string;
};

type UsageBucket = {
  start: string;
  tokenInput: number;
  tokenOutput: number;
  tokenCached: number;
  totalTokens: number;
  runCount: number;
  taskCount: number;
  runtimeMs: number;
};

const TOKEN_PRICES: Record<string, { input: number; cached: number; output: number }> = {
  "gpt-5.6-sol": { input: 5, cached: 0.5, output: 30 },
  "gpt-5.6-terra": { input: 2, cached: 0.2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cached: 0.02, output: 1.2 },
  "gpt-5.4": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cached: 0.075, output: 4.5 }
};

export function registerUsageStatisticsRoutes(server: FastifyInstance, database: DatabaseSync): void {
  server.get<{ Querystring: { range?: string } }>("/api/usage", async (request, reply) => {
    if (!isUsageRange(request.query.range)) return reply.code(400).send({ error: "range must be one of: 1d, 7d, 30d" });
    return usageStatistics(database, request.query.range);
  });
}

export function usageStatistics(database: DatabaseSync, range: UsageRange, now = new Date()) {
  const { start, bucketCount, bucketMs } = rangeWindow(range, now);
  const activityStart = startOfLocalWeek(addLocalDays(now, -52));
  const rows = database.prepare(`SELECT task_id, started_at, finished_at, token_input, token_output, token_cached, config_snapshot_json
    FROM runs WHERE started_at IS NOT NULL AND started_at >= ? AND started_at <= ? ORDER BY started_at`).all(activityStart.toISOString(), now.toISOString()) as RunUsageRow[];
  const rangeRows = rows.filter((row) => Date.parse(row.started_at) >= start.getTime());
  const buckets = Array.from({ length: bucketCount }, (_, index): UsageBucket & { taskIds: Set<string> } => ({
    start: new Date(start.getTime() + index * bucketMs).toISOString(),
    tokenInput: 0,
    tokenOutput: 0,
    tokenCached: 0,
    totalTokens: 0,
    runCount: 0,
    taskCount: 0,
    runtimeMs: 0,
    taskIds: new Set<string>()
  }));
  for (const row of rangeRows) {
    const started = Date.parse(row.started_at);
    const bucket = buckets[Math.min(bucketCount - 1, Math.max(0, Math.floor((started - start.getTime()) / bucketMs)))];
    if (!bucket) continue;
    const input = row.token_input ?? 0;
    const output = row.token_output ?? 0;
    bucket.tokenInput += input;
    bucket.tokenOutput += output;
    bucket.tokenCached += row.token_cached ?? 0;
    bucket.totalTokens += input + output;
    bucket.runCount += 1;
    bucket.runtimeMs += runRuntime(row, now);
    bucket.taskIds.add(row.task_id);
  }
  const series = buckets.map(({ taskIds, ...bucket }) => ({ ...bucket, taskCount: taskIds.size }));
  const taskIds = new Set(rangeRows.map((row) => row.task_id));
  const tokenInput = sum(rangeRows, "token_input");
  const tokenOutput = sum(rangeRows, "token_output");
  const tokenCached = sum(rangeRows, "token_cached");
  const activityCounts = new Map<string, number>();
  for (const row of rows) {
    const date = localDateKey(new Date(row.started_at));
    activityCounts.set(date, (activityCounts.get(date) ?? 0) + 1);
  }
  return {
    range,
    generatedAt: now.toISOString(),
    summary: {
      totalTokens: tokenInput + tokenOutput,
      tokenInput,
      tokenOutput,
      tokenCached,
      estimatedCostUsd: estimatedCost(rangeRows),
      runtimeMs: rangeRows.reduce((total, row) => total + runRuntime(row, now), 0),
      taskCount: taskIds.size,
      runCount: rangeRows.length
    },
    series,
    activity: {
      startDate: localDateKey(activityStart),
      endDate: localDateKey(addLocalDays(activityStart, 370)),
      days: [...activityCounts].map(([date, count]) => ({ date, count }))
    }
  };
}

function rangeWindow(range: UsageRange, now: Date): { start: Date; bucketCount: number; bucketMs: number } {
  if (range === "1d") return { start: new Date(now.getTime() - 24 * 3_600_000), bucketCount: 24, bucketMs: 3_600_000 };
  const days = range === "7d" ? 7 : 30;
  const start = startOfLocalDay(addLocalDays(now, -(days - 1)));
  return { start, bucketCount: days, bucketMs: 86_400_000 };
}

function runRuntime(row: RunUsageRow, now: Date): number {
  const started = Date.parse(row.started_at);
  const finished = row.finished_at ? Date.parse(row.finished_at) : now.getTime();
  return Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0;
}

function estimatedCost(rows: RunUsageRow[]): number | null {
  let dollars = 0;
  for (const row of rows) {
    if (![row.token_input, row.token_output, row.token_cached].some((value) => typeof value === "number")) continue;
    const input = row.token_input ?? 0;
    const cached = Math.min(input, row.token_cached ?? 0);
    const output = row.token_output ?? 0;
    if (input === 0 && output === 0) continue;
    const model = configModel(row.config_snapshot_json);
    const price = model ? TOKEN_PRICES[model] : undefined;
    if (!price) return null;
    dollars += ((input - cached) * price.input + cached * price.cached + output * price.output) / 1_000_000;
  }
  return dollars;
}

function configModel(snapshot: string): string | undefined {
  try {
    const value = JSON.parse(snapshot) as { model?: unknown };
    return typeof value.model === "string" ? value.model : undefined;
  } catch { return undefined; }
}

function sum(rows: RunUsageRow[], key: "token_input" | "token_output" | "token_cached"): number {
  return rows.reduce((total, row) => total + (row[key] ?? 0), 0);
}

function isUsageRange(value: string | undefined): value is UsageRange {
  return value !== undefined && USAGE_RANGES.includes(value as UsageRange);
}

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function startOfLocalWeek(value: Date): Date {
  return startOfLocalDay(addLocalDays(value, -value.getDay()));
}

function addLocalDays(value: Date, days: number): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days, value.getHours(), value.getMinutes(), value.getSeconds(), value.getMilliseconds());
}

function localDateKey(value: Date): string {
  return [value.getFullYear(), value.getMonth() + 1, value.getDate()].map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0")).join("-");
}
