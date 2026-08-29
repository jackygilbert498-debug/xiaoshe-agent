"""A2a · 技能库（SKILL.md）：把可复用做法固化成带元信息的流程，下次同类任务先看技能再动手。TDD 红→绿。

存 .state/skills/<slug>.md；索引(name+when)进开场 system 让模型知道有哪些技能，read_skill 取全文照做。
安全：name slug 化防路径穿越；正文中和隐形字符；照技能做时工具照常过审批（技能不提权）。
运行：仓库根 `python -m unittest tests.test_skills -v`
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import permission, skills, tools


class 技能存取(unittest.TestCase):
    def test_保存后能列出与读回(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            slug = skills.save_skill("发周报", "生成周报", "用户让我写周报时",
                                     "1. 读本周提交\n2. 归类\n3. 成文", path=base)
            lst = skills.list_skills(base)
            self.assertEqual(len(lst), 1)
            self.assertEqual(lst[0]["name"], "发周报")
            self.assertIn("用户让我写周报时", lst[0]["when"])
            full = skills.read_skill("发周报", base)
            self.assertIn("读本周提交", full)          # 正文步骤读得回
            self.assertIn("发周报", full)

    def test_按slug或名字都能读回(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            skills.save_skill("Deploy Web", "部署", "上线时", "步骤", path=base)
            self.assertIsNotNone(skills.read_skill("Deploy Web", base))   # 原名
            self.assertIsNotNone(skills.read_skill("Deploy-Web", base))   # slug

    def test_读不存在的技能返回None(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(skills.read_skill("不存在", Path(d)))

    def test_系统消息索引_空库返None(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(skills.system_message(Path(d)))

    def test_系统消息索引_列name与when(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            skills.save_skill("发周报", "生成周报", "写周报时", "步骤", path=base)
            msg = skills.system_message(base)
            self.assertEqual(msg["role"], "system")
            self.assertIn("发周报", msg["content"])
            self.assertIn("写周报时", msg["content"])
            self.assertIn("read_skill", msg["content"])   # 引导用 read_skill 取全文


class 技能安全(unittest.TestCase):
    def test_名字slug化防路径穿越(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            skills.save_skill("../../evil", "x", "y", "z", path=base)
            # 没写到 base 外
            self.assertEqual(list((base.parent).glob("evil*")), [])
            self.assertFalse((base / ".." / ".." / "evil.md").resolve().exists() and
                             (base / ".." / ".." / "evil.md").resolve().parent != base.resolve())
            # 落在 base 内（slug 化）
            self.assertEqual(len(list(base.glob("*.md"))), 1)

    def test_正文中和隐形字符(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            skills.save_skill("s", "d", "w", "正常​步\x07骤", path=base)   # 零宽 + 控制符
            full = skills.read_skill("s", base)
            self.assertNotIn("​", full)
            self.assertNotIn("\x07", full)


class A2a审查修复(unittest.TestCase):
    def test_MED_frontmatter字段折成单行防跨字段覆盖(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            # when 里塞换行 + 伪造 name 行——折单行后不能覆盖真 name
            skills.save_skill("真技能", "origdesc", "每周五\ndescription: 覆盖\nname: 假名", "步骤", path=base)
            lst = skills.list_skills(base)
            self.assertEqual(len(lst), 1)
            self.assertEqual(lst[0]["name"], "真技能")        # 真 name 没被换行伪造行覆盖
            self.assertEqual(lst[0]["description"], "origdesc")
            self.assertNotIn("\n", lst[0]["when"])             # when 折成单行

    def test_MED_多行description不丢字段(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            skills.save_skill("s", "第一行\n第二行补充", "w", "步骤", path=base)
            self.assertIn("第二行补充", skills.list_skills(base)[0]["description"])  # 折行保留、不丢

    def test_LOW_不同名同slug不静默覆盖(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            skills.save_skill("deploy!!!prod", "A", "w", "步骤A", path=base)
            skills.save_skill("deploy@@@prod", "B", "w", "步骤B", path=base)   # slug 会碰撞
            lst = skills.list_skills(base)
            self.assertEqual(len(lst), 2)                                       # 两份都在、不互相覆盖
            self.assertEqual({s["name"] for s in lst}, {"deploy!!!prod", "deploy@@@prod"})

    def test_同名重存是更新不新增(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            skills.save_skill("s", "旧", "w", "旧步骤", path=base)
            skills.save_skill("s", "新", "w", "新步骤", path=base)   # 同名=更新
            lst = skills.list_skills(base)
            self.assertEqual(len(lst), 1)
            self.assertEqual(lst[0]["description"], "新")
            self.assertIn("新步骤", skills.read_skill("s", base))


class 技能工具(unittest.TestCase):
    def test_工具注册_save需批准_read只读(self):
        self.assertIn("save_skill", tools.REGISTRY)
        self.assertIn("read_skill", tools.REGISTRY)
        self.assertEqual(permission.check("save_skill", {"name": "s"}).action, "ask")     # 写=需批准
        self.assertEqual(permission.check("read_skill", {"name": "s"}).action, "approve")  # 只读=SAFE
        names = [s["function"]["name"] for s in tools.all_specs()]
        self.assertIn("save_skill", names)
        self.assertIn("read_skill", names)

    def test_save_skill工具端到端写读(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(skills, "SKILLS_DIR", Path(d)):
            out = tools.execute("save_skill", {"name": "整理下载", "description": "清理下载目录",
                                               "when": "下载目录乱时", "steps": "1. 列文件\n2. 按类归档"}, {}).content
            self.assertIn("整理下载", out)
            read = tools.execute("read_skill", {"name": "整理下载"}, {}).content
            self.assertIn("按类归档", read)


if __name__ == "__main__":
    unittest.main(verbosity=2)
