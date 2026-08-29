"""A2b Path B.3 · 会话初装载 + 调用时沙箱执行。TDD 红→绿。

字节冻结：会话初 load_user_tools 一次性装载（哈希校验），本会话中途 approve 不热加载、下次会话才生效。
执行：代码与参数都走 base64 进沙箱（零源码插值=无注入面），参数一律字符串 splat 进 param(...)。
免问执行：人审批准+哈希校验过的工具=已授权，调用不再问（真正的门在 :approve 那一刻）。
运行：仓库根 `python -m unittest tests.test_user_tool_exec -v`
"""
import base64
import json
import platform
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import permission, user_tools
from harness import tools as tools_mod

_IS_WIN = platform.system() == "Windows"
_RESERVED = {"read_file"}


def _approve_one(base, name="add_two", code="param($a,$b) Write-Output ([int]$a + [int]$b)"):
    user_tools.propose(name, "两个整数相加", code,
                       [{"name": "a", "description": "加数"}, {"name": "b", "description": "加数"},
                        {"name": "note", "description": "备注", "required": False}],
                       base=base, reserved=_RESERVED)
    user_tools.approve(name, base=base, reserved=_RESERVED)


def _decode_blobs(code: str) -> list:
    """从合成代码里抠出所有 base64 块并解码——验证真字节，不看表面。"""
    return [base64.b64decode(m).decode("utf-8")
            for m in re.findall(r"FromBase64String\('([A-Za-z0-9+/=]+)'\)", code)]


