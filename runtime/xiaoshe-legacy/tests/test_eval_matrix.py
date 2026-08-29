"""§4.6.2 分层评测矩阵 + §4.6.1 有序子目标 checklist。TDD 红→绿（全离线，统计/编排逻辑注入假件测）。

- evals/core.py：Task.checklist 有序子目标断言——按序逐步记录、首挂子目标即失败归因（failed_step），
  不再只从最终失败倒推；无 checklist 的老任务行为零变更。
- evals/matrix.py：元素定位/动作执行/任务完成 三层 × Win/Mac 双平台矩阵；把已有入口编进分层结构
  （ocr_blindspot_suite=定位层 auto；gold_standard_win/mac=执行/完成层 manual 真机入口）；
  parse_gold_log 把金标准全程日志归因到层；render_report 上层挂则下层标「上层未过」（分数无意义）。
运行：仓库根 `py -3 -m unittest tests.test_eval_matrix -v`
"""
import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from evals import core, matrix
from evals.core import Task
from evals.tasks import SEEDS


def _done_model(_m, tools=None):
    return {"content": "好", "tool_calls": []}


def _task(checklist=(), verify=None):
    return Task(name="t", prompt="p", make_model=lambda: _done_model,
                verify=verify, checklist=checklist)


class 有序子目标checklist(unittest.TestCase):
    def test_首挂子目标即归因_步骤按序记录(self):
        t = _task(checklist=(("第一步", lambda c: True),
                             ("第二步", lambda c: False),
                             ("第三步", lambda c: False)))
        with tempfile.TemporaryDirectory() as d:
            out = core.run_once(t, Path(d))
        self.assertFalse(out.passed)
        self.assertEqual(out.failed_step, "第二步")          # 首挂归因，不是从终态倒推
        self.assertEqual([s for s, _ in out.steps], ["第一步", "第二步", "第三步"])  # 有序
        self.assertEqual([ok for _, ok in out.steps], [True, False, False])

    def test_子目标全过且verify过_才算过(self):
        t = _task(checklist=(("rc为零", lambda c: c["rc"] == 0),), verify=lambda c: True)
        with tempfile.TemporaryDirectory() as d:
            out = core.run_once(t, Path(d))
        self.assertTrue(out.passed)
        self.assertIsNone(out.failed_step)

    def test_子目标全过但终态verify挂_仍不过且无子目标归因(self):
        t = _task(checklist=(("rc为零", lambda c: True),), verify=lambda c: False)
        with tempfile.TemporaryDirectory() as d:
            out = core.run_once(t, Path(d))
        self.assertFalse(out.passed)
        self.assertIsNone(out.failed_step)                   # 挂在终态而非某个子目标

    def test_子目标断言自己崩_记该步未过不掀翻套件(self):
        def boom(c):
            raise RuntimeError("断言挂了")
        t = _task(checklist=(("会崩的步", boom),))
        with tempfile.TemporaryDirectory() as d:
            out = core.run_once(t, Path(d))
        self.assertFalse(out.passed)
        self.assertEqual(out.failed_step, "会崩的步")

    def test_无checklist老任务_行为零变更(self):
        t = _task(verify=lambda c: True)
        with tempfile.TemporaryDirectory() as d:
            out = core.run_once(t, Path(d))
        self.assertTrue(out.passed)
        self.assertEqual(out.steps, ())
        self.assertIsNone(out.failed_step)

    def test_写文件种子已编入有序checklist且真过(self):
        seed = next(t for t in SEEDS if "写文件" in t.name)
        self.assertTrue(seed.checklist, "写文件种子应带 §4.6.1 有序子目标 checklist")
        with tempfile.TemporaryDirectory() as d:
            out = core.run_once(seed, Path(d))
        self.assertTrue(out.passed, f"failed_step={out.failed_step}")
        self.assertEqual([ok for _, ok in out.steps], [True] * len(out.steps))


# ── 金标准日志分层归因（喂真机全程日志文本，离线纯函数）──

