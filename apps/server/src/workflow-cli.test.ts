import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { familyHelp, formatWorkflowResult, parseWorkflowCommand, workflowHelp, workflowHttpError, WORKFLOW_COMMANDS } from "./workflow-cli.ts";

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

test("maps delivery commands and reads their request from --data-file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workshop-delivery-cli-"));
  try {
    const previewFile = join(directory, "preview.json");
    const deliveryFile = join(directory, "delivery.json");
    await writeFile(previewFile, String.fromCharCode(0xfeff) + JSON.stringify({ method: "document" }));
    await writeFile(deliveryFile, JSON.stringify({ method: "document", previewFingerprint: "preview-fingerprint" }));
    assert.deepEqual(await parseWorkflowCommand(["task", "delivery-preview", "main-task", "--data-file", previewFile, "--output", "json"]), {
      method: "POST", path: "/api/tasks/main-task/delivery-preview", query: {}, body: JSON.stringify({ method: "document" }), contentType: "application/json", output: "json"
    });
    assert.deepEqual(await parseWorkflowCommand(["task", "deliver", "main-task", "--data-file", deliveryFile, "--output", "json"]), {
      method: "POST", path: "/api/tasks/main-task/deliver", query: {}, body: JSON.stringify({ method: "document", previewFingerprint: "preview-fingerprint" }), contentType: "application/json", output: "json"
    });
    assert.deepEqual(await parseWorkflowCommand(["delivery", "get", "delivery-id", "--output", "json"]), { method: "GET", path: "/api/deliveries/delivery-id", query: {}, output: "json" });
    assert.deepEqual(await parseWorkflowCommand(["delivery", "retry", "delivery-id", "--output", "json"]), { method: "POST", path: "/api/deliveries/delivery-id/retry", query: {}, output: "json" });
    assert.deepEqual(await parseWorkflowCommand(["delivery", "cancel", "delivery-id", "--output", "json"]), { method: "POST", path: "/api/deliveries/delivery-id/cancel", query: {}, output: "json" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("delivery CLI reports actionable data-file errors and keeps task accept disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workshop-delivery-cli-errors-"));
  try {
    const badFile = join(directory, "bad.json");
    await writeFile(badFile, "not json");
    await assert.rejects(parseWorkflowCommand(["task", "deliver", "main-task", "--data-file", badFile]), /--data-file must contain valid JSON/);
    await assert.rejects(parseWorkflowCommand(["task", "deliver", "main-task", "--data-file", join(directory, "missing.json")]), /Unable to read --data-file file/);
    await assert.rejects(parseWorkflowCommand(["task", "deliver", "main-task", "--data", "", "--data-file", badFile]), /Use only one of --data or --data-file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(WORKFLOW_COMMANDS["task accept"], undefined);
  await assert.rejects(parseWorkflowCommand(["task", "accept", "main-task", "--output", "json"]), /Unsupported workflow command: task accept/);
});

test("delivery help, JSON output, and HTTP errors remain machine-readable", () => {
  const help = workflowHelp();
  for (const command of ["task delivery-preview", "task deliver", "delivery get", "delivery retry", "delivery reconcile", "delivery cancel"]) assert.equal(help.includes(command), true);
  assert.match(help, /delivery-preview <main-task-id> --data-file preview\.json/);
  assert.match(help, /task deliver <main-task-id> --data-file delivery\.json/);
  assert.match(familyHelp("task"), /delivery-preview <id> --data-file <path>/);
  assert.match(familyHelp("delivery"), /retry <id>/);
  assert.equal(formatWorkflowResult({ deliveryId: "delivery-id", status: "queued" }, "json"), '{"deliveryId":"delivery-id","status":"queued"}\n');
  assert.equal(workflowHttpError(409, "Conflict", { error: "Preview expired" }, "", "json").message, '{"error":"Preview expired"}');
  assert.equal(workflowHttpError(409, "Conflict", { message: "Preview expired" }, "", "pretty").message, "HTTP 409: Preview expired");
});
