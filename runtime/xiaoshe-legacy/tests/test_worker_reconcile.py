from __future__ import annotations

import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

from harness.run_lease import RunLeaseService
from harness.task_model import CreateTask, EnqueueTask, StartRun
from harness.task_queue import TaskQueue
from harness.task_store import TaskStore, _now


class WorkerReconcileTests(unittest.TestCase):
    def test_expired_unknown_action_waits_for_user(self):
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStore(Path(temp) / "tasks.sqlite"); project = store.create_project("p", Path(temp))
            task = store.create_task(CreateTask(project["id"], "t", "g", ()))
            # TaskStore's run boundary requires Ready; this is intentional evidence for reconciliation.
            ready = store.transition_task(task["id"], task["version"], "Ready", "test")
            _, run = store.start_run(StartRun(ready["id"], ready["version"], "worker"))
            queue = TaskQueue(store); now = datetime(2026, 8, 4, tzinfo=UTC)
            item = queue.enqueue(EnqueueTask(task["id"], "manual", "request:unknown", 0, now, "p1", store.get_task(task["id"])["version"]))
            claim = RunLeaseService(store, 1).claim_next("a", now)
            with store.transaction() as conn:
                conn.execute("INSERT INTO actions(id,task_id,run_id,tool,status,payload_json,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?)", ("act_unknown", task["id"], run["id"], "write", "started", "{}", _now(), None))
            decisions = RunLeaseService(store, 1).reconcile_expired(now + timedelta(seconds=2))
            self.assertEqual("waiting_user", decisions[0].kind)
            self.assertEqual("WaitingUser", store.get_task(task["id"])["status"])
            self.assertEqual("done", queue.get(item.id).status)
