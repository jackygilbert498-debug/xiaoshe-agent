"""S3 · Mac seatbelt 沙箱（sandbox-exec）：与 Windows AppContainer 同一套对外契约。TDD 红→绿。

单元层（注入 runner，离线可跑）：argv 分发 / spec 走 base64 JSON / profile 内容（默认拒绝、断网、
写白名单、敏感名 deny 清单）/ 路径注入 fail-closed / sandbox-exec 缺失 fail-closed /
profile 加载失败 fail-closed / 超时与输出语义对齐 Windows。
真机层（仅 macOS + /usr/bin/sandbox-exec 在）：读 /etc/hosts 拒、读 .env/hooks.json 拒、断网、
写白名单外拒、退出码与输出回传、超时杀、env 不泄父进程密钥——全部真跑，不许只 mock。
红队（照 Windows 先例真跑逃逸）：printenv 泄密钥（环境继承）、pbpaste 剪贴板（mach-lookup 面）、
kill 外部进程、osascript 驱动别的 app。
运行：仓库根 `python3 -m unittest tests.test_sandbox_mac -v`
"""
import base64
import json
import os
import platform
import re
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from harness import sandbox

_IS_DARWIN = platform.system() == "Darwin"
_HAS_SBX = os.path.isfile("/usr/bin/sandbox-exec")
_HOST_REALPATH = os.path.realpath


def _host_sbpl_path(p) -> str:
    """Windows tests need a slash-only path that still names their real temp directory."""
    path = _HOST_REALPATH(p).replace("\\", "/")
    return f"//?/{path}" if re.match(r"^[A-Za-z]:/", path) else path


def _spec_of(seen):
    return json.loads(base64.b64decode(seen["spec_b64"]))


