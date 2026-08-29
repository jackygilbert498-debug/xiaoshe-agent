"""P3 · observe 跨平台分发（Windows UIA/System.Drawing + DPI 前置）。TDD 红→绿。

⚠ Windows 命令**未在真 Windows 验证**（本机 Mac）——这里只测**平台分发**（哪个 OS 走哪条命令）
与 DPI 前置，可离线注入验；真 Windows 行为待有机器再验。归一 dump 格式两平台一致，解析器复用。
运行：仓库根 `python -m unittest discover -s tests -v`
"""
import unittest

from harness import observe


class AX分发(unittest.TestCase):
    def test_windows走UIA脚本(self):
        seen = {}
        observe.capture_ax(runner=lambda script: seen.setdefault("s", script) or "", plat="win32")
        self.assertIn("UIAutomation", seen["s"])           # 用了 Windows UIA 脚本
        self.assertIn("BoundingRectangle", seen["s"])

    def test_mac走AX脚本(self):
        seen = {}
        observe.capture_ax(runner=lambda script: seen.setdefault("s", script) or "", plat="darwin")
        self.assertIn("System Events", seen["s"])          # 用了 mac AX 脚本

    def test_其它平台回空串降级(self):
        self.assertEqual(observe.capture_ax(plat="linux"), "")


class Windows深度枚举(unittest.TestCase):
    """observe 要看得清真实控件（按钮/菜单项多嵌在容器里）→ 走整棵后代控件树，非只窗口直属子。
    且默认 PowerShell 管道输出是 GBK，capture_ax 按 utf-8 读会把中文元素名读成乱码 → 脚本须钉 UTF-8 输出。"""

    def test_UIA脚本走后代且滤掉隐藏元素(self):
        seen = {}
        observe.capture_ax(runner=lambda s: seen.setdefault("s", s) or "", plat="win32")
        self.assertIn("Descendants", seen["s"])            # 深枚举整棵控件树
        self.assertIn("IsOffscreen", seen["s"])            # 滤掉屏幕外/隐藏元素

    def test_UIA脚本钉UTF8输出_中文名不乱码(self):
        seen = {}
        observe.capture_ax(runner=lambda s: seen.setdefault("s", s) or "", plat="win32")
        self.assertIn("OutputEncoding", seen["s"])

    def test_observe与invoke共享枚举核以对齐index(self):
        # 元素表 ref 必须与 invoke 的 $items 索引严丝对齐 → 两脚本用同一枚举/过滤核
        uia, inv = observe._WIN_UIA_PS, observe._win_invoke_ps(0)
        for marker in ("Descendants", "IsOffscreenProperty", "$items"):
            self.assertIn(marker, uia)
            self.assertIn(marker, inv)

    def test_invoke脚本也钉UTF8输出(self):
        self.assertIn("OutputEncoding", observe._win_invoke_ps(0))

    def test_枚举核清元素名换行防索引错位(self):
        # 名字含换行会把一元素打成多物理行 → observe 解析丢行、与 invoke 的 $items 索引错位而点错元素 → 枚举核须清换行
        self.assertIn("-replace", observe._WIN_ENUM_CORE)
        self.assertIn(r"[\r\n\t]", observe._WIN_ENUM_CORE)


class 截图分发(unittest.TestCase):
    def test_windows走powershell_systemdrawing(self):
        seen = {}

        def runner(argv):
            seen["argv"] = argv
            return (0, "", "")
        observe.capture_screenshot(runner=runner, region=(0, 0, 800, 600), plat="win32")
        self.assertEqual(seen["argv"][0], "powershell")
        self.assertIn("System.Drawing", " ".join(seen["argv"]))
        self.assertIn("CopyFromScreen", " ".join(seen["argv"]))

    def test_mac走screencapture带区域(self):
        seen = {}

        def runner(argv):
            seen["argv"] = argv
            return (0, "", "")
        observe.capture_screenshot(runner=runner, region=(10, 20, 800, 600), plat="darwin")
        self.assertEqual(seen["argv"][0], "screencapture")
        self.assertIn("-R", seen["argv"])
        self.assertIn("10,20,800,600", seen["argv"])

    def test_其它平台降级引导(self):
        png, guide = observe.capture_screenshot(plat="linux")
        self.assertEqual(png, b"")
        self.assertTrue(guide)


if __name__ == "__main__":
    unittest.main(verbosity=2)
