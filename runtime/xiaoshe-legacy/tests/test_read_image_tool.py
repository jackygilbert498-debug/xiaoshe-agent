"""P3-v3 · read_image 工具：加载工作区里的图片/PDF 文件进 vision 管道自己看。TDD 红→绿。

兑现 P3 验收锚「读图像文档」缺的那个工具。图片(PNG/JPEG)原生支持；PDF 用 sips 转首页（多页暂只读首页）。
只读工作区内文件（safe_path 拒越界/敏感），压图省 token；截图/图片像素属不可信（视觉注入残留，同 observe）。
运行：仓库根 `python -m unittest discover -s tests -v`
"""
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest import mock

from harness import permission
from harness import tools as tools_mod
from harness import vision


def solid_png(w, h, rgb=(10, 20, 30)):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


class read_image工具(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.root = Path(self._d.name)
        self._vp = mock.patch.object(vision, "VISION_DIR", self.root / "v")
        self._rp = mock.patch.object(permission, "ROOT", self.root)
        self._vp.start()
        self._rp.start()

    def tearDown(self):
        self._vp.stop()
        self._rp.stop()
        self._d.cleanup()

    def test_加载图片_入pending下一发看(self):
        (self.root / "chart.png").write_bytes(solid_png(300, 200))
        ctx = {"session_id": "s"}
        res = tools_mod.execute("read_image", {"path": "chart.png"}, ctx)
        self.assertFalse(res.is_error)
        self.assertEqual(ctx.get("_vision_pending"), ["img-1"])   # 图排队，下一发 materialize
        m = vision.meta("s", "img-1")
        self.assertEqual((m["w"], m["h"]), (300, 200))

    def test_大图加载时被压省token(self):
        (self.root / "big.png").write_bytes(solid_png(3200, 1000))

        def sips_fake(argv):   # 注入假 sips → hermetic（不依赖真机 sips，CI ubuntu 无 sips 也能过）
            with open(argv[argv.index("--out") + 1], "wb") as f:
                f.write(solid_png(1600, 500))
            return (0, "", "")
        ctx = {"session_id": "s", "_sips_runner": sips_fake}
        tools_mod.execute("read_image", {"path": "big.png"}, ctx)
        m = vision.meta("s", ctx["_vision_pending"][0])
        self.assertLessEqual(max(m["w"], m["h"]), 1600)          # 压到长边≤1600

    def test_不存在的文件_友好报错(self):
        res = tools_mod.execute("read_image", {"path": "nope.png"}, {"session_id": "s"})
        self.assertTrue(res.is_error)

    def test_非图片格式_友好提示不炸(self):
        (self.root / "a.txt").write_text("just text", encoding="utf-8")
        res = tools_mod.execute("read_image", {"path": "a.txt"}, {"session_id": "s"})
        self.assertIn("不是", res.content)                       # 不是支持的图片/PDF

    def test_越界或敏感路径被硬拒(self):
        self.assertEqual(permission.check("read_image", {"path": "/etc/passwd"}).action, "deny")

    def test_注册且是安全工具直接放行(self):
        self.assertIn("read_image", tools_mod.REGISTRY)
        names = [s["function"]["name"] for s in tools_mod.all_specs()]
        self.assertIn("read_image", names)
        self.assertEqual(permission.check("read_image", {"path": "chart.png"}).action, "approve")


if __name__ == "__main__":
    unittest.main(verbosity=2)
