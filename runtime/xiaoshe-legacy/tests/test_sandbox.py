"""A2b 执行底座 · sandbox.run_sandboxed：把代码关进真沙箱（Win AppContainer+Job）。TDD 红→绿。

单元层：参数走 base64 JSON 环境变量、零源码插值、返回 JSON 解析、错误收口。
真机层（仅 Windows，非管理员即可）：读不到 workdir 外密钥 / 默认断网 / workdir 可读写 / 超时被杀——
沙箱隔离是 A2b 的命根子，必须真跑坐实，不能只靠 mock。CI(ubuntu) 自动跳过。
运行：仓库根 `python -m unittest tests.test_sandbox -v`
"""
import base64
import json
import platform
import tempfile
import unittest
from pathlib import Path

from harness import sandbox

_IS_WIN = platform.system() == "Windows"


class 单元_契约与解析(unittest.TestCase):
    def _capture_runner(self, ret):
        seen = {}

        def runner(argv, spec_b64, timeout):
            seen["argv"] = argv
            seen["spec"] = json.loads(base64.b64decode(spec_b64))
            return ret
        return runner, seen

    def test_参数走base64_JSON_代码不进命令行源码(self):
        runner, seen = self._capture_runner((0, '{"exit":0,"timed_out":false,"output":"hi"}', ""))
        with tempfile.TemporaryDirectory() as d:
            sandbox.run_sandboxed("Write-Output 秘密逻辑", Path(d) / "wk",
                                  max_proc=5, max_mem_mb=128, timeout_s=10, plat="Windows", runner=runner)
        # 代码在 base64 JSON spec 里，不在 powershell 命令行参数里（零源码插值=无注入面）
        self.assertEqual(seen["spec"]["code"], "Write-Output 秘密逻辑")
        self.assertEqual(seen["spec"]["max_proc"], 5)
        self.assertEqual(seen["spec"]["max_mem_bytes"], 128 * 1024 * 1024)
        joined = " ".join(seen["argv"])
        self.assertNotIn("秘密逻辑", joined)                 # 代码绝不出现在命令行
        self.assertIn("-File", seen["argv"])                 # 启动器走临时 .ps1 文件（避开命令行长度上限）

    def test_返回JSON被解析(self):
        runner, _ = self._capture_runner((0, 'noise\n{"exit":3,"timed_out":false,"output":"OUT"}', ""))
        with tempfile.TemporaryDirectory() as d:
            r = sandbox.run_sandboxed("x", Path(d) / "wk", plat="Windows", runner=runner)
        self.assertEqual(r, {"output": "OUT", "exit": 3, "timed_out": False})

    def test_error返回抛SandboxError(self):
        runner, _ = self._capture_runner((0, '{"error":"CreateProcess err=87"}', ""))
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(sandbox.SandboxError):
                sandbox.run_sandboxed("x", Path(d) / "wk", plat="Windows", runner=runner)

    def test_无有效JSON抛SandboxError(self):
        runner, _ = self._capture_runner((1, "彻底坏了没有json", "err信息"))
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(sandbox.SandboxError):
                sandbox.run_sandboxed("x", Path(d) / "wk", plat="Windows", runner=runner)

    def test_不支持平台报错(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(sandbox.SandboxError):
                sandbox.run_sandboxed("x", Path(d) / "wk", plat="Linux", runner=lambda *a: (0, "", ""))

    def test_available平台判定(self):
        self.assertTrue(sandbox.available("Windows"))
        self.assertTrue(sandbox.available("Darwin"))
        self.assertFalse(sandbox.available("Linux"))

    def test_profile名按workdir隔离(self):
        n1 = sandbox._profile_name(Path("D:/x/task_aaa"))
        n2 = sandbox._profile_name(Path("D:/x/task_bbb"))
        self.assertNotEqual(n1, n2)                          # 各任务独立 profile → SID 隔离

    def test_profile名消毒不再撞名(self):
        # 红队 #6：曾把 task-1/task_1/task.1 消毒成同名共享 SID → 现用全路径哈希，各异
        names = {sandbox._profile_name(Path(f"D:/x/task{c}1")) for c in ["-", "_", ".", "@", "X"]}
        self.assertEqual(len(names), 5)

    def test_sandbox_env剥密钥只留必需(self):
        # 红队 #1③ 根治：给 launcher 的最小环境不含任何密钥 → 子进程继承不到
        base = {"SystemRoot": r"C:\Windows", "TEMP": r"C:\T", "KIMI_API_KEY": "sk-x",
                "OPENAI_API_KEY": "y", "CLAUDE_CODE_SESSION_ID": "z", "PATH": "p"}
        base["PATH"] = "p"   # PATH 非密钥、系统必需，应保留
        env = sandbox._sandbox_env(base, "SPEC64")
        for leaked in ("KIMI_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_SESSION_ID"):
            self.assertNotIn(leaked, env)          # 密钥类一律剥掉
        self.assertIn("SystemRoot", env)           # 系统变量保留（CreateProcess 需要）
        self.assertIn("PATH", env)
        self.assertEqual(env["HARNESS_SANDBOX_SPEC"], "SPEC64")


@unittest.skipUnless(_IS_WIN, "沙箱真机隔离测试仅 Windows（AppContainer）")
class 真机_沙箱隔离(unittest.TestCase):
    """真跑 AppContainer+Job，逐条验隔离。慢（每条起一个真沙箱进程），但这是 A2b 的命根子。"""

    def setUp(self):
        self._wk = tempfile.TemporaryDirectory()
        self._secret = tempfile.TemporaryDirectory()   # workdir 之外、从不授权 → 沙箱应读不到
        self.workdir = Path(self._wk.name) / "wk"
        self.workdir.mkdir()
        self.secret_file = Path(self._secret.name) / "secret.txt"
        self.secret_file.write_text("sk-TOPSECRET-DONT-LEAK-42", encoding="utf-8")

    def tearDown(self):
        self._wk.cleanup()
        try:
            self._secret.cleanup()
        except OSError:
            pass

    def test_沙箱内读不到workdir外的密钥(self):
        p = str(self.secret_file).replace("'", "''")
        code = f"try{{$c=Get-Content '{p}' -Raw -EA Stop;'READ_OK:'+$c}}catch{{'READ_DENIED'}}"
        r = sandbox.run_sandboxed(code, self.workdir, timeout_s=25)
        self.assertIn("READ_DENIED", r["output"])
        self.assertNotIn("TOPSECRET", r["output"])          # 密钥内容绝不泄漏

    def test_沙箱内默认断网(self):
        code = ("try{$t=New-Object Net.Sockets.TcpClient;$i=$t.BeginConnect('1.1.1.1',53,$null,$null);"
                "if($i.AsyncWaitHandle.WaitOne(2500)-and $t.Connected){'NET_OK'}else{'NET_DENIED'}}catch{'NET_DENIED'}")
        r = sandbox.run_sandboxed(code, self.workdir, timeout_s=25)
        self.assertIn("NET_DENIED", r["output"])

    def test_沙箱内可读写授权的workdir(self):
        (self.workdir / "input.txt").write_text("HELLO_SANDBOX", encoding="utf-8")
        ip = str(self.workdir / "input.txt").replace("'", "''")
        op = str(self.workdir / "out.txt").replace("'", "''")
        code = (f"$c=Get-Content '{ip}' -Raw;Set-Content '{op}' ('got:'+$c.Trim());'WROTE'")
        r = sandbox.run_sandboxed(code, self.workdir, timeout_s=25)
        self.assertIn("WROTE", r["output"])
        self.assertEqual((self.workdir / "out.txt").read_text(encoding="utf-8").strip(), "got:HELLO_SANDBOX")

    def test_正常代码返回输出退出0(self):
        r = sandbox.run_sandboxed("Write-Output '沙箱跑通了'", self.workdir, timeout_s=25)
        self.assertIn("沙箱跑通了", r["output"])
        self.assertFalse(r["timed_out"])

    def test_死循环超时被杀(self):
        r = sandbox.run_sandboxed("while($true){Start-Sleep -Milliseconds 100}", self.workdir, timeout_s=4)
        self.assertTrue(r["timed_out"])

    def test_沙箱内读不到父进程密钥环境变量(self):
        # 红队 #1③ 唯一真逃逸：env 继承把密钥递进沙箱。修后非白名单 env 一律读不到
        import os
        os.environ["SBX_LEAK_SENTINEL"] = "SECRET-LEAKME-999"
        try:
            code = "$k=$env:SBX_LEAK_SENTINEL; if($k){'LEAK:'+$k}else{'NO_LEAK'}"
            r = sandbox.run_sandboxed(code, self.workdir, timeout_s=25)
        finally:
            os.environ.pop("SBX_LEAK_SENTINEL", None)
        self.assertIn("NO_LEAK", r["output"])
        self.assertNotIn("LEAKME", r["output"])


if __name__ == "__main__":
    unittest.main()
