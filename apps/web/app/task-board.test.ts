import assert from "node:assert/strict";
import test from "node:test";
import { canDropTask, filterAndSortTasks, preferredProjectId, taskChildren, taskSwimlaneGroups, taskSwimlanes, workspaceOverviewStats, type Task } from "./task-board.ts";

const base = {
  commission_id: "commission",
  position: 0,
  description: "",
  priority: "medium",
  due_date: null,
  owner_type: "ai",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
  archived_at: null,
  auto_approve_permissions: 0,
  labels: []
} satisfies Partial<Task>;

const tasks = [
  { ...base, id: "main", parent_id: null, number_path: "1", title: "Main", status: "todo" },
  { ...base, id: "same", parent_id: "main", number_path: "1.1", title: "Same", status: "todo" },
  { ...base, id: "cross", parent_id: "main", number_path: "1.2", title: "Cross", status: "in_progress" }
] as Task[];

test("restores an active saved project and falls back when it is unavailable", () => {
  const projects = [{ id: "first" }, { id: "saved" }];
  assert.equal(preferredProjectId(projects, "saved"), "saved");
  assert.equal(preferredProjectId(projects, "archived"), "first");
  assert.equal(preferredProjectId([], "saved"), "");
});

test("keeps task hierarchy available for the tree list", () => {
  assert.deepEqual(taskChildren(tasks, "main", "todo").map((task) => task.id), ["same"]);
  assert.deepEqual(taskChildren(tasks, "main").filter((task) => task.status !== "todo").map((task) => task.id), ["cross"]);
  assert.equal(tasks.find((task) => task.id === "cross")?.parent_id, "main");
});

test("non-manual sorting keeps a stable hierarchy tie-break", () => {
  const result = filterAndSortTasks(tasks, { search: "", status: "all", owner: "all", priority: "all", label: "", commission: "" }, "priority", false);
  assert.deepEqual(result.map((task) => task.id), ["main", "same", "cross"]);
});

test("groups visible tasks under a commission swimlane without consuming the main task", () => {
  const [lane] = taskSwimlanes(tasks, [tasks[2]!]);
  assert.equal(lane?.root.id, "main");
  assert.deepEqual(lane?.tasks.map((task) => task.id), ["cross"]);
  assert.deepEqual({ done: lane?.done, total: lane?.total }, { done: 0, total: 2 });
  assert.deepEqual(taskSwimlanes(tasks, tasks)[0]?.tasks.map((task) => task.id), ["main", "same", "cross"]);
});

test("separates running tasks from tasks waiting for human attention", () => {
  const overviewTasks = [
    { ...base, id: "running", parent_id: null, number_path: "1", title: "Running", status: "in_progress", latestRunStatus: "running" },
    { ...base, id: "approval", parent_id: null, number_path: "2", title: "Approval", status: "in_progress", latestRunStatus: "waiting_approval" },
    { ...base, id: "input", parent_id: null, number_path: "3", title: "Input", status: "in_progress", latestRunStatus: "waiting_input" },
    { ...base, id: "blocked", parent_id: null, number_path: "4", title: "Blocked", status: "blocked" },
    { ...base, id: "done", parent_id: null, number_path: "5", title: "Done", status: "done" },
    { ...base, id: "archived", parent_id: null, number_path: "6", title: "Archived", status: "archived" }
  ] as Task[];

  assert.deepEqual(workspaceOverviewStats(overviewTasks), { total: 5, completed: 1, running: 1, attention: 3, completion: 20 });
});

test("moves a swimlane into the archived group when its main task is archived", () => {
  const archivedAt = "2026-08-10T00:00:00Z";
  const archivedTasks = tasks.map((task) => ({ ...task, status: "archived" as const, archived_at: archivedAt }));
  const groups = taskSwimlaneGroups([...tasks, ...archivedTasks.map((task) => ({ ...task, id: `archived-${task.id}`, commission_id: "archived-commission", parent_id: task.parent_id ? `archived-${task.parent_id}` : null }))], [
    ...tasks,
    ...archivedTasks.map((task) => ({ ...task, id: `archived-${task.id}`, commission_id: "archived-commission", parent_id: task.parent_id ? `archived-${task.parent_id}` : null }))
  ]);
  assert.deepEqual(groups.active.map((lane) => lane.root.id), ["main"]);
  assert.deepEqual(groups.archived.map((lane) => lane.root.id), ["archived-main"]);
  assert.equal(groups.archived[0]?.total, 2);
});

test("matches board drop feedback to server transition rules", () => {
  assert.equal(canDropTask(tasks[1]!, "in_progress", tasks), true);
  assert.equal(canDropTask(tasks[0]!, "done", tasks), false);
  assert.equal(canDropTask(tasks[0]!, "archived", tasks), false);
  assert.equal(canDropTask({ ...tasks[1]!, status: "done" }, "todo", tasks), false);
});
