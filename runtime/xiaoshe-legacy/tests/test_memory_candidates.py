import tempfile
import unittest
from pathlib import Path

from harness.memory_candidates import MemoryCandidateExtractor
from harness.task_model import CreateTask
from harness.task_store import TaskStore


class MemoryCandidateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.temp.name) / "tasks.db")
        self.project = self.store.create_project("P", Path(self.temp.name) / "repo")
        self.extractor = MemoryCandidateExtractor(self.store)

    def tearDown(self):
        self.temp.cleanup()

    def task(self, status):
        task = self.store.create_task(CreateTask(self.project["id"], "任务", "目标", ("运行单元测试",)))
        if status != "Draft":
            task = self.store.transition_task(task["id"], task["version"], status, "test")
        return task

    def test_only_succeeded_task_can_generate_candidates(self):
        for status in ("Draft", "Running", "Failed", "Cancelled"):
            with self.subTest(status=status):
                self.assertEqual([], self.extractor.extract(self.task(status)["id"]))

    def test_succeeded_task_creates_candidate_not_approved_memory(self):
        task = self.task("Succeeded")
        # A direct historical transition lacks task.completed evidence and must not
        # invent a source; append the public completion event the normal engine writes.
        with self.store.transaction() as conn:
            self.store._append(conn, task["id"], "task.completed", {"actor": "user", "proof_id": "cpf_test"})
        candidates = self.extractor.extract(task["id"])
        self.assertEqual(1, len(candidates))
        self.assertEqual("candidate", candidates[0].status)
        self.assertEqual([], self.extractor.memory.injectable(self.project["id"]))
        self.assertEqual([], self.extractor.extract(task["id"]))
        self.assertEqual(1, len(self.extractor.memory.list(self.project["id"])))


if __name__ == "__main__":
    unittest.main()
