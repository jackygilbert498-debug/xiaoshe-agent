"""imaging.py · 纯标准库跨平台像素能力（PNG 解码/编码 + 画框 + 数字标号）。TDD 红→绿。

SoM(Set-of-Mark) grounding 的地基：把 observe 的元素 bbox 画成编号框叠到截图上，
让 Kimi 回"点几号"而非报坐标。一份代码 Win/Mac 通用（不走 System.Drawing/CoreGraphics 分叉）。
运行：仓库根 `python -m unittest tests.test_imaging -v`
"""
import struct
import unittest
import zlib

from harness import imaging


def _build_png(w, h, rgba, ftype=0):
    """独立构造一张合法 PNG（不经 imaging.encode），用来验 imaging.decode。
    支持 filter 0(None) 与 2(Up)——覆盖"无滤波"和一种"逐行预测"两条解码路径。"""
    assert len(rgba) == w * h * 4
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        row = rgba[y * stride:(y + 1) * stride]
        raw.append(ftype)
        if ftype == 0:
            raw.extend(row)
        elif ftype == 2:  # Up: 存 当前 - 上一行
            prev = rgba[(y - 1) * stride:y * stride] if y > 0 else bytes(stride)
            raw.extend((row[i] - prev[i]) & 0xFF for i in range(stride))
        else:
            raise ValueError("测试只造 filter 0/2")

    def chunk(typ, data):
        return (struct.pack(">I", len(data)) + typ + data
                + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8bit RGBA 非隔行
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw))) + chunk(b"IEND", b""))


def _solid(w, h, color=(10, 20, 30, 255)):
    return bytes(bytearray(color) * (w * h))


def _png_with_idat(w, h, idat_raw):
    """构造：IHDR 声明 w×h，IDAT = zlib.compress(idat_raw)。用于喂恶意/畸形图（解压炸弹/巨尺寸）。"""
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(idat_raw)) + chunk(b"IEND", b""))


class PNG编解码(unittest.TestCase):
    def test_编码解码往返_像素一致(self):
        w, h = 5, 3
        px = bytearray()
        for y in range(h):
            for x in range(w):
                px += bytes((x * 40 % 256, y * 80 % 256, (x + y) * 30 % 256, 255))
        data = imaging.encode_png(w, h, bytes(px))
        dw, dh, dpx = imaging.decode_png(data)
        self.assertEqual((dw, dh), (w, h))
        self.assertEqual(bytes(dpx), bytes(px))

    def test_解码独立构造的PNG_filter0(self):
        w, h = 4, 4
        px = _solid(w, h, (200, 100, 50, 255))
        dw, dh, dpx = imaging.decode_png(_build_png(w, h, px, ftype=0))
        self.assertEqual((dw, dh), (w, h))
        self.assertEqual(bytes(dpx), px)

    def test_解码独立构造的PNG_filterUp(self):
        # 逐行预测滤波——解码最易错的一路，独立造出来验
        w, h = 4, 5
        px = bytearray()
        for y in range(h):
            for x in range(w):
                px += bytes(((x * 17 + y * 53) % 256, (y * 11) % 256, (x * 7) % 256, 255))
        dw, dh, dpx = imaging.decode_png(_build_png(w, h, bytes(px), ftype=2))
        self.assertEqual((dw, dh), (w, h))
        self.assertEqual(bytes(dpx), bytes(px))

    def test_不支持格式友好报错(self):
        with self.assertRaises(Exception):
            imaging.decode_png(b"not a png at all")
        with self.assertRaises(Exception):
            imaging.decode_png(b"\x89PNG\r\n\x1a\n" + b"\x00" * 20)  # 头对、体坏


