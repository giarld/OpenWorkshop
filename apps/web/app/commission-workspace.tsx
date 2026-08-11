"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import { clarificationOptionLabel, clarificationOptions, clarificationStep, stageAfterAnalysis, type CommissionStage } from "./commission-flow";
import { formatTokenCount } from "./task-run";

type Commission = { id: string; title: string; status: string; summary: string | null; main_task_id: string | null; archived_at: string | null; archive_size_bytes: number | null; clarification_token_input: number; clarification_token_output: number; clarification_token_cached: number };
type Message = { id: string; role: "human" | "agent" | "system"; content: string; options_json: string | null; created_at: string };
type Attachment = { id: string; original_name: string; size_bytes: number };
type Requirement = { id: string; version_no: number; content_markdown: string; acceptance_json: string; status: string };
type CommissionDetails = Commission & { messages: Message[]; attachments: Attachment[]; requirements: Requirement[] };
type AnalysisResult = { kind: "question" | "requirement" };
type DialogMode = "create" | "details" | "clarification" | "requirement" | "archives" | null;

const STATUS_LABELS: Record<string, string> = {
  draft: "草稿", clarifying: "澄清中", awaiting_requirement_approval: "等待需求批准", planned: "已规划",
  backlog: "Backlog", active: "执行中", paused: "已暂停", blocked: "已阻塞", awaiting_acceptance: "等待验收", done: "已完成", archived: "已归档"
};

