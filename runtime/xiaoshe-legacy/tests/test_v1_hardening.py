"""v1 整体体检后的加固回归（测试名全中文）。锁死本轮新增/修正的行为与跨模块接缝。

运行：`python -m unittest discover -s tests -v`
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from harness import agent, compaction, kimi_client, mcp_client, memory, permission, session
from harness import tools as tools_mod

_ECHO = str(Path(__file__).resolve().parent / "_mcp_echo_server.py")


def _tc(name, args, tc_id="t1"):
    return {"index": 0, "id": tc_id, "type": "function",
            "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}


class 脚本模型:
    def __init__(self, responses):
        self.responses = list(responses)

    def __call__(self, messages, tools=None):
        return self.responses.pop(0)


class 交互改进(unittest.TestCase):
    def test_答a按指纹分粒度_同目标不再问新目标仍问(self):
        # 1a·建议①：会话白名单从裸工具名升级为指纹——write_file 绑目标路径。
        # 答 'a' 只放行同一目标（防一次 'a' 放任改写全工作区源码）；写新文件仍各问一次。
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            with mock.patch.object(permission, "ROOT", root):
                calls = {"n": 0}

                def appr(*_a):
                    calls["n"] += 1
                    return "always"

                model = 脚本模型([
                    {"content": "", "tool_calls": [_tc("write_file", {"path": "a.txt", "content": "A"}, "t1")]},
                    {"content": "", "tool_calls": [_tc("write_file", {"path": "a.txt", "content": "A2"}, "t2")]},  # 同目标→不再问
                    {"content": "", "tool_calls": [_tc("write_file", {"path": "b.txt", "content": "B"}, "t3")]},   # 新目标→再问一次
                    {"content": "都写好了", "tool_calls": []},
                ])
                ctx = {"todos": []}
                reply = agent.run_once("写文件", [], model_fn=model, approver=appr,
                                       log_file=root / "l.jsonl", ctx=ctx)
                self.assertEqual(reply, "都写好了")
                self.assertEqual(calls["n"], 2)  # a.txt 问一次（第二次同目标不再问）、b.txt 新目标再问一次
                self.assertTrue((root / "a.txt").exists() and (root / "b.txt").exists())
                self.assertEqual((root / "a.txt").read_text(encoding="utf-8"), "A2")  # 第二次同目标写确实执行了

    def test_连续3次相同调用_追加原地打转提醒(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "a.txt").write_text("hi", encoding="utf-8")
            with mock.patch.object(permission, "ROOT", root):
                model = 脚本模型([
                    {"content": "", "tool_calls": [_tc("read_file", {"path": "a.txt"}, "t1")]},
                    {"content": "", "tool_calls": [_tc("read_file", {"path": "a.txt"}, "t2")]},
                    {"content": "", "tool_calls": [_tc("read_file", {"path": "a.txt"}, "t3")]},
                    {"content": "停", "tool_calls": []},
                ])
                history: list[dict] = []
                agent.run_once("读三次", history, model_fn=model, approver=lambda *a: True,
                               log_file=root / "l.jsonl")
                tool_contents = [m["content"] for m in history if m.get("role") == "tool"]
                self.assertTrue(any("系统提醒" in c for c in tool_contents))


class 安全加固(unittest.TestCase):
    def test_敏感文件改名规避变体也被拒(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(permission, "ROOT", Path(d)):
                for bad in ("id_rsa.bak", "credentials.old", "secrets.json.save", "id_ed25519"):
                    self.assertEqual(permission.check("read_file", {"path": bad}).action, "deny", bad)
                self.assertEqual(permission.check("read_file", {"path": "id_ed25519.pub"}).action, "approve")  # 公钥放行


class 工具健壮性(unittest.TestCase):
    def test_工具返回None或空串_normalize成有意义结果(self):
        with mock.patch.dict(tools_mod.REGISTRY, {"_t_none": lambda a, c: None, "_t_empty": lambda a, c: "   "}):
            r1 = tools_mod.execute("_t_none", {}, {})
            self.assertTrue(r1.is_error and "没有返回内容" in r1.content)
            r2 = tools_mod.execute("_t_empty", {}, {})
            self.assertIn("工具无输出", r2.content)

    def test_run_command输出统一截断_不是stdout和stderr各截双份(self):
        # 用 sys.executable 而非字面 "python"：Windows 新机 PATH 上的 python 可能是 Store 占位 stub（真解释器走 py launcher）
        cmd = f"\"{sys.executable}\" -c \"import sys; sys.stdout.write('a'*15000); sys.stderr.write('b'*15000)\""
        res = tools_mod.execute("run_command", {"command": cmd}, {})
        self.assertLess(len(res.content), 20300)  # 整条统一截到 ~20000，而非 15000+15000
        self.assertIn("已截断", res.content)


class MCP死连接(unittest.TestCase):
    def tearDown(self):
        mcp_client.shutdown()

    def test_server崩溃后_软屏蔽保序_工具留存但调用友好拒(self):
        # 2b：改「动态硬删」为「软屏蔽保序」——失效工具留在清单（护 prompt 缓存前缀），只在调用层快速拒。
        mcp_client.connect("z", sys.executable, [_ECHO])
        self.assertTrue(mcp_client.is_mcp_tool("mcp__z__echo"))
        before = [s["function"]["name"] for s in mcp_client.mcp_specs()]
        # 手动杀掉 server 进程，模拟真崩溃（与 test_mcp_softmask 用 close 的死法互补）
        client = mcp_client._SERVERS["z"]
        client.command = "no-such-mcp-server-binary-xyz"  # 2c⑧：让按启动配置的自动重连也失败（宽限救不回）
        client.proc.kill()
        client.proc.wait(timeout=5)
        with self.assertRaises(mcp_client.MCPError):
            mcp_client.call("mcp__z__echo", {"text": "x"})
        # 新契约：工具没被摘除，清单顺序/数量不变，只是被标记 down
        self.assertTrue(mcp_client.is_mcp_tool("mcp__z__echo"))
        self.assertEqual([s["function"]["name"] for s in mcp_client.mcp_specs()], before)
        self.assertTrue(mcp_client.is_down("mcp__z__echo"))
        # 再次调用快速友好拒
        with self.assertRaises(mcp_client.MCPError):
            mcp_client.call("mcp__z__echo", {"text": "y"})


class 跨模块接缝(unittest.TestCase):
    def tearDown(self):
        mcp_client.shutdown()

    def test_子agent内也能调MCP工具_结果一路带回主线(self):
        mcp_client.connect("echo", sys.executable, [_ECHO])

        class 分层模型:
            def __call__(self, messages, tools=None):
                users = [m for m in messages if m.get("role") == "user"]
                first_user = users[0]["content"] if users else ""
                if messages[-1].get("role") == "tool":
                    return {"content": "完成:" + messages[-1]["content"][:260], "tool_calls": []}  # S5 会话边界包裹更长（通道×来源两层），放宽窗口
                if "派活" in first_user:  # 主 agent
                    return {"content": "", "tool_calls": [_tc("spawn_subagent", {"task": "用 echo 回显 HI"})]}
                return {"content": "", "tool_calls": [_tc("mcp__echo__echo", {"text": "HI"})]}  # 子 agent

        with tempfile.TemporaryDirectory() as d:
            reply = agent.run_once("派活给分身", [], model_fn=分层模型(), approver=lambda *a: True,
                                   log_file=Path(d) / "l.jsonl")
        self.assertIn("echo: HI", reply)  # MCP 结果穿过 子agent 一路回到主线

    def test_子agent内部出错_收敛为is_error回主线且主不崩(self):
        class 子炸模型:
            def __call__(self, messages, tools=None):
                users = [m for m in messages if m.get("role") == "user"]
                first_user = users[0]["content"] if users else ""
                if "派活" in first_user:
                    if messages[-1].get("role") == "tool":
                        return {"content": "主收工", "tool_calls": []}
                    return {"content": "", "tool_calls": [_tc("spawn_subagent", {"task": "子任务"})]}
                raise kimi_client.KimiError("子炸了")

        with tempfile.TemporaryDirectory() as d:
            history: list[dict] = []
            reply = agent.run_once("派活给分身", history, model_fn=子炸模型(), approver=lambda *a: True,
                                   log_file=Path(d) / "l.jsonl")
        self.assertEqual(reply, "主收工")
        tool_msgs = [m for m in history if m.get("role") == "tool"]
        self.assertTrue(tool_msgs and "出错" in tool_msgs[0]["content"])
        self.assertTrue(agent._ends_clean(history))

    def test_压缩后历史_存档读档往返仍干净且刷新记忆(self):
        with tempfile.TemporaryDirectory() as d:
            mf = Path(d) / "memory.json"
            memory.remember("最新记忆XYZ", mf)
            history = [
                {"role": "system", "content": "旧的真 system 快照"},
                {"role": "system", "content": compaction.SUMMARY_PREFIX + "，供你参考】\n一段摘要"},
                {"role": "user", "content": "q"},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "t1", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}]},
                {"role": "tool", "tool_call_id": "t1", "content": "r"},
            ]
            sf = Path(d) / "s.json"
            session.save(history, [], sf)
            h = session.load(sf)["history"]
            memory.refresh_pinned_system(h, mf)
            self.assertEqual(h[0]["role"], "system")
            self.assertIn("最新记忆XYZ", h[0]["content"])                       # 首条换成最新记忆
            self.assertTrue(any(str(m.get("content", "")).startswith(compaction.SUMMARY_PREFIX) for m in h))  # 摘要未被误删
            self.assertNotIn("旧的真 system", h[0]["content"])                  # 旧快照被替掉
            self.assertTrue(agent._ends_clean(h))                              # 仍干净成对


if __name__ == "__main__":
    unittest.main(verbosity=2)
