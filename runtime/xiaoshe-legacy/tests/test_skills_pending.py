"""A2a 增量 · 后台自学技能 pending 区 + 人审硬门。TDD 红→绿。

后台自学产出的技能落 `.state/skills/pending/` 子目录——`list_skills`/`system_message` 用非递归 glob，
pending 物理上看不见（字节冻结：激活前绝不影响注入面）；唯一激活路径 = 人审 approve（`:skills` / `python run.py skills`）。
运行：仓库根 `python -m unittest tests.test_skills_pending -v`
"""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import selflearn, skills


def _outbox():
    lines = []
    return lines, lines.append


class pending存储(unittest.TestCase):
    def test_pending落子目录且不进索引(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            slug = selflearn.save_pending("整理下载", "清理下载目录", "下载目录乱时", "1. 列文件\n2. 归档", path=base)
            self.assertTrue((base / "pending" / f"{slug}.md").exists())      # 落 pending 子目录
            self.assertEqual(skills.list_skills(base), [])                   # 正区列表不含 pending
            self.assertIsNone(skills.system_message(base))                   # 空库形状不变 = 字节冻结

    def test_read_skill读不到pending(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            selflearn.save_pending("整理下载", "d", "w", "步骤", path=base)
            self.assertIsNone(skills.read_skill("整理下载", base))           # 未激活，工具也读不回

    def test_list_pending列出元信息(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            selflearn.save_pending("b技能", "db", "wb", "步骤b", path=base)
            selflearn.save_pending("a技能", "da", "wa", "步骤a", path=base)
            lst = selflearn.list_pending(base)
            self.assertEqual([s["name"] for s in lst], ["a技能", "b技能"])   # 按 name 排序（编号稳定）
            self.assertEqual(lst[0]["when"], "wa")
            self.assertTrue(lst[0]["slug"])

    def test_approve挪正区且pending清空(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            slug = selflearn.save_pending("整理下载", "清下载", "乱时", "1. 列\n2. 归档", path=base)
            self.assertTrue(selflearn.approve_pending(slug, path=base))
            self.assertEqual(selflearn.list_pending(base), [])               # pending 空了
            self.assertFalse((base / "pending" / f"{slug}.md").exists())     # pending 文件删了
            lst = skills.list_skills(base)
            self.assertEqual([s["name"] for s in lst], ["整理下载"])          # 挪进正区
            msg = skills.system_message(base)
            self.assertIn("整理下载", msg["content"])                        # 下次会话自然进索引
            self.assertIn("归档", skills.read_skill("整理下载", base))

    def test_discard删除不进正区(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            slug = selflearn.save_pending("废技能", "d", "w", "步骤", path=base)
            self.assertTrue(selflearn.discard_pending(slug, path=base))
            self.assertEqual(selflearn.list_pending(base), [])
            self.assertEqual(skills.list_skills(base), [])

    def test_approve_discard不存在slug返回False(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            self.assertFalse(selflearn.approve_pending("没有这技能", path=base))
            self.assertFalse(selflearn.discard_pending("没有这技能", path=base))

    def test_slug防路径穿越(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            outside = base.parent / f"evil-{Path(d).name}.md"
            self.assertFalse(selflearn.approve_pending("../../evil-" + Path(d).name, path=base))
            self.assertFalse(selflearn.discard_pending("../../evil-" + Path(d).name, path=base))
            self.assertFalse(outside.exists())                               # 没越目录碰外面文件

    def test_approve时再过一遍净化管线(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            pend = base / "pending"
            pend.mkdir(parents=True)
            # 带外篡改/脏产出：正文藏零宽+控制符——approve 重走 save_skill 净化后才准进正区
            (pend / "脏技能.md").write_text(
                "---\nname: 脏技能\ndescription: d\nwhen: w\n---\n正常​步\x07骤\n", encoding="utf-8")
            self.assertTrue(selflearn.approve_pending("脏技能", path=base))
            full = skills.read_skill("脏技能", base)
            self.assertNotIn("​", full)
            self.assertNotIn("\x07", full)


class 人审命令(unittest.TestCase):
    def test_非skills命令返回False(self):
        lines, out = _outbox()
        self.assertFalse(selflearn.handle_skills_command(":memory", out=out))
        self.assertFalse(selflearn.handle_skills_command("随便聊聊", out=out))
        self.assertEqual(lines, [])

    def test_列表显示正式与待审编号(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            skills.save_skill("正式技能", "d", "正式场景", "步骤", path=base)
            selflearn.save_pending("待审技能", "d", "待审场景", "步骤", path=base)
            lines, out = _outbox()
            self.assertTrue(selflearn.handle_skills_command(":skills", out=out, path=base))
            text = "\n".join(lines)
            self.assertIn("正式技能", text)
            self.assertIn("待审技能", text)
            self.assertIn("1", text)                                         # 待审有编号
            self.assertIn("approve", text)                                   # 提示审批用法

    def test_空库列表不崩(self):
        with tempfile.TemporaryDirectory() as d:
            lines, out = _outbox()
            self.assertTrue(selflearn.handle_skills_command(":skills", out=out, path=Path(d)))
            self.assertTrue(lines)

    def test_approve确认y才激活(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            slug = selflearn.save_pending("待审技能", "d", "w", "步骤内容", path=base)
            lines, out = _outbox()
            self.assertTrue(selflearn.handle_skills_command(
                ":skills approve 1", confirm=lambda prompt: "y", out=out, path=base))
            self.assertEqual([s["name"] for s in skills.list_skills(base)], ["待审技能"])
            self.assertEqual(selflearn.list_pending(base), [])
            self.assertIn("步骤内容", "\n".join(lines))                      # 确认前给看了正文

    def test_approve确认n不动(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            selflearn.save_pending("待审技能", "d", "w", "步骤", path=base)
            lines, out = _outbox()
            selflearn.handle_skills_command(":skills approve 1", confirm=lambda prompt: "n", out=out, path=base)
            self.assertEqual(skills.list_skills(base), [])                   # 没激活
            self.assertEqual(len(selflearn.list_pending(base)), 1)           # pending 还在

    def test_discard确认y才删(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            selflearn.save_pending("待审技能", "d", "w", "步骤", path=base)
            lines, out = _outbox()
            selflearn.handle_skills_command(":skills discard 1", confirm=lambda prompt: "y", out=out, path=base)
            self.assertEqual(selflearn.list_pending(base), [])

    def test_编号越界提示不崩(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            selflearn.save_pending("待审技能", "d", "w", "步骤", path=base)
            lines, out = _outbox()
            selflearn.handle_skills_command(":skills approve 9", confirm=lambda prompt: "y", out=out, path=base)
            self.assertIn("9", "\n".join(lines))
            self.assertEqual(skills.list_skills(base), [])
            lines2, out2 = _outbox()
            selflearn.handle_skills_command(":skills approve", out=out2, path=base)   # 缺编号→用法提示
            self.assertTrue(lines2)

    def test_approve锁定预览的slug身份(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            selflearn.save_pending("甲技能", "d", "w", "甲步骤", path=base)
            selflearn.save_pending("乙技能", "d", "w", "乙步骤", path=base)
            first = selflearn.list_pending(base)[0]["slug"]                  # 编号 1 指向的 slug
            lines, out = _outbox()
            selflearn.handle_skills_command(":skills approve 1", confirm=lambda prompt: "y", out=out, path=base)
            active = skills.list_skills(base)
            self.assertEqual(len(active), 1)
            self.assertEqual(skills._slug(active[0]["name"]), first)         # 激活的就是预览的那份
            self.assertEqual(len(selflearn.list_pending(base)), 1)           # 另一份还在 pending

    def test_显示面对脏字段折行中和(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            pend = base / "pending"
            pend.mkdir(parents=True)
            (pend / "脏.md").write_text("---\nname: 坏\x07名\ndescription: d\nwhen: w\n---\n步骤\n",
                                        encoding="utf-8")
            lines, out = _outbox()
            selflearn.handle_skills_command(":skills", out=out, path=base)
            self.assertNotIn("\x07", "\n".join(lines))                       # 人审展示面不吐控制符


class 命令行入口(unittest.TestCase):
    def test_cli列表与approve(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            selflearn.save_pending("待审技能", "d", "w", "步骤内容", path=base)
            lines, out = _outbox()
            self.assertEqual(selflearn.cli([], out=out, path=base), 0)
            self.assertIn("待审技能", "\n".join(lines))
            lines2, out2 = _outbox()
            self.assertEqual(selflearn.cli(["approve", "1"], out=out2, path=base), 0)   # 敲下即审批，不再二次确认
            self.assertEqual([s["name"] for s in skills.list_skills(base)], ["待审技能"])
            self.assertIn("步骤内容", "\n".join(lines2))                     # 批准前打印了全文

    def test_cli_discard与坏用法(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            selflearn.save_pending("待审技能", "d", "w", "步骤", path=base)
            lines, out = _outbox()
            self.assertEqual(selflearn.cli(["discard", "1"], out=out, path=base), 0)
            self.assertEqual(selflearn.list_pending(base), [])
            self.assertEqual(selflearn.cli(["bogus"], out=out, path=base), 2)

    def test_run_py_dispatch(self):
        import run as run_mod
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(skills, "SKILLS_DIR", Path(d)), \
                mock.patch.object(sys, "argv", ["run.py", "skills"]):
            selflearn.save_pending("待审技能", "d", "w", "步骤", path=Path(d))
            self.assertEqual(run_mod.main(), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
