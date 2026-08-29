"""视觉回归基线：dHash 感知哈希（纯标准库）+ .state 基线 + render_check 接线。TDD 红→绿。

省钱/防静默失败：改了样式却没生效 → 重渲染截图与上次逐位一致 → dHash 距离 0 → 一眼报「基本一致」。
dHash 是**粗**的整体布局哈希：均匀色块恒为 0（只看梯度不看绝对亮度）、局部小字微调可能不变——措辞如实。
纯加信息、绝不抑制截图（模型永远拿到当前截图亲眼看）。全离线可验（不联网、不真屏幕）。
运行：仓库根 `python -m unittest tests.test_visual_baseline -v`
"""
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest import mock

from harness import imaging, vibaseline
from harness import permission
from harness import tools as tools_mod
from harness import vision


def solid(w, h, rgb=(20, 20, 20)):
    return imaging.encode_png(w, h, bytes([rgb[0], rgb[1], rgb[2], 255]) * (w * h))


def half(w, h, left=(10, 10, 10), right=(240, 240, 240)):
    """左半 left 色、右半 right 色——横向有梯度，dHash 非零。"""
    px = bytearray()
    for _y in range(h):
        for x in range(w):
            c = left if x < w // 2 else right
            px += bytes([c[0], c[1], c[2], 255])
    return imaging.encode_png(w, h, bytes(px))


def bands(w, h, a=(240, 240, 240), b=(10, 10, 10)):
    """竖直三段 a|b|a：既有下降沿又有上升沿 → dHash 非零（非 weak），作「有结构页」。
    注意 half()（左暗右亮）是单调渐变、dHash 恒 0（=weak），别用它当「有梯度」样本。"""
    px = bytearray()
    third = w // 3
    for _y in range(h):
        for x in range(w):
            c = b if third <= x < 2 * third else a
            px += bytes([c[0], c[1], c[2], 255])
    return imaging.encode_png(w, h, bytes(px))


def raw_png(w, h, rgb=(10, 20, 30)):
    """不经 imaging 编码的裸 PNG（给 fake runner 落盘用，避免依赖被测模块自身）。"""
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


class dHash纯函数(unittest.TestCase):
    def test_同图哈希相等距离0(self):
        img = half(64, 48)
        self.assertEqual(imaging.dhash(img), imaging.dhash(img))
        self.assertEqual(imaging.hamming(imaging.dhash(img), imaging.dhash(img)), 0)

    def test_均匀色块哈希恒0(self):
        # dHash 只看相邻梯度：纯色左不大于右 → 全 0（黑白同为 0，是已知特性，不是 bug）
        self.assertEqual(imaging.dhash(solid(40, 32, (0, 0, 0))), 0)
        self.assertEqual(imaging.dhash(solid(40, 32, (255, 255, 255))), 0)

    def test_左右反转产生明显距离(self):
        a = half(64, 48, left=(10, 10, 10), right=(240, 240, 240))
        b = half(64, 48, left=(240, 240, 240), right=(10, 10, 10))
        self.assertGreaterEqual(imaging.hamming(imaging.dhash(a), imaging.dhash(b)), 4)

    def test_坏字节抛ValueError(self):
        with self.assertRaises(ValueError):
            imaging.dhash(b"not a png at all")

    def test_hamming数位差(self):
        self.assertEqual(imaging.hamming(0b1010, 0b0011), 2)
        self.assertEqual(imaging.hamming(0, 0), 0)

    def test_极小图不崩(self):
        # 源比 9×8 目标格还小 → 空区域回落最近像素，不除零、不崩
        self.assertIsInstance(imaging.dhash(half(3, 2)), int)


