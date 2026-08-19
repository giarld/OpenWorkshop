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
  assert.equal(notificationEntityHash(item({ entity_type: "delivery", entity_id: "delivery-1" })), "#delivery-delivery-1?project=project-1");
  assert.deepEqual(notificationHashTarget("#task-task-1?project=project-2"), { entityType: "task", entityId: "task-1", projectId: "project-2" });
  assert.deepEqual(notificationHashTarget("#delivery-delivery-1?project=project-2"), { entityType: "delivery", entityId: "delivery-1", projectId: "project-2" });
  assert.deepEqual(notificationNavigation(item({ project_id: "project-2" }), "#task-task-1?project=project-2", "project-1"), { hash: "#task-task-1?project=project-2", updateHash: false, switchProject: true, view: "board", projectId: "project-2", entityType: "task", entityId: "task-1" });
  assert.deepEqual(notificationNavigation(item({ entity_type: "delivery", entity_id: "delivery-1", project_id: "project-2" }), "", "project-1"), { hash: "#delivery-delivery-1?project=project-2", updateHash: true, switchProject: true, view: "delivery", projectId: "project-2", entityType: "delivery", entityId: "delivery-1" });
});

test("passes delivery success and retry context through browser notification content", async () => {
  const shown: AppNotification[] = [];
  const runtime: BrowserNotificationRuntime = {
    supported: true,
    permission: () => "granted",
    requestPermission: async () => "granted",
    wasShown: () => false,
    markShown() {},
    isCurrentTarget: () => false,
    show: (notification) => { shown.push(notification); return { onClick() {}, close() {} }; },
    open() {}
  };

  await pushBrowserNotifications([
    item({ entity_type: "delivery", entity_id: "delivery-1", title: "交付失败", body: "失败步骤：Push；可重试交付 delivery-1" }),
    item({ id: "notification-2", entity_type: "delivery", entity_id: "delivery-2", title: "交付成功", body: "纯文档交付已完成；交付记录 delivery-2" })
  ], runtime);
  assert.equal(shown.length, 2);
  const failure = shown.find((notification) => notification.entity_id === "delivery-1");
  const success = shown.find((notification) => notification.entity_id === "delivery-2");
  if (!failure || !success) throw new Error("未展示完整交付通知");
  assert.equal(failure.entity_type, "delivery");
  assert.equal(failure.title, "交付失败");
  assert.match(failure.body, /失败步骤：Push/);
  assert.match(failure.body, /可重试/);
  assert.equal(success.entity_type, "delivery");
  assert.equal(success.title, "交付成功");
  assert.match(success.body, /纯文档交付已完成/);
  assert.match(success.body, /delivery-2/);
});
