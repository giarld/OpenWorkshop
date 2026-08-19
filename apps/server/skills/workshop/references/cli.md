# Workshop CLI reference

## Common syntax

```text
workshop <family> <action> [id ...] [--query '{...}' | --query-file path] [--data '{...}' | --data-file path] --output json
```

Use `--server-url URL` for a non-default server. Use `WORKSHOP_SERVER_URL` when every call targets the same server.

PowerShell 中优先把 JSON 写入 UTF-8 文件，再使用 `--data-file` 或 `--query-file`，避免原生命令参数转义差异：

```powershell
@{ commissionId = "<commission-id>"; view = "tree" } | ConvertTo-Json -Compress | Set-Content -Encoding utf8 query.json
workshop task list <project-id> --query-file query.json --output json
```

## Service and authentication

```bash
workshop start
workshop status --output json
workshop gui
workshop log -n 100
workshop restart
workshop stop
workshop doctor --output json
workshop auth status --output json
```

`workshop login` and PIN initialization require human interaction. Check `runtime codex-health` only before requirement analysis/planning or task execution; ordinary reads do not require it.

Read-only requests must not call write commands. Run create, update, move, delete, archive, clear, trigger, decide, approve, accept, reject, interrupt, cancel, resume, waive, or lock only when explicitly requested.

## Roots and projects

```bash
workshop root list --output json
workshop root create --data '{"path":"/allowed/root","enabled":true}' --output json
workshop root update <root-id> --data '{"enabled":false}' --output json
workshop root browse <root-id> --query '{"path":"relative/path"}' --output json
workshop project list --output json
workshop project create --data '{"name":"Project","path":"relative/path","rootPathId":"<root-id>"}' --output json
workshop project get <project-id> --output json
workshop project update <project-id> --data '{"name":"New name"}' --output json
workshop project scan <project-id> --output json
workshop project archive <project-id> --output json
```

## Commissions and requirements

```bash
workshop commission list <project-id> --output json
workshop commission list <project-id> --query '{"archived":"true"}' --output json
workshop commission create <project-id> --data '{"title":"Objective","message":"Initial request"}' --output json
workshop commission get <commission-id> --output json
workshop commission delete <commission-id> --output json
workshop commission archive <commission-id> --output json
workshop commission reactivate <commission-id> --output json
workshop commission message <commission-id> --data '{"content":"Clarification"}' --output json
workshop commission analyze <commission-id> --output json
workshop commission requirements <commission-id> --output json
workshop commission replan <commission-id> --output json
workshop requirement approve <requirement-id> --output json
workshop requirement reject <requirement-id> --data '{"reason":"Reason"}' --output json
```

Commission creation is a terminal action for the current request unless the user explicitly asks to continue. Upload attachments explicitly supplied with the creation request, then report the new ID and say requirement clarification is next; do not call `commission analyze` automatically.

`commission replan` 在尚无任务树时重新调用规划 Agent；已有任务树时进入现有的计划修订卡片、独立审查和最终人工确认事务。不要用多条 `task update` / `dependency-add` / `archive` / `reorder` 命令模拟一次计划修订。

When the user asks to continue, run `commission get` before choosing the next action:

1. Present an existing pending requirement or unanswered Agent question without calling `analyze`.
2. If the latest message is from the user, run `commission analyze`.
3. Relay Workshop's question and choices without answering for the user.
4. Wait for the user's answer.
5. Send it with `commission message`, analyze again, and relay the next result.
6. When a requirement candidate is returned, present it for review and wait for explicit approval.
7. If the commission already passed clarification, report its current phase instead of restarting it.

Upload supported attachments with an explicit content type:

```bash
workshop commission attachment <commission-id> --file ./request.pdf --content-type application/pdf --output json
```

Requirement approval normally invokes the planning Agent and creates the task plan automatically.

### Direct Agent plan import

Only use this bypass when the user explicitly requests importing a requirement and task plan produced outside Workshop. It skips requirement clarification and the Workshop planning Agent.

`requirement.json`:

```json
{
  "contentMarkdown": "# Requirement\n\nComplete specification.",
  "acceptanceCriteria": ["Tests pass", "Documented"]
}
```

`plan.json`:

```json
{
  "mainTask": {
    "title": "Deliver feature",
    "description": "Coordinate delivery",
    "acceptanceCriteria": ["User accepts delivery"]
  },
  "tasks": [
    {
      "clientId": "implement",
      "title": "Implement feature",
      "ownerType": "ai",
      "acceptanceCriteria": ["Checks pass"],
      "dependsOn": []
    }
  ]
}
```

Import without starting execution:

```bash
workshop requirement create-approved <commission-id> --data-file requirement.json --output json
workshop task create <commission-id> --data-file plan.json --output json
workshop task list <project-id> --query '{"commissionId":"<commission-id>","view":"tree"}' --output json
```

`requirement create-approved` is an approval action. It refuses commissions with a pending requirement or existing tasks. If task import fails after requirement import succeeds, retry only `task create` with a corrected plan.

## Tasks

