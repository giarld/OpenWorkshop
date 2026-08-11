import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply } from "fastify";

type DocumentRow = { id: string; project_id: string; commission_id: string | null; type: string; title: string; current_version_id: string | null; created_at: string };
type VersionRow = { id: string; document_id: string; version_no: number; content_markdown: string; source_json: string; locked: number; created_by: string; created_at: string };

export function registerDocumentRoutes(server: FastifyInstance, database: DatabaseSync): void {
  server.get<{ Params: { id: string }; Querystring: { type?: string; commissionId?: string } }>("/api/projects/:id/documents", async (request) => {
    const values: string[] = [request.params.id];
    const conditions = ["document.project_id = ?"];
    if (request.query.type) { conditions.push("document.type = ?"); values.push(request.query.type); }
    if (request.query.commissionId) { conditions.push("document.commission_id = ?"); values.push(request.query.commissionId); }
    return database.prepare(`SELECT document.*, version.version_no, version.locked, version.created_at AS updated_at FROM documents AS document LEFT JOIN document_versions AS version ON version.id = document.current_version_id WHERE ${conditions.join(" AND ")} ORDER BY document.type, document.title`).all(...values);
  });

  server.get<{ Params: { id: string } }>("/api/documents/:id", async (request) => documentDetails(database, request.params.id));

  server.put<{ Params: { id: string }; Body: { contentMarkdown?: unknown } }>("/api/documents/:id", async (request) => {
    const content = requiredString(request.body?.contentMarkdown, "contentMarkdown");
    appendDocumentVersion(database, request.params.id, content, { source: "manual_edit" }, "human");
    return documentDetails(database, request.params.id);
  });

  server.post<{ Params: { id: string } }>("/api/documents/:id/lock", async (request) => {
    const document = documentById(database, request.params.id);
    if (!document.current_version_id) throw conflict("Document has no current version");
    database.prepare("UPDATE document_versions SET locked = 1 WHERE id = ?").run(document.current_version_id);
    return documentDetails(database, document.id);
  });

  server.get<{ Params: { id: string } }>("/api/documents/:id/export.md", async (request, reply) => {
    const current = currentVersion(database, request.params.id);
    reply.header("Content-Type", "text/markdown; charset=utf-8").header("Content-Disposition", `attachment; filename=\"document-${request.params.id}.md\"`);
    return reply.send(current.content_markdown);
  });

  server.post<{ Params: { id: string }; Body: { query?: unknown } }>("/api/projects/:id/documents/query", async (request) => {
    const query = requiredString(request.body?.query, "query");
    const rows = database.prepare(`SELECT document.id, document.title, document.type, version.version_no, version.content_markdown
      FROM documents AS document JOIN document_versions AS version ON version.document_id = document.id
      WHERE document.project_id = ? AND (document.title LIKE ? OR version.content_markdown LIKE ?)
      ORDER BY version.created_at DESC LIMIT 20`).all(request.params.id, `%${query}%`, `%${query}%`) as Array<{ id: string; title: string; type: string; version_no: number; content_markdown: string }>;
    return rows.map(({ content_markdown, ...row }) => ({ ...row, excerpt: excerpt(content_markdown, query), href: `/documents/${row.id}?version=${row.version_no}` }));
  });
}

