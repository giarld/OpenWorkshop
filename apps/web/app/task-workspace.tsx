"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDndContext,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Children, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { AVATAR_SETTINGS_EVENT, DEFAULT_AVATARS, avatarSettings, isImageAvatar, type AvatarSettings } from "./avatar-settings";
import { DeliveryWorkspace } from "./delivery-workspace";
import { CommissionWorkspace } from "./commission-workspace";
import { UsageStatisticsWorkspace } from "./usage-statistics-workspace";
import { activeProjects, projectIdAfterArchive, storedWorkspaceView, type ManagedProject, type WorkspaceView } from "./project-management";
import { commentLinkUrl, commentMentionParts, commentThreadRows, diffLines, formatRunDuration, formatTokenCount, formatTokenPrice, insertMention, isLongRunEventDetail, mentionTriggerAtCursor, parseReviewComment, runCodeChanges, runEventDetail, runQuestions, runTimelineEvents, tokenPrice, tokenUsageTotals, type CodeChange, type MentionTrigger, type ReviewFinding, type RunEvent, type RunQuestion } from "./task-run";
import {
  TASK_STATUSES,
  canDropTask,
  filterAndSortTasks,
  preferredProjectId,
  taskChildren,
  taskSwimlaneGroups,
  taskSwimlanes,
  treeRoots,
  type Task,
  type TaskFilters,
  type TaskSort,
  type TaskStatus
} from "./task-board";

type Project = ManagedProject;
type RootPath = { id: string; path: string; real_path: string };
type Commission = { id: string; title: string; status: string };
type Run = { id: string; task_id: string; role: string; status: string; attempt_no: number; started_at: string | null; finished_at: string | null; failure_summary: string | null; token_input: number | null; token_output: number | null; token_cached: number | null; configSnapshot?: { model?: string } };
type TaskComment = { id: string; task_id: string; parent_id: string | null; run_id: string | null; author_type: "human" | "agent" | "system"; agent_role: string | null; kind: string; content: string; created_at: string; deleted_at: string | null };
type CommentPostResponse = TaskComment & { agentMention?: { action: "steered" | "queued" | "triggered" | "unavailable"; message?: string } };
type View = WorkspaceView;
type BoardView = "board" | "list";

