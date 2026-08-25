import assert from "node:assert/strict";
import test from "node:test";
import { canOpenTaskDelivery, canResumeTaskRun, clipboardImageExtension, commentLinkUrl, commentMentionParts, commentThreadRows, currentRunsForEvents, formatJson, formatRunDuration, formatTokenCount, formatTokenPrice, insertMention, isCommentSubmitShortcut, isLongRunEventDetail, isNearScrollBottom, mentionTriggerAtCursor, parseReviewComment, runDiffChanges, runDiffFilePatches, runDiffPatch, runEventDetail, runQuestions, runTimelineEvents, sameCommentSnapshot, screenshotFileName, taskLifecycleAction, taskMentionParts, tokenPrice, tokenUsageTotals, upsertComment } from "./task-run.ts";

test("recognizes supported clipboard images and generates readable screenshot names", () => {
  assert.equal(clipboardImageExtension("image/png"), "png");
  assert.equal(clipboardImageExtension("IMAGE/JPEG"), "jpg");
  assert.equal(clipboardImageExtension("image/gif"), "gif");
  assert.equal(clipboardImageExtension("image/webp"), "webp");
  assert.equal(clipboardImageExtension("text/plain"), null);
  assert.equal(screenshotFileName("image/png", new Date(2026, 7, 12, 16, 30, 45)), "截图-20260812-163045.png");
});

test("recognizes Ctrl or Command plus Enter as the comment submit shortcut", () => {
  assert.equal(isCommentSubmitShortcut({ key: "Enter", ctrlKey: true, metaKey: false }), true);
  assert.equal(isCommentSubmitShortcut({ key: "Enter", ctrlKey: false, metaKey: true }), true);
  assert.equal(isCommentSubmitShortcut({ key: "Enter", ctrlKey: false, metaKey: false }), false);
  assert.equal(isCommentSubmitShortcut({ key: "Enter", ctrlKey: true, metaKey: false, isComposing: true }), false);
  assert.equal(isCommentSubmitShortcut({ key: "NumpadEnter", ctrlKey: true, metaKey: false }), false);
});

test("only offers generic resume for active ordinary interrupted tasks", () => {
  assert.equal(canResumeTaskRun("in_progress", { status: "interrupted", trigger_type: "manual" }), true);
  assert.equal(canResumeTaskRun("archived", { status: "interrupted", trigger_type: "manual" }), false);
  assert.equal(canResumeTaskRun("in_progress", { status: "interrupted", trigger_type: "plan_revision" }), false);
  assert.equal(canResumeTaskRun("in_progress", { status: "interrupted", trigger_type: "coordinate" }), false);
});

test("offers task lifecycle actions only for Done and Archived tasks", () => {
  assert.equal(taskLifecycleAction("done"), "archive");
  assert.equal(taskLifecycleAction("archived"), "unarchive");
  assert.equal(taskLifecycleAction("archived", true), null);
  assert.equal(taskLifecycleAction("in_progress"), null);
});

test("offers the delivery entry only for active main tasks", () => {
  assert.equal(canOpenTaskDelivery({ parent_id: null, archived_at: null }), true);
  assert.equal(canOpenTaskDelivery({ parent_id: "main", archived_at: null }), false);
  assert.equal(canOpenTaskDelivery({ parent_id: null, archived_at: "2026-08-19T00:00:00.000Z" }), false);
});

test("formats Agent Run elapsed time", () => {
  assert.equal(formatRunDuration(3_723_000), "01:02:03");
  assert.equal(formatRunDuration(-1), "00:00:00");
});

