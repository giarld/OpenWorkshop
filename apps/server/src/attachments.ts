import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { extractAttachmentText } from "./commissions.ts";

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_COMMISSION_ATTACHMENT_BYTES = 200 * 1024 * 1024;
export const SUPPORTED_ATTACHMENT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".txt", ".md", ".pdf", ".docx"]);
export const ATTACHMENT_MEDIA_TYPES = [
  "application/octet-stream",
  "application/pdf",
  "application/x-pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "text/markdown",
  "text/x-markdown",
  "text/plain"
] as const;

const ATTACHMENT_MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};
const ATTACHMENT_MEDIA_TYPES_BY_EXTENSION: Readonly<Record<string, ReadonlySet<string>>> = {
  ".png": new Set(["image/png"]),
  ".jpg": new Set(["image/jpeg", "image/jpg"]),
  ".jpeg": new Set(["image/jpeg", "image/jpg"]),
  ".gif": new Set(["image/gif"]),
  ".webp": new Set(["image/webp"]),
  ".txt": new Set(["text/plain"]),
  ".md": new Set(["text/markdown", "text/x-markdown", "text/plain"]),
  ".pdf": new Set(["application/pdf", "application/x-pdf"]),
  ".docx": new Set(["application/vnd.openxmlformats-officedocument.wordprocessingml.document"])
};
const commissionUploadTails = new Map<string, Promise<void>>();

export type AttachmentRow = {
  id: string;
  commission_id: string;
  task_id: string | null;
  comment_id: string | null;
  run_id: string | null;
  original_name: string;
  media_type: string;
  size_bytes: number;
  storage_path: string;
  sha256: string;
  extracted_text: string | null;
  created_at: string;
};

export function registerAttachmentParsers(server: FastifyInstance): void {
  for (const mediaType of ATTACHMENT_MEDIA_TYPES) {
    if (mediaType === "text/plain" && server.hasContentTypeParser(mediaType)) server.removeContentTypeParser(mediaType);
    if (!server.hasContentTypeParser(mediaType)) server.addContentTypeParser(mediaType, { parseAs: "buffer", bodyLimit: MAX_ATTACHMENT_BYTES }, (_request, body, done) => done(null, body));
  }
}