_WIN_PASS_LOG = """\
----- look（第 1 次）-----
已建根视口 v2
----- zoom(v2, mark_no=3「数字键盘」, k=3)（第 1 次）-----
已建子视口 v3
[验收点] 子视口 v3 里「5/五」：[(7, '五', 'uia')]
[金标准一·第一步] 显示屏出现 5：✅（UIA='5'，OCR=None）
[金标准一·第二步] 显示屏出现 52：✅（UIA='52'，OCR=None）
[金标准二] 显示屏归零：✅（UIA='0'，OCR=None）
=== 总结：金标准一 ✅ 通过（5:True 52:True）；金标准二 ✅ 通过 ===
"""

_WIN_ZOOM_FAIL_LOG = """\
----- look（第 1 次）-----
已建根视口 v2
----- zoom(v2, mark_no=3「数字键盘」, k=3)（第 3 次）-----
已建子视口 v5
!! 3 次 zoom 子视口都没有「5」标记 → 金标准一失败
"""

_WIN_ACTION_FAIL_LOG = """\
已建根视口 v2
已建子视口 v3
[金标准一·第一步] 显示屏出现 5：❌（UIA='0'，OCR=None）
[金标准一·第二步] 显示屏出现 52：❌（UIA='0'，OCR=None）
[金标准二] 显示屏归零：✅（UIA='0'，OCR=None）
=== 总结：金标准一 ❌ 未过（5:False 52:False）；金标准二 ✅ 通过 ===
"""

_MAC_TASK_FAIL_LOG = """\
已建根视口 v2
已建子视口 v3
[金标准一·第一步] 显示屏出现 5：✅（剪贴板='5'，OCR=None）
[金标准一·第二步] 显示屏出现 52：✅（剪贴板='52'，OCR=None）
[金标准二] 显示屏归零：❌（剪贴板='52'，OCR=None）
=== 总结：金标准一 ✅ 通过（5:True 52:True）；金标准二 ❌ 未过 ===
"""


class 金标准日志归因(unittest.TestCase):
    def test_全过日志_三层全绿无归因(self):
        r = matrix.parse_gold_log(_WIN_PASS_LOG)
        self.assertEqual(r["grounding"], True)
        self.assertEqual(r["action"], True)
        self.assertEqual(r["task"], True)
        self.assertIsNone(r["failed_layer"])

    def test_zoom定位失败_归因元素定位层(self):
        r = matrix.parse_gold_log(_WIN_ZOOM_FAIL_LOG)
        self.assertEqual(r["grounding"], False)
        self.assertIsNone(r["action"])                       # 没跑到下层 → None（不诬报）
        self.assertIsNone(r["task"])
        self.assertEqual(r["failed_layer"], "grounding")

    def test_点了没生效_归因动作执行层(self):
        r = matrix.parse_gold_log(_WIN_ACTION_FAIL_LOG)
        self.assertEqual(r["grounding"], True)               # 子视口建成了 = 定位到了
        self.assertEqual(r["action"], False)
        self.assertEqual(r["failed_layer"], "action")

    def test_步骤全过但终态回归挂_归因任务完成层(self):
        r = matrix.parse_gold_log(_MAC_TASK_FAIL_LOG)
        self.assertEqual(r["action"], True)
        self.assertEqual(r["task"], False)
        self.assertEqual(r["failed_layer"], "task")

    def test_半截日志_全None不误报红(self):
        r = matrix.parse_gold_log("=== 裁剪-重问 Windows 真机金标准 ===\n[准备] 计算器没在跑")
        self.assertIsNone(r["grounding"])
        self.assertIsNone(r["action"])
        self.assertIsNone(r["task"])
        self.assertIsNone(r["failed_layer"])


def _cell(id, layer, platform, kind="auto", run=None, cmd="", parse=None):
    return matrix.Cell(id=id, layer=layer, platform=platform, kind=kind,
                       run=run, cmd=cmd, parse=parse)


