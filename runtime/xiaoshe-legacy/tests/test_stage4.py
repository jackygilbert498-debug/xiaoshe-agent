"""阶段4 冒烟测试：MCP 对接（用自制的 echo MCP server，不依赖外部服务）。

运行：`python -m unittest discover -s tests -v`
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from harness import agent, mcp_client, permission
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


class 记录tools模型:
    """记录首次被调用时收到的 tools 入参（验证首轮就发全量工具）。"""

    def __init__(self, reply):
        self.seen_tools = None
        self.reply = reply

    def __call__(self, messages, tools=None):
        if self.seen_tools is None:
            self.seen_tools = tools
        return self.reply


class MCP对接(unittest.TestCase):
    def setUp(self):
        self.specs = mcp_client.connect("echo", sys.executable, [_ECHO])

    def tearDown(self):
        mcp_client.shutdown()

    def test_连上mcp_列出的工具带mcp前缀(self):
        names = [s["function"]["name"] for s in self.specs]
        self.assertIn("mcp__echo__echo", names)

    def test_all_specs把mcp工具并进内置工具集(self):
        names = [s["function"]["name"] for s in tools_mod.all_specs()]
        self.assertIn("read_file", names)         # 内置工具还在
        self.assertIn("mcp__echo__echo", names)   # 外部 mcp 工具也在

    def test_execute路由到mcp_server_拿回结果(self):
        res = tools_mod.execute("mcp__echo__echo", {"text": "你好"}, {})
        self.assertFalse(res.is_error)
        self.assertIn("echo: 你好", res.content)

    def test_mcp工具是外部的_默认先问用户(self):
        self.assertEqual(permission.check("mcp__echo__echo", {"text": "x"}).action, "ask")

    def test_模型调用mcp工具_经权限执行并把结果回主线(self):
        model = 脚本模型([
            {"content": "", "tool_calls": [_tc("mcp__echo__echo", {"text": "喂"})]},
            {"content": "外部工具跑完了", "tool_calls": []},
        ])
        history: list[dict] = []
        with tempfile.TemporaryDirectory() as d:
            reply = agent.run_once("用 echo 工具回显一下", history, model_fn=model,
                                   approver=lambda *a: True, log_file=Path(d) / "l.jsonl")
        self.assertEqual(reply, "外部工具跑完了")
        tool_msgs = [m for m in history if m.get("role") == "tool"]
        self.assertTrue(tool_msgs and "echo: 喂" in tool_msgs[0]["content"])

    def test_未连接的mcp工具_execute友好报错不崩(self):
        res = tools_mod.execute("mcp__nope__x", {}, {})
        self.assertTrue(res.is_error)

    def test_首轮就把mcp工具也发给模型(self):
        m = 记录tools模型({"content": "好", "tool_calls": []})
        with tempfile.TemporaryDirectory() as d:
            agent.run_once("在吗", [], model_fn=m, approver=lambda *a: True, log_file=Path(d) / "l.jsonl")
        names = [s["function"]["name"] for s in (m.seen_tools or [])]
        self.assertIn("read_file", names)
        self.assertIn("mcp__echo__echo", names)  # 第一句话就能看到外部工具

    def test_mcp结果过长_被截断不灌爆上下文(self):
        res = tools_mod.execute("mcp__echo__echo", {"text": "x" * 30000}, {})
        self.assertIn("已截断", res.content)
        self.assertLess(len(res.content), 21000)

    def test_mcp工具报错_is_error如实透传(self):
        res = tools_mod.execute("mcp__echo__echo", {"text": "__error__"}, {})
        self.assertTrue(res.is_error)
        self.assertIn("故意报错", res.content)


class MCP配置与清理(unittest.TestCase):
    def tearDown(self):
        mcp_client.shutdown()

    def test_从mcpjson自动连上_返回server数(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = Path(d) / "mcp.json"
            cfg.write_text(json.dumps([{"name": "e1", "command": sys.executable, "args": [_ECHO]}]),
                           encoding="utf-8")
            n = mcp_client.connect_configured(cfg)
            self.assertEqual(n, 1)
            self.assertTrue(mcp_client.is_mcp_tool("mcp__e1__echo"))

    def test_坏server只告警不阻断_好的照样连上(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = Path(d) / "mcp.json"
            cfg.write_text(json.dumps([
                {"name": "bad", "command": "definitely_not_a_real_command_xyz", "args": []},
                {"name": "good", "command": sys.executable, "args": [_ECHO]},
            ]), encoding="utf-8")
            n = mcp_client.connect_configured(cfg)  # 不抛异常
            self.assertEqual(n, 1)                  # 坏的跳过、好的连上
            self.assertTrue(mcp_client.is_mcp_tool("mcp__good__echo"))

    def test_shutdown后工具清空(self):
        mcp_client.connect("z", sys.executable, [_ECHO])
        self.assertTrue(mcp_client.mcp_specs())
        mcp_client.shutdown()
        self.assertEqual(mcp_client.mcp_specs(), [])
        self.assertFalse(mcp_client.is_mcp_tool("mcp__z__echo"))

    def test_mcpjson是敏感文件_写它被拒防后门(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(permission, "ROOT", Path(d)):
                self.assertEqual(permission.check("write_file", {"path": "mcp.json"}).action, "deny")
                self.assertEqual(permission.check("run_command", {"command": "echo x > mcp.json"}).action, "deny")


if __name__ == "__main__":
    unittest.main(verbosity=2)
