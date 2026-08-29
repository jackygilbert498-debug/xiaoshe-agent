"""P3 v0.6a · 视觉 blob 目录跟随会话档案 LRU 清理，别留孤儿。TDD 红→绿。

评委点名：save_session 的 LRU 只 unlink 旧 .json、不清 .state/vision/<sid>/，视觉目录会成孤儿。
运行：仓库根 `python -m unittest discover -s tests -v`
"""
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest import mock

from harness import session, vision


def solid_png(w, h, rgb=(10, 20, 30)):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


class 视觉目录清理(unittest.TestCase):
    def test_purge_session删掉整个视觉目录(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(vision, "VISION_DIR", Path(d)):
                vision.put_image("gone", solid_png(10, 10))
                self.assertTrue((Path(d) / "gone").exists())
                vision.purge_session("gone")
                self.assertFalse((Path(d) / "gone").exists())
                vision.purge_session("gone")  # 幂等：再删不炸

    def test_会话被LRU清时其视觉目录一并清(self):
        with tempfile.TemporaryDirectory() as d:
            vdir = Path(d) / "vision"
            with mock.patch.object(session, "SESSIONS_DIR", Path(d) / "sessions"), \
                    mock.patch.object(vision, "VISION_DIR", vdir), \
                    mock.patch.object(session, "_MAX_SESSIONS", 1):
                vision.put_image("A", solid_png(10, 10))     # A 的视觉目录
                self.assertTrue((vdir / "A").exists())
                session.save_session("A", [{"role": "user", "content": "x"}], [])
                session.save_session("B", [{"role": "user", "content": "y"}], [])  # 触发清最旧 A
                self.assertFalse((vdir / "A").exists())       # A 的视觉目录随会话档案一起清


if __name__ == "__main__":
    unittest.main(verbosity=2)
