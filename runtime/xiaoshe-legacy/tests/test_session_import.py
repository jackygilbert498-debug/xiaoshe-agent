from __future__ import annotations

import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from harness.session_import import SessionImporter
from harness.task_engine import TaskEngine
from harness.task_store import TaskStore


class SessionImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.sessions = root / "sessions"; self.sessions.mkdir()
        self.store = TaskStore(root / "tasks.db")
        workspace = root / "workspace"; workspace.mkdir()
        self.project = self.store.create_project("项目", workspace)
        self.importer = SessionImporter(self.store, TaskEngine(self.store), self.sessions)

    def tearDown(self):
        self.tmp.cleanup()

    def write_raw_session(self, sid: str, data: bytes) -> Path:
        path = self.sessions / f"{sid}.json"
        path.write_bytes(data)
        return path

    def test_import_is_idempotent_and_does_not_rewrite_source(self):
        source = self.write_raw_session(
            "s1", '{"history":[{"role":"user","content":"  修复解析器  "}],"todos":[]}'.encode("utf-8")
        )
        before, mtime = source.read_bytes(), source.stat().st_mtime_ns
        a = self.importer.import_as_task("s1", self.project["id"])
        b = self.importer.import_as_task("s1", self.project["id"])
        self.assertEqual(a["id"], b["id"])
        self.assertEqual(before, source.read_bytes())
        self.assertEqual(mtime, source.stat().st_mtime_ns)
        self.assertEqual("Draft", a["status"])
        self.assertEqual([], list(self.store.acceptance_items(a)))

    def test_corrupt_session_returns_preview_error_without_task(self):
        self.write_raw_session("bad", b"{broken")
        preview = self.importer.preview("bad")
        self.assertEqual("SESSION_CORRUPT", preview["error"]["code"])
        self.assertEqual([], self.store.list_tasks({"legacy_session_id": "bad"}))

    def test_twenty_concurrent_imports_create_exactly_one_task(self):
        source = self.write_raw_session("same", '{"history":[{"role":"user","content":"并发导入"}],"todos":[]}'.encode("utf-8"))
        before = source.read_bytes(), source.stat().st_mtime_ns
        with ThreadPoolExecutor(max_workers=20) as pool:
            results = list(pool.map(lambda _: self.importer.import_as_task_with_result("same", self.project["id"]), range(20)))
        self.assertEqual(1, sum(created for _, created in results))
        self.assertEqual(1, len({task["id"] for task, _ in results}))
        self.assertEqual(before, (source.read_bytes(), source.stat().st_mtime_ns))


if __name__ == "__main__":
    unittest.main()
