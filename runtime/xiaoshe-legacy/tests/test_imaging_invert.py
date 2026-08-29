"""imaging.py · 反色 invert（OCR 健壮性增强：白字深底/孤立字符漏识的反色补跑像素腿）。TDD 红→绿。

动机（2026-07-22 真机探针，docs/验收/裁剪重问-Mac金标准-证据.md 旁证）：Mac 计算器显示屏
白-on-深灰「0」Vision OCR 稳定漏识、数字键盘孤立数字四轮漏一轮——同区域反色图重 OCR 能
稳定认出（zh-Hans,en 认出字形、ja 字符分类最准）。二值化探针全灭，不实现。
invert 纯函数：逐像素 RGB 取 255-x、alpha 原样；几何不变（坐标不受反色影响，才能合并回原坐标系）。
运行：仓库根 `python -m unittest tests.test_imaging_invert -v`
"""
import unittest

from harness import imaging


def _pattern(w, h):
    """每像素可寻址的图：像素 (x,y) = (x, y, x^y, 200+y)——alpha 故意非 255，验 alpha 不动。"""
    px = bytearray()
    for y in range(h):
        for x in range(w):
            px += bytes((x % 256, y % 256, (x ^ y) % 256, (200 + y) % 256))
    return bytes(px)


def _at(px, w, x, y):
    i = (y * w + x) * 4
    return tuple(px[i:i + 4])


class 反色(unittest.TestCase):
    def test_逐像素RGB取255减(self):
        w, h = 6, 5
        px = _pattern(w, h)
        out = imaging.invert(w, h, px)
        self.assertEqual(len(out), w * h * 4)
        for y in range(h):
            for x in range(w):
                r, g, b, a = _at(px, w, x, y)
                self.assertEqual(_at(out, w, x, y), (255 - r, 255 - g, 255 - b, a),
                                 f"像素 ({x},{y}) 反色错误")

    def test_alpha通道原样不动(self):
        px = bytes((10, 20, 30, 0, 40, 50, 60, 128, 70, 80, 90, 255))
        out = imaging.invert(3, 1, px)
        self.assertEqual(tuple(out[3::4]), (0, 128, 255))

    def test_边界值_0变255_255变0_128变127(self):
        px = bytes((0, 255, 128, 255))
        out = imaging.invert(1, 1, px)
        self.assertEqual(tuple(out), (255, 0, 127, 255))

    def test_反色两次回到原图(self):
        w, h = 5, 4
        px = _pattern(w, h)
        self.assertEqual(bytes(imaging.invert(w, h, imaging.invert(w, h, px))), px)

    def test_几何不变_返回同尺寸(self):
        w, h = 7, 3
        out = imaging.invert(w, h, _pattern(w, h))
        self.assertEqual(len(out), w * h * 4)   # 不缩放不裁剪：词框坐标可直接并回原坐标系

    def test_rgba长度不符_ValueError(self):
        with self.assertRaises(ValueError):
            imaging.invert(4, 3, b"\x00" * 10)

    def test_尺寸非法_ValueError(self):
        px = _pattern(4, 3)
        with self.assertRaises(ValueError):
            imaging.invert(0, 3, px)
        with self.assertRaises(ValueError):
            imaging.invert(4, -1, px)

    def test_字节与bytearray入参都收(self):
        px = _pattern(3, 2)
        self.assertEqual(bytes(imaging.invert(3, 2, bytearray(px))),
                         bytes(imaging.invert(3, 2, px)))

    def test_encode再decode往返_像素一致(self):
        # 集成式：invert → encode_png → decode_png（反色补跑落临时文件管道的最小闭环）
        w, h = 8, 6
        out = imaging.invert(w, h, _pattern(w, h))
        dw, dh, dpx = imaging.decode_png(imaging.encode_png(w, h, bytes(out)))
        self.assertEqual((dw, dh), (w, h))
        self.assertEqual(bytes(dpx), bytes(out))


if __name__ == "__main__":
    unittest.main()