export async function storeAttachment(database: DatabaseSync, attachmentsRoot: string, input: { commissionId: string; taskId?: string | null; originalName: string; mediaType: string; data: Buffer }): Promise<AttachmentRow> {
  const extension = extname(input.originalName).toLowerCase();
  if (basename(input.originalName) !== input.originalName || !SUPPORTED_ATTACHMENT_EXTENSIONS.has(extension)) throw statusError("Unsupported or unsafe attachment name", 400);
  if (input.data.length > MAX_ATTACHMENT_BYTES) throw statusError("Attachment exceeds 50 MB", 413);
  const mediaType = ATTACHMENT_MEDIA_TYPE_BY_EXTENSION[extension]!;
  if (input.mediaType !== "application/octet-stream" && !ATTACHMENT_MEDIA_TYPES_BY_EXTENSION[extension]!.has(input.mediaType)) throw statusError("Attachment media type does not match its extension", 400);
  if (mediaType.startsWith("image/") && !hasImageSignature(extension, input.data)) throw statusError("Attachment content does not match its image extension", 400);
  return serializeCommissionUpload(input.commissionId, async () => {
    const used = (database.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM attachments WHERE commission_id = ?").get(input.commissionId) as { bytes: number }).bytes;
    if (used + input.data.length > MAX_COMMISSION_ATTACHMENT_BYTES) throw statusError("Commission attachments exceed 200 MB", 413);

    const id = randomUUID();
    const directory = join(attachmentsRoot, input.commissionId);
    const storagePath = join(directory, id);
    await mkdir(directory, { recursive: true });
    await writeFile(storagePath, input.data, { flag: "wx" });
    try {
      database.prepare(`INSERT INTO attachments
        (id, commission_id, task_id, original_name, media_type, size_bytes, storage_path, sha256, extracted_text, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.commissionId, input.taskId ?? null, input.originalName, mediaType, input.data.length, storagePath, createHash("sha256").update(input.data).digest("hex"), extractAttachmentText(extension, input.data), new Date().toISOString());
    } catch (error) {
      await rm(storagePath, { force: true });
      throw error;
    }
    return attachmentById(database, id);
  });
}

function hasImageSignature(extension: string, data: Buffer): boolean {
  if (extension === ".png") return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === ".jpg" || extension === ".jpeg") return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (extension === ".gif") return data.length >= 6 && (data.subarray(0, 6).equals(Buffer.from("GIF87a", "ascii")) || data.subarray(0, 6).equals(Buffer.from("GIF89a", "ascii")));
  if (extension === ".webp") return data.length >= 12 && data.subarray(0, 4).equals(Buffer.from("RIFF", "ascii")) && data.subarray(8, 12).equals(Buffer.from("WEBP", "ascii"));
  return false;
}

async function serializeCommissionUpload<T>(commissionId: string, action: () => Promise<T>): Promise<T> {
  const previous = commissionUploadTails.get(commissionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  commissionUploadTails.set(commissionId, current);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (commissionUploadTails.get(commissionId) === current) commissionUploadTails.delete(commissionId);
  }
}

export function attachmentById(database: DatabaseSync, id: string): AttachmentRow {
  const attachment = database.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as AttachmentRow | undefined;
  if (!attachment) throw statusError("Attachment not found", 404);
  return attachment;
}

export function taskAttachments(database: DatabaseSync, taskId: string): AttachmentRow[] {
  return database.prepare("SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at, rowid").all(taskId) as AttachmentRow[];
}

export function selectedTaskAttachments(database: DatabaseSync, taskId: string, ids: readonly string[], availability: false | "unlinked" | "not-run" = false): AttachmentRow[] {
  if (!ids.length) return [];
  const unique = [...new Set(ids)];
  const placeholders = unique.map(() => "?").join(", ");
  const pending = availability === "unlinked" ? " AND comment_id IS NULL AND run_id IS NULL" : availability === "not-run" ? " AND run_id IS NULL" : "";
  const rows = database.prepare(`SELECT * FROM attachments WHERE task_id = ? AND id IN (${placeholders})${pending} ORDER BY created_at, rowid`).all(taskId, ...unique) as AttachmentRow[];
  if (rows.length !== unique.length) throw statusError("Attachment does not belong to this task or is already used", 400);
  return rows;
}

export function attachmentMessage(message: string, attachments: ReadonlyArray<Pick<AttachmentRow, "original_name" | "storage_path" | "extracted_text">>): string {
  if (!attachments.length) return message;
  const details = attachments.map((attachment) => {
    const header = `## 附件：${attachment.original_name}\n\n本地路径：${attachment.storage_path}`;
    return attachment.extracted_text ? `${header}\n\n提取文本：\n\n${attachment.extracted_text}` : header;
  }).join("\n\n");
  return `${message}\n\n# 本次消息附件\n\n${details}`;
}

export function localImageInputs(attachments: readonly AttachmentRow[]): Array<{ type: "localImage"; path: string }> {
  return attachments.filter((attachment) => attachment.media_type.startsWith("image/")).map((attachment) => ({ type: "localImage", path: attachment.storage_path }));
}

export async function attachmentData(attachment: AttachmentRow, attachmentsRoot: string): Promise<Buffer> {
  const expected = resolve(attachmentsRoot, attachment.commission_id, attachment.id);
  if (resolve(attachment.storage_path) !== expected) throw statusError("Attachment path is invalid", 409);
  return readFile(expected);
}

export function runAttachmentCopies(attachments: readonly AttachmentRow[], runDirectory: string): AttachmentRow[] {
  return attachments.map((attachment) => ({ ...attachment, storage_path: join(runDirectory, "attachments", attachment.id, attachment.original_name) }));
}

export async function materializeRunAttachments(attachments: readonly AttachmentRow[], attachmentsRoot: string, runDirectory: string): Promise<AttachmentRow[]> {
  const copies = runAttachmentCopies(attachments, runDirectory);
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index]!;
    const copy = copies[index]!;
    const data = await attachmentData(attachment, attachmentsRoot);
    if (createHash("sha256").update(data).digest("hex") !== attachment.sha256) throw statusError("Attachment integrity check failed", 409);
    await mkdir(dirname(copy.storage_path), { recursive: true });
    try {
      await writeFile(copy.storage_path, data, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(copy.storage_path);
      if (createHash("sha256").update(existing).digest("hex") !== attachment.sha256) throw statusError("Run attachment copy is invalid", 409);
    }
  }
  return copies;
}

export async function removePendingAttachment(database: DatabaseSync, attachmentsRoot: string, taskId: string, attachmentId: string): Promise<void> {
  const attachment = selectedTaskAttachments(database, taskId, [attachmentId], "unlinked")[0]!;
  database.prepare("DELETE FROM attachments WHERE id = ?").run(attachment.id);
  await rm(resolve(attachmentsRoot, attachment.commission_id, attachment.id), { force: true });
}

function statusError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}
