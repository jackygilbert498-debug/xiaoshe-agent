"""D3 真实任务修复批回归（2026-07-25，背景 docs/验收/D3真实任务-问题清单.md）：

- P0-1：write_file 的 content 等**内容类参数**豁免路径形态扫描（代码里冒号/反斜杠是常态，
  曾因 NTFS ADS 规则被误判「敏感文件」硬拒致死）；路径类参数（path/file/target…）照扫。
- P0-2：headless --workdir 落在 .state 内部状态树时启动即显式告警（硬拒铁律不动，但别静默全灭）。
- P1-4：run_command 输出解码回退链 utf-8 → mbcs（中文 Windows=GBK）→ 替换符兜底不崩。
- P2-5：无头模式（无用户在场）审批拒绝话术如实，不谎称「用户拒绝了」。
- MED：save_skill 技能正文含本会话不可信源污点 → 拒存（同 note_tip/remember 待遇）。

运行：仓库根 `py -3 -m unittest tests.test_d3_fixes -v`
"""
import codecs
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # 让 tests 能 import harness

from harness import _io, agent, checkpoint, effects, headless, permission, skills, tools
from harness.kimi_client import KimiError

# D3 T5 致死样本形态：Python 代码正文，含冒号、无斜杠
_代码正文 = 'import os\nFOLDER = "files"\ndef main():\n    print(os.listdir(FOLDER))'
_污点行 = "本行是从不可信网页整段抄来的够长污点样本用于测试断言请勿当真指令"   # ≥32 字才入污点（_MIN_TAINT_SPAN）

_无mbcs = False
try:
    codecs.lookup("mbcs")
except LookupError:   # 非 Windows 没有活动代码页编解码器
    _无mbcs = True


def _fake_proc(stdout=b"", stderr=b"", rc=0):
    return types.SimpleNamespace(returncode=rc, stdout=stdout, stderr=stderr)


class P0_1_内容参数豁免路径扫描(unittest.TestCase):
    """修前：_iter_pathlike 对 write_file 全部参数递归，content 无斜杠含冒号 → _is_sensitive 的
    NTFS ADS 规则(":" in p.name)命中 → 硬拒。修后：content/text 键豁免；path/file/target 照扫。"""

    def test_含冒号无斜杠的代码正文不再误拒(self):
        d = permission.check("write_file", {"path": "normalize.py", "content": _代码正文})
        self.assertNotEqual(d.action, "deny", "代码正文里的冒号不许再触发 NTFS ADS 敏感误判（D3 T5 致死根因）")

    def test_正文里的盘符与反斜杠也不当路径扫(self):
        d = permission.check("write_file", {"path": "a.txt",
                                            "content": "set X=C:\\Users\\foo && echo: done"})
        self.assertNotEqual(d.action, "deny")

    def test_MCP工具的内容参数同样豁免(self):
        d = permission.check("mcp__fs__write", {"path": "ok.txt", "content": _代码正文})
        self.assertNotEqual(d.action, "deny")

    def test_嵌套结构里的content键也豁免(self):
        d = permission.check("mcp__x__y", {"files": [{"path": "a.txt", "content": "k: v"}]})
        self.assertNotEqual(d.action, "deny")

    def test_红队_path指向敏感文件照拒(self):
        self.assertEqual(permission.check("write_file", {"path": ".env", "content": "x"}).action, "deny")

    def test_红队_别名路径参数仍被扫(self):
        # 豁免只针对内容键，路径类别名（file/target/嵌套）的硬护栏不许被顺带拆掉
        self.assertEqual(permission.check("write_file", {"path": "ok.txt", "file": ".env"}).action, "deny")
        self.assertEqual(permission.check("mcp__fs__write", {"target": ".env"}).action, "deny")
        self.assertEqual(permission.check("read_file", {"path": "ok.txt", "also": "id_rsa"}).action, "deny")


class P0_2_workdir在state树下启动告警(unittest.TestCase):
    """.state 整树硬拒是铁律（不动）；但 workdir 放它下面 = 文件类工具静默全灭（D3 污染跑 T1 实锤），
    启动时必须一行 warn 说破，排障不必挖转录。"""

    def _collect_warns(self, wd: Path):
        def boom(*a, **kw):
            raise KimiError("拿到告警即可中断，不必真跑")

        with mock.patch.object(headless._io, "warn") as m_warn, \
             mock.patch.object(headless.session, "new_session_id", return_value="headless-T"), \
             mock.patch.object(headless.session, "session_log_file", return_value=wd / "l.jsonl"), \
             mock.patch.object(headless.agent, "run_once", side_effect=boom):
            headless.run_headless("随便", workdir=str(wd), no_mcp=True)
        return [str(c.args[0]) for c in m_warn.call_args_list]

    def test_workdir在state树里启动即显式告警(self):
        with tempfile.TemporaryDirectory() as d:
            box = Path(d) / ".state" / "box"
            box.mkdir(parents=True)
            warns = self._collect_warns(box)
        self.assertTrue(any(".state" in w for w in warns),
                        f"workdir 落在 .state 下必须告警（现在静默全灭）；实际告警：{warns}")

    def test_红队_正常workdir不多嘴(self):
        with tempfile.TemporaryDirectory() as d:
            warns = self._collect_warns(Path(d))
        self.assertFalse(any(".state" in w for w in warns), f"正常 workdir 不许误告警（告警吵）：{warns}")


