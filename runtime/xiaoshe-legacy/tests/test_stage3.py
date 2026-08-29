"""阶段3 冒烟测试：子智能体 / 错误恢复 / 后台任务（测试名全中文）。

离线用「脚本模型」驱动，不连网。运行：`python -m unittest discover -s tests -v`
"""
import json
import re
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from harness import agent, jobs, kimi_client, memory, permission, session
from harness import tools as tools_mod


def _tc(name, args_dict, tc_id="tool_1"):
    return {"index": 0, "id": tc_id, "type": "function",
            "function": {"name": name, "arguments": json.dumps(args_dict, ensure_ascii=False)}}


class 脚本模型:
    def __init__(self, responses):
        self.responses = list(responses)

    def __call__(self, messages, tools=None):
        return self.responses.pop(0)


class 子智能体(unittest.TestCase):
    def test_spawn_subagent是安全工具_不打扰用户(self):
        self.assertEqual(permission.check("spawn_subagent", {"task": "x"}).action, "approve")

    def test_把子任务派给分身_只带回结论不污染主历史(self):
        # 同一个脚本模型被主/子共用：① 主：调 spawn_subagent ② 子：直接给结论 ③ 主：最终答复
        model = 脚本模型([
            {"content": "", "tool_calls": [_tc("spawn_subagent", {"task": "去读 A 并总结"})]},
            {"content": "子结论：A 是 X", "tool_calls": []},
            {"content": "主结论：搞定", "tool_calls": []},
        ])
        history: list[dict] = []
        with tempfile.TemporaryDirectory() as d:
            reply = agent.run_once("派个活", history, model_fn=model, approver=lambda *a: True,
                                   log_file=Path(d) / "l.jsonl")
        self.assertEqual(reply, "主结论：搞定")
        tool_msgs = [m for m in history if m.get("role") == "tool"]
        self.assertTrue(tool_msgs and "子结论：A 是 X" in tool_msgs[0]["content"])
        # 主历史只有 user/assistant(tc)/tool/assistant 四条——子 agent 的中间过程不进主对话
        self.assertEqual([m["role"] for m in history], ["user", "assistant", "tool", "assistant"])

    def test_子agent嵌套过深_被拒绝而不是无限递归(self):
        ctx = {"todos": [], "_subagent_depth": 2,
               "_model_fn": lambda m, tools=None: {"content": "x", "tool_calls": []}}
        res = tools_mod.execute("spawn_subagent", {"task": "再派一层"}, ctx)
        self.assertTrue(res.is_error)
        self.assertIn("嵌套过深", res.content)


