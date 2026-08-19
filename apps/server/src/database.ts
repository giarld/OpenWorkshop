import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATABASE_NAME = "workshop.db";

function lifecycleGuardTriggers(): string {
  const directTables = ["requirement_versions", "requirement_messages", "attachments", "tasks", "execution_grants", "runs", "documents"];
  const relatedTables: Array<[string, string]> = [
    ["task_labels", "SELECT commission_id FROM tasks WHERE id = ROW.task_id"],
    ["comments", "SELECT commission_id FROM tasks WHERE id = ROW.task_id"],
    ["evidence", "SELECT commission_id FROM tasks WHERE id = ROW.task_id"],
    ["run_events", "SELECT commission_id FROM runs WHERE id = ROW.run_id"],
    ["approvals", "SELECT run.commission_id FROM runs AS run WHERE run.id = ROW.run_id"],
    ["document_versions", "SELECT commission_id FROM documents WHERE id = ROW.document_id"]
  ];
  const statements = [
    `CREATE TRIGGER commissions_lifecycle_update BEFORE UPDATE ON commissions
      WHEN OLD.lifecycle_operation IS NOT NULL AND NEW.lifecycle_operation = OLD.lifecycle_operation
      BEGIN SELECT RAISE(ABORT, 'Commission lifecycle operation in progress'); END;`,
    `CREATE TRIGGER commissions_lifecycle_delete BEFORE DELETE ON commissions
      WHEN OLD.lifecycle_operation IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'Commission lifecycle operation in progress'); END;`
  ];
  for (const table of directTables) {
    statements.push(...mutationGuardTriggers(table, (row) => `SELECT 1 FROM commissions WHERE id = ${row}.commission_id AND lifecycle_operation IS NOT NULL`));
  }
  for (const [table, query] of relatedTables) {
    statements.push(...mutationGuardTriggers(table, (row) => `SELECT 1 FROM commissions WHERE id = (${query.replaceAll("ROW", row)}) AND lifecycle_operation IS NOT NULL`));
  }
  statements.push(...mutationGuardTriggers("task_dependencies", (row) => `SELECT 1 FROM commissions WHERE lifecycle_operation IS NOT NULL AND id IN (
    SELECT commission_id FROM tasks WHERE id IN (${row}.task_id, ${row}.depends_on_task_id)
  )`));
  statements.push(...mutationGuardTriggers("notifications", (row) => `SELECT 1 FROM commissions WHERE lifecycle_operation IS NOT NULL AND id IN (
    SELECT ${row}.entity_id WHERE ${row}.entity_type = 'commission'
    UNION SELECT commission_id FROM tasks WHERE id = ${row}.entity_id AND ${row}.entity_type = 'task'
    UNION SELECT commission_id FROM runs WHERE id = ${row}.entity_id AND ${row}.entity_type = 'run'
    UNION SELECT run.commission_id FROM approvals AS approval JOIN runs AS run ON run.id = approval.run_id WHERE approval.id = ${row}.entity_id AND ${row}.entity_type = 'approval'
    UNION SELECT commission_id FROM documents WHERE id = ${row}.entity_id AND ${row}.entity_type = 'document'
    UNION SELECT commission_id FROM requirement_versions WHERE id = ${row}.entity_id AND ${row}.entity_type = 'requirement'
  )`));
  return statements.join("\n");
}

function mutationGuardTriggers(table: string, guardedCommission: (row: "OLD" | "NEW") => string): string[] {
  const message = "Commission lifecycle operation in progress";
  return [
    `CREATE TRIGGER ${table}_lifecycle_insert BEFORE INSERT ON ${table} WHEN EXISTS(${guardedCommission("NEW")}) BEGIN SELECT RAISE(ABORT, '${message}'); END;`,
    `CREATE TRIGGER ${table}_lifecycle_update BEFORE UPDATE ON ${table} WHEN EXISTS(${guardedCommission("OLD")}) OR EXISTS(${guardedCommission("NEW")}) BEGIN SELECT RAISE(ABORT, '${message}'); END;`,
    `CREATE TRIGGER ${table}_lifecycle_delete BEFORE DELETE ON ${table} WHEN EXISTS(${guardedCommission("OLD")}) BEGIN SELECT RAISE(ABORT, '${message}'); END;`
  ];
}

