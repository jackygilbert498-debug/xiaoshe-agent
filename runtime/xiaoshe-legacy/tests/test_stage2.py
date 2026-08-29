"""阶段2 冒烟测试：任务清单 / 上下文压缩 / 记忆（测试名全中文）。

离线用「脚本模型」驱动，不连网。运行：`python -m unittest discover -s tests -v`
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from harness import agent, compaction, memory, permission
from harness import tools as tools_mod


def _tc(name, args_dict, tc_id="tool_1"):
    return {"index": 0, "id": tc_id, "type": "function",
            "function": {"name": name, "arguments": json.dumps(args_dict, ensure_ascii=False)}}


class 脚本模型:
    def __init__(self, responses):
        self.responses = list(responses)

    def __call__(self, messages, tools=None):
        return self.responses.pop(0)


class 任务清单(unittest.TestCase):
    def test_update_todos是安全工具_直接放行不打扰用户(self):
        self.assertEqual(permission.check("update_todos", {"todos": []}).action, "approve")

    def test_模型列计划_清单存进ctx且回勾选视图(self):
        ctx = {"todos": []}

        def _拒绝(*_a):
            raise AssertionError("update_todos 是安全工具，不该问用户")

        model = 脚本模型([
            {"content": "", "tool_calls": [_tc("update_todos", {"todos": [
                {"content": "读配置", "status": "in_progress"},
                {"content": "改代码", "status": "pending"},
            ]})]},
            {"content": "计划列好了", "tool_calls": []},
        ])
        with tempfile.TemporaryDirectory() as d:
            reply = agent.run_once("干个多步活", [], model_fn=model, approver=_拒绝,
                                   log_file=Path(d) / "l.jsonl", ctx=ctx)
        self.assertEqual(reply, "计划列好了")
        self.assertEqual(len(ctx["todos"]), 2)
        self.assertEqual(ctx["todos"][0]["status"], "in_progress")
        self.assertIn("[~]", tools_mod.render_todos(ctx["todos"]))
        self.assertIn("[ ]", tools_mod.render_todos(ctx["todos"]))

    def test_todos跨轮更新_completed会被记住(self):
        ctx = {"todos": []}
        history: list[dict] = []
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "l.jsonl"
            model1 = 脚本模型([
                {"content": "", "tool_calls": [_tc("update_todos", {"todos": [
                    {"content": "步骤A", "status": "in_progress"}]})]},
                {"content": "开始了", "tool_calls": []},
            ])
            agent.run_once("第一步", history, model_fn=model1, approver=lambda *a: True, log_file=log, ctx=ctx)
            model2 = 脚本模型([
                {"content": "", "tool_calls": [_tc("update_todos", {"todos": [
                    {"content": "步骤A", "status": "completed"}]})]},
                {"content": "做完了", "tool_calls": []},
            ])
            agent.run_once("收尾", history, model_fn=model2, approver=lambda *a: True, log_file=log, ctx=ctx)
        self.assertEqual(ctx["todos"][0]["status"], "completed")


class 上下文压缩(unittest.TestCase):
    def test_历史没超预算_不压缩(self):
        history = [{"role": "user", "content": "短"}, {"role": "assistant", "content": "也短"}]
        before = [dict(m) for m in history]
        did = compaction.maybe_compact(history, model_fn=None, summarizer=lambda o, m: "x")
        self.assertFalse(did)
        self.assertEqual(history, before)

    def test_历史超预算_压成摘要并保留最近的用户消息(self):
        history = []
        for i in range(40):
            role = "user" if i % 2 == 0 else "assistant"
            history.append({"role": role, "content": f"消息{i} " + "x" * 400})
        last_user = [m["content"] for m in history if m["role"] == "user"][-1]
        did = compaction.maybe_compact(history, model_fn=None, budget_chars=2000,
                                       keep_recent=6, summarizer=lambda o, m: "这是摘要")
        self.assertTrue(did)
        self.assertLess(len(history), 40)
        # 1c·建议⑥：摘要前多了「最初原话逐字」系统消息 → 摘要不再必在 [0]，改断言其在场
        self.assertTrue(any(str(m.get("content", "")).startswith(compaction.SUMMARY_PREFIX) for m in history))
        self.assertIn(last_user, [m.get("content") for m in history])  # 最近的用户消息还在
        self.assertTrue(any(str(m.get("content", "")).startswith(compaction._FIRST_USER_PREFIX) for m in history))  # 最初原话逐字留存

    def test_压缩后保留段以user开头_不留孤儿工具结果(self):
        history = []
        for i in range(10):
            history.append({"role": "user", "content": "问 " + "y" * 400})
            history.append({"role": "assistant", "content": "",
                            "tool_calls": [{"id": f"t{i}", "type": "function",
                                            "function": {"name": "read_file", "arguments": "{}"}}]})
            history.append({"role": "tool", "tool_call_id": f"t{i}", "content": "结果 " + "z" * 400})
        did = compaction.maybe_compact(history, model_fn=None, budget_chars=2000,
                                       keep_recent=4, summarizer=lambda o, m: "S")
        self.assertTrue(did)
        non_system = [m for m in history if m.get("role") != "system"]
        self.assertEqual(non_system[0]["role"], "user")  # 保留段第一条是 user，不是孤儿 tool

    def test_压缩器出错_跳过不报错且历史不变(self):
        history = [{"role": "user", "content": "x" * 500} for _ in range(40)]
        n = len(history)

        def _boom(old, model_fn):
            raise RuntimeError("摘要挂了")

        did = compaction.maybe_compact(history, model_fn=None, budget_chars=1000, summarizer=_boom)
        self.assertFalse(did)
        self.assertEqual(len(history), n)

    def test_run_once超长历史_会先压缩再正常回话(self):
        ctx = {"todos": []}
        # 真·超长：~720k 字符(≈18万 token)，同时越过 token 网(12.8万)与字符网(F03 后 38.4万)，
        # 不依赖某一网的具体阈值——run_once 必先压缩。（原用 40k 字符是按旧 24000 字符网校准的）
        history = [{"role": "user" if i % 2 == 0 else "assistant", "content": "老消息 " + "x" * 6000}
                   for i in range(120)]
        model = 脚本模型([{"content": "新回复", "tool_calls": []}])
        with tempfile.TemporaryDirectory() as d:
            reply = agent.run_once("新问题", history, model_fn=model, approver=lambda *a: True,
                                   log_file=Path(d) / "l.jsonl", ctx=ctx, summarizer=lambda o, m: "压缩摘要")
        self.assertEqual(reply, "新回复")
        self.assertTrue(any(str(m.get("content", "")).startswith(compaction.SUMMARY_PREFIX) for m in history))


class 记忆系统(unittest.TestCase):
    def test_remember是安全工具_不打扰用户(self):
        self.assertEqual(permission.check("remember", {"fact": "x"}).action, "approve")

    def test_remember写入后load能读回_且去重(self):
        with tempfile.TemporaryDirectory() as d:
            mf = Path(d) / "memory.json"
            self.assertTrue(memory.remember("用户喜欢简体中文", mf))
            self.assertFalse(memory.remember("用户喜欢简体中文", mf))  # 同一事实去重
            self.assertEqual(memory.load(mf), ["用户喜欢简体中文"])

    def test_system_message把记忆拼成系统提示(self):
        with tempfile.TemporaryDirectory() as d:
            mf = Path(d) / "memory.json"
            memory.remember("项目根在 D 盘", mf)
            msg = memory.system_message(mf)
            self.assertEqual(msg["role"], "system")
            self.assertIn("项目根在 D 盘", msg["content"])

    def test_没有记忆时_system_message仍给出行为纪律(self):
        # 改版：行为纪律恒在，不再因无记忆而返回 None；有记忆时才另拼事实段
        with tempfile.TemporaryDirectory() as d:
            msg = memory.system_message(Path(d) / "memory.json")
            self.assertIsNotNone(msg)
            self.assertEqual(msg["role"], "system")
            self.assertIn("小蛇", msg["content"])       # 行为纪律在
            self.assertIn("read_file", msg["content"])  # 专用工具引导在
            self.assertNotIn("供参考", msg["content"])   # 没记忆就不挂事实段

    def test_模型用remember工具_事实真的落盘且跨会话可读(self):
        with tempfile.TemporaryDirectory() as d:
            mf = Path(d) / "memory.json"
            ctx = {"todos": [], "memory_file": mf}
            model = 脚本模型([
                {"content": "", "tool_calls": [_tc("remember", {"fact": "用户是 Vibe Coder"})]},
                {"content": "记住了", "tool_calls": []},
            ])

            def _拒绝(*_a):
                raise AssertionError("remember 是安全工具，不该问用户")

            reply = agent.run_once("记一下我是 Vibe Coder", [], model_fn=model, approver=_拒绝,
                                   log_file=Path(d) / "l.jsonl", ctx=ctx)
            self.assertEqual(reply, "记住了")
            self.assertIn("用户是 Vibe Coder", memory.load(mf))  # 关掉再开也读得到


class 复盘修复回归(unittest.TestCase):
    def test_单user长工具链_也压得动不再静默失效(self):
        history = [{"role": "user", "content": "一个目标"}]
        for i in range(15):
            history.append({"role": "assistant", "content": "",
                            "tool_calls": [{"id": f"t{i}", "type": "function",
                                            "function": {"name": "read_file", "arguments": "{}"}}]})
            history.append({"role": "tool", "tool_call_id": f"t{i}", "content": "结果 " + "z" * 400})
        did = compaction.maybe_compact(history, model_fn=None, budget_chars=2000,
                                       keep_recent=6, summarizer=lambda o, m: "S")
        self.assertTrue(did, "单 user + 长工具链也必须压得动，否则安全网静默失效")
        non_sys = [m for m in history if m.get("role") != "system"]
        self.assertNotEqual(non_sys[0].get("role"), "tool")  # 保留段不以孤儿 tool 开头

    def test_记忆文件损坏_备份后返回空且不静默覆盖(self):
        with tempfile.TemporaryDirectory() as d:
            mf = Path(d) / "memory.json"
            mf.write_text("{这是半截坏 json", encoding="utf-8")
            self.assertEqual(memory.load_or_quarantine(mf), [])  # 写入路径隔离（#37 后隔离挪到这）
            baks = list(Path(d).glob("memory.json.corrupt*"))
            self.assertTrue(baks, "损坏文件应被备份而不是被静默覆盖")

    def test_update_todos_空内容项被过滤掉(self):
        ctx = {"todos": []}
        tools_mod.execute("update_todos", {"todos": [
            {"content": "真任务", "status": "pending"},
            {"content": "   ", "status": "pending"},
            {"status": "pending"},
        ]}, ctx)
        self.assertEqual(len(ctx["todos"]), 1)
        self.assertEqual(ctx["todos"][0]["content"], "真任务")


if __name__ == "__main__":
    unittest.main(verbosity=2)
