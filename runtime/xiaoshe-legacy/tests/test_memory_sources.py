import tempfile
import unittest
from pathlib import Path

from harness.memory_sources import MemorySourceResolver
from harness.task_model import CreateTask, TaskingError
from harness.task_store import TaskStore


class MemorySourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.temp.name) / "tasks.db")
        self.a = self.store.create_project("A", Path(self.temp.name) / "a")
        self.b = self.store.create_project("B", Path(self.temp.name) / "b")
        self.resolver = MemorySourceResolver(self.store)

    def tearDown(self):
        self.temp.cleanup()

    def test_cross_project_task_event_is_not_resolvable(self):
        task = self.store.create_task(CreateTask(self.b["id"], "B 任务", "目标", ()))
        ref = f"task_event:{task['id']}:1"
        with self.assertRaisesRegex(TaskingError, "TASK_MEMORY_SOURCE_NOT_FOUND"):
            self.resolver.resolve(self.a["id"], ref)

    def test_task_event_has_public_summary_not_payload_dump(self):
        task = self.store.create_task(CreateTask(self.a["id"], "A 任务", "目标", ()))
        source = self.resolver.resolve(self.a["id"], f"task_event:{task['id']}:1")
        self.assertEqual(("task_event", "deterministic_evidence", task["id"]),
                         (source.source_kind, source.trust, source.task_id))
        self.assertIn("task.created", source.excerpt)
        self.assertNotIn("acceptance", source.excerpt)

    def test_external_tool_output_is_always_untrusted(self):
        source = self.resolver.resolve(self.a["id"], "external:mcp:art_1")
        self.assertEqual("external_untrusted", source.trust)
        self.assertFalse(source.auto_approvable)

    def test_unknown_source_is_not_resolvable(self):
        with self.assertRaisesRegex(TaskingError, "TASK_MEMORY_SOURCE_NOT_FOUND"):
            self.resolver.resolve(self.a["id"], "task_event:tsk_missing:1")


if __name__ == "__main__":
    unittest.main()