class 基线模块(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.store = Path(self._d.name) / "baseline.json"
        self.addCleanup(self._d.cleanup)

    def test_首次渲染记基线(self):
        r = vibaseline.check("pageA", half(64, 48), store_path=self.store)
        self.assertTrue(r["ok"])
        self.assertTrue(r["first"])

    def test_同图判一致距离0(self):
        img = half(64, 48)
        vibaseline.check("pageA", img, store_path=self.store)
        r = vibaseline.check("pageA", img, store_path=self.store)
        self.assertFalse(r["first"])
        self.assertFalse(r["changed"])
        self.assertEqual(r["distance"], 0)

    def test_改图判变化(self):
        vibaseline.check("pageA", half(64, 48, left=(10, 10, 10), right=(240, 240, 240)), store_path=self.store)
        r = vibaseline.check("pageA", half(64, 48, left=(240, 240, 240), right=(10, 10, 10)), store_path=self.store)
        self.assertTrue(r["changed"])
        self.assertGreater(r["distance"], vibaseline._SAME_MAX)

    def test_不同key互不干扰(self):
        img = half(64, 48)
        vibaseline.check("k1", img, store_path=self.store)
        vibaseline.check("k2", half(64, 48, left=(240, 240, 240), right=(10, 10, 10)), store_path=self.store)
        r = vibaseline.check("k1", img, store_path=self.store)   # k1 没动
        self.assertFalse(r["changed"])
        self.assertEqual(r["distance"], 0)

    def test_坏图优雅降级不崩不污染(self):
        vibaseline.check("k", half(64, 48), store_path=self.store)   # 先有个好基线
        r = vibaseline.check("k", b"garbage-not-png", store_path=self.store)
        self.assertFalse(r["ok"])
        # 好基线没被坏图覆盖：再拿好图来还是能比
        good = vibaseline.check("k", half(64, 48), store_path=self.store)
        self.assertTrue(good["ok"])

    def test_纯色页标记weak(self):
        # dHash 全 0（无梯度）→ weak=True：两张全然不同的纯色页也会 distance 0，措辞得如实（红队 LOW-1）
        r1 = vibaseline.check("k", solid(40, 32, (255, 255, 255)), store_path=self.store)
        self.assertTrue(r1["weak"])
        r2 = vibaseline.check("k", solid(40, 32, (0, 0, 0)), store_path=self.store)   # 白→黑
        self.assertTrue(r2["weak"])
        self.assertFalse(r2["changed"])   # dHash 判不出（已知下限）——靠 weak 措辞兜住

    def test_有梯度页不weak(self):
        self.assertFalse(vibaseline.check("k", bands(64, 48), store_path=self.store)["weak"])

    def test_store有上限淘汰最旧(self):
        with mock.patch.object(vibaseline, "_MAX_KEYS", 3):
            for i in range(6):
                vibaseline.check(f"k{i}", half(32, 24), store_path=self.store)
            import json
            store = json.loads(self.store.read_text(encoding="utf-8"))
            self.assertLessEqual(len(store), 3)
            self.assertIn("k5", store)          # 最新的在
            self.assertNotIn("k0", store)       # 最旧的被淘汰


class render_check接线(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.root = Path(self._d.name)
        (self.root / "page.html").write_text("<h1>登录</h1>", encoding="utf-8")
        self.store = self.root / "baseline.json"
        self._vp = mock.patch.object(vision, "VISION_DIR", self.root / "v")
        self._rp = mock.patch.object(permission, "ROOT", self.root)
        self._vp.start()
        self._rp.start()
        self.addCleanup(self._vp.stop)
        self.addCleanup(self._rp.stop)
        self.addCleanup(self._d.cleanup)

    def _runner(self, png):
        def fake(argv):
            if "--dump-dom" in argv:
                return (0, "<html><body><h1>登录</h1></body></html>", "")
            for a in argv:
                if a.startswith("--screenshot="):
                    Path(a.split("=", 1)[1]).write_bytes(png)
            return (0, "", "")
        return fake

    def _ctx(self, png):
        return {"session_id": "s", "_render_runner": self._runner(png),
                "_render_browser": "fake-chrome", "_baseline_store": str(self.store)}

    def test_首次渲染报基线(self):
        res = tools_mod.execute("render_check", {"path": "page.html"}, self._ctx(raw_png(160, 100)))
        self.assertFalse(res.is_error)
        self.assertIn("视觉基线", res.content)
        self.assertIn("首次", res.content)

    def test_同图重渲染报一致(self):
        # 有结构页（bands 非单调 → dHash 非零、非 weak），同图重渲 → 「基本一致」
        png = bands(120, 80)
        tools_mod.execute("render_check", {"path": "page.html"}, self._ctx(png))
        res = tools_mod.execute("render_check", {"path": "page.html"}, self._ctx(png))
        self.assertIn("基本一致", res.content)

    def test_改动重渲染报变化(self):
        a = bands(120, 80, a=(240, 240, 240), b=(10, 10, 10))
        b = bands(120, 80, a=(10, 10, 10), b=(240, 240, 240))   # 明暗对调 → 沿位置变 → dHash 距离大
        tools_mod.execute("render_check", {"path": "page.html"}, self._ctx(a))
        res = tools_mod.execute("render_check", {"path": "page.html"}, self._ctx(b))
        self.assertIn("变化", res.content)

    def test_纯色页报均匀不误导(self):
        # 纯色截图 → weak 措辞，别对模型说「基本一致」（红队 LOW-1）
        png = solid(120, 80, (250, 250, 250))
        tools_mod.execute("render_check", {"path": "page.html"}, self._ctx(png))
        res = tools_mod.execute("render_check", {"path": "page.html"}, self._ctx(png))
        self.assertIn("均匀", res.content)
        self.assertNotIn("基本一致", res.content)

    def test_改动重渲染报变化区域定位(self):
        # §4.5.2 接线：变化行带出区域网格定位（行主序→第N行第M列），模型修稿直奔主题
        a = bands(120, 80, a=(240, 240, 240), b=(10, 10, 10))
        b = bands(120, 80, a=(10, 10, 10), b=(240, 240, 240))
        tools_mod.execute("render_check", {"path": "page.html"}, self._ctx(a))
        res = tools_mod.execute("render_check", {"path": "page.html"}, self._ctx(b))
        self.assertIn("变化区域", res.content)
        self.assertRegex(res.content, r"第\d+行第\d+列")

    def test_基线行附rn网格口径(self):
        # vibaseline.check 结果带 rn（消费方算行列用，防私有常量跨模块耦合）
        png = bands(64, 48)
        r = vibaseline.check("k", png, store_path=str(self.store))
        self.assertEqual(r["rn"], [4, 4])


if __name__ == "__main__":
    unittest.main(verbosity=2)