class 矩阵编排(unittest.TestCase):
    def test_注册表三层双平台各一格_且引用真入口(self):
        seen = {(c.layer, c.platform) for c in matrix.MATRIX}
        self.assertEqual(seen, {(l, p) for l in matrix.LAYERS for p in matrix.PLATFORMS})
        ids = {c.id for c in matrix.MATRIX}
        self.assertIn("ocr-blindspot-win", ids)              # 定位层接 OCR 盲区回归集
        self.assertIn("gold-standard-win", ids)              # 执行/完成层接真机金标准
        for c in matrix.MATRIX:
            if c.kind == "manual":
                self.assertTrue(c.cmd, f"{c.id} 手动入口必须给跑法")
                self.assertIsNotNone(c.parse, f"{c.id} 手动入口必须给日志归因器")

    def test_平台不符skip_手动格manual_auto格真跑(self):
        cells = [_cell("a", "grounding", "win", run=lambda: True),
                 _cell("b", "grounding", "mac", run=lambda: True),
                 _cell("c", "action", "win", kind="manual", cmd="py -3 x.py")]
        rs = {r.cell.id: r for r in matrix.run_matrix(cells, platform="win")}
        self.assertEqual(rs["a"].status, "pass")
        self.assertEqual(rs["b"].status, "skip")             # 他平台不跑
        self.assertEqual(rs["c"].status, "manual")
        self.assertIn("py -3 x.py", rs["c"].detail)

    def test_auto格runner抛异常_记fail不掀翻(self):
        def boom():
            raise RuntimeError("浏览器没了")
        rs = matrix.run_matrix([_cell("a", "grounding", "win", run=boom)], platform="win")
        self.assertEqual(rs[0].status, "fail")
        self.assertIn("浏览器没了", rs[0].detail)

    def test_喂日志_状态精确按层(self):
        cells = [_cell("gold-g", "grounding", "win", kind="manual", cmd="x", parse=matrix.parse_gold_log),
                 _cell("gold-a", "action", "win", kind="manual", cmd="x", parse=matrix.parse_gold_log),
                 _cell("gold-t", "task", "win", kind="manual", cmd="x", parse=matrix.parse_gold_log)]
        rs = {r.cell.id: r for r in matrix.run_matrix(cells, platform="win")}
        matrix.apply_gold_log(list(rs.values()), "win", _WIN_ZOOM_FAIL_LOG)
        self.assertEqual(rs["gold-g"].status, "fail")
        self.assertEqual(rs["gold-a"].status, "manual")      # 日志无证据 → 保持 manual，不诬报
        self.assertEqual(rs["gold-t"].status, "manual")


class 矩阵报告(unittest.TestCase):
    def _results(self):
        cells = [_cell("g-win", "grounding", "win", run=lambda: False),
                 _cell("a-win", "action", "win", kind="manual", cmd="py -3 evals/gold_standard_win.py"),
                 _cell("t-win", "task", "win", kind="manual", cmd="py -3 evals/gold_standard_win.py"),
                 _cell("g-mac", "grounding", "mac", run=lambda: True),
                 _cell("a-mac", "action", "mac", kind="manual", cmd="python3 evals/gold_standard_mac.py"),
                 _cell("t-mac", "task", "mac", kind="manual", cmd="python3 evals/gold_standard_mac.py")]
        return matrix.run_matrix(cells, platform="win")

    def test_报告含三层双平台格_上层挂下层标无意义(self):
        report = matrix.render_report(self._results())
        self.assertIn("元素定位", report)
        self.assertIn("动作执行", report)
        self.assertIn("任务完成", report)
        self.assertIn("Windows", report)
        self.assertIn("macOS", report)
        # win 定位层挂 → win 执行/完成层标「上层未过」（下层分数无意义，§4.6.2 失败归因纪律）
        self.assertIn("上层未过", report)
        # 归因行直接点名挂的是哪层
        self.assertIn("元素定位", report.split("归因")[1])

    def test_报告列出手动入口跑法(self):
        report = matrix.render_report(self._results())
        self.assertIn("py -3 evals/gold_standard_win.py", report)
        self.assertIn("python3 evals/gold_standard_mac.py", report)

    def test_main_全绿退0_有fail退1(self):
        ok_cells = [_cell("g", "grounding", "win", run=lambda: True)]
        bad_cells = [_cell("g", "grounding", "win", run=lambda: False)]
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc_ok = matrix.main(["--platform", "win"], cells=ok_cells)
        with redirect_stdout(buf):
            rc_bad = matrix.main(["--platform", "win"], cells=bad_cells)
        self.assertEqual(rc_ok, 0)
        self.assertEqual(rc_bad, 1)
        self.assertIn("元素定位", buf.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
