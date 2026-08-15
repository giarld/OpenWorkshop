export type ManagedProject = {
  id: string;
  name: string;
  path: string;
  real_path: string;
  archived_at: string | null;
  task_total: number;
  task_completed: number;
  run_queued: number;
  run_active: number;
  run_waiting: number;
};

export const PROJECT_NAME_MAX_LENGTH = 100;

export function projectNameError(name: string): string | null {
  if (!name.trim()) return "项目名称不能为空。";
  return name.length > PROJECT_NAME_MAX_LENGTH ? `项目名称不能超过 ${PROJECT_NAME_MAX_LENGTH} 个字符。` : null;
}

export const WORKSPACE_VIEW_IDS = ["projects", "commissions", "requirements", "board", "delivery", "notifications", "usage", "settings"] as const;
export type WorkspaceView = typeof WORKSPACE_VIEW_IDS[number];

export function storedWorkspaceView(value: string | null): WorkspaceView {
  if (value === "history") return "board";
  return WORKSPACE_VIEW_IDS.includes(value as WorkspaceView) ? value as WorkspaceView : "commissions";
}

export function initialWorkspaceView(storedValue: string | null, hash: string): WorkspaceView {
  if (storedValue === "history") return "board";
  if (WORKSPACE_VIEW_IDS.includes(storedValue as WorkspaceView)) return storedValue as WorkspaceView;
  if (hash.startsWith("#task-")) return "board";
  if (hash.startsWith("#approval-")) return "notifications";
  return "commissions";
}

export function isStaleWorkspaceHash(storedValue: string | null, hash: string): boolean {
  return WORKSPACE_VIEW_IDS.includes(storedValue as WorkspaceView) && (hash.startsWith("#task-") || hash.startsWith("#approval-"));
}

export type WorkspaceContentState = "settings" | "loading" | "ready";

export function workspaceContentState(view: WorkspaceView, loading: boolean): WorkspaceContentState {
  if (view === "settings") return "settings";
  return loading ? "loading" : "ready";
}

export function activeProjects(projects: ManagedProject[]): ManagedProject[] {
  return projects.filter((project) => !project.archived_at);
}

export function projectRunLabels(project: ManagedProject): string[] {
  return [project.run_active && `运行 ${project.run_active}`, project.run_queued && `排队 ${project.run_queued}`, project.run_waiting && `等待 ${project.run_waiting}`].filter((label): label is string => Boolean(label));
}

export function projectIdAfterArchive(projects: ManagedProject[], currentProjectId: string, archivedProjectId: string): string {
  const remaining = activeProjects(projects).filter((project) => project.id !== archivedProjectId);
  return currentProjectId !== archivedProjectId && remaining.some((project) => project.id === currentProjectId)
    ? currentProjectId
    : remaining[0]?.id ?? "";
}

export type ProjectDataRequest = Readonly<{ projectId: string; sequence: number }>;

export function createProjectDataRequestGate() {
  let latestSequence = 0;
  return {
    begin(projectId: string): ProjectDataRequest {
      return { projectId, sequence: ++latestSequence };
    },
    accepts(request: ProjectDataRequest, currentProjectId: string): boolean {
      return request.projectId === currentProjectId && request.sequence === latestSequence;
    },
    invalidate(): void {
      latestSequence += 1;
    }
  };
}

export function createKeyedSingleFlight() {
  let active: { key: string; promise: Promise<void> } | null = null;
  return {
    run(key: string, operation: () => Promise<void>): Promise<void> {
      if (active?.key === key) return active.promise;
      const promise = operation();
      active = { key, promise };
      const clear = () => { if (active?.promise === promise) active = null; };
      void promise.then(clear, clear);
      return promise;
    }
  };
}
