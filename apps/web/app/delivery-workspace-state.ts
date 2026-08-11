import type { Task } from "./task-board.ts";

export type DeliveryCommission = {
  id: string;
  title: string;
  status: string;
  summary: string | null;
  main_task_id: string | null;
  archived_at: string | null;
};

export type DeliveryEntry = {
  commissionId: string;
  title: string;
  status: string;
  summary: string | null;
  mainTask: Task;
  completedTasks: number;
  totalTasks: number;
};

export function deliveryEntries(commissions: DeliveryCommission[], tasks: Task[]): DeliveryEntry[] {
  const mainTasks = new Map(tasks.filter((task) => !task.parent_id).map((task) => [task.id, task]));
  return commissions.flatMap((commission) => {
    if (!commission.main_task_id || commission.archived_at) return [];
    const mainTask = mainTasks.get(commission.main_task_id);
    if (!mainTask) return [];
    const commissionTasks = tasks.filter((task) => task.commission_id === commission.id && task.status !== "archived");
    return [{
      commissionId: commission.id,
      title: commission.title,
      status: commission.status,
      summary: commission.summary,
      mainTask,
      completedTasks: commissionTasks.filter((task) => task.status === "done").length,
      totalTasks: commissionTasks.length
    }];
  });
}
