import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { openWorkshopDatabase } from "./database.ts";
import { deliverPendingSystemNotifications, notify, systemNotificationProcessReady } from "./notifications.ts";

test("background delivery marks successful notifications and retries failures", async () => {
  const home = await mkdtemp(join(tmpdir(), "workshop-notifications-"));
  const database = await openWorkshopDatabase(home);
  try {
    notify(database, "blocked", "需要处理", "任务已阻塞", "task", "missing-task");
    const first = await deliverPendingSystemNotifications(database, async () => false);
    assert.equal(first, 0);
    assert.equal((database.prepare("SELECT system_notified_at FROM notifications").get() as { system_notified_at: string | null }).system_notified_at, null);

    const second = await deliverPendingSystemNotifications(database, async (notification) => {
      assert.equal(notification.title, "需要处理");
      assert.equal(notification.project_id, null);
      return true;
    });
    assert.equal(second, 1);
    assert.ok((database.prepare("SELECT system_notified_at FROM notifications").get() as { system_notified_at: string | null }).system_notified_at);
    assert.equal(await deliverPendingSystemNotifications(database, async () => true), 0);
  } finally {
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("system notification delivery succeeds as soon as PowerShell reports the notification is visible", async () => {
  const successful = notificationProcess();
  const success = systemNotificationProcessReady(successful.child);
  successful.stdout.emit("data", Buffer.from("WORKSHOP_NOTIFICATION_"));
  successful.stdout.emit("data", Buffer.from("READY\r\n"));
  assert.equal(await success, true);

  const failed = notificationProcess();
  const failure = systemNotificationProcessReady(failed.child);
  failed.child.emit("close", 1);
  assert.equal(await failure, false);

  const errored = notificationProcess();
  const error = systemNotificationProcessReady(errored.child);
  errored.child.emit("error", new Error("PowerShell failed"));
  errored.child.emit("close", 0);
  assert.equal(await error, false);

  const stalled = notificationProcess();
  assert.equal(await systemNotificationProcessReady(stalled.child, 1), false);
  assert.equal(stalled.killed, 1);
});

function notificationProcess(): { child: ChildProcess; stdout: EventEmitter & { destroy(): void }; killed: number } {
  const child = new EventEmitter() as ChildProcess;
  const stdout = Object.assign(new EventEmitter(), { destroy() {} });
  const result = { child, stdout, killed: 0 };
  Object.assign(child, { stdout, unref() { return child; }, kill() { result.killed += 1; return true; } });
  return result;
}
