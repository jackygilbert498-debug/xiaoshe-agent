"""P5 · 5c 进度感知停止 + 独立验证。TDD 红→绿。

- _StepGauge：本轮是否推进的客观信号（工具成功/被拒/todos）；dirty=本会话有写类工具成功过。
- 停滞：连续 STALL_LIMIT 轮无进展→注一条换策略提醒，再 STALL_GRACE 轮仍无进展→干净收尾停（不烧满 20 轮）。
- 收尾独立验证 _verify_completion：仅 dirty+顶层+开关开时触发一次；判未达成→追加 user 消息驱动再修（不产孤儿 tool 结果）。
- **VERIFY_ENABLED 默认关**（ctx 可覆盖）：默认行为退回纯停滞检测，全绿测零变更。全离线。
运行：仓库根 `python -m unittest tests.test_progress_stop -v`
"""
import tempfile
import unittest
from pathlib import Path

from harness import agent, permission


def _fail_tool_model(_messages, tools=None):
    """总是要求 read 一个不存在的文件 → 工具恒 is_error（模拟卡死空转）。content 留空，让停滞收尾话术能浮现。"""
    return {"content": "",
            "tool_calls": [{"id": "t1", "type": "function",
                            "function": {"name": "read_file", "arguments": '{"path": "不存在的文件_xyz"}'}}]}


class 步进信号灯(unittest.TestCase):
    def test_写类工具成功标记dirty_只读工具不标(self):
        g = agent._StepGauge()
        g.observe([(False, False)], denied_delta=0, completed_now=0)   # 写类成功
        self.assertTrue(g.dirty)
        g2 = agent._StepGauge()
        g2.observe([(False, True)], denied_delta=0, completed_now=0)   # 只读成功
        self.assertFalse(g2.dirty)

    def test_全报错累加停滞_有成功清零(self):
        g = agent._StepGauge()
        self.assertEqual(g.observe([(True, False)], 0, 0), 1)          # 报错→stall=1
        self.assertEqual(g.observe([(True, False)], 0, 0), 2)
        self.assertEqual(g.observe([(False, False)], 0, 0), 0)         # 成功→清零

    def test_被拒计入无进展(self):
        g = agent._StepGauge()
        self.assertEqual(g.observe([(False, False)], denied_delta=1, completed_now=0), 1)  # 有拒绝→不算推进


class 停滞停止(unittest.TestCase):
    def test_连续工具全报错_提前停不烧满20轮_且history干净(self):
        with tempfile.TemporaryDirectory() as d:
            ctx = {"todos": []}
            hist = []
            reply = agent.run_once("读个文件", hist, model_fn=_fail_tool_model,
                                   log_file=Path(d) / "l.jsonl", ctx=ctx)
            self.assertIn("无进展", reply)               # 停滞收尾话术
            self.assertTrue(agent._ends_clean(hist))     # 不留悬空 tool_calls（resume 不 400）
            rounds = sum(1 for m in hist if m.get("role") == "assistant")
            self.assertLess(rounds, agent.MAX_TOOL_ROUNDS)   # 远早于 20 轮兜底

    def test_停滞先注一条换策略提醒_再真停(self):
        with tempfile.TemporaryDirectory() as d:
            hist = []
            agent.run_once("读个文件", hist, model_fn=_fail_tool_model, log_file=Path(d) / "l.jsonl", ctx={"todos": []})
            nudges = [m for m in hist if m.get("role") == "user" and "换" in str(m.get("content", ""))]
            self.assertEqual(len(nudges), 1)             # 恰注入一次换策略提醒


class 独立验收(unittest.TestCase):
    def _write_then_done_model(self):
        """先写文件（dirty）→ 再给最终答复（无 tool_calls）。"""
        steps = iter([
            {"content": "写文件", "tool_calls": [{"id": "w1", "type": "function",
             "function": {"name": "write_file", "arguments": '{"path": "out.txt", "content": "hi"}'}}]},
            {"content": "我做完了"},   # 最终答复（会触发收尾验证）
            {"content": "补好了"},     # 若验收判未达成、被驱动再修的下一轮
        ])
        return lambda m, tools=None: next(steps)

    def test_dirty且开关开_触发独立验收判未达成_追加user驱动再修不产孤儿tool(self):
        with tempfile.TemporaryDirectory() as d:
            ctx = {"todos": [], "_verify_enabled": True,
                   "_quiet_model_fn": lambda m, tools=None: {"content": "未达成：还没验证文件真写对"}}
            with permission.use_root(d):
                hist = []
                reply = agent.run_once("写个文件并确认", hist, model_fn=self._write_then_done_model(),
                                       approver=lambda *a: True, log_file=Path(d) / "l.jsonl", ctx=ctx)
            # 验收判未达成 → 追加一条 user 驱动再修 → 模型下一轮「补好了」
            self.assertEqual(reply, "补好了")
            objections = [m for m in hist if m.get("role") == "user" and "验收" in str(m.get("content", ""))]
            self.assertEqual(len(objections), 1)
            self.assertTrue(agent._ends_clean(hist))     # 没有孤儿 tool 结果

    def test_验收判达成_原样返回不多绕一轮(self):
        with tempfile.TemporaryDirectory() as d:
            ctx = {"todos": [], "_verify_enabled": True,
                   "_quiet_model_fn": lambda m, tools=None: {"content": "达成"}}
            with permission.use_root(d):
                hist = []
                reply = agent.run_once("写个文件", hist, model_fn=self._write_then_done_model(),
                                       approver=lambda *a: True, log_file=Path(d) / "l.jsonl", ctx=ctx)
            self.assertEqual(reply, "我做完了")           # 达成→原样返回

    def test_verify默认关闭_不触发验收原样返回(self):
        with tempfile.TemporaryDirectory() as d:
            called = {"n": 0}
            ctx = {"todos": [], "_quiet_model_fn": lambda m, tools=None: called.update(n=called["n"] + 1) or {"content": "未达成"}}
            with permission.use_root(d):
                hist = []
                reply = agent.run_once("写个文件", hist, model_fn=self._write_then_done_model(),
                                       approver=lambda *a: True, log_file=Path(d) / "l.jsonl", ctx=ctx)
            self.assertEqual(reply, "我做完了")           # 默认关→不验收
            self.assertEqual(called["n"], 0)              # 验收员根本没被调

    def test_验收器异常_降级跳过不阻断(self):
        def boom(m, tools=None):
            raise RuntimeError("验收员挂了")
        with tempfile.TemporaryDirectory() as d:
            ctx = {"todos": [], "_verify_enabled": True, "_quiet_model_fn": boom}
            with permission.use_root(d):
                hist = []
                reply = agent.run_once("写个文件", hist, model_fn=self._write_then_done_model(),
                                       approver=lambda *a: True, log_file=Path(d) / "l.jsonl", ctx=ctx)
            self.assertEqual(reply, "我做完了")           # 验收异常→降级原样返回


if __name__ == "__main__":
    unittest.main(verbosity=2)
