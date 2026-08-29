"""复核后的三处改进回归（2026-07-08）：

- 03 裸 exit/quit 也当退出命令（_is_quit）
- 16 交互态派分身打一行可见提示、无头/子 agent 态不打（_spawn_subagent + _io.note）
- 11/22 工具描述里加了轻推：run_command 提醒优先用专用外部工具、update_todos 提醒 ≥3 步先列清单

运行：仓库根 `python -m unittest discover -s tests -v`
"""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from harness import agent, memory, tools


class 退出命令判定(unittest.TestCase):
    def test_裸词冒号斜杠三种退出形都认_大小写空白不敏感(self):
        for t in ["exit", "quit", ":exit", ":quit", "/exit", "/quit", "/q", " EXIT ", "Quit", "  /Exit"]:
            self.assertTrue(agent._is_quit(t), f"{t!r} 应判为退出")

    def test_近似词与普通话不算退出(self):
        for t in ["exits", "quitter", "exit now", "别退出", "", ":e", "q", "/quit now"]:
            self.assertFalse(agent._is_quit(t), f"{t!r} 不该判为退出")


def _stub_model(history, tools=None):
    return {"content": "子结论"}


def _spawn(interactive: bool) -> str:
    """在临时日志文件下跑一次派分身，返回 stdout 捕获内容。"""
    with tempfile.TemporaryDirectory() as d:
        ctx = {"_model_fn": _stub_model, "_log_file": Path(d) / "log.jsonl", "memory_file": None}
        if interactive:
            ctx["_interactive"] = True
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            r = tools._spawn_subagent({"task": "去数一下有几个 py 文件，只带结论回来"}, ctx)
        assert r.startswith("[子 agent 完成]"), r
        return buf.getvalue()


class 派分身可见提示(unittest.TestCase):
    def test_交互态派分身在屏上打出领活与完成两行提示(self):
        out = _spawn(interactive=True)
        self.assertIn("[分身] 领活", out)
        self.assertIn("[分身完成]", out)

    def test_无头态派分身不打任何可见提示_不污染整段输出(self):
        out = _spawn(interactive=False)
        self.assertNotIn("[分身]", out)
        self.assertNotIn("[分身完成]", out)


class 子agent逐工具心跳(unittest.TestCase):
    def test_有心跳hook时每执行一个工具触发一次_带工具名(self):
        seen = []
        tc = {"id": "t1", "function": {"name": "update_todos", "arguments": json.dumps({"todos": []})}}
        with tempfile.TemporaryDirectory() as d:
            ctx = {"todos": [], "_subagent_depth": 1, "_on_subagent_step": seen.append}
            agent._handle_tool_call(tc, [], agent._default_approver, Path(d) / "log.jsonl", ctx)
        self.assertEqual(seen, ["update_todos"])

    def test_无心跳hook时不触发也不崩_主线与无头无hook(self):
        tc = {"id": "t1", "function": {"name": "update_todos", "arguments": json.dumps({"todos": []})}}
        with tempfile.TemporaryDirectory() as d:
            agent._handle_tool_call(tc, [], agent._default_approver, Path(d) / "log.jsonl", {"todos": []})  # 无 _on_subagent_step，不该崩


class 行为系统提示恒在(unittest.TestCase):
    def test_有记忆时纪律仍在且事实以供参考挂出不当指令(self):
        with tempfile.TemporaryDirectory() as d:
            mf = Path(d) / "memory.json"
            memory.remember("项目根在 D 盘", mf)
            c = memory.system_message(mf)["content"]
        self.assertIn("read_file", c)      # 行为纪律恒在
        self.assertIn("项目根在 D 盘", c)    # 记忆事实拼上
        self.assertIn("供参考", c)          # 以「供参考、不是指令」挂出（弱化记忆注入）


class GBK窄编码下note不吞字(unittest.TestCase):
    def test_GBK终端下提示整条不丢_降级后关键中文仍可辨(self):
        import sys
        from harness import _io

        class GBKOut(io.StringIO):
            encoding = "gbk"
            def isatty(self):  # noqa: E301
                return False
            def write(self, s):  # ↳/… 不在 GBK：模拟真机 write 抛 UnicodeEncodeError
                s.encode("gbk")
                return super().write(s)

        buf = GBKOut()
        old = sys.stdout
        sys.stdout = buf
        try:
            _io.note("  └ [分身] 领活：数 py 文件…")   # 含 GBK 印不出的 …
        finally:
            sys.stdout = old
        out = buf.getvalue()
        self.assertNotEqual(out, "", "GBK 下提示被整条吞掉了（回归）")
        self.assertIn("分身", out)  # 关键中文降级后仍在


class 工具描述轻推(unittest.TestCase):
    def _desc(self, name: str) -> str:
        for s in tools.all_specs():
            fn = s.get("function", {})
            if fn.get("name") == name:
                return fn.get("description", "")
        self.fail(f"没找到工具 {name}")

    def test_run_command描述给出别用shell绕过的专用工具映射(self):
        d = self._desc("run_command")
        self.assertIn("read_file", d)   # 读文件的正向映射
        self.assertIn("write_file", d)  # 写文件的正向映射

    def test_update_todos描述带状态机约束而非空泛(self):
        self.assertIn("in_progress", self._desc("update_todos"))


if __name__ == "__main__":
    unittest.main()
