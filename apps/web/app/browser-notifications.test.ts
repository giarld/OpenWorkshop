import assert from "node:assert/strict";
import test from "node:test";
import { notificationEntityHash, notificationHashTarget, notificationNavigation, pushBrowserNotifications, type AppNotification, type BrowserNotificationRuntime } from "./browser-notifications.ts";

function item(overrides: Partial<AppNotification> = {}): AppNotification {
  return { id: "notification-1", kind: "blocked", title: "Task blocked", body: "Needs attention", entity_type: "task", entity_id: "task-1", project_id: "project-1", read_at: null, system_notified_at: null, ...overrides };
}

test("pushes unread notifications while another workspace page is visible", async () => {
  const shown: string[] = [];
  const opened: string[] = [];
  const handles: Array<{ click(): void }> = [];
  const runtime: BrowserNotificationRuntime = {
    supported: true,
    permission: () => "granted",
    requestPermission: async () => "granted",
    wasShown: () => false,
    markShown: (id) => shown.push(id),
    isCurrentTarget: () => false,
    show: () => {
      let handler: () => void = () => undefined;
      const handle = { onClick: (next: () => void) => { handler = next; }, close() {}, click: () => handler() };
      handles.push(handle);
      return handle;
    },
    open: (notification) => opened.push(notification.id)
  };

  await pushBrowserNotifications([item()], runtime);
  assert.deepEqual(shown, ["notification-1"]);
  handles[0]!.click();
  assert.deepEqual(opened, ["notification-1"]);
});

test("does not repeat shown, read, or currently open notifications", async () => {
  const shown: string[] = [];
  const runtime: BrowserNotificationRuntime = {
    supported: true,
    permission: () => "granted",
    requestPermission: async () => "granted",
    wasShown: (id) => id === "shown",
    markShown: (id) => shown.push(id),
    isCurrentTarget: (notification) => notification.id === "current",
    show: () => ({ onClick() {}, close() {} }),
    open() {}
  };

  await pushBrowserNotifications([
    item({ id: "shown" }),
    item({ id: "current" }),
    item({ id: "read", read_at: "2026-08-12T00:00:00.000Z" }),
    item({ id: "system-notified", system_notified_at: "2026-08-12T00:00:00.000Z" })
  ], runtime);
  assert.deepEqual(shown, []);
  assert.equal(notificationEntityHash(item()), "#task-task-1?project=project-1");
  assert.equal(notificationEntityHash(item({ entity_type: "approval", entity_id: "approval-1" })), "#approval-approval-1?project=project-1");
  assert.deepEqual(notificationHashTarget("#task-task-1?project=project-2"), { entityType: "task", entityId: "task-1", projectId: "project-2" });
  assert.deepEqual(notificationNavigation(item({ project_id: "project-2" }), "#task-task-1?project=project-2", "project-1"), { hash: "#task-task-1?project=project-2", updateHash: false, switchProject: true, view: "board", projectId: "project-2", entityType: "task", entityId: "task-1" });
});
