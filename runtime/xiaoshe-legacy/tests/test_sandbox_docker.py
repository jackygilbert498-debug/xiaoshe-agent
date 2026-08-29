"""S2 · Docker 沙箱化执行（优雅降级版）：第三沙箱后端 + 统一降级链。TDD 红→绿。

单元层（注入 which/probe/runner，全离线）：docker 探测 fail-closed / docker argv 形态
（断网、内存与 pids 封顶、只读根 fs、workdir 挂载）/ 降级链（docker→seatbelt/AppContainer→裸跑）
逐层可注入 / 「未隔离」标注文案写死 / 显式后端选择与未知值报错 / 配置项生效。
真机层（本机无 docker）：auto 真跑 → 降级 seatbelt 且 annotation 显式标注
「未隔离（Docker 缺席，降级 seatbelt）」；seatbelt 下读 .env 仍被拒；rm -rf 只伤 workdir。
运行：仓库根 `python3 -m unittest tests.test_sandbox_docker -v`
"""
import base64
import json
import os
import platform
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import sandbox

_IS_DARWIN = platform.system() == "Darwin"
_HAS_SBX = os.path.isfile("/usr/bin/sandbox-exec")
_REPO = Path(__file__).resolve().parent.parent
_HOST_REALPATH = os.path.realpath


def _host_sbpl_path(p) -> str:
    """Return a slash-only alias that Windows can still use to write this temp path."""
    path = _HOST_REALPATH(p).replace("\\", "/")
    return f"//?/{path}" if len(path) >= 3 and path[1:3] == ":/" else path


def _capture(ret=(0, "OK", "")):
    seen = {}

    def runner(argv, spec_b64, timeout):
        seen["argv"] = list(argv)
        seen["spec"] = json.loads(base64.b64decode(spec_b64))
        seen["timeout"] = timeout
        return ret
    return runner, seen


def _seatbelt_runner(seen_box, body="OUT", rc=0):
    """伪造"已进入 seatbelt"的 runner：按 spec 里的 enter_token 回哨兵（离线复现真 runner 行为）。"""
    def runner(argv, spec_b64, timeout):
        seen_box["argv"] = list(argv)
        spec = json.loads(base64.b64decode(spec_b64))
        seen_box["spec"] = spec
        return rc, f"__SBX_ENTER_{spec['enter_token']}__\n{body}\n", ""
    return runner


class 单元_docker探测(unittest.TestCase):
    def test_which未命中时不调probe直接判不可用(self):
        def probe():  # which 未命中时压根不许调 version（Win FileNotFoundError 也在这层堵死）
            raise AssertionError("which 未命中不应调 probe")
        self.assertFalse(sandbox.docker_available(which=lambda name: None, probe=probe))

    def test_which命中但daemon未起_version非零判不可用(self):
        self.assertFalse(sandbox.docker_available(which=lambda name: "/usr/bin/docker",
                                                  probe=lambda: 1))

    def test_probe抛异常判不可用_fail_closed(self):
        def probe():
            raise OSError("daemon socket 不存在")
        self.assertFalse(sandbox.docker_available(which=lambda name: "/usr/bin/docker",
                                                  probe=probe))

    def test_cli在PATH且daemon活着才判可用(self):
        self.assertTrue(sandbox.docker_available(which=lambda name: "/usr/bin/docker",
                                                 probe=lambda: 0))