const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  done: "Done",
  blocked: "Blocked",
  archived: "Archived"
};
const RUN_STATUS_LABELS: Record<string, string> = { queued: "等待运行", preparing: "准备中", running: "进行中", waiting_approval: "等待审批", waiting_input: "等待输入", succeeded: "成功", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
const ROLE_LABELS: Record<string, string> = { planner: "规划 Agent", developer: "执行 Agent", reviewer: "审查 Agent", supervisor: "项目主管 Agent", requirement: "需求 Agent", archivist: "归档 Agent" };
const SORT_LABELS: Record<TaskSort, string> = { manual: "手动顺序", priority: "优先级", due_date: "截止日期", created_at: "创建时间", updated_at: "更新时间" };
const EMPTY_FILTERS: TaskFilters = { search: "", status: "all", owner: "all", priority: "all", label: "", commission: "" };
const SELECTED_PROJECT_KEY = "workshop:selected-project";
const SELECTED_VIEW_KEY = "workshop:selected-workspace-view";
const ARCHIVED_SWIMLANE_ID = "archived-swimlane-group";
const PAGES: Array<{ id: View; label: string }> = [
  { id: "projects", label: "项目管理" },
  { id: "commissions", label: "客户委托" },
  { id: "requirements", label: "需求文档" },
  { id: "board", label: "任务看板" },
  { id: "delivery", label: "交付中心" },
  { id: "notifications", label: "通知与审批" },
  { id: "usage", label: "使用统计" }
];

export function TaskWorkspace({ settings }: { settings: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [projectCommissions, setProjectCommissions] = useState<Commission[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<View>("commissions");
  const [viewLoaded, setViewLoaded] = useState(false);
  const [boardView, setBoardView] = useState<BoardView>("board");
  const [sort, setSort] = useState<TaskSort>("manual");
  const [descending, setDescending] = useState(false);
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_FILTERS);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set([ARCHIVED_SWIMLANE_ID]));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [associationError, setAssociationError] = useState("");
  const [taskCreationError, setTaskCreationError] = useState("");
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [loading, setLoading] = useState(true);
  const [taskDialogTask, setTaskDialogTask] = useState<Task | null>(null);
  const [propertyTask, setPropertyTask] = useState<Task | null>(null);
  const [propertyBusy, setPropertyBusy] = useState(false);
  const [propertyError, setPropertyError] = useState("");
  const [managedProject, setManagedProject] = useState<Project | null>(null);
  const [projectManagementBusy, setProjectManagementBusy] = useState(false);
  const [projectManagementError, setProjectManagementError] = useState("");
  const [taskRuns, setTaskRuns] = useState<Run[]>([]);
  const [taskTokenRuns, setTaskTokenRuns] = useState<Run[]>([]);
  const [taskRunEvents, setTaskRunEvents] = useState<Record<string, RunEvent[]>>({});
  const [taskBusy, setTaskBusy] = useState(false);
  const taskDialog = useRef<HTMLDialogElement>(null);
  const propertyDialog = useRef<HTMLDialogElement>(null);
  const projectManagementDialog = useRef<HTMLDialogElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { delay: 180, tolerance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  useEffect(() => {
    setView(storedWorkspaceView(localStorage.getItem(SELECTED_VIEW_KEY)));
    setViewLoaded(true);
    void api<Project[]>("/api/projects").then((items) => {
      const active = activeProjects(items);
      setProjects(active);
      setProjectId(preferredProjectId(active, localStorage.getItem(SELECTED_PROJECT_KEY)));
    }).catch((error: Error) => setMessage(error.message)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (projectId) localStorage.setItem(SELECTED_PROJECT_KEY, projectId);
  }, [projectId]);

  useEffect(() => {
    if (viewLoaded) localStorage.setItem(SELECTED_VIEW_KEY, view);
  }, [view, viewLoaded]);

  useEffect(() => {
    void refreshNotificationCount();
    const timer = window.setInterval(() => void refreshNotificationCount(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const element = taskDialog.current;
    if (taskDialogTask && element && !element.open) element.showModal();
    if (!taskDialogTask && element?.open) element.close();
  }, [taskDialogTask]);

  useEffect(() => {
    const element = propertyDialog.current;
    if (propertyTask && element && !element.open) element.showModal();
    if (!propertyTask && element?.open) element.close();
  }, [propertyTask]);

  useEffect(() => {
    const element = projectManagementDialog.current;
    if (managedProject && element && !element.open) element.showModal();
    if (!managedProject && element?.open) element.close();
  }, [managedProject]);

  useEffect(() => {
    if (view !== "board" || !projectId) return;
    const timer = window.setInterval(() => { void refreshProject(); if (taskDialogTask) void refreshTaskDialog(taskDialogTask.id); }, 2000);
    return () => window.clearInterval(timer);
  }, [view, projectId, taskDialogTask?.id]);

  useEffect(() => {
    if (!projectId) { setTasks([]); setProjectCommissions([]); return; }
    void loadTasks(projectId, setTasks, setMessage, setLoading);
    void api<Commission[]>(`/api/projects/${projectId}/commissions`).then(setProjectCommissions).catch((error: Error) => setMessage(error.message));
  }, [projectId]);

  useEffect(() => {
    const routeNotification = () => {
      if (location.hash.startsWith("#task-")) {
        setView("board");
        window.setTimeout(() => focusTask(location.hash.slice(6)), 0);
      } else if (location.hash.startsWith("#approval-")) setView("notifications");
    };
    routeNotification();
    window.addEventListener("hashchange", routeNotification);
    return () => window.removeEventListener("hashchange", routeNotification);
  }, []);

  const visibleTasks = useMemo(() => filterAndSortTasks(tasks, filters, sort, descending), [tasks, filters, sort, descending]);
  const labels = useMemo(() => [...new Set(tasks.flatMap((task) => task.labels.map((label) => label.name)))].sort(), [tasks]);
  const commissions = useMemo(() => [...new Set(tasks.map((task) => task.commission_id))], [tasks]);
  const commissionTitles = useMemo(() => new Map(projectCommissions.map((commission) => [commission.id, commission.title])), [projectCommissions]);

  async function handleDragEnd(event: DragEndEvent) {
    const id = String(event.active.id);
    const overId = event.over ? String(event.over.id) : "";
    const task = tasks.find((item) => item.id === id);
    if (!task || !overId || task.status === "archived") return;
    const target = tasks.find((item) => item.id === overId);
    const status = (overId.startsWith("column:") ? overId.split(":").at(-1) : target?.status) as TaskStatus | undefined;
    if (!status) return;
    if (!canDropTask(task, status, tasks)) { setMessage("该任务不能进入目标列表。"); return; }
    if (status === "archived") return void archiveTasks([task.id]);
    if (status !== task.status) {
      if (status === "in_progress" && task.owner_type === "ai") {
        const previous = tasks;
        setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: "in_progress", latestRunStatus: "queued" } : item));
        setMessage("");
        try { await triggerTask(task); await loadTasks(projectId, setTasks, setMessage); setMessage("任务已启动，Agent 正在接管执行。"); }
        catch (error) { setTasks(previous); setMessage((error as Error).message); }
        return;
      }
      return void mutateTask(task, "/move", { status }, { status });
    }
    if (sort === "manual" && target && target.id !== task.id && target.parent_id === task.parent_id) {
      await mutateTask(task, "/reorder", { position: target.position });
    }
  }

  async function mutateTask(task: Task, path: string, body: Record<string, unknown>, optimistic?: Partial<Task>) {
    const previous = tasks;
    if (optimistic) setTasks((current) => current.map((item) => item.id === task.id ? { ...item, ...optimistic } : item));
    setMessage("");
    try {
      await api(`/api/tasks/${task.id}${path}`, { method: "POST", body: JSON.stringify(body) });
      await loadTasks(projectId, setTasks, setMessage);
    } catch (error) {
      setTasks(previous);
      setMessage((error as Error).message);
    }
  }

  async function archiveTasks(ids: string[]) {
    const selectedIds = new Set(ids);
    const eligible = tasks.filter((task) => selectedIds.has(task.id) && task.status === "done");
    const ordered = eligible.filter((task) => {
      let parentId = task.parent_id;
      while (parentId) {
        if (selectedIds.has(parentId)) return false;
        parentId = tasks.find((item) => item.id === parentId)?.parent_id ?? null;
      }
      return true;
    }).sort((a, b) => b.number_path.split(".").length - a.number_path.split(".").length);
    if (!ordered.length) { setMessage("只有 Done 任务可以归档。"); return; }
    const archivesTree = ordered.some((task) => !task.parent_id);
    if (!window.confirm(archivesTree ? "归档主任务会同时归档其所有子任务，是否继续？" : `确认归档选中的 ${ordered.length} 个任务？`)) return;
    setMessage("");
    const failures: string[] = [];
    const archived: Task[] = [];
    for (const task of ordered) {
      try { await api(`/api/tasks/${task.id}/archive`, { method: "POST" }); archived.push(task); }
      catch (error) { failures.push(`${task.number_path} ${task.title}: ${(error as Error).message}`); }
    }
    setSelected(new Set());
    if (taskDialogTask && archived.some((task) => task.id === taskDialogTask.id || (!task.parent_id && task.commission_id === taskDialogTask.commission_id))) setTaskDialogTask(null);
    await loadTasks(projectId, setTasks, setMessage);
    setMessage(failures.length ? failures.join("；") : archivesTree ? "主任务及其全部子任务已归档。" : `已归档 ${archived.length} 个任务。`);
  }

  async function unarchiveTask(task: Task) {
    const restoresTree = !task.parent_id;
    if (!window.confirm(restoresTree ? "解除主任务归档会同时恢复其全部子任务，并统一回到 Done，是否继续？" : "解除该任务归档并恢复到 Done？")) return;
    setTaskBusy(true); setMessage("");
    try {
      const restored = await api<Task>(`/api/tasks/${task.id}/unarchive`, { method: "POST" });
      await loadTasks(projectId, setTasks, setMessage);
      setTaskDialogTask((current) => current?.id === restored.id ? restored : current);
      setMessage(restoresTree ? "主任务及其全部子任务已解除归档并回到 Done。" : "任务已解除归档并回到 Done。");
    } catch (error) { setMessage((error as Error).message); }
    finally { setTaskBusy(false); }
  }

  function toggleCollapsed(id: string) {
    setCollapsed((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  async function associateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const path = String(data.get("path") ?? "").trim();
    const name = String(data.get("name") ?? "").trim() || path.split(/[\\/]/).filter(Boolean).at(-1) || "本地项目";
    setMessage("");
    setAssociationError("");
    try {
      // ponytail: one root per project; add shared-root selection when the settings page exists.
      const roots = await api<RootPath[]>("/api/roots");
      const root = roots.find((item) => item.path === path || item.real_path === path)
        ?? await api<RootPath>("/api/roots", { method: "POST", body: JSON.stringify({ path }) });
      const project = await api<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name, path: ".", rootPathId: root.id }) });
      setProjects((current) => [...current, project]);
      setProjectId(project.id);
      form.reset();
      form.closest("details")?.removeAttribute("open");
      setMessage(`已关联 ${project.name}。`);
    } catch (error) {
      const detail = (error as Error).message;
      setAssociationError(detail === "Project is already associated" ? "该路径已关联，请勿重复关联。" : `关联失败：${detail}`);
    }
  }

  function openProjectManagement(project: Project) {
    setProjectManagementError("");
    setManagedProject(project);
  }

  async function saveManagedProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!managedProject) return;
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (!name) { setProjectManagementError("项目名称不能为空。"); return; }
    setProjectManagementBusy(true); setProjectManagementError("");
    try {
      const updated = await api<Project>(`/api/projects/${managedProject.id}`, { method: "PUT", body: JSON.stringify({ name }) });
      setProjects((current) => current.map((project) => project.id === updated.id ? updated : project));
      setManagedProject(null);
      setMessage(`项目已重命名为“${updated.name}”。`);
    } catch (error) { setProjectManagementError(`保存失败：${(error as Error).message}`); }
    finally { setProjectManagementBusy(false); }
  }

  async function archiveManagedProject() {
    if (!managedProject || !window.confirm(`解除项目“${managedProject.name}”的关联？\n\n该操作不会删除项目文件或历史数据。`)) return;
    setProjectManagementBusy(true); setProjectManagementError("");
    try {
      await api<Project>(`/api/projects/${managedProject.id}/archive`, { method: "POST" });
      const nextProjectId = projectIdAfterArchive(projects, projectId, managedProject.id);
      setProjects((current) => current.filter((project) => project.id !== managedProject.id));
      setManagedProject(null);
      setProjectId(nextProjectId);
      if (!nextProjectId) localStorage.removeItem(SELECTED_PROJECT_KEY);
      setMessage("项目关联已解除，项目文件和历史数据均已保留。");
    } catch (error) { setProjectManagementError(`解除关联失败：${(error as Error).message}`); }
    finally { setProjectManagementBusy(false); }
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const commissionId = String(data.get("commissionId") ?? "");
    setMessage("");
    setTaskCreationError("");
    try {
      await api(`/api/commissions/${commissionId}/tasks`, { method: "POST", body: JSON.stringify({
        title: data.get("title"),
        description: data.get("description"),
        priority: data.get("priority"),
        ownerType: data.get("ownerType"),
        dueDate: data.get("dueDate") || null
      }) });
      await loadTasks(projectId, setTasks, setMessage);
      form.reset();
      form.closest("details")?.removeAttribute("open");
      setMessage("任务已创建并进入 Backlog。");
    } catch (error) {
      setTaskCreationError(`创建失败：${(error as Error).message}`);
    }
  }

  async function refreshProject() {
    try { await Promise.all([loadTasks(projectId, setTasks, setMessage), api<Commission[]>(`/api/projects/${projectId}/commissions`).then(setProjectCommissions)]); }
    catch (error) { setMessage((error as Error).message); }
  }

  async function refreshNotificationCount() {
    try { setUnreadNotifications((await api<Array<{ id: string }>>("/api/notifications?unread=true")).length); }
    catch {}
  }

  async function openTask(task: Task) {
    setMessage("");
    setTaskDialogTask(task);
    setTaskRuns([]);
    setTaskTokenRuns([]);
    setTaskRunEvents({});
    await refreshTaskDialog(task.id, true);
  }

  async function saveTaskProperties(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!propertyTask) return;
    const data = new FormData(event.currentTarget);
    setPropertyBusy(true);
    setPropertyError("");
    try {
      const updated = await api<Task>(`/api/tasks/${propertyTask.id}`, { method: "PUT", body: JSON.stringify({
        ownerType: data.get("ownerType"),
        priority: data.get("priority"),
        dueDate: data.get("dueDate") || null,
        autoApprovePermissions: data.get("autoApprovePermissions") === "on"
      }) });
      setTasks((current) => current.map((task) => task.id === updated.id ? updated : task));
      setTaskDialogTask((current) => current?.id === updated.id ? updated : current);
      setPropertyTask(null);
      setMessage("任务属性已保存。");
    } catch (error) { setPropertyError((error as Error).message); }
    finally { setPropertyBusy(false); }
  }

  async function refreshTaskDialog(taskId: string, includeHistory = false) {
    try {
      const tree = !tasks.find((task) => task.id === taskId)?.parent_id;
      const [task, runs, tokenRuns] = await Promise.all([api<Task>(`/api/tasks/${taskId}`), api<Run[]>(`/api/tasks/${taskId}/runs`), tree ? api<Run[]>(`/api/tasks/${taskId}/runs?scope=tree`) : Promise.resolve(null)]);
      setTaskDialogTask((current) => current?.id === taskId ? task : current);
      setTaskRuns(runs);
      setTaskTokenRuns(tokenRuns ?? runs);
      const targets = includeHistory ? runs : runs.slice(0, 1);
      const loaded = await Promise.all(targets.map(async (run) => [run.id, await api<RunEvent[]>(`/api/runs/${run.id}/events`)] as const));
      setTaskRunEvents((current) => Object.fromEntries([...Object.entries(includeHistory ? {} : current).filter(([id]) => runs.some((run) => run.id === id)), ...loaded]));
    } catch (error) { setMessage((error as Error).message); }
  }

  async function taskAction(path: "trigger" | "pause" | "resume" | "cancel", success: string) {
    if (!taskDialogTask) return;
    setTaskBusy(true); setMessage("");
    try {
      if (path === "trigger") await triggerTask(taskDialogTask);
      else await api(`/api/tasks/${taskDialogTask.id}/${path}`, { method: "POST" });
      await refreshProject(); await refreshTaskDialog(taskDialogTask.id); setMessage(success);
    } catch (error) { setMessage((error as Error).message); }
    finally { setTaskBusy(false); }
  }

  async function triggerTask(task: Task) {
    await api(`/api/tasks/${task.id}/trigger`, { method: "POST" });
  }

  async function steerRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const message = String(new FormData(form).get("message") ?? "").trim();
    const run = taskRuns[0];
    if (!run || !message) return;
    setTaskBusy(true);
    try { await api(`/api/runs/${run.id}/steer`, { method: "POST", body: JSON.stringify({ message }) }); form.reset(); await refreshTaskDialog(run.task_id); setMessage("已向当前 Run 发送补充指令。"); }
    catch (error) { setMessage((error as Error).message); }
    finally { setTaskBusy(false); }
  }

  async function answerRunInput(event: FormEvent<HTMLFormElement>, requestId: string, questions: RunQuestion[]) {
    event.preventDefault();
    const run = taskRuns[0];
    if (!run) return;
    const data = new FormData(event.currentTarget);
    const answers = Object.fromEntries(questions.map((question) => [question.id, { answers: [String(data.get(question.id) ?? "").trim()] }]));
    setTaskBusy(true);
    try { await api(`/api/runs/${run.id}/input`, { method: "POST", body: JSON.stringify({ requestId, answers }) }); await refreshTaskDialog(run.task_id); setMessage("已提交 Agent 所需信息。"); }
    catch (error) { setMessage((error as Error).message); }
    finally { setTaskBusy(false); }
  }

  const associate = <details className="associate-project">
    <summary>关联本地项目</summary>
    <form onSubmit={associateProject}>
      <label>项目名称（可选）<input name="name" placeholder="默认使用目录名" /></label>
      <label>项目绝对路径<input name="path" placeholder="/Users/me/Codes/project" required /></label>
      {associationError && <p className="workspace-message" role="alert">{associationError}</p>}
      <div className="associate-actions">
        <button type="button" className="secondary" onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}>取消</button>
        <button type="submit">关联</button>
      </div>
    </form>
  </details>;

  const taskCommissions = projectCommissions.filter((commission) => ["planned", "backlog", "active", "paused", "blocked"].includes(commission.status));
  const createTaskDialog = <details className="create-task">
    <summary>创建任务</summary>
    <form onSubmit={createTask}>
      {taskCommissions.length ? <>
        <label>委托<select name="commissionId" required>{taskCommissions.map((commission) => <option key={commission.id} value={commission.id}>{commission.title}</option>)}</select></label>
        <label>标题<input name="title" required /></label>
        <label>描述<textarea name="description" rows={3} /></label>
        <label>优先级<select name="priority" defaultValue="none"><option value="none">无</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="urgent">紧急</option></select></label>
        <label>负责人<select name="ownerType" defaultValue="ai"><option value="ai">AI</option><option value="human">人工</option></select></label>
        <label>截止日期<input name="dueDate" type="date" /></label>
        {taskCreationError && <p className="workspace-message" role="alert">{taskCreationError}</p>}
        <div className="dialog-actions"><button type="button" className="secondary" onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}>取消</button><button type="submit">创建</button></div>
      </> : <><p>暂无可创建任务的已批准委托，请先完成委托需求批准。</p><button type="button" className="secondary" onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}>关闭</button></>}
    </form>
  </details>;

  if (loading && !projects.length) return <section className="empty-state">正在加载项目与任务…</section>;
  if (!projects.length) return <section className="task-workspace" aria-label="任务工作区"><div className="workspace-shell"><WorkspaceNav view={view} unreadNotifications={unreadNotifications} onChange={setView} /><section className="workspace-content" id="workspace-content" tabIndex={-1}>{view === "settings" ? settings : view === "usage" ? <UsageStatisticsWorkspace /> : view === "projects" ? <ProjectManagementPage projects={projects} projectId={projectId} associate={associate} onSelect={setProjectId} onManage={openProjectManagement} /> : <section className="empty-state"><h2>暂无可用项目</h2><p>关联主机上的现有项目目录后开始管理任务。</p>{associate}{message && <p className="workspace-message" role="status">{message}</p>}</section>}</section></div></section>;

  return <section className="task-workspace" aria-label="任务工作区">
    <div className="project-bar">
      <div className="project-picker"><label>当前项目<select value={projectId} onChange={(event) => setProjectId(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><p>{tasks.filter((task) => task.status !== "archived").length} 个活跃任务 · {projectCommissions.length} 个委托</p></div>
      <div className="project-actions">{createTaskDialog}{associate}</div>
    </div>
    <div className="workspace-shell">
      <WorkspaceNav view={view} unreadNotifications={unreadNotifications} onChange={setView} />
      <section className="workspace-content" id="workspace-content" tabIndex={-1}>
        {message && <p className="workspace-message" role="status">{message}</p>}
        {view === "projects" && <ProjectManagementPage projects={projects} projectId={projectId} associate={associate} onSelect={(id) => { setMessage(""); setProjectId(id); }} onManage={openProjectManagement} />}
        <CommissionWorkspace projectId={projectId} section={view === "requirements" ? "requirements" : "commissions"} hidden={!(["commissions", "requirements"] as View[]).includes(view)} onChanged={() => void refreshProject()} onStageChange={(stage) => setView(stage)} />
        <DeliveryWorkspace projectId={projectId} tasks={tasks} section={view === "notifications" ? "notifications" : "delivery"} hidden={!(["delivery", "notifications"] as View[]).includes(view)} onChanged={() => { void loadTasks(projectId, setTasks, setMessage); void refreshNotificationCount(); }} />
        {view === "settings" && settings}
        {view === "usage" && <UsageStatisticsWorkspace />}
        {view === "board" && <><div className="filters">
          <div className="view-switch" aria-label="看板显示方式"><button className={boardView === "board" ? "active" : ""} onClick={() => setBoardView("board")}>看板</button><button className={boardView === "list" ? "active" : ""} onClick={() => setBoardView("list")}>列表</button></div>
          <label>排序<select value={sort} onChange={(event) => setSort(event.target.value as TaskSort)}>{Object.entries(SORT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <button className="secondary compact" onClick={() => setDescending((value) => !value)} aria-label="切换排序方向">{descending ? "降序 ↓" : "升序 ↑"}</button>
          <label>搜索<input value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} placeholder="标题或描述" /></label>
          <label>状态<select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value as TaskFilters["status"] })}><option value="all">全部</option>{TASK_STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}</select></label>
          <label>负责人<select value={filters.owner} onChange={(event) => setFilters({ ...filters, owner: event.target.value as TaskFilters["owner"] })}><option value="all">全部</option><option value="human">人工</option><option value="ai">AI</option></select></label>
          <label>优先级<select value={filters.priority} onChange={(event) => setFilters({ ...filters, priority: event.target.value as TaskFilters["priority"] })}><option value="all">全部</option>{["none", "low", "medium", "high", "urgent"].map((priority) => <option key={priority}>{priority}</option>)}</select></label>
          <label>标签<select value={filters.label} onChange={(event) => setFilters({ ...filters, label: event.target.value })}><option value="">全部</option>{labels.map((label) => <option key={label}>{label}</option>)}</select></label>
          <label>委托<select value={filters.commission} onChange={(event) => setFilters({ ...filters, commission: event.target.value })}><option value="">全部</option>{commissions.map((id) => <option key={id} value={id}>{id.slice(0, 8)}</option>)}</select></label>
          <button className="secondary compact" onClick={() => setFilters(EMPTY_FILTERS)}>清除筛选</button>
        </div>{boardView === "board" ? <TaskBoard tasks={tasks} visibleTasks={visibleTasks} commissionTitles={commissionTitles} collapsed={collapsed} manual={sort === "manual"} sensors={sensors} onDragEnd={handleDragEnd} onToggle={toggleCollapsed} onOpen={openTask} /> : <TaskList tasks={visibleTasks} collapsed={collapsed} selected={selected} onToggle={toggleCollapsed} onSelect={setSelected} onArchive={(ids) => archiveTasks(ids)} onUnarchive={unarchiveTask} onOpen={openTask} />}</>}
      </section>
    </div>
    <TaskRunDialog dialog={taskDialog} task={taskDialogTask} tasks={tasks} runs={taskRuns} tokenRuns={taskTokenRuns} eventsByRun={taskRunEvents} busy={taskBusy} message={message} onClose={() => setTaskDialogTask(null)} onOpenTask={openTask} onProperties={(task) => { setPropertyError(""); setPropertyTask(task); }} onArchive={(task) => archiveTasks([task.id])} onUnarchive={unarchiveTask} onAction={taskAction} onSteer={steerRun} onAnswer={answerRunInput} onApprovals={() => { setTaskDialogTask(null); setView("notifications"); }} />
    <TaskPropertyDialog dialog={propertyDialog} task={propertyTask} busy={propertyBusy} error={propertyError} onClose={() => setPropertyTask(null)} onSubmit={saveTaskProperties} />
    <ProjectManagementDialog dialog={projectManagementDialog} project={managedProject} busy={projectManagementBusy} error={projectManagementError} onClose={() => setManagedProject(null)} onSubmit={saveManagedProject} onArchive={archiveManagedProject} />
  </section>;
}

