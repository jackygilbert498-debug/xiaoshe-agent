"""A4 · 手术刀式 Edit 工具（找一段→校验唯一→换一段，改不到就报错不猜）。TDD 红→绿。

对标 Claude Code 的 Edit：改一行不必 write_file 全量重写（省 token、不易手滑覆盖）。仍走路径硬护栏（越界/敏感拒），
保留 write_file 作新建/整体替换。
运行：仓库根 `python -m unittest tests.test_edit -v`
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import permission, tools


class Edit工具(unittest.TestCase):
    def _in(self, d):
        return mock.patch.object(permission, "ROOT", Path(d))

    def test_唯一替换成功_原子写(self):
        with tempfile.TemporaryDirectory() as d, self._in(d):
            (Path(d) / "a.py").write_text("x = 1\nname = 'old'\ny = 2\n", encoding="utf-8")
            out = tools.execute("edit", {"path": "a.py", "old_string": "name = 'old'",
                                         "new_string": "name = 'new'"}, {}).content
            self.assertEqual((Path(d) / "a.py").read_text(encoding="utf-8"), "x = 1\nname = 'new'\ny = 2\n")
            self.assertIn("替换了 1 处", out)

    def test_找不到要替换的文本报错(self):
        with tempfile.TemporaryDirectory() as d, self._in(d):
            (Path(d) / "a.txt").write_text("hello", encoding="utf-8")
            r = tools.execute("edit", {"path": "a.txt", "old_string": "不存在", "new_string": "x"}, {})
            self.assertTrue(r.is_error)
            self.assertIn("没找到", r.content)

    def test_多处不唯一报错_要求加上下文(self):
        with tempfile.TemporaryDirectory() as d, self._in(d):
            (Path(d) / "a.txt").write_text("foo\nfoo\n", encoding="utf-8")
            r = tools.execute("edit", {"path": "a.txt", "old_string": "foo", "new_string": "bar"}, {})
            self.assertTrue(r.is_error)
            self.assertIn("不唯一", r.content)

    def test_replace_all全部替换(self):
        with tempfile.TemporaryDirectory() as d, self._in(d):
            (Path(d) / "a.txt").write_text("foo foo foo", encoding="utf-8")
            out = tools.execute("edit", {"path": "a.txt", "old_string": "foo", "new_string": "bar",
                                         "replace_all": True}, {}).content
            self.assertEqual((Path(d) / "a.txt").read_text(encoding="utf-8"), "bar bar bar")
            self.assertIn("3 处", out)

    def test_新文件拒绝_引导用write_file(self):
        with tempfile.TemporaryDirectory() as d, self._in(d):
            r = tools.execute("edit", {"path": "new.txt", "old_string": "a", "new_string": "b"}, {})
            self.assertTrue(r.is_error)
            self.assertIn("write_file", r.content)

    def test_old等于new拒绝(self):
        with tempfile.TemporaryDirectory() as d, self._in(d):
            (Path(d) / "a.txt").write_text("aaa", encoding="utf-8")
            r = tools.execute("edit", {"path": "a.txt", "old_string": "aaa", "new_string": "aaa"}, {})
            self.assertTrue(r.is_error)

    def test_old为空拒绝(self):
        with tempfile.TemporaryDirectory() as d, self._in(d):
            (Path(d) / "a.txt").write_text("aaa", encoding="utf-8")
            r = tools.execute("edit", {"path": "a.txt", "old_string": "", "new_string": "x"}, {})
            self.assertTrue(r.is_error)


class Edit安全(unittest.TestCase):
    def test_敏感文件被决策层硬拒(self):
        self.assertEqual(permission.check("edit", {"path": ".env", "old_string": "a", "new_string": "b"}).action, "deny")

    def test_越界路径被决策层硬拒(self):
        self.assertEqual(permission.check("edit", {"path": "/etc/passwd", "old_string": "a", "new_string": "b"}).action, "deny")

    def test_edit在污点高危集_与write_file一致(self):
        self.assertIn("edit", permission._TAINT_HIGH_RISK)

    def test_edit注册非SAFE需批准且在specs(self):
        self.assertIn("edit", tools.REGISTRY)
        self.assertEqual(permission.check("edit", {"path": "a.txt", "old_string": "a", "new_string": "b"}).action, "ask")
        self.assertTrue(any(s["function"]["name"] == "edit" for s in tools.all_specs()))


class A4审查修复(unittest.TestCase):
    def test_MED_超大文件edit被拒不进内存(self):
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.object(permission, "ROOT", Path(d)), \
             mock.patch.object(tools, "_EDIT_MAX_BYTES", 1000):
            (Path(d) / "big.txt").write_text("x" * 5000, encoding="utf-8")
            r = tools.execute("edit", {"path": "big.txt", "old_string": "x", "new_string": "y"}, {})
            self.assertTrue(r.is_error)
            self.assertIn("太大", r.content)
            self.assertEqual((Path(d) / "big.txt").read_text(encoding="utf-8"), "x" * 5000)  # 原文没动

    def test_LOW_非utf8文件友好报错(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(permission, "ROOT", Path(d)):
            (Path(d) / "bin.dat").write_bytes(b"\xff\xfe\x00\x01hello")
            r = tools.execute("edit", {"path": "bin.dat", "old_string": "hello", "new_string": "x"}, {})
            self.assertTrue(r.is_error)
            self.assertIn("UTF-8", r.content)                 # 友好提示，非裸 codec 报错
            self.assertNotIn("codec can't decode", r.content)

    def test_LOW_approver返回truthy字符串不算批准(self):
        from harness import agent
        # 拒绝时误回 truthy 字符串 'no' 绝不能被当成批准（契约硬化）
        self.assertFalse(agent._approved("run_command", {"command": "a"}, "", lambda *x: "no", {}))
        self.assertTrue(agent._approved("run_command", {"command": "b"}, "", lambda *x: True, {}))
        self.assertTrue(agent._approved("run_command", {"command": "c"}, "", lambda *x: "always", {}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
