import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseWorkflowCommand, WORKFLOW_COMMANDS } from "./workflow-cli.ts";

test("workflow commands map agent input to API requests", async () => {
  assert.ok(Object.keys(WORKFLOW_COMMANDS).length >= 50);
  assert.deepEqual(await parseWorkflowCommand([
    "task", "move", "task/id", "--query", "{\"view\":\"tree\"}", "--data", "{\"status\":\"blocked\"}", "--output", "json"
  ]), {
    method: "POST",
    path: "/api/tasks/task%2Fid/move",
    query: { view: "tree" },
    body: "{\"status\":\"blocked\"}",
    contentType: "application/json",
    output: "json"
  });
});

test("generic API access stays inside the API namespace", async () => {
  assert.equal((await parseWorkflowCommand(["api", "GET", "/api/health"])).path, "/api/health");
  await assert.rejects(parseWorkflowCommand(["api", "GET", "/admin"]), /must start with \/api\//);
});

test("maps direct approved requirement creation", async () => {
  assert.equal((await parseWorkflowCommand([
    "requirement", "create-approved", "commission-id", "--data", '{"contentMarkdown":"# Goal","acceptanceCriteria":[]}'
  ])).path, "/api/commissions/commission-id/requirements/approved");
});

test("reads query JSON from a file for PowerShell-safe calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workshop-query-file-"));
  try {
    const path = join(directory, "query.json");
    await writeFile(path, '\uFEFF{"commissionId":"commission-id","view":"tree"}');
    assert.deepEqual((await parseWorkflowCommand(["task", "list", "project-id", "--query-file", path])).query, { commissionId: "commission-id", view: "tree" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("maps task unarchive to the dedicated endpoint", async () => {
  assert.equal((await parseWorkflowCommand(["task", "unarchive", "task-id"])).path, "/api/tasks/task-id/unarchive");
});

test("maps task logical deletion to the dedicated endpoint", async () => {
  const request = await parseWorkflowCommand(["task", "delete", "task-id", "--data", '{"reason":"Duplicate task"}']);
  assert.deepEqual({ method: request.method, path: request.path, body: request.body }, { method: "DELETE", path: "/api/tasks/task-id", body: '{"reason":"Duplicate task"}' });
});

test("maps project task numbers to the dedicated lookup endpoint", async () => {
  assert.equal((await parseWorkflowCommand(["task", "get-number", "project/id", "12.3"])).path, "/api/projects/project%2Fid/tasks/by-number/12.3");
});

test("maps commission lifecycle actions to dedicated endpoints", async () => {
  assert.equal((await parseWorkflowCommand(["commission", "delete", "commission-id"])).method, "DELETE");
  assert.equal((await parseWorkflowCommand(["commission", "archive", "commission-id"])).path, "/api/commissions/commission-id/archive");
  assert.equal((await parseWorkflowCommand(["commission", "reactivate", "commission-id"])).path, "/api/commissions/commission-id/reactivate");
});
