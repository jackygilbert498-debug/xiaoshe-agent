"""可靠性 · 文件级 undo：write_file/edit 执行前快照旧字节，:undo 一键还原。TDD 红→绿。

对不读代码的用户最实在的可靠性网：「撤销刚才那步文件改动」。接在 effects 账本理念上——
写前快照目标文件旧内容（不存在则标 absent），改成功后入 undo 栈；undo_last 人确认后还原
（旧内容/删掉新建的），还原前先存 recovery 副本防误撤。越界/敏感在 undo 时复校验、栈有界。
运行：仓库根 `python -m unittest tests.test_checkpoint -v`
"""
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from harness import checkpoint, permission


class _RootCase(unittest.TestCase):
    def setUp(self):
        self._d = TemporaryDirectory()
        self.root = Path(self._d.name)
        self.base = self.root / ".state" / "undo"
        self._cm = permission.use_root(self.root)
        self._cm.__enter__()
        self.addCleanup(self._d.cleanup)
        self.addCleanup(lambda: self._cm.__exit__(None, None, None))

    def _write(self, rel, text):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        return p

    def _do(self, tool, path_rel, ok=True):
        """模拟一次工具执行的快照→提交流程。"""
        args = {"path": path_rel}
        tok = checkpoint.snapshot(tool, args, {}, base=self.base)
        checkpoint.commit(tok, tool, args, {}, ok=ok, base=self.base)
        return tok


class 快照与还原(_RootCase):
    def test_edit旧内容可还原(self):
        p = self._write("a.txt", "旧内容")
        self._do("edit", "a.txt")            # 快照旧内容
        p.write_text("新内容", encoding="utf-8")  # 工具真改了
        ok, msg = checkpoint.undo_last({}, base=self.base)
        self.assertTrue(ok)
        self.assertEqual(p.read_text(encoding="utf-8"), "旧内容")   # 还原到改前

    def test_新建文件undo即删除(self):
        args = {"path": "new.txt"}
        tok = checkpoint.snapshot("write_file", args, {}, base=self.base)  # 快照时文件还不存在
        (self.root / "new.txt").write_text("刚建的", encoding="utf-8")     # 工具建了它
        checkpoint.commit(tok, "write_file", args, {}, ok=True, base=self.base)
        ok, msg = checkpoint.undo_last({}, base=self.base)
        self.assertTrue(ok)
        self.assertFalse((self.root / "new.txt").exists())  # 新建的被删回去

    def test_还原前存recovery防误撤(self):
        p = self._write("b.txt", "v1")
        self._do("write_file", "b.txt")
        p.write_text("v2改动", encoding="utf-8")
        checkpoint.undo_last({}, base=self.base)
        # recovery 副本里应留着被撤掉的 v2（误撤能找回）
        recs = list((self.base).glob("recovery-*"))
        self.assertTrue(recs)
        self.assertTrue(any("v2改动" in r.read_text(encoding="utf-8") for r in recs))

    def test_peek显示最近一次(self):
        self._write("c.txt", "x")
        self._do("edit", "c.txt")
        top = checkpoint.peek(base=self.base)
        self.assertEqual(top["tool"], "edit")
        self.assertIn("c.txt", top["rel"])


