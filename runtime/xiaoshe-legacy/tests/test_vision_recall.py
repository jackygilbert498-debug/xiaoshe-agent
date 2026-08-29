"""P3 v0.4 · recall 工具：按 ref 排队重看图 / 按 query 模糊找 / 无参看目录。TDD 红→绿。

安全：recall **只收不透明 ref、绝不收路径**（接口层天生免穿越）；未知/失效 ref 回墓碑话术、不炸、不读文件。
图 recall 不直接返回图，而是把 ref 塞进 ctx["_vision_pending"]，由 wire 在下一发尾部 materialize。
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
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


class recall工具(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self._p = mock.patch.object(vision, "VISION_DIR", Path(self._d.name))
        self._p.start()

    def tearDown(self):
        self._p.stop()
        self._d.cleanup()

    def test_按ref重看_排队待wire附图(self):
        ref = vision.put_image("s1", solid_png(200, 100), target="登录页")
        ctx = {"session_id": "s1"}
        out = vision.recall({"ref": ref}, ctx)
        self.assertIn(ref, out)
        self.assertEqual(ctx.get("_vision_pending"), [ref])   # 排队，等 wire 附上

    def test_未知或失效ref_墓碑话术不炸不读文件(self):
        ctx = {"session_id": "s1"}
        out = vision.recall({"ref": "img-999"}, ctx)
        self.assertIn("过期", out)
        self.assertNotIn("_vision_pending", ctx)

    def test_ref收到路径当普通不存在处理_不穿越(self):
        # 非空洞验证：先放一张真图让 index 非空，再造一个 blob 目录外的真实敏感文件，
        # 用穿越式 ref 指向它——必须当未知 ref(墓碑)、绝不读到该文件内容。
        vision.put_image("s1", solid_png(10, 10, (7, 7, 7)), target="真图")
        secret = Path(self._d.name).parent / "secret_target.txt"
        try:
            secret.write_text("TOP-SECRET-CONTENT", encoding="utf-8")
            ctx = {"session_id": "s1"}
            for bad in ("../../etc/passwd", f"../{secret.name}", "../../../secret_target.txt"):
                out = vision.recall({"ref": bad}, ctx)
                self.assertIn("过期", out)                   # 当未知 ref → 墓碑
                self.assertNotIn("TOP-SECRET", out)          # 绝不读到穿越目标内容
            self.assertNotIn("_vision_pending", ctx)
        finally:
            secret.unlink(missing_ok=True)

    def test_query模糊命中target(self):
        vision.put_image("s1", solid_png(20, 20, (1, 1, 1)), target="设置—通用")
        vision.put_image("s1", solid_png(20, 20, (2, 2, 2)), target="登录页")
        out = vision.recall({"query": "登录"}, {"session_id": "s1"})
        self.assertIn("img-2", out)
        self.assertNotIn("img-1", out)

    def test_无参看目录_新到旧倒序列出(self):
        vision.put_image("s1", solid_png(20, 20, (1, 1, 1)), target="甲")
        vision.put_image("s1", solid_png(20, 20, (2, 2, 2)), target="乙")
        out = vision.recall({}, {"session_id": "s1"})
        self.assertIn("img-1", out)
        self.assertIn("img-2", out)
        self.assertLess(out.index("img-2"), out.index("img-1"))  # 新(img-2)在旧(img-1)之前，兑现"新→旧"


class recall接入(unittest.TestCase):
    def test_recall在注册表且是安全工具直接放行(self):
        self.assertIn("recall", tools_mod.REGISTRY)
        self.assertEqual(permission.check("recall", {"ref": "img-1"}).action, "approve")
        names = [s["function"]["name"] for s in tools_mod.all_specs()]
        self.assertIn("recall", names)


if __name__ == "__main__":
    unittest.main(verbosity=2)