class 错误恢复(unittest.TestCase):
    def test_会话存档_save后load拿回历史和todos(self):
        with tempfile.TemporaryDirectory() as d:
            sf = Path(d) / "s.json"
            hist = [{"role": "user", "content": "记得我"}, {"role": "assistant", "content": "记得"}]
            session.save(hist, [{"content": "A", "status": "pending"}], sf)
            loaded = session.load(sf)
            self.assertEqual(loaded["history"], hist)
            self.assertEqual(loaded["todos"][0]["content"], "A")

    def test_存档不存在或损坏_load返回None不崩(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(session.load(Path(d) / "nope.json"))
            bad = Path(d) / "bad.json"
            bad.write_text("{半截坏", encoding="utf-8")
            self.assertIsNone(session.load(bad))


class 后台任务(unittest.TestCase):
    def test_后台跑命令_危险要问_且扫敏感deny(self):
        self.assertEqual(permission.check("run_in_background", {"command": "echo hi"}).action, "ask")
        self.assertEqual(permission.check("run_in_background", {"command": "type .env"}).action, "deny")

    def test_check_background是安全工具_不打扰用户(self):
        self.assertEqual(permission.check("check_background", {"job_id": "job1"}).action, "approve")

    def test_起后台命令_跑完能查到输出(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(permission, "ROOT", Path(d)):
                ctx = {"todos": []}
                res = tools_mod.execute("run_in_background", {"command": "echo BGTEST"}, ctx)
                self.assertFalse(res.is_error)
                m = re.search(r"job-[\d-]+", res.content)  # M4：job id 带时间戳/pid，跨重启唯一
                self.assertIsNotNone(m)
                job_id = m.group(0)
                out = ""
                for _ in range(100):
                    out = tools_mod.execute("check_background", {"job_id": job_id}, ctx).content
                    if "已结束" in out:
                        break
                    time.sleep(0.05)
                self.assertIn("BGTEST", out)


class 复盘阶段3修复(unittest.TestCase):
    def test_工具轮数触上限_history干净收尾不留悬空toolcalls(self):
        class _无限:
            def __call__(self, messages, tools=None):
                return {"content": "", "tool_calls": [_tc("read_file", {"path": "README.md"}, "tid")]}

        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "README.md").write_text("hi", encoding="utf-8")
            with mock.patch.object(permission, "ROOT", root):
                history: list[dict] = []
                agent.run_once("死循环", history, model_fn=_无限(), approver=lambda *a: True,
                               log_file=root / "l.jsonl")
        self.assertTrue(agent._ends_clean(history))       # 不以悬空 tool_calls 收尾（存档 resume 才不 400）
        self.assertEqual(history[-1]["role"], "tool")     # 末尾是补上的配对结果

    def test_读档时用最新记忆刷新system_不用旧快照也不重复(self):
        with tempfile.TemporaryDirectory() as d:
            mf = Path(d) / "memory.json"
            memory.remember("新事实：用 pytest", mf)
            history = [
                {"role": "system", "content": "你是用户的本地 agent。以下是你记住的长期事实…\n- 旧事实"},
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "ok"},
            ]
            memory.refresh_pinned_system(history, mf)
        systems = [m for m in history if m["role"] == "system"]
        self.assertEqual(len(systems), 1)                 # 不重复
        self.assertIn("用 pytest", systems[0]["content"])  # 用最新记忆
        self.assertNotIn("旧事实", systems[0]["content"])   # 旧快照被替掉

    def test_轮内出错_todos随history一起回滚(self):
        calls = {"n": 0}

        def _model(messages, tools=None):
            calls["n"] += 1
            if calls["n"] == 1:
                return {"content": "", "tool_calls": [_tc("update_todos",
                        {"todos": [{"content": "半途待办", "status": "pending"}]})]}
            raise kimi_client.KimiError("boom")

        ctx = {"todos": [{"content": "原有", "status": "pending"}]}
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(kimi_client.KimiError):
                agent.run_once("干活", [], model_fn=_model, approver=lambda *a: True,
                               log_file=Path(d) / "l.jsonl", ctx=ctx)
        self.assertEqual(ctx["todos"], [{"content": "原有", "status": "pending"}])  # 回滚一致

    def test_check_background空id或不存在_友好提示不崩(self):
        self.assertIn("job_id", tools_mod.execute("check_background", {"job_id": ""}, {}).content)
        self.assertIn("没有这个后台任务", tools_mod.execute("check_background", {"job_id": "job999"}, {}).content)

    def test_jobs_shutdown后仍可查到记录_M4跨重启(self):
        # M4 语义变更：记录落盘，shutdown（乃至重启）后仍查得到历史（此前是"查不到"）。
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(jobs, "JOBS_DIR", Path(d) / "jobs"):
                jid = jobs.start("echo x", str(Path(d)))
                self.assertTrue(jobs.status(jid)["ok"])
                jobs.shutdown()
                self.assertTrue(jobs.status(jid)["ok"], "M4：记录落盘，重启后仍可查")

    def test_真实递归派分身_靠深度上限收敛不无限(self):
        class _派一次就收:
            def __call__(self, messages, tools=None):
                for m in messages:
                    if m.get("role") == "tool":
                        return {"content": "收工", "tool_calls": []}
                return {"content": "", "tool_calls": [_tc("spawn_subagent", {"task": "派"})]}

        with tempfile.TemporaryDirectory() as d:
            reply = agent.run_once("无限派", [], model_fn=_派一次就收(), approver=lambda *a: True,
                                   log_file=Path(d) / "l.jsonl")
        self.assertIn("收工", reply)  # 递归在 depth 触顶时收敛、正常返回，不栈溢出


if __name__ == "__main__":
    unittest.main(verbosity=2)
