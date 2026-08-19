export type AppNotification = {
  id: string;
  kind: string;
  title: string;
  body: string;
  entity_type: "task" | "approval" | "delivery";
  entity_id: string;
  project_id: string | null;
  read_at: string | null;
  system_notified_at: string | null;
};

export type NotificationTarget = { entityType: "task" | "approval" | "delivery"; entityId: string; projectId: string | null };

type BrowserNotificationHandle = {
  onClick(handler: () => void): void;
  close(): void;
};

export type BrowserNotificationRuntime = {
  supported: boolean;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  wasShown(id: string): boolean;
  markShown(id: string): void;
  isCurrentTarget(item: AppNotification): boolean;
  show(item: AppNotification): BrowserNotificationHandle;
  open(item: AppNotification): void;
};

export function notificationEntityHash(item: Pick<AppNotification, "entity_type" | "entity_id" | "project_id">): string {
  return `#${item.entity_type}-${item.entity_id}${item.project_id ? `?project=${encodeURIComponent(item.project_id)}` : ""}`;
}

export function notificationHashTarget(hash: string): NotificationTarget | null {
  const match = /^#(task|approval|delivery)-([^?]+)(?:\?project=([^&]+))?$/.exec(hash);
  if (!match) return null;
  return { entityType: match[1] as NotificationTarget["entityType"], entityId: match[2]!, projectId: match[3] ? decodeURIComponent(match[3]) : null };
}

export function notificationNavigation(item: Pick<AppNotification, "entity_type" | "entity_id" | "project_id">, currentHash = "", currentProjectId = ""): { hash: string; updateHash: boolean; switchProject: boolean; view: "board" | "notifications" | "delivery"; projectId: string | null; entityType: NotificationTarget["entityType"]; entityId: string } {
  const hash = notificationEntityHash(item);
  return { hash, updateHash: currentHash !== hash, switchProject: Boolean(item.project_id && item.project_id !== currentProjectId), view: item.entity_type === "task" ? "board" : item.entity_type === "delivery" ? "delivery" : "notifications", projectId: item.project_id, entityType: item.entity_type, entityId: item.entity_id };
}

export async function pushBrowserNotifications(items: AppNotification[], runtime: BrowserNotificationRuntime): Promise<void> {
  const unread = items.filter((item) => !item.read_at && !item.system_notified_at);
  if (!unread.length || !runtime.supported) return;
  let permission = runtime.permission();
  if (permission === "default") permission = await runtime.requestPermission();
  if (permission !== "granted") return;
  for (const item of unread) {
    if (runtime.wasShown(item.id) || runtime.isCurrentTarget(item)) continue;
    const notice = runtime.show(item);
    notice.onClick(() => { runtime.open(item); notice.close(); });
    runtime.markShown(item.id);
  }
}

export function browserNotificationRuntime(onOpen: (item: AppNotification) => void): BrowserNotificationRuntime {
  return {
    supported: "Notification" in window,
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    wasShown: (id) => sessionStorage.getItem(notificationStorageKey(id)) !== null,
    markShown: (id) => sessionStorage.setItem(notificationStorageKey(id), "shown"),
    isCurrentTarget: (item) => document.visibilityState === "visible" && location.hash === notificationEntityHash(item),
    show: (item) => {
      const notice = new Notification(item.title, { body: item.body, tag: item.id });
      return { onClick: (handler) => { notice.onclick = handler; }, close: () => notice.close() };
    },
    open: onOpen
  };
}

function notificationStorageKey(id: string): string {
  return `workshop-notification:${id}`;
}
