"""P3 v0.1 · vision.py 纯函数地基：图像 token 记账 + 尺寸读取 + 压图计划。TDD 红→绿。

token 公式 ⌈W/28⌉×⌈H/28⌉、>3.2M 降采样到 ~4202 硬顶，均由真机探针实测（dg0/kimi_gen_probe），
此处当 oracle 钉死。尺寸读取纯标准库（PNG IHDR / JPEG SOF）；压图计划把长边压到 ≤1600。
运行：仓库根 `python -m unittest discover -s tests -v`
"""
import struct
import unittest
import zlib

from harness import vision


def solid_png(w, h, rgb=(10, 20, 30)):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


class 图像token记账(unittest.TestCase):
    def test_公式对齐真机探针(self):
        self.assertEqual(vision.image_tokens(448, 448), 256)     # ⌈448/28⌉²=16²
        self.assertEqual(vision.image_tokens(1280, 800), 1334)   # 46×29
        self.assertEqual(vision.image_tokens(1920, 1080), 2691)  # 69×39

    def test_超大图封顶到服务端降采样上限(self):
        self.assertEqual(vision.image_tokens(4096, 2160), 4202)  # 147×78=11466 → 封顶
        self.assertLessEqual(vision.image_tokens(10000, 10000), 4202)


class 尺寸读取(unittest.TestCase):
    def test_读png尺寸(self):
        self.assertEqual(vision.image_size(solid_png(320, 200)), (320, 200))

    def test_非图字节返回None(self):
        self.assertIsNone(vision.image_size(b"not an image at all"))
        self.assertIsNone(vision.image_size(""))  # 非 bytes 也不炸


class 压图计划(unittest.TestCase):
    def test_小图不压(self):
        self.assertIsNone(vision.plan_downscale(1200, 800))
        self.assertIsNone(vision.plan_downscale(1600, 1600))  # 恰在长边上限

    def test_横图长边超限压到1600保长宽比(self):
        self.assertEqual(vision.plan_downscale(3200, 1600), (1600, 800))
        self.assertEqual(vision.plan_downscale(2000, 1800), (1600, 1440))

    def test_竖图同样按长边压(self):
        self.assertEqual(vision.plan_downscale(1600, 3200), (800, 1600))

    def test_压后必稳在token硬顶下(self):
        w, h = vision.plan_downscale(4096, 2160)
        self.assertLessEqual(vision.image_tokens(w, h), 4202)
        self.assertLessEqual(max(w, h), 1600)


if __name__ == "__main__":
    unittest.main(verbosity=2)