test("totals task tokens while keeping cached input as a subset", () => {
  assert.deepEqual(tokenUsageTotals([{ token_input: 100, token_output: 40, token_cached: 80 }, { token_input: 20, token_output: 10, token_cached: 0 }]), { total: 170, input: 120, output: 50, cached: 80 });
  assert.equal(tokenUsageTotals([{ token_input: null, token_output: null, token_cached: null }]), null);
  assert.equal(formatTokenCount(12345), "12,345");
  assert.equal(tokenPrice([{ token_input: 100, token_output: 40, token_cached: 80, configSnapshot: { model: "gpt-5.6-sol" } }]), 0.00134);
  assert.equal(tokenPrice([{ token_input: 100, token_output: 40, token_cached: 80, configSnapshot: { model: "echo/gpt-5.6-sol" } }]), 0.00134);
  assert.equal(tokenPrice([{ token_input: 1_000_000, token_output: 1_000_000, token_cached: 1_000_000, configSnapshot: { model: "deepseek/deepseek-v4-flash" } }]), 0.2828);
  assert.equal(tokenPrice([{ token_input: 1_000_000, token_output: 1_000_000, token_cached: 1_000_000, configSnapshot: { model: "deepseek/deepseek-v4-pro" } }]), 0.873625);
  assert.equal(tokenPrice([{ token_input: 100, token_output: 40, token_cached: 80 }]), null);
  assert.equal(formatTokenPrice(1.23456), "$1.2346");
});

test("shows Agent message text from timeline delta events", () => {
  assert.equal(runEventDetail({ id: 1, event_type: "agent.message.delta", summary: "Agent message", created_at: "2026-08-07T00:00:00.000Z", payload: { delta: "正在检查调用链" } }), "正在检查调用链");
  assert.equal(isLongRunEventDetail("简短消息"), false);
  assert.equal(isLongRunEventDetail("一\n二\n三\n四"), true);
});

test("shows useful details for Run decisions and tool activity", () => {
  const event = (event_type: string, payload: Record<string, unknown>) => ({ id: 1, event_type, summary: "Event", created_at: "2026-08-07T00:00:00.000Z", payload });
  assert.equal(runEventDetail(event("human.message", { message: "继续检查 Windows" })), "消息：继续检查 Windows");
  assert.match(runEventDetail(event("command_execution.completed", { item: { command: "npm test", exitCode: 0 } })), /命令：npm test\n退出码：0/);
  assert.match(runEventDetail(event("tool.completed", { item: { tool: "read", arguments: { path: "src/app.ts" } } })), /工具：read[\s\S]*src\/app.ts/);
  assert.equal(runEventDetail(event("approval.resolved", { decision: "accepted" })), "决定：accepted");
  assert.equal(runEventDetail(event("input.resolved", { answers: { scope: { answers: ["完整"] } } })), "scope：完整");
  assert.equal(runEventDetail(event("token.usage", { total: 10 })), "");
});

test("merges streaming Agent message deltas into one timeline entry", () => {
  const events = ["我", "会", "先", "读", "完"].map((delta, index) => ({ id: index + 1, event_type: "agent.message.delta", summary: "Agent message", created_at: "2026-08-07T00:00:00.000Z", payload: { itemId: "message-1", delta } }));
  assert.deepEqual(runTimelineEvents(events).map(runEventDetail), ["我会先读完"]);
  assert.equal(runTimelineEvents([...events, { ...events[0]!, id: 6, payload: { itemId: "message-2", delta: "下一条" } }]).length, 2);
  const output = ["pass ", "86"].map((delta, index) => ({ id: index + 1, event_type: "command.output", summary: "Command output", created_at: "2026-08-07T00:00:00.000Z", payload: { itemId: "command-1", delta } }));
  assert.deepEqual(runTimelineEvents(output).map(runEventDetail), ["pass 86"]);
  assert.deepEqual(runTimelineEvents([{ ...output[0]!, event_type: "token.usage" }]), []);
});

test("reads runnable Agent input questions and ignores malformed entries", () => {
  assert.deepEqual(runQuestions({
    id: 1,
    event_type: "input.requested",
    summary: "Input requested",
    created_at: "2026-08-07T00:00:00.000Z",
    payload: { questions: [null, { id: "scope", header: "范围", question: "选择范围", options: [{ label: "完整", description: "执行全部" }] }] }
  }), [{ id: "scope", header: "范围", question: "选择范围", options: [{ label: "完整", description: "执行全部" }] }]);
});