class 画框与编号(unittest.TestCase):
    def test_画矩形_边框像素被着色(self):
        w, h = 20, 20
        px = bytearray(_solid(w, h, (0, 0, 0, 255)))
        red = (255, 0, 0, 255)
        imaging.draw_rect(px, w, h, 5, 5, 8, 8, color=red, thickness=1)

        def at(x, y):
            i = (y * w + x) * 4
            return tuple(px[i:i + 4])
        self.assertEqual(at(5, 5), red)          # 左上角边框
        self.assertEqual(at(12, 12), red)        # 右下角边框(5+8-1)
        self.assertEqual(at(9, 9), (0, 0, 0, 255))  # 框内部未被填充(仅描边)

    def test_画编号_标签区出现前景像素(self):
        w, h = 40, 20
        px = bytearray(_solid(w, h, (0, 0, 0, 255)))
        imaging.draw_label(px, w, h, 2, 2, "12", fg=(255, 255, 0, 255), bg=(0, 0, 255, 255))
        # 标签区应出现前景(黄)像素——即模型能"读到数字"
        fg_hits = sum(1 for i in range(0, len(px), 4)
                      if tuple(px[i:i + 4]) == (255, 255, 0, 255))
        self.assertGreater(fg_hits, 0, "编号数字没画出前景像素")

    def test_边界安全_框超出图不崩(self):
        w, h = 10, 10
        px = bytearray(_solid(w, h))
        imaging.draw_rect(px, w, h, 8, 8, 20, 20, color=(255, 0, 0, 255), thickness=2)  # 越界
        imaging.draw_label(px, w, h, 9, 9, "20", fg=(255, 255, 0, 255), bg=(0, 0, 0, 255))
        self.assertEqual(len(px), w * h * 4)  # 没越写、长度不变


class SoM画标整链(unittest.TestCase):
    def test_draw_marks_产出合法PNG且尺寸不变(self):
        w, h = 60, 40
        png = imaging.encode_png(w, h, _solid(w, h, (30, 30, 30, 255)))
        marks = [{"box": (5, 5, 20, 12), "label": "1"},
                 {"box": (30, 20, 15, 10), "label": "2"}]
        out = imaging.draw_marks(png, marks)
        dw, dh, dpx = imaging.decode_png(out)
        self.assertEqual((dw, dh), (w, h))       # 尺寸不变
        # 画了框：应出现非背景像素
        bg = (30, 30, 30, 255)
        non_bg = sum(1 for i in range(0, len(dpx), 4) if tuple(dpx[i:i + 4]) != bg)
        self.assertGreater(non_bg, 0, "draw_marks 没在图上留下任何标记")

    def test_draw_marks_空列表_原样返回可解码(self):
        w, h = 20, 20
        png = imaging.encode_png(w, h, _solid(w, h))
        out = imaging.draw_marks(png, [])
        dw, dh, _ = imaging.decode_png(out)
        self.assertEqual((dw, dh), (w, h))


class 真机截图解码(unittest.TestCase):
    def test_解码真实截图_尺寸与header一致(self):
        from harness import observe, vision
        png, _ = observe.capture_screenshot()
        if not png:
            self.skipTest("本机截图不可用（无 GUI/权限）")
        hdr = vision._png_size(png)
        if not hdr:
            self.skipTest("截图非 PNG 或 header 解析失败")
        dw, dh, dpx = imaging.decode_png(png)
        self.assertEqual((dw, dh), hdr)                 # 解码尺寸 == header 尺寸
        self.assertEqual(len(dpx), dw * dh * 4)         # 像素量对
        # 真机 PNG 用真实 filter，能解码=unfilter 全路径正确


class 恶意PNG防御(unittest.TestCase):
    """对抗审查修复：decode_png 面对不可信 PNG（将来 read_image 读网络图/用户图）的健壮性。"""

    def test_解压炸弹被拦(self):
        # IHDR 声明 2×2（预期 raw 18 字节），IDAT 却解压出 5MB → 有界解压识破、ValueError
        png = _png_with_idat(2, 2, b"\x00" * 5_000_000)
        with self.assertRaises(ValueError):
            imaging.decode_png(png)

    def test_巨尺寸被拦_不进解压分配(self):
        # 1 亿像素 > 5000 万上限 → IHDR 解析后立刻 ValueError（不分配大内存/不跑 unfilter）
        png = _png_with_idat(10000, 10000, b"\x00" * 10)
        with self.assertRaises(ValueError):
            imaging.decode_png(png)

    def test_解码只抛ValueError_不冒泡别的异常(self):
        # 契约：损坏/恶意一律 ValueError，让上层工具友好处理而非崩
        for bad in (b"", b"not png", b"\x89PNG\r\n\x1a\n" + b"\xff" * 30):
            with self.assertRaises(ValueError):
                imaging.decode_png(bad)

    def test_上限内正常图不误伤(self):
        w, h = 8, 8
        px = _solid(w, h, (100, 150, 200, 255))
        dw, dh, dpx = imaging.decode_png(imaging.encode_png(w, h, px))
        self.assertEqual((dw, dh), (w, h))
        self.assertEqual(bytes(dpx), px)


if __name__ == "__main__":
    unittest.main()
