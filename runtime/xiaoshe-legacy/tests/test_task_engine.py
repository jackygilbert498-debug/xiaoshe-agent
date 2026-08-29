import tempfile
import unittest
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from harness.task_engine import TaskEngine
from harness.task_model import CreateTask, FinishRun, RunStatus, StartRun, TaskStatus, TaskingError, UpdateTaskDefinition
from harness.task_store import TaskStore


class TaskEngineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.tmp.name) / "tasks.db")
        root = Path(self.tmp.name) / "repo"; root.mkdir()
        self.project = self.store.create_project("test", root)
        self.engine = TaskEngine(self.store)

    def tearDown(self): self.tmp.cleanup()

    def create(self, acceptance=("测试通过",)):
        return self.engine.create_task(CreateTask(self.project["id"], "修复", "修复问题", acceptance))

    def test_model_cannot_move_running_directly_to_succeeded(self):
        task = self.create()
        task = self.engine.transition(task["id"], TaskStatus.READY, task["version"], "user")
        task = self.engine.transition(task["id"], TaskStatus.RUNNING, task["version"], "user")
        with self.assertRaisesRegex(TaskingError, "TASK_TRANSITION_INVALID"):
            self.engine.transition(task["id"], TaskStatus.SUCCEEDED, task["version"], "model")
        self.assertEqual("Running", self.store.get_task(task["id"])["status"])

    def test_stale_writer_loses_without_event(self):
        task = self.create()
        changed = self.engine.transition(task["id"], TaskStatus.PLANNING, task["version"], "user")
        before = len(self.store.list_events(task["id"]))
        with self.assertRaisesRegex(TaskingError, "TASK_VERSION_CONFLICT"):
            self.engine.transition(task["id"], TaskStatus.CANCELLED, task["version"], "user")
        self.assertEqual(changed["version"], self.store.get_task(task["id"])["version"])
        self.assertEqual(before, len(self.store.list_events(task["id"])))

    def test_empty_acceptance_cannot_cross_execution_gate(self):
        task = self.create(())
        with self.assertRaisesRegex(TaskingError, "TASK_ACCEPTANCE_REQUIRED"):
            self.engine.transition(task["id"], TaskStatus.READY, task["version"], "user")
        self.assertEqual("Draft", self.store.get_task(task["id"])["status"])

    def test_start_run_is_atomic_and_increments_attempt(self):
        task = self.create()
        task = self.engine.transition(task["id"], TaskStatus.READY, task["version"], "user")
        changed, first = self.engine.start_run(StartRun(task["id"], task["version"], "user", workspace_id="ws_1"))
        self.assertEqual("Running", changed["status"])
        self.assertEqual(first["id"], changed["active_run_id"])
        self.assertEqual(1, first["attempt"])
        self.assertEqual("Running", self.store.get_run(first["id"])["status"])
        self.assertEqual(["task.created", "task.transitioned", "task.transitioned", "run.started"],
                         [event["type"] for event in self.store.list_events(task["id"])])
        with self.assertRaisesRegex(TaskingError, "TASK_TRANSITION_INVALID"):
            self.engine.start_run(StartRun(task["id"], changed["version"], "user"))

    def test_unattended_run_persists_validated_budget_snapshot(self):
        task = self.create()
        ready = self.engine.transition(task["id"], TaskStatus.READY, task["version"], "user")
        _running, run = self.engine.start_run(StartRun(ready["id"], ready["version"], "worker", policy_snapshot={
            "mode": "collaborate", "unattended": True, "policy_id": "policy_1",
            "budget": {"wall_seconds": 10, "model_tokens": 20, "cost_micros": 30,
                       "tool_calls": 2, "network_calls": 1, "repair_attempts": 1},
        }))
        policy = json.loads(run["policy_json"])
        self.assertTrue(policy["unattended"])
        self.assertEqual(2, policy["budget"]["tool_calls"])

    def test_finish_run_updates_run_and_task_once(self):
        task = self.create()
        ready = self.engine.transition(task["id"], TaskStatus.READY, task["version"], "user")
        running, run = self.engine.start_run(StartRun(task["id"], ready["version"], "user"))
        reviewed, ended = self.engine.finish_run(FinishRun(run["id"], running["version"], "agent", RunStatus.COMPLETED))
        self.assertEqual("Review", reviewed["status"])
        self.assertIsNone(reviewed["active_run_id"])
        self.assertEqual("Completed", ended["status"])
        self.assertIsNotNone(ended["ended_at"])
        with self.assertRaisesRegex(TaskingError, "TASK_RUN_NOT_ACTIVE"):
            self.engine.finish_run(FinishRun(run["id"], reviewed["version"], "agent", RunStatus.COMPLETED))

    def test_definition_change_is_draft_or_planning_only_and_does_not_log_old_text(self):
        task = self.create()
        updated = self.engine.update_task_definition(UpdateTaskDefinition(
            task["id"], task["version"], "req_1", title="新标题", acceptance=("可验收",)))
        self.assertEqual("新标题", updated["title"])
        self.assertEqual(("可验收",), self.store.acceptance_items(updated))
        event = self.store.list_events(task["id"])[-1]
        self.assertEqual("task.definition_updated", event["type"])
        self.assertNotIn("新标题", event["payload_json"])
        ready = self.engine.transition(task["id"], TaskStatus.READY, updated["version"], "user")
        with self.assertRaisesRegex(TaskingError, "TASK_TRANSITION_INVALID"):
            self.engine.update_task_definition(UpdateTaskDefinition(task["id"], ready["version"], "req_2", title="不能改"))

    def test_completion_requires_evidence_and_uses_the_verification_gate(self):
        task = self.create()
        ready = self.engine.transition(task["id"], TaskStatus.READY, task["version"], "user")
        running = self.engine.transition(ready["id"], TaskStatus.RUNNING, ready["version"], "user")
        review = self.engine.enter_review(running["id"], running["version"], "agent")
        verifying = self.engine.start_verification(review["id"], review["version"], "user")
        with self.assertRaisesRegex(TaskingError, "COMPLETION_PROOF_REQUIRED"):
            self.engine.complete_task(verifying["id"], verifying["version"], "user", "")
        from datetime import UTC, datetime, timedelta
        from harness.workspace_version import WorkspaceVersionService
        proof = self.store.issue_completion_proof(verifying["id"], "sha256:test", WorkspaceVersionService().current(Path(self.project["root"])), {"allowed": True}, (datetime.now(UTC)+timedelta(minutes=1)).isoformat().replace("+00:00","Z"))
        done = self.engine.complete_task(verifying["id"], verifying["version"], "user", proof["id"])
        self.assertEqual(TaskStatus.SUCCEEDED.value, done["status"])
        self.assertIn("completion_input_hash", self.store.list_events(done["id"])[-2]["payload_json"])

    def test_fifty_stale_writer_races_have_exactly_one_winner(self):
        for _ in range(50):
            task = self.create()
            def writer(target):
                try:
                    return self.engine.transition(task["id"], target, task["version"], "user")["status"]
                except TaskingError as exc:
                    return exc.code
            with ThreadPoolExecutor(max_workers=2) as pool:
                outcomes = list(pool.map(writer, (TaskStatus.PLANNING, TaskStatus.CANCELLED)))
            self.assertEqual(1, sum(value in {"Planning", "Cancelled"} for value in outcomes))
            self.assertEqual(1, sum(value == "TASK_VERSION_CONFLICT" for value in outcomes))