test("formats evidence JSON with readable line breaks", () => {
  assert.equal(formatJson('{"status":"passed","details":{"count":2}}'), '{\n  "status": "passed",\n  "details": {\n    "count": 2\n  }\n}');
  assert.equal(formatJson("not-json"), "not-json");
});

test("orders issue comments with their replies", () => {
  const root = { id: "root", parent_id: null, content: "root" };
  const reply = { id: "reply", parent_id: "root", content: "reply" };
  const nested = { id: "nested", parent_id: "reply", content: "nested" };
  assert.deepEqual(commentThreadRows([root, nested, reply]).map(({ comment, depth }) => [comment.id, depth]), [["root", 0], ["reply", 1], ["nested", 2]]);
});

test("does not duplicate a comment already loaded by polling", () => {
  const polled = { id: "comment-1", content: "已保存" };
  const posted = { id: "comment-1", content: "已保存", agentMention: { action: "triggered" } };
  assert.deepEqual(upsertComment([polled], posted), [posted]);
  assert.deepEqual(upsertComment([], posted), [posted]);
});

test("loads only the current Run events during task refresh", () => {
  assert.deepEqual(currentRunsForEvents([{ id: "current" }, { id: "history-1" }, { id: "history-2" }]), [{ id: "current" }]);
  assert.deepEqual(currentRunsForEvents([]), []);
});

test("shows the comment scroll control until the viewport reaches 90 percent", () => {
  assert.equal(isNearScrollBottom({ scrollTop: 699, clientHeight: 200, scrollHeight: 1000 }), false);
  assert.equal(isNearScrollBottom({ scrollTop: 700, clientHeight: 200, scrollHeight: 1000 }), true);
  assert.equal(isNearScrollBottom({ scrollTop: 0, clientHeight: 500, scrollHeight: 500 }), true);
});

