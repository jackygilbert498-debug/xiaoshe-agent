"""P5 · 5d ADaPT 按需分解。TDD 红→绿。

复用 5c 的 _StepGauge 停滞信号（不另造计数）：卡住（连续 STALL_LIMIT 轮无进展）时，顶层（depth==0）
注入**真分解引导**——明确让模型停止重复、把卡住的目标拆成 2-4 个可独立验证的子任务、用 spawn_subagent
逐个派出（ADaPT 的 as-needed decompose：执行器先直接试，仅卡住才拆，绝不预先过度规划）。
防失控三道闸：① 次数上限 MAX_DECOMPOSE_HINTS（每回合注入分解引导次数，用尽退回纯换策略提醒）；
② 子 agent（depth>0）永不劝拆（防层层递归）；③ 递归深度由 spawn 既有 SUBAGENT_MAX_DEPTH 上限收敛。
计数每回合 run_once 进入处重置（防会话级 ctx 泄漏永久耗尽），并纳入回滚快照（失败轮与 history 一并还原）。
注入走 role=user（与 5c 软提醒同范式，非 mid-对话 system），发生在工具结果配对后——不留未配对 tool_calls（resume 不中毒）。全离线。
运行：仓库根 `python -m unittest tests.test_adapt -v`
"""
import tempfile
import unittest
from pathlib import Path

from harness import agent, tools


def _fail_model(_m, tools=None):
    """恒 read 不存在文件 → 工具恒 error（模拟卡住空转）。"""
    return {"content": "", "tool_calls": [{"id": "t1", "type": "function",
            "function": {"name": "read_file", "arguments": '{"path": "无此文件_zzz"}'}}]}


def _fail_then_boom_model():
    """先恒 error 卡住（触发分解引导）→ 下一次模型调用直接炸（验回滚把分解计数一并还原）。"""
    calls = {"n": 0}

    def m(_msgs, tools=None):
        calls["n"] += 1
        if calls["n"] <= 4:   # 首轮 + 3 个工具轮（第 3 轮后 stall==3 注引导），第 4 次 _send 时炸
            return _fail_model(_msgs)
        raise RuntimeError("模型挂了")
    return m


def _progress_model():
    """先成功读一次（有进展）→ 再给最终答复。"""
    steps = iter([
        {"content": "", "tool_calls": [{"id": "r1", "type": "function",
         "function": {"name": "update_todos", "arguments": '{"todos": [{"content": "一步", "status": "completed"}]}'}}]},
        {"content": "好了"},
    ])
    return lambda m, tools=None: next(steps)


def _mixed_model():
    """一轮内两个工具：一个成功（update_todos）、一个报错（read 不存在文件）→ 部分成功=有进展。"""
    steps = iter([
        {"content": "", "tool_calls": [
            {"id": "a", "type": "function",
             "function": {"name": "update_todos", "arguments": '{"todos": [{"content": "x", "status": "completed"}]}'}},
            {"id": "b", "type": "function",
             "function": {"name": "read_file", "arguments": '{"path": "无此文件_zzz"}'}},
        ]},
        {"content": "部分成功也算推进"},
    ])
    return lambda m, tools=None: next(steps)


def _nudges(hist):
    return [str(m.get("content", "")) for m in hist if m.get("role") == "user" and "系统提醒" in str(m.get("content", ""))]


def _assert_all_paired(tc, hist):
    """每个带 tool_calls 的 assistant，其全部 id 在下一条 assistant 之前都有配对 tool 结果（resume 不中毒红线）。"""
    for i, m in enumerate(hist):
        if m.get("role") == "assistant" and m.get("tool_calls"):
            ids = {c.get("id") for c in m["tool_calls"]}
            nxt = next((j for j in range(i + 1, len(hist)) if hist[j].get("role") == "assistant"), len(hist))
            seg = {x.get("tool_call_id") for x in hist[i + 1:nxt] if x.get("role") == "tool"}
            tc.assertTrue(ids <= seg, f"第 {i} 条 assistant 有未配对 tool_calls：{ids - seg}")


class ADaPT分解引导(unittest.TestCase):
    def test_顶层连续无进展_停滞提醒含拆子任务引导(self):
        with tempfile.TemporaryDirectory() as d:
            hist = []
            agent.run_once("干个大活", hist, model_fn=_fail_model, log_file=Path(d) / "l.jsonl", ctx={"todos": []})
            ns = _nudges(hist)
            self.assertEqual(len(ns), 1)                         # 恰一次
            self.assertIn("spawn_subagent", ns[0])               # 顶层含分解引导
            self.assertIn("子任务", ns[0])

    def test_子agent内depth大于0_提醒不含拆子任务引导_防层层递归(self):
        with tempfile.TemporaryDirectory() as d:
            hist = []
            agent.run_once("子活", hist, model_fn=_fail_model, log_file=Path(d) / "l.jsonl",
                           ctx={"todos": [], "_subagent_depth": 1})
            ns = _nudges(hist)
            self.assertEqual(len(ns), 1)
            self.assertNotIn("spawn_subagent", ns[0])            # 子 agent 不再劝拆（防层层递归）

    def test_有进展不触发任何停滞提醒(self):
        with tempfile.TemporaryDirectory() as d:
            hist = []
            agent.run_once("小活", hist, model_fn=_progress_model(), approver=lambda *a: True,
                           log_file=Path(d) / "l.jsonl", ctx={"todos": []})
            self.assertEqual(_nudges(hist), [])                  # 有进展→不提醒


