"""A2a 第二级 · 增量3 沙箱重放门：approve 前若技能含可执行步骤（命令/脚本形态），先丢 run_sandboxed
干跑验证，重放结果附在人审卡片上帮人判断；纯文本流程技能跳过重放并如实标注。
**重放是信息不是门**——重放通过 ≠ 激活，激活仍 only 靠人确认（人审硬门不变）。
运行：仓库根 `python -m unittest tests.test_skills_replay -v`
"""
import tempfile
import unittest
from pathlib import Path

from harness import selflearn, skills


def _outbox():
    lines = []
    return lines, lines.append


def _runner_ok(argv, spec, timeout):
    return (0, '{"exit":0,"timed_out":false,"output":"all good"}', "")


class 抽取可执行步骤(unittest.TestCase):
    def test_代码块与提示符行被抽出(self):
        body = "做法：\n```bash\n$ py -3 -V\nls -la\n```\n然后：\n$ git status 看看"
        cmds = selflearn.extract_executable_steps(body)
        self.assertIn("py -3 -V", cmds)
        self.assertIn("ls -la", cmds)
        self.assertIn("git status 看看", cmds)

    def test_步骤行首已知命令也认(self):
        cmds = selflearn.extract_executable_steps("1. 先想清楚\n2. `py -3 -m unittest`")
        self.assertIn("py -3 -m unittest", cmds)

    def test_纯文本流程抽不到(self):
        self.assertEqual(selflearn.extract_executable_steps("1. 先想清楚\n2. 再动手写\n3. 仔细复查"), [])
        self.assertEqual(selflearn.extract_executable_steps(""), [])
        self.assertEqual(selflearn.extract_executable_steps(None), [])

    def test_命令条数与长度封顶(self):
        body = "\n".join(f"$ cmd{i} " + "x" * 300 for i in range(20))
        cmds = selflearn.extract_executable_steps(body)
        self.assertLessEqual(len(cmds), selflearn._REPLAY_MAX_CMDS)
        self.assertTrue(all(len(c) <= 200 for c in cmds))


class 重放(unittest.TestCase):
    def test_纯文本跳过如实标注(self):
        rep = selflearn.replay_skill({"body": "1. 想想\n2. 做做"})
        self.assertEqual(rep["verdict"], "no_code")
        self.assertEqual(rep["results"], [])

    def test_含命令进沙箱干跑(self):
        rep = selflearn.replay_skill({"body": "$ py -3 -V"}, plat="Windows", runner=_runner_ok)
        self.assertEqual(rep["verdict"], "ran")
        self.assertEqual(rep["results"][0]["exit"], 0)
        self.assertIn("py -3 -V", rep["results"][0]["cmd"])

    def test_平台不支持如实报unavailable不崩(self):
        rep = selflearn.replay_skill({"body": "$ rm -rf /"}, plat="Linux")
        self.assertEqual(rep["verdict"], "unavailable")

    def test_重放输出中和截断(self):
        def dirty_runner(argv, spec, timeout):
            return (0, '{"exit":1,"timed_out":false,"output":"脏\\u0007\\u200b' + "y" * 500 + '"}', "")
        rep = selflearn.replay_skill({"body": "$ boom"}, plat="Windows", runner=dirty_runner)
        out = rep["results"][0]["output"]
        self.assertNotIn("\x07", out)
        self.assertNotIn("​", out)
        self.assertLessEqual(len(out), 200)

    def test_重放异常fail_safe(self):
        def boom(argv, spec, timeout):
            raise OSError("进程起不来")
        rep = selflearn.replay_skill({"body": "$ x"}, plat="Windows", runner=boom)
        self.assertEqual(rep["verdict"], "unavailable")                     # 重放炸不挡人审


class 人审接线(unittest.TestCase):
    def test_approve卡片带重放结果但确认n不激活(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            selflearn.save_pending("命令技能", "d", "w", "```bash\n$ py -3 -V\n```", path=base)
            seen = []
            def fake_replay(meta):
                seen.append(meta)
                return {"verdict": "ran",
                        "results": [{"cmd": "py -3 -V", "exit": 0, "timed_out": False, "output": "3.12"}]}
            lines, out = _outbox()
            selflearn.handle_skills_command(":skills approve 1", confirm=lambda p: "n",
                                            out=out, path=base, replay_fn=fake_replay)
            text = "\n".join(lines)
            self.assertTrue(seen)                                           # approve 前真跑了重放
            self.assertIn("exit 0", text)                                   # 结果上了卡片
            self.assertIn("仍由你定", text)                                 # 如实标注：重放 ≠ 激活
            self.assertEqual(skills.list_skills(base), [])                  # 确认 n → 没激活
            self.assertEqual(len(selflearn.list_pending(base)), 1)          # pending 还在

    def test_重放失败也照常由人决定(self):
        # 红队：重放门不是激活门——exit 非 0 不自动拒，exit 0 不自动批，都是人说了算
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            selflearn.save_pending("命令技能", "d", "w", "$ py -3 -V", path=base)
            bad = lambda meta: {"verdict": "ran",
                                "results": [{"cmd": "py -3 -V", "exit": 1, "timed_out": False, "output": "炸"}]}
            lines, out = _outbox()
            selflearn.handle_skills_command(":skills approve 1", confirm=lambda p: "y",
                                            out=out, path=base, replay_fn=bad)
            self.assertIn("exit 1", "\n".join(lines))                       # 失败如实上人审卡片
            self.assertEqual([s["name"] for s in skills.list_skills(base)], ["命令技能"])  # 人批准了就激活

    def test_discard不重放(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            selflearn.save_pending("命令技能", "d", "w", "$ py -3 -V", path=base)
            seen = []
            selflearn.handle_skills_command(":skills discard 1", confirm=lambda p: "y",
                                            out=_outbox()[1], path=base, replay_fn=seen.append)
            self.assertEqual(seen, [])                                      # 丢弃不烧重放

    def test_纯文本技能approve如实标注跳过重放(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            selflearn.save_pending("流程技能", "d", "w", "1. 先想\n2. 再做", path=base)
            lines, out = _outbox()
            selflearn.handle_skills_command(":skills approve 1", confirm=lambda p: "n", out=out, path=base)
            self.assertIn("跳过重放", "\n".join(lines))                     # 真 replay_skill：纯文本如实标注

    def test_cli_approve也带重放(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            selflearn.save_pending("命令技能", "d", "w", "$ py -3 -V", path=base)
            seen = []
            lines, out = _outbox()
            rc = selflearn.cli(["approve", "1"], out=out, path=base, replay_fn=lambda m: seen.append(m) or {
                "verdict": "ran", "results": [{"cmd": "py -3 -V", "exit": 0, "timed_out": False, "output": ""}]})
            self.assertEqual(rc, 0)
            self.assertTrue(seen)
            self.assertIn("exit 0", "\n".join(lines))


if __name__ == "__main__":
    unittest.main(verbosity=2)
