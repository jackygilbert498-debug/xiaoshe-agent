"""P3 v2.1 / P2d · 平台能力层：TCC 检测 + 授权引导 + Win DPI。TDD 红→绿。

装眼睛前先探权限、未授权给**结构化引导**（绝不静默失败/假成功，P2d 验收锚）。真机才跑系统命令，
离线 TDD 注入假探针 + 平台名。运行：仓库根 `python -m unittest discover -s tests -v`
"""
import unittest

from harness import platform_caps as pc


def runner(rc=0, out="", err=""):
    return lambda argv: (rc, out, err)


class 截屏权限(unittest.TestCase):
    def test_mac未授权_报不可用且引导屏幕录制(self):
        ok, guide = pc.screen_capture_status(runner=runner(rc=1, err="could not create image from display"),
                                             plat="darwin")
        self.assertFalse(ok)
        self.assertIn("屏幕录制", guide)

    def test_mac已授权_可用无引导(self):
        ok, guide = pc.screen_capture_status(runner=runner(rc=0), plat="darwin")
        self.assertTrue(ok)
        self.assertEqual(guide, "")

    def test_windows截屏不需TCC_直接可用(self):
        ok, guide = pc.screen_capture_status(plat="win32")   # 不需注入 runner
        self.assertTrue(ok)


class 辅助功能权限(unittest.TestCase):
    def test_mac未授权_报不可用且引导辅助功能(self):
        ok, guide = pc.accessibility_status(runner=runner(rc=1, err="osascript is not allowed assistive access (-1719)"),
                                            plat="darwin")
        self.assertFalse(ok)
        self.assertIn("辅助功能", guide)

    def test_mac已授权_可用(self):
        ok, guide = pc.accessibility_status(runner=runner(rc=0, out="68"), plat="darwin")
        self.assertTrue(ok)


class DPI前置(unittest.TestCase):
    def test_非windows_无操作不炸返回False(self):
        self.assertFalse(pc.set_dpi_aware(plat="darwin"))

    def test_windows_调用不炸(self):
        # 真机没有 ctypes.windll 时也不能崩，返回布尔
        self.assertIn(pc.set_dpi_aware(plat="win32"), (True, False))


if __name__ == "__main__":
    unittest.main(verbosity=2)
