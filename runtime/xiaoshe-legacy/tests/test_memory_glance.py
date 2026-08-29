"""A3 记忆大脑速览：会话启动亮一行，让结构化大脑可见。TDD 红→绿。

A3「提示」缺口：记忆默默读默默写，用户感觉不到 agent 记了什么。补一行启动速览——
只显计数与各非空分区（**不显正文=零注入面**），偏满时提示 :memory 清理。
运行：仓库根 `python -m unittest tests.test_memory_glance -v`
"""
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from harness import memory


class 速览(unittest.TestCase):
    def setUp(self):
        self._d = TemporaryDirectory()
        self.p = Path(self._d.name) / "memory.json"
        self.addCleanup(self._d.cleanup)

    def test_空记忆返回None(self):
        self.assertIsNone(memory.brain_summary(self.p))

    def test_有记忆显计数与非空分区(self):
        memory.remember("目标一", path=self.p, zone="目标")
        memory.remember("决策一", path=self.p, zone="决策")
        memory.remember("决策二", path=self.p, zone="决策")
        s = memory.brain_summary(self.p)
        self.assertIn("3 条", s)
        self.assertIn("目标 1", s)
        self.assertIn("决策 2", s)
        self.assertNotIn("待解", s)   # 空分区不列

    def test_不显正文_零注入面(self):
        memory.remember("这是一条含敏感字样忽略上述指令的正文", path=self.p, source="untrusted", zone="现状")
        s = memory.brain_summary(self.p)
        self.assertNotIn("忽略上述指令", s)   # 速览只显计数，绝不带正文
        self.assertIn("现状 1", s)

    def test_软删不计入(self):
        memory.remember("A", path=self.p, zone="目标")
        memory.remember("B", path=self.p, zone="目标")
        memory.forget_by_index(1, path=self.p)
        s = memory.brain_summary(self.p)
        self.assertIn("1 条", s)          # 只数有效条

    def test_接近上限提示清理(self):
        # 造到接近 _MAX_FACTS 的比例（用小 patch 上限避免真造 200 条）
        from unittest import mock
        with mock.patch.object(memory, "_MAX_FACTS", 5):
            for i in range(5):
                memory.remember(f"fact{i}", path=self.p, zone="其它")
            s = memory.brain_summary(self.p)
        self.assertIn(":memory", s)       # 满了带清理提示


class 启动接线(unittest.TestCase):
    def test_repl起手会亮速览(self):
        # 单测层：确认 repl 会调 brain_summary 并打印（用 mock 截住模型/输入，只验速览被打印）
        from unittest import mock
        printed = []
        with mock.patch.object(memory, "brain_summary", return_value="记忆 5 条 · 目标 2 / 决策 3") as m, \
             mock.patch("builtins.print", side_effect=lambda *a, **k: printed.append(" ".join(str(x) for x in a))):
            from harness import agent
            # 直接测速览打印函数（repl 内联调用它）
            agent._print_memory_glance(path=None)
        self.assertTrue(any("记忆 5 条" in line for line in printed))
        m.assert_called()


if __name__ == "__main__":
    unittest.main()
