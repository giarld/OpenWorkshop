export type ManagedProject = {
  id: string;
  name: string;
  path: string;
  real_path: string;
  archived_at: string | null;
};

export const WORKSPACE_VIEW_IDS = ["projects", "commissions", "requirements", "board", "delivery", "notifications", "usage", "settings"] as const;
export type WorkspaceView = typeof WORKSPACE_VIEW_IDS[number];

export function storedWorkspaceView(value: string | null): WorkspaceView {
  return WORKSPACE_VIEW_IDS.includes(value as WorkspaceView) ? value as WorkspaceView : "commissions";
}

export type WorkspaceContentState = "settings" | "loading" | "ready";

export function workspaceContentState(view: WorkspaceView, loading: boolean): WorkspaceContentState {
  if (view === "settings") return "settings";
  return loading ? "loading" : "ready";
}

export function activeProjects(projects: ManagedProject[]): ManagedProject[] {
  return projects.filter((project) => !project.archived_at);
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
