"""P1 · schedule 尾账（#26 历史轮转 / #41 .stopped 按 pid 认领）。TDD 红→绿。

运行：仓库根 `python -m unittest discover -s tests -v`
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import schedule


class 执行历史轮转(unittest.TestCase):
    """#26：历史超上限锁内轮转，防长期运行的定时任务把 history.jsonl 撑到无限大。"""

    def test_历史超上限轮转_不无限增长且保留最近(self):
        d = tempfile.mkdtemp()
        with mock.patch.object(schedule, "HISTORY_DIR", Path(d)), \
             mock.patch.object(schedule, "_MAX_HISTORY_LINES", 10), \
             mock.patch.object(schedule, "_KEEP_HISTORY_LINES", 6):
            for i in range(15):
                schedule.append_history("t", {"i": i})
            lines = (Path(d) / "t.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertLessEqual(len(lines), 10)
        self.assertIn('"i": 14', lines[-1])  # 最近一条必须保留


class 停止标记按pid认领(unittest.TestCase):
    """#41：.stopped 带 child_pid，run_task 只认针对本次运行的停止标记，陈旧标记不毒化下一次。"""

    def test_stop标记pid匹配才算被停_陈旧标记清掉不毒化(self):
        d = tempfile.mkdtemp()
        with mock.patch.object(schedule, "RUNNING_DIR", Path(d)):
            (Path(d) / "t.stopped").write_text("999", encoding="utf-8")   # 针对 pid 999 的停止
            self.assertFalse(schedule._consume_stop_marker("t", 12345))   # 本次 12345，不匹配 → 不算被停
            self.assertFalse((Path(d) / "t.stopped").exists())            # 陈旧标记被清掉
            (Path(d) / "t.stopped").write_text("777", encoding="utf-8")
            self.assertTrue(schedule._consume_stop_marker("t", 777))      # 匹配 → 被停

    def test_没有标记时返回False(self):
        d = tempfile.mkdtemp()
        with mock.patch.object(schedule, "RUNNING_DIR", Path(d)):
            self.assertFalse(schedule._consume_stop_marker("t", 1))


if __name__ == "__main__":
    unittest.main()
