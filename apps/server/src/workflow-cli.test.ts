import assert from "node:assert/strict";
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

test("maps task unarchive to the dedicated endpoint", async () => {
  assert.equal((await parseWorkflowCommand(["task", "unarchive", "task-id"])).path, "/api/tasks/task-id/unarchive");
});

test("maps commission lifecycle actions to dedicated endpoints", async () => {
  assert.equal((await parseWorkflowCommand(["commission", "delete", "commission-id"])).method, "DELETE");
  assert.equal((await parseWorkflowCommand(["commission", "archive", "commission-id"])).path, "/api/commissions/commission-id/archive");
  assert.equal((await parseWorkflowCommand(["commission", "reactivate", "commission-id"])).path, "/api/commissions/commission-id/reactivate");
});
