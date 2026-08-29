"""A2b Path B.2 · propose_tool 工具 + REPL 人审门（:tools/:approve/:reject）。TDD 红→绿。

混合审查门（用户拍板）：提案时内联摘要 → :tools 名 可看全码/开文件深审 → :approve 展示**即将批准的那份字节**
并确认（expected_sha256 锁死"看到的=批准的"，防展示后草稿再被改的 TOCTOU）→ 批准后**下次会话**生效（字节冻结）。
运行：仓库根 `python -m unittest tests.test_tool_gate -v`
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import agent, permission, user_tools
from harness import tools as tools_mod

_RESERVED = {"read_file"}


def _propose(base, name="word_count", code="param($text) Write-Output 7"):
    return user_tools.propose(name, "数一段文本的词数", code,
                              [{"name": "text", "description": "要数的文本"}],
                              base=base, reserved=_RESERVED)


class propose_tool工具(unittest.TestCase):
    def test_注册且提案免审批(self):
        self.assertIn("propose_tool", tools_mod.REGISTRY)
        names = [s["function"]["name"] for s in tools_mod.all_specs()]
        self.assertIn("propose_tool", names)
        # 提案只写待审草稿、无任何效力（真正的门在 :approve）→ SAFE 免审批，别让用户批两道
        d = permission.check("propose_tool", {"name": "x_tool", "description": "d", "code": "c"})
        self.assertEqual(d.action, "approve")

    def test_污点升级覆盖提案(self):
        # 提案代码若整段抄自不可信网页/MCP → taint_gate 升 ask，人在提案时就被点醒（纵深，不只靠批准时看代码）
        self.assertIn("propose_tool", permission._TAINT_HIGH_RISK)

    def test_提案落pending并回执审批指引(self):
        with mock.patch.object(tools_mod.user_tools, "propose",
                               return_value={"name": "word_count", "description": "数词数",
                                             "params": [{"name": "text", "description": "t", "required": True}],
                                             "path": "X:/pending/word_count.json", "updates_active": False}) as m:
            r = tools_mod.execute("propose_tool",
                                  {"name": "word_count", "description": "数词数",
                                   "code": "param($text) Write-Output 7",
                                   "params": [{"name": "text", "description": "t"}]}, {})
        self.assertFalse(r.is_error)
        m.assert_called_once()
        for kw in ("未生效", ":tools", ":approve", "下次会话"):
            self.assertIn(kw, r.content, msg=f"回执缺关键信息：{kw}")

    def test_替换已批准版本要点明(self):
        with mock.patch.object(tools_mod.user_tools, "propose",
                               return_value={"name": "w", "description": "d", "params": [],
                                             "path": "p", "updates_active": True}):
            r = tools_mod.execute("propose_tool", {"name": "w", "description": "d", "code": "c"}, {})
        self.assertIn("替换", r.content)          # 更新已批准工具=高影响，回执必须说清

    def test_参数错误收口不冒泡(self):
        r = tools_mod.execute("propose_tool", {"name": "BAD NAME", "description": "d", "code": "c"}, {})
        self.assertTrue(r.is_error)


class 审批门命令(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.base = Path(self._d.name)
        self.out_lines = []
        self.out = self.out_lines.append

    def tearDown(self):
        self._d.cleanup()

    def _text(self):
        return "\n".join(str(x) for x in self.out_lines)

    def test_非命令不消费(self):
        for t in ("你好", "帮我算个数", ":toolsx", "approve word_count"):
            self.assertFalse(agent._handle_tools_command(t, confirm=lambda p: "y",
                                                         out=self.out, base=self.base))

    def test_tools列出待审与已批(self):
        _propose(self.base)
        _propose(self.base, name="csv_stats", code="Write-Output 1")
        user_tools.approve("csv_stats", base=self.base, reserved=_RESERVED)
        self.assertTrue(agent._handle_tools_command(":tools", confirm=lambda p: "y",
                                                    out=self.out, base=self.base))
        txt = self._text()
        self.assertIn("word_count", txt)
        self.assertIn("csv_stats", txt)
        self.assertIn(":approve", txt)            # 列表里带用法指引

    def test_tools看单个工具全码(self):
        _propose(self.base)
        self.assertTrue(agent._handle_tools_command(":tools word_count", confirm=lambda p: "y",
                                                    out=self.out, base=self.base))
        txt = self._text()
        self.assertIn("param($text)", txt)        # 全码可深审
        self.assertIn("word_count.json", txt)     # 给出文件路径，可开文件再审

    def test_approve展示全码确认后批准(self):
        _propose(self.base)
        prompts = []

        def confirm(p):
            prompts.append(p)
            return "y"
        self.assertTrue(agent._handle_tools_command(":approve word_count", confirm=confirm,
                                                    out=self.out, base=self.base))
        self.assertTrue((self.base / "active" / "word_count.json").exists())
        self.assertIn("param($text)", self._text())       # 确认前展示的就是全码
        self.assertIn("下次会话", self._text())            # 生效时点说清（字节冻结）
        self.assertTrue(prompts)                           # 确实问过

    def test_approve拒绝确认则不批(self):
        _propose(self.base)
        agent._handle_tools_command(":approve word_count", confirm=lambda p: "n",
                                    out=self.out, base=self.base)
        self.assertFalse((self.base / "active" / "word_count.json").exists())
        self.assertTrue((self.base / "pending" / "word_count.json").exists())   # 草稿保留

    def test_展示与expected哈希同源(self):
        # 锁死"看到的=批准的"：传给 approve 的 expected_sha256 必须等于**展示那一刻**盘上字节的哈希，
        # 且展示的代码来自同一份字节（防"展示读盘≠算sha读盘"两次读之间被掉包）。
        import hashlib
        _propose(self.base, code="param($text) Write-Output 展示锁定")
        seen = {}
        shown = {}

        def confirm(p):
            seen["bytes"] = (self.base / "pending" / "word_count.json").read_bytes()
            return "y"
        orig_approve = user_tools.approve
        cap = {}

        def spy(name, **kw):
            cap["expected"] = kw.get("expected_sha256")
            return orig_approve(name, **kw)
        orig_print = agent._print_draft

        def spy_print(t, out):
            shown["code"] = t.get("code")
            return orig_print(t, out)
        with mock.patch.object(agent.user_tools, "approve", side_effect=spy), \
             mock.patch.object(agent, "_print_draft", side_effect=spy_print):
            agent._handle_tools_command(":approve word_count", confirm=confirm,
                                        out=self.out, base=self.base)
        self.assertEqual(cap["expected"], hashlib.sha256(seen["bytes"]).hexdigest())   # sha 锁确认时字节
        self.assertEqual(shown["code"], json.loads(seen["bytes"])["code"])              # 展示来自同一份字节

    def test_approve期间草稿被改则拒_TOCTOU(self):
        _propose(self.base)
        pend = self.base / "pending" / "word_count.json"

        def confirm(p):   # 模拟：确认瞬间草稿被偷换（展示的≠盘上的）
            data = json.loads(pend.read_text(encoding="utf-8"))
            data["code"] = "Invoke-WebRequest evil"
            pend.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            return "y"
        agent._handle_tools_command(":approve word_count", confirm=confirm,
                                    out=self.out, base=self.base)
        self.assertFalse((self.base / "active" / "word_count.json").exists())   # 绝不带改后字节过门
        self.assertIn("不一致", self._text())

    def test_代码控制字符展示时转义防伪装(self):
        # 展示的代码=人审依据：ANSI 清屏/覆写序列能把恶意代码"演"成无害——展示层必须转成可见转义（批准字节不变）
        _propose(self.base, code="Write-Output 1 \x1b[2J# evil")
        agent._handle_tools_command(":tools word_count", confirm=lambda p: "y",
                                    out=self.out, base=self.base)
        txt = self._text()
        self.assertNotIn("\x1b", txt)
        self.assertIn("\\u001b", txt)   # ESC 被可见化转义（统一 \\uXXXX 格式，含 bidi/零宽/CR 一并覆盖）

    def test_reject删草稿(self):
        _propose(self.base)
        self.assertTrue(agent._handle_tools_command(":reject word_count", confirm=lambda p: "y",
                                                    out=self.out, base=self.base))
        self.assertFalse((self.base / "pending" / "word_count.json").exists())

    def test_缺名字给用法提示不发模型(self):
        self.assertTrue(agent._handle_tools_command(":approve", confirm=lambda p: "y",
                                                    out=self.out, base=self.base))
        self.assertIn(":approve", self._text())

    def test_不存在的名字友好报错(self):
        agent._handle_tools_command(":approve nothere", confirm=lambda p: "y",
                                    out=self.out, base=self.base)
        self.assertIn("没有", self._text())


class expected哈希(unittest.TestCase):
    def test_approve带expected哈希不符拒(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            _propose(base)
            with self.assertRaises(ValueError):
                user_tools.approve("word_count", base=base, reserved=_RESERVED,
                                   expected_sha256="0" * 64)
            self.assertFalse((base / "active" / "word_count.json").exists())


if __name__ == "__main__":
    unittest.main()
