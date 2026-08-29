"""M2 无头模式：免值守单次执行 / 白名单审批 / 工作区切换 的回归测试。

运行：仓库根目录 `python -m unittest discover -s tests -v`
"""
import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from harness import config, headless, permission, session

_ROOT = Path(__file__).resolve().parent.parent


def _脚本模型(responses):
    """依次弹出预设响应的假模型（不联网）。"""
    seq = list(responses)

    def fn(history, tools=None):
        return seq.pop(0)

    return fn


def _写文件调用(path, content="hi"):
    return {"content": "", "tool_calls": [{"id": "t1", "function": {
        "name": "write_file",
        "arguments": json.dumps({"path": path, "content": content}, ensure_ascii=False)}}]}


_完成 = {"content": "任务完成", "tool_calls": []}


class 无头模式核心(unittest.TestCase):
    def _sandbox(self, d):
        """把工作区、会话档案目录、日志目录全部指到临时目录。"""
        base = Path(d).resolve()
        (base / "ws").mkdir()
        return (mock.patch.object(permission, "ROOT", base / "ws"),
                mock.patch.object(session, "SESSIONS_DIR", base / "sessions"),
                mock.patch.object(session, "LOGS_DIR", base / "logs"))

    def test_安全任务_免值守跑完_打印结果且留档案和日志(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = self._sandbox(d)
            with p1, p2, p3:
                buf = io.StringIO()
                with redirect_stdout(buf):
                    code = headless.run_headless("说句结论", model_fn=_脚本模型([
                        {"content": "结论是四十二", "tool_calls": []}]))
                self.assertEqual(code, 0)
                self.assertIn("结论是四十二", buf.getvalue())
                archives = list(session.SESSIONS_DIR.glob("headless-*.json"))
                self.assertEqual(len(archives), 1)
                logs = list(session.LOGS_DIR.glob("headless-*.jsonl"))
                self.assertEqual(len(logs), 1)

    def test_危险工具默认拒_文件不落盘且日志留痕(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = self._sandbox(d)
            with p1, p2, p3:
                with redirect_stdout(io.StringIO()):
                    code = headless.run_headless("写个文件", model_fn=_脚本模型([
                        _写文件调用("a.txt"), _完成]))
                self.assertEqual(code, 0)
                self.assertFalse((permission.ROOT / "a.txt").exists())
                log_text = next(session.LOGS_DIR.glob("headless-*.jsonl")).read_text(encoding="utf-8")
                self.assertIn("拒绝", log_text)

    def test_allow白名单放行_文件真落盘(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = self._sandbox(d)
            with p1, p2, p3:
                with redirect_stdout(io.StringIO()):
                    code = headless.run_headless("写个文件", allow=("write_file",),
                                                 model_fn=_脚本模型([_写文件调用("a.txt"), _完成]))
                self.assertEqual(code, 0)
                self.assertEqual((permission.ROOT / "a.txt").read_text(encoding="utf-8"), "hi")

    def test_白名单不越过硬护栏_敏感文件仍拒(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = self._sandbox(d)
            with p1, p2, p3:
                with redirect_stdout(io.StringIO()):
                    headless.run_headless("写敏感文件", allow=("write_file",),
                                          model_fn=_脚本模型([_写文件调用(".env", "K=1"), _完成]))
                self.assertFalse((permission.ROOT / ".env").exists())

    def test_workdir切换工作区_用完恢复原值(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = self._sandbox(d)
            other = Path(d).resolve() / "other"
            other.mkdir()
            with p1, p2, p3:
                before = permission.ROOT
                with redirect_stdout(io.StringIO()):
                    code = headless.run_headless("在别处写文件", allow=("write_file",),
                                                 workdir=str(other),
                                                 model_fn=_脚本模型([_写文件调用("b.txt"), _完成]))
                self.assertEqual(code, 0)
                self.assertTrue((other / "b.txt").exists())
                self.assertEqual(permission.ROOT, before)  # 用完恢复

    def test_workdir不存在_退出码1且不跑模型(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = self._sandbox(d)
            with p1, p2, p3:
                def 不该被调用(history, tools=None):
                    raise AssertionError("workdir 非法时不应调用模型")
                code = headless.run_headless("x", workdir=str(Path(d) / "nope"), model_fn=不该被调用)
                self.assertEqual(code, 1)

    def test_同进程同秒连调两次_档案各自留存不互覆(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = self._sandbox(d)
            with p1, p2, p3:
                with redirect_stdout(io.StringIO()):
                    headless.run_headless("一", model_fn=_脚本模型([{"content": "1", "tool_calls": []}]))
                    headless.run_headless("二", model_fn=_脚本模型([{"content": "2", "tool_calls": []}]))
                self.assertEqual(len(list(session.SESSIONS_DIR.glob("headless-*.json"))), 2)

    def test_allow放行run_command_密钥类命令仍被硬拒(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = self._sandbox(d)
            cmd_call = {"content": "", "tool_calls": [{"id": "t1", "function": {
                "name": "run_command",
                "arguments": json.dumps({"command": "cat .env"})}}]}
            with p1, p2, p3:
                with redirect_stdout(io.StringIO()):
                    headless.run_headless("偷密钥", allow=("run_command",),
                                          model_fn=_脚本模型([cmd_call, _完成]))
                log_text = next(session.LOGS_DIR.glob("headless-*.jsonl")).read_text(encoding="utf-8")
                self.assertIn("拒绝", log_text)

    def test_allow里有不认识的工具名_stderr有告警(self):
        from contextlib import redirect_stderr
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = self._sandbox(d)
            with p1, p2, p3:
                err = io.StringIO()
                with redirect_stdout(io.StringIO()), redirect_stderr(err):
                    headless.run_headless("x", allow=("write_flie",),
                                          model_fn=_脚本模型([_完成]))
                self.assertIn("不认识的工具名", err.getvalue())
                self.assertIn("write_flie", err.getvalue())


class 入口参数(unittest.TestCase):
    def test_无p时给allow参数_报用法错误不进对话(self):
        r = subprocess.run([sys.executable, "run.py", "--allow", "write_file"],
                           cwd=str(_ROOT), capture_output=True, text=True,
                           encoding="utf-8", timeout=30)
        self.assertEqual(r.returncode, 2)
        self.assertIn("只在", r.stderr)

    def test_空任务_报用法错误而非掉进交互(self):
        r = subprocess.run([sys.executable, "run.py", "-p", "  "],
                           cwd=str(_ROOT), capture_output=True, text=True,
                           encoding="utf-8", timeout=30)
        self.assertEqual(r.returncode, 2)
        self.assertIn("不能为空", r.stderr)

    def test_帮助信息_包含无头模式三个参数(self):
        r = subprocess.run([sys.executable, "run.py", "--help"],
                           cwd=str(_ROOT), capture_output=True, text=True,
                           encoding="utf-8", timeout=30)
        self.assertEqual(r.returncode, 0)
        for opt in ("--prompt", "--allow", "--workdir"):
            self.assertIn(opt, r.stdout)


class 实链无头(unittest.TestCase):
    def test_实链_无头一句话任务真跑通(self):
        if not config.API_KEY:
            self.skipTest(
                f"无 {config.API_KEY_ENV}，跳过 {config.PROVIDER_LABEL} 实链")
        r = subprocess.run([sys.executable, "run.py", "-p", "只回复两个字：收到"],
                           cwd=str(_ROOT), capture_output=True, text=True,
                           encoding="utf-8", timeout=180)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("收到", r.stdout)
