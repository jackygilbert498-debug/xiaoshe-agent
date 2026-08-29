"""P3 v1.2 · 真机渲染（可注入 runner）：render() 产出截图字节 + DOM + 退出码。TDD 红→绿。

真机才 shell out 浏览器；离线 TDD 注入假 runner（照 scheduler_install 的可注入套路）。
render 不碰 base64、不进 history——截图字节交给上层塞进 vision 管道。
运行：仓库根 `python -m unittest discover -s tests -v`
"""
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest import mock

from harness import permission, render


def solid_png(w, h, rgb=(10, 20, 30)):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


def make_fake_runner(rc_shot=0, rc_dom=0, dom="<html><body><h1>登录</h1></body></html>", write_png=True):
    def fake(argv):
        if "--dump-dom" in argv:
            return (rc_dom, dom, "")
        for a in argv:                       # 截图轮：把假 png 写到 --screenshot=<path>
            if a.startswith("--screenshot=") and write_png:
                Path(a.split("=", 1)[1]).write_bytes(solid_png(120, 80))
        return (rc_shot, "", "" if rc_shot == 0 else "boom")
    return fake


class 渲染执行(unittest.TestCase):
    def _root(self, d):
        (Path(d) / "page.html").write_text("<h1>登录</h1>", encoding="utf-8")
        return mock.patch.object(permission, "ROOT", Path(d))

    def test_渲染成功_带截图字节与DOM(self):
        with tempfile.TemporaryDirectory() as d, self._root(d):
            res = render.render("page.html", browser="chrome", runner=make_fake_runner())
            self.assertTrue(res.ok)
            self.assertEqual(res.exit_code, 0)
            self.assertTrue(res.png.startswith(b"\x89PNG"))   # 拿到截图字节
            self.assertIn("登录", res.dom)                     # 拿到 DOM

    def test_退出码非零_ok为假(self):
        with tempfile.TemporaryDirectory() as d, self._root(d):
            res = render.render("page.html", browser="chrome",
                                runner=make_fake_runner(rc_shot=1, write_png=False))
            self.assertFalse(res.ok)
            self.assertIn("boom", res.stderr)

    def test_截图没生成_ok为假(self):
        with tempfile.TemporaryDirectory() as d, self._root(d):
            res = render.render("page.html", browser="chrome",
                                runner=make_fake_runner(rc_shot=0, write_png=False))
            self.assertFalse(res.ok)                           # 退出码0但没截图 → 不算成功

    def test_渲染临时png用完清理不留垃圾(self):
        with tempfile.TemporaryDirectory() as d, self._root(d):
            seen = {}
            base = make_fake_runner()

            def spy(argv):
                for a in argv:
                    if a.startswith("--screenshot="):
                        seen["png"] = a.split("=", 1)[1]
                return base(argv)
            render.render("page.html", browser="chrome", runner=spy)
            self.assertIn("png", seen)
            self.assertFalse(Path(seen["png"]).exists())       # 读完即删、不留临时文件

    def test_http被拒(self):
        with self.assertRaises(ValueError):
            render.render("https://evil.example.com/x.html", browser="chrome", runner=make_fake_runner())


if __name__ == "__main__":
    unittest.main(verbosity=2)
