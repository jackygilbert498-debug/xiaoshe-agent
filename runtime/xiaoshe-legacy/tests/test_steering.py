"""基M3 增量2 · steering 注入运行中的轮次（边跑边说）。TDD 红→绿。

用户在处理中打的插话进 InputHub 的插话队列；run_once 在工具轮间隙（history 干净处）drain 出来、作 user 消息
注入本轮，让模型下一轮就看到——且**不打断不可逆动作审批**（审批走审批队列，见 test_inputhub）。
运行：仓库根 `python -m unittest tests.test_steering -v`
"""
import tempfile
import threading
import time
import unittest
from pathlib import Path

from harness import agent, inputhub


def _tool_then_done(steer_lines_seen):
    """第一轮调一次 read_file，其后收尾。用于制造「工具轮间隙」让 steering 有机会注入。"""
    calls = [0]

    def model(messages, tools=None):
        calls[0] += 1
        # 记录本次模型看到的 history 里有没有插话（第二轮应看到）
        steer_lines_seen.append([m.get("content") for m in messages if m.get("role") == "user"])
        if calls[0] == 1:
            return {"content": "", "tool_calls": [
                {"id": "A", "type": "function",
                 "function": {"name": "read_file", "arguments": '{"path": "nofile"}'}}]}
        return {"content": "好的，按你插话调整了", "tool_calls": []}
    return model


class steering注入(unittest.TestCase):
    def test_插话在工具轮间隙作user消息注入(self):
        hub = inputhub.InputHub()
        hub._route("其实你先看下 b 文件")     # 用户处理中打的插话（进插话队列）
        seen = []
        with tempfile.TemporaryDirectory() as d:
            agent.run_once("看下 a 文件", [], model_fn=_tool_then_done(seen),
                           approver=lambda *a: True, log_file=Path(d) / "l.jsonl",
                           ctx={"todos": [], "_inputhub": hub})
        # history 里出现了「用户插话」这条 user 消息
        # （通过第二轮模型看到的 user 消息里含插话验证）
        second_round_users = seen[1]
        self.assertTrue(any("用户插话" in (u or "") and "b 文件" in (u or "") for u in second_round_users),
                        f"第二轮模型应看到插话，实际：{second_round_users}")

    def test_无插话时不注入(self):
        hub = inputhub.InputHub()   # 空插话队列
        seen = []
        with tempfile.TemporaryDirectory() as d:
            agent.run_once("看下 a 文件", [], model_fn=_tool_then_done(seen),
                           approver=lambda *a: True, log_file=Path(d) / "l.jsonl",
                           ctx={"todos": [], "_inputhub": hub})
        second_round_users = seen[1]
        self.assertFalse(any("用户插话" in (u or "") for u in second_round_users))

    def test_没有hub也不崩(self):
        seen = []
        with tempfile.TemporaryDirectory() as d:
            r = agent.run_once("看下 a 文件", [], model_fn=_tool_then_done(seen),
                               approver=lambda *a: True, log_file=Path(d) / "l.jsonl",
                               ctx={"todos": []})   # ctx 无 _inputhub
        self.assertIn("好的", r)

    def test_红队_子agent不drain主线插话(self):
        hub = inputhub.InputHub()
        hub._route("主线插话")
        hist = []
        with tempfile.TemporaryDirectory() as d:
            agent._drain_steering({"_inputhub": hub, "_subagent_depth": 1}, hist, Path(d) / "l.jsonl")
        self.assertEqual(hist, [])                                    # 子 agent(depth>0) 不注入
        self.assertEqual(hub.next_message(timeout=0.01), "主线插话")   # 插话原样留给主线


class 红队EOF健壮(unittest.TestCase):
    def test_approver在EOF后默认拒不卡死(self):
        hub = inputhub.InputHub()
        hub.set_closed()   # EOF：没人再投答案
        approver = agent._make_hub_approver(hub, is_tty=lambda: True)
        self.assertFalse(approver("t", {}, ""))   # 不永久轮询、默认拒

    def test_reader在EOF后置closed通知consumer(self):
        hub = inputhub.InputHub()
        stop = threading.Event()
        agent._stdin_reader(hub, stop, read_line=lambda: "")   # 立即 EOF
        self.assertTrue(hub.is_closed())
        self.assertTrue(stop.is_set())


class hub审批(unittest.TestCase):
    def _ask(self, hub, approver, answer, tool="t"):
        """真实流程：approver 先 begin_approval(抽干残留)+弹提示，用户之后才作答。
        故在另一线程跑 approver，待其进入审批模式再投答案（不能预置——预置会被 begin_approval 抽干，正是红队 HIGH 要防的）。"""
        box = {}
        th = threading.Thread(target=lambda: box.__setitem__("v", approver(tool, {}, "")))
        th.start()
        for _ in range(400):
            if hub._approving.is_set():   # approver 已 begin_approval（抽干完、置模式）
                break
            time.sleep(0.005)
        hub._route(answer)
        th.join(timeout=2.0)
        self.assertFalse(th.is_alive())
        return box.get("v")

    def test_approver从审批队列取答案并分类(self):
        hub = inputhub.InputHub()
        approver = agent._make_hub_approver(hub, is_tty=lambda: True)
        self.assertIs(self._ask(hub, approver, "y"), True)
        self.assertEqual(self._ask(hub, approver, "a"), "always")
        self.assertFalse(self._ask(hub, approver, "n"))

    def test_approver非交互默认拒(self):
        hub = inputhub.InputHub()
        approver = agent._make_hub_approver(hub, is_tty=lambda: False)
        self.assertFalse(approver("t", {}, ""))   # 无 TTY → 拒，不读队列

    def test_approver轮询中插话不被当答案_另线程投y才返回(self):
        # 劫持防护端到端：审批期先有插话在插话队列、approver 只从审批队列取；另一线程投 y 才返回。
        hub = inputhub.InputHub()
        hub._route("你顺便看下天气")   # 非审批期插话 → 插话队列
        approver = agent._make_hub_approver(hub, is_tty=lambda: True)
        result = {}
        def do():
            result["v"] = approver("run_command", {}, "")
        th = threading.Thread(target=do); th.start()
        th.join(timeout=0.5)
        self.assertTrue(th.is_alive())          # 还在等——插话没被当答案放行
        hub._route("y")                          # 审批期(approver 已 begin_approval) → 审批队列
        th.join(timeout=1.0)
        self.assertFalse(th.is_alive())
        self.assertIs(result["v"], True)         # 真正的 y 才放行
        self.assertEqual(hub.next_message(timeout=0.01), "你顺便看下天气")  # 插话仍在、原样留存


class stdin读者(unittest.TestCase):
    def test_逐行投递并在EOF置stop(self):
        hub = inputhub.InputHub()
        stop = threading.Event()
        lines = iter(["第一句\n", "第二句\n", ""])   # "" = EOF
        agent._stdin_reader(hub, stop, read_line=lambda: next(lines))
        self.assertTrue(stop.is_set())
        self.assertEqual(hub.next_message(timeout=0.01), "第一句")
        self.assertEqual(hub.next_message(timeout=0.01), "第二句")

    def test_审批期读到的行进审批队列(self):
        hub = inputhub.InputHub()
        stop = threading.Event()
        hub.begin_approval()
        lines = iter(["y\n", ""])
        agent._stdin_reader(hub, stop, read_line=lambda: next(lines))
        self.assertEqual(hub.next_approval(timeout=0.01), "y")   # 审批期 → 审批队列
        self.assertIsNone(hub.next_message(timeout=0.01))        # 不进插话队列


if __name__ == "__main__":
    unittest.main(verbosity=2)
