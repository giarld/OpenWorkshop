"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import type { Task } from "./task-board";
import type { AppNotification } from "./browser-notifications";
import { deliveryEntries, deliveryFormFromRequest, deliveryRequestFromForm, shouldRefreshDeliveryEntries, startDeliveryPolling, EMPTY_DELIVERY_FORM, type DeliveryCommission, type DeliveryEntry, type DeliveryFormState } from "./delivery-workspace-state";
import { DeliveryControls, type Acceptance, type DeliveryPreview, type DeliveryRecord } from "./delivery-workspace-controls";

type DocumentSummary = { id: string; commission_id: string | null; title: string; type: string; version_no: number; locked: number };
type DocumentDetails = DocumentSummary & { currentVersion: { content_markdown: string; version_no: number; locked: number }; versions: Array<{ id: string; version_no: number; locked: number; created_at: string }> };
type Approval = { id: string; kind: string; status: string; request: Record<string, unknown> };

export function DeliveryWorkspace({ projectId, tasks, section, hidden, onChanged, onNavigateNotification, notificationTargetId, onNotificationTargetHandled }: { projectId: string; tasks: Task[]; section: "delivery" | "notifications"; hidden: boolean; onChanged(): void; onNavigateNotification(item: AppNotification): void; notificationTargetId?: string | null; onNotificationTargetHandled?: () => void }) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [commissions, setCommissions] = useState<DeliveryCommission[]>([]);
  const [activeEntry, setActiveEntry] = useState<DeliveryEntry | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<DocumentDetails | null>(null);
  const [content, setContent] = useState("");
  const [acceptance, setAcceptance] = useState<Acceptance | null>(null);
  const [acceptanceLoading, setAcceptanceLoading] = useState(false);
  const [acceptanceError, setAcceptanceError] = useState("");
  const [deliveryForm, setDeliveryForm] = useState<DeliveryFormState>(EMPTY_DELIVERY_FORM);
  const [deliveryPreview, setDeliveryPreview] = useState<DeliveryPreview | null>(null);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [message, setMessage] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const handledNotificationTarget = useRef<string | null>(null);
  const entries = deliveryEntries(commissions, tasks);
  useEffect(() => {
    if (!notificationTargetId) { handledNotificationTarget.current = null; return; }
    if (hidden || section !== "delivery" || handledNotificationTarget.current === notificationTargetId) return;
    handledNotificationTarget.current = notificationTargetId;
    let cancelled = false;
    void api<DeliveryRecord>(`/api/deliveries/${notificationTargetId}`).then((delivery) => {
      if (cancelled) return;
      const entry = entries.find((item) => item.commissionId === delivery.commissionId);
      if (!entry) {
        setMessage("找不到该交付记录对应的当前项目数据。");
        onNotificationTargetHandled?.();
        return;
      }
      void openDelivery(entry).finally(() => {
        if (!cancelled) onNotificationTargetHandled?.();
      });
    }).catch((error) => {
      if (cancelled) return;
      setMessage(`打开交付记录失败：${(error as Error).message}`);
      onNotificationTargetHandled?.();
    });
    return () => { cancelled = true; };
  }, [entries, hidden, notificationTargetId, projectId, section]);

  useEffect(() => {
    setActiveEntry(null); setDocuments([]); setSelectedDocument(null); setAcceptance(null); setAcceptanceLoading(false); setAcceptanceError("");
    void loadCommissions();
  }, [projectId]);
  useEffect(() => {
    if (shouldRefreshDeliveryEntries(hidden, section)) void loadCommissions();
  }, [hidden, projectId, section]);
  useEffect(() => {
    const element = dialog.current;
    if (activeEntry && element && !element.open) element.showModal();
    if (!activeEntry && element?.open) element.close();
  }, [activeEntry]);
  useEffect(() => { if (hidden || section !== "delivery") setActiveEntry(null); }, [hidden, section]);
  useEffect(() => {
    const delivery = acceptance?.currentDelivery;
    if (!delivery || !activeEntry) return;
    return startDeliveryPolling(delivery.status, true, () => void loadAcceptance(activeEntry.mainTask.id), (callback, delay) => window.setInterval(callback, delay), (timer) => window.clearInterval(timer));
  }, [acceptance?.currentDelivery?.status, activeEntry]);
  useEffect(() => {
    if (hidden || section !== "notifications") return;
    const refresh = () => { void loadNotifications(); void loadApprovals(); };
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(timer);
  }, [hidden, projectId, section]);

  async function loadCommissions() {
    try { setCommissions(await api<DeliveryCommission[]>(`/api/projects/${projectId}/commissions`)); }
    catch (error) { setMessage((error as Error).message); }
  }

  async function loadDocuments(commissionId: string, preferredDocumentId?: string) {
    const rows = await api<DocumentSummary[]>(`/api/projects/${projectId}/documents?commissionId=${encodeURIComponent(commissionId)}`);
    setDocuments(rows);
    const id = preferredDocumentId && rows.some((item) => item.id === preferredDocumentId)
      ? preferredDocumentId
      : rows.find((item) => item.type === "delivery")?.id ?? rows[0]?.id;
    if (id) await selectDocument(id);
    else { setSelectedDocument(null); setContent(""); }
  }

  async function selectDocument(id: string) {
    const value = await api<DocumentDetails>(`/api/documents/${id}`);
    setSelectedDocument(value); setContent(value.currentVersion.content_markdown);
  }

  async function saveDocument() {
    const value = await api<DocumentDetails>(`/api/documents/${selectedDocument!.id}`, { method: "PUT", body: JSON.stringify({ contentMarkdown: content }) });
    setSelectedDocument(value); setContent(value.currentVersion.content_markdown); await loadDocuments(activeEntry!.commissionId, value.id); setMessage("已创建新的文档版本。");
  }

  async function lockDocument() {
    const value = await api<DocumentDetails>(`/api/documents/${selectedDocument!.id}/lock`, { method: "POST" });
    setSelectedDocument(value); await loadDocuments(activeEntry!.commissionId, value.id); setMessage("当前版本已锁定，后续更新会创建新版本。");
  }

  async function openDelivery(entry: DeliveryEntry) {
    setActiveEntry(entry); setDocuments([]); setSelectedDocument(null); setAcceptance(null); setAcceptanceError(""); setDeliveryForm(EMPTY_DELIVERY_FORM); setDeliveryPreview(null); setMessage("");
    try { await Promise.all([loadDocuments(entry.commissionId), loadAcceptance(entry.mainTask.id)]); }
    catch (error) { setMessage(`交付页面加载失败：${(error as Error).message}`); }
  }

  async function loadAcceptance(taskId: string) {
    setAcceptanceLoading(true); setAcceptanceError("");
    try {
      const value = await api<Acceptance>(`/api/tasks/${taskId}/acceptance`);
      setAcceptance(value);
      setDeliveryForm(deliveryFormFromRequest(value.currentDelivery?.request));
    }
    catch (error) { setAcceptance(null); setAcceptanceError((error as Error).message); }
    finally { setAcceptanceLoading(false); }
  }

  function deliveryBody(): Record<string, unknown> { return deliveryRequestFromForm(deliveryForm); }

  function updateDeliveryForm(field: keyof DeliveryFormState, value: string | boolean): void {
    setDeliveryForm((current) => ({ ...current, [field]: value } as DeliveryFormState));
    setDeliveryPreview(null);
  }

  async function previewDelivery() {
    if (!acceptance) return;
    try { setDeliveryPreview(await api<DeliveryPreview>(`/api/tasks/${acceptance.task.id}/delivery-preview`, { method: "POST", body: JSON.stringify(deliveryBody()) })); setMessage("交付预览已生成，请核对后确认。"); }
    catch (error) { setDeliveryPreview(null); setMessage(`生成预览失败：${(error as Error).message}`); }
  }

  async function deliver() {
    if (!acceptance || !activeEntry) return;
    if (!deliveryPreview) return;
    const body = deliveryBody();
    try {
      await api(`/api/tasks/${acceptance.task.id}/deliver`, { method: "POST", body: JSON.stringify({ ...body, previewFingerprint: deliveryPreview.fingerprint }) });
      setDeliveryPreview(null); setMessage("交付已提交执行，正在等待结果。"); onChanged(); await loadAcceptance(activeEntry.mainTask.id);
    } catch (error) { setDeliveryPreview(null); setMessage(`交付操作失败：${(error as Error).message}`); }
  }

  async function retryDelivery() {
    const delivery = acceptance?.currentDelivery;
    if (!delivery || !activeEntry) return;
    try { await api(`/api/deliveries/${delivery.id}/retry`, { method: "POST" }); setMessage("已提交交付重试。"); await loadAcceptance(activeEntry.mainTask.id); }
    catch (error) { setMessage(`重试失败：${(error as Error).message}`); }
  }
  async function reconcileDelivery() {
    const delivery = acceptance?.currentDelivery;
    if (!delivery || !activeEntry || !window.confirm("请确认已人工核对：外部 Commit、Push、SVN Commit 或 PR 均未成功。确认后将允许重新执行。")) return;
    try { await api(`/api/deliveries/${delivery.id}/reconcile`, { method: "POST", body: JSON.stringify({ decision: "retry", confirmedNoExternalEffect: true }) }); setMessage("已提交人工核对后的交付重试。"); await loadAcceptance(activeEntry.mainTask.id); }
    catch (error) { setMessage(error instanceof Error ? error.message : "人工核对失败。"); }
  }

  async function cancelDelivery() {
    const delivery = acceptance?.currentDelivery;
    if (!delivery || !activeEntry) return;
    try { await api(`/api/deliveries/${delivery.id}/cancel`, { method: "POST" }); setMessage("交付已取消。"); await loadAcceptance(activeEntry.mainTask.id); }
    catch (error) { setMessage(`取消失败：${(error as Error).message}`); }
  }

  async function decide(action: "reject", reason?: string) {
    const taskId = acceptance!.task.id;
    try {
      await api(`/api/tasks/${taskId}/reject`, { method: "POST", body: JSON.stringify({ reason }) });
      setMessage("已记录验收拒绝评论，并重新打开原任务返工。"); onChanged(); await loadCommissions(); await loadDocuments(activeEntry!.commissionId); await loadAcceptance(taskId); await loadNotifications();
    } catch (error) {
      try { setAcceptance(await api<Acceptance>(`/api/tasks/${taskId}/acceptance`)); } catch { /* Keep the original action error. */ }
      setMessage(`验收操作失败：${(error as Error).message}`);
    }
  }

  async function loadNotifications() {
    const items = await api<AppNotification[]>("/api/notifications");
    setNotifications(items);
  }

  async function readNotification(item: AppNotification) {
    if (!item.read_at) await api(`/api/notifications/${item.id}/read`, { method: "POST" });
    onNavigateNotification(item);
    await loadNotifications(); onChanged();
  }

  async function loadApprovals() { setApprovals(await api<Approval[]>("/api/approvals?status=pending")); }

  async function decideApproval(id: string, decision: "accepted" | "declined") {
    await api(`/api/approvals/${id}/decide`, { method: "POST", body: JSON.stringify({ decision }) });
    setMessage(decision === "accepted" ? "审批已通过。" : "审批已拒绝。"); await loadApprovals(); await loadNotifications(); onChanged();
  }

  async function clearNotificationHistory() {
    if (!window.confirm("清理所有历史通知？尚待处理的审批会保留。")) return;
    const result = await api<{ deleted: number }>("/api/notifications/history", { method: "DELETE" });
    setMessage(`已清理 ${result.deleted} 条历史通知。`); await loadNotifications(); await loadApprovals(); onChanged();
  }

  return <div className={`delivery-grid ${section === "delivery" ? "delivery-page" : ""}`} hidden={hidden}>
    <section className="delivery-index" hidden={section !== "delivery"}>
      <header className="delivery-index-header"><div><p className="eyebrow">Delivery Center</p><h2>客户需求交付</h2><p>每项对应一个客户需求，点击后在统一交付浮层中查看文档、证据并完成验收。</p></div><span>{entries.length} 项</span></header>
      {entries.length ? <div className="delivery-list">{entries.map((entry) => <button className="delivery-card" key={entry.commissionId} onClick={() => void openDelivery(entry)}>
        <span className="delivery-card-main"><span className="delivery-card-title"><strong>{entry.title}</strong><small>{STATUS_LABELS[entry.status] ?? entry.status}</small></span><span>{entry.summary || entry.mainTask.description || "该需求已进入任务交付流程。"}</span></span>
        <span className="delivery-card-meta"><span>主任务 {entry.mainTask.number_path}</span><span>{entry.completedTasks}/{entry.totalTasks} 已完成</span><b aria-hidden="true">→</b></span>
      </button>)}</div> : <p className="delivery-empty">暂无可交付的客户需求。需求完成规划并生成主任务后会显示在这里。</p>}
    </section>

    <dialog ref={dialog} className="commission-dialog delivery-dialog" onClose={() => setActiveEntry(null)}>
      <header className="commission-dialog-header"><div><p className="eyebrow">Delivery Workspace</p><h2>任务交付页面</h2>{activeEntry && <p>{activeEntry.title} · {activeEntry.mainTask.number_path} {activeEntry.mainTask.title}</p>}</div><button type="button" className="secondary dialog-close" onClick={() => setActiveEntry(null)}>关闭</button></header>
      {activeEntry && <div className="commission-dialog-body delivery-dialog-body">
        {message && <p className="workspace-message delivery-dialog-message" role="status">{message}</p>}
        <section className="delivery-panel"><header><div><p className="eyebrow">Documents</p><h2>文档与版本</h2></div>{documents.length > 0 && <select aria-label="选择文档" value={selectedDocument?.id ?? ""} onChange={(event) => void selectDocument(event.target.value)}>{documents.map((item) => <option key={item.id} value={item.id}>{item.type} · {item.title}</option>)}</select>}</header>
        {selectedDocument ? <><div className="document-actions"><span>v{selectedDocument.currentVersion.version_no} · {selectedDocument.currentVersion.locked ? "已锁定" : "可编辑"}</span><a className="button-link" href={`/api/documents/${selectedDocument.id}/export.md`}>导出 Markdown</a><button className="secondary compact" disabled={Boolean(selectedDocument.currentVersion.locked)} onClick={() => void lockDocument()}>锁定版本</button><button className="compact" disabled={content === selectedDocument.currentVersion.content_markdown} onClick={() => void saveDocument()}>保存新版本</button></div><textarea className="document-editor" value={content} onChange={(event) => setContent(event.target.value)} aria-label="Markdown 文档内容" /><p>版本历史：{selectedDocument.versions.map((version) => `v${version.version_no}${version.locked ? "🔒" : ""}`).join("、")}</p></> : <p>该需求暂无交付文档。</p>}
        </section>
        <section className="delivery-panel"><header><div><p className="eyebrow">Acceptance</p><h2>最终验收</h2></div>{acceptance && <span className="delivery-status">{STATUS_LABELS[acceptance.commissionStatus] ?? acceptance.commissionStatus}</span>}</header>
        {acceptance ? <><dl className="acceptance-summary"><div><dt>任务</dt><dd>{acceptance.tasks.length}</dd></div><div><dt>Run</dt><dd>{acceptance.runs.length}</dd></div><div><dt>证据</dt><dd>{acceptance.evidence.length}</dd></div></dl>{acceptance.deliveryDocument ? <section className="acceptance-report"><header><strong>交付报告 v{acceptance.deliveryDocument.versionNo}</strong><a href={`/api/documents/${acceptance.deliveryDocument.id}/export.md`}>导出 Markdown</a></header><pre>{acceptance.deliveryDocument.contentMarkdown}</pre></section> : <p>交付报告尚未生成。</p>}<DeliveryControls acceptance={acceptance} preview={deliveryPreview} form={deliveryForm} onFormChange={updateDeliveryForm} onPreview={() => void previewDelivery()} onDeliver={() => void deliver()} onRetry={() => void retryDelivery()} onReconcile={() => void reconcileDelivery()} onCancel={() => void cancelDelivery()} /><div className="acceptance-actions"><RejectForm disabled={acceptance.commissionStatus !== "awaiting_acceptance" || Boolean(acceptance.task.archived_at) || Boolean(acceptance.currentDelivery && ["queued", "preparing", "running"].includes(acceptance.currentDelivery.status))} onReject={(reason) => decide("reject", reason)} /></div></> : acceptanceLoading ? <p>正在加载任务交付信息…</p> : acceptanceError ? <div className="delivery-load-error" role="alert"><p>任务交付信息加载失败：{acceptanceError}</p><button className="secondary compact" onClick={() => void loadAcceptance(activeEntry.mainTask.id)}>重新加载</button></div> : <p>暂无任务交付信息。</p>}
        </section>
      </div>}
    </dialog>

    <section className="delivery-panel notification-panel" hidden={section !== "notifications"}><header><div><p className="eyebrow">Notifications</p><h2>通知与审批</h2></div><div className="document-actions"><button className="secondary compact" onClick={() => void clearNotificationHistory()}>清理历史通知</button><button className="secondary compact" onClick={() => { void loadNotifications(); void loadApprovals(); }}>刷新</button></div></header>
      {approvals.map((approval) => <article className="approval-item" id={`approval-${approval.id}`} key={approval.id}><div><strong>待审批 · {approval.kind}</strong><p>{JSON.stringify(approval.request)}</p></div><button onClick={() => void decideApproval(approval.id, "accepted")}>批准</button><button className="secondary" onClick={() => void decideApproval(approval.id, "declined")}>拒绝</button></article>)}
      {notifications.length ? <ul>{notifications.map((item) => <li key={item.id}><button className="notification-item" onClick={() => void readNotification(item)}><strong>{item.read_at ? "" : "● "}{item.title}</strong><span>{item.body}</span></button></li>)}</ul> : <p>暂无通知。浏览器拒绝权限时不影响业务流程。</p>}
    </section>
    {message && <p className="workspace-message" role="status">{message}</p>}
  </div>;
}

const STATUS_LABELS: Record<string, string> = {
  planned: "已规划", backlog: "Backlog", active: "执行中", paused: "已暂停", blocked: "已阻塞", awaiting_acceptance: "等待验收", done: "已完成", archived: "已归档"
};

function RejectForm({ disabled, onReject }: { disabled: boolean; onReject(reason: string): Promise<void> }) {
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = event.currentTarget; const reason = String(new FormData(form).get("reason") ?? "").trim(); if (reason) { await onReject(reason); form.reset(); } }
  return <form className="reject-form" onSubmit={submit}><input name="reason" placeholder="拒绝原因" required disabled={disabled} /><button className="secondary" disabled={disabled}>拒绝并返工</button></form>;
}

async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> { const response = await fetch(url, init?.body ? { ...init, headers: { "Content-Type": "application/json", ...init.headers } } : init); if (response.ok) return response.status === 204 ? undefined as T : await response.json() as T; const result = await response.json().catch(() => ({})) as { message?: string; error?: string }; throw new Error(result.message || result.error || `请求失败 (${response.status})`); }