export function CommissionWorkspace({ projectId, section, hidden, onChanged, onStageChange }: { projectId: string; section: "commissions" | "requirements"; hidden: boolean; onChanged(): void; onStageChange(stage: CommissionStage): void }) {
  const [commissions, setCommissions] = useState<Commission[]>([]);
  const [archivedCommissions, setArchivedCommissions] = useState<Commission[]>([]);
  const [selected, setSelected] = useState<CommissionDetails | null>(null);
  const [dialogMode, setDialogMode] = useState<DialogMode>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [copiedRequirementId, setCopiedRequirementId] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const timeline = useRef<HTMLDivElement>(null);

  useEffect(() => { void loadCommissions(); }, [projectId]);
  useEffect(() => {
    const element = dialog.current;
    if (dialogMode && element && !element.open) element.showModal();
    if (!dialogMode && element?.open) element.close();
  }, [dialogMode]);
  useEffect(() => { if (hidden) setDialogMode(null); }, [hidden]);
  useEffect(() => { if (dialogMode === "clarification" && timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight; }, [dialogMode, selected?.id, selected?.messages.length, analyzing]);

  async function loadCommissions(preferredId?: string) {
    try {
      const [rows, archivedRows] = await Promise.all([
        api<Commission[]>(`/api/projects/${projectId}/commissions`),
        api<Commission[]>(`/api/projects/${projectId}/commissions?archived=true`)
      ]);
      setCommissions(rows);
      setArchivedCommissions(archivedRows);
      const id = preferredId ?? (rows.some((item) => item.id === selected?.id) ? selected!.id : rows[0]?.id);
      setSelected(id ? await api<CommissionDetails>(`/api/commissions/${id}`) : null);
    } catch (error) { setMessage((error as Error).message); }
  }

  async function openCommission(id: string, mode: Exclude<DialogMode, "create" | null>) {
    await run(async () => {
      setSelected(await api<CommissionDetails>(`/api/commissions/${id}`));
      setDialogMode(mode);
    });
  }

  async function createCommission(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await run(async () => {
      const created = await api<CommissionDetails>(`/api/projects/${projectId}/commissions`, { method: "POST", body: JSON.stringify({ title: data.get("title"), message: data.get("message") }) });
      form.reset();
      setDialogMode(null);
      await loadCommissions(created.id);
      setMessage("委托已创建，可以开始需求澄清。");
    });
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const content = String(new FormData(form).get("content") ?? "").trim();
    if (content) await submitMessage(content, form);
  }

  async function sendChoice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const choice = String(data.get("choice") ?? "");
    const content = choice === "__custom__" ? String(data.get("custom") ?? "").trim() : choice;
    if (!content) return setMessage("请输入自定义答案。");
    await submitMessage(content, form);
  }

  async function submitMessage(content: string, form: HTMLFormElement) {
    if (!selected) return;
    await run(async () => {
      const created = await api<Message>(`/api/commissions/${selected.id}/messages`, { method: "POST", body: JSON.stringify({ content }) });
      setSelected((current) => current?.id === selected.id ? { ...current, messages: [...current.messages, created] } : current);
      form.reset();
      const destination = stageAfterAnalysis((await continueAnalysis(selected.id)).kind);
      if (destination) { setDialogMode(null); onStageChange(destination); }
      setMessage("回复已提交，需求分析已继续。");
    });
  }

  async function uploadAttachment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = (new FormData(form).get("file") as File | null);
    if (!file || !selected) return;
    await run(async () => {
      await api(`/api/commissions/${selected.id}/attachments`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) }, body: file });
      form.reset(); await loadCommissions(selected.id); setMessage("附件已上传。");
    });
  }

  async function analyze() {
    if (!selected) return;
    await run(async () => {
      const destination = stageAfterAnalysis((await continueAnalysis(selected.id)).kind);
      if (destination) { setDialogMode(null); onStageChange(destination); }
      setMessage("需求分析已更新。");
    });
  }

  async function continueAnalysis(commissionId: string): Promise<AnalysisResult> {
    setAnalyzing(true);
    try { return await api<AnalysisResult>(`/api/commissions/${commissionId}/analyze`, { method: "POST" }); }
    finally { try { await loadCommissions(commissionId); } finally { setAnalyzing(false); } }
  }

  async function showRequirement(id: string) {
    await run(async () => {
      setSelected(await api<CommissionDetails>(`/api/commissions/${id}`));
      onStageChange("requirements");
      setDialogMode("requirement");
    });
  }

  async function decideRequirement(requirement: Requirement, action: "approve" | "reject", reason?: string) {
    await run(async () => {
      try { await api(`/api/requirements/${requirement.id}/${action}`, action === "reject" ? { method: "POST", body: JSON.stringify({ reason }) } : { method: "POST" }); }
      finally { await loadCommissions(selected!.id); onChanged(); }
      if (action === "approve") onStageChange("board");
      setMessage(action === "approve" ? "需求已批准，任务规划已生成。" : "需求已拒绝，可以继续补充信息。");
    });
  }

  async function copyRequirement(requirement: Requirement) {
    try {
      await navigator.clipboard.writeText(requirement.content_markdown);
      setCopiedRequirementId(requirement.id);
      window.setTimeout(() => setCopiedRequirementId((current) => current === requirement.id ? null : current), 1500);
    } catch { setMessage("复制失败，请检查浏览器剪贴板权限。"); }
  }

  async function deleteCommission(commission: Commission) {
    if (!window.confirm(`确定永久删除正在澄清的委托“${commission.title}”吗？相关澄清消息和附件也会删除。`)) return;
    await run(async () => {
      await api(`/api/commissions/${commission.id}`, { method: "DELETE" });
      if (selected?.id === commission.id) { setSelected(null); setDialogMode(null); }
      await loadCommissions();
      onChanged();
      setMessage("委托已删除。");
    });
  }

  async function archiveSelectedCommission(commission: Commission) {
    if (!window.confirm(`确定归档委托“${commission.title}”吗？相关文档、任务和历史记录会压缩归档。`)) return;
    await run(async () => {
      await api(`/api/commissions/${commission.id}/archive`, { method: "POST" });
      if (selected?.id === commission.id) { setSelected(null); setDialogMode(null); }
      await loadCommissions();
      onChanged();
      setMessage("委托及其文档、任务已压缩归档。");
    });
  }

  async function reactivateSelectedCommission(commission: Commission) {
    await run(async () => {
      await api(`/api/commissions/${commission.id}/reactivate`, { method: "POST" });
      setDialogMode(null);
      await loadCommissions(commission.id);
      onChanged();
      setMessage("委托已重新激活，文档、任务和历史记录已恢复。");
    });
  }

  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await action(); } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }

  const currentRequirement = selected?.requirements[0];
  const nextClarification = selected ? clarificationStep(selected.status, selected.messages) : "complete";
  const latestOptions = clarificationOptions(selected?.messages.at(-1)?.options_json);
  const requirementCommissions = commissions.filter((item) => isClarified(item.status));

  return <div className={`delivery-grid commission-page ${section}`} hidden={hidden}>
    {section === "commissions" && <section className="commission-index">
      <header className="commission-index-header"><div><p className="eyebrow">Commissions</p><h2>委托列表</h2><p>集中查看委托状态，按需进入详情或专注澄清。</p></div><div className="commission-index-actions"><button className="secondary" onClick={() => { setMessage(""); setDialogMode("archives"); }}>归档委托{archivedCommissions.length ? ` (${archivedCommissions.length})` : ""}</button><button onClick={() => { setMessage(""); setDialogMode("create"); }}>创建委托</button></div></header>
      {commissions.length ? <div className="commission-list">{commissions.map((item) => {
        const clarified = isClarified(item.status);
        return <article className="commission-card" key={item.id}>
          <button className="commission-card-main" onClick={() => void openCommission(item.id, "details")}>
            <span className="commission-card-title"><strong>{item.title}</strong><small>{STATUS_LABELS[item.status] ?? item.status}</small></span>
            <span className="commission-summary">{item.summary || "尚未填写委托内容。"}</span>
          </button>
          <span className="commission-card-actions"><button className={clarified ? "secondary" : ""} onClick={() => void (clarified ? showRequirement(item.id) : openCommission(item.id, "clarification"))}>{clarified ? "已澄清" : "需求澄清"}</button>{clarified ? <button className="secondary" disabled={busy} onClick={() => void archiveSelectedCommission(item)}>归档</button> : <button className="danger" disabled={busy} onClick={() => void deleteCommission(item)}>删除</button>}</span>
        </article>;
      })}</div> : <section className="empty-state"><h3>暂无委托</h3><p>创建第一个委托后，从列表进入需求澄清。</p><button onClick={() => setDialogMode("create")}>创建委托</button></section>}
    </section>}

    {section === "requirements" && <section className="commission-index requirement-index">
      <header className="commission-index-header"><div><p className="eyebrow">Requirements</p><h2>需求文档列表</h2><p>集中查看已生成的需求文档，点击后在独立悬浮页中专注审阅。</p></div></header>
      {requirementCommissions.length ? <div className="commission-list">{requirementCommissions.map((item) => <article className="commission-card requirement-card" key={item.id}>
        <button className="commission-card-main" onClick={() => void showRequirement(item.id)}>
          <span className="commission-card-title"><strong>{item.title}</strong><small>{STATUS_LABELS[item.status] ?? item.status}</small></span>
          <span className="commission-summary">{item.summary || "需求文档已生成，点击查看完整内容与验收标准。"}</span>
        </button>
        <button className="secondary" onClick={() => void showRequirement(item.id)}>查看文档</button>
      </article>)}</div> : <section className="empty-state"><h3>暂无需求文档</h3><p>完成委托澄清后，生成的需求文档会显示在这里。</p></section>}
    </section>}

    <dialog ref={dialog} className={`commission-dialog ${dialogMode === "clarification" ? "clarification-dialog" : dialogMode === "requirement" ? "requirement-dialog" : dialogMode === "archives" ? "commission-archives-dialog" : ""}`} onClose={() => setDialogMode(null)}>
      <header className="commission-dialog-header"><div><p className="eyebrow">{dialogMode === "create" ? "New Commission" : dialogMode === "details" ? "Commission Details" : dialogMode === "requirement" ? "Requirement Document" : dialogMode === "archives" ? "Archived Commissions" : "Focused Clarification"}</p><h2>{dialogMode === "create" ? "创建委托" : dialogMode === "details" ? "委托详情" : dialogMode === "requirement" ? "需求文档" : dialogMode === "archives" ? "归档委托" : "需求澄清"}</h2>{selected && !["create", "archives"].includes(String(dialogMode)) && <p>{selected.title}</p>}</div><button type="button" className="secondary dialog-close" onClick={() => setDialogMode(null)}>关闭</button></header>

      {dialogMode === "create" && <form className="commission-form commission-dialog-body" onSubmit={createCommission}><label>委托标题<input name="title" autoFocus required /></label><label>完整委托内容<textarea name="message" rows={9} required /></label><div className="dialog-actions"><button type="button" className="secondary" onClick={() => setDialogMode(null)}>取消</button><button disabled={busy}>{busy ? "创建中…" : "创建委托"}</button></div></form>}

      {dialogMode === "archives" && <div className="commission-dialog-body archived-commission-list">{archivedCommissions.length ? archivedCommissions.map((item) => <article className="commission-card" key={item.id}><div className="commission-card-main archived-commission-summary"><span className="commission-card-title"><strong>{item.title}</strong><small>已归档</small></span><span className="commission-summary">归档时间：{item.archived_at ? new Date(item.archived_at).toLocaleString("zh-CN") : "未知"} · 压缩包：{formatArchiveSize(item.archive_size_bytes)}</span></div><button disabled={busy} onClick={() => void reactivateSelectedCommission(item)}>重新激活</button></article>) : <section className="empty-state"><h3>暂无归档委托</h3><p>已完成需求澄清的委托归档后会显示在这里。</p></section>}</div>}

      {dialogMode === "details" && selected && <div className="commission-detail commission-dialog-body"><p className="requirement-version">{STATUS_LABELS[selected.status] ?? selected.status}</p><ClarificationTokenSummary commission={selected} /><section><h3>委托标题</h3><p>{selected.title}</p></section><section><h3>完整委托内容</h3><p className="commission-full-content">{originalMessage(selected.messages) || "尚未填写委托内容。"}</p></section>{selected.attachments.length > 0 && <section><h3>附件</h3><p>{selected.attachments.map((item) => `${item.original_name} (${Math.ceil(item.size_bytes / 1024)} KB)`).join("、")}</p></section>}<div className="dialog-actions"><button onClick={() => void (isClarified(selected.status) ? showRequirement(selected.id) : setDialogMode("clarification"))}>{isClarified(selected.status) ? "查看需求文档" : "开始需求澄清"}</button></div></div>}

      {dialogMode === "clarification" && selected && <div className="clarification-body commission-dialog-body">
        <p className="clarification-token">Token: 输入 {formatTokenCount(selected.clarification_token_input)} · 输出 {formatTokenCount(selected.clarification_token_output)}</p>
        <div className="commission-timeline" ref={timeline}>{selected.messages.length ? selected.messages.map((item) => <article key={item.id} className={`commission-message ${item.role}`}><strong>{item.role === "human" ? "你" : item.role === "agent" ? "需求分析 Agent" : "系统"}</strong><p>{item.content}</p></article>) : <p>尚无澄清消息。</p>}{analyzing && <article className="commission-message agent thinking-message" role="status" aria-live="polite"><strong>需求分析 Agent</strong><span>正在思考</span><span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span></article>}</div>
        <div className="clarification-controls">
          {nextClarification === "reply" && (latestOptions.length ? <form className="clarification-choice-form" onSubmit={sendChoice}>{latestOptions.map((option, index) => <label key={option}><input type="radio" name="choice" value={option} required disabled={busy} />{clarificationOptionLabel(option, index === 0)}</label>)}<label><input type="radio" name="choice" value="__custom__" required disabled={busy} />其他（自定义）</label><input name="custom" autoComplete="off" placeholder="输入自定义答案" disabled={busy} /><button disabled={busy}>{busy ? "分析中…" : "提交选择并继续分析"}</button></form> : <form className="commission-message-form" onSubmit={sendMessage}><input name="content" placeholder="回复需求分析 Agent" required disabled={busy} /><button disabled={busy}>{busy ? "分析中…" : "回复并继续分析"}</button></form>)}
          <form className="commission-message-form" onSubmit={uploadAttachment}><input name="file" type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.txt,.md,.pdf,.docx" required disabled={busy} /><button className="secondary" disabled={busy}>上传附件</button></form>
          {selected.attachments.length > 0 && <p className="attachment-summary">附件：{selected.attachments.map((item) => `${item.original_name} (${Math.ceil(item.size_bytes / 1024)} KB)`).join("、")}</p>}
          {nextClarification === "analyze" && <button onClick={() => void analyze()} disabled={busy}>{busy ? "分析中…" : "运行需求分析"}</button>}
        </div>
      </div>}
      {dialogMode === "requirement" && <div className="requirement-document commission-dialog-body">
        {currentRequirement ? <><p className="requirement-version">当前版本 v{currentRequirement.version_no} · {currentRequirement.status} · 共 {selected?.requirements.length ?? 0} 个版本</p><div className="requirement-content"><button type="button" className="secondary requirement-copy" onClick={() => void copyRequirement(currentRequirement)}>{copiedRequirementId === currentRequirement.id ? "已复制" : "复制"}</button><div className="comment-markdown requirement-markdown"><ReactMarkdown>{currentRequirement.content_markdown}</ReactMarkdown></div></div><section><h3>验收标准</h3><p>{JSON.parse(currentRequirement.acceptance_json).map((item: unknown) => String(item)).join("；") || "无"}</p></section>{currentRequirement.status === "awaiting_approval" && <div className="requirement-actions"><button disabled={busy} onClick={() => void decideRequirement(currentRequirement, "approve")}>批准需求并生成任务</button><RequirementReject disabled={busy} onReject={(reason) => decideRequirement(currentRequirement, "reject", reason)} /></div>}</> : <p>需求分析信息充分后会生成待批准版本。</p>}
      </div>}
      {dialogMode && message && <p className="workspace-message dialog-message" role="status">{message}</p>}
    </dialog>
    {!dialogMode && message && <p className="workspace-message" role="status">{message}</p>}
  </div>;
}