```bash
workshop task list <project-id> --query '{"commissionId":"<commission-id>","view":"tree"}' --output json
workshop task get <task-id> --output json
workshop task get-number <project-id> <task-number> --output json
workshop task create <commission-id> --data '{"title":"Task","description":"Scope","priority":"high","ownerType":"ai","acceptanceCriteria":["Expected result"],"labels":["cli"],"dependsOnTaskIds":[]}' --output json
workshop task update <task-id> --data '{"priority":"urgent","labels":["cli","blocking"]}' --output json
workshop task delete <task-id> --data '{"reason":"Duplicate task"}' --output json
workshop task move <task-id> --data '{"status":"blocked","blockedReason":"Reason"}' --output json
workshop task reorder <task-id> --data '{"position":0}' --output json
workshop task archive <task-id> --output json
workshop task unarchive <task-id> --output json
```

Task filters include `status`, `priority`, `ownerType`, `label`, `search`, `sort`, `order`, `commissionId`, `view`, and `includeArchived`. Comma-separate multiple statuses or priorities.

Dependencies and comments:

```bash
workshop task dependency-add <task-id> --data '{"dependencyId":"<required-task-id>"}' --output json
workshop task dependency-add <task-id> --data '{"dependsOnTaskIds":["<task-a>","<task-b>"]}' --output json
workshop task dependency-remove <task-id> <dependency-task-id> --output json
workshop task comments <task-id> --output json
workshop task comment-add <task-id> --data '{"content":"Comment","parentId":null}' --output json
workshop task comment-delete <task-id> <comment-id> --output json
```

Execution and acceptance:

```bash
workshop task trigger <task-id> --output json
workshop task runs <task-id> --output json
workshop task pause <task-id> --output json
workshop task cancel <task-id> --output json
workshop task resume <task-id> --output json
workshop task waive <task-id> --data '{"reason":"Reason"}' --output json
workshop task acceptance <main-task-id> --output json
workshop task delivery-preview <main-task-id> --data-file preview.json --output json
workshop task deliver <main-task-id> --data-file delivery.json --output json
workshop delivery get <delivery-id> --output json
workshop delivery retry <delivery-id> --output json
workshop delivery reconcile <delivery-id> --data-file reconcile.json --output json
workshop delivery cancel <delivery-id> --output json
workshop task reject <main-task-id> --data '{"reason":"Required rework"}' --output json
```

`preview.json` contains the selected method, for example `{"method":"document"}`; use `vcs_commit` or `github_pr` with the method-specific commit, remote, branch, or PR fields. Run `task delivery-preview` first, copy its top-level `fingerprint` into `delivery.json` as `previewFingerprint` alongside the same request, then run `task deliver`. Delivery creation is asynchronous: `task deliver` returns the Delivery ID and current status without waiting; use `delivery get` to poll, and `delivery retry` or `delivery cancel` only when the server state permits it. The removed parameterless `task accept` path must not be used.

Before `task trigger`, inspect the task tree and dependencies and explain the scope: a main-task trigger authorizes the full commission tree; a child-task trigger authorizes that task and its unfinished dependency closure. Do not treat an ambiguous request to “start work” as a target selection.

Task statuses: `backlog`, `todo`, `in_progress`, `done`, `blocked`, `archived`. Priorities: `none`, `low`, `medium`, `high`, `urgent`. Owners: `human`, `ai`.
`task delete` performs an audited logical deletion, accepts active or archived child tasks, requires a reason, and preserves comments, Runs, evidence, and history. It rejects main tasks, active Runs, active children, active dependents, and concurrent plan revisions.

## Runs and approvals

```bash
workshop run get <run-id> --output json
workshop run events <run-id> --query '{"after":"0"}' --output json
workshop run steer <run-id> --data '{"message":"Additional instruction"}' --output json
workshop run interrupt <run-id> --output json
workshop run input <run-id> --data '{"requestId":"<request-id>","answers":{"<question-id>":{"answers":["Answer"]}}}' --output json
workshop approval list --query '{"status":"pending","runId":"<run-id>"}' --output json
workshop approval decide <approval-id> --data '{"decision":"accepted"}' --output json
workshop approval decide <approval-id> --data '{"decision":"declined","details":{"reason":"Reason"}}' --output json
```

Poll only while a Run is `queued`, `preparing`, or `running`. Stop for `waiting_approval` or `waiting_input` and relay the required action. Stop and summarize `succeeded`, `failed`, `cancelled`, or `interrupted`. An empty event response is not completion.

## Documents, notifications, and runtime

```bash
workshop document list <project-id> --query '{"commissionId":"<commission-id>","type":"delivery"}' --output json
workshop document get <document-id> --output json
workshop document update <document-id> --data '{"contentMarkdown":"# Updated"}' --output json
workshop document lock <document-id> --output json
workshop document export <document-id>
workshop document query <project-id> --data '{"query":"term"}' --output json
workshop notification list --query '{"unread":"true"}' --output json
workshop notification read <notification-id> --output json
workshop notification clear --output json
workshop runtime status --output json
workshop runtime codex-health --output json
```

## Generic API fallback

```bash
workshop api GET /api/health --output json
workshop api POST /api/path --data '{"key":"value"}' --output json
```

Only use paths beginning with `/api/`. Prefer a dedicated command whenever one exists, and never use the fallback to bypass validation or authorization.
