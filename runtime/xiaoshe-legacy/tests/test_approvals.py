"""A7 · 持久放行清单（跨会话）。TDD 红→绿。

用户答 p → 命令指纹落盘 .state/approvals.json，下次同命令不再问。绑整条命令指纹、taint/force_ask 仍拦、只交互态生效。
运行：仓库根 `python -m unittest tests.test_approvals -v`
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import agent, approvals


class 持久清单存取(unittest.TestCase):
    def test_add后load读回(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "a.json"
            self.assertTrue(approvals.add("run_command:git status", path=p))
            self.assertIn("run_command:git status", approvals.load(p))

    def test_重复add不新增(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "a.json"
            approvals.add("k", path=p)
            self.assertFalse(approvals.add("k", path=p))   # 已有 → 不新增

    def test_坏档缺档返空集不崩(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(approvals.load(Path(d) / "nope.json"), set())
            (Path(d) / "bad.json").write_text("{坏", encoding="utf-8")
            self.assertEqual(approvals.load(Path(d) / "bad.json"), set())


class 审批集成(unittest.TestCase):
    def test_答p落盘且本会话也认(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(approvals, "APPROVALS_FILE", Path(d) / "a.json"):
                ctx = {"_persistent_approved": set()}
                # 答 p → 放行 + 落盘
                self.assertTrue(agent._approved("run_command", {"command": "git status"}, "", lambda *a: "persist", ctx))
                self.assertIn("run_command:git status", approvals.load(Path(d) / "a.json"))   # 落盘
                self.assertIn("run_command:git status", ctx["_persistent_approved"])          # 本会话也认

    def test_持久清单命中直接放行不再问(self):
        called = []
        ctx = {"_persistent_approved": {"run_command:git status"}}
        r = agent._approved("run_command", {"command": "git status"}, "",
                            lambda *a: called.append(1) or False, ctx)
        self.assertTrue(r)            # 命中持久清单 → 放行
        self.assertEqual(called, [])  # 没问用户

    def test_持久清单不放行别的命令(self):
        ctx = {"_persistent_approved": {"run_command:git status"}}
        self.assertFalse(agent._approved("run_command", {"command": "rm -rf /"}, "", lambda *a: False, ctx))

    def test_污点仍拦持久放行(self):
        span = "这是一段来自网页的不可信内容必须超过三十二个字符才被污点闸门认作长片段AAAA"
        ctx = {"_persistent_approved": {"run_command:echo " + span},
               "_tainted": {span}}
        called = []
        # 命令引用污点 → taint_gate 命中 → 不走持久捷径，重新问（这里 approver 拒）
        r = agent._approved("run_command", {"command": "echo " + span}, "",
                            lambda *a: called.append(1) or False, ctx)
        self.assertFalse(r)
        self.assertEqual(len(called), 1)   # 被逼重新问了（持久清单没直接放行）

    def test_持久放行含污点时不落盘(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(approvals, "APPROVALS_FILE", Path(d) / "a.json"):
                span = "又一段够长的不可信网页内容必须超过三十二字符才算长片段BBBBCCCC"
                ctx = {"_persistent_approved": set(), "_tainted": {span}}
                agent._approved("run_command", {"command": "echo " + span}, "", lambda *a: "persist", ctx)
                self.assertEqual(approvals.load(Path(d) / "a.json"), set())   # 含污点的 persist 不落盘


class A7审查修复(unittest.TestCase):
    def test_MED_裸名高危工具答p不落盘只本会话(self):
        # 红队 MED：press_keys 无细指纹→回落裸名，持久放行=永久空白支票（任意参数敲任意命令）。
        # 修：裸名不持久，只本会话放行。
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(approvals, "APPROVALS_FILE", Path(d) / "a.json"):
                ctx = {"_persistent_approved": set()}
                self.assertTrue(agent._approved("press_keys", {"keys": "echo hi"}, "", lambda *a: "persist", ctx))
                self.assertEqual(approvals.load(Path(d) / "a.json"), set())     # 裸名不落盘
                self.assertIn("press_keys", ctx["_approved_tools"])             # 但本会话认（不用重问）
                self.assertNotIn("press_keys", ctx["_persistent_approved"])     # 不进持久

    def test_MED_真指纹答p仍正常持久(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(approvals, "APPROVALS_FILE", Path(d) / "a.json"):
                ctx = {"_persistent_approved": set()}
                agent._approved("run_command", {"command": "git status"}, "", lambda *a: "persist", ctx)
                self.assertIn("run_command:git status", approvals.load(Path(d) / "a.json"))   # 细指纹照常持久


if __name__ == "__main__":
    unittest.main(verbosity=2)
