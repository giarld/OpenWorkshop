import type { DatabaseSync } from "node:sqlite";

export function allocateProjectTaskNumber(database: DatabaseSync, projectId: string): string {
  const row = database.prepare(`INSERT INTO project_task_sequences (project_id, next_number) VALUES (?, 2)
    ON CONFLICT(project_id) DO UPDATE SET next_number = next_number + 1
    RETURNING next_number - 1 AS number`).get(projectId) as { number: number };
  return String(row.number);
}

export function renumberTaskTree(database: DatabaseSync, commissionId: string): void {
  const root = database.prepare(`SELECT task.id, task.number_path FROM commissions AS commission
    JOIN tasks AS task ON task.id = commission.main_task_id WHERE commission.id = ?`).get(commissionId) as { id: string; number_path: string } | undefined;
  if (!root) return;
  const rows = database.prepare(`SELECT id, parent_id, position FROM tasks
    WHERE commission_id = ? AND archived_at IS NULL ORDER BY position, created_at, rowid`).all(commissionId) as Array<{ id: string; parent_id: string | null; position: number }>;
  const children = new Map<string | null, typeof rows>();
  for (const row of rows) children.set(row.parent_id, [...(children.get(row.parent_id) ?? []), row]);
  const update = database.prepare("UPDATE tasks SET number_path = ? WHERE id = ?");
  const visit = (parentId: string | null, prefix: string) => (children.get(parentId) ?? []).forEach((task, index) => {
    const number = prefix ? `${prefix}.${index + 1}` : `${index + 1}`;
    if (task.position !== index) database.prepare("UPDATE tasks SET position = ? WHERE id = ?").run(index, task.id);
    update.run(number, task.id);
    visit(task.id, number);
  });
  visit(root.id, root.number_path);
}
