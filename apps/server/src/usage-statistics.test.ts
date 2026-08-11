import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import Fastify from "fastify";
import { registerUsageStatisticsRoutes, usageStatistics } from "./usage-statistics.ts";

function fixture(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE runs (
    task_id TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    token_input INTEGER,
    token_output INTEGER,
    token_cached INTEGER,
    config_snapshot_json TEXT NOT NULL
  ) STRICT;`);
  return database;
}

test("aggregates token, cost, runtime, tasks, and daily activity", () => {
  const database = fixture();
  const insert = database.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)");
  insert.run("task-a", "2026-08-09T01:00:00.000Z", "2026-08-09T01:30:00.000Z", 1_000_000, 100_000, 200_000, JSON.stringify({ model: "gpt-5.6-terra" }));
  insert.run("task-a", "2026-08-10T01:00:00.000Z", "2026-08-10T02:00:00.000Z", 200_000, 50_000, 20_000, JSON.stringify({ model: "gpt-5.6-terra" }));
  insert.run("task-b", "2026-08-10T03:00:00.000Z", null, 300_000, 70_000, 30_000, JSON.stringify({ model: "gpt-5.6-terra" }));

  const result = usageStatistics(database, "7d", new Date("2026-08-10T04:00:00.000Z"));
  assert.equal(result.summary.totalTokens, 1_720_000);
  assert.equal(result.summary.tokenCached, 250_000);
  assert.equal(result.summary.runtimeMs, 9_000_000);
  assert.equal(result.summary.taskCount, 2);
  assert.equal(result.summary.runCount, 3);
  assert.ok(Math.abs((result.summary.estimatedCostUsd ?? 0) - 5.19) < 1e-9);
  assert.equal(result.series.reduce((total, bucket) => total + bucket.totalTokens, 0), 1_720_000);
  assert.equal(result.activity.days.reduce((total, day) => total + day.count, 0), 3);
  database.close();
});

test("rejects unsupported ranges and reports unknown model cost as unavailable", async () => {
  const database = fixture();
  database.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)").run("task-a", "2026-08-10T01:00:00.000Z", "2026-08-10T02:00:00.000Z", 10, 5, 0, JSON.stringify({ model: "custom-model" }));
  assert.equal(usageStatistics(database, "1d", new Date("2026-08-10T04:00:00.000Z")).summary.estimatedCostUsd, null);
  const server = Fastify();
  registerUsageStatisticsRoutes(server, database);
  const response = await server.inject({ method: "GET", url: "/api/usage?range=90d" });
  assert.equal(response.statusCode, 400);
  await server.close();
  database.close();
});