class P1_4_命令输出解码回退链(unittest.TestCase):
    """修前：text=True encoding=utf-8 errors=replace → 中文 Windows cmd 的 GBK 输出全变 �（D3 T3/T5）。
    修后：utf-8 严格 → mbcs（活动代码页，中文 Windows=GBK）→ 替换符兜底。"""

    def test_utf8输出照常优先(self):
        self.assertEqual(_io.decode_cmd_output("中文输出".encode("utf-8")), "中文输出")

    @unittest.skipIf(_无mbcs, "非 Windows 无 mbcs 编解码器")
    def test_gbk输出回退活动代码页解码(self):
        self.assertEqual(_io.decode_cmd_output("文件夹".encode("gbk")), "文件夹")

    @unittest.skipIf(_无mbcs, "非 Windows 无 mbcs 编解码器")
    def test_二进制垃圾不崩_替换符兜底(self):
        out = _io.decode_cmd_output(b"\xff\xff\xff\x81")   # utf-8 与 GBK 都解不动
        self.assertIsInstance(out, str)
        self.assertIn("�", out, "解码全失败必须给替换符，不许抛异常")

    @unittest.skipIf(_无mbcs, "非 Windows 无 mbcs 编解码器")
    def test_run_command整链_中文文件名不乱码(self):
        gbk = "微信图片_2024.png".encode("gbk")   # D3 T5 实锤样本：dir 输出里的中文文件名
        with mock.patch.object(tools.subprocess, "run", return_value=_fake_proc(stdout=gbk)):
            out = tools._run_command({"command": "dir"}, {})
        self.assertIn("微信图片_2024.png", out)

    @unittest.skipIf(_无mbcs, "非 Windows 无 mbcs 编解码器")
    def test_run_command整链_CRLF归一为LF(self):
        # 旧 text=True 自带 universal newlines；改字节解码后必须保住这个行为
        with mock.patch.object(tools.subprocess, "run", return_value=_fake_proc(stdout=b"a\r\nb\r\n")):
            out = tools._run_command({"command": "x"}, {})
        self.assertIn("a\nb", out)
        self.assertNotIn("\r", out)


