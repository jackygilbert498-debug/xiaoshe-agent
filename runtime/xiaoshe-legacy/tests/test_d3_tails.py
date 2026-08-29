"""D3 两条小尾巴收口（2026-07-25）：

- 尾巴1：jobs._tail（run_in_background 读落盘日志）与 schedule.run_task（监工收子进程输出）
  此前各自 utf-8 硬读/+replace，中文 Windows 下 GBK 输出全毁成 �；收口为共用
  `_io.decode_cmd_output` 回退链（utf-8 严格 → mbcs → utf-8+replace，CRLF 归一 LF）。
- 尾巴2：agent._run_tool 两处 ask 被拒边角——①白名单内工具参数带污点被 taint_gate 拦下、
  ②hooks 收紧的 ask 被拒——无头模式下话术仍谎称「用户拒绝了」（无用户在场）；
  收口为检测无头上下文如实归因「审批策略拒绝」，交互模式一字不变。

运行：仓库根 `py -3 -m unittest tests.test_d3_tails -v`
"""
import codecs
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # 让 tests 能 import harness

from harness import _io, agent, hooks, jobs, permission, schedule

_无mbcs = False
try:
    codecs.lookup("mbcs")
except LookupError:   # 非 Windows 没有活动代码页编解码器
    _无mbcs = True


