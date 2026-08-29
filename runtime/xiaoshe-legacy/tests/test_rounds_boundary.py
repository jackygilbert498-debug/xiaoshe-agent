"""§2.3.1 循环边界确定性提醒层。TDD 红→绿。

- 逼近 MAX_TOOL_ROUNDS 硬上限时（剩 ROUNDS_REMIND_AHEAD 轮）注入一次「收敛收尾」系统提醒。
- 时机精确：不到边界不出；到边界只出一次（flag 回合内本地，跨用户回合重新计）。
- 与 #5c _StepGauge 正交：它管「停滞」（语义判据），本层管「确定性边界」（纯轮数算术）——
  停滞先停（远早于上限）时本层不出；判据全失灵烧到上限时本层必已出过。
- 注入面：文案=常量模板+整数，不拼用户输入/工具输出等任何不可信内容。
运行：仓库根 `py -3 -m unittest tests.test_rounds_boundary -v`
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import agent, permission


def _forever_read_model(_messages, tools=None):
    """永远要求 read 同一个存在的文件 → 工具恒成功（有进展、不停滞），专烧轮数上限。"""
    return {"content": "",
            "tool_calls": [{"id": "t1", "type": "function",
                            "function": {"name": "read_file", "arguments": '{"path": "note.txt"}'}}]}


def _read_then_done_model(rounds_before_done):
    """先读 N 轮再收尾给最终答复（验证「不到边界不出」）。"""
    seq = [_forever_read_model(None)] * rounds_before_done + [{"content": "做完了", "tool_calls": []}]
    it = iter(seq)
    return lambda m, tools=None: next(it)


def _reminders(hist):
    return [m for m in hist if m.get("role") == "user" and "还剩" in str(m.get("content", ""))]


class 边界提醒(unittest.TestCase):
    def _run_to_cap(self, hist=None, ctx=None):
        """假模型一路成功调工具烧到上限（MAX=6, AHEAD=2 缩小场景）。"""
        hist = [] if hist is None else hist
        ctx = {"todos": []} if ctx is None else ctx
        with tempfile.TemporaryDirectory() as d:
            Path(d, "note.txt").write_text("hi", encoding="utf-8")
            with permission.use_root(d), \
                 mock.patch.object(agent, "MAX_TOOL_ROUNDS", 6), \
                 mock.patch.object(agent, "ROUNDS_REMIND_AHEAD", 2):
                reply = agent.run_once("干活", hist, model_fn=_forever_read_model,
                                       log_file=Path(d) / "l.jsonl", ctx=ctx)
        return reply, hist, ctx

    def test_到边界注入一次_且时机精确在倒数第N轮(self):
        reply, hist, _ = self._run_to_cap()
        rems = _reminders(hist)
        self.assertEqual(len(rems), 1, "到边界应恰注入一次提醒")
        self.assertIn("还剩 2 轮", rems[0]["content"])       # MAX=6, AHEAD=2 → 第 4 轮执行完注入
        # 时机精确：提醒出现在第 MAX-AHEAD=4 个工具轮之后、第 5 轮之前
        idx = hist.index(rems[0])
        tool_rounds_before = sum(1 for m in hist[:idx]
                                 if m.get("role") == "assistant" and m.get("tool_calls"))
        self.assertEqual(tool_rounds_before, 6 - 2)
        self.assertEqual(reply, "（工具调用轮数过多，已停止）")   # 之后仍烧到硬上限兜底
        self.assertTrue(agent._ends_clean(hist))                # 干净收尾，resume 不 400

    def test_边界内连续多轮也只出一次(self):
        # 提醒后模型仍不停（剩 2/1 轮都满足条件）→ flag 保证全程只有一条
        _, hist, _ = self._run_to_cap()
        self.assertEqual(len(_reminders(hist)), 1)

    def test_不到边界不出(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "note.txt").write_text("hi", encoding="utf-8")
            hist = []
            with permission.use_root(d):
                reply = agent.run_once("读两下", hist, model_fn=_read_then_done_model(2),
                                       log_file=Path(d) / "l.jsonl", ctx={"todos": []})
            self.assertEqual(reply, "做完了")
            self.assertEqual(_reminders(hist), [], "2 轮 << 20 轮上限，绝不该出边界提醒")

    def test_跨用户回合重新计_第二轮到边界仍提醒(self):
        # 多轮会话：提醒 flag 是回合本地状态——同一 ctx 的第二个用户回合到边界要再提醒（语义按回合计轮）
        ctx = {"todos": []}
        _, hist1, _ = self._run_to_cap(ctx=ctx)
        _, hist2, _ = self._run_to_cap(ctx=ctx)
        self.assertEqual(len(_reminders(hist1)), 1)
        self.assertEqual(len(_reminders(hist2)), 1)

    def test_停滞先停则不出边界提醒_与5c不打架(self):
        def fail_model(_m, tools=None):
            return {"content": "",
                    "tool_calls": [{"id": "t1", "type": "function",
                                    "function": {"name": "read_file",
                                                 "arguments": '{"path": "不存在的文件_xyz"}'}}]}
        with tempfile.TemporaryDirectory() as d:
            hist = []
            reply = agent.run_once("读个文件", hist, model_fn=fail_model,
                                   log_file=Path(d) / "l.jsonl", ctx={"todos": []})
            self.assertIn("无进展", reply)                        # 5c 停滞停在第 5 轮
            self.assertEqual(_reminders(hist), [], "停滞早停（第5轮），远未到上限，边界提醒不出")

    def test_提醒文案不拼不可信内容(self):
        # 注入面红队：用户输入与工具输出都带 marker，提醒文案一个字都不能沾
        with tempfile.TemporaryDirectory() as d:
            Path(d, "note.txt").write_text("SECRET_TOOL_CONTENT", encoding="utf-8")
            hist = []
            with permission.use_root(d), \
                 mock.patch.object(agent, "MAX_TOOL_ROUNDS", 6), \
                 mock.patch.object(agent, "ROUNDS_REMIND_AHEAD", 2):
                agent.run_once("SECRET_USER_INPUT 干活", hist, model_fn=_forever_read_model,
                               log_file=Path(d) / "l.jsonl", ctx={"todos": []})
            rems = _reminders(hist)
            self.assertEqual(len(rems), 1)
            self.assertNotIn("SECRET_USER_INPUT", rems[0]["content"])
            self.assertNotIn("SECRET_TOOL_CONTENT", rems[0]["content"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
