import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

from harness.memory_conflicts import MemoryConflictService
from harness.project_memory import ProjectMemoryStore
from harness.task_model import CreateMemoryCandidate, MemoryKind, TaskingError
from harness.task_store import TaskStore


class MemoryConflictTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.temp.name) / "tasks.db")
        self.a = self.store.create_project("A", Path(self.temp.name) / "a")
        self.b = self.store.create_project("B", Path(self.temp.name) / "b")
        self.memory = ProjectMemoryStore(self.store)
        self.conflicts = MemoryConflictService(self.store, self.memory)

    def tearDown(self):
        self.temp.cleanup()

    def approved(self, text, *, project=None, review_after=None):
        project = project or self.a
        candidate = self.memory.create(CreateMemoryCandidate(project["id"], MemoryKind.COMMAND, text,
            "user:req_memory_conflict", "user_direct", 1.0, review_after=review_after))
        return self.memory.approve(project["id"], candidate.id, candidate.version, "user")

    def test_superseded_record_is_not_injected_but_remains_auditable(self):
        old = self.approved("测试命令是 pytest")
        new = self.approved("测试命令是 py -m unittest")
        self.conflicts.supersede(self.a["id"], old.id, new.id, "user")
        current = self.memory.get(self.a["id"], old.id)
        self.assertEqual("superseded", current.status)
        self.assertEqual(old.text, current.text)
        self.assertEqual([new.id], [record.id for record in self.memory.injectable(self.a["id"])])

    def test_expiry_stops_injection_without_deleting(self):
        item = self.approved("临时迁移窗口", review_after=datetime.now(UTC) - timedelta(seconds=1))
        expired = self.conflicts.expire_due(datetime.now(UTC))
        self.assertEqual([item.id], [record.id for record in expired])
        current = self.memory.get(self.a["id"], item.id)
        self.assertEqual(("expired", "临时迁移窗口"), (current.status, current.text))
        self.assertEqual([], self.memory.injectable(self.a["id"]))

    def test_duplicate_is_reported_but_not_automatically_superseded(self):
        old = self.approved("运行单元测试")
        new = self.approved("运行单元测试")
        conflicts = self.conflicts.find(self.a["id"], new)
        self.assertEqual([("duplicate", old.id, new.id)], [(item.kind, item.existing_id, item.candidate_id) for item in conflicts])
        self.assertEqual("approved", self.memory.get(self.a["id"], old.id).status)

    def test_cross_project_supersede_is_rejected(self):
        old = self.approved("A", project=self.a)
        foreign = self.approved("B", project=self.b)
        with self.assertRaisesRegex(TaskingError, "TASK_MEMORY_NOT_FOUND"):
            self.conflicts.supersede(self.a["id"], old.id, foreign.id, "user")


if __name__ == "__main__":
    unittest.main()