function ProjectManagementPage({ projects, projectId, associate, onSelect, onManage }: { projects: Project[]; projectId: string; associate: ReactNode; onSelect(id: string): void; onManage(project: Project): void }) {
  return <section className="project-management-page">
    <header className="project-management-header"><div><p className="eyebrow">Projects</p><h2>项目管理</h2><p>切换当前工作项目，或管理本地目录关联。</p></div>{associate}</header>
    {projects.length ? <div className="commission-list">{projects.map((project) => {
      const active = project.id === projectId;
      return <article className="commission-card" key={project.id}>
        <button className="commission-card-main" onClick={() => onSelect(project.id)} aria-current={active ? "true" : undefined}>
          <span className="commission-card-title"><strong>{project.name}</strong>{active && <small>当前项目</small>}</span>
          <span className="commission-summary">{project.path}</span>
        </button>
        <button className="secondary" onClick={() => onManage(project)}>管理</button>
      </article>;
    })}</div> : <section className="empty-state"><h3>暂无关联项目</h3><p>使用右上角入口关联本地项目目录。</p></section>}
  </section>;
}

function ProjectManagementDialog({ dialog, project, busy, error, onClose, onSubmit, onArchive }: { dialog: React.RefObject<HTMLDialogElement | null>; project: Project | null; busy: boolean; error: string; onClose(): void; onSubmit(event: FormEvent<HTMLFormElement>): void; onArchive(): void }) {
  return <dialog ref={dialog} className="commission-dialog project-management-dialog" onClose={onClose}>
    <header className="commission-dialog-header"><div><p className="eyebrow">Project Management</p><h2>管理项目</h2>{project && <p>{project.name}</p>}</div><button type="button" className="secondary dialog-close" onClick={onClose}>关闭</button></header>
    {project && <form key={project.id} className="commission-dialog-body commission-form" onSubmit={onSubmit}>
      <label>项目名称<input name="name" defaultValue={project.name} required disabled={busy} /></label>
      <label>项目路径<input value={project.real_path || project.path} readOnly aria-readonly="true" /></label>
      {error && <p className="workspace-message" role="alert">{error}</p>}
      <div className="project-management-dialog-actions"><button type="button" className="project-unlink" disabled={busy} onClick={onArchive}>解除关联</button><span><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><button disabled={busy}>{busy ? "保存中…" : "保存名称"}</button></span></div>
    </form>}
  </dialog>;
}