const MIGRATIONS = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE auth_state (
    id TEXT PRIMARY KEY,
    pin_hash TEXT NOT NULL,
    initialized_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE root_paths (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    real_path TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    real_path TEXT NOT NULL,
    root_path_id TEXT NOT NULL REFERENCES root_paths(id),
    vcs_type TEXT NOT NULL CHECK (vcs_type IN ('git', 'svn', 'none')),
    vcs_root TEXT,
    profile_json TEXT,
    profile_updated_at TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE commissions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'clarifying', 'awaiting_requirement_approval', 'planned', 'backlog', 'active', 'paused', 'blocked', 'awaiting_acceptance', 'done', 'archived')),
    active_requirement_version_id TEXT REFERENCES requirement_versions(id),
    main_task_id TEXT REFERENCES tasks(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  ) STRICT;
  CREATE UNIQUE INDEX commissions_one_active_per_project ON commissions(project_id) WHERE status = 'active';
  CREATE TABLE requirement_versions (
    id TEXT PRIMARY KEY,
    commission_id TEXT NOT NULL REFERENCES commissions(id),
    version_no INTEGER NOT NULL,
    content_markdown TEXT NOT NULL,
    acceptance_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'awaiting_approval', 'approved', 'superseded', 'rejected')),
    created_by TEXT NOT NULL CHECK (created_by IN ('human', 'requirement_agent')),
    created_at TEXT NOT NULL,
    approved_at TEXT,
    UNIQUE (commission_id, version_no)
  ) STRICT;
  CREATE UNIQUE INDEX requirement_versions_one_approved ON requirement_versions(commission_id) WHERE status = 'approved';
  CREATE TABLE requirement_messages (
    id TEXT PRIMARY KEY,
    commission_id TEXT NOT NULL REFERENCES commissions(id),
    role TEXT NOT NULL CHECK (role IN ('human', 'agent', 'system')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    commission_id TEXT NOT NULL REFERENCES commissions(id),
    original_name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 52428800),
    storage_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    extracted_text TEXT,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    commission_id TEXT NOT NULL REFERENCES commissions(id),
    parent_id TEXT REFERENCES tasks(id),
    number_path TEXT NOT NULL,
    position INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('backlog', 'todo', 'in_progress', 'done', 'blocked', 'archived')),
    priority TEXT NOT NULL CHECK (priority IN ('none', 'low', 'medium', 'high', 'urgent')),
    due_date TEXT,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('human', 'ai')),
    acceptance_json TEXT NOT NULL,
    review_round_limit INTEGER NOT NULL CHECK (review_round_limit >= 0),
    review_round_used INTEGER NOT NULL CHECK (review_round_used >= 0),
    blocked_reason TEXT,
    human_waiver_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  ) STRICT;
  CREATE TABLE task_dependencies (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
    created_by TEXT NOT NULL CHECK (created_by IN ('human', 'planner_agent')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, depends_on_task_id),
    CHECK (task_id <> depends_on_task_id)
  ) STRICT;
  CREATE TABLE labels (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    UNIQUE (project_id, name)
  ) STRICT;
  CREATE TABLE task_labels (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    label_id TEXT NOT NULL REFERENCES labels(id),
    PRIMARY KEY (task_id, label_id)
  ) STRICT;
  CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    author_type TEXT NOT NULL CHECK (author_type IN ('human', 'agent', 'system')),
    agent_role TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('normal', 'rejection', 'blocker', 'approval', 'waiver')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE role_configs (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    role TEXT NOT NULL CHECK (role IN ('supervisor', 'requirement', 'planner', 'developer', 'reviewer', 'archivist')),
    prompt TEXT NOT NULL,
    model TEXT,
    reasoning_effort TEXT,
    custom_args_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX role_configs_scope_role ON role_configs(COALESCE(project_id, ''), role);
  CREATE TABLE execution_grants (
    id TEXT PRIMARY KEY,
    commission_id TEXT NOT NULL REFERENCES commissions(id),
    root_task_id TEXT NOT NULL REFERENCES tasks(id),
    scope TEXT NOT NULL CHECK (scope IN ('commission_tree', 'target_closure')),
    status TEXT NOT NULL CHECK (status IN ('active', 'exhausted', 'revoked')),
    created_at TEXT NOT NULL,
    revoked_at TEXT
  ) STRICT;
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    commission_id TEXT NOT NULL REFERENCES commissions(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    role TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    trigger_ref_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'preparing', 'running', 'waiting_approval', 'waiting_input', 'succeeded', 'failed', 'cancelled', 'interrupted')),
    attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
    codex_version TEXT,
    config_snapshot_json TEXT NOT NULL,
    context_snapshot_json TEXT NOT NULL,
    pid INTEGER,
    started_at TEXT,
    finished_at TEXT,
    failure_code TEXT,
    failure_summary TEXT,
    token_input INTEGER,
    token_output INTEGER,
    token_cached INTEGER
  ) STRICT;
  CREATE TABLE run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id),
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    redacted INTEGER NOT NULL CHECK (redacted IN (0, 1)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    codex_request_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('command', 'file_change', 'permission', 'high_risk')),
    request_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
    decision_json TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  ) STRICT;
  CREATE TABLE evidence (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    run_id TEXT REFERENCES runs(id),
    criterion_key TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('test', 'review', 'diff', 'command', 'human_waiver')),
    status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'waived')),
    summary TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    commission_id TEXT REFERENCES commissions(id),
    type TEXT NOT NULL CHECK (type IN ('requirement', 'plan', 'decision', 'review', 'delivery')),
    title TEXT NOT NULL,
    current_version_id TEXT REFERENCES document_versions(id),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE document_versions (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id),
    version_no INTEGER NOT NULL,
    content_markdown TEXT NOT NULL,
    source_json TEXT NOT NULL,
    locked INTEGER NOT NULL CHECK (locked IN (0, 1)),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (document_id, version_no)
  ) STRICT;
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT
  ) STRICT;
  `,
  `
  CREATE TRIGGER attachments_total_size_limit
  BEFORE INSERT ON attachments
  WHEN COALESCE((SELECT SUM(size_bytes) FROM attachments WHERE commission_id = NEW.commission_id), 0) + NEW.size_bytes > 209715200
  BEGIN
    SELECT RAISE(ABORT, 'commission attachments exceed 200 MB');
  END;

  CREATE TRIGGER tasks_require_approved_requirement
  BEFORE INSERT ON tasks
  WHEN NOT EXISTS (
    SELECT 1
    FROM commissions AS commission
    JOIN requirement_versions AS requirement ON requirement.id = commission.active_requirement_version_id
    WHERE commission.id = NEW.commission_id AND requirement.status = 'approved'
  )
  BEGIN
    SELECT RAISE(ABORT, 'commission requirement is not approved');
  END;
  `,
  `
  DROP TRIGGER tasks_require_approved_requirement;

  UPDATE requirement_versions
  SET status = 'rejected'
  WHERE status = 'awaiting_approval'
    AND EXISTS (
      SELECT 1 FROM requirement_versions AS newer
      WHERE newer.commission_id = requirement_versions.commission_id
        AND newer.status = 'awaiting_approval'
        AND newer.version_no > requirement_versions.version_no
    );

  CREATE UNIQUE INDEX requirement_versions_one_pending ON requirement_versions(commission_id) WHERE status = 'awaiting_approval';

  CREATE TRIGGER tasks_require_approved_requirement
  BEFORE INSERT ON tasks
  WHEN NOT EXISTS (
    SELECT 1
    FROM commissions AS commission
    JOIN requirement_versions AS requirement ON requirement.id = commission.active_requirement_version_id
    WHERE commission.id = NEW.commission_id
      AND requirement.commission_id = NEW.commission_id
      AND requirement.status = 'approved'
      AND commission.status IN ('planned', 'backlog', 'active', 'paused', 'blocked', 'awaiting_acceptance')
  )
  BEGIN
    SELECT RAISE(ABORT, 'commission requirement is not approved');
  END;
  `,
  `
  UPDATE commissions
  SET status = 'awaiting_requirement_approval'
  WHERE status NOT IN ('done', 'archived')
    AND EXISTS (
      SELECT 1
      FROM requirement_versions AS requirement
      WHERE requirement.commission_id = commissions.id
        AND requirement.status = 'awaiting_approval'
    );
  `,
  `
  ALTER TABLE tasks ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1));
  `,
  `
  ALTER TABLE runs ADD COLUMN execution_grant_id TEXT REFERENCES execution_grants(id);
  ALTER TABLE runs ADD COLUMN retry_root_run_id TEXT REFERENCES runs(id);
  ALTER TABLE runs ADD COLUMN workspace_path TEXT;
  ALTER TABLE runs ADD COLUMN workspace_mode TEXT CHECK (workspace_mode IN ('read', 'worktree', 'exclusive'));

  UPDATE runs
  SET execution_grant_id = (
    SELECT grant.id FROM execution_grants AS grant
    WHERE grant.commission_id = runs.commission_id AND grant.status = 'active'
    ORDER BY grant.created_at DESC LIMIT 1
  )
  WHERE execution_grant_id IS NULL;

  UPDATE runs
  SET status = 'interrupted', finished_at = COALESCE(finished_at, datetime('now')), failure_code = COALESCE(failure_code, 'duplicate_reservation')
  WHERE id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY rowid DESC) AS reservation_order
      FROM runs WHERE status IN ('queued', 'preparing', 'running', 'waiting_approval', 'waiting_input')
    ) WHERE reservation_order > 1
  );

  CREATE UNIQUE INDEX runs_one_reserved_per_task
  ON runs(task_id)
  WHERE status IN ('queued', 'preparing', 'running', 'waiting_approval', 'waiting_input');
  `,
  `
  ALTER TABLE requirement_messages ADD COLUMN options_json TEXT
    CHECK (options_json IS NULL OR (json_valid(options_json) AND json_type(options_json) = 'array'));
  `,
  `
  UPDATE approvals
  SET status = 'expired', decided_at = COALESCE(decided_at, datetime('now'))
  WHERE status = 'pending'
    AND run_id IN (SELECT id FROM runs WHERE status IN ('succeeded', 'failed', 'cancelled', 'interrupted'));

  UPDATE notifications
  SET read_at = COALESCE(read_at, datetime('now'))
  WHERE entity_type = 'approval'
    AND entity_id IN (SELECT id FROM approvals WHERE status <> 'pending');

  CREATE TRIGGER approvals_resolve_notifications
  AFTER UPDATE OF status ON approvals
  WHEN OLD.status = 'pending' AND NEW.status <> 'pending'
  BEGIN
    UPDATE notifications
    SET read_at = COALESCE(read_at, datetime('now'))
    WHERE entity_type = 'approval' AND entity_id = NEW.id;
  END;

  CREATE TRIGGER runs_expire_pending_approvals
  AFTER UPDATE OF status ON runs
  WHEN OLD.status IN ('queued', 'preparing', 'running', 'waiting_approval', 'waiting_input')
    AND NEW.status IN ('succeeded', 'failed', 'cancelled', 'interrupted')
  BEGIN
    UPDATE approvals
    SET status = 'expired', decided_at = COALESCE(decided_at, datetime('now'))
    WHERE run_id = NEW.id AND status = 'pending';
  END;
  `,
  `
  ALTER TABLE comments ADD COLUMN parent_id TEXT REFERENCES comments(id);
  ALTER TABLE comments ADD COLUMN run_id TEXT REFERENCES runs(id);
  CREATE INDEX comments_task_parent_created ON comments(task_id, parent_id, created_at);
  CREATE INDEX comments_run_created ON comments(run_id, created_at);

  INSERT INTO comments (id, task_id, parent_id, run_id, author_type, agent_role, kind, content, created_at)
  SELECT lower(hex(randomblob(16))), task.id, NULL, NULL, 'agent', 'planner', 'normal',
    '## 架构师任务分析' || char(10) || char(10) || CASE WHEN task.description = '' THEN task.title ELSE task.description END || char(10) || char(10) ||
    '## 对执行者的约束要求' || char(10) || char(10) || '- 负责人：' || CASE task.owner_type WHEN 'ai' THEN 'AI' ELSE '人工' END || char(10) ||
    '- 优先级：' || task.priority || CASE WHEN task.read_only = 1 THEN char(10) || '- 只读任务：不得修改项目文件' ELSE '' END || char(10) ||
    '- 验收要求：' || task.acceptance_json,
    datetime('now')
  FROM tasks AS task
  WHERE task.archived_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM comments WHERE comments.task_id = task.id AND comments.agent_role = 'planner');
  `,
  `
  ALTER TABLE comments ADD COLUMN deleted_at TEXT;
  `,
  `
  UPDATE tasks
  SET review_round_used = (
    SELECT COUNT(*) FROM evidence
    WHERE evidence.task_id = tasks.id AND evidence.type = 'review' AND evidence.status = 'passed'
  );
  `,
  `
  ALTER TABLE tasks ADD COLUMN auto_approve_permissions INTEGER NOT NULL DEFAULT 0 CHECK (auto_approve_permissions IN (0, 1));
  `,
  `
  DROP TRIGGER approvals_resolve_notifications;
  DROP TRIGGER runs_expire_pending_approvals;

  ALTER TABLE approvals RENAME TO approvals_v12;
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    codex_request_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('command', 'file_change', 'permission', 'high_risk', 'mcp_tool_call')),
    request_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
    decision_json TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  ) STRICT;
  INSERT INTO approvals SELECT * FROM approvals_v12;
  DROP TABLE approvals_v12;

  CREATE TRIGGER approvals_resolve_notifications
  AFTER UPDATE OF status ON approvals
  WHEN OLD.status = 'pending' AND NEW.status <> 'pending'
  BEGIN
    UPDATE notifications
    SET read_at = COALESCE(read_at, datetime('now'))
    WHERE entity_type = 'approval' AND entity_id = NEW.id;
  END;

  CREATE TRIGGER runs_expire_pending_approvals
  AFTER UPDATE OF status ON runs
  WHEN OLD.status IN ('queued', 'preparing', 'running', 'waiting_approval', 'waiting_input')
    AND NEW.status IN ('succeeded', 'failed', 'cancelled', 'interrupted')
  BEGIN
    UPDATE approvals
    SET status = 'expired', decided_at = COALESCE(decided_at, datetime('now'))
    WHERE run_id = NEW.id AND status = 'pending';
  END;
  `,
  `
  ALTER TABLE commissions ADD COLUMN clarification_token_input INTEGER NOT NULL DEFAULT 0 CHECK (clarification_token_input >= 0);
  ALTER TABLE commissions ADD COLUMN clarification_token_output INTEGER NOT NULL DEFAULT 0 CHECK (clarification_token_output >= 0);
  ALTER TABLE commissions ADD COLUMN clarification_token_cached INTEGER NOT NULL DEFAULT 0 CHECK (clarification_token_cached >= 0);
  `,
  `
  ALTER TABLE commissions ADD COLUMN archive_path TEXT;
  ALTER TABLE commissions ADD COLUMN archive_sha256 TEXT;
  ALTER TABLE commissions ADD COLUMN archive_size_bytes INTEGER CHECK (archive_size_bytes IS NULL OR archive_size_bytes >= 0);
  `,
  `
  ALTER TABLE commissions ADD COLUMN lifecycle_operation TEXT CHECK (lifecycle_operation IN ('archiving', 'reactivating'));
  ALTER TABLE commissions ADD COLUMN lifecycle_token TEXT;
  ${lifecycleGuardTriggers()}
  `,
  `
  ALTER TABLE attachments ADD COLUMN task_id TEXT REFERENCES tasks(id);
  ALTER TABLE attachments ADD COLUMN comment_id TEXT REFERENCES comments(id);
  ALTER TABLE attachments ADD COLUMN run_id TEXT REFERENCES runs(id);
  CREATE INDEX attachments_task_created ON attachments(task_id, created_at);
  CREATE INDEX attachments_comment_created ON attachments(comment_id, created_at);
  CREATE INDEX attachments_run_created ON attachments(run_id, created_at);
  `,
  `
  ALTER TABLE notifications ADD COLUMN system_notified_at TEXT;
  UPDATE notifications SET system_notified_at = created_at;
  `,
  `
  ALTER TABLE commissions ADD COLUMN coordination_revision INTEGER NOT NULL DEFAULT 0 CHECK (coordination_revision >= 0);
  ALTER TABLE commissions ADD COLUMN coordination_pending INTEGER NOT NULL DEFAULT 0 CHECK (coordination_pending IN (0, 1));
  ALTER TABLE runs ADD COLUMN coordination_revision INTEGER CHECK (coordination_revision IS NULL OR coordination_revision >= 0);
  UPDATE runs SET coordination_revision = 0 WHERE trigger_type = 'coordinate';

  CREATE TRIGGER tasks_revision_coordination
  AFTER UPDATE OF status ON tasks
  WHEN OLD.status <> NEW.status
  BEGIN
    UPDATE commissions
    SET coordination_revision = coordination_revision + 1
    WHERE id = NEW.commission_id;
    UPDATE runs
    SET coordination_revision = (SELECT coordination_revision FROM commissions WHERE id = NEW.commission_id),
        context_snapshot_json = '{}'
    WHERE commission_id = NEW.commission_id AND trigger_type = 'coordinate' AND status = 'queued';
  END;
  `,
  `
  CREATE TABLE plan_revisions (
    id TEXT PRIMARY KEY,
    commission_id TEXT NOT NULL REFERENCES commissions(id),
    base_coordination_revision INTEGER NOT NULL CHECK (base_coordination_revision >= 0),
    status TEXT NOT NULL CHECK (status IN ('collecting', 'reviewing', 'awaiting_confirmation', 'applied', 'cancelled', 'stale')),
    proposal_json TEXT CHECK (proposal_json IS NULL OR json_valid(proposal_json)),
    review_run_id TEXT REFERENCES runs(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    applied_at TEXT
  ) STRICT;
  CREATE UNIQUE INDEX plan_revisions_one_active
  ON plan_revisions(commission_id)
  WHERE status IN ('collecting', 'reviewing', 'awaiting_confirmation');

  CREATE TABLE plan_revision_cards (
    comment_id TEXT PRIMARY KEY REFERENCES comments(id),
    plan_revision_id TEXT NOT NULL REFERENCES plan_revisions(id),
    interaction_type TEXT NOT NULL CHECK (interaction_type IN ('boolean', 'single_choice', 'multiple_choice', 'text')),
    purpose TEXT NOT NULL CHECK (purpose IN ('question', 'final_confirmation')),
    options_json TEXT NOT NULL CHECK (json_valid(options_json) AND json_type(options_json) = 'array'),
    status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'superseded')),
    answer_json TEXT CHECK (answer_json IS NULL OR json_valid(answer_json)),
    answered_at TEXT
  ) STRICT;
  CREATE UNIQUE INDEX plan_revision_cards_one_pending
  ON plan_revision_cards(plan_revision_id)
  WHERE status = 'pending';

  ALTER TABLE tasks ADD COLUMN deleted_at TEXT;
  ALTER TABLE tasks ADD COLUMN deleted_reason TEXT;
  ALTER TABLE tasks ADD COLUMN deleted_revision_id TEXT REFERENCES plan_revisions(id);

  ${mutationGuardTriggers("plan_revisions", (row) => `SELECT 1 FROM commissions WHERE id = ${row}.commission_id AND lifecycle_operation IS NOT NULL`).join("\n")}
  ${mutationGuardTriggers("plan_revision_cards", (row) => `SELECT 1 FROM commissions WHERE id = (SELECT commission_id FROM plan_revisions WHERE id = ${row}.plan_revision_id) AND lifecycle_operation IS NOT NULL`).join("\n")}
  `,
  `
  CREATE TRIGGER tasks_structure_revision_insert
  AFTER INSERT ON tasks
  WHEN NOT EXISTS (SELECT 1 FROM commissions WHERE id = NEW.commission_id AND lifecycle_operation IS NOT NULL)
  BEGIN
    UPDATE commissions SET coordination_revision = coordination_revision + 1 WHERE id = NEW.commission_id;
    UPDATE runs SET coordination_revision = (SELECT coordination_revision FROM commissions WHERE id = NEW.commission_id), context_snapshot_json = '{}'
      WHERE commission_id = NEW.commission_id AND trigger_type = 'coordinate' AND status = 'queued';
  END;

  CREATE TRIGGER tasks_structure_revision_update
  AFTER UPDATE OF parent_id, position, title, description, priority, due_date, owner_type, acceptance_json, read_only, archived_at, deleted_at ON tasks
  WHEN NOT EXISTS (SELECT 1 FROM commissions WHERE id = NEW.commission_id AND lifecycle_operation IS NOT NULL)
  BEGIN
    UPDATE commissions SET coordination_revision = coordination_revision + 1 WHERE id = NEW.commission_id;
    UPDATE runs SET coordination_revision = (SELECT coordination_revision FROM commissions WHERE id = NEW.commission_id), context_snapshot_json = '{}'
      WHERE commission_id = NEW.commission_id AND trigger_type = 'coordinate' AND status = 'queued';
  END;

  CREATE TRIGGER task_dependencies_revision_insert
  AFTER INSERT ON task_dependencies
  WHEN NOT EXISTS (SELECT 1 FROM commissions JOIN tasks ON tasks.commission_id = commissions.id WHERE tasks.id = NEW.task_id AND commissions.lifecycle_operation IS NOT NULL)
  BEGIN
    UPDATE commissions SET coordination_revision = coordination_revision + 1 WHERE id = (SELECT commission_id FROM tasks WHERE id = NEW.task_id);
    UPDATE runs SET coordination_revision = (SELECT coordination_revision FROM commissions WHERE id = runs.commission_id), context_snapshot_json = '{}'
      WHERE commission_id = (SELECT commission_id FROM tasks WHERE id = NEW.task_id) AND trigger_type = 'coordinate' AND status = 'queued';
  END;

  CREATE TRIGGER task_dependencies_revision_delete
  AFTER DELETE ON task_dependencies
  WHEN NOT EXISTS (SELECT 1 FROM commissions JOIN tasks ON tasks.commission_id = commissions.id WHERE tasks.id = OLD.task_id AND commissions.lifecycle_operation IS NOT NULL)
  BEGIN
    UPDATE commissions SET coordination_revision = coordination_revision + 1 WHERE id = (SELECT commission_id FROM tasks WHERE id = OLD.task_id);
    UPDATE runs SET coordination_revision = (SELECT coordination_revision FROM commissions WHERE id = runs.commission_id), context_snapshot_json = '{}'
      WHERE commission_id = (SELECT commission_id FROM tasks WHERE id = OLD.task_id) AND trigger_type = 'coordinate' AND status = 'queued';
  END;
  `,
  `
  ALTER TABLE tasks ADD COLUMN deleted_dependency_ids_json TEXT
  CHECK (
    deleted_dependency_ids_json IS NULL
    OR (json_valid(deleted_dependency_ids_json) AND json_type(deleted_dependency_ids_json) = 'array')
  );
  `,
  `
  WITH RECURSIVE numbered(id, number_path) AS (
    SELECT task.id, CAST(1 + (
      SELECT COUNT(*) FROM tasks AS prior
      JOIN commissions AS prior_commission ON prior_commission.id = prior.commission_id
      WHERE prior_commission.project_id = commission.project_id AND prior.parent_id IS NULL AND prior.archived_at IS NULL
        AND (prior.position < task.position OR (prior.position = task.position AND prior.created_at < task.created_at) OR (prior.position = task.position AND prior.created_at = task.created_at AND prior.rowid < task.rowid))
    ) AS TEXT)
    FROM tasks AS task JOIN commissions AS commission ON commission.id = task.commission_id
    WHERE task.parent_id IS NULL AND task.archived_at IS NULL
    UNION ALL
    SELECT child.id, numbered.number_path || '.' || (1 + (
      SELECT COUNT(*) FROM tasks AS prior
      WHERE prior.parent_id = child.parent_id AND prior.archived_at IS NULL
        AND (prior.position < child.position OR (prior.position = child.position AND prior.created_at < child.created_at) OR (prior.position = child.position AND prior.created_at = child.created_at AND prior.rowid < child.rowid))
    ))
    FROM tasks AS child JOIN numbered ON child.parent_id = numbered.id
    WHERE child.archived_at IS NULL
  )
  UPDATE tasks SET number_path = (SELECT numbered.number_path FROM numbered WHERE numbered.id = tasks.id)
  WHERE id IN (SELECT id FROM numbered);
  `,
  `
  CREATE TABLE project_task_sequences (
    project_id TEXT PRIMARY KEY REFERENCES projects(id),
    next_number INTEGER NOT NULL CHECK (next_number >= 1)
  ) STRICT;

  WITH RECURSIVE numbered(id, number_path) AS (
    SELECT task.id, CAST(1 + (
      SELECT COUNT(*) FROM tasks AS prior
      JOIN commissions AS prior_commission ON prior_commission.id = prior.commission_id
      WHERE prior_commission.project_id = commission.project_id AND prior.parent_id IS NULL
        AND (prior.created_at < task.created_at OR (prior.created_at = task.created_at AND prior.rowid < task.rowid))
    ) AS TEXT)
    FROM tasks AS task JOIN commissions AS commission ON commission.id = task.commission_id
    WHERE task.parent_id IS NULL
    UNION ALL
    SELECT child.id, numbered.number_path || '.' || (1 + (
      SELECT COUNT(*) FROM tasks AS prior
      WHERE prior.parent_id = child.parent_id
        AND (prior.position < child.position OR (prior.position = child.position AND prior.created_at < child.created_at) OR (prior.position = child.position AND prior.created_at = child.created_at AND prior.rowid < child.rowid))
    ))
    FROM tasks AS child JOIN numbered ON child.parent_id = numbered.id
  )
  UPDATE tasks SET number_path = (SELECT numbered.number_path FROM numbered WHERE numbered.id = tasks.id)
  WHERE id IN (SELECT id FROM numbered);

  INSERT INTO project_task_sequences (project_id, next_number)
  SELECT project.id, COALESCE(MAX(CAST(task.number_path AS INTEGER)), 0) + 1
  FROM projects AS project
  LEFT JOIN commissions AS commission ON commission.project_id = project.id
  LEFT JOIN tasks AS task ON task.commission_id = commission.id AND task.parent_id IS NULL
  GROUP BY project.id;
  `,
  `
  DROP TRIGGER tasks_structure_revision_insert;
  DROP TRIGGER tasks_structure_revision_update;
  DROP TRIGGER task_dependencies_revision_insert;
  DROP TRIGGER task_dependencies_revision_delete;

  CREATE TRIGGER tasks_structure_revision_insert
  AFTER INSERT ON tasks
  WHEN NOT EXISTS (SELECT 1 FROM commissions WHERE id = NEW.commission_id AND lifecycle_operation IS NOT NULL)
  BEGIN
    UPDATE commissions SET coordination_revision = coordination_revision + 1, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.commission_id;
    UPDATE tasks SET updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = (SELECT main_task_id FROM commissions WHERE id = NEW.commission_id) AND id <> NEW.id;
    UPDATE runs SET coordination_revision = (SELECT coordination_revision FROM commissions WHERE id = NEW.commission_id), context_snapshot_json = '{}'
      WHERE commission_id = NEW.commission_id AND trigger_type = 'coordinate' AND status = 'queued';
  END;

  CREATE TRIGGER tasks_structure_revision_update
  AFTER UPDATE OF parent_id, position, title, description, priority, due_date, owner_type, acceptance_json, read_only, archived_at, deleted_at ON tasks
  WHEN NOT EXISTS (SELECT 1 FROM commissions WHERE id = NEW.commission_id AND lifecycle_operation IS NOT NULL)
  BEGIN
    UPDATE commissions SET coordination_revision = coordination_revision + 1, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.commission_id;
    UPDATE tasks SET updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = (SELECT main_task_id FROM commissions WHERE id = NEW.commission_id) AND id <> NEW.id;
    UPDATE runs SET coordination_revision = (SELECT coordination_revision FROM commissions WHERE id = NEW.commission_id), context_snapshot_json = '{}'
      WHERE commission_id = NEW.commission_id AND trigger_type = 'coordinate' AND status = 'queued';
  END;

  CREATE TRIGGER task_dependencies_revision_insert
  AFTER INSERT ON task_dependencies
  WHEN NOT EXISTS (SELECT 1 FROM commissions JOIN tasks ON tasks.commission_id = commissions.id WHERE tasks.id = NEW.task_id AND commissions.lifecycle_operation IS NOT NULL)
  BEGIN
    UPDATE commissions SET coordination_revision = coordination_revision + 1, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = (SELECT commission_id FROM tasks WHERE id = NEW.task_id);
    UPDATE tasks SET updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = (SELECT commission.main_task_id FROM commissions AS commission JOIN tasks AS task ON task.commission_id = commission.id WHERE task.id = NEW.task_id);
    UPDATE runs SET coordination_revision = (SELECT coordination_revision FROM commissions WHERE id = runs.commission_id), context_snapshot_json = '{}'
      WHERE commission_id = (SELECT commission_id FROM tasks WHERE id = NEW.task_id) AND trigger_type = 'coordinate' AND status = 'queued';
  END;

  CREATE TRIGGER task_dependencies_revision_delete
  AFTER DELETE ON task_dependencies
  WHEN NOT EXISTS (SELECT 1 FROM commissions JOIN tasks ON tasks.commission_id = commissions.id WHERE tasks.id = OLD.task_id AND commissions.lifecycle_operation IS NOT NULL)
  BEGIN
    UPDATE commissions SET coordination_revision = coordination_revision + 1, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = (SELECT commission_id FROM tasks WHERE id = OLD.task_id);
    UPDATE tasks SET updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = (SELECT commission.main_task_id FROM commissions AS commission JOIN tasks AS task ON task.commission_id = commission.id WHERE task.id = OLD.task_id);
    UPDATE runs SET coordination_revision = (SELECT coordination_revision FROM commissions WHERE id = runs.commission_id), context_snapshot_json = '{}'
      WHERE commission_id = (SELECT commission_id FROM tasks WHERE id = OLD.task_id) AND trigger_type = 'coordinate' AND status = 'queued';
  END;
  `,
  `
  ALTER TABLE runs ADD COLUMN workspace_baseline_json TEXT
    CHECK (workspace_baseline_json IS NULL OR (json_valid(workspace_baseline_json) AND json_type(workspace_baseline_json) = 'object'));

  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    commission_id TEXT NOT NULL UNIQUE REFERENCES commissions(id),
    main_task_id TEXT NOT NULL REFERENCES tasks(id),
    method TEXT NOT NULL CHECK (method IN ('document', 'vcs_commit', 'github_pr')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'preparing', 'running', 'waiting_human', 'failed', 'cancelled', 'succeeded')),
    request_json TEXT NOT NULL CHECK (json_valid(request_json) AND json_type(request_json) = 'object'),
    preview_json TEXT NOT NULL CHECK (json_valid(preview_json) AND json_type(preview_json) = 'object'),
    progress_json TEXT NOT NULL CHECK (json_valid(progress_json) AND json_type(progress_json) = 'object'),
    result_json TEXT NOT NULL CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
    external_effect_started INTEGER NOT NULL CHECK (external_effect_started IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  ) STRICT;

  CREATE TABLE delivery_attempts (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES deliveries(id),
    attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
    status TEXT NOT NULL CHECK (status IN ('queued', 'preparing', 'running', 'waiting_human', 'failed', 'cancelled', 'succeeded')),
    request_json TEXT NOT NULL CHECK (json_valid(request_json) AND json_type(request_json) = 'object'),
    preview_json TEXT NOT NULL CHECK (json_valid(preview_json) AND json_type(preview_json) = 'object'),
    progress_json TEXT NOT NULL CHECK (json_valid(progress_json) AND json_type(progress_json) = 'object'),
    result_json TEXT NOT NULL CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
    failure_code TEXT,
    failure_summary TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (delivery_id, attempt_no)
  ) STRICT;
  CREATE UNIQUE INDEX deliveries_one_active_attempt ON delivery_attempts(delivery_id)
    WHERE status IN ('queued', 'preparing', 'running');
  CREATE INDEX delivery_attempts_delivery_created ON delivery_attempts(delivery_id, created_at);
  DROP TRIGGER evidence_lifecycle_delete;
  DELETE FROM evidence
    WHERE type = 'diff' AND run_id IS NOT NULL AND rowid NOT IN (
      SELECT MAX(rowid) FROM evidence WHERE type = 'diff' AND run_id IS NOT NULL GROUP BY run_id
    );
  ${mutationGuardTriggers("evidence", (row) => `SELECT 1 FROM commissions WHERE id = (SELECT commission_id FROM tasks WHERE id = ${row}.task_id) AND lifecycle_operation IS NOT NULL`)[2]}
  CREATE UNIQUE INDEX evidence_one_diff_per_run ON evidence(run_id) WHERE type = 'diff' AND run_id IS NOT NULL;
  ${mutationGuardTriggers("deliveries", (row) => `SELECT 1 FROM commissions WHERE id = ${row}.commission_id AND lifecycle_operation IS NOT NULL`).join("\n")}
  ${mutationGuardTriggers("delivery_attempts", (row) => `SELECT 1 FROM commissions WHERE id = (SELECT commission_id FROM deliveries WHERE id = ${row}.delivery_id) AND lifecycle_operation IS NOT NULL`).join("\n")}
  `,
  `
  DROP INDEX deliveries_one_active_attempt;
  DROP TRIGGER delivery_attempts_lifecycle_update;
  WITH ranked AS (
    SELECT id, status, ROW_NUMBER() OVER (
      PARTITION BY delivery_id
      ORDER BY CASE WHEN status = 'waiting_human' THEN 0 ELSE 1 END, attempt_no DESC
    ) AS active_rank
    FROM delivery_attempts
    WHERE status IN ('queued', 'preparing', 'running', 'waiting_human')
  )
  UPDATE delivery_attempts
  SET status = CASE WHEN status IN ('queued', 'preparing') THEN 'cancelled' ELSE 'failed' END,
      failure_code = COALESCE(failure_code, 'migration_active_attempt_conflict'),
      failure_summary = COALESCE(failure_summary, 'Conflicting active attempt stopped during schema migration'),
      finished_at = COALESCE(finished_at, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE id IN (SELECT id FROM ranked WHERE active_rank > 1);
  ${mutationGuardTriggers("delivery_attempts", (row) => `SELECT 1 FROM commissions WHERE id = (SELECT commission_id FROM deliveries WHERE id = ${row}.delivery_id) AND lifecycle_operation IS NOT NULL`)[1]}
  CREATE UNIQUE INDEX deliveries_one_active_attempt ON delivery_attempts(delivery_id)
    WHERE status IN ('queued', 'preparing', 'running', 'waiting_human');
  CREATE TRIGGER delivery_attempts_audit_snapshot_immutable
  BEFORE UPDATE OF id, delivery_id, attempt_no, request_json, preview_json, created_at ON delivery_attempts
  BEGIN SELECT RAISE(ABORT, 'Delivery attempt audit snapshot is immutable'); END;
  `,
  `
  DROP TRIGGER IF EXISTS notifications_lifecycle_insert;
  DROP TRIGGER IF EXISTS notifications_lifecycle_update;
  DROP TRIGGER IF EXISTS notifications_lifecycle_delete;
  ${mutationGuardTriggers("notifications", (row) => `SELECT 1 FROM commissions WHERE lifecycle_operation IS NOT NULL AND id IN (
    SELECT ${row}.entity_id WHERE ${row}.entity_type = 'commission'
    UNION SELECT commission_id FROM tasks WHERE id = ${row}.entity_id AND ${row}.entity_type = 'task'
    UNION SELECT commission_id FROM runs WHERE id = ${row}.entity_id AND ${row}.entity_type = 'run'
    UNION SELECT run.commission_id FROM approvals AS approval JOIN runs AS run ON run.id = approval.run_id WHERE approval.id = ${row}.entity_id AND ${row}.entity_type = 'approval'
    UNION SELECT commission_id FROM documents WHERE id = ${row}.entity_id AND ${row}.entity_type = 'document'
    UNION SELECT commission_id FROM requirement_versions WHERE id = ${row}.entity_id AND ${row}.entity_type = 'requirement'
    UNION SELECT commission_id FROM deliveries WHERE id = ${row}.entity_id AND ${row}.entity_type = 'delivery'
  )`).join("\n")}
  `
];

export async function openWorkshopDatabase(home: string): Promise<DatabaseSync> {
  const databasePath = join(home, DATABASE_NAME);
  const existing = await stat(databasePath).catch(() => undefined);
  const database = new DatabaseSync(databasePath);
  configure(database);

  try {
    const currentVersion = database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (currentVersion.user_version > MIGRATIONS.length) throw new Error(`Database schema ${currentVersion.user_version} is newer than supported schema ${MIGRATIONS.length}`);
    if (currentVersion.user_version < MIGRATIONS.length && existing?.size) {
      await backupOpenDatabase(database, automaticBackupPath(join(home, "backups"), "migration"));
    }
    for (let index = currentVersion.user_version; index < MIGRATIONS.length; index += 1) {
      database.exec(`BEGIN IMMEDIATE;\n${MIGRATIONS[index]}\nPRAGMA user_version = ${index + 1};\nCOMMIT;`);
    }
    return database;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    database.close();
    throw error;
  }
}

export async function backupDatabase(databasePath: string, destination?: string): Promise<string> {
  const target = resolve(destination ?? automaticBackupPath(join(dirname(databasePath), "backups"), "manual"));
  await assertMissing(target);
  await mkdir(dirname(target), { recursive: true });
  validateDatabase(databasePath);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    await backupOpenDatabase(database, target);
    return target;
  } finally {
    database.close();
  }
}

export async function restoreDatabase(databasePath: string, sourcePath: string, backupsDirectory: string, runtimeDirectory: string): Promise<string | undefined> {
  const target = resolve(databasePath);
  const source = resolve(sourcePath);
  if (source === target) throw new Error("Restore source must differ from the active database");

  await mkdir(runtimeDirectory, { recursive: true });
  const temporary = join(runtimeDirectory, `restore-${randomUUID()}.db`);
  const previous = join(runtimeDirectory, `previous-${randomUUID()}.db`);
  const targetExists = await exists(target);
  let safetyBackup: string | undefined;

  try {
    await backupDatabase(source, temporary);
    validateDatabase(temporary);
    if (targetExists) {
      safetyBackup = await backupDatabase(target, automaticBackupPath(backupsDirectory, "pre-restore"));
      checkpoint(target);
      await rename(target, previous);
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      if (targetExists) await rename(previous, target);
      throw error;
    }
    await Promise.all([rm(previous, { force: true }), rm(`${target}-wal`, { force: true }), rm(`${target}-shm`, { force: true })]);
    return safetyBackup;
  } finally {
    await rm(temporary, { force: true });
  }
}

export class SettingsStore {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  get<T>(key: string, fallback?: T): T | undefined {
    const row = this.database.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as T : fallback;
  }

  set(key: string, value: unknown): void {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("Setting value must be JSON serializable");
    this.database.prepare(`
      INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, encoded, new Date().toISOString());
  }

  delete(key: string): boolean {
    return this.database.prepare("DELETE FROM settings WHERE key = ?").run(key).changes > 0;
  }

  all(): Record<string, unknown> {
    return Object.fromEntries((this.database.prepare("SELECT key, value_json FROM settings ORDER BY key").all() as Array<{ key: string; value_json: string }>).map(({ key, value_json }) => [key, JSON.parse(value_json)]));
  }
}

function configure(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
}

async function backupOpenDatabase(database: DatabaseSync, target: string): Promise<void> {
  await assertMissing(target);
  await mkdir(dirname(target), { recursive: true });
  database.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
}

function automaticBackupPath(directory: string, reason: string): string {
  return join(directory, `${basename(DATABASE_NAME, ".db")}-${reason}-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}.db`);
}

function validateDatabase(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    assertHealthy(database, path);
  } finally {
    database.close();
  }
}

function assertHealthy(database: DatabaseSync, path: string): void {
  const result = database.prepare("PRAGMA quick_check").get() as { quick_check: string };
  if (result.quick_check !== "ok") throw new Error(`Invalid SQLite database ${path}: ${result.quick_check}`);
}

function checkpoint(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
}

async function assertMissing(path: string): Promise<void> {
  if (await exists(path)) throw new Error(`Refusing to overwrite existing backup: ${path}`);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}
