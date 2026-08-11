import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { openWorkshopDatabase } from "./database.ts";
import { registerDocumentRoutes } from "./documents.ts";
import { notify, registerNotificationRoutes } from "./notifications.ts";

test("keeps locked document versions immutable and exposes locatable notifications", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-documents-"));
  const database = await openWorkshopDatabase(home);
  const server = Fastify();
  registerDocumentRoutes(server, database);
  registerNotificationRoutes(server, database);
  try {
    const now = new Date().toISOString();
    const root = randomUUID(), project = randomUUID(), document = randomUUID(), version = randomUUID();
    database.prepare("INSERT INTO root_paths (id, path, real_path, enabled, created_at, updated_at) VALUES (?, 'root', 'root', 1, ?, ?)").run(root, now, now);
    database.prepare("INSERT INTO projects (id, name, path, real_path, root_path_id, vcs_type, created_at, updated_at) VALUES (?, 'Project', 'project', 'project', ?, 'none', ?, ?)").run(project, root, now, now);
    database.prepare("INSERT INTO documents (id, project_id, type, title, created_at) VALUES (?, ?, 'decision', 'ADR', ?)").run(document, project, now);
    database.prepare("INSERT INTO document_versions (id, document_id, version_no, content_markdown, source_json, locked, created_by, created_at) VALUES (?, ?, 1, '# v1', '{}', 0, 'human', ?)").run(version, document, now);
    database.prepare("UPDATE documents SET current_version_id = ? WHERE id = ?").run(version, document);

    assert.equal((await server.inject({ method: "POST", url: `/api/documents/${document}/lock` })).statusCode, 200);
    assert.equal((await server.inject({ method: "PUT", url: `/api/documents/${document}`, payload: { contentMarkdown: "# v2" } })).statusCode, 200);
    const versions = database.prepare("SELECT version_no, content_markdown, locked FROM document_versions WHERE document_id = ? ORDER BY version_no").all(document).map((row) => ({ ...row }));
    assert.deepEqual(versions, [{ version_no: 1, content_markdown: "# v1", locked: 1 }, { version_no: 2, content_markdown: "# v2", locked: 0 }]);
    assert.equal((await server.inject({ method: "GET", url: `/api/documents/${document}/export.md` })).body, "# v2");
    assert.match((await server.inject({ method: "POST", url: `/api/projects/${project}/documents/query`, payload: { query: "v1" } })).json()[0].href, /version=1/);

    notify(database, "acceptance", "等待验收", "打开任务", "task", "task-1");
    const notification = (await server.inject({ method: "GET", url: "/api/notifications?unread=true" })).json()[0];
    assert.equal(notification.entity_id, "task-1");
    assert.ok((await server.inject({ method: "POST", url: `/api/notifications/${notification.id}/read` })).json().read_at);
    assert.equal((await server.inject({ method: "DELETE", url: "/api/notifications/history" })).json().deleted, 1);
    assert.deepEqual((await server.inject({ method: "GET", url: "/api/notifications" })).json(), []);
  } finally { await server.close(); database.close(); await rm(home, { recursive: true, force: true }); }
});
