"""P0 · 无头模式 ctx 必须带 session_id（交互 repl 早已注入，无头漏了）。

后续 notes/episodic 等按 session_id 落盘的特性，在无头场景会因 ctx 缺 session_id
而静默失效（写到 None/失败）。这里锁死："无头建的 ctx 里带的 session_id = 本次真正用的那个"。

运行：仓库根 `python -m unittest discover -s tests -v`
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import headless
from harness.kimi_client import KimiError


class 无头ctx带session_id(unittest.TestCase):
    def test_run_headless给ctx注入与本次一致的session_id(self):
        captured = {}

        def fake_run_once(prompt, history, **kw):
            captured["ctx"] = kw.get("ctx")
            raise KimiError("在此中断，只为拿到 ctx，跳过存档")

        with mock.patch.object(headless.session, "new_session_id", return_value="headless-FIXED123"), \
             mock.patch.object(headless.session, "session_log_file",
                               return_value=Path(tempfile.mkdtemp()) / "l.jsonl"), \
             mock.patch.object(headless.agent, "run_once", side_effect=fake_run_once):
            rc = headless.run_headless("随便一句", no_mcp=True)

        self.assertEqual(rc, 1)  # KimiError → 退出码 1
        self.assertIsNotNone(captured.get("ctx"), "run_once 应拿到 ctx")
        self.assertEqual(captured["ctx"].get("session_id"), "headless-FIXED123",
                         "无头 ctx 必须带本次 session_id，否则 notes/episodic 静默失效")


class 无头装载自定义工具(unittest.TestCase):
    """B.3 接线：无头/定时任务也走 load_user_tools——否则已批准的自定义工具在无头场景装载不了、用不上。"""

    def test_run_headless会装载自定义工具(self):
        called = {"n": 0}

        def fake_load(*a, **kw):
            called["n"] += 1
            return (2, [])

        def fake_run_once(prompt, history, **kw):
            raise KimiError("在此中断，只为验证装载被调用")

        with mock.patch.object(headless.tools_mod, "load_user_tools", side_effect=fake_load), \
             mock.patch.object(headless.tools_mod, "unload_user_tools") as m_unload, \
             mock.patch.object(headless.session, "new_session_id", return_value="headless-X"), \
             mock.patch.object(headless.session, "session_log_file",
                               return_value=Path(tempfile.mkdtemp()) / "l.jsonl"), \
             mock.patch.object(headless.agent, "run_once", side_effect=fake_run_once):
            headless.run_headless("随便", no_mcp=True)

        self.assertEqual(called["n"], 1, "无头必须装载自定义工具")
        m_unload.assert_called()          # 独占进程收尾时卸载，别把免问集泄给下一个进程内调用


if __name__ == "__main__":
    unittest.main()
