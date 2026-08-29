from __future__ import annotations

import json
import tempfile
import threading
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

from harness import effects
from harness.run_lease import RunLeaseService
from harness.task_model import CreateTask, EnqueueTask, StartRun
from harness.task_queue import TaskQueue
from harness.task_store import TaskStore


class RunLeaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.store = TaskStore(Path(self.temp.name) / "tasks.sqlite")
        self.project = self.store.create_project("p", Path(self.temp.name)); self.task = self.store.create_task(CreateTask(self.project["id"], "t", "g", ()))
        self.now = datetime(2026, 8, 4, tzinfo=UTC); self.queue = TaskQueue(self.store); self.leases = RunLeaseService(self.store, ttl_seconds=10)
        self.queue.enqueue(EnqueueTask(self.task["id"], "manual", "request:1", 0, self.now, "p1", self.task["version"]))

    def tearDown(self): self.temp.cleanup()

    def test_only_one_worker_claims_item_and_old_heartbeat_cannot_extend(self):
        first = self.leases.claim_next("a", self.now); second = self.leases.claim_next("b", self.now)
        self.assertIsNotNone(first); self.assertIsNone(second)
        with self.assertRaisesRegex(ValueError, "LEASE_STALE"):
            self.leases.heartbeat(first.item.id, "b", first.generation, self.now + timedelta(seconds=1))
        with self.assertRaisesRegex(ValueError, "LEASE_EXPIRED"):
            self.leases.heartbeat(first.item.id, "a", first.generation, self.now + timedelta(seconds=10))

    def test_expired_claim_without_durable_action_evidence_holds_for_review(self):
        claim = self.leases.claim_next("a", self.now)
        decisions = self.leases.reconcile_expired(self.now + timedelta(seconds=11))
        self.assertEqual([(claim.item.id, "waiting_user")], [(x.item_id, x.kind) for x in decisions])
        self.assertEqual("done", self.queue.get(claim.item.id).status)

    def test_expired_unknown_effect_is_held_and_next_worker_cannot_reclaim_it(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TaskStore(Path(directory) / "tasks.sqlite")
            project = store.create_project("p", Path(directory))
            task = store.create_task(CreateTask(project["id"], "t", "g", ()))
            ready = store.transition_task(task["id"], task["version"], "Ready", "test")
            running, run = store.start_run(StartRun(ready["id"], ready["version"], "worker"))
            queue = TaskQueue(store)
            queue.enqueue(EnqueueTask(
                running["id"], "manual", "request:1", 0, self.now, "p1", running["version"],
            ))
            ledger = Path(directory) / "effects.jsonl"
            lease = RunLeaseService(store, ttl_seconds=10, effects_path=ledger)
            claim = lease.claim_next("lost-worker", self.now)
            self.assertIsNotNone(claim)
            effect_id = effects.begin_task_effect(
                "run_command", {"command": "curl https://example.invalid"},
                {"task_id": running["id"]}, path=ledger, action_id="act_lost", run_id=run["id"],
            )
            effects.mark_task_effect_started(effect_id, path=ledger)

            decisions = lease.reconcile_expired(self.now + timedelta(seconds=11))

            self.assertEqual([(claim.item.id, "waiting_user", "ACTION_OUTCOME_UNKNOWN")], [
                (item.item_id, item.kind, item.code) for item in decisions
            ])
            self.assertEqual("WaitingUser", store.get_task(running["id"])["status"])
            self.assertEqual("done", queue.get(claim.item.id).status)
            self.assertIsNone(lease.claim_next("next-worker", self.now + timedelta(seconds=12)))

    def test_only_explicit_durable_not_started_evidence_can_be_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TaskStore(Path(directory) / "tasks.sqlite")
            project = store.create_project("p", Path(directory))
            task = store.create_task(CreateTask(project["id"], "t", "g", ()))
            ready = store.transition_task(task["id"], task["version"], "Ready", "test")
            running, run = store.start_run(StartRun(ready["id"], ready["version"], "worker"))
            queue = TaskQueue(store)
            queue.enqueue(EnqueueTask(
                running["id"], "manual", "request:1", 0, self.now, "p1", running["version"],
            ))
            ledger = Path(directory) / "effects.jsonl"
            lease = RunLeaseService(store, ttl_seconds=10, effects_path=ledger)
            claim = lease.claim_next("lost-worker", self.now)
            self.assertIsNotNone(claim)
            effects.begin_task_effect(
                "run_command", {"command": "curl https://example.invalid"},
                {"task_id": running["id"]}, path=ledger, action_id="act_not_started", run_id=run["id"],
            )

            decisions = lease.reconcile_expired(self.now + timedelta(seconds=11))

            self.assertEqual([(claim.item.id, "retry_safe")], [(item.item_id, item.kind) for item in decisions])
            self.assertEqual("pending", queue.get(claim.item.id).status)
            self.assertIsNotNone(lease.claim_next("next-worker", self.now + timedelta(seconds=12)))

    def test_reconcile_serializes_not_started_decision_with_effect_fence(self):
        """An old worker must be able to advance its marker before requeue commits."""
        with tempfile.TemporaryDirectory() as directory:
            store = TaskStore(Path(directory) / "tasks.sqlite")
            project = store.create_project("p", Path(directory))
            task = store.create_task(CreateTask(project["id"], "t", "g", ()))
            ready = store.transition_task(task["id"], task["version"], "Ready", "test")
            running, run = store.start_run(StartRun(ready["id"], ready["version"], "worker"))
            queue = TaskQueue(store)
            queue.enqueue(EnqueueTask(
                running["id"], "manual", "request:1", 0, self.now, "p1", running["version"],
            ))
            ledger = Path(directory) / "effects.jsonl"
            lease = RunLeaseService(store, ttl_seconds=10, effects_path=ledger, effect_fence_timeout=1)
            claim = lease.claim_next("lost-worker", self.now)
            effect_id = effects.begin_task_effect(
                "run_command", {"command": "curl https://example.invalid"},
                {"task_id": running["id"]}, path=ledger, action_id="act_race", run_id=run["id"],
            )
            entered, advance = threading.Event(), threading.Event()
            reconciled, decisions = threading.Event(), []

            def old_worker():
                with effects.task_effect_fence(ledger):
                    entered.set()
                    self.assertTrue(advance.wait(2))
                    effects.mark_task_effect_started(effect_id, path=ledger, fence_held=True)

            def reconcile():
                decisions.extend(lease.reconcile_expired(self.now + timedelta(seconds=11)))
                reconciled.set()

            worker = threading.Thread(target=old_worker)
            worker.start()
            self.assertTrue(entered.wait(1))
            reconciler = threading.Thread(target=reconcile)
            reconciler.start()
            try:
                self.assertFalse(reconciled.wait(0.15), "reconciler bypassed the shared effect fence")
                advance.set()
                self.assertTrue(reconciled.wait(2))
            finally:
                advance.set()
                worker.join(2)
                reconciler.join(2)

            self.assertFalse(worker.is_alive())
            self.assertFalse(reconciler.is_alive())
            self.assertEqual([(claim.item.id, "waiting_user", "ACTION_OUTCOME_UNKNOWN")], [
                (item.item_id, item.kind, item.code) for item in decisions
            ])
            self.assertEqual("done", queue.get(claim.item.id).status)
            self.assertEqual("outcome_unknown", effects.load(ledger)[0]["outcome_state"])

    def test_effect_fence_timeout_fails_closed_to_manual_hold(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TaskStore(Path(directory) / "tasks.sqlite")
            project = store.create_project("p", Path(directory))
            task = store.create_task(CreateTask(project["id"], "t", "g", ()))
            ready = store.transition_task(task["id"], task["version"], "Ready", "test")
            running, run = store.start_run(StartRun(ready["id"], ready["version"], "worker"))
            queue = TaskQueue(store)
            queue.enqueue(EnqueueTask(
                running["id"], "manual", "request:1", 0, self.now, "p1", running["version"],
            ))
            ledger = Path(directory) / "effects.jsonl"
            lease = RunLeaseService(store, ttl_seconds=10, effects_path=ledger, effect_fence_timeout=0.02)
            claim = lease.claim_next("lost-worker", self.now)
            effects.begin_task_effect(
                "run_command", {"command": "curl https://example.invalid"},
                {"task_id": running["id"]}, path=ledger, action_id="act_timeout", run_id=run["id"],
            )
            entered, release = threading.Event(), threading.Event()

            def hold_fence():
                with effects.task_effect_fence(ledger):
                    entered.set()
                    release.wait(2)

            holder = threading.Thread(target=hold_fence)
            holder.start()
            self.assertTrue(entered.wait(1))
            try:
                decisions = lease.reconcile_expired(self.now + timedelta(seconds=11))
            finally:
                release.set()
                holder.join(2)

            self.assertEqual([(claim.item.id, "waiting_user", "EFFECT_FENCE_UNAVAILABLE")], [
                (item.item_id, item.kind, item.code) for item in decisions
            ])
            self.assertEqual("done", queue.get(claim.item.id).status)

    def test_incomplete_v2_not_started_record_is_not_replay_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TaskStore(Path(directory) / "tasks.sqlite")
            project = store.create_project("p", Path(directory))
            task = store.create_task(CreateTask(project["id"], "t", "g", ()))
            ready = store.transition_task(task["id"], task["version"], "Ready", "test")
            running, run = store.start_run(StartRun(ready["id"], ready["version"], "worker"))
            queue = TaskQueue(store)
            queue.enqueue(EnqueueTask(
                running["id"], "manual", "request:1", 0, self.now, "p1", running["version"],
            ))
            ledger = Path(directory) / "effects.jsonl"
            lease = RunLeaseService(store, ttl_seconds=10, effects_path=ledger)
            claim = lease.claim_next("lost-worker", self.now)
            effects.begin_task_effect(
                "run_command", {"command": "curl https://example.invalid"},
                {"task_id": running["id"]}, path=ledger, action_id="act_incomplete", run_id=run["id"],
            )
            record = effects.load(ledger)[0]
            record["irreversible"] = "yes"
            ledger.write_text(json.dumps(record) + "\n", encoding="utf-8")

            decisions = lease.reconcile_expired(self.now + timedelta(seconds=11))

            self.assertEqual([(claim.item.id, "waiting_user")], [(item.item_id, item.kind) for item in decisions])
