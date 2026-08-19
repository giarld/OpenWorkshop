import type { Task } from "./task-board.ts";

export type DeliveryMethod = "document" | "vcs_commit" | "github_pr";

export type DeliveryFormState = {
  method: DeliveryMethod;
  commitMessage: string;
  remote: string;
  sourceBranch: string;
  targetBranch: string;
  prTitle: string;
  prBody: string;
  draft: boolean;
};

export const EMPTY_DELIVERY_FORM: DeliveryFormState = {
  method: "document",
  commitMessage: "",
  remote: "",
  sourceBranch: "",
  targetBranch: "",
  prTitle: "",
  prBody: "",
  draft: false
};

export const DELIVERY_POLL_INTERVAL_MS = 2_000;

export function shouldRefreshDeliveryEntries(hidden: boolean, section: "delivery" | "notifications"): boolean {
  return !hidden && section === "delivery";
}

export function shouldPollDelivery(status: string | null, hasActiveEntry: boolean): boolean {
  return hasActiveEntry && (status === "queued" || status === "preparing" || status === "running");
}

export function startDeliveryPolling(status: string | null, hasActiveEntry: boolean, refresh: () => void, schedule: (callback: () => void, delay: number) => number, cancel: (timer: number) => void): () => void {
  if (!shouldPollDelivery(status, hasActiveEntry)) return () => undefined;
  const timer = schedule(refresh, DELIVERY_POLL_INTERVAL_MS);
  return () => cancel(timer);
}

export function deliveryFormFromRequest(request: Record<string, unknown> | null | undefined): DeliveryFormState {
  const method = request?.method === "vcs_commit" || request?.method === "github_pr" ? request.method : "document";
  return {
    method,
    commitMessage: stringValue(request?.commitMessage),
    remote: stringValue(request?.remote),
    sourceBranch: stringValue(request?.sourceBranch),
    targetBranch: stringValue(request?.targetBranch),
    prTitle: stringValue(request?.prTitle),
    prBody: stringValue(request?.prBody),
    draft: request?.draft === true
  };
}

export function deliveryRequestFromForm(form: DeliveryFormState): Record<string, unknown> {
  return { ...form };
}

export function deliveryWriteState(commissionStatus: string, deliveryStatus: string | null, externalEffectStarted: boolean): {
  readOnly: boolean;
  canEdit: boolean;
  cancellable: boolean;
} {
  const readOnly = commissionStatus === "done" || deliveryStatus === "succeeded";
  const busy = deliveryStatus === "queued" || deliveryStatus === "preparing" || deliveryStatus === "running";
  return {
    readOnly,
    canEdit: !readOnly && commissionStatus === "awaiting_acceptance" && !externalEffectStarted && !busy,
    cancellable: !readOnly && !externalEffectStarted && (deliveryStatus === "queued" || deliveryStatus === "preparing")
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

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
