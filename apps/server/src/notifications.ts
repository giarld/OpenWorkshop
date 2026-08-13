import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";

export type NotificationKind = "completed" | "blocked" | "approval" | "acceptance" | "mention";

type PendingSystemNotification = {
  id: string;
  title: string;
  body: string;
  entity_type: "task" | "approval";
  entity_id: string;
  project_id: string | null;
};

export type SystemNotificationDelivery = (notification: PendingSystemNotification) => Promise<boolean>;

export function notify(database: DatabaseSync, kind: NotificationKind, title: string, body: string, entityType: "task" | "approval", entityId: string): void {
  database.prepare("INSERT INTO notifications (id, kind, title, body, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), kind, title, body, entityType, entityId, new Date().toISOString());
}

export function registerNotificationRoutes(server: FastifyInstance, database: DatabaseSync): void {
  server.get<{ Querystring: { unread?: string } }>("/api/notifications", async (request) =>
    database.prepare(`SELECT notification.*,
      CASE notification.entity_type
        WHEN 'task' THEN task_commission.project_id
        WHEN 'approval' THEN approval_run.project_id
        ELSE NULL
      END AS project_id
      FROM notifications AS notification
      LEFT JOIN tasks AS task ON notification.entity_type = 'task' AND task.id = notification.entity_id
      LEFT JOIN commissions AS task_commission ON task_commission.id = task.commission_id
      LEFT JOIN approvals AS approval ON notification.entity_type = 'approval' AND approval.id = notification.entity_id
      LEFT JOIN runs AS approval_run ON approval_run.id = approval.run_id
      ${request.query.unread === "true" ? "WHERE notification.read_at IS NULL" : ""}
      ORDER BY notification.created_at DESC`).all());

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

export function startSystemNotificationWorker(database: DatabaseSync, baseUrl: string, intervalMs = 1_000): () => Promise<void> {
  let stopped = false;
  let activeDelivery: Promise<void> | undefined;
  const deliver = windowsSystemNotificationDelivery(baseUrl);
  const run = () => {
    if (stopped || activeDelivery) return;
    activeDelivery = deliverPendingSystemNotifications(database, deliver)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => { activeDelivery = undefined; });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await activeDelivery;
  };
}

export async function deliverPendingSystemNotifications(database: DatabaseSync, deliver: SystemNotificationDelivery): Promise<number> {
  const pending = database.prepare(`SELECT notification.id, notification.title, notification.body, notification.entity_type, notification.entity_id,
    CASE notification.entity_type
      WHEN 'task' THEN task_commission.project_id
      WHEN 'approval' THEN approval_run.project_id
      ELSE NULL
    END AS project_id
    FROM notifications AS notification
    LEFT JOIN tasks AS task ON notification.entity_type = 'task' AND task.id = notification.entity_id
    LEFT JOIN commissions AS task_commission ON task_commission.id = task.commission_id
    LEFT JOIN approvals AS approval ON notification.entity_type = 'approval' AND approval.id = notification.entity_id
    LEFT JOIN runs AS approval_run ON approval_run.id = approval.run_id
    WHERE notification.read_at IS NULL AND notification.system_notified_at IS NULL
    ORDER BY notification.created_at
    LIMIT 20`).all() as PendingSystemNotification[];
  const results = await Promise.all(pending.map(async (notification) => ({ notification, succeeded: await deliver(notification) })));
  let delivered = 0;
  for (const { notification, succeeded } of results) {
    if (!succeeded) continue;
    const result = database.prepare("UPDATE notifications SET system_notified_at = COALESCE(system_notified_at, ?) WHERE id = ? AND read_at IS NULL")
      .run(new Date().toISOString(), notification.id);
    delivered += Number(result.changes);
  }
  return delivered;
}

function windowsSystemNotificationDelivery(baseUrl: string): SystemNotificationDelivery {
  if (process.platform !== "win32") return async () => false;
  const script = `$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$notice = New-Object System.Windows.Forms.NotifyIcon
try {
  $notice.Icon = [System.Drawing.SystemIcons]::Information
  $notice.Visible = $true
  $notice.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
  $notice.BalloonTipTitle = $env:WORKSHOP_NOTIFICATION_TITLE
  $notice.BalloonTipText = $env:WORKSHOP_NOTIFICATION_BODY
  $notice.add_BalloonTipClicked({ Start-Process $env:WORKSHOP_NOTIFICATION_URL })
  $notice.ShowBalloonTip(10000)
  [Console]::Out.WriteLine("WORKSHOP_NOTIFICATION_READY")
  Start-Sleep -Seconds 11
} finally {
  $notice.Dispose()
}`;
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  return async (notification) => new Promise<boolean>((resolve) => {
    const target = notification.entity_type === "task" ? "task" : "approval";
    const hash = `#${target}-${notification.entity_id}${notification.project_id ? `?project=${encodeURIComponent(notification.project_id)}` : ""}`;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encodedScript], {
      detached: true,
      env: {
        ...process.env,
        WORKSHOP_NOTIFICATION_TITLE: notification.title.slice(0, 63),
        WORKSHOP_NOTIFICATION_BODY: notification.body.slice(0, 255),
        WORKSHOP_NOTIFICATION_URL: `${baseUrl}/${hash}`
      },
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });
    void systemNotificationProcessReady(child).then(resolve);
  });
}

export function systemNotificationProcessReady(child: Pick<ChildProcess, "kill" | "once" | "stdout" | "unref">, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    const timeout = setTimeout(() => {
      child.stdout?.destroy();
      child.kill();
      finish(false);
    }, timeoutMs);
    const finish = (succeeded: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(succeeded);
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes("WORKSHOP_NOTIFICATION_READY")) {
        child.stdout?.destroy();
        child.unref();
        finish(true);
      }
    });
    child.once("error", () => finish(false));
    child.once("close", () => finish(false));
  });
}
