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

export function activeProjects(projects: ManagedProject[]): ManagedProject[] {
  return projects.filter((project) => !project.archived_at);
}

export function projectIdAfterArchive(projects: ManagedProject[], currentProjectId: string, archivedProjectId: string): string {
  const remaining = activeProjects(projects).filter((project) => project.id !== archivedProjectId);
  return currentProjectId !== archivedProjectId && remaining.some((project) => project.id === currentProjectId)
    ? currentProjectId
    : remaining[0]?.id ?? "";
}
