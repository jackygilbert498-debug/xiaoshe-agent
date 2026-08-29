"""P3 v0.3 · wire：pending 图在发送副本尾部 materialize。TDD 红→绿。

承重不变式（评委一致点名的最扎实一块）：history **永不含 base64**；图只在"这一发的临时副本尾部"
出现。wire 每次调用都写 ctx["_vision_last_tokens"]（无图=0，修"从不归零→压缩欠触发"锚点 bug）；
单发最多 VISION_LIVE_MAX 张（防一次撞 3.2M）；失效 ref 跳过不炸。
运行：仓库根 `python -m unittest discover -s tests -v`
"""
import json
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


def _has_base64(history) -> bool:
    return "base64" in json.dumps(history, ensure_ascii=False)


class wire承重(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self._p = mock.patch.object(vision, "VISION_DIR", Path(self._d.name))
        self._p.start()

    def tearDown(self):
        self._p.stop()
        self._d.cleanup()

    def test_无pending_原样返回_锚点归零(self):
        hist = [{"role": "user", "content": "hi"}]
        ctx = {"session_id": "s1"}
        out = vision.wire(hist, ctx)
        self.assertEqual(out, hist)
        self.assertEqual(ctx["_vision_last_tokens"], 0)  # 每次都写、无图=0

    def test_有pending_图拼到尾部_history不被污染(self):
        ref = vision.put_image("s1", solid_png(1280, 800))
        hist = [{"role": "user", "content": "看下界面"},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "c1", "type": "function", "function": {"name": "observe", "arguments": "{}"}}]},
                {"role": "tool", "tool_call_id": "c1", "content": vision.pointer_text("s1", ref)}]
        ctx = {"session_id": "s1", "_vision_pending": [ref]}
        out = vision.wire(hist, ctx)
        # 尾部多一条 user 带图消息
        self.assertEqual(len(out), len(hist) + 1)
        tail = out[-1]
        self.assertEqual(tail["role"], "user")
        urls = [p["image_url"]["url"] for p in tail["content"] if p.get("type") == "image_url"]
        self.assertEqual(len(urls), 1)
        self.assertTrue(urls[0].startswith("data:image"))
        # ★ 关键：原 history 未被 mutate、且不含任何 base64（resume 免疫）
        self.assertEqual(len(hist), 3)
        self.assertFalse(_has_base64(hist))
        # pending 被消费；锚点=该图 token
        self.assertNotIn("_vision_pending", ctx)
        self.assertEqual(ctx["_vision_last_tokens"], vision.image_tokens(1280, 800))

    def test_单发最多两张(self):
        refs = [vision.put_image("s1", solid_png(20, 20, (i, i, i))) for i in (1, 2, 3)]
        ctx = {"session_id": "s1", "_vision_pending": refs}
        out = vision.wire([{"role": "user", "content": "x"}], ctx)
        urls = [p for p in out[-1]["content"] if p.get("type") == "image_url"]
        self.assertEqual(len(urls), vision.VISION_LIVE_MAX)
        self.assertEqual(vision.VISION_LIVE_MAX, 2)

    def test_失效ref跳过不炸(self):
        ctx = {"session_id": "s1", "_vision_pending": ["img-999"]}
        out = vision.wire([{"role": "user", "content": "x"}], ctx)
        self.assertEqual(len(out), 1)                 # 没有可 materialize 的图 → 原样
        self.assertEqual(ctx["_vision_last_tokens"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