function WorkspaceNav({ view, unreadNotifications, onChange }: { view: View; unreadNotifications: number; onChange(view: View): void }) {
  return <nav className="workspace-nav" aria-label="工作区分页">
    <p>工作区</p>
    {PAGES.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} aria-current={view === item.id ? "page" : undefined} onClick={() => onChange(item.id)}><span>{item.label}</span>{item.id === "notifications" && unreadNotifications > 0 && <span className="notification-badge" aria-label={unreadNotifications + " 条未处理通知"}>{unreadNotifications > 99 ? "99+" : unreadNotifications}</span>}</button>)}
    <button className={`workspace-nav-settings ${view === "settings" ? "active" : ""}`} aria-current={view === "settings" ? "page" : undefined} onClick={() => onChange("settings")}>设置</button>
  </nav>;
}

function TaskBoard({ tasks, visibleTasks, commissionTitles, collapsed, manual, sensors, onDragEnd, onToggle, onOpen }: { tasks: Task[]; visibleTasks: Task[]; commissionTitles: Map<string, string>; collapsed: Set<string>; manual: boolean; sensors: ReturnType<typeof useSensors>; onDragEnd(event: DragEndEvent): void; onToggle(id: string): void; onOpen(task: Task): void }) {
  const lanes = taskSwimlaneGroups(tasks, visibleTasks);
  const cards = [...lanes.active, ...lanes.archived].flatMap((lane) => lane.tasks);
  const archiveGroupCollapsed = collapsed.has(ARCHIVED_SWIMLANE_ID);
  const dragging = useRef(false);
  const finishDrag = (event?: DragEndEvent) => { if (event) onDragEnd(event); window.setTimeout(() => { dragging.current = false; }, 0); };
  const openCard = (task: Task) => { if (!dragging.current) onOpen(task); };
  return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={() => { dragging.current = true; }} onDragEnd={finishDrag} onDragCancel={() => finishDrag()}>
    <div className="swimlane-board">
      <div className="swimlane-statuses">{TASK_STATUSES.map((status) => <div key={status} className={`status-${status}`}><strong>{STATUS_LABELS[status]}</strong><span>{cards.filter((task) => task.status === status).length}</span></div>)}</div>
      {lanes.active.map((lane) => <TaskSwimlane key={lane.root.id} lane={lane} title={commissionTitles.get(lane.root.commission_id) ?? lane.root.title} collapsed={collapsed} manual={manual} onToggle={onToggle} onOpen={openCard} />)}
      {!lanes.active.length && !lanes.archived.length && <section className="empty-state"><p>没有符合当前筛选条件的任务。</p></section>}
      <section className="archived-swimlane-group">
        <button className="archived-swimlane-toggle" onClick={() => onToggle(ARCHIVED_SWIMLANE_ID)} aria-expanded={!archiveGroupCollapsed} aria-controls="archived-swimlanes">
          <span className="swimlane-chevron" aria-hidden="true">{archiveGroupCollapsed ? "▸" : "▾"}</span>
          <span><strong>归档泳道</strong><small>{lanes.archived.length} 个已归档任务组</small></span>
        </button>
        {!archiveGroupCollapsed && <div id="archived-swimlanes" className="archived-swimlanes">
          {lanes.archived.map((lane) => <TaskSwimlane key={lane.root.id} lane={lane} title={commissionTitles.get(lane.root.commission_id) ?? lane.root.title} collapsed={collapsed} manual={manual} onToggle={onToggle} onOpen={openCard} />)}
          {!lanes.archived.length && <p className="archived-swimlane-empty">暂无已归档的主任务。</p>}
        </div>}
      </section>
    </div>
  </DndContext>;
}

