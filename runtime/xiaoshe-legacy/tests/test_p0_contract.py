"""P0 · 碰契约的三修（用户已拍板：#8 词边界 / #37 读纯净化 / #38 条数上限）。TDD 红→绿。

运行：仓库根 `python -m unittest discover -s tests -v`
"""
import json
import tempfile
import unittest
from pathlib import Path

from harness import permission


class 命令扫描词边界(unittest.TestCase):
    """#8：.env/credentials/secrets 类加尾部词边界，治 .environment 误伤，但真 .env 仍硬拒。"""

    def test_真env凭据文件仍硬拒(self):
        for c in ("type .env", "cat app.env", "cat .env.local",
                  "cat ~/.aws/config", "cat ~/.netrc", "cat credentials.json"):
            self.assertEqual(permission.check("run_command", {"command": c}).action,
                             "deny", f"应硬拒：{c}")

    def test_env在更长单词里不再误伤(self):
        for c in ("cat notes.environment.md", "ls .environment/dir"):
            self.assertNotEqual(permission.check("run_command", {"command": c}).action,
                                "deny", f"不该误拒：{c}")

    def test_目录后缀类token仍子串强匹配(self):
        for c in (r"echo x > .state\schedule\tasks\a.json", "cat key.pem", "cat host.ssh"):
            self.assertEqual(permission.check("run_command", {"command": c}).action,
                             "deny", f"应硬拒：{c}")

    def test_普通命令仍是ask不误伤(self):
        for c in ("echo hi", "aws s3 ls", "npm install"):
            self.assertEqual(permission.check("run_command", {"command": c}).action, "ask", c)


class 记忆读纯净化(unittest.TestCase):
    """#37：load() 纯读（坏档返空、不搬源文件）；隔离备份挪到写入路径 load_or_quarantine()。"""

    def test_load读坏档纯读返空_不搬动源文件(self):
        from harness import memory
        d = tempfile.mkdtemp()
        p = Path(d) / "mem.json"
        p.write_text("{这是坏 json", encoding="utf-8")
        self.assertEqual(memory.load(p), [])
        self.assertTrue(p.exists(), "读不该有副作用：load 不能搬走源文件")
        self.assertFalse((Path(d) / "mem.json.corrupt").exists())

    def test_load_or_quarantine读坏档才隔离备份(self):
        from harness import memory
        d = tempfile.mkdtemp()
        p = Path(d) / "mem.json"
        p.write_text("{这是坏 json", encoding="utf-8")
        self.assertEqual(memory.load_or_quarantine(p), [])
        self.assertFalse(p.exists(), "写入路径应把坏档隔离走，防后续覆盖丢失")
        self.assertTrue((Path(d) / "mem.json.corrupt").exists())


class 记忆条数上限与归一化判重(unittest.TestCase):
    """#38：条数上限防刷爆；归一化判重（大小写/空白/尾标点算同一条）。"""

    def test_达到条数上限时拒记新事实(self):
        from harness import memory
        d = tempfile.mkdtemp()
        p = Path(d) / "mem.json"
        p.write_text(json.dumps([f"事实{i}" for i in range(memory._MAX_FACTS)]), encoding="utf-8")
        self.assertFalse(memory.remember("再来一条新的", p))

    def test_归一化判重_大小写空白尾标点算同一条(self):
        from harness import memory
        d = tempfile.mkdtemp()
        p = Path(d) / "mem.json"
        self.assertTrue(memory.remember("Loves MangoSteen", p))
        self.assertFalse(memory.remember("  loves  mangosteen. ", p), "归一化后应判为同一条")


if __name__ == "__main__":
    unittest.main()
