"""evals/gold_standard_mac.py · 根视口 id 不得写死（2026-07-22 红队真跑复现）。TDD 红→绿。

真跑复现：look 第 1 次因焦点被抢没找到计算器「组」→ 重试第 2 次成功（根视口 v2），
但 zoom 写死 viewport_id="v1" → 放大的仍是第 1 次失败 look 的旧根视口（mark_no=1 是别的
窗口的组）→ 3 次 zoom 全在错误窗口里找「5」→ 金标准一假失败
（会话 goldstd-mac-20260722-224950 全程日志实证）。修复：从 look 输出解析真实根视口 id。
运行：仓库根 `python -m unittest tests.test_gold_standard_mac -v`
"""
import re
import unittest

from evals import gold_standard_mac as gsm


class 根视口id不写死(unittest.TestCase):
    def test_解析look输出里的真实根视口id(self):
        self.assertEqual(gsm._root_vid("已建根视口 v2（整屏 2560x1440 像素，scale=1）"), "v2")
        self.assertEqual(gsm._root_vid("已建根视口 v17（整屏 2560x1440 像素，scale=1）"), "v17")

    def test_解析不到根视口id_响亮拒(self):
        with self.assertRaises(ValueError):
            gsm._root_vid("已建根视口\n没有 id 的输出")

    def test_zoom用解析出的根视口id_不写死v1(self):
        with open(gsm.__file__, encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn('"viewport_id": "v1"', src, "zoom 不得写死 v1——look 重试后根视口是 v2/v3…")
        m = re.search(r'tools\._zoom\(\{"viewport_id": (\w+),', src)
        self.assertTrue(m, "zoom 调用应传解析出的根视口 id 变量")
        self.assertNotEqual(m.group(1).strip("\"'"), "v1")


if __name__ == "__main__":
    unittest.main()
