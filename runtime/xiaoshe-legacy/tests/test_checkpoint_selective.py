"""§6.2/§6.3 · 选择性快照（敏感/二进制/超大不进快照，如实记原因）+ undo/清理墙钟上限。TDD 红→绿。

三态口径：可撤（快照已入栈）/ 未快照不可撤（太大·敏感·二进制，账本记原因）/ 本质不可逆（§6.1）。
敏感文件进快照=把密钥复制进 .state/undo，泄密面放大——必须拦在快照口。
墙钟上限可注入 clock（测试别真 sleep）：超时如实报「哪步做了/没做」，不卡死会话。
运行：仓库根 `py -3 -m unittest tests.test_checkpoint_selective -v`
"""
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from harness import checkpoint, effects, permission


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

    def _armed_edit(self, rel, old, new):
        """快照一次 edit 意图，再模拟工具真改——undo 栈处于可撤状态。"""
        p = self._write(rel, old)
        args = {"path": rel}
        tok = checkpoint.snapshot("edit", args, {}, base=self.base)
        checkpoint.commit(tok, "edit", args, {}, ok=True, base=self.base)
        p.write_text(new, encoding="utf-8")
        return p


class 选择性快照(_RootCase):
    def test_敏感文件不进快照(self):
        self._write(".env", "SECRET=1")
        reason = []
        tok = checkpoint.snapshot("write_file", {"path": ".env"}, {}, base=self.base, skip_reason=reason)
        self.assertIsNone(tok)
        self.assertEqual(reason, ["sensitive"])
        self.assertEqual(list(self.base.glob("blob-*")) if self.base.exists() else [],
                         [])   # 密钥字节绝不落进 undo 目录

    def test_大文件原因too_big(self):
        with mock.patch.object(checkpoint, "_MAX_SNAP_BYTES", 10):
            self._write("big.txt", "x" * 100)
            reason = []
            self.assertIsNone(checkpoint.snapshot("edit", {"path": "big.txt"}, {},
                                                  base=self.base, skip_reason=reason))
            self.assertEqual(reason, ["too_big"])

    def test_二进制原因binary(self):
        (self.root / "bin.dat").write_bytes(b"\x00\x01\x02binary-stuff")
        reason = []
        self.assertIsNone(checkpoint.snapshot("write_file", {"path": "bin.dat"}, {},
                                              base=self.base, skip_reason=reason))
        self.assertEqual(reason, ["binary"])

    def test_普通文本照旧快照(self):
        self._write("a.txt", "文本")
        reason = []
        tok = checkpoint.snapshot("edit", {"path": "a.txt"}, {}, base=self.base, skip_reason=reason)
        self.assertIsNotNone(tok)
        self.assertEqual(reason, [])

    def test_新建文件absent照旧快照(self):
        reason = []
        tok = checkpoint.snapshot("write_file", {"path": "new.txt"}, {}, base=self.base, skip_reason=reason)
        self.assertIsNotNone(tok)
        self.assertEqual(reason, [])

    def test_非文件工具不适用不给原因(self):
        reason = []
        self.assertIsNone(checkpoint.snapshot("run_command", {"command": "ls"}, {},
                                              base=self.base, skip_reason=reason))
        self.assertEqual(reason, [])   # 不适用 ≠ 跳过，别污染账本原因字段


class undo墙钟(_RootCase):
    def test_超时在还原前中止_文件不动栈保留(self):
        p = self._armed_edit("t1.txt", "旧", "新")
        clk = iter([0.0, 999.0])
        ok, msg = checkpoint.undo_last({}, base=self.base, clock=lambda: next(clk, 999.0), timeout=30)
        self.assertFalse(ok)
        self.assertIn("超时", msg)
        self.assertIn("未还原", msg)
        self.assertEqual(p.read_text(encoding="utf-8"), "新")        # 目标文件没被动
        self.assertTrue(list(self.base.glob("recovery-*")))          # recovery 已存（如实交代）
        self.assertIsNotNone(checkpoint.peek(base=self.base))        # 栈顶保留可重试，不装已撤

    def test_还原完成才超时_成功但跳过清理(self):
        p = self._armed_edit("t2.txt", "旧", "新")
        clk = iter([0.0, 1.0, 999.0])
        ok, msg = checkpoint.undo_last({}, base=self.base, clock=lambda: next(clk, 999.0), timeout=30)
        self.assertTrue(ok)
        self.assertEqual(p.read_text(encoding="utf-8"), "旧")        # 真还原了
        self.assertIn("清理", msg)                                   # 如实说清理被跳过
        self.assertIsNone(checkpoint.peek(base=self.base))           # 已出栈（还原完成）

    def test_墙钟内正常还原_无超时字样(self):
        p = self._armed_edit("t3.txt", "旧", "新")
        ok, msg = checkpoint.undo_last({}, base=self.base, clock=lambda: 0.0, timeout=30)
        self.assertTrue(ok)
        self.assertEqual(p.read_text(encoding="utf-8"), "旧")
        self.assertNotIn("超时", msg)


class 清理墙钟(_RootCase):
    def test_reconcile超时提前收手不卡死(self):
        self.base.mkdir(parents=True, exist_ok=True)
        for i in range(5):
            (self.base / f"blob-{i:016x}").write_bytes(b"orphan")
        (self.base / "stack.jsonl").write_text("", encoding="utf-8")
        clk = iter([0.0] + [999.0] * 50)
        checkpoint.reconcile(base=self.base, clock=lambda: next(clk, 999.0), timeout=10)
        remaining = list(self.base.glob("blob-*"))
        self.assertTrue(remaining)   # 超时截断：没清完（留到下轮），但函数返回了——没卡死

    def test_reconcile墙钟内照常清孤儿(self):
        self.base.mkdir(parents=True, exist_ok=True)
        (self.base / f"blob-{0:016x}").write_bytes(b"orphan")
        (self.base / "stack.jsonl").write_text("", encoding="utf-8")
        checkpoint.reconcile(base=self.base, clock=lambda: 0.0, timeout=10)
        self.assertEqual(list(self.base.glob("blob-*")), [])


