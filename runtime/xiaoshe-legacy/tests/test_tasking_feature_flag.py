from __future__ import annotations

import os
import unittest
from unittest import mock

from harness import config, ui_server
from tests.ui_server.test_server import ServerCase


class TaskingModeTests(unittest.TestCase):
    def test_only_three_declared_modes_are_accepted(self):
        with mock.patch.dict(os.environ, {"XIAOSHE_TASKING_V2": "shadow"}):
            self.assertEqual("shadow", config.tasking_mode())
        with mock.patch.dict(os.environ, {"XIAOSHE_TASKING_V2": "wrong"}):
            with self.assertRaisesRegex(ValueError, "off"):
                config.tasking_mode()


class TaskingFeatureFlagTests(ServerCase):
    def test_off_does_not_open_or_create_tasking_database(self):
        self.assertEqual("off", self.sess.tasking_mode)
        self.assertIsNone(self.sess.task_api)
        self.assertFalse((self.state_dir / "tasking").exists())

    def test_shadow_keeps_old_routes_and_does_not_create_tasking_database(self):
        previous = os.environ.get("XIAOSHE_TASKING_V2")
        os.environ["XIAOSHE_TASKING_V2"] = "shadow"
        try:
            # 本例的 ServerCase 已在 setUp 完成，故显式建立一个独立 Session 验证启动行为。
            other = ui_server.UISession(dict(self.ctx), "shadow-session", [], self.state_dir / "shadow.jsonl", self.state_dir,
                                        model_fn=lambda *_args, **_kwargs: {"role": "assistant", "content": "ok"})
            self.assertEqual("shadow", other.tasking_mode)
            self.assertIsNone(other.task_api)
            self.assertFalse((self.state_dir / "tasking").exists())
        finally:
            if previous is None:
                os.environ.pop("XIAOSHE_TASKING_V2", None)
            else:
                os.environ["XIAOSHE_TASKING_V2"] = previous

    def test_store_failure_falls_back_to_old_session_without_deleting_data(self):
        previous = os.environ.get("XIAOSHE_TASKING_V2")
        os.environ["XIAOSHE_TASKING_V2"] = "on"
        try:
            with mock.patch("harness.task_store.TaskStore", side_effect=OSError("只读磁盘")):
                other = ui_server.UISession(dict(self.ctx), "failed-tasking", [], self.state_dir / "failed.jsonl", self.state_dir,
                                            model_fn=lambda *_args, **_kwargs: {"role": "assistant", "content": "ok"})
            self.assertIsNone(other.task_api)
            self.assertEqual("unavailable", other.tasking_diagnostic["store"])
            self.assertEqual("TASK_STORE_UNAVAILABLE", other.tasking_diagnostic["code"])
            self.assertEqual("OSError", other.tasking_diagnostic["reason"])
        finally:
            if previous is None:
                os.environ.pop("XIAOSHE_TASKING_V2", None)
            else:
                os.environ["XIAOSHE_TASKING_V2"] = previous


if __name__ == "__main__":
    unittest.main()
