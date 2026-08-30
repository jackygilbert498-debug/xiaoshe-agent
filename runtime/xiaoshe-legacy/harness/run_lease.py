"""SQLite-backed worker leases with conservative expiry reconciliation.

An expired lease is evidence of a lost worker, not permission to repeat a write.
This module owns only queue leases; TaskWorker owns actual runtime dispatch.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from . import effects
from .task_queue import _item, _utc_iso
from .task_store import TaskStore, _now
from .action_idempotency import ActionIdempotency, ReplayDecision
from .effect_outcomes import EffectOutcome


@dataclass(frozen=True)
class ClaimedItem:
    item: object
    owner: str
    generation: int
    expires_at: datetime


@dataclass(frozen=True)
class ReconcileDecision:
    item_id: str
    kind: str
    code: str


class RunLeaseService:
    def __init__(self, store: TaskStore, ttl_seconds: int = 30, effects_path=None,
                 effect_fence_timeout: float = 30):
        if not isinstance(ttl_seconds, int) or ttl_seconds < 1:
            raise ValueError("lease ttl must be a positive integer")
        if (not isinstance(effect_fence_timeout, (int, float))
                or isinstance(effect_fence_timeout, bool) or effect_fence_timeout <= 0):
            raise ValueError("effect fence timeout must be positive")
        self.store, self.ttl_seconds = store, ttl_seconds
        self.effects_path = Path(effects_path) if effects_path is not None else effects.EFFECTS_FILE
        self.effect_fence_timeout = float(effect_fence_timeout)

    @staticmethod
    def _manual_hold():
        return ActionIdempotency.classify(
            "unknown", "started", outcome_state=EffectOutcome.OUTCOME_UNKNOWN.value,
            outcome_proven=True,
        )

    @staticmethod
    def _is_explicit_not_started(record: object, task_id: object, run_id: object) -> bool:
        """Delegate strict durable-record validation to the effect ledger contract."""
        return effects.is_complete_not_started_task_effect(
            record, task_id=task_id, run_id=run_id,
        )

    def _lease_effect_decision(self, task_id: object, run_id: object, action: object):
        """Missing or malformed evidence is a manual hold, never retry proof."""
        if action is not None or not isinstance(task_id, str) or not isinstance(run_id, str):
            return self._manual_hold()
        try:
            records = [record for record in effects.load(self.effects_path) if (
                record.get("task_id") == task_id and record.get("run_id") == run_id
            )]
        except Exception:
            return self._manual_hold()
        if not records or not all(self._is_explicit_not_started(record, task_id, run_id) for record in records):
            return self._manual_hold()
        return ActionIdempotency.classify(
            "unknown", "started", outcome_state=EffectOutcome.NOT_STARTED.value,
            outcome_proven=True,
        )

    def claim_next(self, worker_id: str, now: datetime) -> ClaimedItem | None:
        if not isinstance(worker_id, str) or not worker_id.strip():
            raise ValueError("worker_id must not be blank")
        now_text = _utc_iso(now)
        expires_at = now + timedelta(seconds=self.ttl_seconds)
        expires_text = _utc_iso(expires_at, "expires_at")
        with self.store.transaction() as conn:
            row = conn.execute("""SELECT * FROM queue_items
                WHERE status='pending' AND not_before<=?
                ORDER BY priority DESC, not_before ASC, created_at ASC, id ASC LIMIT 1""", (now_text,)).fetchone()
            if row is None:
                return None
            generation = row["lease_generation"] + 1
            changed = conn.execute("""UPDATE queue_items SET status='leased', lease_owner=?,
                lease_generation=?, lease_expires_at=?, version=version+1, updated_at=?
                WHERE id=? AND status='pending' AND version=?""", (
                worker_id.strip(), generation, expires_text, _now(), row["id"], row["version"],
            ))
            if changed.rowcount != 1:
                return None
            claimed = self.store.queue_item(conn, row["id"])
            assert claimed is not None
            return ClaimedItem(_item(claimed), worker_id.strip(), generation, expires_at)

    def heartbeat(self, item_id: str, worker_id: str, generation: int, now: datetime) -> ClaimedItem:
        expires_at = now + timedelta(seconds=self.ttl_seconds)
        with self.store.transaction() as conn:
            row = self.store.queue_item(conn, item_id)
            if row is None:
                raise KeyError("queue item not found")
            if row["status"] != "leased" or row["lease_owner"] != worker_id or row["lease_generation"] != generation:
                raise ValueError("LEASE_STALE")
            # A late heartbeat cannot resurrect an expired generation.
            if row["lease_expires_at"] is None or row["lease_expires_at"] <= _utc_iso(now):
                raise ValueError("LEASE_EXPIRED")
            changed = conn.execute("""UPDATE queue_items SET lease_expires_at=?, updated_at=?
                WHERE id=? AND status='leased' AND lease_owner=? AND lease_generation=? AND lease_expires_at>?""", (
                _utc_iso(expires_at, "expires_at"), _now(), item_id, worker_id, generation, _utc_iso(now),
            ))
            if changed.rowcount != 1:
                raise ValueError("LEASE_STALE")
            updated = self.store.queue_item(conn, item_id)
            assert updated is not None
            return ClaimedItem(_item(updated), worker_id, generation, expires_at)

    def finish(self, claim: ClaimedItem, status: str = "done") -> object:
        if status not in {"done", "failed"}:
            raise ValueError("LEASE_FINISH_STATUS_INVALID")
        with self.store.transaction() as conn:
            changed = conn.execute("""UPDATE queue_items SET status=?, lease_owner=NULL, lease_expires_at=NULL,
                version=version+1, updated_at=? WHERE id=? AND status='leased' AND lease_owner=? AND lease_generation=?""", (
                status, _now(), claim.item.id, claim.owner, claim.generation,
            ))
            if changed.rowcount != 1:
                raise ValueError("LEASE_STALE")
            row = self.store.queue_item(conn, claim.item.id)
            assert row is not None
            return _item(row)

    def _reconcile_expired_locked(self, now: datetime, *, ledger_available: bool) -> list[ReconcileDecision]:
        """Apply lease transitions while the shared effect fence is held."""
        now_text = _utc_iso(now)
        decisions: list[ReconcileDecision] = []
        with self.store.transaction() as conn:
            expired = list(conn.execute("SELECT * FROM queue_items WHERE status='leased' AND lease_expires_at<=? ORDER BY id", (now_text,)))
            for row in expired:
                task = conn.execute("SELECT * FROM tasks WHERE id=?", (row["task_id"],)).fetchone()
                active_run = task["active_run_id"] if task else None
                action = None
                if active_run:
                    action = conn.execute("SELECT status FROM actions WHERE run_id=? ORDER BY started_at DESC, id DESC LIMIT 1", (active_run,)).fetchone()
                decision = (
                    self._lease_effect_decision(row["task_id"], active_run, action)
                    if ledger_available else ReplayDecision("waiting_user", "EFFECT_FENCE_UNAVAILABLE")
                )
                if decision.kind == "waiting_user":
                    if task and task["status"] == "Running":
                        conn.execute("UPDATE tasks SET status='WaitingUser', active_run_id=NULL, version=version+1, updated_at=? WHERE id=?", (_now(), task["id"]))
                        self.store._append(conn, task["id"], "run.reconcile_waiting_user", {"queue_item_id": row["id"], "code": decision.code})
                    conn.execute("UPDATE queue_items SET status='done', lease_owner=NULL, lease_expires_at=NULL, version=version+1, updated_at=? WHERE id=? AND version=?", (_now(), row["id"], row["version"]))
                    decisions.append(ReconcileDecision(row["id"], decision.kind, decision.code))
                else:
                    conn.execute("UPDATE queue_items SET status='pending', lease_owner=NULL, lease_expires_at=NULL, version=version+1, updated_at=? WHERE id=? AND version=?", (_now(), row["id"], row["version"]))
                    decisions.append(ReconcileDecision(row["id"], decision.kind, decision.code))
        return decisions

    def reconcile_expired(self, now: datetime) -> list[ReconcileDecision]:
        """Serialize durable-effect evidence and queue recovery on one shared fence."""
        try:
            with effects.task_effect_fence(self.effects_path, timeout=self.effect_fence_timeout):
                return self._reconcile_expired_locked(now, ledger_available=True)
        except (OSError, TimeoutError):
            # A lock timeout means the ledger may change at the dispatch
            # boundary.  Do not retry; atomically park every expired item for
            # manual reconciliation without reading that mutable evidence.
            return self._reconcile_expired_locked(now, ledger_available=False)