function TaskSwimlane({ lane, title, collapsed, manual, onToggle, onOpen }: { lane: ReturnType<typeof taskSwimlanes>[number]; title: string; collapsed: Set<string>; manual: boolean; onToggle(id: string): void; onOpen(task: Task): void }) {
  const isCollapsed = collapsed.has(lane.root.id);
  const contentId = `swimlane-${lane.root.id}`;
  return <section className="task-swimlane">
    <header className={`swimlane-heading status-${lane.root.status}`}>
      <button className="swimlane-toggle" onClick={() => onToggle(lane.root.id)} aria-expanded={!isCollapsed} aria-controls={contentId}>
        <span className="swimlane-chevron" aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
        <span className="swimlane-title"><small>委托任务组 · {lane.root.status === "archived" ? lane.total ? `${lane.total} 个子任务已归档` : "无子任务" : lane.total ? `${lane.done}/${lane.total} 个子任务完成` : "暂无子任务"}</small><strong>{title}</strong></span>
      </button>
    </header>
    {!isCollapsed && <div id={contentId} className="swimlane-columns">{TASK_STATUSES.map((status) => <SwimlaneColumn key={status} rootId={lane.root.id} status={status} tasks={lane.tasks} manual={manual} onOpen={onOpen} />)}</div>}
  </section>;
}

