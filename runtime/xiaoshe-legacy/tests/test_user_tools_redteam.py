"""A2b Path B · 对抗审查确认项的回归测试（红队 7 确认 → 修复锁死）。TDD 红→绿。

覆盖：①MED run_command 拼路径触达 .state → force_ask（无人值守=拒）；③LOW manifest 部分损坏优雅降级；
④LOW code 含 bidi/零宽不可见字符拒收 + _safe_show 兜底转义；⑤LOW 孤立 CR 归一；⑥LOW pending 数量上限。
（②MED TOCTOU 已在 test_tool_gate 的「展示与expected哈希同源」锁死。）
运行：仓库根 `python -m unittest tests.test_user_tools_redteam -v`
"""
import tempfile
import unittest
from pathlib import Path

from harness import agent, permission, user_tools

_RESERVED = {"read_file"}


class MED_run_command触达state强制确认(unittest.TestCase):
    """红队#1：run_command 只做字面子串扫描，运行时拼路径($d=Join-Path '.state' ...)绕过。
    修法③：折叠后含 .state → force_ask（即便 --allow run_command 在白名单也重问；无人值守 approver 恒拒=断链）。"""

    def test_拼路径写active被force_ask(self):
        cmd = ('$d=Join-Path (Join-Path ".state" ("user"+"_tools")) "active"; '
               'New-Item -Force $d; Set-Content (Join-Path $d "evil.json") "x"')
        d = permission.check("run_command", {"command": cmd})
        self.assertEqual(d.action, "ask")
        self.assertTrue(d.force_ask, "触达 .state 的命令必须 force_ask，否则 --allow 白名单静默放行")

    def test_字面完整路径仍硬拒(self):
        d = permission.check("run_command", {"command": "Set-Content .state/user_tools/active/x.json y"})
        self.assertEqual(d.action, "deny")   # 现有 _cmd_hits 完整字面仍 deny，不降级

    def test_读state也force_ask(self):
        d = permission.check("run_command", {"command": "Get-Content .state/manifest.json"})
        self.assertEqual(d.action, "ask")
        self.assertTrue(d.force_ask)

    def test_普通命令不受影响(self):
        d = permission.check("run_command", {"command": "python run.py --version"})
        self.assertEqual(d.action, "ask")
        self.assertFalse(d.force_ask)   # 不含 .state 的正常命令不被强制重问

    def test_press_keys注state命令也force_ask(self):
        d = permission.check("press_keys", {"keys": 'cd .state{ENTER}'})
        self.assertTrue(d.force_ask or d.action == "deny")   # 往终端注 .state 命令是 run_command 旁路，同样堵

    def test_type_text注state命令也force_ask(self):
        d = permission.check("type_text", {"text": 'New-Item .state/user_tools/active/x.json'})
        self.assertTrue(d.force_ask or d.action == "deny")


class LOW_manifest部分损坏优雅降级(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.base = Path(self._d.name)
        self.addCleanup(self._d.cleanup)
        (self.base / "active").mkdir(parents=True)
        (self.base / "active" / "good.json").write_text("{}", encoding="utf-8")

    def _write_manifest(self, tools):
        import json
        (self.base / "manifest.json").write_text(json.dumps({"tools": tools}), encoding="utf-8")

    def test_entry非dict不崩返回problems(self):
        for bad in ("deadbeef", None, 123, ["a"]):
            self._write_manifest({"good": bad})
            tools, problems = user_tools.load_active(base=self.base, reserved=_RESERVED)  # 不许抛
            self.assertEqual(tools, [])
            self.assertTrue(problems)

    def test_非法名key不拼路径(self):
        self._write_manifest({"../evil": {"sha256": "x"}})
        tools, problems = user_tools.load_active(base=self.base, reserved=_RESERVED)
        self.assertEqual(tools, [])
        self.assertTrue(problems)   # 非法名跳过、绝不用它拼 active/ 路径


class LOW_不可见字符拒收(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.base = Path(self._d.name)
        self.addCleanup(self._d.cleanup)

    def _propose(self, code):
        return user_tools.propose("t_tool", "描述", code, [], base=self.base, reserved=_RESERVED)

    def test_code含RLO拒收(self):
        with self.assertRaises(ValueError):
            self._propose("Write-Output 1 ‮# evil")   # 双向覆写

    def test_code含零宽拒收(self):
        with self.assertRaises(ValueError):
            self._propose("Write-Output​ 1")

    def test_孤立CR归一不拒但存为LF(self):
        import json
        self._propose("Write-Output 1\rWrite-Output 2")   # CR 归一成 LF，不拒
        data = json.loads((self.base / "pending" / "t_tool.json").read_text(encoding="utf-8"))
        self.assertNotIn("\r", data["code"])              # 存盘无孤立 CR（杜绝终端覆写）

    def test_safe_show兜底转义bidi与CR(self):
        s = agent._safe_show("a‮b\rc")
        self.assertNotIn("‮", s)
        self.assertNotIn("\r", s)
        self.assertIn("\\u202e", s)


class LOW_pending数量上限(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.base = Path(self._d.name)
        self.addCleanup(self._d.cleanup)

    def test_超上限拒新提案(self):
        (self.base / "pending").mkdir(parents=True)
        for i in range(user_tools._PENDING_MAX):
            (self.base / "pending" / f"t{i:03d}.json").write_text("{}", encoding="utf-8")
        with self.assertRaises(ValueError):
            user_tools.propose("overflow_tool", "d", "Write-Output 1", [],
                               base=self.base, reserved=_RESERVED)

    def test_覆盖已存在的不算新增(self):
        # 同名再提案是覆盖草稿、不增数量，即便已达上限也应放行（改草稿不该被上限卡死）
        (self.base / "pending").mkdir(parents=True)
        for i in range(user_tools._PENDING_MAX):
            (self.base / "pending" / f"t{i:03d}.json").write_text("{}", encoding="utf-8")
        r = user_tools.propose("t000", "改草稿", "Write-Output 9", [], base=self.base, reserved=_RESERVED)
        self.assertEqual(r["name"], "t000")


if __name__ == "__main__":
    unittest.main()