function originalMessage(messages: Message[]): string | undefined {
  return messages.find((message) => message.role === "human")?.content;
}

function isClarified(status: string): boolean {
  return !["draft", "clarifying"].includes(status);
}

function formatArchiveSize(bytes: number | null): string {
  if (bytes === null) return "未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ClarificationTokenSummary({ commission }: { commission: Commission }) {
  const input = commission.clarification_token_input;
  const output = commission.clarification_token_output;
  const cached = commission.clarification_token_cached;
  const total = input + output;
  return <section className="task-token-summary" aria-label="需求澄清 Token 使用统计"><strong>需求澄清 Token</strong>{total || cached ? <dl>{([['总计', formatTokenCount(total)], ['输入', formatTokenCount(input)], ['输出', formatTokenCount(output)], ['缓存', formatTokenCount(cached)]] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : <span>暂无统计</span>}</section>;
}

function RequirementReject({ disabled, onReject }: { disabled: boolean; onReject(reason: string): Promise<void> }) {
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = event.currentTarget; const reason = String(new FormData(form).get("reason") ?? "").trim(); if (reason) { await onReject(reason); form.reset(); } }
  return <form className="reject-form" onSubmit={submit}><input name="reason" placeholder="拒绝原因" required disabled={disabled} /><button className="secondary" disabled={disabled}>拒绝</button></form>;
}

async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> { const response = await fetch(url, init?.body && !(init.body instanceof File) ? { ...init, headers: { "Content-Type": "application/json", ...init.headers } } : init); if (response.ok) return response.status === 204 ? undefined as T : await response.json() as T; const result = await response.json().catch(() => ({})) as { message?: string; error?: string }; throw new Error(result.message || result.error || `请求失败 (${response.status})`); }