class 账本三态接线(unittest.TestCase):
    """agent._run_tool 把快照结果接进 effects 账本：可撤/未快照不可撤/本质不可逆。"""

    def _run(self, d, tool, args, patch_snap=None):
        from harness import agent
        ctx = {"_approver": lambda *a: True, "session_id": "s"}
        cms = [mock.patch.object(permission, "ROOT", Path(d)),
               mock.patch.object(checkpoint, "UNDO_DIR", Path(d) / ".state" / "undo"),
               mock.patch.object(effects, "EFFECTS_FILE", Path(d) / "e.jsonl")]
        if patch_snap:
            cms.append(mock.patch.object(checkpoint, "_MAX_SNAP_BYTES", patch_snap))
        for cm in cms:
            cm.__enter__()
        try:
            agent._run_tool(tool, args, ctx, ctx["_approver"], Path(d) / "l.jsonl")
        finally:
            for cm in reversed(cms):
                cm.__exit__(None, None, None)
        return effects.load(Path(d) / "e.jsonl")

    def test_正常写_undoable为true(self):
        with TemporaryDirectory() as d:
            recs = self._run(d, "write_file", {"path": "x.txt", "content": "hi"})
            self.assertEqual(len(recs), 1)
            self.assertFalse(recs[0]["irreversible"])
            self.assertTrue(recs[0]["undoable"])

    def test_大文件写_未快照三态落账(self):
        with TemporaryDirectory() as d:
            (Path(d) / "big.txt").write_bytes(b"x" * 100)
            recs = self._run(d, "write_file", {"path": "big.txt", "content": "new"}, patch_snap=10)
            self.assertEqual(len(recs), 1)
            self.assertFalse(recs[0]["irreversible"])           # 本质可逆
            self.assertFalse(recs[0]["undoable"])               # 但这次没快照
            self.assertEqual(recs[0]["snapshot_skip"], "too_big")
            blobs = list((Path(d) / ".state" / "undo").glob("blob-*"))
            self.assertEqual(blobs, [])                          # 确认真没快照


class undo视图对三态如实(unittest.TestCase):
    def setUp(self):
        self._d = TemporaryDirectory()
        self.root = Path(self._d.name)
        self.base = self.root / ".state" / "undo"
        self.fx = self.root / "effects.jsonl"
        self._cm = permission.use_root(self.root)
        self._cm.__enter__()
        self.addCleanup(self._d.cleanup)
        self.addCleanup(lambda: self._cm.__exit__(None, None, None))
        from harness import agent
        self.agent = agent
        self.out = []

    def _emit(self, s):
        self.out.append(str(s))

    def _text(self):
        return "\n".join(self.out)

    def _undo(self):
        return self.agent._handle_undo_command(":undo", confirm=lambda pr: "y", out=self._emit,
                                               base=self.base, effects_path=self.fx, session_id="A")

    def test_空栈_最近动作本质不可逆_如实说撤不了(self):
        effects.record_effect("run_command", {"command": "rm -rf build"}, {"session_id": "A"}, path=self.fx)
        self.assertTrue(self._undo())
        txt = self._text()
        self.assertIn("没有可撤销", txt)
        self.assertIn("撤不了", txt)     # 不装能撤

    def test_空栈_最近改动未快照_如实说undo不可用(self):
        effects.record_effect("write_file", {"path": "big.bin"}, {"session_id": "A"},
                              undoable=False, snapshot_skip="too_big", path=self.fx)
        self.assertTrue(self._undo())
        txt = self._text()
        self.assertIn("没有可撤销", txt)
        self.assertIn("未快照", txt)
        self.assertIn("太大", txt)

    def test_栈顶之后有更晚不可逆动作_警告但仍撤文件(self):
        p = self.root / "h.txt"
        p.write_text("旧", encoding="utf-8")
        args = {"path": "h.txt"}
        tok = checkpoint.snapshot("edit", args, {}, base=self.base)
        checkpoint.commit(tok, "edit", args, {}, ok=True, base=self.base)
        p.write_text("新", encoding="utf-8")
        effects.record_effect("run_command", {"command": "git push"}, {"session_id": "A"}, path=self.fx)
        self.assertTrue(self._undo())
        txt = self._text()
        self.assertIn("撤不了", txt)                               # 警告：git push 这类撤不了
        self.assertIn("外部请求", txt)
        self.assertEqual(p.read_text(encoding="utf-8"), "旧")      # 文件改动照常撤

    def test_栈顶之后无新副作用_不多嘴(self):
        p = self.root / "q.txt"
        p.write_text("旧", encoding="utf-8")
        args = {"path": "q.txt"}
        tok = checkpoint.snapshot("edit", args, {}, base=self.base)
        checkpoint.commit(tok, "edit", args, {}, ok=True, base=self.base)
        p.write_text("新", encoding="utf-8")
        self.assertTrue(self._undo())
        self.assertNotIn("撤不了", self._text())   # 没有更晚的不可逆动作就别吓人


if __name__ == "__main__":
    unittest.main(verbosity=2)
