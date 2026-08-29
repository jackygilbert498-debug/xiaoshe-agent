"""P4 · 视觉C 收口 · list_windows 工具：列出当前打开的顶层窗口标题，供 focus_window 挑目标。TDD 红→绿。

「操作别的 app/浏览器」闭环缺的一环：agent 跑在终端里，要操作别的窗口得先知道有哪些窗口开着 → list_windows 列窗口
→ focus_window 切过去 → observe 看元素 → click/press 操作。窗口标题=不可信外部数据 → 入污点。可注入 runner 离线 TDD。
运行：仓库根 `python -m unittest tests.test_list_windows -v`
"""
import unittest

from harness import observe, permission
from harness import tools as tools_mod


class list_windows解析(unittest.TestCase):
    def test_按行解析窗口标题(self):
        raw = "Google Chrome — 小蛇 · GitHub\n计算器 — 计算器\nFinder — 下载"
        titles = observe.list_windows(runner=lambda s: raw)
        self.assertEqual(len(titles), 3)
        self.assertIn("Google Chrome — 小蛇 · GitHub", titles)

    def test_跳过APP_WIN_ERR噪声行与空行(self):
        raw = "APP: X\n\n计算器 — 计算器\nERR: boom\n"
        self.assertEqual(observe.list_windows(runner=lambda s: raw), ["计算器 — 计算器"])

    def test_注入runner时linux也走runner保CI水密(self):
        titles = observe.list_windows(runner=lambda s: "A — B", plat="linux")
        self.assertEqual(titles, ["A — B"])         # 注入 runner 一律优先于平台分发（同 capture_ax）

    def test_无runner时不支持平台回空(self):
        self.assertEqual(observe.list_windows(plat="linux"), [])

    def test_mac脚本源头清窗口名换行防伪造条目(self):
        # 窗口名含 \n 会被 split("\n") 拆成假窗口条目（伪造「Safari — Bank Login」诱导 focus 错窗口）→ 源头须清换行
        self.assertIn("text item delimiters", observe._MAC_LIST_AS)


class list_windows工具(unittest.TestCase):
    def test_列窗口并入污点(self):
        raw = "Google Chrome — 某个足够长的不可信网页标题用于验证窗口标题是否入污点必须超过三十二个字符\n计算器 — 计算器"
        ctx = {"_winlist_runner": lambda s: raw}
        res = tools_mod.execute("list_windows", {}, ctx)
        self.assertFalse(res.is_error)
        self.assertIn("计算器", res.content)
        self.assertIn("Google Chrome", res.content)
        self.assertTrue(any("不可信网页标题" in t for t in ctx.get("_tainted", set())))

    def test_无窗口给友好提示(self):
        res = tools_mod.execute("list_windows", {}, {"_winlist_runner": lambda s: ""})
        self.assertFalse(res.is_error)
        self.assertIn("没列到", res.content)

    def test_注册且默认ask(self):
        self.assertIn("list_windows", tools_mod.REGISTRY)
        self.assertEqual(permission.check("list_windows", {}).action, "ask")


if __name__ == "__main__":
    unittest.main(verbosity=2)