function SwimlaneColumn({ rootId, status, tasks, manual, onOpen }: { rootId: string; status: TaskStatus; tasks: Task[]; manual: boolean; onOpen(task: Task): void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${rootId}:${status}` });
  const drag = useDndContext();
  const columnTasks = tasks.filter((task) => task.status === status);
  const dragged = drag.active?.data.current?.task as Task | undefined;
  const overTask = drag.over?.data.current?.task as Task | undefined;
  const active = isOver || Boolean(overTask && overTask.status === status && tasks.some((task) => task.id === overTask.id));
  const valid = !dragged || canDropTask(dragged, status, tasks);
  return <section ref={setNodeRef} className={`swimlane-column status-${status} ${active ? `drop-active ${valid ? "drop-valid" : "drop-invalid"}` : ""}`} aria-label={`${STATUS_LABELS[status]} 列`}>
    <SortableContext items={columnTasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
      {columnTasks.map((task) => <TaskCard key={task.id} task={task} manual={manual} onOpen={onOpen} />)}
      {!columnTasks.length && <p className="drop-hint">拖到此列</p>}
    </SortableContext>
  </section>;
}

function TaskCard({ task, manual, onOpen }: { task: Task; manual: boolean; onOpen(task: Task): void }) {
  const sortable = useSortable({ id: task.id, disabled: task.status === "archived", data: { task } });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  return <article ref={sortable.setNodeRef} style={style} className={`task-card ${sortable.isDragging ? "dragging" : ""}`} id={`task-${task.id}`} {...sortable.attributes} {...sortable.listeners} onClick={(event) => { const target = event.target as HTMLElement; if (target.closest(".task-card") === event.currentTarget && !target.closest("button, input, select, textarea, a")) onOpen(task); }} onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === "Enter") { event.preventDefault(); onOpen(task); } }} title={manual ? "单击查看详情，按住后拖动任务" : "单击查看详情，按住后跨列移动"}>
    <div className="task-card-heading">
      <div><strong>{task.number_path} {task.title}</strong><p>{task.description || "无描述"}</p></div>
    </div>
    <TaskMeta task={task} />
  </article>;
}

function TaskPropertyDialog({ dialog, task, busy, error, onClose, onSubmit }: { dialog: React.RefObject<HTMLDialogElement | null>; task: Task | null; busy: boolean; error: string; onClose(): void; onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> }) {
  return <dialog ref={dialog} className="commission-dialog task-property-dialog" onClose={onClose}>
    <header className="commission-dialog-header"><div><p className="eyebrow">Task Properties</p><h2>任务属性</h2>{task && <p>{task.number_path} {task.title}</p>}</div><button type="button" className="secondary dialog-close" onClick={onClose}>关闭</button></header>
    {task && <form key={task.id} className="commission-dialog-body commission-form" onSubmit={(event) => void onSubmit(event)}>
      <label>负责人<select name="ownerType" defaultValue={task.owner_type}><option value="ai">AI</option><option value="human">人工</option></select></label>
      <label>优先级<select name="priority" defaultValue={task.priority}><option value="none">无</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="urgent">紧急</option></select></label>
      <label>截止日期<input name="dueDate" type="date" defaultValue={task.due_date ?? ""} /></label>
      <label className="task-permission-option"><span><input name="autoApprovePermissions" type="checkbox" defaultChecked={Boolean(task.auto_approve_permissions)} />自动审批 Agent 沙盒权限请求</span><small>仅自动批准沙盒权限；命令、文件修改和高风险操作仍需人工审批。</small></label>
      {error && <p className="workspace-message" role="alert">保存失败：{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" disabled={busy}>{busy ? "保存中…" : "保存属性"}</button></div>
    </form>}
  </dialog>;
}

function TaskList({ tasks, collapsed, selected, onToggle, onSelect, onArchive, onUnarchive, onOpen }: { tasks: Task[]; collapsed: Set<string>; selected: Set<string>; onToggle(id: string): void; onSelect(value: Set<string>): void; onArchive(ids: string[]): void; onUnarchive(task: Task): void; onOpen(task: Task): void }) {
  const rows = treeRoots(tasks);
  return <div className="list-view">
    <div className="bulk-bar"><span>已选择 {selected.size} 项</span><button disabled={!selected.size} onClick={() => onArchive([...selected])}>批量归档</button></div>
    <div className="task-table" role="treegrid"><div className="task-row task-row-head"><span>任务</span><span>状态</span><span>负责人</span><span>优先级</span><span>操作</span></div>{rows.map((task) => <TaskRow key={task.id} task={task} tasks={tasks} depth={0} collapsed={collapsed} selected={selected} onToggle={onToggle} onSelect={onSelect} onArchive={onArchive} onUnarchive={onUnarchive} onOpen={onOpen} />)}</div>
  </div>;
}

function TaskRow({ task, tasks, depth, collapsed, selected, onToggle, onSelect, onArchive, onUnarchive, onOpen }: { task: Task; tasks: Task[]; depth: number; collapsed: Set<string>; selected: Set<string>; onToggle(id: string): void; onSelect(value: Set<string>): void; onArchive(ids: string[]): void; onUnarchive(task: Task): void; onOpen(task: Task): void }) {
  const children = taskChildren(tasks, task.id);
  return <>
    <div className="task-row" role="row" style={{ "--depth": depth } as React.CSSProperties}>
      <span className="task-name"><input type="checkbox" checked={selected.has(task.id)} disabled={task.status !== "done"} onChange={(event) => { const next = new Set(selected); if (event.target.checked) next.add(task.id); else next.delete(task.id); onSelect(next); }} aria-label={`选择 ${task.title}`} />{children.length ? <button className="icon-button" onClick={() => onToggle(task.id)}>{collapsed.has(task.id) ? "▸" : "▾"}</button> : <span className="indent-spacer" />}<strong>{task.number_path} {task.title}</strong></span>
      <span><i className={`status-dot status-${task.status}`} />{STATUS_LABELS[task.status]}</span><span>{task.owner_type === "human" ? "人工" : "AI"}</span><span>{task.priority}</span><span className="task-row-actions"><button className="secondary compact" onClick={() => onOpen(task)}>查看与推进</button>{task.status === "done" && <button className="secondary compact" onClick={() => onArchive([task.id])}>归档</button>}{task.status === "archived" && <button className="secondary compact" onClick={() => onUnarchive(task)}>解除归档</button>}</span>
    </div>
    {!collapsed.has(task.id) && children.map((child) => <TaskRow key={child.id} task={child} tasks={tasks} depth={depth + 1} collapsed={collapsed} selected={selected} onToggle={onToggle} onSelect={onSelect} onArchive={onArchive} onUnarchive={onUnarchive} onOpen={onOpen} />)}
  </>;
}

function TaskRunDialog({ dialog, task, tasks, runs, tokenRuns, eventsByRun, busy, message, onClose, onOpenTask, onProperties, onArchive, onUnarchive, onAction, onSteer, onAnswer, onApprovals }: { dialog: React.RefObject<HTMLDialogElement | null>; task: Task | null; tasks: Task[]; runs: Run[]; tokenRuns: Run[]; eventsByRun: Record<string, RunEvent[]>; busy: boolean; message: string; onClose(): void; onOpenTask(task: Task): Promise<void>; onProperties(task: Task): void; onArchive(task: Task): void; onUnarchive(task: Task): void; onAction(path: "trigger" | "pause" | "resume" | "cancel", success: string): Promise<void>; onSteer(event: FormEvent<HTMLFormElement>): Promise<void>; onAnswer(event: FormEvent<HTMLFormElement>, requestId: string, questions: RunQuestion[]): Promise<void>; onApprovals(): void }) {
  const [activeTab, setActiveTab] = useState<"comments" | "runs" | "changes">("comments");
  const [openRunIds, setOpenRunIds] = useState<Set<string>>(new Set());
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentError, setCommentError] = useState("");
  useEffect(() => {
    setActiveTab("comments");
    setCommentError("");
    if (!task) return setComments([]);
    let current = true;
    const load = () => void api<TaskComment[]>(`/api/tasks/${task.id}/comments`).then((items) => { if (current) setComments(items); }).catch((error: Error) => { if (current && !comments.length) setCommentError(error.message); });
    load();
    const timer = window.setInterval(load, 2000);
    return () => { current = false; window.clearInterval(timer); };
  }, [task?.id]);
  useEffect(() => setOpenRunIds(new Set(runs[0] ? [runs[0].id] : [])), [task?.id, runs[0]?.id]);
  const latest = runs[0];
  const active = latest && ["queued", "preparing", "running", "waiting_approval", "waiting_input"].includes(latest.status);
  const controllable = latest && ["preparing", "running", "waiting_approval", "waiting_input"].includes(latest.status);
  const treeActive = !task?.parent_id && tokenRuns.some((run) => ["queued", "preparing", "running", "waiting_approval", "waiting_input"].includes(run.status));
  const unfinishedChildren = task && !task.parent_id && tasks.some((item) => item.commission_id === task.commission_id && item.id !== task.id && item.status !== "done" && item.status !== "archived");
  const canTrigger = task && task.status !== "done" && task.status !== "archived" && latest?.status !== "interrupted" && (task.parent_id ? ["backlog", "todo", "in_progress", "blocked"].includes(task.status) : unfinishedChildren && !treeActive && ["backlog", "todo", "in_progress", "blocked"].includes(task.status));
  const events = latest ? eventsByRun[latest.id] ?? [] : [];
  const inputEvent = [...events].reverse().find((event) => event.event_type === "input.requested");
  const questions = runQuestions(inputEvent);
  const requestId = String(inputEvent?.payload.requestId ?? "");
  const codeChanges = runs.flatMap((run, index) => runCodeChanges(eventsByRun[run.id] ?? []).map((change) => ({ run, change, current: index === 0 })));
  async function submitComment(event: FormEvent<HTMLFormElement>): Promise<boolean> {
    event.preventDefault();
    if (!task) return false;
    const form = event.currentTarget;
    const data = new FormData(form);
    const content = String(data.get("content") ?? "").trim();
    if (!content) return false;
    setCommentBusy(true); setCommentError("");
    try {
      const comment = await api<CommentPostResponse>(`/api/tasks/${task.id}/comments`, { method: "POST", body: JSON.stringify({ content, parentId: data.get("parentId") || null }) });
      setComments((current) => [...current, comment]);
      form.reset();
      if (comment.agentMention?.action === "unavailable") setCommentError(`评论已保存，但 Agent 未响应：${comment.agentMention.message ?? "当前不可用"}`);
      return true;
    } catch (error) { setCommentError((error as Error).message); return false; }
    finally { setCommentBusy(false); }
  }
  async function deleteComment(comment: TaskComment) {
    if (!task || !window.confirm("删除这条评论？其回复会保留。")) return;
    setCommentError("");
    try {
      await api(`/api/tasks/${task.id}/comments/${comment.id}`, { method: "DELETE" });
      setComments((current) => current.map((item) => item.id === comment.id ? { ...item, content: "", deleted_at: new Date().toISOString() } : item));
    } catch (error) { setCommentError((error as Error).message); }
  }
  return <dialog ref={dialog} className="commission-dialog task-run-dialog" onClose={onClose}>
    <header className="commission-dialog-header"><div><p className="eyebrow">Task Execution</p><h2>任务运行</h2>{task && <p>{task.number_path} {task.title}</p>}</div><div className="task-run-header-actions">{task && task.status !== "archived" && <button className="secondary" onClick={() => onProperties(task)}>任务属性</button>}<button className="secondary dialog-close" onClick={onClose}>关闭</button></div></header>
    {task && <div className="task-run-layout commission-dialog-body">
    <main className="task-run-content">
      <div className="task-run-summary"><span className={`status-pill status-${task.status}`}>{STATUS_LABELS[task.status]}</span><span>{task.owner_type === "human" ? "人工任务" : "AI 任务"}</span><span>{latest ? `Run #${latest.attempt_no} · ${latest.role} · ${latest.status}` : "尚未运行"}</span>{latest && active && <RunElapsedTimer run={latest} />}</div>
      <TaskTokenSummary runs={tokenRuns} tree={!task.parent_id} />
      <p>{task.description || "无任务描述。"}</p>
      <div className="task-run-actions">
        {!active && latest?.status === "interrupted" && <button disabled={busy} onClick={() => void onAction("resume", "任务已恢复执行。")}>恢复执行</button>}
        {!active && canTrigger && <button disabled={busy} onClick={() => void onAction("trigger", task.parent_id ? "任务已启动。" : "已触发当前可运行的子任务。")}>{task.status === "blocked" ? "重新执行" : !task.parent_id && task.status === "in_progress" ? "继续执行" : "启动执行"}</button>}
        {controllable && <><button disabled={busy} onClick={() => void onAction("pause", "任务已暂停，可稍后恢复。")}>暂停</button><button className="secondary" disabled={busy} onClick={() => void onAction("cancel", "当前 Run 已取消。")}>取消 Run</button></>}
        {latest?.status === "waiting_approval" && <button onClick={onApprovals}>前往处理审批</button>}
        {task.status === "done" && <button className="secondary" disabled={busy} onClick={() => onArchive(task)}>{task.parent_id ? "归档任务" : "归档任务组"}</button>}
        {task.status === "archived" && <button className="secondary" disabled={busy} onClick={() => onUnarchive(task)}>{task.parent_id ? "解除归档" : "解除任务组归档"}</button>}
      </div>
      {active && latest?.status !== "waiting_input" && <form className="task-steer-form" onSubmit={onSteer}><input name="message" autoComplete="off" placeholder="向当前 Agent 补充指令" required disabled={busy} /><button className="secondary" disabled={busy}>发送介入</button></form>}
      {latest?.status === "waiting_input" && requestId && questions.length > 0 && <form className="run-input-form" onSubmit={(event) => void onAnswer(event, requestId, questions)}><h3>Agent 等待你的输入</h3>{questions.map((question) => <fieldset key={question.id}><legend>{question.header || question.question}</legend>{question.options.length ? question.options.map((option) => <label key={option.label}><input type="radio" name={question.id} value={option.label} required disabled={busy} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>) : <label>{question.question}<input name={question.id} required disabled={busy} /></label>}</fieldset>)}<button disabled={busy}>提交并继续</button></form>}
      {latest?.failure_summary && <p className="workspace-message" role="alert">失败原因：{latest.failure_summary}</p>}
      {message && <p className="workspace-message" role="status">{message}</p>}
    </main>
    <section className="task-run-tabs">
      <div className="task-run-tab-list" role="tablist" aria-label="任务协作记录">
        {([['comments', '评论'], ['runs', '运行记录'], ['changes', '修改记录']] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={activeTab === id} className={activeTab === id ? "active" : ""} onClick={() => setActiveTab(id)}>{label}{id === "comments" && comments.length > 0 ? ` ${comments.length}` : id === "runs" && runs.length > 0 ? ` ${runs.length}` : id === "changes" && codeChanges.length > 0 ? ` ${codeChanges.length}` : ""}</button>)}
      </div>
      <div className="task-run-tab-panel" role="tabpanel">
        {activeTab === "comments" && <TaskComments comments={comments} tasks={tasks.filter((item) => item.commission_id === task.commission_id)} mentionTasks={tasks.filter((item) => item.commission_id === task.commission_id && item.status !== "archived")} readOnly={task.status === "archived"} busy={commentBusy} error={commentError} onSubmit={submitComment} onDelete={deleteComment} onOpenTask={onOpenTask} />}
        {activeTab === "runs" && <div className="run-records">{runs.length ? runs.map((run, index) => <RunTimelineGroup key={run.id} run={run} events={eventsByRun[run.id] ?? []} current={index === 0} open={openRunIds.has(run.id)} onToggle={(nextOpen) => setOpenRunIds((current) => { const next = new Set(current); if (nextOpen) next.add(run.id); else next.delete(run.id); return next; })} />) : <p className="task-tab-empty">启动任务后可在这里跟进执行过程。</p>}</div>}
        {activeTab === "changes" && <CodeChanges changes={codeChanges} />}
      </div>
    </section>
    </div>}
  </dialog>;
}

