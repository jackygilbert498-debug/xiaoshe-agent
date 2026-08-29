"""P2 · 2b：MCP 失效 server「软屏蔽保序」替代「动态硬删」。TDD 红→绿。

旧行为：server 挂了就把它的工具从清单里删掉——工具数组变短/错位，**打碎 prompt 缓存前缀**
（all_specs 每轮全量发给模型）。新行为：失效 server 的工具**留在清单、保序保数**（字节稳定、
护住缓存前缀），改在调用层"快速友好拒"，且不再去戳已死进程。这就是评审要的"软屏蔽替代动态删"。
`all_specs(masked=)` 那个当前无调用者的 knob 按 YAGNI 缓做——保序意图已由本项兑现。
运行：仓库根 `python -m unittest discover -s tests -v`
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from harness import mcp_client
from harness import tools as tools_mod

_ECHO = str(Path(__file__).resolve().parent / "_mcp_echo_server.py")


class MCP失效软屏蔽保序(unittest.TestCase):
    def tearDown(self):
        mcp_client.shutdown()

    def test_server失效后工具保序留存_调用快速友好拒(self):
        mcp_client.connect("echo", sys.executable, [_ECHO])
        before = [s["function"]["name"] for s in mcp_client.mcp_specs()]
        self.assertIn("mcp__echo__echo", before)
        client, _ = mcp_client._MCP_TOOLS["mcp__echo__echo"]
        client.command = "no-such-mcp-server-binary-xyz"  # 2c⑧：让按启动配置的自动重连也失败（宽限救不回）
        client.close()  # 底层进程真死了

        # 第一次调用踩到失效 → 自动重连也失败 → 标记 down 并抛 MCPError（execute 会收敛成 is_error）
        with self.assertRaises(mcp_client.MCPError):
            mcp_client.call("mcp__echo__echo", {"text": "hi"})

        # 关键：软屏蔽保序——工具没被删，清单顺序/数量不变（护 prompt 缓存前缀）
        after = [s["function"]["name"] for s in mcp_client.mcp_specs()]
        self.assertEqual(after, before)
        self.assertTrue(mcp_client.is_down("mcp__echo__echo"))

        # 再次调用：直接友好拒、不再戳已死进程（快速失败）
        with self.assertRaises(mcp_client.MCPError):
            mcp_client.call("mcp__echo__echo", {"text": "hi2"})

    def test_execute对失效mcp工具给友好is_error不崩(self):
        mcp_client.connect("echo", sys.executable, [_ECHO])
        client, _ = mcp_client._MCP_TOOLS["mcp__echo__echo"]
        client.command = "no-such-mcp-server-binary-xyz"  # 2c⑧：自动重连也失败，才会走到 down 路径
        client.close()
        res = tools_mod.execute("mcp__echo__echo", {"text": "hi"}, {})
        self.assertTrue(res.is_error)

    def test_健康server不被误标down(self):
        mcp_client.connect("echo", sys.executable, [_ECHO])
        self.assertFalse(mcp_client.is_down("mcp__echo__echo"))
        text, is_err = mcp_client.call("mcp__echo__echo", {"text": "ok"})
        self.assertFalse(is_err)
        self.assertFalse(mcp_client.is_down("mcp__echo__echo"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
