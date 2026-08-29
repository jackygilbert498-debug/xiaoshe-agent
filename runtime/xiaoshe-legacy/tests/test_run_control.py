import tempfile
import unittest
from pathlib import Path

from harness import agent
from harness.run_control import RunControl
from harness.task_engine import TaskEngine
from harness.task_model import CreateTask, RunContext, StartRun, TaskStatus, TaskingError
from harness.task_store import TaskStore


class RunControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.temp.name) / "tasks.db")
        project = self.store.create_project("repo", Path(self.temp.name) / "repo")
        self.engine = TaskEngine(self.store)
        task = self.engine.create_task(CreateTask(project["id"], "修复", "修复解析器", ("测试通过",)))
        ready = self.engine.transition(task["id"], TaskStatus.READY, task["version"], "user")
        self.task, self.run = self.engine.start_run(StartRun(ready["id"], ready["version"], "agent"))
        self.control = RunControl(self.store)

    def tearDown(self):
        self.temp.cleanup()

    def test_stop_is_idempotent_and_only_consumed_at_boundary(self):
        self.assertTrue(self.control.request_stop(self.run["id"], "user", self.task["version"]))
        self.assertFalse(self.control.request_stop(self.run["id"], "user", self.task["version"]))
        self.assertEqual("Running", self.store.get_run(self.run["id"])["status"])
        batch = self.control.drain_at_boundary(self.run["id"])
        self.assertTrue(batch.stop_requested)
        self.assertTrue(self.control.drain_at_boundary(self.run["id"]).stop_requested)
        self.assertEqual(1, sum(event["type"] == "run.stop_requested" for event in self.store.list_events(self.task["id"])))

    def test_queued_steer_is_fifo_exactly_once_and_not_task_status(self):
        first = self.control.queue_steer(self.run["id"], "先不要改配置", "user", self.task["version"])
        second = self.control.queue_steer(self.run["id"], "先跑测试", "user", self.task["version"])
        self.assertLess(first, second)
        self.assertEqual("Running", self.store.get_task(self.task["id"])["status"])
        self.assertEqual(2, self.control.queued_count(self.run["id"]))
        batch = self.control.drain_at_boundary(self.run["id"])
        self.assertEqual(["先不要改配置", "先跑测试"], [item.text for item in batch.inputs])
        self.assertEqual(0, self.control.queued_count(self.run["id"]))
        self.assertEqual((), self.control.drain_at_boundary(self.run["id"]).inputs)

    def test_stale_writer_and_ended_run_are_rejected(self):
        with self.assertRaisesRegex(TaskingError, "TASK_VERSION_CONFLICT"):
            self.control.queue_steer(self.run["id"], "继续", "user", 99)
        with self.store.transaction() as conn:
            conn.execute("UPDATE runs SET status='Stopped' WHERE id=?", (self.run["id"],))
        with self.assertRaisesRegex(TaskingError, "TASK_RUN_NOT_ACTIVE"):
            self.control.request_stop(self.run["id"], "user", self.task["version"])

    def test_agent_consumes_steer_and_stop_only_at_boundary(self):
        self.control.queue_steer(self.run["id"], "先跑测试", "user", self.task["version"])
        self.control.request_stop(self.run["id"], "user", self.task["version"])
        history = []
        events = []
        context = {"_run_control": self.control, "_task_engine": self.engine,
                   "_run_context": RunContext(self.task["id"], self.run["id"], None, None, {}, lambda kind, payload: events.append((kind, payload)))}
        stopped = agent._drain_run_control(context, history, Path(self.temp.name) / "agent.jsonl")
        self.assertTrue(stopped)
        self.assertEqual("[用户插话] 先跑测试", history[0]["content"])
        self.assertEqual("Stopped", self.store.get_run(self.run["id"])["status"])
        self.assertEqual("Review", self.store.get_task(self.task["id"])["status"])
        self.assertEqual(["run.steered", "run.stopped"], [kind for kind, _ in events])


if __name__ == "__main__":
    unittest.main()
