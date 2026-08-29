"""imaging.py · 裁剪/整数倍放大（统一「裁剪-重问」子系统 P1 的地基）。TDD 红→绿。

spec：docs/superpowers/specs/2026-07-19-统一裁剪重问子系统-design.md §组件 2。
zoom 的像素腿：crop 按区域裁出 RGBA、upscale 整数倍最近邻放大（把 ~40px 目标抬到 ≥80px
供 OCR/模型看清）。越界 clamp、完全不相交/超像素闸/长度不符一律 ValueError（对齐既有契约）。
运行：仓库根 `python -m unittest tests.test_imaging_crop -v`
"""
import unittest

from harness import imaging


def _pattern(w, h):
    """每像素可寻址的图：像素 (x,y) = (x, y, x^y, 255)——逐像素断言靠它定位。"""
    px = bytearray()
    for y in range(h):
        for x in range(w):
            px += bytes((x % 256, y % 256, (x ^ y) % 256, 255))
    return bytes(px)


def _at(px, w, x, y):
    i = (y * w + x) * 4
    return tuple(px[i:i + 4])


class 裁剪(unittest.TestCase):
    def test_裁出区域逐像素正确(self):
        w, h = 6, 5
        px = _pattern(w, h)
        nw, nh, out = imaging.crop(w, h, px, (2, 1, 3, 2))
        self.assertEqual((nw, nh), (3, 2))
        for yy in range(nh):
            for xx in range(nw):
                self.assertEqual(_at(out, nw, xx, yy), _at(px, w, 2 + xx, 1 + yy),
                                 f"子图像素 ({xx},{yy}) 不等于源图 ({2 + xx},{1 + yy})")

    def test_整图原样裁出(self):
        w, h = 4, 3
        px = _pattern(w, h)
        nw, nh, out = imaging.crop(w, h, px, (0, 0, w, h))
        self.assertEqual((nw, nh), (w, h))
        self.assertEqual(bytes(out), px)

    def test_越界clamp到图内(self):
        w, h = 6, 5
        px = _pattern(w, h)
        # 右下越界：region 伸出图外 → clamp 回图内
        nw, nh, out = imaging.crop(w, h, px, (4, 3, 10, 10))
        self.assertEqual((nw, nh), (2, 2))
        self.assertEqual(_at(out, nw, 0, 0), _at(px, w, 4, 3))
        self.assertEqual(_at(out, nw, 1, 1), _at(px, w, 5, 4))

    def test_负起点clamp到图内(self):
        w, h = 6, 5
        px = _pattern(w, h)
        nw, nh, out = imaging.crop(w, h, px, (-2, -1, 4, 3))
        self.assertEqual((nw, nh), (2, 2))   # x∈[-2,2)∩[0,6)=[0,2)，y∈[-1,2)∩[0,5)=[0,2)
        self.assertEqual(_at(out, nw, 0, 0), _at(px, w, 0, 0))
        self.assertEqual(_at(out, nw, 1, 1), _at(px, w, 1, 1))

    def test_完全不相交_ValueError(self):
        w, h = 6, 5
        px = _pattern(w, h)
        for bad in ((10, 0, 2, 2),      # 整体在图右外
                    (0, 10, 2, 2),      # 整体在图下外
                    (-5, -5, 2, 2)):    # 整体在图左上外
            with self.assertRaises(ValueError, msg=f"region={bad} 应报 ValueError"):
                imaging.crop(w, h, px, bad)

    def test_clamp后尺寸为零_ValueError(self):
        w, h = 6, 5
        px = _pattern(w, h)
        with self.assertRaises(ValueError):
            imaging.crop(w, h, px, (2, 2, 0, 3))   # 宽 0
        with self.assertRaises(ValueError):
            imaging.crop(w, h, px, (2, 2, 3, -1))  # 负高

    def test_rgba长度不符_ValueError(self):
        with self.assertRaises(ValueError):
            imaging.crop(4, 3, b"\x00" * 10, (0, 0, 2, 2))

    def test_尺寸非法_ValueError(self):
        px = _pattern(4, 3)
        with self.assertRaises(ValueError):
            imaging.crop(0, 3, px, (0, 0, 1, 1))
        with self.assertRaises(ValueError):
            imaging.crop(4, -1, px, (0, 0, 1, 1))


class 放大(unittest.TestCase):
    def test_两倍放大_每个源像素变2x2块(self):
        w, h = 3, 2
        px = _pattern(w, h)
        nw, nh, out = imaging.upscale(w, h, px, 2)
        self.assertEqual((nw, nh), (6, 4))
        for y in range(nh):
            for x in range(nw):
                self.assertEqual(_at(out, nw, x, y), _at(px, w, x // 2, y // 2),
                                 f"({x},{y}) 应来自源像素 ({x // 2},{y // 2})")

    def test_三倍放大_每个源像素变3x3块(self):
        w, h = 2, 2
        px = _pattern(w, h)
        nw, nh, out = imaging.upscale(w, h, px, 3)
        self.assertEqual((nw, nh), (6, 6))
        for y in range(nh):
            for x in range(nw):
                self.assertEqual(_at(out, nw, x, y), _at(px, w, x // 3, y // 3))

    def test_非法倍数_ValueError(self):
        px = _pattern(2, 2)
        for k in (0, 1, 4, -2, 2.5):
            with self.assertRaises(ValueError, msg=f"k={k} 应报 ValueError"):
                imaging.upscale(2, 2, px, k)

    def test_超像素闸_ValueError(self):
        # 5000×5000(25MP) ×2 → 100MP > 50M 闸 → 拒绝（与 PDF 路径同值同理由）
        with self.assertRaises(ValueError):
            imaging.upscale(5000, 5000, b"", 2)

    def test_闸内不误伤(self):
        w, h = 8, 8
        nw, nh, out = imaging.upscale(w, h, _pattern(w, h), 3)
        self.assertEqual((nw, nh), (24, 24))
        self.assertEqual(len(out), 24 * 24 * 4)

    def test_rgba长度不符_ValueError(self):
        with self.assertRaises(ValueError):
            imaging.upscale(4, 3, b"\x00" * 10, 2)


class 裁剪编码往返(unittest.TestCase):
    def test_crop后encode再decode_像素一致(self):
        # 集成式：crop → encode_png → decode_png 往返（zoom 落图管道的最小闭环）
        w, h = 10, 8
        px = _pattern(w, h)
        nw, nh, sub = imaging.crop(w, h, px, (3, 2, 5, 4))
        png = imaging.encode_png(nw, nh, bytes(sub))
        dw, dh, dpx = imaging.decode_png(png)
        self.assertEqual((dw, dh), (nw, nh))
        self.assertEqual(bytes(dpx), bytes(sub))

    def test_crop加upscale后encode再decode_尺寸翻倍(self):
        w, h = 8, 6
        px = _pattern(w, h)
        nw, nh, sub = imaging.crop(w, h, px, (2, 2, 4, 3))
        uw, uh, up = imaging.upscale(nw, nh, sub, 2)
        dw, dh, dpx = imaging.decode_png(imaging.encode_png(uw, uh, bytes(up)))
        self.assertEqual((dw, dh), (8, 6))
        self.assertEqual(bytes(dpx), bytes(up))


if __name__ == "__main__":
    unittest.main()
