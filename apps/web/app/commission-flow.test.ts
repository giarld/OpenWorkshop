import assert from "node:assert/strict";
import test from "node:test";
import { taskPlanningStatus, uploadClarificationAttachments, clarificationOptionLabel, clarificationOptions, clarificationStep, stageAfterAnalysis } from "./commission-flow.ts";

test("shows exactly the next valid requirement clarification action", () => {
  assert.equal(clarificationStep("clarifying", [{ role: "human" }]), "analyze");
  assert.equal(clarificationStep("clarifying", [{ role: "human" }, { role: "agent" }]), "reply");
  assert.equal(clarificationStep("awaiting_requirement_approval", [{ role: "agent" }]), "complete");
  assert.equal(stageAfterAnalysis("question"), undefined);
  assert.equal(stageAfterAnalysis("requirement"), "requirements");
});

test("reads persisted clarification choices", () => {
  assert.deepEqual(clarificationOptions('["Windows","macOS"]'), ["Windows", "macOS"]);
  assert.deepEqual(clarificationOptions(null), []);
  assert.deepEqual(clarificationOptions("invalid"), []);
});

test("labels only the first option as recommended in its language", () => {
  assert.equal(clarificationOptionLabel("运行完整验证", true), "运行完整验证（推荐）");
  assert.equal(clarificationOptionLabel("Run full validation", true), "Run full validation (Recommended)");
  assert.equal(clarificationOptionLabel("Alternative", false), "Alternative");
});

test("uploads up to ten clarification attachments and reports partial failure", async () => {
  const files = Array.from({ length: 10 }, (_, index) => new File(["text"], `${index}.txt`));
  const uploaded: string[] = [];
  await uploadClarificationAttachments(files, async (file) => { uploaded.push(file.name); });
  assert.deepEqual(uploaded, files.map((file) => file.name));
  await assert.rejects(uploadClarificationAttachments([...files, files[0]!], async () => { assert.fail("must reject before uploading"); }), /最多上传 10/);
  const attempted: string[] = [];
  await assert.rejects(uploadClarificationAttachments(files, async (file) => {
    attempted.push(file.name);
    if (attempted.length === 2) throw new Error("网络错误");
  }), /已上传 1\/10 个附件；1.txt 上传失败：网络错误/);
  assert.deepEqual(attempted, ["0.txt", "1.txt"]);
});

test("distinguishes pending planning, active planning, completion and missing tasks", () => {
  const commission = { status: "awaiting_requirement_approval", main_task_id: null };
  assert.equal(taskPlanningStatus(commission), null);
  assert.match(taskPlanningStatus(commission, true)!, /正在规划任务/);
  assert.match(taskPlanningStatus({ ...commission, status: "planned", task_planning_running: true })!, /正在规划任务/);
  assert.match(taskPlanningStatus({ ...commission, status: "planned" })!, /当前没有正在运行的规划/);
  assert.match(taskPlanningStatus({ ...commission, main_task_id: "main" })!, /任务已生成/);
});
