from __future__ import annotations

import tempfile
import unittest
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock

from harness.run_lease import RunLeaseService
from harness.task_engine import TaskEngine
from harness.task_model import CreateTask, EnqueueTask, FinishRun, ReviewPlan, RunStatus
from harness.task_queue import TaskQueue
from harness.task_store import TaskStore
from harness.task_worker import TaskWorker
from harness import config
from harness.ui_server import UISession
from harness import agent
from harness.task_model import RunContext


class TaskWorkerTests(unittest.TestCase):
    @staticmethod
    def _approved_ready_task(store, project):
        engine = TaskEngine(store)
        task = engine.create_task(CreateTask(project["id"], "t", "g", ("proof",)))
        plan = engine.propose_plan(task["id"], {
            "objective": "g", "assumptions": [],
            "steps": [{"id": "work", "title": "work", "intent": "work", "files": ["README.md"],
                       "validation": ["proof"], "risk": "low", "depends_on": []}],
            "acceptance_mapping": {"proof": ["work"]}, "estimated_budget": {},
        }, "agent", task["version"])
        engine.review_plan(ReviewPlan(task["id"], plan["revision"], "approve", "ok",
                                      store.get_task(task["id"])["version"], "user"))
        return store.get_task(task["id"]), engine

    @staticmethod
    def _isolated_workspace(store, task, project, root):
        root.mkdir(exist_ok=True)
        reserved = store.reserve_workspace(task["id"], project["id"], "isolated", {"kind": "test"})
        return store.activate_workspace(reserved["id"], root, "test:1")

    def test_missing_approved_plan_is_not_executed(self):
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStore(Path(temp) / "tasks.sqlite"); project = store.create_project("p", Path(temp))
            task = store.create_task(CreateTask(project["id"], "t", "g", ("proof",)))
            ready = store.transition_task(task["id"], task["version"], "Ready", "test")
            now = datetime(2026, 8, 4, tzinfo=UTC); queue = TaskQueue(store)
            queue.enqueue(EnqueueTask(ready["id"], "manual", "request:worker", 0, now, "p1", ready["version"]))
            leases = RunLeaseService(store); claim = leases.claim_next("w", now)
            called = []
            outcome = TaskWorker(store, leases, worker_id="w", runner=lambda _context: called.append(True)).run_one(claim)
            self.assertEqual("precondition_failed", outcome.kind)
            self.assertEqual([], called)
            self.assertEqual("failed", queue.get(claim.item.id).status)

    def test_serve_rejects_non_positive_poll_interval(self):
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStore(Path(temp) / "tasks.sqlite")
            with self.assertRaisesRegex(ValueError, "WORKER_POLL_INTERVAL_INVALID"):
                TaskWorker(store, RunLeaseService(store)).serve(threading.Event(), 0)

    def test_successful_runner_enters_review_and_releases_workspace_lease(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "repo"; store = TaskStore(Path(temp) / "tasks.sqlite")
            project = store.create_project("p", root); task, _engine = self._approved_ready_task(store, project)
            workspace = self._isolated_workspace(store, task, project, root)
            now = datetime(2026, 8, 4, tzinfo=UTC); queue = TaskQueue(store)
            item = queue.enqueue(EnqueueTask(task["id"], "manual", "request:success", 0, now, "p1", task["version"]))
            leases = RunLeaseService(store); claim = leases.claim_next("w", now); contexts = []
            outcome = TaskWorker(store, leases, worker_id="w", runner=contexts.append).run_one(claim)
            self.assertEqual("review", outcome.kind)
            self.assertEqual("Review", store.get_task(task["id"])["status"])
            self.assertEqual("done", queue.get(item.id).status)
            self.assertEqual(1, len(contexts))
            self.assertEqual("ready", store.get_workspace(workspace["id"])["status"])

    def test_runner_that_consumes_stop_is_not_overwritten_as_completed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "repo"; store = TaskStore(Path(temp) / "tasks.sqlite")
            project = store.create_project("p", root); task, engine = self._approved_ready_task(store, project)
            self._isolated_workspace(store, task, project, root)
            now = datetime(2026, 8, 4, tzinfo=UTC); queue = TaskQueue(store)
            queue.enqueue(EnqueueTask(task["id"], "manual", "request:stop", 0, now, "p1", task["version"]))
            leases = RunLeaseService(store); claim = leases.claim_next("w", now)
            def stop_runner(context):
                current = store.get_task(context.task_id)
                engine.finish_run(FinishRun(context.run_id, current["version"], "user", RunStatus.STOPPED))
            outcome = TaskWorker(store, leases, worker_id="w", runner=stop_runner).run_one(claim)
            self.assertEqual("stopped", outcome.kind)
            self.assertEqual("Stopped", store.get_run(outcome.run_id)["status"])
            self.assertEqual("Review", store.get_task(task["id"])["status"])

    def test_runtime_events_are_persisted_before_the_optional_broadcast(self):
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStore(Path(temp) / "tasks.sqlite"); project = store.create_project("p", Path(temp))
            task, _engine = self._approved_ready_task(store, project); self._isolated_workspace(store, task, project, Path(temp) / "repo")
            now = datetime(2026, 8, 4, tzinfo=UTC); queue = TaskQueue(store)
            queue.enqueue(EnqueueTask(task["id"], "manual", "request:events", 0, now, "p1", task["version"]))
            claim = RunLeaseService(store).claim_next("w", now); broadcasts = []
            worker = TaskWorker(store, RunLeaseService(store), worker_id="w", runner=lambda context: context.emit_event("action.started", {"task_id": context.task_id, "run_id": context.run_id, "action_id": "act_1", "tool": "read_file"}), event_sink=lambda type_, payload: broadcasts.append((type_, payload)))
            worker.run_one(claim)
            self.assertIn("action.started", [event["type"] for event in store.list_events(task["id"])])
            self.assertEqual("action.started", broadcasts[0][0])

    def test_wall_budget_expiry_stops_the_run_without_marking_task_failed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "repo"; store = TaskStore(Path(temp) / "tasks.sqlite")
            project = store.create_project("p", root); task, _engine = self._approved_ready_task(store, project)
            self._isolated_workspace(store, task, project, root)
            now = datetime(2026, 8, 4, tzinfo=UTC); queue = TaskQueue(store)
            queue.enqueue(EnqueueTask(task["id"], "manual", "request:deadline", 0, now, "p1", task["version"]))
            claim = RunLeaseService(store).claim_next("w", now)
            outcome = TaskWorker(store, RunLeaseService(store), worker_id="w", runner=lambda _context: (_ for _ in ()).throw(RuntimeError("BUDGET_WALL_CLOCK_EXCEEDED"))).run_one(claim)
            self.assertEqual("stopped", outcome.kind)
            self.assertEqual("Stopped", store.get_run(outcome.run_id)["status"])
            self.assertEqual("Review", store.get_task(task["id"])["status"])

    def test_task_run_cannot_spawn_a_parallel_legacy_job(self):
        context = RunContext("tsk_background", "run_background", None, None, {})
        text, is_error, executed = agent._run_tool("run_in_background", {"command": "echo never"},
                                                    {"_run_context": context}, lambda *_args: True,
                                                    Path(tempfile.gettempdir()) / "task-worker.log")
        self.assertTrue(is_error); self.assertFalse(executed)
        self.assertIn("TaskQueue", text)

    def test_serve_worker_claims_a_ready_task_and_routes_clean_agent_result_to_review(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(config, "tasking_mode", return_value="on"):
            base = Path(temp); state = base / "state"; state.mkdir()
            ctx = {"todos": [], "memory_file": base / "memory.md", "session_id": "test-worker"}
            ui = UISession(ctx, "test-worker", [], base / "worker.jsonl", state,
                           model_fn=lambda _messages, tools=None: {"content": "完成", "tool_calls": []})
            try:
                self.assertIsNotNone(ui.task_api)
                root = base / "repo"; project = ui.task_api.store.create_project("p", root)
                task, _engine = self._approved_ready_task(ui.task_api.store, project)
                self._isolated_workspace(ui.task_api.store, task, project, root)
                now = datetime.now(UTC); TaskQueue(ui.task_api.store).enqueue(
                    EnqueueTask(task["id"], "manual", "request:serve", 0, now, "p1", task["version"]))
                ui.start_task_worker()
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline and ui.task_api.store.get_task(task["id"])["status"] != "Review":
                    time.sleep(0.05)
                self.assertEqual("Review", ui.task_api.store.get_task(task["id"])["status"])
            finally:
                ui.stop_task_worker()