class 装载(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.base = Path(self._d.name)
        self.addCleanup(self._d.cleanup)
        self.addCleanup(tools_mod.unload_user_tools)   # 别把测试工具漏进别的测试

    def test_装载后入工具表且免问(self):
        _approve_one(self.base)
        n, problems = tools_mod.load_user_tools(base=self.base)
        self.assertEqual((n, problems), (1, []))
        names = [s["function"]["name"] for s in tools_mod.all_specs()]
        self.assertIn("add_two", names)
        self.assertEqual(permission.check("add_two", {"a": "1", "b": "2"}).action, "approve")   # 批准=授权后续调用

    def test_spec形状正确(self):
        _approve_one(self.base)
        tools_mod.load_user_tools(base=self.base)
        spec = next(s for s in tools_mod.all_specs() if s["function"]["name"] == "add_two")["function"]
        self.assertIn("自定义工具", spec["description"])              # 模型知道这是沙箱执行的自定义工具
        self.assertEqual(spec["parameters"]["properties"]["a"]["type"], "string")
        self.assertEqual(sorted(spec["parameters"]["required"]), ["a", "b"])   # note 可选不进 required

    def test_篡改的不装载且上报(self):
        _approve_one(self.base)
        f = self.base / "active" / "add_two.json"
        f.write_text(f.read_text(encoding="utf-8").replace("相加", "相乘"), encoding="utf-8")
        n, problems = tools_mod.load_user_tools(base=self.base)
        self.assertEqual(n, 0)
        self.assertTrue(any("哈希" in p for p in problems))

    def test_字节冻结_中途批准不热加载(self):
        _approve_one(self.base)
        tools_mod.load_user_tools(base=self.base)
        _approve_one(self.base, name="late_tool", code="Write-Output 1")   # 会话中途才批准
        names = [s["function"]["name"] for s in tools_mod.all_specs()]
        self.assertNotIn("late_tool", names)                                # 不热加载，下次会话才生效
        self.assertEqual(permission.check("late_tool", {}).action, "ask")   # 也不免问

    def test_卸载后不再分发也不免问(self):
        _approve_one(self.base)
        tools_mod.load_user_tools(base=self.base)
        tools_mod.unload_user_tools()
        names = [s["function"]["name"] for s in tools_mod.all_specs()]
        self.assertNotIn("add_two", names)
        self.assertEqual(permission.check("add_two", {}).action, "ask")
        r = tools_mod.execute("add_two", {"a": "1", "b": "2"}, {})
        self.assertTrue(r.is_error)


class 执行(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.base = Path(self._d.name)
        self.addCleanup(self._d.cleanup)
        self.addCleanup(tools_mod.unload_user_tools)
        _approve_one(self.base)
        tools_mod.load_user_tools(base=self.base)

    def test_合成代码零源码插值(self):
        code = tools_mod._compose_user_tool_code("param($a) Write-Output $a", {"a": "秘密'注入"})
        self.assertNotIn("秘密", code)                 # 参数值绝不出现在源码里
        self.assertNotIn("Write-Output $a", code)      # 用户代码本体也不出现（都走 base64）
        blobs = _decode_blobs(code)
        self.assertIn("param($a) Write-Output $a", blobs)
        self.assertIn({"a": "秘密'注入"}, [json.loads(b) for b in blobs if b.strip().startswith("{")])

    def test_execute分发进沙箱(self):
        seen = {}

        def fake(code, workdir, **kw):
            seen["code"] = code
            return {"output": "42", "exit": 0, "timed_out": False}
        with mock.patch.object(tools_mod.sandbox, "available", return_value=True), \
             mock.patch.object(tools_mod.sandbox, "run_sandboxed", side_effect=fake):
            r = tools_mod.execute("add_two", {"a": "17", "b": "25"}, {})
        self.assertFalse(r.is_error)
        self.assertIn("42", r.content)
        args_blob = [json.loads(b) for b in _decode_blobs(seen["code"]) if b.strip().startswith("{")][0]
        self.assertEqual(args_blob, {"a": "17", "b": "25"})

    def test_未声明参数被丢弃(self):
        seen = {}

        def fake(code, workdir, **kw):
            seen["code"] = code
            return {"output": "x", "exit": 0, "timed_out": False}
        with mock.patch.object(tools_mod.sandbox, "available", return_value=True), \
             mock.patch.object(tools_mod.sandbox, "run_sandboxed", side_effect=fake):
            tools_mod.execute("add_two", {"a": "1", "b": "2", "evil": "x; rm -rf"}, {})
        args_blob = [json.loads(b) for b in _decode_blobs(seen["code"]) if b.strip().startswith("{")][0]
        self.assertNotIn("evil", args_blob)            # 只有声明过的参数能进沙箱

    def test_缺必填参数报错(self):
        r = tools_mod.execute("add_two", {"a": "1"}, {})
        self.assertTrue(r.is_error)
        self.assertIn("b", r.content)

    def test_沙箱错误收口(self):
        with mock.patch.object(tools_mod.sandbox, "available", return_value=True), \
             mock.patch.object(tools_mod.sandbox, "run_sandboxed",
                               side_effect=tools_mod.sandbox.SandboxError("炸了")):
            r = tools_mod.execute("add_two", {"a": "1", "b": "2"}, {})
        self.assertIn("沙箱", r.content)               # 收口成给模型的错误说明，不冒泡


@unittest.skipUnless(_IS_WIN, "自定义工具真机执行仅 Windows（AppContainer）")
class 真机端到端(unittest.TestCase):
    """propose→approve→load→execute 全链路真跑 AppContainer——持久化工具的命根子路径必须真机坐实。"""

    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.base = Path(self._d.name)
        self.addCleanup(self._d.cleanup)
        self.addCleanup(tools_mod.unload_user_tools)

    def test_批准的工具真沙箱算得对(self):
        _approve_one(self.base)
        n, problems = tools_mod.load_user_tools(base=self.base)
        self.assertEqual((n, problems), (1, []))
        r = tools_mod.execute("add_two", {"a": "17", "b": "25"}, {})
        self.assertFalse(r.is_error)
        self.assertIn("42", r.content)

    def test_中文与引号参数原样进得去(self):
        _approve_one(self.base, name="echo_back", code="param($a,$b) Write-Output ($a + '|' + $b)")
        tools_mod.load_user_tools(base=self.base)
        r = tools_mod.execute("echo_back", {"a": "白日依山尽", "b": "it's 'quoted'"}, {})
        self.assertIn("白日依山尽|it's 'quoted'", r.content)   # base64 通道：中文/引号零转义损伤


if __name__ == "__main__":
    unittest.main()
