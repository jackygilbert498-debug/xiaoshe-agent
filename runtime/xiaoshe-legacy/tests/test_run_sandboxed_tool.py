"""A2b 弱版 · run_sandboxed 工具：agent 写任意 PowerShell 丢真沙箱跑一次（不持久化）。TDD 红→绿。

沙箱档（对应"纯计算→沙箱"分档）：读不到密钥/断网/资源上限/超时秒杀，只临时工作目录可读写。
默认 ask（不自动放行）；非只读、非安全。跑完删工作目录。
运行：仓库根 `python -m unittest tests.test_run_sandboxed_tool -v`
"""
import platform
import unittest
from pathlib import Path
from unittest import mock

from harness import permission
from harness import tools as tools_mod

_IS_WIN = platform.system() == "Windows"


def _console_output_code_page() -> int:
    import ctypes
    return int(ctypes.windll.kernel32.GetConsoleOutputCP())


def _set_console_output_code_page(code_page: int) -> None:
    import ctypes
    if not ctypes.windll.kernel32.SetConsoleOutputCP(code_page):
        raise OSError(f"SetConsoleOutputCP failed for {code_page}")


class 单元(unittest.TestCase):
    def test_跑通返回stdout(self):
        with mock.patch.object(tools_mod.sandbox, "run_sandboxed",
                               return_value={"output": "42", "exit": 0, "timed_out": False}):
            r = tools_mod.execute("run_sandboxed", {"code": "Write-Output (6*7)"}, {})
        self.assertFalse(r.is_error)
        self.assertIn("42", r.content)

    def test_空code报错(self):
        r = tools_mod.execute("run_sandboxed", {"code": "   "}, {})
        self.assertTrue(r.is_error)

    def test_超时被标注(self):
        with mock.patch.object(tools_mod.sandbox, "run_sandboxed",
                               return_value={"output": "", "exit": 1, "timed_out": True}):
            r = tools_mod.execute("run_sandboxed", {"code": "while($true){}"}, {})
        self.assertIn("超时", r.content)

    def test_不支持平台友好提示(self):
        with mock.patch.object(tools_mod.sandbox, "available", return_value=False):
            r = tools_mod.execute("run_sandboxed", {"code": "x"}, {})
        self.assertFalse(r.is_error)
        self.assertIn("不支持", r.content)

    def test_沙箱错误被收口(self):
        with mock.patch.object(tools_mod.sandbox, "available", return_value=True), \
             mock.patch.object(tools_mod.sandbox, "run_sandboxed",
                               side_effect=tools_mod.sandbox.SandboxError("启动器炸了")):
            r = tools_mod.execute("run_sandboxed", {"code": "x"}, {})
        self.assertIn("沙箱执行失败", r.content)

    def test_一次性工作目录跑完删(self):
        seen = {}

        def fake(code, workdir, **kw):
            seen["wk"] = workdir
            Path(workdir).mkdir(parents=True, exist_ok=True)
            (Path(workdir) / "tmp.txt").write_text("x", encoding="utf-8")
            return {"output": "ok", "exit": 0, "timed_out": False}
        with mock.patch.object(tools_mod.sandbox, "available", return_value=True), \
             mock.patch.object(tools_mod.sandbox, "run_sandboxed", side_effect=fake):
            tools_mod.execute("run_sandboxed", {"code": "x"}, {})
        self.assertFalse(Path(seen["wk"]).exists())   # finally 清理，无残留

    def test_注册_默认ask_非只读非安全(self):
        self.assertIn("run_sandboxed", tools_mod.REGISTRY)
        self.assertEqual(permission.check("run_sandboxed", {"code": "x"}).action, "ask")   # 跑代码=先问
        self.assertNotIn("run_sandboxed", tools_mod.READONLY_TOOLS)
        names = [s["function"]["name"] for s in tools_mod.all_specs()]
        self.assertIn("run_sandboxed", names)


@unittest.skipUnless(_IS_WIN, "沙箱工具真机端到端仅 Windows（AppContainer）")
class 真机端到端(unittest.TestCase):
    def test_sandbox_restores_callers_console_code_page_on_success_and_failure(self):
        original_code_page = _console_output_code_page()
        self.addCleanup(_set_console_output_code_page, original_code_page)

        for code in ("Write-Output (6*7)", "throw 'sandbox failure'"):
            with self.subTest(code=code):
                _set_console_output_code_page(437)
                tools_mod.execute("run_sandboxed", {"code": code}, {})
                self.assertEqual(437, _console_output_code_page())

    def test_沙箱工具算得对(self):
        r = tools_mod.execute("run_sandboxed", {"code": "Write-Output (6*7)"}, {})
        self.assertFalse(r.is_error)
        self.assertIn("42", r.content)

    def test_沙箱工具读不到父进程密钥(self):
        import os
        os.environ["SBX_TOOL_SENTINEL"] = "LEAKME-TOOL-2"
        try:
            r = tools_mod.execute("run_sandboxed",
                                  {"code": "$k=$env:SBX_TOOL_SENTINEL; if($k){'LEAK:'+$k}else{'SAFE'}"}, {})
        finally:
            os.environ.pop("SBX_TOOL_SENTINEL", None)
        self.assertIn("SAFE", r.content)
        self.assertNotIn("LEAKME", r.content)


_IS_MAC = platform.system() == "Darwin"


@unittest.skipUnless(_IS_MAC, "沙箱工具真机端到端 Mac 仅 macOS（seatbelt）")
class 真机端到端Mac(unittest.TestCase):
    """S3：run_sandboxed 工具在 Mac 走 seatbelt 真跑（代码=zsh shell，与 Windows PowerShell 分平台）。"""

    def test_沙箱工具算得对(self):
        r = tools_mod.execute("run_sandboxed", {"code": "echo $((6*7))"}, {})
        self.assertFalse(r.is_error)
        self.assertIn("42", r.content)

    def test_沙箱工具读不到父进程密钥(self):
        import os
        os.environ["SBX_TOOL_SENTINEL"] = "LEAKME-TOOL-2"
        try:
            r = tools_mod.execute("run_sandboxed",
                                  {"code": 'if [ -n "$SBX_TOOL_SENTINEL" ]; then echo "LEAK:$SBX_TOOL_SENTINEL"; else echo SAFE; fi'}, {})
        finally:
            os.environ.pop("SBX_TOOL_SENTINEL", None)
        self.assertIn("SAFE", r.content)
        self.assertNotIn("LEAKME", r.content)

    def test_沙箱工具断网且读不到env(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as d:
            envf = Path(d) / ".env"
            envf.write_text("KIMI_API_KEY=sk-LEAKME-TOOL-3", encoding="utf-8")
            code = (f"cat '{envf}' >/dev/null 2>&1 && echo ENV_OK || echo ENV_DENIED;"
                    "curl -sS --max-time 3 http://1.1.1.1/ >/dev/null 2>&1 && echo NET_OK || echo NET_DENIED")
            r = tools_mod.execute("run_sandboxed", {"code": code}, {})
        self.assertIn("ENV_DENIED", r.content)
        self.assertIn("NET_DENIED", r.content)
        self.assertNotIn("LEAKME", r.content)


if __name__ == "__main__":
    unittest.main()
