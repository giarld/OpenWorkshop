export const TASK_STATUSES = ["backlog", "todo", "in_progress", "done", "blocked", "archived"] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export type TaskSort = "manual" | "priority" | "due_date" | "created_at" | "updated_at";

export type Task = {
  id: string;
  commission_id: string;
  parent_id: string | null;
  number_path: string;
  position: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: "none" | "low" | "medium" | "high" | "urgent";
  due_date: string | null;
  owner_type: "human" | "ai";
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  auto_approve_permissions: number;
  latestRunStatus?: string | null;
  labels: Array<{ id: string; name: string; color: string }>;
};

export type TaskFilters = {
  search: string;
  status: "all" | TaskStatus;
  owner: "all" | Task["owner_type"];
  priority: "all" | Task["priority"];
  label: string;
  commission: string;
};

export type TaskSwimlane = { root: Task; tasks: Task[]; done: number; total: number };
export type TaskSwimlaneGroups = { active: TaskSwimlane[]; archived: TaskSwimlane[] };
export type WorkspaceOverviewStats = { total: number; completed: number; running: number; attention: number; completion: number };

export function preferredProjectId(projects: Array<{ id: string }>, saved: string | null): string {
  return projects.some((project) => project.id === saved) ? saved! : projects[0]?.id ?? "";
}

const PRIORITY_RANK = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 } as const;

export function filterAndSortTasks(tasks: Task[], filters: TaskFilters, sort: TaskSort, descending: boolean): Task[] {
  const needle = filters.search.trim().toLocaleLowerCase();
  return tasks.filter((task) =>
    (!needle || `${task.title}\n${task.description}`.toLocaleLowerCase().includes(needle)) &&
    (filters.status === "all" || task.status === filters.status) &&
    (filters.owner === "all" || task.owner_type === filters.owner) &&
    (filters.priority === "all" || task.priority === filters.priority) &&
    (!filters.label || task.labels.some((label) => label.name === filters.label)) &&
    (!filters.commission || task.commission_id === filters.commission)
  ).sort((left, right) => (descending ? -1 : 1) * compareTasks(left, right, sort));
}

export function taskChildren(tasks: Task[], parentId: string, status?: TaskStatus): Task[] {
  return tasks.filter((task) => task.parent_id === parentId && (status === undefined || task.status === status));
}

export function canDropTask(task: Task, status: TaskStatus, tasks: Task[]): boolean {
  if (status === task.status) return true;
  if (task.status === "done") return false;
  if (status === "done" && !task.parent_id) return false;
  if (status === "archived" && (task.status === "in_progress" || tasks.some((item) => item.parent_id === task.id && item.status !== "archived"))) return false;
  return true;
}

export function treeRoots(tasks: Task[]): Task[] {
  const visibleIds = new Set(tasks.map((task) => task.id));
  return tasks.filter((task) => !task.parent_id || !visibleIds.has(task.parent_id));
}

export function taskSwimlanes(tasks: Task[], visibleTasks: Task[]): TaskSwimlane[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const rootOf = (task: Task) => {
    let root = task;
    while (root.parent_id && byId.has(root.parent_id)) root = byId.get(root.parent_id)!;
    return root;
  };
  const descendants = new Map<string, Task[]>();
  for (const task of tasks) {
    const root = rootOf(task);
    if (root.id !== task.id) descendants.set(root.id, [...(descendants.get(root.id) ?? []), task]);
  }
  const lanes = new Map<string, TaskSwimlane>();
  for (const task of visibleTasks) {
    const root = rootOf(task);
    const descendantsForRoot = descendants.get(root.id) ?? [];
    const counted = root.status === "archived" ? descendantsForRoot : descendantsForRoot.filter((item) => item.status !== "archived");
    const lane = lanes.get(root.id) ?? { root, tasks: [], done: counted.filter((item) => item.status === "done").length, total: counted.length };
    lane.tasks.push(task);
    lanes.set(root.id, lane);
  }
  return [...lanes.values()];
}

export function taskSwimlaneGroups(tasks: Task[], visibleTasks: Task[]): TaskSwimlaneGroups {
  const lanes = taskSwimlanes(tasks, visibleTasks);
  return {
    active: lanes.filter((lane) => lane.root.status !== "archived"),
    archived: lanes.filter((lane) => lane.root.status === "archived")
  };
}

export function workspaceOverviewStats(tasks: Task[]): WorkspaceOverviewStats {
  const current = tasks.filter((task) => task.status !== "archived");
  const completed = current.filter((task) => task.status === "done").length;
  const running = current.filter((task) => ["queued", "preparing", "running"].includes(task.latestRunStatus ?? "")).length;
  const attention = current.filter((task) => task.status === "blocked" || ["waiting_approval", "waiting_input"].includes(task.latestRunStatus ?? "")).length;
  return {
    total: current.length,
    completed,
    running,
    attention,
    completion: current.length ? Math.round((completed / current.length) * 100) : 0
  };
}

function compareTasks(left: Task, right: Task, sort: TaskSort): number {
  if (sort === "manual") return compareNumberPath(left.number_path, right.number_path);
  if (sort === "priority") return PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority] || compareNumberPath(left.number_path, right.number_path);
  const leftValue = left[sort];
  const rightValue = right[sort];
  if (leftValue === rightValue) return compareNumberPath(left.number_path, right.number_path);
  if (leftValue === null) return 1;
  if (rightValue === null) return -1;
  return leftValue.localeCompare(rightValue);
}

function compareNumberPath(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? -1) - (b[index] ?? -1);
    if (difference) return difference;
  }
  return 0;
}
