---
name: workshop
description: Control OpenWorkshop through its local workshop CLI. Use when Codex needs to inspect or manage Workshop roots, projects, commissions, requirement clarification and approval, task trees and dependencies, Agent runs, approvals, acceptance, documents, notifications, service health, or any software delivery workflow coordinated by OpenWorkshop.
---

# Workshop

Use the `workshop` CLI as the sole workflow interface. Do not edit the Workshop SQLite database or runtime files directly.

## Start safely

1. Check installed syntax when uncertain with `workshop --help` and `workshop <family> help`.
2. Check the service and authentication before workflow calls:

   ```bash
   workshop status --output json
   workshop auth status --output json
   ```

3. Check `workshop runtime codex-health --output json` only before Agent-backed actions: requirement analysis, requirement approval and planning, task trigger, or task resume.
4. If login is required, ask the user to run `workshop login`. Never request, pass, store, or print the PIN.
5. Use `--output json` for every command whose result will be parsed.
6. Read canonical IDs from command output. Do not guess IDs from titles or array positions.
7. Classify the request before acting. Questions, explanations, inspection, review, and status requests are read-only and must not run a mutation.

## Route the task

- Roots and allowed directories: `root`
- Local projects and scanning: `project`
- Requests and clarification messages: `commission`
- Requirement decisions: `requirement`
- Task trees, dependencies, execution, and acceptance: `task`
- Active Agent interaction and event polling: `run`
- Command, file, permission, and risk decisions: `approval`
- Versioned project records: `document`
- User attention items: `notification`
- Queue and Codex health: `runtime`

Read [references/cli.md](references/cli.md) for the relevant command family, payload fields, and examples. Load only the sections needed for the current request.

## Follow the delivery workflow

1. Locate the project with `project list`. Create or change a project only when explicitly requested.
2. Create a commission only when explicitly requested, using the user's objective and initial message. If the same request includes attachments, upload those attachments as part of creation before reporting completion.
3. Stop after the commission and its explicitly supplied attachments are stored. Report the commission ID, state that creation is complete, and tell the user that requirement clarification is next. Do not call `commission analyze`, add an unrequested message, approve a requirement, plan tasks, or trigger execution.
4. Continue only when the user explicitly asks to advance a specific commission. First call `commission get` and resume from persisted state:
   - If a requirement is awaiting approval, present that candidate and wait for a decision.
   - If the latest message is an unanswered Agent question, relay it and wait for the user's answer; do not call `commission analyze`.
   - If the latest message is from the user, call `commission analyze` to obtain the next Workshop result.
   - If the commission is already planned, active, paused, blocked, awaiting acceptance, done, or archived, report that phase and do not restart clarification.
5. During active clarification, act only as a communication bridge:
   - Relay the question and any choices to the user without answering, summarizing away constraints, or selecting a choice for them.
   - Stop and wait for the user's answer.
   - Send that answer with `commission message`, then call `commission analyze` again and relay the next result.
   - Repeat one user-answer round at a time until Workshop produces a requirement candidate.
6. When a requirement candidate exists, report its ID and contents for review. Do not approve it unless the user explicitly approves that exact requirement.
7. After approval creates the task plan, inspect the tree but do not trigger execution unless the user explicitly asks.
8. Before triggering, inspect the target and explain its execution scope. Triggering the main task authorizes the whole commission tree; triggering a child authorizes that task plus its unfinished dependency closure. Resolve an ambiguous “start work” request before triggering.
9. Poll Run events incrementally with the last event ID. Surface pending approvals and Agent questions unless the user already authorized that exact decision.
10. Inspect acceptance evidence before asking for or applying final acceptance. Final acceptance is always an explicit human decision.

After commission creation, use an outcome equivalent to:

```text
客户委托已创建：<commission-id>。下一步需要执行需求澄清；需要我继续推进时请告诉我。
```

Do not interpret “create”, “submit”, or “record this commission” as authorization to continue clarification.

## Import an external Agent plan

Use the direct import path only when the user explicitly asks to skip Workshop clarification and import a requirement and task plan produced by Codex plan mode or another Agent.

1. Inspect or create the target commission. Do not call `commission analyze`.
2. Review the supplied requirement Markdown and acceptance criteria with the user. `requirement create-approved` records them immediately as the active approved requirement; the command itself is the approval boundary.
3. Import the requirement:

   ```bash
   workshop requirement create-approved <commission-id> --data-file requirement.json --output json
   ```

4. Import the task plan with the returned commission ID:

   ```bash
   workshop task create <commission-id> --data-file plan.json --output json
   ```

5. Read back the task tree, report the created requirement and task IDs, then stop. Do not trigger execution without a separate explicit request.

Do not use this path when a requirement is awaiting approval or the commission already has tasks. If requirement import succeeds but task import fails, fix and retry only `task create`; do not create another approved requirement.

## Mutation rules

- Treat task create, update, delete, reorder, dependency, archive, and unarchive commands as project-supervisor capabilities. They execute directly and must not start an extra supervisor scheduling Run. Do not use them while acting as a developer or reviewer. Before a structural mutation, verify that the commission has no active Run or pending plan revision; re-read the task tree after the command because structural writes advance its coordination revision. Human task-plan changes must originate in the main-task discussion and pass the product's supervisor review and confirmation flow; direct external plan import remains limited to the explicitly approved workflow above.
- Run create, update, move, delete, archive, clear, trigger, steer, input, decide, approve, accept, reject, interrupt, cancel, resume, waive, lock, or other state-changing actions only when the user explicitly requests that action or it is an unavoidable documented step inside the exact requested operation.
- Prefer dedicated commands over `workshop api`; use the generic API only when the installed CLI lacks a dedicated action.
- Never use `workshop api` to bypass a dedicated command's validation, approval boundary, or missing authorization.
- Before archive, cancel, interrupt, dependency replacement, waiver, rejection, approval, or final acceptance, verify the target ID and current state.
- Do not approve requirements, Agent operations, or final delivery without explicit user authorization for that decision.
- Treat `requirement create-approved` as explicit requirement approval. Never call it for a draft the user has not reviewed or when the user requested the normal clarification workflow.
- Use `--data-file` for long or shell-sensitive JSON. The file must contain a complete JSON value.
- Report the resulting entity ID and state after a mutation.
- On HTTP conflict or validation failure, re-read the entity and explain the current valid next action. Do not retry mutations blindly.

## Track runs without flooding context

```bash
workshop task runs <task-id> --output json
workshop run events <run-id> --query '{"after":"<last-event-id>"}' --output json
workshop approval list --query '{"status":"pending","runId":"<run-id>"}' --output json
```

Prefer bounded polling controlled by the caller. Continue polling only for `queued`, `preparing`, or `running`. Stop and relay action for `waiting_approval` or `waiting_input`. Stop and summarize `succeeded`, `failed`, `cancelled`, or `interrupted`. No new events does not mean the Run is complete. Use `run steer`, `run input`, `task pause`, `task cancel`, or `task resume` only when the requested action matches the Run's current state.