class 挂钩与边界(_RootCase):
    def test_非文件工具不快照(self):
        self.assertIsNone(checkpoint.snapshot("run_command", {"command": "ls"}, {}, base=self.base))
        self.assertIsNone(checkpoint.snapshot("press_keys", {"keys": "x"}, {}, base=self.base))

    def test_失败的工具不入栈(self):
        self._write("d.txt", "orig")
        self._do("edit", "d.txt", ok=False)      # 工具执行失败
        self.assertIsNone(checkpoint.peek(base=self.base))   # 没入 undo 栈

    def test_空栈undo友好返回(self):
        ok, msg = checkpoint.undo_last({}, base=self.base)
        self.assertFalse(ok)
        self.assertIn("没有", msg)

    def test_undo复校验越界敏感拒绝(self):
        # 篡改栈：塞一条指向工作区外的记录 → undo 时 safe_path 复校验应拒
        self.base.mkdir(parents=True, exist_ok=True)
        import json
        (self.base / "stack.jsonl").write_text(
            json.dumps({"tool": "edit", "rel": "../evil.txt", "abs": str(self.root.parent / "evil.txt"),
                        "token": "t1", "existed": True}) + "\n", encoding="utf-8")
        ok, msg = checkpoint.undo_last({}, base=self.base)
        self.assertFalse(ok)
        self.assertFalse((self.root.parent / "evil.txt").exists())

    def test_栈有界(self):
        for i in range(checkpoint._MAX_UNDO + 5):
            self._write(f"f{i}.txt", "x")
            self._do("edit", f"f{i}.txt")
        n = checkpoint.count(base=self.base)
        self.assertLessEqual(n, checkpoint._MAX_UNDO)

    def test_连续两次undo各回一步(self):
        p1 = self._write("g1.txt", "g1旧")
        p2 = self._write("g2.txt", "g2旧")
        self._do("edit", "g1.txt"); p1.write_text("g1新", encoding="utf-8")
        self._do("edit", "g2.txt"); p2.write_text("g2新", encoding="utf-8")
        checkpoint.undo_last({}, base=self.base)   # 撤 g2
        self.assertEqual(p2.read_text(encoding="utf-8"), "g2旧")
        self.assertEqual(p1.read_text(encoding="utf-8"), "g1新")
        checkpoint.undo_last({}, base=self.base)   # 再撤 g1
        self.assertEqual(p1.read_text(encoding="utf-8"), "g1旧")


class 对抗审查修复(_RootCase):
    def test_HIGH_恶意token不越界写(self):
        # 红队 HIGH：token 原样拼路径穿越——纯 hex 白名单必须拦下，绝不让 undo 写到工作区外
        import json
        outside = self.root.parent / "evil_target.txt"
        outside.write_text("界外原文", encoding="utf-8")
        self.addCleanup(lambda: outside.unlink(missing_ok=True))
        p = self._write("loot.txt", "x")
        (self.root / ".state" / "undo").mkdir(parents=True, exist_ok=True)
        # 存一个恶意 token 指向界外文件的 blob（模拟攻击者把内容放好）
        (self.root / ".state" / "undo" / "blob-payload").write_bytes(b"MALICIOUS") if False else None
        (self.base / "stack.jsonl").write_text(json.dumps({
            "token": "../../../../evil_target", "tool": "write_file",
            "abs": str(p), "rel": "loot.txt", "existed": True}) + "\n", encoding="utf-8")
        ok, msg = checkpoint.undo_last({}, base=self.base)
        self.assertFalse(ok)                                   # 非法 token → 拒
        self.assertEqual(outside.read_text(encoding="utf-8"), "界外原文")   # 界外文件绝不被动

    def test_HIGH_token纯hex白名单(self):
        for bad in ("../x", "a/b", "a.b", "..", "x" * 40, "AB12", "a b"):
            self.assertIsNone(checkpoint._safe_child(self.base, "blob-", bad))
        good = checkpoint._safe_child(self.base, "blob-", "abc123def456")
        self.assertIsNotNone(good)
        self.assertEqual(good.parent.resolve(), self.base.resolve())   # 就在 undo 目录下

    def test_MED_大文件不快照(self):
        big = self._write("big.txt", "x" * (checkpoint._MAX_SNAP_BYTES + 10))
        self.assertIsNone(checkpoint.snapshot("edit", {"path": "big.txt"}, {}, base=self.base))  # 超上限不纳入 undo

    def test_LOW_改动后又被外部改_peek警示(self):
        p = self._write("m.txt", "旧")
        self._do("edit", "m.txt")
        p.write_text("我方写的新内容", encoding="utf-8")   # 模拟工具写完
        # commit 记的 after 指纹是"旧"（_do 里工具没真改），这里手动让文件再变以触发 changed
        import time as _t
        _t.sleep(0.01)
        p.write_text("用户后来手改的", encoding="utf-8")
        top = checkpoint.peek(base=self.base)
        self.assertTrue(top.get("changed_since"))    # 改动后又变了 → 警示位

    def test_LOW_recovery有界(self):
        for i in range(checkpoint._MAX_RECOVERY + 8):
            p = self._write(f"r{i}.txt", "旧")
            self._do("edit", f"r{i}.txt")
            p.write_text("新", encoding="utf-8")
            checkpoint.undo_last({}, base=self.base)
        recs = list(self.base.glob("recovery-*"))
        self.assertLessEqual(len(recs), checkpoint._MAX_RECOVERY)

    def test_LOW_reconcile回收孤儿blob(self):
        self.base.mkdir(parents=True, exist_ok=True)
        (self.base / "blob-deadbeef").write_bytes(b"orphan")   # 栈里没有的孤儿
        (self.base / "stack.jsonl").write_text("", encoding="utf-8")
        checkpoint.reconcile(base=self.base)
        self.assertFalse((self.base / "blob-deadbeef").exists())   # 孤儿被回收

    def test_recovery存不下则中止不摧毁(self):
        # recovery 目录只读致写失败时，undo 应 fail-closed 中止、不动当前文件
        from unittest import mock
        p = self._write("s.txt", "旧")
        self._do("edit", "s.txt")
        p.write_text("当前新内容", encoding="utf-8")
        with mock.patch.object(checkpoint.Path, "write_bytes", side_effect=OSError("只读")):
            ok, msg = checkpoint.undo_last({}, base=self.base)
        self.assertFalse(ok)
        self.assertEqual(p.read_text(encoding="utf-8"), "当前新内容")   # 没兜住就没动，当前内容还在
        self.assertIn("中止", msg)

    def test_state_undo进敏感硬护栏(self):
        from harness import permission
        # 反斜杠等价写法仅 Windows 是分隔符（Win 分支保持原字面断言）；Mac 用正斜杠等价路径断言同样的 deny。
        backslash = ".state\\undo\\blob-x" if sys.platform == "win32" else ".state/undo/blob-x"
        for path in (".state/undo/stack.jsonl", backslash):
            d = permission.check("write_file", {"path": path, "content": "x"})
            self.assertEqual(d.action, "deny", msg=f"该拒没拒：{path}")
        d2 = permission.check("run_command", {"command": "echo x > .state/undo/stack.jsonl"})
        self.assertEqual(d2.action, "deny")


