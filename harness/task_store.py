"""SQLite Task 事实账本的最小 v1 存储层。"""
from __future__ import annotations

import sqlite3
import uuid
import json
import ntpath
import os
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from .task_events import canonical_payload, payload_hash
from .task_model import CreateTask, FinishRun, StartRun, UpdateTaskDefinition


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def normalize_project_root(root: Path, platform_name: str | None = None) -> str:
    """生成 Project 唯一键；Windows 采用不区分大小写的规范路径。"""
    if (platform_name or os.name) == "nt":
        # 用 ntpath 而非宿主 Path.resolve，保证在 macOS/Linux 的交叉测试里也能验证 Windows 语义。
        return ntpath.normcase(ntpath.abspath(str(root)))
    return str(Path(root).resolve())


class TaskStore:
    SCHEMA_VERSION = 16

    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=5, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _initialize(self) -> None:
        conn = self._connect()
        try:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
                    goal TEXT NOT NULL, acceptance_json TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
                    legacy_session_id TEXT UNIQUE, active_run_id TEXT, active_plan_revision INTEGER
                );
                CREATE TABLE IF NOT EXISTS task_events (
                    task_id TEXT NOT NULL REFERENCES tasks(id), seq INTEGER NOT NULL, type TEXT NOT NULL,
                    payload_json TEXT NOT NULL, payload_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
                    PRIMARY KEY(task_id, seq)
                );
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt INTEGER NOT NULL,
                    status TEXT NOT NULL, workspace_id TEXT, plan_revision_id TEXT, policy_json TEXT NOT NULL,
                    started_at TEXT NOT NULL, ended_at TEXT, error_code TEXT,
                    supersedes_run_id TEXT REFERENCES runs(id),
                    UNIQUE(task_id, attempt)
                );
                CREATE TABLE IF NOT EXISTS actions (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id),
                    tool TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT
                );
                CREATE TABLE IF NOT EXISTS effects (
                    id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), run_id TEXT REFERENCES runs(id),
                    action_id TEXT REFERENCES actions(id), payload_json TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS approvals (
                    id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), run_id TEXT REFERENCES runs(id),
                    status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
                );
                CREATE TABLE IF NOT EXISTS plan_revisions (
                    task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
                    body_json TEXT NOT NULL, checksum TEXT NOT NULL, status TEXT NOT NULL,
                    proposed_by TEXT NOT NULL, created_at TEXT NOT NULL,
                    reviewed_by TEXT, reviewed_at TEXT, feedback TEXT, supersedes_revision INTEGER,
                    PRIMARY KEY(task_id, revision)
                );
                CREATE TABLE IF NOT EXISTS task_questions (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
                    run_id TEXT NOT NULL REFERENCES runs(id), plan_revision_id TEXT,
                    prompt TEXT NOT NULL, choices_json TEXT NOT NULL, allow_free_text INTEGER NOT NULL,
                    reason_code TEXT NOT NULL, status TEXT NOT NULL, answer_text TEXT,
                    asked_by TEXT NOT NULL, asked_at TEXT NOT NULL, answered_by TEXT, answered_at TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS task_questions_one_open_run
                    ON task_questions(run_id) WHERE status='open';
                CREATE TABLE IF NOT EXISTS run_controls (
                    run_id TEXT PRIMARY KEY REFERENCES runs(id), stop_requested INTEGER NOT NULL DEFAULT 0,
                    requested_by TEXT, requested_at TEXT
                );
                CREATE TABLE IF NOT EXISTS run_inputs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
                    text TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, consumed_at TEXT
                );
                CREATE TABLE IF NOT EXISTS changesets (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id),
                    workspace_version TEXT NOT NULL, diff_hash TEXT NOT NULL, manifest_json TEXT NOT NULL,
                    created_at TEXT NOT NULL, stale_at TEXT, stale_workspace_version TEXT
                );
                CREATE TABLE IF NOT EXISTS review_decisions (
                    id TEXT PRIMARY KEY, changeset_id TEXT NOT NULL REFERENCES changesets(id), request_id TEXT NOT NULL UNIQUE,
                    decision TEXT NOT NULL, feedback TEXT NOT NULL, diff_hash TEXT NOT NULL, workspace_version TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS verification_profiles (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), checksum TEXT NOT NULL,
                    profile_json TEXT NOT NULL, source_hashes_json TEXT NOT NULL, status TEXT NOT NULL,
                    approved_by TEXT, approved_at TEXT, created_at TEXT NOT NULL, revoked_at TEXT,
                    UNIQUE(project_id, checksum)
                );
                CREATE TABLE IF NOT EXISTS verification_runs (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), changeset_id TEXT NOT NULL REFERENCES changesets(id),
                    profile_checksum TEXT NOT NULL, workspace_version TEXT NOT NULL, status TEXT NOT NULL,
                    started_at TEXT NOT NULL, ended_at TEXT
                );
                CREATE TABLE IF NOT EXISTS verification_checks (
                    id TEXT PRIMARY KEY, verification_id TEXT NOT NULL REFERENCES verification_runs(id), check_id TEXT NOT NULL,
                    status TEXT NOT NULL, code TEXT NOT NULL, exit_code INTEGER, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
                    UNIQUE(verification_id, check_id)
                );
                CREATE TABLE IF NOT EXISTS acceptance_coverage (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), verification_id TEXT REFERENCES verification_runs(id),
                    acceptance TEXT NOT NULL, status TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL,
                    UNIQUE(task_id, verification_id, acceptance)
                );
                CREATE TABLE IF NOT EXISTS completion_proofs (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), input_hash TEXT NOT NULL, workspace_version TEXT NOT NULL,
                    decision_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT
                );
                CREATE TABLE IF NOT EXISTS task_workspaces (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), project_id TEXT NOT NULL REFERENCES projects(id),
                    mode TEXT NOT NULL, root TEXT, status TEXT NOT NULL, baseline_json TEXT NOT NULL,
                    workspace_version TEXT, lease_owner TEXT, lease_expires_at TEXT, lease_generation INTEGER NOT NULL DEFAULT 0,
                    error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS task_workspaces_task ON task_workspaces(task_id, created_at);
                CREATE TABLE IF NOT EXISTS task_checkpoints (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT REFERENCES runs(id),
                    workspace_id TEXT NOT NULL REFERENCES task_workspaces(id), kind TEXT NOT NULL,
                    workspace_version TEXT NOT NULL, manifest_json TEXT NOT NULL, manifest_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS task_checkpoints_dedupe
                    ON task_checkpoints(workspace_id, kind, workspace_version) WHERE kind != 'manual';
                CREATE TABLE IF NOT EXISTS recovery_previews (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), checkpoint_id TEXT NOT NULL REFERENCES task_checkpoints(id),
                    workspace_id TEXT NOT NULL REFERENCES task_workspaces(id), workspace_version TEXT NOT NULL,
                    checkpoint_hash TEXT NOT NULL, operations_json TEXT NOT NULL, preview_hash TEXT NOT NULL,
                    expires_at TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS recovery_executions (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), preview_id TEXT NOT NULL REFERENCES recovery_previews(id),
                    before_checkpoint_id TEXT REFERENCES task_checkpoints(id), status TEXT NOT NULL, items_json TEXT NOT NULL,
                    started_at TEXT NOT NULL, ended_at TEXT, resulting_workspace_version TEXT
                );
                CREATE TABLE IF NOT EXISTS task_relations (
                    id TEXT PRIMARY KEY, source_task_id TEXT NOT NULL REFERENCES tasks(id), target_task_id TEXT NOT NULL REFERENCES tasks(id),
                    kind TEXT NOT NULL, created_at TEXT NOT NULL,
                    UNIQUE(source_task_id, target_task_id, kind)
                );
                CREATE TABLE IF NOT EXISTS queue_items (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
                    trigger_kind TEXT NOT NULL, trigger_key TEXT NOT NULL UNIQUE,
                    priority INTEGER NOT NULL, not_before TEXT NOT NULL, policy_id TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('pending','leased','paused','done','failed','cancelled')),
                    version INTEGER NOT NULL, lease_owner TEXT, lease_generation INTEGER NOT NULL DEFAULT 0,
                    lease_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS queue_items_ready_order
                    ON queue_items(priority DESC, not_before ASC, created_at ASC, id ASC)
                    WHERE status='pending';
                CREATE INDEX IF NOT EXISTS queue_items_expired_lease
                    ON queue_items(status, lease_expires_at) WHERE status='leased';
                CREATE TABLE IF NOT EXISTS run_budget_ledger (
                    run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL,
                    reserved INTEGER NOT NULL DEFAULT 0, committed INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL, PRIMARY KEY(run_id, kind)
                );
                CREATE TABLE IF NOT EXISTS memory_records (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
                    kind TEXT NOT NULL CHECK(kind IN ('fact','convention','decision','command','pitfall','preference')),
                    text TEXT, text_hash TEXT NOT NULL, source_ref TEXT NOT NULL,
                    source_trust TEXT NOT NULL CHECK(source_trust IN ('user_direct','deterministic_evidence','agent_observation','external_untrusted','legacy_unknown')),
                    confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
                    status TEXT NOT NULL CHECK(status IN ('candidate','approved','superseded','expired','forgotten','rejected')),
                    version INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    request_id TEXT, approved_by TEXT, approved_at TEXT, rejected_by TEXT, rejected_at TEXT,
                    supersedes_id TEXT REFERENCES memory_records(id), review_after TEXT,
                    forgotten_by TEXT, forgotten_at TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS memory_records_request_unique
                    ON memory_records(project_id, request_id) WHERE request_id IS NOT NULL;
                CREATE INDEX IF NOT EXISTS memory_records_project_status
                    ON memory_records(project_id, status, updated_at DESC, id);
                CREATE TABLE IF NOT EXISTS memory_events (
                    id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memory_records(id),
                    project_id TEXT NOT NULL REFERENCES projects(id), type TEXT NOT NULL,
                    actor TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS memory_events_memory ON memory_events(memory_id, created_at, id);
                CREATE TABLE IF NOT EXISTS memory_usage_receipts (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), run_id TEXT,
                    action_id TEXT, record_ids_json TEXT NOT NULL, query_hash TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS memory_usage_receipts_project ON memory_usage_receipts(project_id, created_at DESC);
            """)
            row = conn.execute("SELECT version FROM schema_meta LIMIT 1").fetchone()
            if row is None:
                conn.execute("INSERT INTO schema_meta(version) VALUES (?)", (self.SCHEMA_VERSION,))
            elif row["version"] > self.SCHEMA_VERSION:
                raise ValueError("TASK_SCHEMA_TOO_NEW")
            elif row["version"] < self.SCHEMA_VERSION:
                old = row["version"]
                self._backup_database(old)
                self._migrate(conn, old)
        finally:
            conn.close()

    def _backup_database(self, old_version: int) -> None:
        """迁移前建立一致性备份及 hash manifest；失败即中止升级。"""
        from .migrations import MigrationManager
        backup = MigrationManager(self.db_path).backup(old_version)
        if not MigrationManager(self.db_path).verify_backup(backup):
            raise OSError("TASK_SCHEMA_BACKUP_FAILED")

    def _migrate(self, conn: sqlite3.Connection, old_version: int) -> None:
        """只允许向前升级；每一步在当前初始化连接内完成。"""
        if old_version == 1:
            task_columns = {row[1] for row in conn.execute("PRAGMA table_info(tasks)")}
            if "legacy_session_id" not in task_columns:
                # SQLite 的 ADD COLUMN 不接受 UNIQUE；先加列，再建唯一索引，仍是同一升级事务。
                conn.execute("ALTER TABLE tasks ADD COLUMN legacy_session_id TEXT")
                conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS tasks_legacy_session_unique ON tasks(legacy_session_id)")
            run_columns = {row[1] for row in conn.execute("PRAGMA table_info(runs)")}
            if "session_id" in run_columns and "workspace_id" not in run_columns:
                conn.execute("ALTER TABLE runs RENAME COLUMN session_id TO workspace_id")
            old_version = 2
        if old_version == 2:
            task_columns = {row[1] for row in conn.execute("PRAGMA table_info(tasks)")}
            if "active_run_id" not in task_columns:
                conn.execute("ALTER TABLE tasks ADD COLUMN active_run_id TEXT")
            old_version = 3
        if old_version == 3:
            task_columns = {row[1] for row in conn.execute("PRAGMA table_info(tasks)")}
            if "active_plan_revision" not in task_columns:
                conn.execute("ALTER TABLE tasks ADD COLUMN active_plan_revision INTEGER")
            conn.execute("""CREATE TABLE IF NOT EXISTS plan_revisions (
                task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
                body_json TEXT NOT NULL, checksum TEXT NOT NULL, status TEXT NOT NULL,
                proposed_by TEXT NOT NULL, created_at TEXT NOT NULL,
                reviewed_by TEXT, reviewed_at TEXT, feedback TEXT, supersedes_revision INTEGER,
                PRIMARY KEY(task_id, revision)
            )""")
            old_version = 4
        if old_version == 4:
            conn.execute("""CREATE TABLE IF NOT EXISTS task_questions (
                id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
                run_id TEXT NOT NULL REFERENCES runs(id), plan_revision_id TEXT,
                prompt TEXT NOT NULL, choices_json TEXT NOT NULL, allow_free_text INTEGER NOT NULL,
                reason_code TEXT NOT NULL, status TEXT NOT NULL, answer_text TEXT,
                asked_by TEXT NOT NULL, asked_at TEXT NOT NULL, answered_by TEXT, answered_at TEXT
            )""")
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS task_questions_one_open_run ON task_questions(run_id) WHERE status='open'")
            old_version = 5
        if old_version == 5:
            conn.execute("""CREATE TABLE IF NOT EXISTS run_controls (
                run_id TEXT PRIMARY KEY REFERENCES runs(id), stop_requested INTEGER NOT NULL DEFAULT 0,
                requested_by TEXT, requested_at TEXT
            )""")
            conn.execute("""CREATE TABLE IF NOT EXISTS run_inputs (
                id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
                text TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, consumed_at TEXT
            )""")
            old_version = 6
        if old_version == 6:
            conn.execute("""CREATE TABLE IF NOT EXISTS changesets (
                id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id),
                workspace_version TEXT NOT NULL, diff_hash TEXT NOT NULL, manifest_json TEXT NOT NULL,
                created_at TEXT NOT NULL, stale_at TEXT, stale_workspace_version TEXT
            )""")
            conn.execute("""CREATE TABLE IF NOT EXISTS review_decisions (
                id TEXT PRIMARY KEY, changeset_id TEXT NOT NULL REFERENCES changesets(id), request_id TEXT NOT NULL UNIQUE,
                decision TEXT NOT NULL, feedback TEXT NOT NULL, diff_hash TEXT NOT NULL, workspace_version TEXT NOT NULL,
                created_at TEXT NOT NULL
            )""")
            old_version = 7
        if old_version == 7:
            run_columns = {row[1] for row in conn.execute("PRAGMA table_info(runs)")}
            if "supersedes_run_id" not in run_columns:
                conn.execute("ALTER TABLE runs ADD COLUMN supersedes_run_id TEXT REFERENCES runs(id)")
            old_version = 8
        if old_version == 8:
            conn.execute("""CREATE TABLE IF NOT EXISTS verification_profiles (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), checksum TEXT NOT NULL,
                profile_json TEXT NOT NULL, source_hashes_json TEXT NOT NULL, status TEXT NOT NULL,
                approved_by TEXT, approved_at TEXT, created_at TEXT NOT NULL, revoked_at TEXT,
                UNIQUE(project_id, checksum)
            )""")
            old_version = 9
        if old_version == 9:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS verification_runs (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), changeset_id TEXT NOT NULL REFERENCES changesets(id),
                    profile_checksum TEXT NOT NULL, workspace_version TEXT NOT NULL, status TEXT NOT NULL,
                    started_at TEXT NOT NULL, ended_at TEXT
                );
                CREATE TABLE IF NOT EXISTS verification_checks (
                    id TEXT PRIMARY KEY, verification_id TEXT NOT NULL REFERENCES verification_runs(id), check_id TEXT NOT NULL,
                    status TEXT NOT NULL, code TEXT NOT NULL, exit_code INTEGER, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
                    UNIQUE(verification_id, check_id)
                );
                CREATE TABLE IF NOT EXISTS acceptance_coverage (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), verification_id TEXT REFERENCES verification_runs(id),
                    acceptance TEXT NOT NULL, status TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL,
                    UNIQUE(task_id, verification_id, acceptance)
                );
                CREATE TABLE IF NOT EXISTS completion_proofs (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), input_hash TEXT NOT NULL, workspace_version TEXT NOT NULL,
                    decision_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT
                );
            """)
            old_version = 10
        if old_version == 10:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS task_workspaces (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), project_id TEXT NOT NULL REFERENCES projects(id),
                    mode TEXT NOT NULL, root TEXT, status TEXT NOT NULL, baseline_json TEXT NOT NULL,
                    workspace_version TEXT, lease_owner TEXT, lease_expires_at TEXT, lease_generation INTEGER NOT NULL DEFAULT 0,
                    error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS task_workspaces_task ON task_workspaces(task_id, created_at);
                CREATE TABLE IF NOT EXISTS task_checkpoints (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT REFERENCES runs(id),
                    workspace_id TEXT NOT NULL REFERENCES task_workspaces(id), kind TEXT NOT NULL,
                    workspace_version TEXT NOT NULL, manifest_json TEXT NOT NULL, manifest_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS task_checkpoints_dedupe
                    ON task_checkpoints(workspace_id, kind, workspace_version) WHERE kind != 'manual';
                CREATE TABLE IF NOT EXISTS recovery_previews (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), checkpoint_id TEXT NOT NULL REFERENCES task_checkpoints(id),
                    workspace_id TEXT NOT NULL REFERENCES task_workspaces(id), workspace_version TEXT NOT NULL,
                    checkpoint_hash TEXT NOT NULL, operations_json TEXT NOT NULL, preview_hash TEXT NOT NULL,
                    expires_at TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS recovery_executions (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), preview_id TEXT NOT NULL REFERENCES recovery_previews(id),
                    before_checkpoint_id TEXT REFERENCES task_checkpoints(id), status TEXT NOT NULL, items_json TEXT NOT NULL,
                    started_at TEXT NOT NULL, ended_at TEXT, resulting_workspace_version TEXT
                );
                CREATE TABLE IF NOT EXISTS task_relations (
                    id TEXT PRIMARY KEY, source_task_id TEXT NOT NULL REFERENCES tasks(id), target_task_id TEXT NOT NULL REFERENCES tasks(id),
                    kind TEXT NOT NULL, created_at TEXT NOT NULL,
                    UNIQUE(source_task_id, target_task_id, kind)
                );
            """)
            old_version = 11
        if old_version == 11:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS queue_items (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
                    trigger_kind TEXT NOT NULL, trigger_key TEXT NOT NULL UNIQUE,
                    priority INTEGER NOT NULL, not_before TEXT NOT NULL, policy_id TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('pending','leased','paused','done','failed','cancelled')),
                    version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS queue_items_ready_order
                    ON queue_items(priority DESC, not_before ASC, created_at ASC, id ASC)
                    WHERE status='pending';
            """)
            old_version = 12
        if old_version == 12:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(queue_items)")}
            if "lease_owner" not in columns:
                conn.execute("ALTER TABLE queue_items ADD COLUMN lease_owner TEXT")
            if "lease_generation" not in columns:
                conn.execute("ALTER TABLE queue_items ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0")
            if "lease_expires_at" not in columns:
                conn.execute("ALTER TABLE queue_items ADD COLUMN lease_expires_at TEXT")
            conn.execute("CREATE INDEX IF NOT EXISTS queue_items_expired_lease ON queue_items(status, lease_expires_at) WHERE status='leased'")
            old_version = 13
        if old_version == 13:
            conn.execute("""CREATE TABLE IF NOT EXISTS run_budget_ledger (
                run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL,
                reserved INTEGER NOT NULL DEFAULT 0, committed INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL, PRIMARY KEY(run_id, kind)
            )""")
            old_version = 14
        if old_version == 14:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS memory_records (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
                    kind TEXT NOT NULL CHECK(kind IN ('fact','convention','decision','command','pitfall','preference')),
                    text TEXT, text_hash TEXT NOT NULL, source_ref TEXT NOT NULL,
                    source_trust TEXT NOT NULL CHECK(source_trust IN ('user_direct','deterministic_evidence','agent_observation','external_untrusted','legacy_unknown')),
                    confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
                    status TEXT NOT NULL CHECK(status IN ('candidate','approved','superseded','expired','forgotten','rejected')),
                    version INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    request_id TEXT, approved_by TEXT, approved_at TEXT, rejected_by TEXT, rejected_at TEXT,
                    supersedes_id TEXT REFERENCES memory_records(id), review_after TEXT,
                    forgotten_by TEXT, forgotten_at TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS memory_records_request_unique
                    ON memory_records(project_id, request_id) WHERE request_id IS NOT NULL;
                CREATE INDEX IF NOT EXISTS memory_records_project_status
                    ON memory_records(project_id, status, updated_at DESC, id);
                CREATE TABLE IF NOT EXISTS memory_events (
                    id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memory_records(id),
                    project_id TEXT NOT NULL REFERENCES projects(id), type TEXT NOT NULL,
                    actor TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS memory_events_memory ON memory_events(memory_id, created_at, id);
            """)
            old_version = 15
        if old_version == 15:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS memory_usage_receipts (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), run_id TEXT,
                    action_id TEXT, record_ids_json TEXT NOT NULL, query_hash TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS memory_usage_receipts_project ON memory_usage_receipts(project_id, created_at DESC);
            """)
            old_version = 16
        if old_version == self.SCHEMA_VERSION:
            conn.execute("UPDATE schema_meta SET version=?", (self.SCHEMA_VERSION,))
            return
        raise ValueError("TASK_SCHEMA_MIGRATION_UNSUPPORTED")

    @contextmanager
    def transaction(self):
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def queue_by_trigger(self, conn: sqlite3.Connection, trigger_key: str) -> sqlite3.Row | None:
        return conn.execute("SELECT * FROM queue_items WHERE trigger_key=?", (trigger_key,)).fetchone()

    def queue_item(self, conn: sqlite3.Connection, item_id: str) -> sqlite3.Row | None:
        return conn.execute("SELECT * FROM queue_items WHERE id=?", (item_id,)).fetchone()

    def insert_queue_item(self, conn: sqlite3.Connection, record: dict) -> sqlite3.Row:
        conn.execute("""INSERT INTO queue_items(
            id,task_id,trigger_kind,trigger_key,priority,not_before,policy_id,status,version,
            lease_owner,lease_generation,lease_expires_at,created_at,updated_at
        ) VALUES (
            :id,:task_id,:trigger_kind,:trigger_key,:priority,:not_before,:policy_id,:status,:version,
            :lease_owner,:lease_generation,:lease_expires_at,:created_at,:updated_at
        )""", record)
        row = self.queue_item(conn, record["id"])
        assert row is not None
        return row

    def ready_queue_items(self, now: str, limit: int) -> list[sqlite3.Row]:
        conn = self._connect()
        try:
            return list(conn.execute("""
                SELECT * FROM queue_items WHERE status='pending' AND not_before<=?
                ORDER BY priority DESC, not_before ASC, created_at ASC, id ASC LIMIT ?
            """, (now, limit)))
        finally:
            conn.close()

    def list_queue_items(self, task_id: str | None = None) -> list[dict]:
        conn = self._connect()
        try:
            query = "SELECT * FROM queue_items" + (" WHERE task_id=?" if task_id else "")
            query += " ORDER BY updated_at DESC, id DESC"
            return [dict(row) for row in conn.execute(query, (task_id,) if task_id else ())]
        finally:
            conn.close()

    @staticmethod
    def _row(row: sqlite3.Row | None) -> dict:
        if row is None:
            raise KeyError("tasking record not found")
        return dict(row)

    def create_project(self, name: str, root: Path) -> dict:
        real_root = normalize_project_root(root)
        with self.transaction() as conn:
            found = conn.execute("SELECT * FROM projects WHERE root=?", (real_root,)).fetchone()
            if found:
                return self._row(found)
            record = {"id": f"prj_{uuid.uuid4().hex}", "name": name.strip(), "root": real_root, "created_at": _now()}
            conn.execute("INSERT INTO projects(id,name,root,created_at) VALUES (:id,:name,:root,:created_at)", record)
            return record

    def list_projects(self) -> list[dict]:
        conn = self._connect()
        try:
            return [dict(row) for row in conn.execute("SELECT * FROM projects ORDER BY created_at, id")]
        finally:
            conn.close()

    def get_project(self, project_id: str) -> dict:
        conn = self._connect()
        try:
            return self._row(conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone())
        finally:
            conn.close()

    # Project Memory 的领域校验位于 project_memory.py；这里仅提供事务化 CRUD，
    # 使所有读写仍以 TaskStore 的 SQLite 账本为唯一事实源。
    def memory_record(self, memory_id: str, project_id: str | None = None) -> dict:
        conn = self._connect()
        try:
            query = "SELECT * FROM memory_records WHERE id=?" + (" AND project_id=?" if project_id else "")
            values = (memory_id, project_id) if project_id else (memory_id,)
            return self._row(conn.execute(query, values).fetchone())
        finally:
            conn.close()

    def list_memory_records(self, project_id: str, status: str | None = None) -> list[dict]:
        conn = self._connect()
        try:
            query = "SELECT * FROM memory_records WHERE project_id=?" + (" AND status=?" if status else "")
            query += " ORDER BY updated_at DESC, id DESC"
            values = (project_id, status) if status else (project_id,)
            return [dict(row) for row in conn.execute(query, values)]
        finally:
            conn.close()

    def memory_events(self, memory_id: str) -> list[dict]:
        conn = self._connect()
        try:
            return [dict(row) for row in conn.execute(
                "SELECT * FROM memory_events WHERE memory_id=? ORDER BY created_at, id", (memory_id,)
            )]
        finally:
            conn.close()

    def list_memory_usage_receipts(self, project_id: str, run_id: str | None = None, limit: int = 50) -> list[dict]:
        """列出实际注入回执；不联表正文，避免 forgotten 记忆被显示路径复活。"""
        conn = self._connect()
        try:
            query = "SELECT * FROM memory_usage_receipts WHERE project_id=?"
            values: list[object] = [project_id]
            if run_id is not None:
                query += " AND run_id=?"
                values.append(run_id)
            query += " ORDER BY created_at DESC, id DESC LIMIT ?"
            values.append(limit)
            return [dict(row) for row in conn.execute(query, values)]
        finally:
            conn.close()

    def _append(self, conn: sqlite3.Connection, task_id: str, type_: str, payload: dict) -> dict:
        seq = conn.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM task_events WHERE task_id=?", (task_id,)).fetchone()[0]
        event = {"task_id": task_id, "seq": seq, "type": type_, "payload_json": canonical_payload(payload), "payload_sha256": payload_hash(payload), "created_at": _now()}
        conn.execute("INSERT INTO task_events VALUES (:task_id,:seq,:type,:payload_json,:payload_sha256,:created_at)", event)
        return event

    def create_task(self, command: CreateTask) -> dict:
        return self.create_task_with_result(command)[0]

    def create_task_with_result(self, command: CreateTask) -> tuple[dict, bool]:
        """创建任务并原子返回是否真正插入；幂等导入据此避免重复广播事件。"""
        with self.transaction() as conn:
            if not conn.execute("SELECT 1 FROM projects WHERE id=?", (command.project_id,)).fetchone():
                raise KeyError("project not found")
            if command.legacy_session_id is not None:
                existing = conn.execute("SELECT * FROM tasks WHERE legacy_session_id=?", (command.legacy_session_id,)).fetchone()
                if existing is not None:
                    return self._row(existing), False
            now = _now()
            task = {"id": f"tsk_{uuid.uuid4().hex}", "project_id": command.project_id, "title": command.title, "goal": command.goal, "acceptance_json": canonical_payload({"items": command.acceptance}), "status": "Draft", "version": 0, "created_at": now, "updated_at": now, "archived_at": None, "legacy_session_id": command.legacy_session_id, "active_run_id": None, "active_plan_revision": None}
            try:
                conn.execute("""INSERT INTO tasks(id,project_id,title,goal,acceptance_json,status,version,created_at,updated_at,archived_at,legacy_session_id,active_run_id,active_plan_revision)
                                VALUES (:id,:project_id,:title,:goal,:acceptance_json,:status,:version,:created_at,:updated_at,:archived_at,:legacy_session_id,:active_run_id,:active_plan_revision)""", task)
            except sqlite3.IntegrityError:
                if command.legacy_session_id is None:
                    raise
                existing = conn.execute("SELECT * FROM tasks WHERE legacy_session_id=?", (command.legacy_session_id,)).fetchone()
                if existing is None:
                    raise
                return self._row(existing), False
            self._append(conn, task["id"], "task.created", {"status": "Draft", "goal": command.goal})
            return task, True

    def archive_task(self, task_id: str, expected_version: int) -> dict:
        with self.transaction() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            task = self._row(row)
            if task["version"] != expected_version:
                raise ValueError("TASK_VERSION_CONFLICT")
            now = _now()
            conn.execute("UPDATE tasks SET status='Archived', version=version+1, updated_at=?, archived_at=? WHERE id=?", (now, now, task_id))
            self._append(conn, task_id, "task.archived", {"from": task["status"], "to": "Archived"})
            return self._row(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())

    def get_task(self, task_id: str) -> dict:
        conn = self._connect()
        try:
            return self._row(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())
        finally:
            conn.close()

    def list_tasks(self, filters: dict | None = None) -> list[dict]:
        filters = filters or {}
        clauses, values = [], []
        for key in ("project_id", "status", "legacy_session_id"):
            if filters.get(key) is not None:
                clauses.append(f"{key}=?")
                values.append(filters[key])
        query = "SELECT * FROM tasks" + (" WHERE " + " AND ".join(clauses) if clauses else "")
        query += " ORDER BY updated_at DESC, id"
        conn = self._connect()
        try:
            return [dict(row) for row in conn.execute(query, values)]
        finally:
            conn.close()

    def find_task_by_legacy_session(self, legacy_session_id: str) -> dict | None:
        conn = self._connect()
        try:
            row = conn.execute("SELECT * FROM tasks WHERE legacy_session_id=?", (legacy_session_id,)).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()

    def update_task_definition(self, command: UpdateTaskDefinition) -> dict:
        with self.transaction() as conn:
            task = self._row(conn.execute("SELECT * FROM tasks WHERE id=?", (command.task_id,)).fetchone())
            if task["version"] != command.expected_version:
                raise ValueError("TASK_VERSION_CONFLICT")
            values = {key: value for key, value in {
                "title": command.title, "goal": command.goal,
                "acceptance_json": (canonical_payload({"items": command.acceptance}) if command.acceptance is not None else None),
            }.items() if value is not None}
            if not values:
                return task
            now = _now()
            assignments = ", ".join(f"{key}=?" for key in values)
            changed = conn.execute(
                f"UPDATE tasks SET {assignments}, version=version+1, updated_at=? WHERE id=? AND version=?",
                (*values.values(), now, command.task_id, command.expected_version),
            )
            if changed.rowcount != 1:
                raise ValueError("TASK_VERSION_CONFLICT")
            self._append(conn, command.task_id, "task.definition_updated", {
                "request_id": command.request_id, "fields": sorted(values),
            })
            return self._row(conn.execute("SELECT * FROM tasks WHERE id=?", (command.task_id,)).fetchone())

    def transition_task(self, task_id: str, expected_version: int, status: str, actor: str) -> dict:
        """比较 version、更新物化状态和追加事件必须位于同一事务。"""
        with self.transaction() as conn:
            current = self._row(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())
            if current["version"] != expected_version:
                raise ValueError("TASK_VERSION_CONFLICT")
            now = _now()
            changed = conn.execute(
                "UPDATE tasks SET status=?, version=version+1, updated_at=? WHERE id=? AND version=?",
                (status, now, task_id, expected_version),
            )
            if changed.rowcount != 1:
                raise ValueError("TASK_VERSION_CONFLICT")
            self._append(conn, task_id, "task.transitioned", {"from": current["status"], "to": status, "actor": actor})
            return self._row(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())

    def start_run(self, command: StartRun) -> tuple[dict, dict]:
        """在同一事务中启动 run 并将任务切换至 Running。"""
        with self.transaction() as conn:
            task = self._row(conn.execute("SELECT * FROM tasks WHERE id=?", (command.task_id,)).fetchone())
            if task["version"] != command.expected_version:
                raise ValueError("TASK_VERSION_CONFLICT")
            if task["status"] != "Ready":
                raise ValueError("TASK_RUN_NOT_READY")
            attempt = conn.execute(
                "SELECT COALESCE(MAX(attempt), 0) + 1 FROM runs WHERE task_id=?", (command.task_id,)
            ).fetchone()[0]
            now = _now()
            run = {
                "id": f"run_{uuid.uuid4().hex}", "task_id": command.task_id, "attempt": attempt,
                "status": "Running", "workspace_id": command.workspace_id,
                "plan_revision_id": command.plan_revision_id,
                "policy_json": canonical_payload(dict(command.policy_snapshot)),
                "started_at": now, "ended_at": None, "error_code": None, "supersedes_run_id": None,
            }
            conn.execute("""INSERT INTO runs VALUES
                (:id,:task_id,:attempt,:status,:workspace_id,:plan_revision_id,:policy_json,:started_at,:ended_at,:error_code,:supersedes_run_id)""", run)
            changed = conn.execute(
                "UPDATE tasks SET status='Running', active_run_id=?, version=version+1, updated_at=? WHERE id=? AND version=?",
                (run["id"], now, command.task_id, command.expected_version),
            )
            if changed.rowcount != 1:
                raise ValueError("TASK_VERSION_CONFLICT")
            self._append(conn, command.task_id, "task.transitioned", {"from": "Ready", "to": "Running", "actor": command.actor, "run_id": run["id"]})
            self._append(conn, command.task_id, "run.started", {"run_id": run["id"], "attempt": attempt, "actor": command.actor})
            return self._row(conn.execute("SELECT * FROM tasks WHERE id=?", (command.task_id,)).fetchone()), run

    def get_run(self, run_id: str) -> dict:
        conn = self._connect()
        try:
            return self._row(conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone())
        finally:
            conn.close()

    def finish_run(self, command: FinishRun, changeset: tuple[str, str, dict] | None = None) -> tuple[dict, dict]:
        """结束运行并同步任务物化状态；不允许重复收尾或跨任务写入。"""
        task_targets = {"Completed": "Review", "Stopped": "Review", "Failed": "Failed", "Cancelled": "Cancelled"}
        with self.transaction() as conn:
            run = self._row(conn.execute("SELECT * FROM runs WHERE id=?", (command.run_id,)).fetchone())
            task = self._row(conn.execute("SELECT * FROM tasks WHERE id=?", (run["task_id"],)).fetchone())
            if task["version"] != command.expected_task_version:
                raise ValueError("TASK_VERSION_CONFLICT")
            if run["status"] != "Running" or task["status"] != "Running":
                raise ValueError("TASK_RUN_NOT_ACTIVE")
            now = _now()
            target = task_targets[command.outcome.value]
            conn.execute("UPDATE runs SET status=?, ended_at=?, error_code=? WHERE id=?", (
                command.outcome.value, now, command.error_code, command.run_id,
            ))
            changed = conn.execute(
                "UPDATE tasks SET status=?, active_run_id=NULL, version=version+1, updated_at=? WHERE id=? AND version=?",
                (target, now, task["id"], command.expected_task_version),
            )
            if changed.rowcount != 1:
                raise ValueError("TASK_VERSION_CONFLICT")
            self._append(conn, task["id"], "run.finished", {
                "run_id": command.run_id, "outcome": command.outcome.value,
                "actor": command.actor, "error_code": command.error_code,
            })
            self._append(conn, task["id"], "task.transitioned", {
                "from": "Running", "to": target, "actor": command.actor, "run_id": command.run_id,
            })
            if changeset is not None:
                workspace_version, diff_hash, manifest = changeset
                record = {"id": f"csg_{uuid.uuid4().hex}", "task_id": task["id"], "run_id": command.run_id,
                          "workspace_version": workspace_version, "diff_hash": diff_hash,
                          "manifest_json": canonical_payload(manifest), "created_at": _now(),
                          "stale_at": None, "stale_workspace_version": None}
                conn.execute("INSERT INTO changesets VALUES (:id,:task_id,:run_id,:workspace_version,:diff_hash,:manifest_json,:created_at,:stale_at,:stale_workspace_version)", record)
                self._append(conn, task["id"], "changeset.captured", {
                    "changeset_id": record["id"], "run_id": command.run_id,
                    "diff_hash": diff_hash, "workspace_version": workspace_version,
                })
            return self._row(conn.execute("SELECT * FROM tasks WHERE id=?", (task["id"],)).fetchone()), self._row(conn.execute("SELECT * FROM runs WHERE id=?", (command.run_id,)).fetchone())

    @staticmethod
    def acceptance_items(task: dict) -> tuple[str, ...]:
        return tuple(json.loads(task["acceptance_json"]).get("items", []))

    def list_events(self, task_id: str) -> list[dict]:
        conn = self._connect()
        try:
            return [dict(row) for row in conn.execute("SELECT * FROM task_events WHERE task_id=? ORDER BY seq", (task_id,))]
        finally:
            conn.close()

    def list_events_after(self, task_id: str, after: int = 0) -> list[dict]:
        if not isinstance(after, int) or after < 0:
            raise ValueError("events_after 必须是非负整数")
        conn = self._connect()
        try:
            return [dict(row) for row in conn.execute(
                "SELECT * FROM task_events WHERE task_id=? AND seq>? ORDER BY seq", (task_id, after)
            )]
        finally:
            conn.close()

    def last_event_seq(self, task_id: str) -> int:
        conn = self._connect()
        try:
            row = conn.execute("SELECT COALESCE(MAX(seq), 0) FROM task_events WHERE task_id=?", (task_id,)).fetchone()
            return int(row[0])
        finally:
            conn.close()

    def insert_changeset(self, task_id: str, run_id: str, workspace_version: str, diff_hash: str, manifest: dict) -> dict:
        """只保存可审计 manifest 与哈希；patch 始终留在 ArtifactStore。"""
        with self.transaction() as conn:
            self._row(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())
            run = self._row(conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone())
            if run["task_id"] != task_id: raise ValueError("CHANGESET_RUN_MISMATCH")
            record={"id":f"csg_{uuid.uuid4().hex}","task_id":task_id,"run_id":run_id,"workspace_version":workspace_version,"diff_hash":diff_hash,"manifest_json":canonical_payload(manifest),"created_at":_now(),"stale_at":None,"stale_workspace_version":None}
            conn.execute("INSERT INTO changesets VALUES (:id,:task_id,:run_id,:workspace_version,:diff_hash,:manifest_json,:created_at,:stale_at,:stale_workspace_version)",record)
            self._append(conn,task_id,"changeset.captured",{"changeset_id":record["id"],"run_id":run_id,"diff_hash":diff_hash,"workspace_version":workspace_version})
            return {**record,"manifest":manifest}

    def get_changeset(self, changeset_id: str) -> dict:
        conn=self._connect()
        try:
            row=self._row(conn.execute("SELECT * FROM changesets WHERE id=?",(changeset_id,)).fetchone())
            return {**row,"manifest":json.loads(row["manifest_json"])}
        finally: conn.close()

    def current_changeset(self, task_id: str) -> dict | None:
        conn=self._connect()
        try:
            row=conn.execute("SELECT * FROM changesets WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT 1",(task_id,)).fetchone()
            return ({**dict(row),"manifest":json.loads(row["manifest_json"])} if row else None)
        finally: conn.close()

    def find_changeset(self, run_id: str, workspace_version: str, diff_hash: str) -> dict | None:
        conn=self._connect()
        try:
            row=conn.execute("""SELECT * FROM changesets WHERE run_id=? AND workspace_version=? AND diff_hash=?
                ORDER BY created_at DESC,id DESC LIMIT 1""",(run_id,workspace_version,diff_hash)).fetchone()
            return ({**dict(row),"manifest":json.loads(row["manifest_json"])} if row else None)
        finally: conn.close()

    def approve_verification_profile(self, project_id: str, checksum: str, profile: dict,
                                     source_hashes: dict[str, str], actor: str) -> dict:
        with self.transaction() as conn:
            self._row(conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone())
            existing = conn.execute("SELECT * FROM verification_profiles WHERE project_id=? AND checksum=?",
                                    (project_id, checksum)).fetchone()
            now = _now()
            if existing is not None:
                conn.execute("""UPDATE verification_profiles SET profile_json=?,source_hashes_json=?,status='approved',
                    approved_by=?,approved_at=?,revoked_at=NULL WHERE id=?""",
                             (canonical_payload(profile), canonical_payload(source_hashes), actor, now, existing["id"]))
                return dict(conn.execute("SELECT * FROM verification_profiles WHERE id=?", (existing["id"],)).fetchone())
            record = {"id": f"vpf_{uuid.uuid4().hex}", "project_id": project_id, "checksum": checksum,
                      "profile_json": canonical_payload(profile), "source_hashes_json": canonical_payload(source_hashes),
                      "status": "approved", "approved_by": actor, "approved_at": now, "created_at": now, "revoked_at": None}
            conn.execute("""INSERT INTO verification_profiles VALUES
                (:id,:project_id,:checksum,:profile_json,:source_hashes_json,:status,:approved_by,:approved_at,:created_at,:revoked_at)""", record)
            return record

    def get_verification_profile(self, project_id: str, checksum: str) -> dict | None:
        conn = self._connect()
        try:
            row = conn.execute("SELECT * FROM verification_profiles WHERE project_id=? AND checksum=?", (project_id, checksum)).fetchone()
            return dict(row) if row else None
        finally: conn.close()

    def revoke_verification_profile(self, profile_id: str) -> None:
        with self.transaction() as conn:
            conn.execute("UPDATE verification_profiles SET status='revoked', revoked_at=? WHERE id=? AND status='approved'", (_now(), profile_id))

    def create_verification_run(self, task_id: str, changeset_id: str, profile_checksum: str, workspace_version: str) -> dict:
        with self.transaction() as conn:
            changeset = self._row(conn.execute("SELECT * FROM changesets WHERE id=?", (changeset_id,)).fetchone())
            if changeset["task_id"] != task_id: raise ValueError("VERIFY_CHANGESET_TASK_MISMATCH")
            record = {"id": f"vrf_{uuid.uuid4().hex}", "task_id": task_id, "changeset_id": changeset_id,
                      "profile_checksum": profile_checksum, "workspace_version": workspace_version,
                      "status": "running", "started_at": _now(), "ended_at": None}
            conn.execute("INSERT INTO verification_runs VALUES (:id,:task_id,:changeset_id,:profile_checksum,:workspace_version,:status,:started_at,:ended_at)", record)
            self._append(conn, task_id, "verification.started", {"verification_id": record["id"], "changeset_id": changeset_id, "workspace_version": workspace_version})
            return record

    def record_verification_check(self, verification_id: str, check_id: str, status: str, code: str,
                                  exit_code: int | None, result: dict) -> dict:
        with self.transaction() as conn:
            verification = self._row(conn.execute("SELECT * FROM verification_runs WHERE id=?", (verification_id,)).fetchone())
            record = {"id": f"vck_{uuid.uuid4().hex}", "verification_id": verification_id, "check_id": check_id,
                      "status": status, "code": code, "exit_code": exit_code,
                      "result_json": canonical_payload(result), "created_at": _now()}
            conn.execute("INSERT INTO verification_checks VALUES (:id,:verification_id,:check_id,:status,:code,:exit_code,:result_json,:created_at)", record)
            self._append(conn, verification["task_id"], "verification.check_finished", {"verification_id": verification_id, "check_id": check_id, "status": status, "code": code})
            return record

    def finish_verification_run(self, verification_id: str, status: str) -> dict:
        with self.transaction() as conn:
            verification = self._row(conn.execute("SELECT * FROM verification_runs WHERE id=?", (verification_id,)).fetchone())
            conn.execute("UPDATE verification_runs SET status=?, ended_at=? WHERE id=? AND status='running'", (status, _now(), verification_id))
            self._append(conn, verification["task_id"], "verification.finished", {"verification_id": verification_id, "status": status})
            return self._row(conn.execute("SELECT * FROM verification_runs WHERE id=?", (verification_id,)).fetchone())

    def get_verification_run(self, verification_id: str) -> dict:
        conn = self._connect()
        try:
            record = self._row(conn.execute("SELECT * FROM verification_runs WHERE id=?", (verification_id,)).fetchone())
            record["checks"] = [{**dict(row), "result": json.loads(row["result_json"])} for row in conn.execute("SELECT * FROM verification_checks WHERE verification_id=? ORDER BY created_at,id", (verification_id,))]
            return record
        finally: conn.close()

    def latest_verification_run(self, task_id: str) -> dict | None:
        conn = self._connect()
        try:
            row = conn.execute("SELECT id FROM verification_runs WHERE task_id=? ORDER BY started_at DESC,id DESC LIMIT 1", (task_id,)).fetchone()
            return self.get_verification_run(row["id"]) if row else None
        finally: conn.close()

    def replace_acceptance_coverage(self, task_id: str, verification_id: str, coverage: list[dict]) -> list[dict]:
        with self.transaction() as conn:
            conn.execute("DELETE FROM acceptance_coverage WHERE task_id=? AND verification_id=?", (task_id, verification_id))
            rows=[]
            for item in coverage:
                row={"id": f"acv_{uuid.uuid4().hex}", "task_id": task_id, "verification_id": verification_id,
                     "acceptance": item["acceptance"], "status": item["status"],
                     "evidence_json": canonical_payload(item.get("evidence", {})), "created_at": _now()}
                conn.execute("INSERT INTO acceptance_coverage VALUES (:id,:task_id,:verification_id,:acceptance,:status,:evidence_json,:created_at)", row); rows.append(row)
            return rows

    def list_acceptance_coverage(self, task_id: str, verification_id: str | None = None) -> list[dict]:
        conn=self._connect()
        try:
            query="SELECT * FROM acceptance_coverage WHERE task_id=?"; values=[task_id]
            if verification_id is not None: query += " AND verification_id=?"; values.append(verification_id)
            return [{**dict(row),"evidence":json.loads(row["evidence_json"])} for row in conn.execute(query+" ORDER BY acceptance",values)]
        finally: conn.close()

    def issue_completion_proof(self, task_id: str, input_hash: str, workspace_version: str, decision: dict, expires_at: str) -> dict:
        with self.transaction() as conn:
            record={"id":f"cpf_{uuid.uuid4().hex}","task_id":task_id,"input_hash":input_hash,"workspace_version":workspace_version,
                    "decision_json":canonical_payload(decision),"created_at":_now(),"expires_at":expires_at,"consumed_at":None}
            conn.execute("INSERT INTO completion_proofs VALUES (:id,:task_id,:input_hash,:workspace_version,:decision_json,:created_at,:expires_at,:consumed_at)",record)
            return record

    def get_completion_proof(self, proof_id: str) -> dict:
        conn=self._connect()
        try:
            row=self._row(conn.execute("SELECT * FROM completion_proofs WHERE id=?",(proof_id,)).fetchone())
            return {**row,"decision":json.loads(row["decision_json"])}
        finally: conn.close()

    def consume_completion_proof(self, conn: sqlite3.Connection, proof_id: str, task_id: str, workspace_version: str) -> dict:
        proof=self._row(conn.execute("SELECT * FROM completion_proofs WHERE id=?",(proof_id,)).fetchone())
        if proof["task_id"] != task_id: raise ValueError("COMPLETION_PROOF_TASK_MISMATCH")
        if proof["consumed_at"] is not None: raise ValueError("COMPLETION_PROOF_CONSUMED")
        if proof["workspace_version"] != workspace_version: raise ValueError("COMPLETION_PROOF_STALE")
        if proof["expires_at"] <= _now(): raise ValueError("COMPLETION_PROOF_EXPIRED")
        conn.execute("UPDATE completion_proofs SET consumed_at=? WHERE id=? AND consumed_at IS NULL",(_now(),proof_id))
        return proof

    def list_changesets(self, task_id: str) -> list[dict]:
        conn=self._connect()
        try:
            return [{**dict(row),"manifest":json.loads(row["manifest_json"])} for row in conn.execute("SELECT * FROM changesets WHERE task_id=? ORDER BY created_at,id",(task_id,))]
        finally: conn.close()

    def list_review_decisions(self, changeset_id: str) -> list[dict]:
        conn=self._connect()
        try:
            return [dict(row) for row in conn.execute("SELECT * FROM review_decisions WHERE changeset_id=? ORDER BY created_at,id",(changeset_id,))]
        finally: conn.close()

    # Plan05 workspace/recovery records.  These methods deliberately expose no
    # destructive lifecycle operation: retiring a worktree remains an explicit
    # product action, never a reconciliation side effect.
    def reserve_workspace(self, task_id: str, project_id: str, mode: str, baseline: dict) -> dict:
        if mode not in {"current", "isolated", "limited"}:
            raise ValueError("WORKSPACE_MODE_INVALID")
        with self.transaction() as conn:
            task = self._row(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())
            if task["project_id"] != project_id:
                raise ValueError("WORKSPACE_PROJECT_MISMATCH")
            now = _now()
            record = {"id": f"ws_{uuid.uuid4().hex}", "task_id": task_id, "project_id": project_id,
                      "mode": mode, "root": None, "status": "allocating", "baseline_json": canonical_payload(baseline),
                      "workspace_version": None, "lease_owner": None, "lease_expires_at": None,
                      "lease_generation": 0, "error_code": None, "created_at": now, "updated_at": now}
            conn.execute("""INSERT INTO task_workspaces(id,task_id,project_id,mode,root,status,baseline_json,workspace_version,
                         lease_owner,lease_expires_at,lease_generation,error_code,created_at,updated_at)
                         VALUES (:id,:task_id,:project_id,:mode,:root,:status,:baseline_json,:workspace_version,
                         :lease_owner,:lease_expires_at,:lease_generation,:error_code,:created_at,:updated_at)""", record)
            self._append(conn, task_id, "workspace.reserved", {"workspace_id": record["id"], "mode": mode})
            return {**record, "baseline": baseline}

    def activate_workspace(self, workspace_id: str, root: Path, workspace_version: str) -> dict:
        with self.transaction() as conn:
            item = self._row(conn.execute("SELECT * FROM task_workspaces WHERE id=?", (workspace_id,)).fetchone())
            if item["status"] != "allocating": raise ValueError("WORKSPACE_NOT_ALLOCATING")
            now = _now()
            conn.execute("UPDATE task_workspaces SET root=?,status='ready',workspace_version=?,updated_at=? WHERE id=?",
                         (str(Path(root).resolve()), workspace_version, now, workspace_id))
            self._append(conn, item["task_id"], "workspace.ready", {"workspace_id": workspace_id, "mode": item["mode"]})
            row = self._row(conn.execute("SELECT * FROM task_workspaces WHERE id=?", (workspace_id,)).fetchone())
            return {**row, "baseline": json.loads(row["baseline_json"])}

    def mark_workspace(self, workspace_id: str, status: str, error_code: str | None = None) -> dict:
        if status not in {"allocating", "ready", "leased", "orphaned", "broken", "retired"}: raise ValueError("WORKSPACE_STATUS_INVALID")
        with self.transaction() as conn:
            item = self._row(conn.execute("SELECT * FROM task_workspaces WHERE id=?", (workspace_id,)).fetchone())
            conn.execute("UPDATE task_workspaces SET status=?,error_code=?,updated_at=? WHERE id=?", (status, error_code, _now(), workspace_id))
            self._append(conn, item["task_id"], "workspace.marked", {"workspace_id": workspace_id, "status": status, "error_code": error_code})
            row = self._row(conn.execute("SELECT * FROM task_workspaces WHERE id=?", (workspace_id,)).fetchone())
            return {**row, "baseline": json.loads(row["baseline_json"])}

    def get_workspace(self, workspace_id: str) -> dict:
        conn = self._connect()
        try:
            row = self._row(conn.execute("SELECT * FROM task_workspaces WHERE id=?", (workspace_id,)).fetchone())
            return {**row, "baseline": json.loads(row["baseline_json"])}
        finally: conn.close()

    def list_workspaces(self, task_id: str | None = None) -> list[dict]:
        conn = self._connect()
        try:
            query, values = "SELECT * FROM task_workspaces", []
            if task_id: query += " WHERE task_id=?"; values.append(task_id)
            return [{**dict(row), "baseline": json.loads(row["baseline_json"])} for row in conn.execute(query + " ORDER BY created_at,id", values)]
        finally: conn.close()

    def acquire_workspace_lease(self, workspace_id: str, owner: str, expires_at: str, now: str | None = None) -> dict:
        if not owner.strip(): raise ValueError("WORKSPACE_LEASE_OWNER_INVALID")
        with self.transaction() as conn:
            item = self._row(conn.execute("SELECT * FROM task_workspaces WHERE id=?", (workspace_id,)).fetchone())
            moment = now or _now()
            if item["lease_owner"] and item["lease_expires_at"] and item["lease_expires_at"] > moment and item["lease_owner"] != owner:
                raise ValueError("WORKSPACE_LEASE_HELD")
            if item["status"] not in {"ready", "leased"}: raise ValueError("WORKSPACE_NOT_LEASABLE")
            changed = conn.execute("UPDATE task_workspaces SET lease_owner=?,lease_expires_at=?,lease_generation=lease_generation+1,status='leased',updated_at=? WHERE id=? AND lease_generation=?",
                                   (owner, expires_at, moment, workspace_id, item["lease_generation"]))
            if changed.rowcount != 1: raise ValueError("WORKSPACE_LEASE_CONFLICT")
            row = self._row(conn.execute("SELECT * FROM task_workspaces WHERE id=?", (workspace_id,)).fetchone())
            return {**row, "baseline": json.loads(row["baseline_json"])}

    def release_workspace_lease(self, workspace_id: str, owner: str) -> dict:
        with self.transaction() as conn:
            item = self._row(conn.execute("SELECT * FROM task_workspaces WHERE id=?", (workspace_id,)).fetchone())
            if item["lease_owner"] not in {None, owner}: raise ValueError("WORKSPACE_LEASE_OWNER_MISMATCH")
            conn.execute("UPDATE task_workspaces SET lease_owner=NULL,lease_expires_at=NULL,status='ready',updated_at=? WHERE id=?", (_now(), workspace_id))
            row = self._row(conn.execute("SELECT * FROM task_workspaces WHERE id=?", (workspace_id,)).fetchone())
            return {**row, "baseline": json.loads(row["baseline_json"])}

    def insert_task_checkpoint(self, task_id: str, workspace_id: str, kind: str, workspace_version: str, manifest: dict, *, run_id: str | None = None) -> dict:
        import hashlib
        manifest_json = canonical_payload(manifest); manifest_hash = "sha256:" + hashlib.sha256(manifest_json.encode()).hexdigest()
        with self.transaction() as conn:
            workspace = self._row(conn.execute("SELECT * FROM task_workspaces WHERE id=?", (workspace_id,)).fetchone())
            if workspace["task_id"] != task_id: raise ValueError("CHECKPOINT_WORKSPACE_MISMATCH")
            if kind != "manual":
                existing = conn.execute("SELECT * FROM task_checkpoints WHERE workspace_id=? AND kind=? AND workspace_version=?", (workspace_id, kind, workspace_version)).fetchone()
                if existing: return {**dict(existing), "manifest": json.loads(existing["manifest_json"])}
            record={"id":f"cp_{uuid.uuid4().hex}","task_id":task_id,"run_id":run_id,"workspace_id":workspace_id,"kind":kind,
                    "workspace_version":workspace_version,"manifest_json":manifest_json,"manifest_hash":manifest_hash,"created_at":_now()}
            conn.execute("INSERT INTO task_checkpoints VALUES (:id,:task_id,:run_id,:workspace_id,:kind,:workspace_version,:manifest_json,:manifest_hash,:created_at)", record)
            self._append(conn, task_id, "checkpoint.created", {"checkpoint_id":record["id"],"workspace_id":workspace_id,"kind":kind,"workspace_version":workspace_version})
            return {**record,"manifest":manifest}

    def get_task_checkpoint(self, checkpoint_id: str) -> dict:
        conn=self._connect()
        try:
            row=self._row(conn.execute("SELECT * FROM task_checkpoints WHERE id=?",(checkpoint_id,)).fetchone())
            return {**row,"manifest":json.loads(row["manifest_json"])}
        finally: conn.close()

    def list_task_checkpoints(self, task_id: str) -> list[dict]:
        conn=self._connect()
        try:
            return [{**dict(row),"manifest":json.loads(row["manifest_json"])} for row in conn.execute("SELECT * FROM task_checkpoints WHERE task_id=? ORDER BY created_at,id",(task_id,))]
        finally: conn.close()

    def insert_recovery_preview(self, task_id: str, checkpoint_id: str, workspace_id: str, workspace_version: str, checkpoint_hash: str, operations: list[dict], preview_hash: str, expires_at: str) -> dict:
        with self.transaction() as conn:
            record={"id":f"rcp_{uuid.uuid4().hex}","task_id":task_id,"checkpoint_id":checkpoint_id,"workspace_id":workspace_id,"workspace_version":workspace_version,"checkpoint_hash":checkpoint_hash,"operations_json":canonical_payload(operations),"preview_hash":preview_hash,"expires_at":expires_at,"created_at":_now()}
            conn.execute("INSERT INTO recovery_previews VALUES (:id,:task_id,:checkpoint_id,:workspace_id,:workspace_version,:checkpoint_hash,:operations_json,:preview_hash,:expires_at,:created_at)",record)
            self._append(conn,task_id,"recovery.previewed",{"preview_id":record["id"],"checkpoint_id":checkpoint_id,"workspace_version":workspace_version})
            return {**record,"operations":operations}

    def get_recovery_preview(self, preview_id: str) -> dict:
        conn=self._connect()
        try:
            row=self._row(conn.execute("SELECT * FROM recovery_previews WHERE id=?",(preview_id,)).fetchone())
            return {**row,"operations":json.loads(row["operations_json"])}
        finally: conn.close()

    def create_recovery_execution(self, task_id: str, preview_id: str, before_checkpoint_id: str | None, status: str, items: list[dict], resulting_workspace_version: str | None = None, ended: bool = False) -> dict:
        with self.transaction() as conn:
            now=_now(); record={"id":f"rce_{uuid.uuid4().hex}","task_id":task_id,"preview_id":preview_id,"before_checkpoint_id":before_checkpoint_id,"status":status,"items_json":canonical_payload(items),"started_at":now,"ended_at":now if ended else None,"resulting_workspace_version":resulting_workspace_version}
            conn.execute("INSERT INTO recovery_executions VALUES (:id,:task_id,:preview_id,:before_checkpoint_id,:status,:items_json,:started_at,:ended_at,:resulting_workspace_version)",record)
            self._append(conn,task_id,"recovery.started",{"execution_id":record["id"],"preview_id":preview_id})
            return {**record,"items":items}

    def finish_recovery_execution(self, execution_id: str, status: str, items: list[dict], workspace_version: str | None) -> dict:
        with self.transaction() as conn:
            record=self._row(conn.execute("SELECT * FROM recovery_executions WHERE id=?",(execution_id,)).fetchone())
            conn.execute("UPDATE recovery_executions SET status=?,items_json=?,ended_at=?,resulting_workspace_version=? WHERE id=?",(status,canonical_payload(items),_now(),workspace_version,execution_id))
            self._append(conn,record["task_id"],"recovery.finished",{"execution_id":execution_id,"status":status})
            row=self._row(conn.execute("SELECT * FROM recovery_executions WHERE id=?",(execution_id,)).fetchone())
            return {**row,"items":json.loads(row["items_json"])}

    def add_task_relation(self, source_task_id: str, target_task_id: str, kind: str) -> dict:
        if kind not in {"forked_from", "supersedes"}: raise ValueError("TASK_RELATION_INVALID")
        with self.transaction() as conn:
            self._row(conn.execute("SELECT * FROM tasks WHERE id=?",(source_task_id,)).fetchone()); self._row(conn.execute("SELECT * FROM tasks WHERE id=?",(target_task_id,)).fetchone())
            row=conn.execute("SELECT * FROM task_relations WHERE source_task_id=? AND target_task_id=? AND kind=?",(source_task_id,target_task_id,kind)).fetchone()
            if row: return dict(row)
            record={"id":f"rel_{uuid.uuid4().hex}","source_task_id":source_task_id,"target_task_id":target_task_id,"kind":kind,"created_at":_now()}
            conn.execute("INSERT INTO task_relations VALUES (:id,:source_task_id,:target_task_id,:kind,:created_at)",record)
            self._append(conn,source_task_id,"task.related",{"relation_id":record["id"],"target_task_id":target_task_id,"kind":kind})
            return record

    def list_task_relations(self, task_id: str) -> list[dict]:
        conn=self._connect()
        try: return [dict(row) for row in conn.execute("SELECT * FROM task_relations WHERE source_task_id=? OR target_task_id=? ORDER BY created_at,id",(task_id,task_id))]
        finally: conn.close()

    def _record_review_in(self, conn: sqlite3.Connection, changeset_id: str, request_id: str,
                          decision: str, feedback: str, diff_hash: str, workspace_version: str) -> tuple[dict, bool]:
        if decision not in {"approve", "request_changes", "acknowledge_limited"}:
            raise ValueError("REVIEW_DECISION_INVALID")
        prior = conn.execute("SELECT * FROM review_decisions WHERE request_id=?", (request_id,)).fetchone()
        if prior:
            return dict(prior), False
        changeset = self._row(conn.execute("SELECT * FROM changesets WHERE id=?", (changeset_id,)).fetchone())
        if changeset["stale_at"] is not None:
            raise ValueError("REVIEW_CHANGESET_STALE")
        if changeset["diff_hash"] != diff_hash or changeset["workspace_version"] != workspace_version:
            raise ValueError("REVIEW_DIFF_MISMATCH")
        existing = conn.execute("SELECT id FROM review_decisions WHERE changeset_id=? LIMIT 1", (changeset_id,)).fetchone()
        if existing:
            raise ValueError("REVIEW_ALREADY_DECIDED")
        record = {"id": f"rvw_{uuid.uuid4().hex}", "changeset_id": changeset_id, "request_id": request_id,
                  "decision": decision, "feedback": feedback, "diff_hash": diff_hash,
                  "workspace_version": workspace_version, "created_at": _now()}
        conn.execute("INSERT INTO review_decisions VALUES (:id,:changeset_id,:request_id,:decision,:feedback,:diff_hash,:workspace_version,:created_at)", record)
        self._append(conn, changeset["task_id"], "review.recorded", {
            "review_id": record["id"], "changeset_id": changeset_id, "decision": decision,
        })
        return record, True

    def record_review(self, changeset_id: str, request_id: str, decision: str, feedback: str,
                      diff_hash: str, workspace_version: str) -> dict:
        with self.transaction() as conn:
            return self._record_review_in(conn, changeset_id, request_id, decision, feedback,
                                          diff_hash, workspace_version)[0]

    def mark_changeset_stale(self, changeset_id: str, current_workspace_version: str) -> None:
        with self.transaction() as conn:
            row=self._row(conn.execute("SELECT * FROM changesets WHERE id=?",(changeset_id,)).fetchone())
            if row["stale_at"] is None:
                conn.execute("UPDATE changesets SET stale_at=?,stale_workspace_version=? WHERE id=?",(_now(),current_workspace_version,changeset_id))
                self._append(conn,row["task_id"],"changeset.stale",{"changeset_id":changeset_id,"workspace_version":current_workspace_version})
