"""A5 · glob 找文件 + grep 搜内容（纯标准库，只读安全，结构化输出）。TDD 红→绿。

对标 Claude Code 的 Glob/Grep：搜代码不必 run_command 跑 shell find/grep（糙、慢、还得过命令闸）。
在 ROOT 内搜、跳噪声目录(.git/__pycache__/.state…)与敏感文件（grep 绝不泄漏 .env 等内容）。
运行：仓库根 `python -m unittest tests.test_search -v`
"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import permission, tools


def _can_symlink() -> bool:
    """能否创建符号链接：Windows 非管理员/未开开发者模式会抛 WinError 1314。
    此机不能则符号链接安全测试 skip（在 Mac/Linux/Win-admin 上照常验证），而非误报为 ERROR。"""
    try:
        with tempfile.TemporaryDirectory() as _d:
            os.symlink(Path(_d) / "t", Path(_d) / "l")
        return True
    except (OSError, NotImplementedError):
        return False


_CAN_SYMLINK = _can_symlink()
_SYMLINK_MSG = "本平台/权限无法创建符号链接（Windows 需管理员或开发者模式）"


class Glob找文件(unittest.TestCase):
    def _mk(self, d):
        (Path(d) / "a.py").write_text("x", encoding="utf-8")
        (Path(d) / "sub").mkdir()
        (Path(d) / "sub" / "b.py").write_text("y", encoding="utf-8")
        (Path(d) / "c.txt").write_text("z", encoding="utf-8")

    def test_递归找py(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(permission, "ROOT", Path(d)):
            self._mk(d)
            out = tools.execute("glob", {"pattern": "**/*.py"}, {}).content
            self.assertIn("a.py", out)
            self.assertIn("sub/b.py", out)
            self.assertNotIn("c.txt", out)

    def test_顶层匹配不含子目录(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(permission, "ROOT", Path(d)):
            self._mk(d)
            out = tools.execute("glob", {"pattern": "*.py"}, {}).content
            self.assertIn("a.py", out)
            self.assertNotIn("sub/b.py", out)

    def test_跳过敏感与噪声目录(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(permission, "ROOT", Path(d)):
            (Path(d) / ".env").write_text("k=1", encoding="utf-8")
            (Path(d) / ".git").mkdir()
            (Path(d) / ".git" / "config").write_text("x", encoding="utf-8")
            out = tools.execute("glob", {"pattern": "**/*"}, {}).content
            self.assertNotIn(".env", out)
            self.assertNotIn("config", out)

    def test_无匹配友好提示(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(permission, "ROOT", Path(d)):
            out = tools.execute("glob", {"pattern": "**/*.rs"}, {}).content
            self.assertIn("没有匹配", out)

    def test_拒绝越界pattern(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(permission, "ROOT", Path(d)):
            r = tools.execute("glob", {"pattern": "../*"}, {})
            self.assertTrue(r.is_error)


class Grep搜内容(unittest.TestCase):
    def test_找到匹配文件(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(permission, "ROOT", Path(d)):
            (Path(d) / "a.py").write_text("# TODO: 修\nx = 1", encoding="utf-8")
            (Path(d) / "b.py").write_text("y = 2", encoding="utf-8")
            out = tools.execute("grep", {"pattern": "TODO"}, {}).content
            self.assertIn("a.py", out)
            self.assertNotIn("b.py", out)

    def test_content模式给出行号与文本(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(permission, "ROOT", Path(d)):
            (Path(d) / "a.py").write_text("line1\nfind_me = 3\nline3", encoding="utf-8")
            out = tools.execute("grep", {"pattern": "find_me", "output_mode": "content"}, {}).content
            self.assertIn("a.py:2:", out)
            self.assertIn("find_me = 3", out)

    def test_大小写不敏感(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(permission, "ROOT", Path(d)):
            (Path(d) / "a.py").write_text("Hello World", encoding="utf-8")
            out = tools.execute("grep", {"pattern": "hello", "case_insensitive": True}, {}).content
            self.assertIn("a.py", out)

    def test_glob过滤只搜指定名(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(permission, "ROOT", Path(d)):
            (Path(d) / "a.py").write_text("target", encoding="utf-8")
            (Path(d) / "a.txt").write_text("target", encoding="utf-8")
            out = tools.execute("grep", {"pattern": "target", "glob": "*.py"}, {}).content
            self.assertIn("a.py", out)
            self.assertNotIn("a.txt", out)

    def test_跳过二进制文件不崩(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(permission, "ROOT", Path(d)):
            (Path(d) / "bin.dat").write_bytes(b"\xff\xfe\x00target\x00")
            (Path(d) / "ok.txt").write_text("target", encoding="utf-8")
            out = tools.execute("grep", {"pattern": "target"}, {}).content
            self.assertIn("ok.txt", out)          # 文本文件搜到
            self.assertNotIn("bin.dat", out)      # 二进制跳过、不崩

    def test_安全_不泄漏敏感文件内容(self):
        # 关键安全：grep 读文件内容——绝不能把 .env 的 key 搜出来泄漏。
        with tempfile.TemporaryDirectory() as d, mock.patch.object(permission, "ROOT", Path(d)):
            (Path(d) / ".env").write_text("KIMI_API_KEY=sk-secret-REAL-123", encoding="utf-8")
            (Path(d) / "ok.txt").write_text("KIMI_API_KEY=placeholder", encoding="utf-8")
            out = tools.execute("grep", {"pattern": "KIMI_API_KEY", "output_mode": "content"}, {}).content
            self.assertNotIn("sk-secret-REAL-123", out)   # .env 内容不泄漏
            self.assertNotIn(".env", out)
            self.assertIn("ok.txt", out)                  # 非敏感照常搜到

    @unittest.skipUnless(_CAN_SYMLINK, _SYMLINK_MSG)
    def test_安全_符号链接指向敏感文件不泄漏内容(self):
        # 名字无辜的符号链接指向 .env——grep 跟链会读出 key。_is_sensitive 只查名字，须对解析后的真路径复查。
        with tempfile.TemporaryDirectory() as d, mock.patch.object(permission, "ROOT", Path(d)):
            (Path(d) / ".env").write_text("KIMI_API_KEY=sk-LEAK-999", encoding="utf-8")
            (Path(d) / "notes.txt").symlink_to(Path(d) / ".env")
            out = tools.execute("grep", {"pattern": "KIMI_API_KEY", "output_mode": "content"}, {}).content
            self.assertNotIn("sk-LEAK-999", out)          # 经符号链接也不泄漏 .env 内容

    @unittest.skipUnless(_CAN_SYMLINK, _SYMLINK_MSG)
    def test_安全_符号链接逃逸ROOT外不读到(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as outside, \
             mock.patch.object(permission, "ROOT", Path(d)):
            # 秘密值与 pattern 不同名，免得被「没有匹配 <pattern>」消息里回显的 pattern 误触断言
            (Path(outside) / "ext.txt").write_text("findme = SECRETVAL_outside", encoding="utf-8")
            (Path(d) / "link.txt").symlink_to(Path(outside) / "ext.txt")
            out = tools.execute("grep", {"pattern": "findme", "output_mode": "content"}, {}).content
            self.assertNotIn("SECRETVAL_outside", out)    # ROOT 外经符号链接也不读到内容
            self.assertNotIn("link.txt", out)             # 也不列该文件

    def test_非法正则友好报错(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(permission, "ROOT", Path(d)):
            r = tools.execute("grep", {"pattern": "[unclosed"}, {})
            self.assertTrue(r.is_error)


class A5审查修复(unittest.TestCase):
    def test_MED_ReDoS危险正则被拒不冻死(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(permission, "ROOT", Path(d)):
            (Path(d) / "a.txt").write_text("aaaaaaa", encoding="utf-8")
            r = tools.execute("grep", {"pattern": "(a+)+$"}, {})   # 嵌套无界量词——拒了就不会灾难性回溯冻死
            self.assertTrue(r.is_error)

    @unittest.skipUnless(_CAN_SYMLINK, _SYMLINK_MSG)
    def test_LOW_glob不跟符号链接目录到ROOT外(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as outside, \
             mock.patch.object(permission, "ROOT", Path(d)):
            (Path(outside) / "ext.txt").write_text("x", encoding="utf-8")
            (Path(d) / "linkdir").symlink_to(Path(outside))
            out = tools.execute("glob", {"pattern": "linkdir/*.txt"}, {}).content
            self.assertNotIn("ext.txt", out)   # 显式点名符号链接目录也不列 ROOT 外文件名

    def test_LOW_env后缀文件也算敏感不泄漏(self):
        self.assertTrue(permission._is_sensitive(Path("app.env")))
        self.assertTrue(permission._is_sensitive(Path("config.env")))
        self.assertFalse(permission._is_sensitive(Path(".env.example")))   # 模板豁免不误伤
        with tempfile.TemporaryDirectory() as d, mock.patch.object(permission, "ROOT", Path(d)):
            (Path(d) / "app.env").write_text("SECRET_KEY=leakme999", encoding="utf-8")
            out = tools.execute("grep", {"pattern": "SECRET_KEY", "output_mode": "content"}, {}).content
            self.assertNotIn("leakme999", out)


class 搜索工具注册(unittest.TestCase):
    def test_glob_grep已注册且只读安全(self):
        self.assertIn("glob", tools.REGISTRY)
        self.assertIn("grep", tools.REGISTRY)
        self.assertEqual(permission.check("glob", {"pattern": "*.py"}).action, "approve")   # 只读=SAFE
        self.assertEqual(permission.check("grep", {"pattern": "x"}).action, "approve")
        names = [s["function"]["name"] for s in tools.all_specs()]
        self.assertIn("glob", names)
        self.assertIn("grep", names)


if __name__ == "__main__":
    unittest.main(verbosity=2)
