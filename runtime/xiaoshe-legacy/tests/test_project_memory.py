import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

from harness.project_memory import ProjectMemoryStore
from harness.task_model import CreateMemoryCandidate, MemoryKind, MemoryStatus, TaskingError
from harness.task_store import TaskStore


class ProjectMemoryStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.temp.name) / "tasks.db")
        self.a = self.store.create_project("A", Path(self.temp.name) / "a")
        self.b = self.store.create_project("B", Path(self.temp.name) / "b")
        self.memory = ProjectMemoryStore(self.store)

    def tearDown(self):
        self.temp.cleanup()

    def create(self, project_id, text, *, request_id=None):
        return self.memory.create(CreateMemoryCandidate(
            project_id, MemoryKind.CONVENTION, text, "user:req_memory_test", "user_direct", 1.0,
            created_by="user", request_id=request_id,
        ))

    def test_default_list_never_crosses_project(self):
        left = self.create(self.a["id"], "使用 unittest")
        right = self.create(self.b["id"], "使用 pytest")
        self.memory.approve(self.a["id"], left.id, left.version, "user")
        self.memory.approve(self.b["id"], right.id, right.version, "user")
        self.assertEqual([left.id], [record.id for record in self.memory.list(self.a["id"], MemoryStatus.APPROVED)])
        with self.assertRaisesRegex(TaskingError, "TASK_MEMORY_NOT_FOUND"):
            self.memory.get(self.a["id"], right.id)

    def test_candidate_is_not_in_injectable_records(self):
        candidate = self.create(self.a["id"], "部署前运行测试")
        self.assertEqual("candidate", candidate.status)
        self.assertEqual([], self.memory.injectable(self.a["id"]))
        approved = self.memory.approve(self.a["id"], candidate.id, candidate.version, "user")
        self.assertEqual([approved.id], [record.id for record in self.memory.injectable(self.a["id"])])

    def test_source_shape_and_text_limit_are_rejected(self):
        with self.assertRaisesRegex(TaskingError, "TASK_MEMORY_SOURCE_REQUIRED"):
            self.memory.create(CreateMemoryCandidate(
                self.a["id"], MemoryKind.FACT, "x", "not-a-source", "user_direct", 1.0,
            ))
        with self.assertRaisesRegex(ValueError, "4000"):
            CreateMemoryCandidate(self.a["id"], MemoryKind.FACT, "x" * 4001,
                                  "user:req_memory_test", "user_direct", 1.0)

    def test_request_id_is_idempotent_and_review_events_are_auditable(self):
        request_id = "req_" + "a" * 32
        first = self.create(self.a["id"], "测试命令固定", request_id=request_id)
        second = self.create(self.a["id"], "测试命令固定", request_id=request_id)
        self.assertEqual(first.id, second.id)
        approved = self.memory.approve(self.a["id"], first.id, first.version, "user")
        self.assertEqual("approved", approved.status)
        self.assertEqual(["memory.candidate", "memory.approved"],
                         [event["type"] for event in self.store.memory_events(first.id)])

    def test_candidate_carries_review_time_without_becoming_injectable(self):
        candidate = self.memory.create(CreateMemoryCandidate(
            self.a["id"], MemoryKind.PITFALL, "临时迁移窗口", "user:req_memory_test", "user_direct", 0.9,
            review_after=datetime.now(UTC) + timedelta(days=1),
        ))
        self.assertIsNotNone(candidate.review_after)
        self.assertEqual([], self.memory.injectable(self.a["id"]))


if __name__ == "__main__":
    unittest.main()
