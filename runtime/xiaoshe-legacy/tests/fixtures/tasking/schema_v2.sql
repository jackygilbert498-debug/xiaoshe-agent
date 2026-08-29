CREATE TABLE schema_meta (version INTEGER NOT NULL);
INSERT INTO schema_meta VALUES (3);
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
  acceptance_json TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
  legacy_session_id TEXT UNIQUE, active_run_id TEXT
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL,
  workspace_id TEXT, plan_revision_id TEXT, policy_json TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, error_code TEXT
);