function TaskComments({ comments, tasks, mentionTasks, readOnly, busy, error, onSubmit, onDelete, onOpenTask }: { comments: TaskComment[]; tasks: Task[]; mentionTasks: Task[]; readOnly: boolean; busy: boolean; error: string; onSubmit(event: FormEvent<HTMLFormElement>): Promise<boolean>; onDelete(comment: TaskComment): Promise<void>; onOpenTask(task: Task): Promise<void> }) {
  const [replyTo, setReplyTo] = useState<TaskComment | null>(null);
  const [mention, setMention] = useState<MentionTrigger | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const mentionOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [avatars, setAvatars] = useState<AvatarSettings>(DEFAULT_AVATARS);
  const rows = commentThreadRows(comments);
  useEffect(() => {
    void fetch("/api/settings").then(async (response) => { if (response.ok) setAvatars(avatarSettings(await response.json())); }).catch(() => undefined);
    const update = (event: Event) => setAvatars(avatarSettings((event as CustomEvent<AvatarSettings>).detail));
    window.addEventListener(AVATAR_SETTINGS_EVENT, update);
    return () => window.removeEventListener(AVATAR_SETTINGS_EVENT, update);
  }, []);
  const mentionOptions = useMemo(() => {
    const options = [
      { id: "role-agent", group: "角色", value: "@Agent", label: "AI Agent", description: "执行或介入当前任务" },
      ...mentionTasks.map((task) => ({ id: task.id, group: "任务", value: `@任务${task.number_path}`, label: `${task.number_path} ${task.title}`, description: "跳转到该任务" }))
    ];
    const query = mention?.query.toLocaleLowerCase() ?? "";
    return query ? options.filter((option) => `${option.value} ${option.label}`.toLocaleLowerCase().includes(query)) : options;
  }, [mention?.query, mentionTasks]);
  useEffect(() => {
    if (mention) mentionOptionRefs.current[mentionIndex]?.scrollIntoView({ block: "nearest" });
  }, [mention, mentionIndex]);
  const submit = async (event: FormEvent<HTMLFormElement>) => { if (await onSubmit(event)) { setReplyTo(null); setMention(null); } };
  const refreshMention = (target: HTMLTextAreaElement) => {
    setMention(mentionTriggerAtCursor(target.value, target.selectionStart ?? target.value.length));
    setMentionIndex(0);
  };
  const chooseMention = (value: string) => {
    const target = textarea.current;
    if (!target || !mention) return;
    const next = insertMention(target.value, mention, target.selectionStart ?? target.value.length, value);
    target.value = next.content;
    setMention(null);
    window.requestAnimationFrame(() => { target.focus(); target.setSelectionRange(next.cursor, next.cursor); });
  };
  return <div className="task-comments">
    <div className="task-comment-list">{rows.length ? rows.map(({ comment, depth }) => <article key={comment.id} className={`task-comment comment-${comment.author_type}`} style={{ "--comment-depth": Math.min(depth, 4) } as React.CSSProperties}>
      <CommentAvatar value={comment.author_type === "human" ? avatars.humanAvatar : comment.author_type === "agent" ? avatars.agentAvatar : "系"} />
      <div className={`comment-card ${comment.deleted_at ? "deleted" : ""}`}><header><span><strong>{comment.author_type === "human" ? "人工负责人" : comment.agent_role ? ROLE_LABELS[comment.agent_role] ?? comment.agent_role : comment.author_type === "agent" ? "AI Agent" : "系统"}</strong>{comment.author_type === "agent" && <small>Agent</small>}{comment.run_id && <small>Run</small>}</span><time>{new Date(comment.created_at).toLocaleString()}</time></header>{comment.deleted_at ? <p className="comment-deleted">评论已删除</p> : <CommentMarkdown content={comment.content} tasks={tasks} onOpenTask={onOpenTask} />}{!readOnly && !comment.deleted_at && <footer><button type="button" className="comment-reply" onClick={() => { setReplyTo(comment); window.setTimeout(() => textarea.current?.focus(), 0); }}>回复</button><button type="button" className="comment-delete" onClick={() => void onDelete(comment)}>删除</button></footer>}</div>
    </article>) : <p className="task-tab-empty">{readOnly ? "该归档任务没有历史评论。" : "暂无评论，输入一条协作信息开始讨论。"}</p>}</div>
    {readOnly ? <p className="task-tab-empty">归档任务的评论为只读，历史记录仍会保留。</p> : <form className="task-comment-form" onSubmit={(event) => void submit(event)}>
      {replyTo && <div className="comment-replying"><span>回复 {replyTo.author_type === "human" ? "人工负责人" : replyTo.agent_role ? ROLE_LABELS[replyTo.agent_role] ?? replyTo.agent_role : "系统"}：{replyTo.content.slice(0, 60)}</span><button type="button" className="secondary compact" onClick={() => setReplyTo(null)}>取消回复</button></div>}
      <input type="hidden" name="parentId" value={replyTo?.id ?? ""} />
      <div className="task-comment-editor">
        <textarea ref={textarea} name="content" rows={3} autoComplete="off" placeholder={replyTo ? "写下回复，输入 @ 提及角色或任务…" : "发起新评论，输入 @ 提及角色或任务…"} required disabled={busy} aria-autocomplete="list" aria-expanded={Boolean(mention)} aria-controls={mention ? "task-mention-menu" : undefined} aria-activedescendant={mention && mentionOptions[mentionIndex] ? `task-mention-option-${mentionIndex}` : undefined} onChange={(event) => refreshMention(event.currentTarget)} onClick={(event) => refreshMention(event.currentTarget)} onBlur={() => window.setTimeout(() => setMention(null), 100)} onKeyDown={(event) => {
          if (!mention) return;
          if (event.key === "Escape") { event.preventDefault(); setMention(null); return; }
          if (!mentionOptions.length) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setMentionIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + mentionOptions.length) % mentionOptions.length); }
          else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); chooseMention(mentionOptions[mentionIndex]?.value ?? mentionOptions[0]!.value); }
        }} />
        {mention && <div id="task-mention-menu" className="task-mention-menu" role="listbox" aria-label="选择要提及的角色或任务">
          {mentionOptions.length ? ["角色", "任务"].map((group) => { const items = mentionOptions.filter((option) => option.group === group); return items.length ? <div key={group} role="group" aria-label={group}><strong>{group}</strong>{items.map((option) => { const index = mentionOptions.indexOf(option); return <button ref={(element) => { mentionOptionRefs.current[index] = element; }} id={`task-mention-option-${index}`} key={option.id} type="button" role="option" aria-selected={index === mentionIndex} className={index === mentionIndex ? "active" : ""} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseMention(option.value)} onMouseEnter={() => setMentionIndex(index)}><span>{option.value}</span><small>{option.label} · {option.description}</small></button>; })}</div> : null; }) : <p>没有匹配的角色或任务</p>}
        </div>}
      </div>
      <button className="task-comment-submit" disabled={busy}>{busy ? "发送中…" : replyTo ? "回复" : "评论"}</button>
      {error && <p className="workspace-message" role="alert">{error}</p>}
    </form>}
  </div>;
}

function CommentAvatar({ value }: { value: string }) {
  return <span className="comment-avatar" aria-hidden="true">{isImageAvatar(value) ? <img src={value} alt="" /> : value}</span>;
}

function CommentMarkdown({ content, tasks, onOpenTask }: { content: string; tasks: Task[]; onOpenTask(task: Task): Promise<void> }) {
  const review = parseReviewComment(content);
  const mentions = (children: ReactNode) => <CommentMentionText tasks={tasks} onOpenTask={onOpenTask}>{children}</CommentMentionText>;
  const markdown = <ReactMarkdown components={{
    p: ({ children }) => <p>{mentions(children)}</p>,
    h1: ({ children }) => <h1>{mentions(children)}</h1>,
    h2: ({ children }) => <h2>{mentions(children)}</h2>,
    h3: ({ children }) => <h3>{mentions(children)}</h3>,
    h4: ({ children }) => <h4>{mentions(children)}</h4>,
    li: ({ children }) => <li>{mentions(children)}</li>,
    strong: ({ children }) => <strong>{mentions(children)}</strong>,
    em: ({ children }) => <em>{mentions(children)}</em>,
    blockquote: ({ children }) => <blockquote>{mentions(children)}</blockquote>,
    a: ({ children, href }) => commentLinkUrl(href) ? <a href={href} target="_blank" rel="noreferrer">{mentions(children)}</a> : <>{mentions(children)}</>
  }}>{review?.markdown ?? content}</ReactMarkdown>;
  return <div className="comment-markdown">{markdown}{review && <ReviewFindings findings={review.findings} />}</div>;
}