class 单元_契约与profile生成(unittest.TestCase):
    def setUp(self):
        self._sandbox_exec = mock.patch.object(
            sandbox, "_MAC_SANDBOX_EXEC", sys.executable
        )
        self._sandbox_exec.start()
        self.addCleanup(self._sandbox_exec.stop)
        self._realpath = mock.patch.object(
            sandbox.os.path, "realpath", side_effect=_host_sbpl_path
        )
        self._realpath.start()
        self.addCleanup(self._realpath.stop)

    def _capture_runner(self, ret=(0, "", "")):
        seen = {}

        def runner(argv, spec_b64, timeout):
            seen["argv"] = list(argv)
            seen["spec_b64"] = spec_b64
            seen["timeout"] = timeout
            # profile 路径在 argv 里（-f 之后），执行期间文件必须在
            if "-f" in argv:
                seen["profile"] = Path(argv[argv.index("-f") + 1]).read_text(encoding="utf-8")
            # 脚本路径是 argv 最后一个；读出 sentinel 前缀好让默认 ret 能伪造成"已进入沙箱"
            seen["script"] = Path(argv[-1]).read_text(encoding="utf-8")
            return ret
        return runner, seen

    def _entered_ret(self, seen, body="OUT", rc=0, err=""):
        token = _spec_of(seen)["enter_token"]
        return rc, f"__SBX_ENTER_{token}__\n{body}\n", err

    def test_测试路径保留真实workdir(self):
        runner, seen = self._capture_runner()
        with tempfile.TemporaryDirectory() as d:
            wk = Path(d) / "wk"
            expected = _host_sbpl_path(wk)

            def r(argv, spec_b64, timeout):
                runner(argv, spec_b64, timeout)
                return self._entered_ret(seen)

            sandbox.run_sandboxed("x", wk, plat="Darwin", runner=r)

        self.assertNotEqual(expected, "/tmp")
        self.assertIn(expected, seen["profile"])
        self.assertEqual(
            _HOST_REALPATH(Path(seen["argv"][-1]).parent).replace("\\", "/"),
            expected,
        )

    def test_argv分发到sandbox_exec且代码不进命令行(self):
        runner, seen = self._capture_runner()
        with tempfile.TemporaryDirectory() as d:
            def r(argv, spec_b64, timeout):
                ret = runner(argv, spec_b64, timeout)
                return self._entered_ret(seen)
            sandbox.run_sandboxed("echo 秘密逻辑", Path(d) / "wk", plat="Darwin", runner=r)
        argv = seen["argv"]
        self.assertEqual(argv[0], sandbox._MAC_SANDBOX_EXEC)
        self.assertIn("-f", argv)
        self.assertIn("/bin/zsh", argv)
        joined = " ".join(argv)
        self.assertNotIn("秘密逻辑", joined)          # 代码绝不出现在命令行（零插值=无注入面）

    def test_spec参数走base64_JSON(self):
        runner, seen = self._capture_runner()
        with tempfile.TemporaryDirectory() as d:
            def r(argv, spec_b64, timeout):
                runner(argv, spec_b64, timeout)
                return self._entered_ret(seen)
            sandbox.run_sandboxed("echo hi", Path(d) / "wk", max_mem_mb=128, timeout_s=10,
                                  plat="Darwin", runner=r)
        spec = _spec_of(seen)
        self.assertEqual(spec["code"], "echo hi")
        self.assertEqual(spec["max_mem_bytes"], 128 * 1024 * 1024)
        self.assertEqual(spec["timeout_ms"], 10 * 1000)
        self.assertTrue(spec["enter_token"])         # 每次执行独立哨兵（判沙箱真生效）
        self.assertTrue(spec["workdir"])

    def test_profile默认拒绝且显式断网(self):
        runner, seen = self._capture_runner()
        with tempfile.TemporaryDirectory() as d:
            def r(argv, spec_b64, timeout):
                runner(argv, spec_b64, timeout)
                return self._entered_ret(seen)
            sandbox.run_sandboxed("x", Path(d) / "wk", plat="Darwin", runner=r)
        prof = seen["profile"]
        self.assertIn("(deny default)", prof)
        self.assertIn("(deny network*)", prof)
        self.assertNotIn("(allow network", prof)

    def test_profile写白名单只授workdir(self):
        runner, seen = self._capture_runner()
        with tempfile.TemporaryDirectory() as d:
            wk = Path(d) / "wk"
            def r(argv, spec_b64, timeout):
                runner(argv, spec_b64, timeout)
                return self._entered_ret(seen)
            sandbox.run_sandboxed("x", wk, plat="Darwin", runner=r)
            prof = seen["profile"]
        wk_real = _host_sbpl_path(wk)
        # 唯一的 file-write 子路径白名单 = workdir（/dev/null 是字面量不算子路径）
        write_subpaths = [ln for ln in prof.splitlines() if "file-write*" in ln and "subpath" in ln]
        self.assertEqual(len(write_subpaths), 1)
        self.assertIn(wk_real, write_subpaths[0])

    def test_profile敏感名deny清单对齐硬护栏(self):
        runner, seen = self._capture_runner()
        with tempfile.TemporaryDirectory() as d:
            def r(argv, spec_b64, timeout):
                runner(argv, spec_b64, timeout)
                return self._entered_ret(seen)
            sandbox.run_sandboxed("x", Path(d) / "wk", plat="Darwin", runner=r)
        prof = seen["profile"]
        for token in ("\\.env", "pem", "key", "id_rsa", "id_ed25519", "credentials", "secrets",
                      "mcp\\.json", "hooks\\.json", "netrc", "npmrc", "git-credentials"):
            self.assertIn(token, prof, f"敏感名 {token} 不在 profile deny 清单")
        # deny 规则须在 allow 之后（SBPL 后写优先）才兜得住
        self.assertGreater(prof.rindex("(deny file-read-data"), prof.rindex("(allow file-read"))

    def test_profile不含未净化自由文本(self):
        # profile 里只允许出现：固定模板 + 严格校验过的绝对路径。凡进引号的 literal/subpath 内容
        # 都必须过与 _sbpl_path 同一把尺（绝对路径、无引号/换行/反斜杠）——断言绑语义不绑随机串。
        runner, seen = self._capture_runner()
        with tempfile.TemporaryDirectory() as d:
            def r(argv, spec_b64, timeout):
                runner(argv, spec_b64, timeout)
                return self._entered_ret(seen)
            sandbox.run_sandboxed("x", Path(d) / "wk", plat="Darwin", runner=r)
            prof = seen["profile"]
        for ln in prof.splitlines():
            self.assertNotIn(";;", ln)               # 无拼接残渣
        for m in re.finditer(r'(?:literal|subpath) "([^"]*)"', prof):
            p = m.group(1)
            self.assertTrue(p.startswith("/"), f"profile 路径非绝对：{p!r}")
            self.assertIsNone(sandbox._MAC_PATH_BAD.search(p), f"profile 路径含危险字符：{p!r}")

    def test_恶意workdir路径注入_fail_closed(self):
        # 红队：路径带引号/换行/反斜杠 → profile 生成前硬拒。
        # 直接压测 SBPL 字符串边界，避免宿主 Windows 文件系统先拒绝非法路径名。
        for evil in ('/tmp/evil"(deny default)', "/tmp/evil\n(allow file-read*)", "/tmp/evil\\x"):
            with self.subTest(evil=evil), \
                 mock.patch.object(sandbox.os.path, "realpath", return_value=evil):
                with self.assertRaises(sandbox.SandboxError):
                    sandbox._sbpl_path(Path("safe-placeholder"))

    def test_sandbox_exec缺失_fail_closed(self):
        runner, _ = self._capture_runner()
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(sandbox, "_MAC_SANDBOX_EXEC", "/nonexistent/sandbox-exec"):
                with self.assertRaises(sandbox.SandboxError):
                    sandbox.run_sandboxed("x", Path(d) / "wk", plat="Darwin", runner=runner)

    def test_profile加载失败_fail_closed不降级裸跑(self):
        # 红队 fail-open 变种：sandbox-exec 起不来（无哨兵输出）→ SandboxError，绝不把输出当成功
        runner, _ = self._capture_runner(ret=(1, "", "sandbox-exec: compile error"))
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(sandbox.SandboxError):
                sandbox.run_sandboxed("x", Path(d) / "wk", plat="Darwin", runner=runner)

    def test_无哨兵即使退出0也fail_closed(self):
        # 事后断言（对齐 Windows TokenIsAppContainer 复核）：哨兵不在=沙箱未生效，rc=0 也不信
        runner, _ = self._capture_runner(ret=(0, "我假装跑完了\n", ""))
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(sandbox.SandboxError):
                sandbox.run_sandboxed("x", Path(d) / "wk", plat="Darwin", runner=runner)

    def test_正常输出解析与哨兵剥离(self):
        runner, seen = self._capture_runner()
        with tempfile.TemporaryDirectory() as d:
            def r(argv, spec_b64, timeout):
                runner(argv, spec_b64, timeout)
                return self._entered_ret(seen, body="你好沙箱", rc=3)
            res = sandbox.run_sandboxed("x", Path(d) / "wk", plat="Darwin", runner=r)
        self.assertEqual(res["exit"], 3)
        self.assertIn("你好沙箱", res["output"])
        self.assertNotIn("__SBX_ENTER_", res["output"])   # 哨兵不外泄
        self.assertFalse(res["timed_out"])

    def test_stderr并入输出对齐Windows(self):
        runner, seen = self._capture_runner()
        with tempfile.TemporaryDirectory() as d:
            def r(argv, spec_b64, timeout):
                runner(argv, spec_b64, timeout)
                return self._entered_ret(seen, body="out", err="warn-line")
            res = sandbox.run_sandboxed("x", Path(d) / "wk", plat="Darwin", runner=r)
        self.assertIn("out", res["output"])
        self.assertIn("warn-line", res["output"])    # Windows 把 stderr 并入同一捕获，Mac 对齐

    def test_超时语义对齐(self):
        runner, seen = self._capture_runner()
        with tempfile.TemporaryDirectory() as d:
            def r(argv, spec_b64, timeout):
                runner(argv, spec_b64, timeout)
                token = _spec_of(seen)["enter_token"]
                return (124, f"__SBX_ENTER_{token}__\n", sandbox._MAC_TIMEOUT_MARK)
            res = sandbox.run_sandboxed("x", Path(d) / "wk", timeout_s=5, plat="Darwin", runner=r)
        self.assertTrue(res["timed_out"])
        self.assertEqual(seen["timeout"], 5)         # 墙钟预算原样下发（runner 层杀进程组）

    def test_环境构造不继承父进程密钥(self):
        # 红队 #1③ Mac 对应：给沙箱的环境是全新构造的最小集，父进程 env 一个比特都进不去
        with tempfile.TemporaryDirectory() as d:
            home = _host_sbpl_path(d)
            env = sandbox._mac_env("SPEC64", home)
        self.assertEqual(env["HARNESS_SANDBOX_SPEC"], "SPEC64")
        self.assertEqual(env["HOME"], home)
        self.assertEqual(env["PATH"], "/usr/bin:/bin:/usr/sbin:/sbin")   # 固定 PATH，不继承
        for leaked in ("KIMI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "http_proxy"):
            self.assertNotIn(leaked, env)

    def test_脚本落盘workdir且含资源上限(self):
        runner, seen = self._capture_runner()
        with tempfile.TemporaryDirectory() as d:
            wk = Path(d) / "wk"
            def r(argv, spec_b64, timeout):
                runner(argv, spec_b64, timeout)
                return self._entered_ret(seen)
            sandbox.run_sandboxed("echo body", wk, max_mem_mb=64, plat="Darwin", runner=r)
            script = seen["script"]
        self.assertIn("ulimit -t ", script)          # CPU 秒上限
        self.assertIn("ulimit -f 131072", script)    # 单文件上限（512B 块：64MB=131072 块；macOS 无 RLIMIT_AS）
        self.assertIn("echo body", script)           # agent 代码走脚本文件，不进 argv
        self.assertTrue(seen["argv"][-1].startswith(_host_sbpl_path(wk)))


@unittest.skipUnless(_IS_DARWIN and _HAS_SBX, "seatbelt 真机隔离测试仅 macOS 且 sandbox-exec 在")
class 真机_沙箱隔离(unittest.TestCase):
    """真跑 sandbox-exec，逐条坐实隔离语义（与 Windows 真机层同构）。慢，但这是 A2b 的命根子。"""

    def setUp(self):
        self._wk = tempfile.TemporaryDirectory()
        self._outside = tempfile.TemporaryDirectory()
        self.workdir = Path(self._wk.name) / "wk"
        self.workdir.mkdir()
        self.secret = Path(self._outside.name) / "secret.txt"
        self.secret.write_text("sk-TOPSECRET-DONT-LEAK-42", encoding="utf-8")
        self.dotenv = Path(self._outside.name) / ".env"
        self.dotenv.write_text("KIMI_API_KEY=sk-TOPSECRET-ENV-42", encoding="utf-8")

    def tearDown(self):
        self._wk.cleanup()
        self._outside.cleanup()

    def test_读etc_hosts被拒(self):
        r = sandbox.run_sandboxed("cat /etc/hosts >/dev/null 2>&1 && echo ETC_OK || echo ETC_DENIED",
                                  self.workdir, timeout_s=20)
        self.assertIn("ETC_DENIED", r["output"])

    def test_读workdir外密钥与env文件被拒(self):
        code = (f"cat '{self.secret}' >/dev/null 2>&1 && echo SEC_OK || echo SEC_DENIED;"
                f"cat '{self.dotenv}' >/dev/null 2>&1 && echo ENV_OK || echo ENV_DENIED")
        r = sandbox.run_sandboxed(code, self.workdir, timeout_s=20)
        self.assertIn("SEC_DENIED", r["output"])
        self.assertIn("ENV_DENIED", r["output"])
        self.assertNotIn("TOPSECRET", r["output"])   # 密钥内容绝不泄漏

    def test_读hooks_json被拒(self):
        hooks = Path(__file__).resolve().parent.parent / ".state" / "hooks.json"
        if not hooks.exists():
            self.skipTest(".state/hooks.json 不存在")
        r = sandbox.run_sandboxed(
            f"cat '{hooks}' >/dev/null 2>&1 && echo HOOKS_OK || echo HOOKS_DENIED",
            self.workdir, timeout_s=20)
        self.assertIn("HOOKS_DENIED", r["output"])

    def test_默认断网(self):
        code = ("curl -sS --max-time 3 http://1.1.1.1/ >/dev/null 2>&1 && echo NET_OK || echo NET_DENIED;"
                "nc -z -G 2 8.8.8.8 53 >/dev/null 2>&1 && echo NC_OK || echo NC_DENIED")
        r = sandbox.run_sandboxed(code, self.workdir, timeout_s=20)
        self.assertIn("NET_DENIED", r["output"])
        self.assertIn("NC_DENIED", r["output"])

    def test_workdir可读写(self):
        (self.workdir / "input.txt").write_text("HELLO_SANDBOX", encoding="utf-8")
        code = "c=$(cat input.txt); echo \"got:$c\" > out.txt; echo WROTE"
        r = sandbox.run_sandboxed(code, self.workdir, timeout_s=20)
        self.assertIn("WROTE", r["output"])
        self.assertEqual((self.workdir / "out.txt").read_text(encoding="utf-8").strip(), "got:HELLO_SANDBOX")

    def test_写workdir外被拒(self):
        target = Path(self._outside.name) / "escape.txt"
        r = sandbox.run_sandboxed(
            f"echo x > '{target}' 2>/dev/null && echo W_OK || echo W_DENIED", self.workdir, timeout_s=20)
        self.assertIn("W_DENIED", r["output"])
        self.assertFalse(target.exists())

    def test_退出码与输出回传正确(self):
        r = sandbox.run_sandboxed("echo 沙箱跑通了; exit 3", self.workdir, timeout_s=20)
        self.assertIn("沙箱跑通了", r["output"])
        self.assertEqual(r["exit"], 3)
        self.assertFalse(r["timed_out"])

    def test_死循环超时被杀(self):
        t0 = time.monotonic()
        r = sandbox.run_sandboxed("sleep 30", self.workdir, timeout_s=3)
        dt = time.monotonic() - t0
        self.assertTrue(r["timed_out"])
        self.assertLess(dt, 15)                      # 杀进程组，不拖到 sleep 自然醒

    def test_资源上限已套_CPU与单文件(self):
        # macOS 无 RLIMIT_AS（setrlimit EINVAL，真机探过）→ 资源笼 = CPU 秒 + 单文件大小 + 墙钟杀进程组
        r = sandbox.run_sandboxed("ulimit -t; ulimit -f", self.workdir, max_mem_mb=64, timeout_s=20)
        self.assertIn("25", r["output"].splitlines()[0])      # CPU 秒 = timeout_s+5
        self.assertIn("131072", r["output"])                  # 64MB = 131072 个 512B 块
        r2 = sandbox.run_sandboxed(
            "dd if=/dev/zero of=big.bin bs=1m count=80 >/dev/null 2>&1; "
            "sz=$(stat -f %z big.bin 2>/dev/null || echo 0); echo \"SIZE=$sz\"; rm -f big.bin",
            self.workdir, max_mem_mb=64, timeout_s=20)
        self.assertIn("SIZE=", r2["output"])
        size = int(r2["output"].split("SIZE=")[1].splitlines()[0])
        self.assertLessEqual(size, 64 * 1024 * 1024)          # 写爆被 SIGXFSZ 掐在 64MB

    def test_中文路径workdir(self):
        # 仓库在中文目录下（/Users/example/Desktop/小蛇）——profile 路径是非 ASCII 也必须真跑通
        from harness import config
        wk = config.ROOT / ".state" / "sandbox" / "sbx_mac_test_中文"
        try:
            r = sandbox.run_sandboxed("echo 中文路径通了 > f.txt; echo OK", wk, timeout_s=20)
            self.assertIn("OK", r["output"])
            self.assertEqual((wk / "f.txt").read_text(encoding="utf-8").strip(), "中文路径通了")
        finally:
            import shutil
            shutil.rmtree(wk, ignore_errors=True)


@unittest.skipUnless(_IS_DARWIN and _HAS_SBX, "seatbelt 红队逃逸测试仅 macOS 且 sandbox-exec 在")
class 红队_逃逸自测(unittest.TestCase):
    """照 Windows 先例真跑逃逸：env 泄密钥（环境继承）/ 剪贴板 / 杀外部进程 / AppleEvent 驱动别的 app。"""

    def setUp(self):
        self._wk = tempfile.TemporaryDirectory()
        self.workdir = Path(self._wk.name) / "wk"
        self.workdir.mkdir()

    def tearDown(self):
        self._wk.cleanup()

    def test_env泄密钥_printenv看不到父进程密钥(self):
        # Windows 红队 #1③ 同类：环境继承是最可能的真逃逸——父进程密钥必须一个比特都进不了沙箱
        old = {k: os.environ.get(k) for k in ("SBX_LEAK_SENTINEL", "KIMI_API_KEY")}
        os.environ["SBX_LEAK_SENTINEL"] = "SECRET-LEAKME-999"
        os.environ["KIMI_API_KEY"] = "sk-FAKE-LEAKME-777"
        try:
            r = sandbox.run_sandboxed("printenv", self.workdir, timeout_s=20)
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        self.assertNotIn("LEAKME", r["output"])
        self.assertNotIn("KIMI_API_KEY", r["output"])

    def test_剪贴板读不到_mach_lookup全断(self):
        marker = "SBX-CLIP-MARKER-4242"
        subprocess.run(["pbcopy"], input=marker, text=True, check=True)
        r = sandbox.run_sandboxed("v=$(pbpaste 2>/dev/null); echo \"pb=[$v]\"", self.workdir, timeout_s=20)
        self.assertNotIn(marker, r["output"])
        self.assertIn("pb=[]", r["output"])

    def test_杀外部进程被拒(self):
        victim = subprocess.Popen(["sleep", "30"])
        try:
            r = sandbox.run_sandboxed(
                f"kill -9 {victim.pid} 2>/dev/null && echo KILL_OK || echo KILL_DENIED",
                self.workdir, timeout_s=20)
            self.assertIn("KILL_DENIED", r["output"])
            self.assertIsNone(victim.poll())          # 受害者还活着
        finally:
            victim.kill()
            victim.wait()

    def test_osascript驱动别的app被拒(self):
        code = ("osascript -e 'tell application \"System Events\" to count of processes'"
                " >/dev/null 2>&1 && echo OSA_OK || echo OSA_DENIED")
        r = sandbox.run_sandboxed(code, self.workdir, timeout_s=20)
        self.assertIn("OSA_DENIED", r["output"])


if __name__ == "__main__":
    unittest.main()
