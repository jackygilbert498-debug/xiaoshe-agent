"""P3 打磨 · 发送前压图省 token：长边 >1600 用 sips 压到 ≤1600。TDD 红→绿。

observe/render_check 原来发原生尺寸（如 2560×1440→服务端封顶 4202 tok）；压到长边≤1600（~2088 tok）省一半。
sips 是 macOS 系统工具（可注入 runner 离线测）；缺 sips/失败 → 原图（优雅降级、接受服务端降采样）。
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
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def _sips_fake(out_w, out_h):
    """假 sips：把目标 png 写到 --out 路径（模拟压好的图）。"""
    def fake(argv):
        out = argv[argv.index("--out") + 1]
        with open(out, "wb") as f:
            f.write(solid_png(out_w, out_h))
        return (0, "", "")
    return fake


class 压图省token(unittest.TestCase):
    def test_小图长边不超限_原样不压(self):
        img = solid_png(1200, 800)
        self.assertIs(vision.downscale_to_max(img, runner=_sips_fake(1, 1)), img)  # 未压=原对象

    def test_大图压到长边1600_保长宽比(self):
        big = solid_png(3200, 1600)          # 长边 3200 → 目标 (1600,800)
        out = vision.downscale_to_max(big, runner=_sips_fake(1600, 800))
        self.assertEqual(vision.image_size(out), (1600, 800))
        self.assertLessEqual(vision.image_tokens(*vision.image_size(out)), 4202)

    def test_压图后token明显下降(self):
        big = solid_png(2560, 1440)          # 原生 → 服务端封顶 4202 tok
        out = vision.downscale_to_max(big, runner=_sips_fake(1600, 900))
        self.assertLess(vision.image_tokens(*vision.image_size(out)), 4202)  # 压后 ~2088 < 4202

    def test_sips失败或缺工具_回落原图不炸(self):
        big = solid_png(3000, 1000)
        out = vision.downscale_to_max(big, runner=lambda a: (127, "", "sips not found"))
        self.assertEqual(out, big)           # 失败 → 原图（优雅降级）


if __name__ == "__main__":
    unittest.main(verbosity=2)
