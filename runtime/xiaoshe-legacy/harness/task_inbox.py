"""Single task-fact inbox; queue records never create a second user status."""
from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from .task_store import TaskStore

_NEEDS_USER = frozenset({"WaitingUser", "Review"})

@dataclass(frozen=True)
class InboxPage:
    items: tuple[dict, ...]
    next_cursor: str | None
    counts: dict[str, int]

class TaskInbox:
    def __init__(self, store: TaskStore):
        self.store = store
        self._initialize_ingress()

    @staticmethod
    def _now() -> str:
        return datetime.now(UTC).isoformat().replace("+00:00", "Z")

    @contextmanager
    def _connection(self):
        """Dedicated durable-inbox connection; never masquerade as a projection."""
        conn = sqlite3.connect(self.store.db_path, timeout=5, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA journal_mode=WAL")
        try:
            yield conn
        finally:
            conn.close()

    def _initialize_ingress(self) -> None:
        with self._connection() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS inbox_request_nonces (
                    identity_id TEXT NOT NULL, nonce_digest TEXT NOT NULL, issued_at TEXT NOT NULL,
                    PRIMARY KEY(identity_id, nonce_digest)
                );
                CREATE TABLE IF NOT EXISTS inbox_intents (
                    receipt_id TEXT PRIMARY KEY, identity_id TEXT NOT NULL, project_id TEXT NOT NULL,
                    task_id TEXT, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
                    intent_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status='accepted'), created_at TEXT NOT NULL,
                    UNIQUE(identity_id, idempotency_key)
                );
                CREATE INDEX IF NOT EXISTS inbox_intents_pending ON inbox_intents(status, created_at, receipt_id);
            """)

    def consume_request_nonce(self, identity_id: str, nonce_digest: str, issued_at: str) -> bool:
        try:
            with self._connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                conn.execute("INSERT INTO inbox_request_nonces VALUES (?,?,?)", (identity_id, nonce_digest, issued_at))
                conn.execute("COMMIT")
            return True
        except sqlite3.IntegrityError:
            return False

    def task_belongs_to(self, task_id: str, project_id: str) -> bool:
        try:
            return self.store.get_task(task_id)["project_id"] == project_id
        except KeyError:
            return False

    def find_intent(self, identity_id: str, idempotency_key: str) -> dict | None:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT receipt_id,fingerprint,status,created_at FROM inbox_intents WHERE identity_id=? AND idempotency_key=?",
                (identity_id, idempotency_key),
            ).fetchone()
        return dict(row) if row else None

    def accept_intent(self, *, identity_id: str, project_id: str, task_id: str | None,
                      idempotency_key: str, fingerprint: str, intent: dict) -> tuple[dict, bool]:
        """Atomically accept once; actual execution remains with the Runtime task pipeline."""
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                "SELECT receipt_id,fingerprint,status,created_at FROM inbox_intents WHERE identity_id=? AND idempotency_key=?",
                (identity_id, idempotency_key),
            ).fetchone()
            if existing:
                conn.execute("COMMIT")
                if existing["fingerprint"] != fingerprint:
                    raise ValueError("INBOX_IDEMPOTENCY_CONFLICT")
                return dict(existing), True
            row = {
                "receipt_id": f"rcpt_{uuid.uuid4().hex}", "fingerprint": fingerprint,
                "status": "accepted", "created_at": self._now(),
            }
            conn.execute(
                "INSERT INTO inbox_intents(receipt_id,identity_id,project_id,task_id,idempotency_key,fingerprint,intent_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (row["receipt_id"], identity_id, project_id, task_id, idempotency_key, fingerprint,
                 json.dumps(intent, ensure_ascii=False, sort_keys=True, separators=(",", ":")), row["status"], row["created_at"]),
            )
            conn.execute("COMMIT")
            return row, False

    def pending_intent_count(self) -> int:
        with self._connection() as conn:
            return int(conn.execute("SELECT COUNT(*) FROM inbox_intents WHERE status='accepted'").fetchone()[0])

    def query(self, project_id: str | None = None, needs_user: bool = False,
              statuses: tuple[str, ...] | None = None, limit: int = 50, cursor: str | None = None) -> InboxPage:
        if not isinstance(limit, int) or limit < 1 or limit > 200: raise ValueError("INBOX_LIMIT_INVALID")
        rows = self.store.list_tasks({"project_id": project_id} if project_id else None)
        if needs_user: rows = [row for row in rows if row["status"] in _NEEDS_USER]
        if statuses is not None: rows = [row for row in rows if row["status"] in statuses]
        rows.sort(key=lambda row: (row["updated_at"], row["id"]), reverse=True)
        if cursor:
            rows = [row for row in rows if f"{row['updated_at']}|{row['id']}" < cursor]
        page = rows[:limit]
        counts: dict[str, int] = {}
        for row in self.store.list_tasks({"project_id": project_id} if project_id else None):
            counts[row["status"]] = counts.get(row["status"], 0) + 1
        next_cursor = f"{page[-1]['updated_at']}|{page[-1]['id']}" if len(rows) > limit else None
        return InboxPage(tuple(page), next_cursor, counts)