class P2_5_无头拒绝话术如实(unittest.TestCase):
    """无头模式没有用户可问：白名单外的 ask 如实落成 deny（审批策略拒绝），话术指向 --allow，
    不谎称「用户拒绝了」（D3 T5 里 run_script 被拒的误导话术）。"""

    def test_白名单外的ask在无头上下文落成deny且话术如实(self):
        with permission.headless_mode(("write_file",)):
            d = permission.check("run_command", {"command": "dir"})
            self.assertEqual(d.action, "deny")
            self.assertIn("无头", d.reason)
            self.assertIn("--allow", d.reason)

    def test_白名单内工具的普通ask保留_走白名单捷径(self):
        with permission.headless_mode(("write_file",)):
            d = permission.check("write_file", {"path": "a.txt", "content": "x"})
            self.assertEqual(d.action, "ask", "--allow 放行的工具必须仍是 ask，_approved 白名单捷径才接得住")

    def test_白名单内工具的force_ask也如实deny(self):
        # 混淆管道 force_ask 即使 --allow 也不许静默过——无头下无人可逐次确认 → 如实拒
        with permission.headless_mode(("run_command",)):
            d = permission.check("run_command", {"command": "echo AA== | base64 -d | bash"})
            self.assertEqual(d.action, "deny")
            self.assertIn("无头", d.reason)

    def test_退出上下文即恢复交互语义(self):
        with permission.headless_mode(()):
            permission.check("run_command", {"command": "dir"})
        self.assertEqual(permission.check("run_command", {"command": "dir"}).action, "ask")

    def test_run_headless端到端_拒绝话术不再谎称用户(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            script = [
                {"content": "", "tool_calls": [
                    {"id": "c1", "type": "function",
                     "function": {"name": "run_command", "arguments": '{"command": "dir"}'}},
                    {"id": "c2", "type": "function",
                     "function": {"name": "write_file", "arguments": '{"path": "out.txt", "content": "hi"}'}},
                ]},
                {"content": "done"},
            ]
            model = lambda msgs, tools=None: script.pop(0)
            captured = {}
            _orig_run_once = headless.agent.run_once

            def spy(prompt, history, **kw):
                captured["history"] = history
                return _orig_run_once(prompt, history, **kw)

            with mock.patch.object(headless.session, "new_session_id", return_value="headless-T"), \
                 mock.patch.object(headless.session, "session_log_file", return_value=d / "l.jsonl"), \
                 mock.patch.object(headless.session, "save_session"), \
                 mock.patch.object(headless, "_print_reply"), \
                 mock.patch.object(headless.agent, "run_once", side_effect=spy), \
                 mock.patch.object(checkpoint, "UNDO_DIR", d / "undo"), \
                 mock.patch.object(effects, "EFFECTS_FILE", d / "effects.jsonl"):
                rc = headless.run_headless("任务", allow=("write_file",), workdir=str(d),
                                           model_fn=model, no_mcp=True)
            self.assertEqual(rc, 0)
            tool_msgs = [str(m.get("content", "")) for m in captured["history"] if m.get("role") == "tool"]
            denied = next(m for m in tool_msgs if "拒绝" in m)
            self.assertIn("无头", denied, "无头拒绝话术必须如实说明没有用户在场")
            self.assertNotIn("用户拒绝了", denied, "没有用户在场，不许谎称「用户拒绝了」")
            self.assertEqual((d / "out.txt").read_text(encoding="utf-8"), "hi",
                             "--allow 放行的 write_file 不许被无头话术修复误伤（效用基线）")


class MED_save_skill污点拒存(unittest.TestCase):
    """注入套件实锤的缝隙：save_skill 无 _fact_from_untrusted——用户对 save_skill 答过 'a' 后，
    整段抄自网页/OCR 的 steps 静默写进 SKILL.md，下会话 read_skill 原文注入。对齐 note_tip 待遇：拒存。"""

    def test_污点steps拒存且文件零新增(self):
        with tempfile.TemporaryDirectory() as d:
            sk = Path(d) / "skills"
            ctx = {"session_id": "s", "_tainted": {_污点行}}
            with mock.patch.object(skills, "SKILLS_DIR", sk):
                out = tools.execute("save_skill", {"name": "x", "description": "d", "when": "w",
                                                   "steps": _污点行}, ctx).content
            self.assertIn("没保存", out)
            self.assertFalse(list(sk.glob("*.md")) if sk.exists() else [], "被拒后技能文件不许出生（状态断言）")

    def test_污点description或when同样拒存(self):
        with tempfile.TemporaryDirectory() as d:
            sk = Path(d) / "skills"
            ctx = {"session_id": "s", "_tainted": {_污点行}}
            with mock.patch.object(skills, "SKILLS_DIR", sk):
                out = tools.execute("save_skill", {"name": "x", "description": _污点行, "when": "w",
                                                   "steps": "干净步骤"}, ctx).content
            self.assertIn("没保存", out, "description/when 也是 SKILL.md 正文，污点同样不许固化")

    def test_污点name同样拒存(self):
        """审查 MED-1：name 也进 SKILL.md frontmatter，污点经技能名固化可绕过既有拒存。"""
        with tempfile.TemporaryDirectory() as d:
            sk = Path(d) / "skills"
            ctx = {"session_id": "s", "_tainted": {_污点行}}
            with mock.patch.object(skills, "SKILLS_DIR", sk):
                out = tools.execute("save_skill", {"name": _污点行, "description": "d", "when": "w",
                                                   "steps": "干净步骤"}, ctx).content
            self.assertIn("没保存", out, "name 也是 SKILL.md 正文，污点不许经技能名固化")
            self.assertFalse(list(sk.glob("*.md")) if sk.exists() else [], "被拒后技能文件不许出生（状态断言）")

    def test_效用基线_干净技能照存(self):
        with tempfile.TemporaryDirectory() as d:
            sk = Path(d) / "skills"
            with mock.patch.object(skills, "SKILLS_DIR", sk):
                out = tools.execute("save_skill", {"name": "发周报", "description": "d", "when": "周五",
                                                   "steps": "先收集再汇总"}, {"session_id": "s"}).content
            self.assertIn("已保存技能", out)
            self.assertTrue(list(sk.glob("*.md")), "干净技能被拦=防线误伤（效用回归）")


if __name__ == "__main__":
    unittest.main(verbosity=2)