class 分解档位与上限(unittest.TestCase):
    def test_分解引导在停滞3档注入_5档仍按原节奏干净停(self):
        with tempfile.TemporaryDirectory() as d:
            ctx = {"todos": []}
            hist = []
            reply = agent.run_once("卡住的活", hist, model_fn=_fail_model,
                                   log_file=Path(d) / "l.jsonl", ctx=ctx)
            ns = _nudges(hist)
            self.assertEqual(len(ns), 1)                         # 3 档恰注一次分解引导
            self.assertIn("spawn_subagent", ns[0])
            self.assertIn("无进展", reply)                       # 5 档仍按既有节奏干净收尾停
            self.assertTrue(agent._ends_clean(hist))
            self.assertEqual(ctx["_decompose_hints"], 1)         # 分解计数落 ctx（可观测）

    def test_分解引导次数上限_用尽后退回纯换策略提醒(self):
        ctx = {"_subagent_depth": 0}
        t1, k1 = agent._stall_reminder(ctx)
        self.assertIn("spawn_subagent", t1)                      # 第一次：分解引导
        self.assertEqual(k1, "decompose_hint")
        t2, k2 = agent._stall_reminder(ctx)                      # 已达 MAX_DECOMPOSE_HINTS
        self.assertNotIn("spawn_subagent", t2)                   # 退回纯换策略提醒
        self.assertEqual(k2, "stall_nudge")
        self.assertEqual(agent.MAX_DECOMPOSE_HINTS, 1)           # 次数上限常量化

    def test_分解引导只给顶层_子agent永远纯换策略提醒(self):
        ctx = {"_subagent_depth": 1}
        t, k = agent._stall_reminder(ctx)
        self.assertNotIn("spawn_subagent", t)
        self.assertEqual(k, "stall_nudge")
        self.assertEqual(ctx.get("_decompose_hints", 0), 0)      # 子 agent 不消耗分解预算

    def test_跨用户轮分解计数每轮重置_再次卡住能再次触发(self):
        with tempfile.TemporaryDirectory() as d:
            ctx = {"todos": []}                                   # 会话级共享 ctx（repl 形态）
            for _ in range(2):
                hist = []
                agent.run_once("又卡住了", hist, model_fn=_fail_model,
                               log_file=Path(d) / "l.jsonl", ctx=ctx)
                ns = _nudges(hist)
                self.assertEqual(len(ns), 1)
                self.assertIn("spawn_subagent", ns[0])           # 每轮都拿到新的分解预算
            self.assertEqual(ctx["_decompose_hints"], 1)         # 进入处重置→不被首轮钉死


class 正常流程零打扰(unittest.TestCase):
    def test_一轮多工具部分成功_不算卡住不注入分解引导(self):
        with tempfile.TemporaryDirectory() as d:
            hist = []
            reply = agent.run_once("混合活", hist, model_fn=_mixed_model(), approver=lambda *a: True,
                                   log_file=Path(d) / "l.jsonl", ctx={"todos": []})
            self.assertEqual(reply, "部分成功也算推进")
            self.assertEqual(_nudges(hist), [])                  # 部分成功=有进展，不误判卡住


class 回滚与配对红线(unittest.TestCase):
    def test_回合异常回滚_分解计数与history一并还原(self):
        with tempfile.TemporaryDirectory() as d:
            ctx = {"todos": []}
            hist = []
            with self.assertRaises(RuntimeError):
                agent.run_once("卡到一半模型挂了", hist, model_fn=_fail_then_boom_model(),
                               log_file=Path(d) / "l.jsonl", ctx=ctx)
            self.assertEqual(hist, [])                           # 整表回滚（含已注入的分解引导）
            self.assertEqual(ctx["_decompose_hints"], 0)         # 计数一并还原，下轮重试能再触发

    def test_分解引导以user角色注入_不留未配对tool_calls_resume不中毒(self):
        with tempfile.TemporaryDirectory() as d:
            hist = []
            agent.run_once("卡住的活", hist, model_fn=_fail_model,
                           log_file=Path(d) / "l.jsonl", ctx={"todos": []})
            hints = [m for m in hist if "spawn_subagent" in str(m.get("content", ""))]
            self.assertEqual(len(hints), 1)
            self.assertEqual(hints[0].get("role"), "user")       # 既有范式注入，非 mid-对话 system
            _assert_all_paired(self, hist)                       # 无未配对 tool_calls
            self.assertTrue(agent._ends_clean(hist))


class 子上下文独立(unittest.TestCase):
    def test_子agent的child_ctx分解计数独立_不继承父状态(self):
        with tempfile.TemporaryDirectory() as d:
            parent = {"todos": [], "_decompose_hints": 1, "memory_file": Path(d) / "m.md"}
            reply, child = tools._run_one_subagent("小活", parent,
                                                   lambda m, tools=None: {"content": "done"},
                                                   lambda *a: True, Path(d) / "l.jsonl", 0)
            self.assertEqual(reply, "done")
            self.assertEqual(child["_decompose_hints"], 0)       # 子独立计数（且 depth>0 永不注入）
            self.assertEqual(child["_subagent_depth"], 1)
            self.assertEqual(parent["_decompose_hints"], 1)      # 父状态不被子污染

    def test_分解落到spawn受嵌套上限收敛_不无限递归拆(self):
        with tempfile.TemporaryDirectory() as d:
            # depth 已达上限的 ctx 再 spawn → 既有护栏拒绝（分解递归由 spawn 深度上限收敛，不另造一套）
            ctx = {"todos": [], "_subagent_depth": tools.config.SUBAGENT_MAX_DEPTH,
                   "_model_fn": lambda m, tools=None: {"content": "x"}}
            with self.assertRaises(RuntimeError) as e:
                tools._spawn_subagent({"task": "再拆一层"}, ctx)
            self.assertIn("嵌套过深", str(e.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
