"""M0 换机闭环：跨平台加固与迁移收尾的回归测试。

运行：仓库根目录 `python -m unittest discover -s tests -v`
"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import memory, permission


def _symlink_workspace(base: Path):
    """造一个「真目录 + 指向它的符号链接」，复刻 macOS /var → /private/var 陷阱。
    返回 (real, alias)；本环境不允许建符号链接时返回 None。"""
    real = base / "work"
    real.mkdir()
    alias = base / "alias"
    try:
        os.symlink(real, alias, target_is_directory=True)
    except (OSError, NotImplementedError):
        return None
    return real, alias


class 跨平台工作区(unittest.TestCase):
    def test_工作区ROOT是未展开的符号链接_路径判定不误判越界(self):
        with tempfile.TemporaryDirectory() as d:
            pair = _symlink_workspace(Path(d).resolve())
            if pair is None:
                self.skipTest("本环境不允许创建符号链接")
            real, alias = pair
            (real / "a.txt").write_text("hi", encoding="utf-8")
            with mock.patch.object(permission, "ROOT", alias):  # 故意不 resolve
                self.assertEqual(permission.check("read_file", {"path": "a.txt"}).action, "approve")
                self.assertEqual(permission.safe_path("a.txt"), real / "a.txt")

    def test_符号链接ROOT下_越界路径依然被拒(self):
        with tempfile.TemporaryDirectory() as d:
            pair = _symlink_workspace(Path(d).resolve())
            if pair is None:
                self.skipTest("本环境不允许创建符号链接")
            real, alias = pair
            with mock.patch.object(permission, "ROOT", alias):
                self.assertEqual(
                    permission.check("read_file", {"path": "../../etc/hosts"}).action, "deny")

    def test_工作区内的符号链接指向区外_依然被拒(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d).resolve()
            root = base / "work"
            root.mkdir()
            outside = base / "outside.txt"
            outside.write_text("secret", encoding="utf-8")
            try:
                os.symlink(outside, root / "inside.txt")
            except (OSError, NotImplementedError):
                self.skipTest("本环境不允许创建符号链接")
            with mock.patch.object(permission, "ROOT", root):
                decision = permission.check("read_file", {"path": "inside.txt"})
                self.assertEqual(decision.action, "deny")
                self.assertIn("越出", decision.reason)  # 锁死拒因是越界，而非其它策略碰巧拒掉


class 提示信息跨平台(unittest.TestCase):
    def test_缺key的报错提示_指向当前配置的env文件路径(self):
        from harness import kimi_client
        with tempfile.TemporaryDirectory() as d:
            fake_env = Path(d).resolve() / ".env"
            with mock.patch.object(kimi_client.config, "API_KEY", ""), \
                 mock.patch.object(kimi_client.config, "ENV_PATH", fake_env):
                with self.assertRaises(kimi_client.KimiError) as ctx:
                    kimi_client.chat([{"role": "user", "content": "hi"}])
        msg = str(ctx.exception)
        self.assertIn(str(fake_env), msg)


class 记忆合并(unittest.TestCase):
    def test_合并两份记忆_并集去重且保持先后顺序(self):
        # 基M1：merge_facts 现返回 v2 记录(list[dict])——按内容 id 去重、保序。取正文核对。
        merged = memory.merge_facts(["a", "b"], ["b", "c"])
        self.assertEqual([r["text"] for r in merged], ["a", "b", "c"])

    def test_解析含git冲突标记的记忆文件_两边事实都保留(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "memory.json"
            p.write_text(
                '[\n<<<<<<< HEAD\n  "a",\n  "b"\n=======\n  "a",\n  "c"\n>>>>>>> other\n]\n',
                encoding="utf-8")
            self.assertTrue(memory.resolve_conflict_file(p))
            self.assertEqual(memory.load(p), ["a", "b", "c"])

    def test_diff3冲突样式_本机侧事实不丢(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "memory.json"
            p.write_text(
                '[\n<<<<<<< HEAD\n  "a",\n  "b"\n||||||| merged common ancestors\n  "a"\n=======\n  "a",\n  "c"\n>>>>>>> other\n]\n',
                encoding="utf-8")
            self.assertTrue(memory.resolve_conflict_file(p))
            self.assertEqual(memory.load(p), ["a", "b", "c"])

    def test_冲突一侧内容非法_文件不动且返回失败(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "memory.json"
            broken = '[\n<<<<<<< HEAD\n  "a",,,坏的\n=======\n  "a"\n>>>>>>> other\n]\n'
            p.write_text(broken, encoding="utf-8")
            self.assertFalse(memory.resolve_conflict_file(p))
            self.assertEqual(p.read_text(encoding="utf-8"), broken)  # 原文件一字未动
