"""可靠性 · :effects 看这次会话动了什么。TDD 红→绿。

effects 账本(写/改/跑命令/原生UI)早就记着，但一直没给用户看的入口。补上——配 :undo 成「看改动 + 撤改动」。
展示时对 target 折行中和（防命令/路径里的控制符做终端注入）。纯读账本、不联网。
运行：仓库根 `python -m unittest tests.test_effects_view -v`
"""
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from harness import effects


class recent取回(unittest.TestCase):
    def setUp(self):
        self._d = TemporaryDirectory()
        self.p = Path(self._d.name) / "effects.jsonl"
        self.addCleanup(self._d.cleanup)

    def _rec(self, tool, target, ok=True, session="s1"):
        effects.record_effect(tool, {"path": target} if tool in ("write_file", "edit") else {"command": target},
                              {"session_id": session}, ok=ok, path=self.p)

    def test_recent取末N条(self):
        for i in range(5):
            self._rec("write_file", f"f{i}.txt")
        r = effects.recent(3, path=self.p)
        self.assertEqual([x["target"] for x in r], ["f2.txt", "f3.txt", "f4.txt"])   # 末 3 条、时序

    def test_按session过滤(self):
        self._rec("write_file", "a.txt", session="s1")
        self._rec("write_file", "b.txt", session="s2")
        self._rec("edit", "c.txt", session="s1")
        r = effects.recent(10, session_id="s1", path=self.p)
        self.assertEqual([x["target"] for x in r], ["a.txt", "c.txt"])   # 只本会话

    def test_空账本返回空(self):
        self.assertEqual(effects.recent(10, path=self.p), [])


class effects命令(unittest.TestCase):
    def setUp(self):
        self._d = TemporaryDirectory()
        self.p = Path(self._d.name) / "effects.jsonl"
        self.addCleanup(self._d.cleanup)
        from harness import agent
        self.agent = agent
        self.out = []

    def _emit(self, s):
        self.out.append(str(s))

    def _text(self):
        return "\n".join(self.out)

    def _rec(self, tool, target, ok=True, session="sess-A"):
        effects.record_effect(tool, {"path": target} if tool in ("write_file", "edit") else {"command": target},
                              {"session_id": session}, ok=ok, path=self.p)

    def test_非命令不消费(self):
        self.assertFalse(self.agent._handle_effects_command("你好", out=self._emit, path=self.p, session_id="sess-A"))

    def test_effects展示本会话改动(self):
        self._rec("write_file", "报告.md", session="sess-A")
        self._rec("run_command", "npm install", session="sess-A")
        self._rec("write_file", "别的会话.txt", session="sess-B")
        self.assertTrue(self.agent._handle_effects_command(":effects", out=self._emit, path=self.p, session_id="sess-A"))
        txt = self._text()
        self.assertIn("报告.md", txt)
        self.assertIn("command", txt)
        self.assertNotIn("npm install", txt)  # 原始命令不进入 effects 账本或展示
        self.assertNotIn("别的会话.txt", txt)   # 默认只本会话

    def test_effects_all跨会话(self):
        self._rec("write_file", "会话A文件", session="sess-A")
        self._rec("write_file", "会话B文件", session="sess-B")
        self.agent._handle_effects_command(":effects all", out=self._emit, path=self.p, session_id="sess-A")
        txt = self._text()
        self.assertIn("会话A文件", txt)
        self.assertIn("会话B文件", txt)

    def test_失败动作有标记(self):
        self._rec("write_file", "写失败的.txt", ok=False, session="sess-A")
        self.agent._handle_effects_command(":effects", out=self._emit, path=self.p, session_id="sess-A")
        self.assertIn("写失败的.txt", self._text())

    def test_空账本友好提示(self):
        self.agent._handle_effects_command(":effects", out=self._emit, path=self.p, session_id="sess-A")
        self.assertIn("没", self._text())

    def test_target控制符中和防注入(self):
        # target 里塞换行/控制符 → 展示折行中和，不让它在终端伪造行
        effects.record_effect("run_command", {"command": "echo x\n伪造行\x1b[2J"},
                              {"session_id": "sess-A"}, ok=True, path=self.p)
        self.agent._handle_effects_command(":effects", out=self._emit, path=self.p, session_id="sess-A")
        txt = self._text()
        self.assertNotIn("\x1b", txt)
        # 命令被折成单行（换行没把"伪造行"顶成独立一行的行首）
        self.assertNotIn("\n伪造行", txt)


if __name__ == "__main__":
    unittest.main()
