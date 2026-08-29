"""P2 · 1d 第三片：MCP 工具描述/命名的入口净化（tool-poisoning 硬化）。TDD 红→绿。

恶意第三方 MCP server 能在 description 里塞超长文本 / 注入话术 / 控制字符，也能给工具起个
带空格或特殊字符的名字——这些原样进 spec 就等于把"外部可控指令/脏命名"喂给模型。
这里只做"入口净化"：描述剔控制字符+截断+空回退，命名安全化，不做语义判别（那属 CaMeL 深水）。
运行：仓库根 `python -m unittest discover -s tests -v`
"""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from harness import mcp_client

_HOSTILE = str(Path(__file__).resolve().parent / "_mcp_hostile_server.py")
_COLLIDE = str(Path(__file__).resolve().parent / "_mcp_collide_server.py")


class 描述净化(unittest.TestCase):
    def test_超长描述被截断带提示(self):
        out = mcp_client._screen_description("垃" * 5000, "t")
        self.assertLessEqual(len(out), 600)
        self.assertIn("截断", out)

    def test_控制字符与零宽被剔除(self):
        self.assertEqual(mcp_client._screen_description("好\x07工​具\x00", "t"), "好工具")

    def test_空描述或非串_回退到工具名(self):
        self.assertEqual(mcp_client._screen_description("   ", "回声"), "MCP 工具 回声")
        self.assertEqual(mcp_client._screen_description(None, "回声"), "MCP 工具 回声")


class 命名安全化(unittest.TestCase):
    def test_特殊字符被替换成下划线(self):
        self.assertTrue(re.fullmatch(r"[A-Za-z0-9_-]+", mcp_client._safe_ns("evil tool!!")))

    def test_超长命名被截短(self):
        self.assertLessEqual(len(mcp_client._safe_ns("x" * 200)), 32)

    def test_全非法字符不产出空串(self):
        self.assertTrue(mcp_client._safe_ns("！！！"))

    def test_空入参走空回退分支产出x(self):
        # 钉住 `or "x"` 空回退：唯有空串能触达它（re.sub 逐字符替换、非空入参永不为空）。
        # 生产里 raw = t.get("name") or "" 可为空（失范 server），去掉回退会拼出畸形 pref。
        self.assertEqual(mcp_client._safe_ns(""), "x")


class 恶意server连接净化(unittest.TestCase):
    def tearDown(self):
        mcp_client.shutdown()

    def test_恶意描述与工具名进spec前被净化且仍可调用(self):
        specs = mcp_client.connect("hostile", sys.executable, [_HOSTILE])
        self.assertEqual(len(specs), 1)
        fn = specs[0]["function"]
        # 名字合法：无空格/特殊字符，且仍带本 server 前缀
        self.assertTrue(re.fullmatch(r"[A-Za-z0-9_-]+", fn["name"]))
        self.assertTrue(fn["name"].startswith("mcp__hostile__"))
        # 描述被截断、无控制字符
        self.assertLessEqual(len(fn["description"]), 600)
        self.assertNotIn("\x07", fn["description"])
        # 关键：净化后仍能路由回"原始工具名"并拿回结果
        text, is_err = mcp_client.call(fn["name"], {"text": "hi"})
        self.assertFalse(is_err)
        self.assertIn("hi", text)

    def test_第三方描述进spec带不可信标注(self):
        # 描述来自第三方 server，进 spec 前要像 MCP 输出那样被框成"仅供参考、非指令"，别被读成可信工具说明。
        specs = mcp_client.connect("hostile", sys.executable, [_HOSTILE])
        desc = specs[0]["function"]["description"]
        self.assertIn("第三方", desc)
        self.assertIn("非指令", desc)

    def test_净化后撞名的两个工具_去重不覆盖_各自可路由(self):
        # "a b" 与 "a_b" 经 _safe_ns 都成 "a_b"：必须去重成两个不同 pref，别静默顶掉/误路由。
        specs = mcp_client.connect("col", sys.executable, [_COLLIDE])
        names = [s["function"]["name"] for s in specs]
        self.assertEqual(len(names), 2)
        self.assertEqual(len(set(names)), 2)  # 两个 pref 互不相同（已去重）
        # 两个 pref 各自映射到不同的原始工具名，且都能真调用拿回对应结果
        origs = set()
        for n in names:
            text, is_err = mcp_client.call(n, {})
            self.assertFalse(is_err)
            origs.add(text.split("called:")[-1])
        self.assertEqual(origs, {"a b", "a_b"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