class 尾巴1_jobs日志解码(unittest.TestCase):
    """jobs._tail 读 run_in_background 子进程落盘日志（字节是子进程真实编码，Windows 中文=GBK）。"""

    @unittest.skipIf(_无mbcs, "非 Windows 无 mbcs 编解码器")
    def test_gbk日志按活动代码页回退解码(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "job.log"
            p.write_bytes("中文输出".encode("gbk"))
            self.assertEqual(jobs._tail(p), "中文输出")

    def test_utf8日志行为不变(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "job.log"
            p.write_bytes("中文输出\nsecond line".encode("utf-8"))
            self.assertEqual(jobs._tail(p), "中文输出\nsecond line")

    def test_二进制垃圾不崩_替换符兜底(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "job.log"
            p.write_bytes(b"\xff\xff\xff\x81")   # utf-8 与 GBK 都解不动
            out = jobs._tail(p)
            self.assertIsInstance(out, str)      # 绝不抛 UnicodeDecodeError

    def test_CRLF归一为LF(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "job.log"
            p.write_bytes(b"a\r\nb\r\n")
            self.assertEqual(jobs._tail(p), "a\nb\n")


class 尾巴1_schedule监工输出解码(unittest.TestCase):
    """run_task 收子进程输出：env 强制 PYTHONUTF8 只罩得住 Python 子进程，任务链里夹 cmd 内置
    命令仍可能吐 GBK——读侧必须走同款回退链，别再 text=True encoding=utf-8 锁死。"""

    def _run_with_fake_child(self, out_bytes: bytes, rc: int = 0):
        """假子进程喂指定字节，返回 (退出码, 历史记录)。"""
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            tasks, history, running = d / "tasks", d / "history", d / "running"
            tasks.mkdir()
            (tasks / "t.json").write_text(
                json.dumps({"name": "t", "prompt": "干活", "every": "30m"}), encoding="utf-8")
            proc = types.SimpleNamespace(
                pid=424242, returncode=rc,
                communicate=lambda timeout=None: (out_bytes, None))
            with mock.patch.object(schedule, "TASKS_DIR", tasks), \
                 mock.patch.object(schedule, "HISTORY_DIR", history), \
                 mock.patch.object(schedule, "RUNNING_DIR", running):
                code = schedule.run_task("t", popen=lambda *a, **kw: proc)
                recs = schedule.read_history("t")
            return code, recs

    @unittest.skipIf(_无mbcs, "非 Windows 无 mbcs 编解码器")
    def test_gbk输出落历史不乱码(self):
        code, recs = self._run_with_fake_child("中文输出".encode("gbk"))
        self.assertEqual(code, 0)
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["output_tail"], "中文输出")

    def test_utf8输出行为不变(self):
        code, recs = self._run_with_fake_child("中文输出".encode("utf-8"))
        self.assertEqual(code, 0)
        self.assertEqual(recs[0]["output_tail"], "中文输出")

    def test_二进制垃圾不崩(self):
        code, recs = self._run_with_fake_child(b"\xff\xff\xff\x81")
        self.assertEqual(code, 0)
        self.assertIsInstance(recs[0]["output_tail"], str)


class 尾巴2_无头拒绝话术边角(unittest.TestCase):
    """无头模式（permission.headless_mode 上下文）没有用户在场：ask 被拒的话术必须如实归因
    审批策略；交互模式（不在无头上下文）话术一字不变。"""

    _SPAN = "本段是从不可信网页整段抄来的够长污点文本专用于触发taint_gate断言"   # ≥32 字才入污点

    def _call(self, name, args, ctx):
        # approver 恒拒（无头 _deny_all 同款形态）；log_file 在 deny 路径用不到
        return agent._run_tool(name, args, ctx, approver=lambda *a: False, log_file=Path(os.devnull))

    def test_边角1_白名单内参数带污点_无头话术如实(self):
        ctx = {"_approved_tools": {"run_command"}, "_tainted": (self._SPAN,)}
        with mock.patch.object(hooks, "eval_pretool", return_value=None):
            with permission.headless_mode(("run_command",)):
                content, is_error, executed = self._call(
                    "run_command", {"command": f"echo {self._SPAN}"}, ctx)
        self.assertFalse(executed)
        self.assertTrue(is_error)
        self.assertIn("审批策略拒绝", content)
        self.assertIn("无头", content)
        self.assertNotIn("用户拒绝了", content, "无头模式没有用户在场，不许谎称「用户拒绝了」")

    def test_边角2_hooks收紧的ask被拒_无头话术如实(self):
        ctx = {"_approved_tools": {"run_command"}}
        with mock.patch.object(hooks, "eval_pretool", return_value="ask"):
            with permission.headless_mode(("run_command",)):
                content, is_error, executed = self._call(
                    "run_command", {"command": "echo hi"}, ctx)
        self.assertFalse(executed)
        self.assertTrue(is_error)
        self.assertIn("审批策略拒绝", content)
        self.assertIn("无头", content)
        self.assertNotIn("用户拒绝了", content, "无头模式没有用户在场，不许谎称「用户拒绝了」")

    def test_交互模式两处边角话术一字不变(self):
        # 边角1：污点拦下
        ctx = {"_approved_tools": {"run_command"}, "_tainted": (self._SPAN,)}
        with mock.patch.object(hooks, "eval_pretool", return_value=None):
            content1, _, executed1 = self._call("run_command", {"command": f"echo {self._SPAN}"}, ctx)
        self.assertFalse(executed1)
        self.assertIn("用户拒绝了", content1)
        # 边角2：hooks 收紧的 ask 被拒
        ctx2 = {"_approved_tools": {"run_command"}}
        with mock.patch.object(hooks, "eval_pretool", return_value="ask"):
            content2, _, executed2 = self._call("run_command", {"command": "echo hi"}, ctx2)
        self.assertFalse(executed2)
        self.assertIn("用户拒绝了", content2)

    def test_退出无头上下文即恢复交互话术(self):
        ctx = {"_approved_tools": {"run_command"}}
        with mock.patch.object(hooks, "eval_pretool", return_value="ask"):
            with permission.headless_mode(("run_command",)):
                inside, _, _ = self._call("run_command", {"command": "echo hi"}, ctx)
            outside, _, _ = self._call("run_command", {"command": "echo hi"}, ctx)
        self.assertNotIn("用户拒绝了", inside)
        self.assertIn("用户拒绝了", outside, "contextvar 退出必须复位，别把无头话术串给交互上下文")


if __name__ == "__main__":
    unittest.main(verbosity=2)
