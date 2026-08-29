"""批 2 尾欠（batch2p3）· 2c 建议⑧：MCP 失败重连宽限。TDD 红→绿。

旧行为：call 遇 MCPError 直接把 client 加进 _DOWN 永久软屏蔽——一次瞬时抖动就永久失联。
新行为：connect() 留存启动配置；call 遇 MCPError（协议级 error 与传输级失败同路径）先按原配置
重启 server（关旧进程防泄漏、工具名映射复用旧前缀护缓存）重发本次调用**恰一次**，再失败才 _DOWN；
DOWN 后快速拒、绝不再重启（防重连风暴）。
运行：仓库根 `py -3 -m unittest tests.test_mcp_reconnect -v`
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from harness import mcp_client

_ECHO = str(Path(__file__).resolve().parent / "_mcp_echo_server.py")


class MCP失败重连宽限(unittest.TestCase):
    def tearDown(self):
        mcp_client.shutdown()

    def test_MCP瞬时失败自动重连一次后成功(self):
        mcp_client.connect("echo", sys.executable, [_ECHO])
        names_before = [s["function"]["name"] for s in mcp_client.mcp_specs()]
        old_client, _ = mcp_client._MCP_TOOLS["mcp__echo__echo"]
        old_client.close()   # 模拟 server 进程猝死（瞬时失败）

        text, is_err = mcp_client.call("mcp__echo__echo", {"text": "hi"})
        self.assertFalse(is_err)
        self.assertIn("echo: hi", text)                                # 重连后重发成功
        self.assertFalse(mcp_client.is_down("mcp__echo__echo"))        # 没进软屏蔽

        new_client, _ = mcp_client._MCP_TOOLS["mcp__echo__echo"]
        self.assertIsNot(new_client, old_client)                       # 真换了新进程
        self.assertIsNotNone(old_client.proc.poll())                   # 旧进程已回收，不泄漏
        names_after = [s["function"]["name"] for s in mcp_client.mcp_specs()]
        self.assertEqual(names_after, names_before)                    # 旧前缀复用，护 prompt 缓存前缀

    def test_重连仍失败才软屏蔽(self):
        mcp_client.connect("echo", sys.executable, [_ECHO])
        names_before = [s["function"]["name"] for s in mcp_client.mcp_specs()]
        old_client, _ = mcp_client._MCP_TOOLS["mcp__echo__echo"]
        old_client.close()
        with mock.patch.object(mcp_client, "MCPClient", side_effect=OSError("装不起来")) as mc:
            with self.assertRaises(mcp_client.MCPError):
                mcp_client.call("mcp__echo__echo", {"text": "hi"})
            self.assertEqual(mc.call_count, 1)                         # 重启尝试恰一次
            self.assertTrue(mcp_client.is_down("mcp__echo__echo"))     # 重启也失败 → 才软屏蔽
            with self.assertRaises(mcp_client.MCPError):
                mcp_client.call("mcp__echo__echo", {"text": "again"})
            self.assertEqual(mc.call_count, 1)                         # DOWN 后快速拒，不再重启（防重连风暴）
        names_after = [s["function"]["name"] for s in mcp_client.mcp_specs()]
        self.assertEqual(names_after, names_before)                    # 软屏蔽保序不变

    def test_重连成功但重发仍失败才软屏蔽(self):
        mcp_client.connect("echo", sys.executable, [_ECHO])
        old_client, _ = mcp_client._MCP_TOOLS["mcp__echo__echo"]
        old_client.close()
        stub = mock.Mock()
        stub.call_tool.side_effect = mcp_client.MCPError("协议错误")
        with mock.patch.object(mcp_client, "MCPClient", return_value=stub):
            with self.assertRaises(mcp_client.MCPError):
                mcp_client.call("mcp__echo__echo", {"text": "hi"})
        stub.call_tool.assert_called_once_with("echo", {"text": "hi"})  # 重发恰一次
        stub.close.assert_called_once()                                 # 失败的新 client 也回收，不泄漏
        self.assertIn(stub, mcp_client._DOWN)                           # 重发仍失败 → 新 client 进软屏蔽
        self.assertTrue(mcp_client.is_down("mcp__echo__echo"))

    def test_协议级error也走重连路径(self):
        # 方案核实发现：协议级 error（JSON-RPC error 响应）与传输级失败都走重连路径。
        mcp_client.connect("echo", sys.executable, [_ECHO])
        old_client, _ = mcp_client._MCP_TOOLS["mcp__echo__echo"]
        with mock.patch.object(old_client, "call_tool",
                               side_effect=mcp_client.MCPError("MCP 返回错误：boom")):
            text, is_err = mcp_client.call("mcp__echo__echo", {"text": "yo"})
        self.assertFalse(is_err)
        self.assertIn("echo: yo", text)                                # 重连后重发成功
        new_client, _ = mcp_client._MCP_TOOLS["mcp__echo__echo"]
        self.assertIsNot(new_client, old_client)
        self.assertIsNotNone(old_client.proc.poll())                   # 旧进程被换出时回收

    def test_并发重连不双重启(self):
        # 红队：两个线程同时踩到失效——只许一个真重启，另一个复用新连接，别泄漏子进程。
        import threading
        mcp_client.connect("echo", sys.executable, [_ECHO])
        old_client, _ = mcp_client._MCP_TOOLS["mcp__echo__echo"]
        old_client.close()
        results, errors = [], []
        def worker(t):
            try:
                results.append(mcp_client.call("mcp__echo__echo", {"text": t}))
            except mcp_client.MCPError as e:
                errors.append(e)
        ts = [threading.Thread(target=worker, args=(f"t{i}",)) for i in range(4)]
        for t in ts:
            t.start()
        for t in ts:
            t.join(timeout=30)
        self.assertEqual(errors, [])                                   # 大家都经新连接成功，无人被误屏蔽
        self.assertEqual(len(results), 4)
        self.assertFalse(mcp_client.is_down("mcp__echo__echo"))
        alive = {c for c, _ in mcp_client._MCP_TOOLS.values()}
        self.assertEqual(len(alive), 1)                                # 注册表只指向一个活 client


if __name__ == "__main__":
    unittest.main(verbosity=2)