test("reads one terminal workspace diff per Developer Run", () => {
  assert.deepEqual(runDiffChanges(JSON.stringify({ changes: [
    { path: "src/app.ts", changeType: "modified", baselineHash: "before", hash: "after", safe: true },
    { path: "src/new.ts", changeType: "added", baselineHash: null, hash: "new", safe: false }
  ] })), [
    { path: "src/app.ts", changeType: "modified", baselineHash: "before", hash: "after", safe: true },
    { path: "src/new.ts", changeType: "added", baselineHash: null, hash: "new", safe: false }
  ]);
  assert.deepEqual(runDiffChanges("invalid"), []);
  assert.equal(runDiffPatch(JSON.stringify({ patch: "diff --git a/src/app.ts b/src/app.ts" })), "diff --git a/src/app.ts b/src/app.ts");
  assert.deepEqual(runDiffFilePatches(JSON.stringify({ patch: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/src/new.ts b/src/new.ts\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+new" })), [
    { path: "src/app.ts", changeType: "modified", patch: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new" },
    { path: "src/new.ts", changeType: "modified", patch: "diff --git a/src/new.ts b/src/new.ts\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+new" }
  ]);
  assert.deepEqual(runDiffFilePatches(JSON.stringify({ patch: "diff --git \"a/\\346\\226\\207\\346\\241\\243.md\" \"b/\\346\\226\\207\\346\\241\\243.md\"\n--- \"a/\\346\\226\\207\\346\\241\\243.md\"\n+++ \"b/\\346\\226\\207\\346\\241\\243.md\"\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\ndiff --git a/docs/read me.md b/docs/read me.md\nold mode 100644\nnew mode 100755" })), [
    { path: "文档.md", changeType: "modified", patch: "diff --git \"a/\\346\\226\\207\\346\\241\\243.md\" \"b/\\346\\226\\207\\346\\241\\243.md\"\n--- \"a/\\346\\226\\207\\346\\241\\243.md\"\n+++ \"b/\\346\\226\\207\\346\\241\\243.md\"\n@@ -1 +1 @@\n-old\n+new" },
    { path: "new.txt", changeType: "renamed", patch: "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt" },
    { path: "docs/read me.md", changeType: "modified", patch: "diff --git a/docs/read me.md b/docs/read me.md\nold mode 100644\nnew mode 100755" }
  ]);
  assert.deepEqual(runDiffFilePatches(JSON.stringify({ patch: "diff --git a/old.txt b/b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to b/new.txt" })), [
    { path: "b/new.txt", changeType: "renamed", patch: "diff --git a/old.txt b/b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to b/new.txt" }
  ]);
  assert.equal(runDiffFilePatches(JSON.stringify({ patch: "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt" }))[0]?.changeType, "added");
  assert.equal(runDiffFilePatches(JSON.stringify({ patch: "diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null" }))[0]?.changeType, "deleted");
  assert.equal(runDiffPatch("invalid"), "");
});

test("reuses the comment snapshot when polling returns unchanged data", () => {
  const comments = [{ id: "comment-1", content: "已保存" }];
  assert.equal(sameCommentSnapshot(comments, [{ id: "comment-1", content: "已保存" }]), true);
  assert.equal(sameCommentSnapshot(comments, [{ id: "comment-1", content: "已更新" }]), false);
  assert.equal(sameCommentSnapshot(comments, []), false);
});

test("parses clickable task mentions without matching ordinary version text", () => {
  assert.deepEqual(taskMentionParts("查看 @任务1.2 后继续"), ["查看 ", { numberPath: "1.2", label: "@任务1.2" }, " 后继续"]);
  assert.deepEqual(taskMentionParts("版本 1.2"), ["版本 1.2"]);
  assert.deepEqual(commentMentionParts("@Agent 请查看 @任务1.2 并通知 @负责人"), [
    { kind: "role", label: "@Agent" }, " 请查看 ", { kind: "task", numberPath: "1.2", label: "@任务1.2" }, " 并通知 ", { kind: "role", label: "@负责人" }
  ]);
});

test("only makes absolute web URLs clickable in comments", () => {
  assert.equal(commentLinkUrl("https://example.com/docs"), "https://example.com/docs");
  assert.equal(commentLinkUrl("HTTP://example.com"), "HTTP://example.com");
  assert.equal(commentLinkUrl("/tasks/1"), undefined);
  assert.equal(commentLinkUrl("#details"), undefined);
});

test("parses structured review findings without consuming ordinary JSON", () => {
  const parsed = parseReviewComment('## 代码审查结果：未通过\n\n摘要\n\n### 发现\n\n- {"severity":"blocking","file":"src/main.cpp","line":42,"message":"需要回滚"}\n{"severity":"warning","file":null,"line":null,"message":"缺少冒烟证据"}\n\n@负责人 请关注');
  assert.deepEqual(parsed, {
    markdown: "## 代码审查结果：未通过\n\n摘要\n\n@负责人 请关注",
    findings: [
      { severity: "blocking", file: "src/main.cpp", line: 42, message: "需要回滚" },
      { severity: "warning", file: null, line: null, message: "缺少冒烟证据" }
    ]
  });
  assert.equal(parseReviewComment('普通评论：{"ok":true}'), null);
});

test("finds and replaces the mention being typed at the cursor", () => {
  assert.deepEqual(mentionTriggerAtCursor("请检查 @任", 6), { start: 4, query: "任" });
  assert.equal(mentionTriggerAtCursor("mail@example", 12), null);
  assert.deepEqual(insertMention("请检查 @任", { start: 4, query: "任" }, 6, "@任务1.2"), { content: "请检查 @任务1.2 ", cursor: 11 });
});
