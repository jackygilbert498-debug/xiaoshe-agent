"""P3 v1.5 · render_check 工具：模型渲染自己写的 HTML → 廉价硬信号 + 截图入 vision 管道自己看。TDD 红→绿。

「循环属于模型」：不做自主循环，给模型眼睛——渲染→DOM硬信号反馈→截图下一发materialize→模型自看自改。
复用 render.render(可注入runner) + vision.put_image + wire。渲染启浏览器子进程→默认 ask（不在 SAFE_TOOLS）；
path 走 permission 通用路径硬护栏（越界/敏感 deny）。
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
from harness import vibaseline
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


def make_fake_runner(rc_shot=0, dom="<html><body><h1>登录</h1><button>提交</button></body></html>", write_png=True):
    def fake(argv):
        if "--dump-dom" in argv:
            return (0, dom, "")
        for a in argv:
            if a.startswith("--screenshot=") and write_png:
                Path(a.split("=", 1)[1]).write_bytes(solid_png(160, 100))
        return (rc_shot, "", "" if rc_shot == 0 else "render boom")
    return fake


class render_check工具(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.root = Path(self._d.name)
        (self.root / "page.html").write_text("<h1>登录</h1><button>提交</button>", encoding="utf-8")
        self._vp = mock.patch.object(vision, "VISION_DIR", self.root / "v")
        self._rp = mock.patch.object(permission, "ROOT", self.root)
        self._bp = mock.patch.object(vibaseline, "BASELINE_FILE", self.root / "baseline.json")  # 别写真 .state
        self._vp.start()
        self._rp.start()
        self._bp.start()

    def tearDown(self):
        self._vp.stop()
        self._rp.stop()
        self._bp.stop()
        self._d.cleanup()

    def _ctx(self, **extra):
        return {"session_id": "s", "_render_runner": make_fake_runner(**extra),
                "_render_browser": "fake-chrome"}

    def test_渲染成功_截图入pending_DOM硬信号全过(self):
        ctx = self._ctx()
        res = tools_mod.execute("render_check", {"path": "page.html", "keywords": ["登录", "提交"]}, ctx)
        self.assertFalse(res.is_error)
        self.assertEqual(ctx.get("_vision_pending"), ["img-1"])   # 截图排队，下一发自己看
        self.assertIn("齐全", res.content)                        # DOM 硬信号全过

    def test_缺关键字_硬信号报缺(self):
        ctx = self._ctx()
        res = tools_mod.execute("render_check", {"path": "page.html", "keywords": ["登录", "没有的文案"]}, ctx)
        self.assertIn("没有的文案", res.content)                  # 报出缺哪个

    def test_渲染失败_报失败不塞图(self):
        ctx = self._ctx(rc_shot=1, write_png=False)
        res = tools_mod.execute("render_check", {"path": "page.html"}, ctx)
        self.assertIn("渲染失败", res.content)
        self.assertNotIn("_vision_pending", ctx)                  # 失败不塞图

    def test_越界path_权限层硬拒(self):
        self.assertEqual(permission.check("render_check", {"path": "/etc/passwd"}).action, "deny")

    def test_注册且默认先问(self):
        self.assertIn("render_check", tools_mod.REGISTRY)
        names = [s["function"]["name"] for s in tools_mod.all_specs()]
        self.assertIn("render_check", names)
        self.assertEqual(permission.check("render_check", {"path": "page.html"}).action, "ask")


if __name__ == "__main__":
    unittest.main(verbosity=2)