class 单元_docker命令行拼装(unittest.TestCase):
    def test_argv含断网内存pids封顶只读根fs与workdir挂载(self):
        runner, seen = _capture()
        with tempfile.TemporaryDirectory() as d:
            wk = Path(d) / "wk"
            sandbox.docker_run("echo hi", wk, max_proc=8, max_mem_mb=256, timeout_s=30,
                               runner=runner)
        argv = seen["argv"]
        self.assertEqual(argv[:3], ["docker", "run", "--rm"])
        self.assertIn("--network", argv)
        self.assertEqual(argv[argv.index("--network") + 1], "none")      # 默认断网（对齐 seatbelt）
        self.assertEqual(argv[argv.index("--memory") + 1], "256m")        # 内存封顶（对齐 max_mem_mb）
        self.assertEqual(argv[argv.index("--pids-limit") + 1], "8")       # 进程数封顶（对齐 max_proc）
        self.assertIn("--read-only", argv)                                # 容器根 fs 只读：只 workdir 可写
        self.assertIn("-v", argv)
        self.assertEqual(
            argv[argv.index("-v") + 1],
            f"{str(wk).replace(chr(92), '/')}:/work",
        )  # 工作区挂载（可写，对齐 seatbelt workdir 语义）
        self.assertEqual(argv[argv.index("-w") + 1], "/work")
        self.assertEqual(argv[-4:], ["python:3-slim", "sh", "-c", "echo hi"])  # 默认通用镜像

    def test_镜像与网络可被参数覆盖(self):
        runner, seen = _capture()
        with tempfile.TemporaryDirectory() as d:
            sandbox.docker_run("echo hi", Path(d) / "wk", image="alpine:3", network="bridge",
                               runner=runner)
        argv = seen["argv"]
        self.assertEqual(argv[argv.index("--network") + 1], "bridge")
        self.assertEqual(argv[-4], "alpine:3")

    def test_只读挂载时带ro后缀(self):
        runner, seen = _capture()
        with tempfile.TemporaryDirectory() as d:
            sandbox.docker_run("cat x", Path(d) / "wk", workdir_ro=True, runner=runner)
        self.assertTrue(seen["argv"][seen["argv"].index("-v") + 1].endswith(":/work:ro"))

    def test_Windows路径反斜杠转正斜杠再挂载(self):
        runner, seen = _capture()
        sandbox.docker_run("echo hi", "D:\\tmp\\wk 1", runner=runner)   # 注入 runner 不真跑，无需目录存在
        self.assertEqual(seen["argv"][seen["argv"].index("-v") + 1], "D:/tmp/wk 1:/work")

    def test_超时标记被识别为timed_out(self):
        runner, _ = _capture((124, "", sandbox._DOCKER_TIMEOUT_MARK))
        with tempfile.TemporaryDirectory() as d:
            r = sandbox.docker_run("sleep 99", Path(d) / "wk", runner=runner)
        self.assertTrue(r["timed_out"])

    def test_docker_run失败按任务失败返回不抛异常(self):
        # D3 评审：--pids-limit 等平台差异致 docker run 报错 = 本任务失败（rc 回传），不许 crash 掀翻套件
        runner, _ = _capture((125, "", "docker: Error response from daemon: bad flag."))
        with tempfile.TemporaryDirectory() as d:
            r = sandbox.docker_run("echo hi", Path(d) / "wk", runner=runner)
        self.assertEqual(r["exit"], 125)
        self.assertIn("bad flag", r["output"])                            # stderr 并入 output（对齐 mac 契约）