function ReviewFindings({ findings }: { findings: ReviewFinding[] }) {
  return <section className="review-findings" aria-label="审查发现"><h3>发现</h3><ul>{findings.map((finding, index) => <li key={`${finding.file ?? "general"}:${finding.line ?? 0}:${index}`} className={`review-finding review-finding-${finding.severity}`}><header><strong>{finding.severity === "blocking" ? "阻塞" : "警告"}</strong>{finding.file && <code>{finding.file}{finding.line === null ? "" : `:${finding.line}`}</code>}</header><p>{finding.message}</p></li>)}</ul></section>;
}

function CommentMentionText({ children, tasks, onOpenTask }: { children: ReactNode; tasks: Task[]; onOpenTask(task: Task): Promise<void> }) {
  return <>{Children.map(children, (child) => typeof child !== "string" ? child : commentMentionParts(child).map((part, index) => {
    if (typeof part === "string") return <span key={index}>{part}</span>;
    if (part.kind === "role") return <span key={index} className="comment-mention comment-role-mention">{part.label}</span>;
    const target = tasks.find((task) => task.number_path === part.numberPath);
    return target ? <button key={index} type="button" className="comment-mention task-mention-link" onClick={() => void onOpenTask(target)}>{part.label}</button> : <span key={index} className="comment-mention task-mention-link">{part.label}</span>;
  }))}</>;
}

function CodeChanges({ changes }: { changes: Array<{ run: Run; change: CodeChange; current: boolean }> }) {
  const kindLabels: Record<string, string> = { add: "新增", update: "修改", delete: "删除", move: "移动" };
  return <div className="code-change-list">{changes.length ? changes.map(({ run, change, current }) => <article key={`${run.id}-${change.path}`} className="code-change-record">
    <header><span><small>{current ? "当前执行" : "历史执行"} · Run #{run.attempt_no} · {kindLabels[change.kind] ?? change.kind}</small><strong>{change.path}</strong>{change.movePath && <small>移动自 {change.movePath}</small>}</span><time>{new Date(change.event.created_at).toLocaleString()}</time></header>
    {change.diff ? <pre className="code-diff" aria-label={`${change.path} 的代码差异`}>{diffLines(change.diff).map((line, index) => <span key={index} className={`diff-${line.kind}`}>{line.text || " "}</span>)}</pre> : <p>Agent 已报告文件变化，但未提供 Diff。</p>}
  </article>) : <p className="task-tab-empty">Agent 修改文件后，最新 Diff 会显示在这里。</p>}</div>;
}

function RunTimelineGroup({ run, events, current, open, onToggle }: { run: Run; events: RunEvent[]; current: boolean; open: boolean; onToggle(open: boolean): void }) {
  const timelineEvents = runTimelineEvents(events);
  const tokens = tokenUsageTotals([run]);
  const price = tokenPrice([run]);
  return <section className={`run-record ${open ? "open" : ""}`}>
    <button className="run-record-toggle" aria-expanded={open} onClick={() => onToggle(!open)}>
      <span className="run-record-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
      <span><small>{current ? "当前执行" : "历史执行"}</small><strong>Run #{run.attempt_no} · {run.role}</strong><RunRecordDuration run={run} /><small className="run-record-tokens" title={tokens ? `输入 ${formatTokenCount(tokens.input)}，输出 ${formatTokenCount(tokens.output)}，缓存 ${formatTokenCount(tokens.cached)}` : undefined}>Token {tokens ? formatTokenCount(tokens.total) : "—"} · {price === null ? "价格不可用" : `约 ${formatTokenPrice(price)}`}</small></span>
      <span className={`run-record-status status-${run.status}`}>{RUN_STATUS_LABELS[run.status] ?? run.status}</span>
    </button>
    {open && <div className="run-timeline">{timelineEvents.length ? timelineEvents.map((event) => <RunTimelineEvent key={event.id} event={event} />) : <p>此 Run 尚未产生事件。</p>}</div>}
  </section>;
}

function TaskTokenSummary({ runs, tree }: { runs: Run[]; tree: boolean }) {
  const tokens = tokenUsageTotals(runs);
  const price = tokenPrice(runs);
  const label = tree ? "任务树 Token" : "任务 Token";
  return <section className="task-token-summary" aria-label={`${label} 使用统计`}><strong>{label}</strong>{tokens ? <dl>{([['总计', formatTokenCount(tokens.total)], ['输入', formatTokenCount(tokens.input)], ['输出', formatTokenCount(tokens.output)], ['缓存', formatTokenCount(tokens.cached)], ['估算价格', price === null ? '不可用' : formatTokenPrice(price)]] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : <span>暂无统计</span>}</section>;
}

function RunRecordDuration({ run }: { run: Run }) {
  const active = ["queued", "preparing", "running", "waiting_approval", "waiting_input"].includes(run.status);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, run.id]);
  const startedAt = run.started_at ? Date.parse(run.started_at) : Number.NaN;
  const finishedAt = run.finished_at ? Date.parse(run.finished_at) : Number.NaN;
  if (!Number.isFinite(startedAt)) return <small className="run-record-duration">持续时间 --:--:--</small>;
  const endedAt = !active && Number.isFinite(finishedAt) ? finishedAt : now;
  return <small className="run-record-duration">持续时间 {formatRunDuration(endedAt - startedAt)}</small>;
}

function RunElapsedTimer({ run }: { run: Run }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run.id]);
  const parsedStartedAt = run.started_at ? Date.parse(run.started_at) : Number.NaN;
  const startedAt = Number.isFinite(parsedStartedAt) ? parsedStartedAt : now;
  return <span className="run-timer" role="timer" aria-label="Agent 运行时长">运行时长 {formatRunDuration(now - startedAt)}</span>;
}

function RunTimelineEvent({ event }: { event: RunEvent }) {
  const detail = runEventDetail(event);
  const agentMessage = event.event_type === "agent.message.delta";
  return <article><time>{new Date(event.created_at).toLocaleString()}</time><strong>{event.summary}</strong><small>{event.event_type}</small>{detail && (agentMessage && !isLongRunEventDetail(detail) ? <p>{detail}</p> : <details className="run-event-detail"><summary><span>{agentMessage ? detail : "查看详情"}</span></summary><p>{detail}</p></details>)}</article>;
}

function TaskMeta({ task }: { task: Task }) {
  const run = task.latestRunStatus;
  const runLabel = run === "queued" ? "等待运行" : run === "preparing" ? "正在准备" : run === "running" ? "正在运行" : run === "waiting_approval" ? "等待审批" : run === "waiting_input" ? "等待输入" : "";
  return <div className="task-meta"><span className={`status-pill status-${task.status}`}>{STATUS_LABELS[task.status]}</span>{runLabel && <span className={`run-indicator run-${run}`}><i aria-hidden="true" />{runLabel}</span>}<span>{task.owner_type === "human" ? "人工" : "AI"}</span><span className={`priority priority-${task.priority}`}>{task.priority}</span>{task.due_date && <span>截止 {task.due_date}</span>}{task.labels.map((label) => <span key={label.id} className="label-chip"><i style={{ background: label.color }} />{label.name}</span>)}</div>;
}

function focusTask(id: string) {
  const element = document.getElementById(`task-${id}`);
  element?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  element?.classList.add("highlighted");
  window.setTimeout(() => element?.classList.remove("highlighted"), 1800);
}

async function loadTasks(projectId: string, setTasks: (tasks: Task[]) => void, setMessage: (message: string) => void, setLoading?: (loading: boolean) => void) {
  setLoading?.(true);
  try { setTasks(await api<Task[]>(`/api/projects/${projectId}/tasks?includeArchived=true`)); }
  catch (error) { setMessage((error as Error).message); }
  finally { setLoading?.(false); }
}

async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init?.body ? { ...init, headers: { "Content-Type": "application/json", ...init.headers } } : init);
  if (response.ok) return response.status === 204 ? undefined as T : await response.json() as T;
  const result = await response.json().catch(() => ({})) as { message?: string; error?: string };
  throw new Error(result.message || result.error || `请求失败 (${response.status})`);
}
