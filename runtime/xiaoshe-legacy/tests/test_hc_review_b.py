"""体检·全仓审查修复 Group B：usage_report 类型/TOCTOU 健壮、backup FIFO 白名单、kimi 非流式重试、execute 信任边界。TDD。"""
import io
import os
import tarfile
import tempfile
import unittest
from unittest import mock

from harness import backup, kimi_client, tools, usage_report, vision


class 费用报告健壮(unittest.TestCase):
    def test_坏usage值不崩整份报告(self):
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "good.jsonl"), "w", encoding="utf-8") as f:
            f.write('{"usage":{"prompt_tokens":50,"completion_tokens":5}}\n')
        with open(os.path.join(d, "bad.jsonl"), "w", encoding="utf-8") as f:
            f.write('{"usage":{"prompt_tokens":"100"}}\n')   # token 是字符串——旧码 int+=str 崩
        r = usage_report.report(None, logs_dir=d)             # 不抛
        self.assertIn("总账", r)


class 备份还原健壮(unittest.TestCase):
    def test_restore只解普通文件和目录_跳过FIFO(self):
        d = tempfile.mkdtemp()
        arch = os.path.join(d, "b.tar.gz")
        with tarfile.open(arch, "w:gz") as t:
            data = b"hi"
            ti = tarfile.TarInfo(".state/f.txt"); ti.size = len(data); t.addfile(ti, io.BytesIO(data))
            fifo = tarfile.TarInfo(".state/pipe"); fifo.type = tarfile.FIFOTYPE; t.addfile(fifo)
        target = os.path.join(d, "out")
        ok, _ = backup.restore_backup(arch, target_dir=target, force=True)
        self.assertTrue(ok)
        self.assertTrue(os.path.exists(os.path.join(target, ".state", "f.txt")))
        self.assertFalse(os.path.exists(os.path.join(target, ".state", "pipe")))   # FIFO 被白名单挡掉


class kimi非流式重试(unittest.TestCase):
    def test_非流式不用retry_all_errors(self):
        cfg = kimi_client._curl_config("x", 10, 5, streaming=False)
        self.assertNotIn("retry-all-errors", cfg)   # 防已生成后传输断线整请求重发→重复计费

    def test_流式仍不加retry_回归(self):
        self.assertNotIn("retry", kimi_client._curl_config("x", 10, 5, streaming=True))


class execute信任边界(unittest.TestCase):
    def test_spill抛异常时不冒泡而回落截断(self):
        with mock.patch.object(vision, "spill_or_truncate", side_effect=ValueError("坏 index")):
            res = tools.execute("read_file", {"path": "README.md"}, {"session_id": "s"})
        self.assertIsInstance(res, tools.ToolResult)   # 回了结果、没破"永不抛"
        self.assertFalse(res.is_error)


class 并行取消止血(unittest.TestCase):
    def test_run_once遇取消旗收工不再发第二次调用(self):
        import threading
        from pathlib import Path

        from harness import agent
        ev = threading.Event(); ev.set()
        calls = {"n": 0}

        def model_fn(messages, tools=None):
            calls["n"] += 1
            return {"content": "", "tool_calls": [{"id": "c1", "function": {"name": "update_todos", "arguments": "{}"}}]}
        agent.run_once("任务", [], model_fn=model_fn, approver=lambda *a: True,
                       log_file=Path(tempfile.mktemp(suffix=".jsonl")),
                       ctx={"_cancel_event": ev, "session_id": "s", "todos": []})
        self.assertEqual(calls["n"], 1)   # 首轮响应后遇取消旗即止步，不再发第二次 API（#11 止住续烧）


if __name__ == "__main__":
    unittest.main(verbosity=2)