class 单元_降级链(unittest.TestCase):
    def test_auto_docker可用选docker且标注已隔离(self):
        runner, seen = _capture()
        with tempfile.TemporaryDirectory() as d:
            r = sandbox.run_sandboxed_auto("echo hi", Path(d) / "wk", plat="Darwin",
                                           which=lambda n: "/usr/bin/docker", probe=lambda: 0,
                                           runner=runner)
        self.assertEqual(r["backend"], "docker")
        self.assertTrue(r["isolated"])
        self.assertEqual(r["annotation"], "已隔离（Docker 容器 python:3-slim）")
        self.assertEqual(seen["argv"][0], "docker")

    def test_auto_docker缺席_Mac降seatbelt_标注未隔离(self):
        box = {}
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(sandbox, "_MAC_SANDBOX_EXEC", sys.executable), \
                 mock.patch.object(sandbox.os.path, "realpath", side_effect=_host_sbpl_path):
                r = sandbox.run_sandboxed_auto("echo hi", Path(d) / "wk", plat="Darwin",
                                               which=lambda n: None, runner=_seatbelt_runner(box))
        self.assertEqual(r["backend"], "seatbelt")
        self.assertFalse(r["isolated"])                                   # 不装隔离：非容器一律标未隔离
        self.assertEqual(r["annotation"], "未隔离（Docker 缺席，降级 seatbelt）")
        self.assertEqual(box["argv"][0], sys.executable)                  # 真走了注入的 seatbelt 分支
        self.assertIn("OUT", r["output"])

    def test_auto_docker缺席_Win降AppContainer_标注未隔离(self):
        runner, seen = _capture((0, '{"exit":0,"timed_out":false,"output":"W"}', ""))
        with tempfile.TemporaryDirectory() as d:
            r = sandbox.run_sandboxed_auto("echo hi", Path(d) / "wk", plat="Windows",
                                           which=lambda n: None, runner=runner)
        self.assertEqual(r["backend"], "appcontainer")
        self.assertFalse(r["isolated"])
        self.assertEqual(r["annotation"], "未隔离（Docker 缺席，降级 AppContainer）")

    def test_auto_docker缺席_无平台沙箱_裸跑且标注未隔离(self):
        runner, seen = _capture((0, "BARE", ""))
        with tempfile.TemporaryDirectory() as d:
            r = sandbox.run_sandboxed_auto("echo hi", Path(d) / "wk", plat="Linux",
                                           which=lambda n: None, runner=runner)
        self.assertEqual(r["backend"], "bare")
        self.assertFalse(r["isolated"])
        self.assertTrue(r["annotation"].startswith("未隔离（Docker 缺席"))
        self.assertEqual(r["output"], "BARE")

    def test_auto_seatbelt自身不可用_继续降裸跑(self):
        # seatbelt profile 加载失败（无哨兵）→ SandboxError → 链继续降级裸跑，绝不无标注执行
        runner, _ = _capture((0, "没有哨兵", ""))
        with tempfile.TemporaryDirectory() as d:
            r = sandbox.run_sandboxed_auto("echo hi", Path(d) / "wk", plat="Darwin",
                                           which=lambda n: None, runner=runner)
        self.assertEqual(r["backend"], "bare")
        self.assertFalse(r["isolated"])
        self.assertTrue(r["annotation"].startswith("未隔离"))

    def test_显式docker但缺席_fail_closed不静默降级(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(sandbox.SandboxError):
                sandbox.run_sandboxed_auto("echo hi", Path(d) / "wk", backend="docker",
                                           which=lambda n: None, runner=_capture()[0])

    def test_显式seatbelt在非Mac平台_抛SandboxError(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(sandbox.SandboxError):
                sandbox.run_sandboxed_auto("echo hi", Path(d) / "wk", backend="seatbelt",
                                           plat="Windows", runner=_capture()[0])

    def test_显式seatbelt_Mac真走mac分支_标注显式选择(self):
        box = {}
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(sandbox, "_MAC_SANDBOX_EXEC", sys.executable), \
                 mock.patch.object(sandbox.os.path, "realpath", side_effect=_host_sbpl_path):
                r = sandbox.run_sandboxed_auto("echo hi", Path(d) / "wk", backend="seatbelt",
                                               plat="Darwin", runner=_seatbelt_runner(box))
        self.assertEqual(r["backend"], "seatbelt")
        self.assertEqual(r["annotation"], "未隔离（显式选择 seatbelt 后端）")

    def test_显式bare_标注显式裸跑(self):
        runner, _ = _capture((0, "B", ""))
        with tempfile.TemporaryDirectory() as d:
            r = sandbox.run_sandboxed_auto("echo hi", Path(d) / "wk", backend="bare",
                                           plat="Darwin", runner=runner)
        self.assertEqual(r["backend"], "bare")
        self.assertEqual(r["annotation"], "未隔离（显式选择裸跑）")

    def test_未知后端名_抛SandboxError(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(sandbox.SandboxError):
                sandbox.run_sandboxed_auto("echo hi", Path(d) / "wk", backend="k8s",
                                           plat="Darwin", runner=_capture()[0])

    def test_配置项生效_env指定bare_即使docker可用也裸跑(self):
        runner, _ = _capture((0, "B", ""))
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.dict(os.environ, {"SANDBOX_BACKEND": "bare"}):
                r = sandbox.run_sandboxed_auto("echo hi", Path(d) / "wk", plat="Darwin",
                                               which=lambda n: "/usr/bin/docker",
                                               probe=lambda: 0, runner=runner)
        self.assertEqual(r["backend"], "bare")                            # 显式配置压过 auto 探测
        self.assertEqual(r["annotation"], "未隔离（显式选择裸跑）")


@unittest.skipUnless(_IS_DARWIN and _HAS_SBX, "真机降级坐实仅 macOS + sandbox-exec")
class 真机_降级坐实(unittest.TestCase):
    """本机无 docker → auto 必须真降 seatbelt、标注写死、且 seatbelt 的 OS 级隔离仍然真生效。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.workdir = Path(self._tmp.name) / "wk"

    def tearDown(self):
        self._tmp.cleanup()

    def test_真机_本机无docker_auto降seatbelt且标注未隔离(self):
        if sandbox.docker_available():
            self.skipTest("本机装了 docker——降级路径无从坐实（应走 docker 后端）")
        r = sandbox.run_sandboxed_auto("echo 降级真跑标记", self.workdir, timeout_s=30)
        self.assertEqual(r["backend"], "seatbelt")
        self.assertFalse(r["isolated"])
        self.assertEqual(r["annotation"], "未隔离（Docker 缺席，降级 seatbelt）")
        self.assertIn("降级真跑标记", r["output"])
        self.assertEqual(r["exit"], 0)

    def test_真机_降级seatbelt下读repo密钥文件仍被拒(self):
        env_file = _REPO / ".env"
        if not env_file.exists() or sandbox.docker_available():
            self.skipTest("需要 repo .env 在场且无 docker")
        r = sandbox.run_sandboxed_auto(f"cat '{env_file}' 2>&1 || echo READ_DENIED",
                                       self.workdir, timeout_s=30)
        self.assertEqual(r["backend"], "seatbelt")
        self.assertIn("READ_DENIED", r["output"])                         # seatbelt 隔离真生效
        self.assertNotIn("KIMI_API_KEY", r["output"])                     # 密钥内容绝不进输出

    def test_真机_破坏性rm_rf只伤workdir不伤宿主(self):
        if sandbox.docker_available():
            self.skipTest("本机装了 docker——降级路径无从坐实")
        (self.workdir.mkdir(parents=True, exist_ok=True))
        (self.workdir / "victim.txt").write_text(" bye", encoding="utf-8")
        outside = Path(self._tmp.name) / "outside.txt"
        outside.write_text("host", encoding="utf-8")
        r = sandbox.run_sandboxed_auto("rm -rf ./* && echo RMDONE", self.workdir, timeout_s=30)
        self.assertIn("RMDONE", r["output"])
        self.assertFalse((self.workdir / "victim.txt").exists())          # workdir 内真被删（破坏性任务敢跑）
        self.assertTrue(outside.exists())                                 # workdir 外分毫未伤
        self.assertEqual(outside.read_text(encoding="utf-8"), "host")


if __name__ == "__main__":
    unittest.main()
