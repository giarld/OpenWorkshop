import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { inflateRawSync, inflateSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { registerAttachmentParsers, storeAttachment } from "./attachments.ts";
import { resolvedRoleConfig } from "./agent-settings.ts";
import { archiveCommission, deleteClarifyingCommission, reactivateCommission } from "./commission-archive.ts";
import type { CodexRoleConfig } from "./codex.ts";
import type { TaskPlanner } from "./planner-agent.js";
import type { RequirementTokenUsage } from "./requirement-token-usage.js";
import { createTaskPlan } from "./tasks.ts";

const CLARIFICATION_COMPLETION_QUESTION = "需求信息已经足够。是否确认结束需求澄清并生成需求文档？";
// ponytail: cap in-process extraction at 5 MiB; move parsing to isolated streaming workers if larger documents become required.
const MAX_EXTRACTED_BYTES = 5 * 1024 * 1024;

type CommissionRow = {
  id: string;
  project_id: string;
  title: string;
  status: string;
  active_requirement_version_id: string | null;
  main_task_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  clarification_token_input: number;
  clarification_token_output: number;
  clarification_token_cached: number;
  archive_path: string | null;
  archive_sha256: string | null;
  archive_size_bytes: number | null;
  lifecycle_operation: "archiving" | "reactivating" | null;
  lifecycle_token: string | null;
};

export type { RequirementTokenUsage } from "./requirement-token-usage.js";

export type RequirementAnalysis = (
  | { question: string; options?: string[] }
  | { completionQuestion: true }
  | { contentMarkdown: string; acceptanceCriteria: unknown[] }
) & { tokenUsage?: RequirementTokenUsage };

export type RequirementAnalyzer = (input: {
  commission: CommissionRow;
  projectRoot: string;
  agentConfig: Readonly<CodexRoleConfig>;
  messages: Array<{ role: string; content: string }>;
  attachments: Array<{ original_name: string; extracted_text: string | null }>;
  activeRequirement: { content_markdown: string; acceptance_json: string } | null;
  onProgress?: (message: string) => void;
}) => Promise<RequirementAnalysis>;

export function registerCommissionRoutes(server: FastifyInstance, database: DatabaseSync, attachmentsRoot: string, analyze?: RequirementAnalyzer, plan?: TaskPlanner): void {
  registerAttachmentParsers(server);

  server.get<{ Params: { id: string }; Querystring: { archived?: string } }>("/api/projects/:id/commissions", async (request) => {
    projectExists(database, request.params.id);
    const archiveFilter = request.query.archived === "true" ? "commission.archived_at IS NOT NULL" : "commission.archived_at IS NULL";
    return database.prepare(`
      SELECT commission.*, (
        SELECT content FROM requirement_messages
        WHERE commission_id = commission.id AND role = 'human'
        ORDER BY created_at, rowid LIMIT 1
      ) AS summary
      FROM commissions AS commission
      WHERE project_id = ? AND ${archiveFilter}
      ORDER BY created_at DESC
    `).all(request.params.id);
  });

  server.post<{ Params: { id: string }; Body: { title?: unknown; message?: unknown } }>("/api/projects/:id/commissions", async (request, reply) => {
    projectExists(database, request.params.id);
    const title = requiredString(request.body?.title, "title");
    const message = optionalString(request.body?.message, "message");
    const now = new Date().toISOString();
    const id = randomUUID();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("INSERT INTO commissions (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, request.params.id, title, message ? "clarifying" : "draft", now, now);
      if (message) insertMessage(database, id, "human", message, now);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return reply.code(201).send(commissionDetails(database, id));
  });

  server.get<{ Params: { id: string } }>("/api/commissions/:id", async (request) => commissionDetails(database, request.params.id));

  server.delete<{ Params: { id: string } }>("/api/commissions/:id", async (request, reply) => {
    await deleteClarifyingCommission(database, attachmentsRoot, request.params.id);
    return reply.code(204).send();
  });

  server.post<{ Params: { id: string } }>("/api/commissions/:id/archive", async (request) =>
    archiveCommission(database, attachmentsRoot, request.params.id));

  server.post<{ Params: { id: string } }>("/api/commissions/:id/reactivate", async (request) =>
    reactivateCommission(database, attachmentsRoot, request.params.id));

  server.post<{ Params: { id: string }; Body: Buffer | string }>("/api/commissions/:id/attachments", async (request, reply) => {
    const commission = mutableCommission(database, request.params.id);
    const originalName = decodedFileName(requiredHeader(request.headers["x-file-name"], "x-file-name"));
    const mediaType = String(request.headers["content-type"] ?? "application/octet-stream").split(";", 1)[0]!.toLowerCase();
    const data = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body ?? "", "utf8");
    return reply.code(201).send(await storeAttachment(database, attachmentsRoot, { commissionId: commission.id, originalName, mediaType, data }));
  });

  server.post<{ Params: { id: string }; Body: { content?: unknown } }>("/api/commissions/:id/messages", async (request, reply) => {
    const content = requiredString(request.body?.content, "content");
    const now = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const commission = mutableCommission(database, request.params.id);
      assertNoPendingRequirement(database, commission.id);
      const id = insertMessage(database, commission.id, "human", content, now);
      database.prepare("UPDATE commissions SET status = 'clarifying', updated_at = ? WHERE id = ?").run(now, commission.id);
      database.exec("COMMIT");
      return reply.code(201).send(database.prepare("SELECT * FROM requirement_messages WHERE id = ?").get(id));
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  });

  server.post<{ Params: { id: string } }>("/api/commissions/:id/analyze", async (request, reply) => {
    if (!analyze) throw unavailable("Requirement Agent is not configured");
    const commission = mutableCommission(database, request.params.id);
    assertNoPendingRequirement(database, commission.id);
    const messages = database.prepare("SELECT role, content FROM requirement_messages WHERE commission_id = ? ORDER BY created_at, rowid").all(commission.id) as Array<{ role: string; content: string }>;
    if (messages.at(-1)?.role === "agent") throw conflict("Reply to the Requirement Agent before continuing analysis");
    const streaming = request.headers.accept === "application/x-ndjson";
    let streamStarted = false;
    const write = (value: unknown) => {
      if (!streaming || reply.raw.destroyed || reply.raw.writableEnded) return;
      if (!streamStarted) {
        streamStarted = true;
        reply.hijack();
        reply.raw.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
      }
      reply.raw.write(`${JSON.stringify(value)}\n`);
    };
    try {
      const result = await analyze({
        commission,
        projectRoot: (database.prepare("SELECT project.real_path FROM projects AS project JOIN commissions AS commission ON commission.project_id = project.id WHERE commission.id = ?").get(commission.id) as { real_path: string }).real_path,
        agentConfig: resolvedRoleConfig(database, commission.project_id, "supervisor"),
        messages,
        attachments: database.prepare("SELECT original_name, extracted_text FROM attachments WHERE commission_id = ? ORDER BY created_at, rowid").all(commission.id) as Array<{ original_name: string; extracted_text: string | null }>,
        activeRequirement: commission.active_requirement_version_id
          ? database.prepare("SELECT content_markdown, acceptance_json FROM requirement_versions WHERE id = ?").get(commission.active_requirement_version_id) as { content_markdown: string; acceptance_json: string }
          : null,
        ...(streaming ? { onProgress: (message: string) => write({ type: "progress", message }) } : {})
      });
      const now = new Date().toISOString();
      const usage = result.tokenUsage ?? { input: 0, output: 0, cached: 0 };
      let response: unknown;
      let status = 200;
      if ("question" in result || "completionQuestion" in result) {
        const question = "completionQuestion" in result ? CLARIFICATION_COMPLETION_QUESTION : requiredString(result.question, "question");
        const options = "question" in result && result.options ? validateOptions(result.options) : undefined;
        const id = insertMessage(database, commission.id, "agent", question, now, options);
        database.prepare(`UPDATE commissions SET status = 'clarifying', updated_at = ?, clarification_token_input = clarification_token_input + ?, clarification_token_output = clarification_token_output + ?, clarification_token_cached = clarification_token_cached + ? WHERE id = ?`).run(now, usage.input, usage.output, usage.cached, commission.id);
        response = { kind: "question", message: database.prepare("SELECT * FROM requirement_messages WHERE id = ?").get(id) };
      } else {
        const content = requiredString(result.contentMarkdown, "contentMarkdown");
        if (!Array.isArray(result.acceptanceCriteria)) throw badGateway("Requirement Agent returned invalid acceptanceCriteria");
        database.exec("BEGIN IMMEDIATE");
        try {
          assertNoPendingRequirement(database, commission.id);
          const id = randomUUID();
          const version = (database.prepare("SELECT COALESCE(MAX(version_no), 0) + 1 AS version FROM requirement_versions WHERE commission_id = ?").get(commission.id) as { version: number }).version;
          database.prepare(`INSERT INTO requirement_versions (id, commission_id, version_no, content_markdown, acceptance_json, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'awaiting_approval', 'requirement_agent', ?)`).run(id, commission.id, version, content, JSON.stringify(result.acceptanceCriteria), now);
          database.prepare(`UPDATE commissions SET status = 'awaiting_requirement_approval', updated_at = ?, clarification_token_input = clarification_token_input + ?, clarification_token_output = clarification_token_output + ?, clarification_token_cached = clarification_token_cached + ? WHERE id = ?`).run(now, usage.input, usage.output, usage.cached, commission.id);
          database.exec("COMMIT");
          status = 201;
          response = { kind: "requirement", requirement: requirementById(database, id) };
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
      if (!streaming) return reply.code(status).send(response);
      write({ type: "result", result: response });
      reply.raw.end();
      return reply;
    } catch (error) {
      if (streaming) {
        if (!streamStarted) throw error;
        const status = errorStatus(error);
        write({ type: "error", status, error: status ? errorMessage(error) : "需求分析失败，请重试或检查 Codex 配置。" });
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
        return reply;
      }
      throw error;
    }
  });

  server.get<{ Params: { id: string } }>("/api/commissions/:id/requirements", async (request) => {
    commissionById(database, request.params.id);
    return database.prepare("SELECT * FROM requirement_versions WHERE commission_id = ? ORDER BY version_no DESC").all(request.params.id);
  });

  server.post<{ Params: { id: string }; Body: { contentMarkdown?: unknown; acceptanceCriteria?: unknown } }>("/api/commissions/:id/requirements/approved", async (request, reply) => {
    const content = requiredString(request.body?.contentMarkdown, "contentMarkdown");
    if (!Array.isArray(request.body?.acceptanceCriteria)) throw badRequest("acceptanceCriteria must be an array");
    const now = new Date().toISOString();
    const requirementId = randomUUID();
    database.exec("BEGIN IMMEDIATE");
    try {
      const commission = mutableCommission(database, request.params.id);
      assertNoPendingRequirement(database, commission.id);
      if (commission.main_task_id || database.prepare("SELECT 1 FROM tasks WHERE commission_id = ? LIMIT 1").get(commission.id)) throw conflict("Commission already has tasks");
      const version = (database.prepare("SELECT COALESCE(MAX(version_no), 0) + 1 AS version FROM requirement_versions WHERE commission_id = ?").get(commission.id) as { version: number }).version;
      database.prepare("UPDATE requirement_versions SET status = 'superseded' WHERE commission_id = ? AND status = 'approved'").run(commission.id);
      database.prepare(`
        INSERT INTO requirement_versions (id, commission_id, version_no, content_markdown, acceptance_json, status, created_by, created_at, approved_at)
        VALUES (?, ?, ?, ?, ?, 'approved', 'human', ?, ?)
      `).run(requirementId, commission.id, version, content, JSON.stringify(request.body.acceptanceCriteria), now, now);
      database.prepare("UPDATE commissions SET active_requirement_version_id = ?, status = 'planned', updated_at = ? WHERE id = ?").run(requirementId, now, commission.id);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return reply.code(201).send(requirementById(database, requirementId));
  });

  server.post<{ Params: { id: string } }>("/api/requirements/:id/approve", async (request) => {
    const now = new Date().toISOString();
    let approved: { requirementId: string; commissionId: string };
    database.exec("BEGIN IMMEDIATE");
    try {
      const { requirement, commission } = currentPendingRequirement(database, request.params.id);
      database.prepare("UPDATE requirement_versions SET status = 'superseded' WHERE commission_id = ? AND status = 'approved'").run(commission.id);
      database.prepare("UPDATE requirement_versions SET status = 'approved', approved_at = ? WHERE id = ?").run(now, requirement.id);
      database.prepare("UPDATE commissions SET active_requirement_version_id = ?, status = 'planned', updated_at = ? WHERE id = ?").run(requirement.id, now, commission.id);
      database.exec("COMMIT");
      approved = { requirementId: requirement.id, commissionId: commission.id };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    if (plan) await planCommission(database, approved.commissionId, plan);
    return requirementById(database, approved.requirementId);
  });

  server.post<{ Params: { id: string } }>("/api/commissions/:id/replan", async (request) => {
    if (!plan) throw unavailable("Planning Agent is not configured");
    const commission = commissionById(database, request.params.id);
    if (commission.main_task_id) throw conflict("Commission already has a task plan");
    return planCommission(database, commission.id, plan);
  });

  server.post<{ Params: { id: string }; Body: { reason?: unknown } }>("/api/requirements/:id/reject", async (request) => {
    const reason = optionalString(request.body?.reason, "reason");
    const now = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const { requirement, commission } = currentPendingRequirement(database, request.params.id);
      database.prepare("UPDATE requirement_versions SET status = 'rejected' WHERE id = ?").run(requirement.id);
      if (reason) insertMessage(database, requirement.commission_id, "human", reason, now);
      database.prepare("UPDATE commissions SET status = ?, updated_at = ? WHERE id = ?").run(commission.active_requirement_version_id ? "planned" : "clarifying", now, requirement.commission_id);
      database.exec("COMMIT");
      return requirementById(database, requirement.id);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  });
}

async function planCommission(database: DatabaseSync, commissionId: string, plan: TaskPlanner) {
  const input = database.prepare(`SELECT commission.title, commission.project_id, project.real_path, requirement.content_markdown, requirement.acceptance_json
    FROM commissions AS commission JOIN projects AS project ON project.id = commission.project_id
    JOIN requirement_versions AS requirement ON requirement.id = commission.active_requirement_version_id
    WHERE commission.id = ? AND requirement.status = 'approved'`).get(commissionId) as { title: string; project_id: string; real_path: string; content_markdown: string; acceptance_json: string } | undefined;
  if (!input) throw conflict("Commission requirement is not approved");
  const result = await plan({ title: input.title, projectRoot: input.real_path, agentConfig: resolvedRoleConfig(database, input.project_id, "supervisor"), requirement: input.content_markdown, acceptanceCriteria: JSON.parse(input.acceptance_json) as unknown[] });
  return createTaskPlan(database, commissionId, result as unknown as Record<string, unknown>);
}

export function extractAttachmentText(extension: string, data: Buffer): string | null {
  try {
    if (extension === ".txt" || extension === ".md") return limitedText(data.toString("utf8"));
    if (extension === ".pdf") return extractPdfText(data) || null;
    if (extension === ".docx") return extractDocxText(data) || null;
    return null;
  } catch (error) {
    if (error instanceof Error && "statusCode" in error) throw error;
    throw badRequest("Invalid or unsafe attachment content", error);
  }
}

function extractPdfText(data: Buffer): string {
  const source = data.toString("latin1");
  let text = pdfStrings(source);
  let remainingInflatedBytes = MAX_EXTRACTED_BYTES;
  for (const match of source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const offset = match.index ?? 0;
    if (!/\/FlateDecode/.test(source.slice(Math.max(0, offset - 512), offset))) continue;
    const inflated = inflateSync(Buffer.from(match[1]!, "latin1"), { maxOutputLength: remainingInflatedBytes });
    remainingInflatedBytes -= inflated.length;
    text += `\n${pdfStrings(inflated.toString("latin1"))}`;
    if (remainingInflatedBytes === 0 || Buffer.byteLength(text) > MAX_EXTRACTED_BYTES) break;
  }
  return limitedText(text).trim();
}

function pdfStrings(source: string): string {
  return [...source.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)].map((match) => decodePdfString(match[1]!)).join("\n");
}

function decodePdfString(value: string): string {
  return value.replace(/\\([0-7]{1,3}|n|r|t|b|f|\\|\(|\))/g, (_match, escape: string) => {
    if (/^[0-7]/.test(escape)) return String.fromCharCode(Number.parseInt(escape, 8));
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "\\": "\\", "(": "(", ")": ")" } as Record<string, string>)[escape]!;
  });
}

function extractDocxText(data: Buffer): string {
  const eocd = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assertRange(data, eocd, 22);
  let cursor = data.readUInt32LE(eocd + 16);
  while (cursor < data.length) {
    assertRange(data, cursor, 46);
    if (data.readUInt32LE(cursor) !== 0x02014b50) break;
    const compressedSize = data.readUInt32LE(cursor + 20);
    const uncompressedSize = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const localOffset = data.readUInt32LE(cursor + 42);
    assertRange(data, cursor + 46, nameLength + extraLength + commentLength);
    const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (name === "word/document.xml") {
      if (uncompressedSize > MAX_EXTRACTED_BYTES) throw new Error("DOCX document.xml exceeds extraction limit");
      assertRange(data, localOffset, 30);
      if (data.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid DOCX local header");
      const method = data.readUInt16LE(localOffset + 8);
      const localNameLength = data.readUInt16LE(localOffset + 26);
      const localExtraLength = data.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      assertRange(data, start, compressedSize);
      const compressed = data.subarray(start, start + compressedSize);
      const xml = method === 8 ? inflateRawSync(compressed, { maxOutputLength: MAX_EXTRACTED_BYTES }) : method === 0 ? compressed : (() => { throw new Error("Unsupported DOCX compression"); })();
      if (xml.length !== uncompressedSize) throw new Error("Invalid DOCX entry size");
      return limitedText(xml.toString("utf8").replace(/<w:tab\s*\/>/g, "\t").replace(/<w:(?:br|cr)\s*\/>/g, "\n").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")).trim();
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("DOCX document.xml is missing");
}

function assertRange(data: Buffer, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > data.length - length) throw new Error("Invalid DOCX structure");
}

function limitedText(text: string): string {
  const encoded = Buffer.from(text);
  return encoded.length <= MAX_EXTRACTED_BYTES ? text : `${encoded.subarray(0, MAX_EXTRACTED_BYTES).toString("utf8")}\n[truncated]`;
}

function commissionDetails(database: DatabaseSync, id: string) {
  const commission = commissionById(database, id);
  return {
    ...commission,
    attachments: database.prepare("SELECT * FROM attachments WHERE commission_id = ? ORDER BY created_at, rowid").all(id),
    messages: database.prepare("SELECT * FROM requirement_messages WHERE commission_id = ? ORDER BY created_at, rowid").all(id),
    requirements: database.prepare("SELECT * FROM requirement_versions WHERE commission_id = ? ORDER BY version_no DESC").all(id)
  };
}

function commissionById(database: DatabaseSync, id: string): CommissionRow {
  const commission = database.prepare("SELECT * FROM commissions WHERE id = ?").get(id) as CommissionRow | undefined;
  if (!commission) throw notFound("Commission not found");
  return commission;
}

function mutableCommission(database: DatabaseSync, id: string): CommissionRow {
  const commission = commissionById(database, id);
  if (commission.lifecycle_operation) throw conflict("Commission lifecycle operation is in progress");
  if (commission.archived_at || ["done", "archived"].includes(commission.status)) throw conflict("Commission is not editable");
  return commission;
}

function projectExists(database: DatabaseSync, id: string): void {
  if (!database.prepare("SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL").get(id)) throw notFound("Project not found");
}

function requirementById(database: DatabaseSync, id: string) {
  const requirement = database.prepare("SELECT * FROM requirement_versions WHERE id = ?").get(id);
  if (!requirement) throw notFound("Requirement not found");
  return requirement as { id: string; commission_id: string; status: string };
}

function currentPendingRequirement(database: DatabaseSync, id: string) {
  const requirement = requirementById(database, id);
  if (requirement.status !== "awaiting_approval") throw conflict("Requirement is not awaiting approval");
  const commission = mutableCommission(database, requirement.commission_id);
  const current = database.prepare("SELECT id FROM requirement_versions WHERE commission_id = ? AND status = 'awaiting_approval' ORDER BY version_no DESC LIMIT 1").get(commission.id) as { id: string } | undefined;
  if (commission.status !== "awaiting_requirement_approval" || current?.id !== requirement.id) throw conflict("Requirement is not the current approval candidate");
  return { requirement, commission };
}

function assertNoPendingRequirement(database: DatabaseSync, commissionId: string): void {
  if (database.prepare("SELECT 1 FROM requirement_versions WHERE commission_id = ? AND status = 'awaiting_approval'").get(commissionId)) throw conflict("Commission already has a requirement awaiting approval");
}

function insertMessage(database: DatabaseSync, commissionId: string, role: "human" | "agent" | "system", content: string, createdAt: string, options?: string[]): string {
  const id = randomUUID();
  database.prepare("INSERT INTO requirement_messages (id, commission_id, role, content, created_at, options_json) VALUES (?, ?, ?, ?, ?, ?)").run(id, commissionId, role, content, createdAt, options ? JSON.stringify(options) : null);
  return id;
}

function validateOptions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 5) throw badGateway("Requirement Agent returned invalid question options");
  const options = value.map((option) => typeof option === "string" ? option.trim() : "");
  if (options.some((option) => !option) || new Set(options).size !== options.length) throw badGateway("Requirement Agent returned invalid question options");
  return options;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${name} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name);
}

function requiredHeader(value: string | string[] | undefined, name: string): string {
  if (Array.isArray(value)) value = value[0];
  return requiredString(value, name);
}

function decodedFileName(value: string): string {
  try { return decodeURIComponent(value); }
  catch (error) { throw badRequest("Invalid attachment name encoding", error); }
}

function statusError(message: string, statusCode: number, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { statusCode });
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return undefined;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" && status >= 400 && status < 600 ? status : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "需求分析失败，请重试。";
}

const badRequest = (message: string, cause?: unknown) => statusError(message, 400, cause);
const badGateway = (message: string) => statusError(message, 502);
const notFound = (message: string) => statusError(message, 404);
const conflict = (message: string) => statusError(message, 409);
const unavailable = (message: string) => statusError(message, 503);
