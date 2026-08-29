"""视觉 · PDF 读取修复：Windows 用 WinRT Windows.Data.Pdf 渲染首页，替 mac-only 的 sips。TDD 红→绿。

真 bug：read_image 读 PDF → vision.pdf_to_png → sips，sips 是 macOS 独有 → Windows 上读 PDF 直接死。
补 observe.pdf_to_png_win（零依赖 WinRT，探针真机验证过）+ vision.pdf_to_png 平台分发。
安全：PDF 路径走 base64（防同形字逃逸 RCE）、PdfPageRenderOptions 长边封顶（防恶意巨 PDF 撑爆位图）、PDF 内容不可信。
离线可跑（注入 runner，不起真 PS）；真机 WinRT E2E 另跑探针。
运行：仓库根 `python -m unittest tests.test_pdf_render -v`
"""
import base64
import unittest

from harness import imaging, observe, vision


def small_png():
    """构造一张真 PNG（imaging 编码），当作 PS 渲染回传的图。"""
    return imaging.encode_png(4, 3, bytes([10, 20, 30, 255]) * 12)


def ok_runner(png=None):
    """假 runner：模拟 WinRT PS 成功回传 base64 PNG（形如 OK|页数|b64）。"""
    png = png or small_png()
    b64 = base64.b64encode(png).decode()

    def fake(argv):
        return (0, f"OK|1|{b64}\n", "")
    return fake


def err_runner(msg="PDF 没有页面"):
    def fake(argv):
        return (0, f"ERR|{msg}\n", "")
    return fake


def crash_runner(rc=1, err="boom"):
    def fake(argv):
        return (rc, "", err)
    return fake


class win_pdf脚本安全(unittest.TestCase):
    def test_路径走base64不裸拼(self):
        ps = observe._win_pdf_ps("C:/危险'路径$(evil).pdf")
        self.assertNotIn("危险", ps)                 # 原文不出现在脚本里
        self.assertNotIn("evil", ps)
        self.assertIn("FromBase64String", ps)        # 走 base64 解回
        self.assertIn("Windows.Data.Pdf", ps)        # 用的是 WinRT PDF

    def test_有长边封顶(self):
        ps = observe._win_pdf_ps("x.pdf")
        self.assertIn("PdfPageRenderOptions", ps)
        self.assertIn("DestinationHeight", ps)


class pdf_to_png_win(unittest.TestCase):
    def test_成功回传PNG字节(self):
        want = small_png()
        ok, png, err = observe.pdf_to_png_win("a.pdf", runner=ok_runner(want), plat="win32")
        self.assertTrue(ok)
        self.assertEqual(png, want)
        self.assertEqual(err, "")

    def test_PS报ERR_优雅回错(self):
        ok, png, err = observe.pdf_to_png_win("a.pdf", runner=err_runner("PDF 没有页面"), plat="win32")
        self.assertFalse(ok)
        self.assertIsNone(png)
        self.assertIn("没有页面", err)

    def test_子进程非零_回错(self):
        ok, png, err = observe.pdf_to_png_win("a.pdf", runner=crash_runner(rc=1, err="爆了"), plat="win32")
        self.assertFalse(ok)
        self.assertIsNone(png)

    def test_坏base64_不崩(self):
        def bad(argv):
            return (0, "OK|1|@@@不是base64@@@\n", "")
        ok, png, err = observe.pdf_to_png_win("a.pdf", runner=bad, plat="win32")
        self.assertFalse(ok)
        self.assertIsNone(png)

    def test_非Windows无runner_明确不支持(self):
        ok, png, err = observe.pdf_to_png_win("a.pdf", plat="darwin")
        self.assertFalse(ok)
        self.assertIn("Windows", err)


class vision_pdf_to_png分发(unittest.TestCase):
    def test_win32走WinRT分支(self):
        want = small_png()
        png = vision.pdf_to_png(b"%PDF-1.4 fake", runner=ok_runner(want), plat="win32")
        self.assertEqual(png, want)

    def test_win32渲染失败回None(self):
        png = vision.pdf_to_png(b"%PDF-1.4 fake", runner=err_runner(), plat="win32")
        self.assertIsNone(png)

    def test_mac走sips分支(self):
        want = small_png()

        def sips_runner(argv):
            # sips argv: [..., in_p, "--out", out_p]；把 out_p 写成真 PNG（模拟 sips 转换成功）
            out_p = argv[-1]
            with open(out_p, "wb") as f:
                f.write(want)
            return (0, "", "")
        png = vision.pdf_to_png(b"%PDF-1.4 fake", runner=sips_runner, plat="darwin")
        self.assertEqual(png, want)

    def test_超大栅格被像素闸拦(self):
        # 渲染回来一张声称 9000×9000（8100 万像素 > 5000 万）的图 → 像素闸拒、回 None（红队 LOW-1/2）
        huge = imaging.encode_png(2, 2, bytes([0, 0, 0, 255]) * 4)
        # 伪造一张头部尺寸巨大的合法 PNG（只需 IHDR 尺寸大即可，image_size 只读头）
        import struct as _s
        import zlib as _z

        def _chunk(t, d):
            return _s.pack(">I", len(d)) + t + d + _s.pack(">I", _z.crc32(t + d) & 0xFFFFFFFF)
        big = (b"\x89PNG\r\n\x1a\n"
               + _chunk(b"IHDR", _s.pack(">IIBBBBB", 9000, 9000, 8, 6, 0, 0, 0))
               + _chunk(b"IDAT", _z.compress(b"\x00" * 16)) + _chunk(b"IEND", b""))
        png = vision.pdf_to_png(b"%PDF-1.4 fake", runner=ok_runner(big), plat="win32")
        self.assertIsNone(png)   # 超像素上限 → 不往下游送
        del huge


class read_image体积上限(unittest.TestCase):
    def setUp(self):
        import tempfile as _t
        from pathlib import Path
        from unittest import mock
        from harness import permission
        self._d = _t.TemporaryDirectory()
        self.root = Path(self._d.name)
        self._rp = mock.patch.object(permission, "ROOT", self.root)
        self._rp.start()
        self.addCleanup(self._rp.stop)
        self.addCleanup(self._d.cleanup)

    def test_超大文件读前被拒(self):
        from harness import tools as tools_mod
        big = self.root / "huge.pdf"
        big.write_bytes(b"%PDF-" + b"\x00" * (tools_mod._IMAGE_MAX_BYTES + 10))
        res = tools_mod.execute("read_image", {"path": "huge.pdf"}, {"session_id": "s"})
        self.assertTrue(res.is_error)
        self.assertIn("太大", res.content)


if __name__ == "__main__":
    unittest.main(verbosity=2)