export function generateAcceptanceDocuments(database: DatabaseSync, commissionId: string): void {
  const commission = database.prepare(`SELECT commission.id, commission.project_id, commission.title, commission.status, commission.active_requirement_version_id,
    task.id AS main_task_id, task.title AS main_task_title
    FROM commissions AS commission JOIN tasks AS task ON task.id = commission.main_task_id WHERE commission.id = ?`).get(commissionId) as { id: string; project_id: string; title: string; status: string; active_requirement_version_id: string | null; main_task_id: string; main_task_title: string } | undefined;
  if (!commission) return;
  const requirement = commission.active_requirement_version_id
    ? database.prepare("SELECT content_markdown, acceptance_json FROM requirement_versions WHERE id = ?").get(commission.active_requirement_version_id) as { content_markdown: string; acceptance_json: string }
    : null;
  if (requirement) upsertGeneratedDocument(database, commission, "requirement", `${commission.title} requirement`, requirement.content_markdown, { requirementVersionId: commission.active_requirement_version_id });

  const tasks = database.prepare("SELECT number_path, title, status, blocked_reason, human_waiver_reason FROM tasks WHERE commission_id = ? ORDER BY number_path").all(commissionId) as Array<Record<string, unknown>>;
  const evidence = database.prepare("SELECT evidence.type, evidence.status, evidence.summary, evidence.payload_json FROM evidence JOIN tasks ON tasks.id = evidence.task_id WHERE tasks.commission_id = ? ORDER BY evidence.created_at").all(commissionId) as Array<Record<string, unknown>>;
  const runs = database.prepare("SELECT role, status, failure_summary FROM runs WHERE commission_id = ? ORDER BY rowid").all(commissionId) as Array<Record<string, unknown>>;
  const source = { commissionId, tasks, evidence, runs };
  const reviews = evidence.filter((item) => item.type === "review");
  const rejection = database.prepare("SELECT content FROM comments WHERE task_id = ? AND kind = 'rejection' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(commission.main_task_id) as { content: string } | undefined;
  const acceptanceResult = commission.status === "done" ? "- 已批准。" : commission.status === "awaiting_acceptance" ? "- 等待人工验收。" : rejection ? `- 已拒绝：${rejection.content}` : "- 尚未进入人工验收。";
  upsertGeneratedDocument(database, commission, "review", `${commission.title} review report`, reviewMarkdown(reviews), source);
  upsertGeneratedDocument(database, commission, "delivery", `${commission.title} delivery`, deliveryMarkdown(commission.main_task_title, tasks, evidence, runs, acceptanceResult), source);
}

function upsertGeneratedDocument(database: DatabaseSync, commission: { id: string; project_id: string }, type: string, title: string, content: string, source: unknown): void {
  let document = database.prepare("SELECT * FROM documents WHERE commission_id = ? AND type = ? ORDER BY created_at LIMIT 1").get(commission.id, type) as DocumentRow | undefined;
  if (!document) {
    const now = new Date().toISOString();
    document = { id: randomUUID(), project_id: commission.project_id, commission_id: commission.id, type, title, current_version_id: null, created_at: now };
    database.prepare("INSERT INTO documents (id, project_id, commission_id, type, title, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(document.id, document.project_id, document.commission_id, type, title, now);
  }
  const current = document.current_version_id ? currentVersion(database, document.id) : null;
  if (current?.content_markdown === content) return;
  appendDocumentVersion(database, document.id, content, source, "archivist_agent");
}

function appendDocumentVersion(database: DatabaseSync, documentId: string, content: string, source: unknown, createdBy: string): void {
  const document = documentById(database, documentId);
  const version = (database.prepare("SELECT COALESCE(MAX(version_no), 0) + 1 AS version FROM document_versions WHERE document_id = ?").get(document.id) as { version: number }).version;
  const versionId = randomUUID();
  database.prepare("INSERT INTO document_versions (id, document_id, version_no, content_markdown, source_json, locked, created_by, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)")
    .run(versionId, document.id, version, content, JSON.stringify(source), createdBy, new Date().toISOString());
  database.prepare("UPDATE documents SET current_version_id = ? WHERE id = ?").run(versionId, document.id);
}

function documentDetails(database: DatabaseSync, id: string) {
  const document = documentById(database, id);
  return { ...document, currentVersion: document.current_version_id ? currentVersion(database, id) : null, versions: database.prepare("SELECT * FROM document_versions WHERE document_id = ? ORDER BY version_no DESC").all(id) };
}

function documentById(database: DatabaseSync, id: string): DocumentRow {
  const row = database.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocumentRow | undefined;
  if (!row) throw notFound("Document not found");
  return row;
}

function currentVersion(database: DatabaseSync, documentId: string): VersionRow {
  const row = database.prepare("SELECT version.* FROM documents AS document JOIN document_versions AS version ON version.id = document.current_version_id WHERE document.id = ?").get(documentId) as VersionRow | undefined;
  if (!row) throw notFound("Document version not found");
  return row;
}

function reviewMarkdown(reviews: Array<Record<string, unknown>>): string {
  return ["## 检查结果", "", ...(reviews.length ? reviews.map((review) => `- ${review.status}: ${review.summary}`) : ["- 暂无独立评审证据。"]), "", "## 证据", "", `共 ${reviews.length} 条评审记录。`].join("\n");
}

function deliveryMarkdown(title: string, tasks: Array<Record<string, unknown>>, evidence: Array<Record<string, unknown>>, runs: Array<Record<string, unknown>>, acceptanceResult: string): string {
  const changedFiles = new Set<string>();
  for (const item of evidence) {
    try {
      const payload = JSON.parse(String(item.payload_json ?? "{}")) as { findings?: Array<{ file?: string | null }> };
      for (const finding of payload.findings ?? []) if (finding.file) changedFiles.add(finding.file);
    } catch { /* stored evidence may predate the structured contract */ }
  }
  const risks = evidence.filter((item) => item.status === "failed").map((item) => String(item.summary));
  const unfinished = tasks.filter((task) => task.status !== "done");
  return [
    `## ${title}`, "", "## 需求覆盖", "", ...tasks.map((task) => `- ${task.number_path} ${task.title}: ${task.status}`), "",
    "## 变更摘要", "", `${tasks.filter((task) => task.status === "done").length} 个任务已完成。`, "", "## 文件清单", "", ...(changedFiles.size ? [...changedFiles].map((file) => `- ${file}`) : ["- 结构化证据中未记录文件清单。"]), "",
    "## 测试与评审", "", ...evidence.map((item) => `- ${item.type}/${item.status}: ${item.summary}`), "", "## 已知风险", "", ...(risks.length ? risks.map((risk) => `- ${risk}`) : ["- 无已知阻塞风险。"]), "",
    "## 未完成项", "", ...(unfinished.length ? unfinished.map((task) => `- ${task.number_path} ${task.title}`) : ["- 无。"]), "", "## 人工操作", "", "- 在验收页批准或拒绝最终交付。", "", "## 人工验收结果", "", acceptanceResult, "",
    `Run 数量：${runs.length}`
  ].join("\n");
}

function excerpt(content: string, query: string): string { const index = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()); return content.slice(Math.max(0, index - 80), Math.max(0, index - 80) + 240); }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw badRequest(`${name} must be a non-empty string`); return value.trim(); }
function statusError(message: string, statusCode: number): Error { return Object.assign(new Error(message), { statusCode }); }
const badRequest = (message: string) => statusError(message, 400);
const notFound = (message: string) => statusError(message, 404);
const conflict = (message: string) => statusError(message, 409);
