import assert from "node:assert/strict";
import test from "node:test";
import { deliveryEntries, type DeliveryCommission } from "./delivery-workspace-state.ts";
import type { Task } from "./task-board.ts";

const task = (overrides: Partial<Task>): Task => ({
  id: "main",
  commission_id: "commission",
  parent_id: null,
  number_path: "1",
  position: 0,
  title: "交付主任务",
  description: "",
  status: "in_progress",
  priority: "medium",
  due_date: null,
  owner_type: "ai",
  created_at: "2026-08-10T00:00:00.000Z",
  updated_at: "2026-08-10T00:00:00.000Z",
  archived_at: null,
  auto_approve_permissions: 0,
  labels: [],
  ...overrides
});

const commission = (overrides: Partial<DeliveryCommission> = {}): DeliveryCommission => ({
  id: "commission",
  title: "客户需求",
  status: "active",
  summary: "交付一个可验收功能",
  main_task_id: "main",
  archived_at: null,
  ...overrides
});

test("builds one delivery entry per active commission with a main task", () => {
  const entries = deliveryEntries([commission()], [task({}), task({ id: "child", parent_id: "main", number_path: "1.1", status: "done" })]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.title, "客户需求");
  assert.equal(entries[0]?.completedTasks, 1);
  assert.equal(entries[0]?.totalTasks, 2);
});

test("omits archived commissions and commissions without a resolvable main task", () => {
  assert.deepEqual(deliveryEntries([commission({ archived_at: "2026-08-10T00:00:00.000Z" }), commission({ id: "missing", main_task_id: "missing" })], [task({})]), []);
});
