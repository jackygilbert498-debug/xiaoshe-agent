"""Task 关联是会话档案的可选元数据，绝不破坏旧档案读取。"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import session


class TaskSessionMetadataTests(unittest.TestCase):
    def test_old_session_gets_none_metadata_without_rewrite(self):
        with tempfile.TemporaryDirectory() as td, mock.patch.object(session, "SESSIONS_DIR", Path(td)):
            path = Path(td) / "old.json"
            original = '{"id":"old","history":[],"todos":[]}'
            path.write_text(original, encoding="utf-8")
            loaded = session.load_session("old")
            self.assertIsNone(loaded["task_id"])
            self.assertIsNone(loaded["run_id"])
            self.assertEqual(original, path.read_text(encoding="utf-8"))

    def test_new_session_persists_optional_task_metadata(self):
        with tempfile.TemporaryDirectory() as td, mock.patch.object(session, "SESSIONS_DIR", Path(td)):
            session.save_session("new", [], [], task_id="tsk_1", run_id="run_1")
            loaded = session.load_session("new")
            self.assertEqual("tsk_1", loaded["task_id"])
            self.assertEqual("run_1", loaded["run_id"])


if __name__ == "__main__":
    unittest.main()
