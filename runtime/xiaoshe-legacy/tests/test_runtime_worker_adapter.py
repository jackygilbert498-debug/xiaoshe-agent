from __future__ import annotations

import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path

from harness.run_lease import RunLeaseService
from harness.task_engine import TaskEngine
from harness.task_model import CreateTask, EnqueueTask, ReviewPlan
from harness.task_queue import TaskQueue
from harness.task_store import TaskStore
from harness.task_triggers import ScheduleTrigger
from harness.task_worker import TaskWorker


class _Policy:
    def digest(self):
        return "sha256:" + "2" * 64


class _Session:
    def __init__(self, events):
        self.policy = _Policy()
        self.events = events

    def run(self, _value):
        raise AssertionError("shadow must not own worker execution")

    def close(self):
        self.events.append("runtime_close")


class _Factory:
    def __init__(self, events):
        self.events = events
        self.calls = []

    def create(self, identity, **facts):
        self.calls.append((identity, facts))
        return _Session(self.events)


class RuntimeWorkerAdapterTests(unittest.TestCase):
    @staticmethod
    def _approved_ready_task(store, project):
        engine = TaskEngine(store)
        task = engine.create_task(CreateTask(project["id"], "t", "g", ("proof",)))
        plan = engine.propose_plan(task["id"], {
            "objective": "g", "assumptions": [],
            "steps": [{
                "id": "work", "title": "work", "intent": "work",
                "files": ["README.md"], "validation": ["proof"],
                "risk": "low", "depends_on": [],
            }],
            "acceptance_mapping": {"proof": ["work"]},
            "estimated_budget": {},
        }, "agent", task["version"])
        engine.review_plan(ReviewPlan(
            task["id"], plan["revision"], "approve", "ok",
            store.get_task(task["id"])["version"], "user",
        ))
        return store.get_task(task["id"])

    @staticmethod
    def _isolated_workspace(store, task, project, root):
        root.mkdir(exist_ok=True)
        reserved = store.reserve_workspace(
            task["id"], project["id"], "isolated", {"kind": "test"},
        )
        return store.activate_workspace(reserved["id"], root, "test:1")

    def test_worker_closes_runtime_before_releasing_workspace_lease(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "repo"
            store = TaskStore(Path(temp) / "tasks.sqlite")
            project = store.create_project("p", root)
            task = self._approved_ready_task(store, project)
            self._isolated_workspace(store, task, project, root)
            now = datetime(2026, 8, 15, tzinfo=UTC)
            queue = TaskQueue(store)
            queue.enqueue(EnqueueTask(
                task["id"], "manual", "request:runtime-close", 0,
                now, "policy-1", task["version"],
            ))
            leases = RunLeaseService(store)
            claim = leases.claim_next("worker", now)
            events = []
            factory = _Factory(events)
            worker = TaskWorker(
                store, leases, worker_id="worker",
                runner=lambda _ctx: events.append("legacy_runner"),
                runtime_factory=factory,
            )
            original_release = worker.worktrees.release_lease

            def release(*args, **kwargs):
                events.append("workspace_release")
                return original_release(*args, **kwargs)

            worker.worktrees.release_lease = release
            outcome = worker.run_one(claim)
            self.assertEqual("review", outcome.kind)
            self.assertEqual(["legacy_runner", "runtime_close", "workspace_release"], events)
            identity, facts = factory.calls[0]
            self.assertEqual("worker", identity.entrypoint)
            self.assertEqual(task["id"], identity.task_id)
            self.assertEqual(task["id"], facts["task"]["id"])

    def test_same_schedule_nominal_time_is_one_durable_queue_item(self):
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStore(Path(temp) / "tasks.sqlite")
            project = store.create_project("p", Path(temp))
            task = self._approved_ready_task(store, project)
            queue = TaskQueue(store)
            trigger = ScheduleTrigger(queue)
            nominal = datetime(2026, 8, 15, 9, tzinfo=UTC)
            first = trigger.fire(task, "daily", nominal, "policy-1")
            second = trigger.fire(task, "daily", nominal, "policy-1")
            self.assertEqual(first.queue_item_id, second.queue_item_id)
            self.assertEqual(
                [first.queue_item_id],
                [item.id for item in queue.list_ready(nominal)],
            )


if __name__ == "__main__":
    unittest.main()