class REPL命令(_RootCase):
    def setUp(self):
        super().setUp()
        from harness import agent
        self.agent = agent
        self.out = []

    def _emit(self, s):
        self.out.append(str(s))

    def _text(self):
        return "\n".join(self.out)

    def test_非命令不消费(self):
        self.assertFalse(self.agent._handle_undo_command("你好", confirm=lambda p: "y",
                                                         out=self._emit, base=self.base))

    def test_undo确认后还原(self):
        p = self._write("h.txt", "旧")
        self._do("edit", "h.txt")
        p.write_text("新", encoding="utf-8")
        self.assertTrue(self.agent._handle_undo_command(":undo", confirm=lambda pr: "y",
                                                        out=self._emit, base=self.base))
        self.assertEqual(p.read_text(encoding="utf-8"), "旧")   # 撤销成功
        self.assertIn("还原", self._text())

    def test_undo拒绝确认不动(self):
        p = self._write("i.txt", "旧")
        self._do("edit", "i.txt")
        p.write_text("新", encoding="utf-8")
        self.agent._handle_undo_command(":undo", confirm=lambda pr: "n", out=self._emit, base=self.base)
        self.assertEqual(p.read_text(encoding="utf-8"), "新")   # 没撤
        self.assertIn("未撤销", self._text())

    def test_undo空栈友好提示(self):
        self.agent._handle_undo_command(":undo", confirm=lambda pr: "y", out=self._emit, base=self.base)
        self.assertIn("没有可撤销", self._text())

    def test_undo_list列出(self):
        self._write("j.txt", "x")
        self._do("write_file", "j.txt")
        self.agent._handle_undo_command(":undo list", confirm=lambda pr: "y", out=self._emit, base=self.base)
        self.assertIn("j.txt", self._text())


if __name__ == "__main__":
    unittest.main()
