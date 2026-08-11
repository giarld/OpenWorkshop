import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";

export type NotificationKind = "completed" | "blocked" | "approval" | "acceptance" | "mention";

export function notify(database: DatabaseSync, kind: NotificationKind, title: string, body: string, entityType: "task" | "approval", entityId: string): void {
  database.prepare("INSERT INTO notifications (id, kind, title, body, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), kind, title, body, entityType, entityId, new Date().toISOString());
}

export function registerNotificationRoutes(server: FastifyInstance, database: DatabaseSync): void {
  server.get<{ Querystring: { unread?: string } }>("/api/notifications", async (request) =>
    database.prepare(`SELECT * FROM notifications${request.query.unread === "true" ? " WHERE read_at IS NULL" : ""} ORDER BY created_at DESC`).all());

  server.post<{ Params: { id: string } }>("/api/notifications/:id/read", async (request) => {
    const result = database.prepare("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?").run(new Date().toISOString(), request.params.id);
    if (!result.changes) throw Object.assign(new Error("Notification not found"), { statusCode: 404 });
    return database.prepare("SELECT * FROM notifications WHERE id = ?").get(request.params.id);
  });

  server.delete("/api/notifications/history", async () => {
    const result = database.prepare(`
      DELETE FROM notifications
      WHERE NOT (
        entity_type = 'approval' AND EXISTS (
          SELECT 1 FROM approvals WHERE approvals.id = notifications.entity_id AND approvals.status = 'pending'
        )
      )
    `).run();
    return { deleted: Number(result.changes) };
  });
}
