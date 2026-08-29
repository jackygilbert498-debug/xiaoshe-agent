"""§6.1 · effects 账本 irreversible 标记 + 三态口径（可撤 / 未快照不可撤 / 本质不可逆）。TDD 红→绿。

判定抽纯函数 judge_irreversible：文件写标可逆；命令默认不可逆（undo 只覆盖文件，够不到命令副作用），
删除/破坏命令形态与发外部请求单列原因；原生UI动作不可逆。:effects 视图对不可逆项显著标记。
运行：仓库根 `py -3 -m unittest tests.test_effects_irreversible -v`
"""
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from harness import effects


class 不可逆判定纯函数(unittest.TestCase):
    def test_文件写标可逆(self):
        for t in ("write_file", "edit"):
            self.assertEqual(effects.judge_irreversible(t, {"path": "a.py"}), (False, ""))

    def test_命令默认不可逆(self):
        # run_command 的副作用 undo 够不到——默认标不可逆（宁可保守，不装能撤）
        ir, why = effects.judge_irreversible("run_command", {"command": "git status"})
        self.assertTrue(ir)
        self.assertIn("不可逆", why)

    def test_破坏命令形态单列原因(self):
        for cmd in ("rm -rf build", "rm -f x.log", "del /f /q a.txt", "rmdir /s /q dist",
                    "git reset --hard HEAD~1", "git clean -fd", "Remove-Item -Recurse -Force foo"):
            ir, why = effects.judge_irreversible("run_command", {"command": cmd})
            self.assertTrue(ir, msg=cmd)
            self.assertIn("破坏", why, msg=cmd)

    def test_发外部请求单列原因(self):
        for cmd in ("curl -X POST https://api.example.com/x", "git push origin main",
                    "Invoke-RestMethod -Uri http://x -Method Post", "scp a.txt user@h:/tmp"):
            ir, why = effects.judge_irreversible("run_command", {"command": cmd})
            self.assertTrue(ir, msg=cmd)
            self.assertIn("外部请求", why, msg=cmd)

    def test_后台命令同样不可逆(self):
        ir, _ = effects.judge_irreversible("run_in_background", {"command": "echo hi"})
        self.assertTrue(ir)

    def test_原生UI动作不可逆(self):
        for t in ("click", "click_at", "pick", "press_keys", "type_text", "focus_window"):
            ir, why = effects.judge_irreversible(t, {})
            self.assertTrue(ir, msg=t)
            self.assertIn("UI", why, msg=t)

    def test_文件类副作用标可逆(self):
        # screenshot/save_skill 本质是新建文件，可逆（删掉即还原），只是不在 undo 栈覆盖内
        for t in ("screenshot", "save_skill"):
            ir, _ = effects.judge_irreversible(t, {"path": "x.png"})
            self.assertFalse(ir, msg=t)

    def test_非字符串命令不崩(self):
        ir, why = effects.judge_irreversible("run_command", {})
        self.assertTrue(ir)
        self.assertIn("不可逆", why)


class 账本三态(unittest.TestCase):
    def setUp(self):
        self._d = TemporaryDirectory()
        self.p = Path(self._d.name) / "e.jsonl"
        self.addCleanup(self._d.cleanup)

    def test_命令落账带不可逆标记(self):
        effects.record_effect("run_command", {"command": "rm -rf x"}, {}, path=self.p)
        rec = effects.load(self.p)[0]
        self.assertTrue(rec["irreversible"])
        self.assertIn("破坏", rec["irrev_why"])
        self.assertNotIn("undoable", rec)   # 非文件工具不谈 undoable（不适用 ≠ 不可撤）

    def test_可撤文件改动_undoable为true(self):
        effects.record_effect("write_file", {"path": "a.txt"}, {}, undoable=True, path=self.p)
        rec = effects.load(self.p)[0]
        self.assertFalse(rec["irreversible"])
        self.assertTrue(rec["undoable"])

    def test_未快照不可撤_带原因(self):
        effects.record_effect("write_file", {"path": "big.bin"}, {},
                              undoable=False, snapshot_skip="too_big", path=self.p)
        rec = effects.load(self.p)[0]
        self.assertFalse(rec["irreversible"])        # 本质可逆，只是这次没快照
        self.assertFalse(rec["undoable"])
        self.assertEqual(rec["snapshot_skip"], "too_big")

    def test_旧格式条目无新字段不崩(self):
        self.p.write_text('{"ts":"t","tool":"run_command","target":"x","ok":true}\n', encoding="utf-8")
        recs = effects.load(self.p)
        self.assertEqual(len(recs), 1)
        self.assertNotIn("irreversible", recs[0])    # 旧条目缺字段=未知，视图不得装知道


class effects视图三态标记(unittest.TestCase):
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

    def test_不可逆条目显著标记(self):
        effects.record_effect("run_command", {"command": "rm -rf build"}, {"session_id": "A"}, path=self.p)
        self.agent._handle_effects_command(":effects", out=self._emit, path=self.p, session_id="A")
        txt = self._text()
        self.assertIn("不可逆", txt)
        self.assertIn("破坏", txt)

    def test_可撤条目标记(self):
        effects.record_effect("write_file", {"path": "a.txt"}, {"session_id": "A"}, undoable=True, path=self.p)
        self.agent._handle_effects_command(":effects", out=self._emit, path=self.p, session_id="A")
        self.assertIn("可撤", self._text())

    def test_未快照条目如实标原因(self):
        effects.record_effect("write_file", {"path": "big.bin"}, {"session_id": "A"},
                              undoable=False, snapshot_skip="too_big", path=self.p)
        self.agent._handle_effects_command(":effects", out=self._emit, path=self.p, session_id="A")
        txt = self._text()
        self.assertIn("未快照", txt)
        self.assertIn("太大", txt)

    def test_旧条目不装知道(self):
        # 无三态字段的旧条目：只显示原有行，不编造可撤/不可逆
        self.p.write_text('{"ts":"2026-07-24T10:00:00","tool":"write_file","target":"old.txt","ok":true,"session":"A"}\n',
                          encoding="utf-8")
        self.agent._handle_effects_command(":effects", out=self._emit, path=self.p, session_id="A")
        line = [l for l in self._text().splitlines() if "old.txt" in l][0]
        self.assertNotIn("不可逆", line)
        self.assertNotIn("可撤", line)
        self.assertNotIn("未快照", line)


if __name__ == "__main__":
    unittest.main(verbosity=2)
