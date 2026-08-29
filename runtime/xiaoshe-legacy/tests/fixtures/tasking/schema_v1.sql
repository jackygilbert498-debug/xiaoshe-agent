-- 任务账本 v1：仅用于验证单向迁移与备份；生产代码不得倒退写入此结构。
CREATE TABLE schema_meta (version INTEGER NOT NULL);
INSERT INTO schema_meta VALUES (1);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  acceptance_json TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE task_events (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(task_id, seq)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  session_id TEXT,
  plan_revision_id TEXT,
  policy_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error_code TEXT
);

CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  tool TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE effects (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  run_id TEXT REFERENCES runs(id),
  action_id TEXT REFERENCES actions(id),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  run_id TEXT REFERENCES runs(id),
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
