import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { notify } from "./notifications.ts";

export type CommentAuthor = "human" | "agent" | "system";
export type AgentMentionResult = { action: "steered" | "queued" | "triggered" | "unavailable"; runId?: string; message?: string };
export type AgentMentionHandler = ((taskId: string, message: string, attachmentIds?: readonly string[]) => Promise<AgentMentionResult>) & {
  cancelTaskRun?: (taskId: string) => Promise<boolean>;
  coordinateTask?: (taskId: string) => Promise<unknown>;
  coordinateFinal?: (commissionId: string) => Promise<boolean>;
  reviseTaskPlan?: (revisionId: string) => Promise<unknown>;
};

export function mentionsAgent(content: string): boolean {
  return /@(agent|ai(?:\s+agent)?)(?=\s|[，。！？、:：]|$)/i.test(content);
}

type CommentInput = { taskId: string; authorType: CommentAuthor; content: string; agentRole?: string | null; kind?: "normal" | "rejection" | "blocker" | "approval" | "waiver"; parentId?: string | null; runId?: string | null };

export function addTaskComment(database: DatabaseSync, input: CommentInput) {
  const task = database.prepare("SELECT id, title FROM tasks WHERE id = ? AND archived_at IS NULL").get(input.taskId) as { id: string; title: string } | undefined;
  if (!task) throw statusError("Task not found", 404);
  if (input.parentId && !database.prepare("SELECT 1 FROM comments WHERE id = ? AND task_id = ?").get(input.parentId, task.id)) throw statusError("Parent comment must belong to the same task", 400);
  const id = randomUUID();
  database.prepare("INSERT INTO comments (id, task_id, parent_id, run_id, author_type, agent_role, kind, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, task.id, input.parentId ?? null, input.runId ?? null, input.authorType, input.agentRole ?? null, input.kind ?? "normal", input.content, new Date().toISOString());
  if (input.authorType === "agent" && /@(负责人|人类负责人|人工负责人|human)(?=\s|[，。！？、:：]|$)/i.test(input.content)) {
    notify(database, "mention", `AI 提及你：${task.title}`, input.content.slice(0, 240), "task", task.id);
  }
  return database.prepare("SELECT * FROM comments WHERE id = ?").get(id) as Record<string, unknown>;
}

export function addRunCommentOnce(database: DatabaseSync, input: CommentInput & { runId: string }) {
  const existing = database.prepare("SELECT * FROM comments WHERE run_id = ? AND author_type = ? AND COALESCE(agent_role, '') = ? AND content = ? LIMIT 1")
    .get(input.runId, input.authorType, input.agentRole ?? "", input.content) as Record<string, unknown> | undefined;
  return existing ?? addTaskComment(database, input);
}

export function addMainTaskComment(database: DatabaseSync, input: { sourceTaskId: string; content: string; kind?: "normal" | "blocker"; runId?: string }) {
  const source = database.prepare("SELECT task.number_path, task.title, commission.main_task_id FROM tasks task JOIN commissions commission ON commission.id = task.commission_id WHERE task.id = ?")
    .get(input.sourceTaskId) as { number_path: string; title: string; main_task_id: string | null } | undefined;
  if (!source?.main_task_id || source.main_task_id === input.sourceTaskId) return undefined;
  const comment: CommentInput = { taskId: source.main_task_id, authorType: "system", kind: input.kind ?? "normal", content: `@任务${source.number_path} ${source.title}\n\n${input.content}`, ...(input.runId ? { runId: input.runId } : {}) };
  return input.runId ? addRunCommentOnce(database, { ...comment, runId: input.runId }) : addTaskComment(database, comment);
}

function statusError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}
