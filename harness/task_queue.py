"""Durable queue records only; workers and leases are introduced in later tasks."""
from __future__ import annotations

import sqlite3
import uuid
from datetime import UTC, datetime

from .task_model import EnqueueTask, QueueItem
from .task_store import TaskStore, _now


_TERMINAL_TASK_STATUSES = frozenset({"Succeeded", "Failed", "Cancelled", "Archived"})


def _parse_utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.astimezone(UTC)


def _utc_iso(value: datetime, field_name: str = "now") -> str:
    if not isinstance(value, datetime) or value.tzinfo is not UTC:
        raise ValueError(f"{field_name} must be a UTC datetime")
    return value.isoformat().replace("+00:00", "Z")


def _item(row: sqlite3.Row | dict) -> QueueItem:
    return QueueItem(
        id=row["id"], task_id=row["task_id"], trigger_kind=row["trigger_kind"],
        trigger_key=row["trigger_key"], priority=row["priority"],
        not_before=_parse_utc(row["not_before"]), policy_id=row["policy_id"],
        status=row["status"], version=row["version"],
        created_at=_parse_utc(row["created_at"]), updated_at=_parse_utc(row["updated_at"]),
    )


class TaskQueue:
    def __init__(self, store: TaskStore):
        self.store = store

    def enqueue(self, command: EnqueueTask) -> QueueItem:
        with self.store.transaction() as conn:
            task = conn.execute("SELECT status, archived_at, version FROM tasks WHERE id=?", (command.task_id,)).fetchone()
            if task is None:
                raise KeyError("tasking record not found")
            if task["status"] in _TERMINAL_TASK_STATUSES or task["archived_at"] is not None:
                raise ValueError("TASK_QUEUE_TASK_TERMINAL")
            # 终态/归档约束高于 trigger 幂等：旧 queue item 不能成为绕过
            # Task 生命周期的后门。只有仍可执行的 Task 才能返回同一 trigger 的现存项。
            existing = self.store.queue_by_trigger(conn, command.trigger_key)
            if existing is not None:
                return _item(existing)
            if task["version"] != command.expected_version:
                raise ValueError("TASK_VERSION_CONFLICT")
            now = _now()
            record = {
                "id": f"qit_{uuid.uuid4().hex}", "task_id": command.task_id,
                "trigger_kind": command.trigger_kind, "trigger_key": command.trigger_key,
                "priority": command.priority,
                "not_before": command.not_before.isoformat().replace("+00:00", "Z"),
                "policy_id": command.policy_id, "status": "pending", "version": 0,
                "lease_owner": None, "lease_generation": 0, "lease_expires_at": None,
                "created_at": now, "updated_at": now,
            }
            try:
                return _item(self.store.insert_queue_item(conn, record))
            except sqlite3.IntegrityError:
                existing = self.store.queue_by_trigger(conn, command.trigger_key)
                if existing is None:
                    raise
                return _item(existing)

    def get(self, item_id: str) -> QueueItem:
        conn = self.store._connect()
        try:
            item = self.store.queue_item(conn, item_id)
            if item is None:
                raise KeyError("queue item not found")
            return _item(item)
        finally:
            conn.close()

    def list_ready(self, now: datetime, limit: int = 20) -> list[QueueItem]:
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            raise ValueError("limit must be a positive integer")
        return [_item(row) for row in self.store.ready_queue_items(_utc_iso(now), limit)]

    def pause(self, item_id: str, expected_version: int) -> QueueItem:
        return self._transition(item_id, expected_version, {"pending"}, "paused")

    def resume(self, item_id: str, expected_version: int) -> QueueItem:
        return self._transition(item_id, expected_version, {"paused"}, "pending")

    def cancel(self, item_id: str, expected_version: int) -> QueueItem:
        return self._transition(item_id, expected_version, {"pending", "paused"}, "cancelled")

    def _transition(self, item_id: str, expected_version: int, allowed: set[str], target: str) -> QueueItem:
        if not isinstance(expected_version, int) or isinstance(expected_version, bool) or expected_version < 0:
            raise ValueError("expected_version must be a non-negative integer")
        with self.store.transaction() as conn:
            current = self.store.queue_item(conn, item_id)
            if current is None:
                raise KeyError("queue item not found")
            if current["version"] != expected_version:
                raise ValueError("TASK_QUEUE_VERSION_CONFLICT")
            if current["status"] not in allowed:
                raise ValueError("TASK_QUEUE_TRANSITION_INVALID")
            changed = conn.execute("""
                UPDATE queue_items SET status=?, version=version+1, updated_at=?
                WHERE id=? AND version=? AND status=?
            """, (target, _now(), item_id, expected_version, current["status"]))
            if changed.rowcount != 1:
                raise ValueError("TASK_QUEUE_VERSION_CONFLICT")
            updated = self.store.queue_item(conn, item_id)
            assert updated is not None
            return _item(updated)
