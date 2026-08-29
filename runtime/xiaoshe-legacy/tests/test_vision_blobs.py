"""P3 v0.2 · vision blob 存储：图片落盘 + sha256 去重 + 确定性 ref + data_uri + 指针文字。TDD 红→绿。

不变式：history 里只放**指针文字**，图字节只落磁盘（回捞权威）；ref 确定性（img-<会话内序号>、
无时间戳/随机），指针一旦写进 history 就永不变 → 不破坏 prompt 缓存前缀。sha256 去重让同图复用同 ref。
运行：仓库根 `python -m unittest discover -s tests -v`
"""
import base64
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest import mock

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


class blob存储(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self._p = mock.patch.object(vision, "VISION_DIR", Path(self._d.name))
        self._p.start()

    def tearDown(self):
        self._p.stop()
        self._d.cleanup()

    def test_落盘返回确定性ref_meta带尺寸与token(self):
        ref = vision.put_image("s1", solid_png(320, 200))
        self.assertEqual(ref, "img-1")            # 确定性、无时间戳
        m = vision.meta("s1", ref)
        self.assertEqual((m["w"], m["h"]), (320, 200))
        self.assertEqual(m["tokens_est"], vision.image_tokens(320, 200))

    def test_同图去重复用同ref_不重复落盘(self):
        png = solid_png(64, 64)
        r1 = vision.put_image("s1", png)
        r2 = vision.put_image("s1", png)          # 同字节
        self.assertEqual(r1, r2)
        imgs = list((Path(self._d.name) / "s1").glob("img-*.png"))
        self.assertEqual(len(imgs), 1)            # 只落一份

    def test_不同图给不同递增ref(self):
        r1 = vision.put_image("s1", solid_png(10, 10, (1, 2, 3)))
        r2 = vision.put_image("s1", solid_png(10, 10, (9, 9, 9)))
        self.assertEqual((r1, r2), ("img-1", "img-2"))

    def test_data_uri往返还原原字节(self):
        png = solid_png(48, 48)
        ref = vision.put_image("s1", png)
        uri = vision.data_uri("s1", ref)
        self.assertTrue(uri.startswith("data:image/png;base64,"))
        self.assertEqual(base64.b64decode(uri.split(",", 1)[1]), png)

    def test_指针文字含ref尺寸与recall提示(self):
        ref = vision.put_image("s1", solid_png(1280, 800))
        ptr = vision.pointer_text("s1", ref)
        self.assertIn(ref, ptr)
        self.assertIn("1280", ptr)
        self.assertIn("recall", ptr)

    def test_未知ref的meta与datauri不炸(self):
        self.assertIsNone(vision.meta("s1", "img-999"))
        self.assertIsNone(vision.data_uri("s1", "img-999"))

    def test_跨调用序号续接不从头(self):
        vision.put_image("s1", solid_png(10, 10, (1, 1, 1)))
        vision.put_image("s1", solid_png(10, 10, (2, 2, 2)))
        # 重新按现有 index 续号（模拟重启后仍读得到既有条目）
        r3 = vision.put_image("s1", solid_png(10, 10, (3, 3, 3)))
        self.assertEqual(r3, "img-3")


if __name__ == "__main__":
    unittest.main(verbosity=2)
