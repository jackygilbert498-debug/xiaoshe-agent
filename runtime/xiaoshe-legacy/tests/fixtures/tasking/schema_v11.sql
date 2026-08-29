-- Production TaskStore schema snapshot at v11.  This fixture intentionally
-- predates queue_items and proves the only supported upgrade is v11 -> v12.
CREATE TABLE acceptance_coverage (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), verification_id TEXT REFERENCES verification_runs(id),
    acceptance TEXT NOT NULL, status TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(task_id, verification_id, acceptance)
);
CREATE TABLE actions (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id),
    tool TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), run_id TEXT REFERENCES runs(id),
    status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE TABLE changesets (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id),
    workspace_version TEXT NOT NULL, diff_hash TEXT NOT NULL, manifest_json TEXT NOT NULL,
    created_at TEXT NOT NULL, stale_at TEXT, stale_workspace_version TEXT
);
CREATE TABLE completion_proofs (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), input_hash TEXT NOT NULL, workspace_version TEXT NOT NULL,
    decision_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT
);
CREATE TABLE effects (
    id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), run_id TEXT REFERENCES runs(id),
    action_id TEXT REFERENCES actions(id), payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE plan_revisions (
    task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
    body_json TEXT NOT NULL, checksum TEXT NOT NULL, status TEXT NOT NULL,
    proposed_by TEXT NOT NULL, created_at TEXT NOT NULL,
    reviewed_by TEXT, reviewed_at TEXT, feedback TEXT, supersedes_revision INTEGER,
    PRIMARY KEY(task_id, revision)
);
CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE recovery_executions (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), preview_id TEXT NOT NULL REFERENCES recovery_previews(id),
    before_checkpoint_id TEXT REFERENCES task_checkpoints(id), status TEXT NOT NULL, items_json TEXT NOT NULL,
    started_at TEXT NOT NULL, ended_at TEXT, resulting_workspace_version TEXT
);
CREATE TABLE recovery_previews (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), checkpoint_id TEXT NOT NULL REFERENCES task_checkpoints(id),
    workspace_id TEXT NOT NULL REFERENCES task_workspaces(id), workspace_version TEXT NOT NULL,
    checkpoint_hash TEXT NOT NULL, operations_json TEXT NOT NULL, preview_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE review_decisions (
    id TEXT PRIMARY KEY, changeset_id TEXT NOT NULL REFERENCES changesets(id), request_id TEXT NOT NULL UNIQUE,
    decision TEXT NOT NULL, feedback TEXT NOT NULL, diff_hash TEXT NOT NULL, workspace_version TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE run_controls (
    run_id TEXT PRIMARY KEY REFERENCES runs(id), stop_requested INTEGER NOT NULL DEFAULT 0,
    requested_by TEXT, requested_at TEXT
);
CREATE TABLE run_inputs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
    text TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, consumed_at TEXT
);
CREATE TABLE runs (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt INTEGER NOT NULL,
    status TEXT NOT NULL, workspace_id TEXT, plan_revision_id TEXT, policy_json TEXT NOT NULL,
    started_at TEXT NOT NULL, ended_at TEXT, error_code TEXT,
    supersedes_run_id TEXT REFERENCES runs(id), UNIQUE(task_id, attempt)
);
CREATE TABLE schema_meta (version INTEGER NOT NULL);
INSERT INTO schema_meta VALUES (11);
CREATE TABLE task_checkpoints (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT REFERENCES runs(id),
    workspace_id TEXT NOT NULL REFERENCES task_workspaces(id), kind TEXT NOT NULL,
    workspace_version TEXT NOT NULL, manifest_json TEXT NOT NULL, manifest_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE task_events (
    task_id TEXT NOT NULL REFERENCES tasks(id), seq INTEGER NOT NULL, type TEXT NOT NULL,
    payload_json TEXT NOT NULL, payload_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(task_id, seq)
);
CREATE TABLE task_questions (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id), plan_revision_id TEXT,
    prompt TEXT NOT NULL, choices_json TEXT NOT NULL, allow_free_text INTEGER NOT NULL, reason_code TEXT NOT NULL,
    status TEXT NOT NULL, answer_text TEXT, asked_by TEXT NOT NULL, asked_at TEXT NOT NULL, answered_by TEXT, answered_at TEXT
);
CREATE TABLE task_relations (
    id TEXT PRIMARY KEY, source_task_id TEXT NOT NULL REFERENCES tasks(id), target_task_id TEXT NOT NULL REFERENCES tasks(id),
    kind TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(source_task_id, target_task_id, kind)
);
CREATE TABLE task_workspaces (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), project_id TEXT NOT NULL REFERENCES projects(id),
    mode TEXT NOT NULL, root TEXT, status TEXT NOT NULL, baseline_json TEXT NOT NULL,
    workspace_version TEXT, lease_owner TEXT, lease_expires_at TEXT, lease_generation INTEGER NOT NULL DEFAULT 0,
    error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, goal TEXT NOT NULL,
    acceptance_json TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    archived_at TEXT, legacy_session_id TEXT UNIQUE, active_run_id TEXT, active_plan_revision INTEGER
);
CREATE TABLE verification_checks (
    id TEXT PRIMARY KEY, verification_id TEXT NOT NULL REFERENCES verification_runs(id), check_id TEXT NOT NULL,
    status TEXT NOT NULL, code TEXT NOT NULL, exit_code INTEGER, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(verification_id, check_id)
);
CREATE TABLE verification_profiles (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), checksum TEXT NOT NULL,
    profile_json TEXT NOT NULL, source_hashes_json TEXT NOT NULL, status TEXT NOT NULL,
    approved_by TEXT, approved_at TEXT, created_at TEXT NOT NULL, revoked_at TEXT, UNIQUE(project_id, checksum)
);
CREATE TABLE verification_runs (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), changeset_id TEXT NOT NULL REFERENCES changesets(id),
    profile_checksum TEXT NOT NULL, workspace_version TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT
);
CREATE UNIQUE INDEX task_questions_one_open_run ON task_questions(run_id) WHERE status='open';
CREATE INDEX task_workspaces_task ON task_workspaces(task_id, created_at);
CREATE UNIQUE INDEX task_checkpoints_dedupe ON task_checkpoints(workspace_id, kind, workspace_version) WHERE kind != 'manual';

INSERT INTO projects VALUES ('prj_v11_fixture', 'v11 fixture', 'C:/fixture', '2026-08-04T00:00:00Z');
INSERT INTO tasks VALUES ('tsk_v11_fixture', 'prj_v11_fixture', 'kept task', 'prove upgrade', '{"items":[]}', 'Draft', 4,
    '2026-08-04T00:00:00Z', '2026-08-04T00:00:00Z', NULL, NULL, NULL, NULL);
