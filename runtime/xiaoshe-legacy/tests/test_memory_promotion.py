import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from harness import memory, notes
from harness.memory_promotion import MemoryPromotionService
from harness.project_memory import ProjectMemoryStore
from harness.task_model import TaskingError
from harness.task_store import TaskStore


class MemoryPromotionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.temp.name) / "tasks.db")
        self.project = self.store.create_project("p", Path(self.temp.name) / "project")
        self.legacy_path = Path(self.temp.name) / "memory.json"
        self.service = MemoryPromotionService(self.store, ProjectMemoryStore(self.store), self.legacy_path)

    def tearDown(self):
        self.temp.cleanup()

    def test_note_is_deleted_only_after_candidate_is_durable_and_retry_is_idempotent(self):
        ctx = {}
        notes.add(ctx, "测试前先运行自检")
        note = notes.records(ctx)[0]
        with patch.object(self.service.project_memory, "create", side_effect=RuntimeError("injected failure")):
            with self.assertRaisesRegex(RuntimeError, "injected failure"):
                self.service.promote_note(ctx, note.id, self.project["id"], "user")
        self.assertEqual([note.text], notes.current(ctx))
        first = self.service.promote_note(ctx, note.id, self.project["id"], "user")
        self.assertEqual([], notes.current(ctx))
        self.assertEqual("candidate", first.status)
        # 候选已落库但源删除前中断的重试，不会再创建第二条候选。
        retry_ctx = {}
        notes.add(retry_ctx, note.text)
        second = self.service.promote_note(retry_ctx, notes.records(retry_ctx)[0].id, self.project["id"], "user")
        self.assertEqual(first.id, second.id)
        self.assertEqual(1, len(self.service.project_memory.list(self.project["id"])))

    def test_legacy_import_is_read_only_and_candidates_are_idempotent(self):
        self.assertTrue(memory.remember("项目使用 unittest", self.legacy_path, source="legacy"))
        before = self.legacy_path.read_bytes()
        preview = self.service.preview_legacy_import()
        self.assertEqual(1, len(preview))
        first = self.service.import_selected(self.project["id"], [preview[0].id], "user")
        second = self.service.import_selected(self.project["id"], [preview[0].id], "user")
        self.assertEqual([first[0].id], [second[0].id])
        self.assertEqual(before, self.legacy_path.read_bytes())
        self.assertEqual("legacy_unknown", first[0].source_trust)

    def test_remove_record_requires_current_slot_and_exact_hash(self):
        ctx = {}
        notes.add(ctx, "A")
        record = notes.records(ctx)[0]
        self.assertFalse(notes.remove_record(ctx, record.id, "0" * 64))
        self.assertEqual(["A"], notes.current(ctx))
        self.assertTrue(notes.remove_record(ctx, record.id, record.content_hash))
        self.assertEqual([], notes.current(ctx))

    def test_import_rejects_unknown_selected_id(self):
        with self.assertRaisesRegex(TaskingError, "TASK_MEMORY_LEGACY_NOT_FOUND"):
            self.service.import_selected(self.project["id"], ["legacy_missing"], "user")


if __name__ == "__main__":
    unittest.main()
