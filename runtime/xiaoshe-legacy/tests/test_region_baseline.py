"""§4.5.2 区域化比对 + 迭代预算/退化回滚 + §4.6.3 三值判决。TDD 红→绿。

- imaging.region_hashes：整图切网格逐格 dHash（照稿写码「哪个区域变了」的像素腿，纯函数）。
- vibaseline 基线扩区域化：存储/比对逐区域哈希，变化定位到区域索引。
- vibaseline.compare_pngs：两张 PNG 的区域化比对（设计稿 vs 渲染图打分腿）。
- vibaseline.FitLoop：照稿写码迭代预算（≤2 轮修复）+ 退化回滚历史最优（纯状态机，YAGNI）。
- 三值判决：check 返回 verdict ∈ {PASS, FAIL, INCONCLUSIVE}——基线缺失/判不了 → INCONCLUSIVE，
  绝不硬 PASS/FAIL；FAIL 在变化探测器语境=「与基线不同」而非「页面错」。
断言绑特征不绑实现：只断距离量级/区域索引/类别归属，不断逐位哈希值。
运行：仓库根 `python -m unittest tests.test_region_baseline -v`
"""
import json
import tempfile
import unittest
from pathlib import Path

from harness import imaging, vibaseline


def quad(w=64, h=64, flip_br=False):
    """2×2 区域，每区左暗右亮竖条（区内有梯度 → dHash 非零可比对）；flip_br=True 时右下区梯度反转。"""
    dark, light = (10, 10, 10), (240, 240, 240)
    px = bytearray()
    for y in range(h):
        for x in range(w):
            lx = x % (w // 2)
            d = lx < w // 4
            if flip_br and x >= w // 2 and y >= h // 2:
                d = not d
            c = dark if d else light
            px += bytes([c[0], c[1], c[2], 255])
    return imaging.encode_png(w, h, bytes(px))


def solid(w=40, h=32, rgb=(200, 200, 200)):
    return imaging.encode_png(w, h, bytes([rgb[0], rgb[1], rgb[2], 255]) * (w * h))


class 区域哈希纯函数(unittest.TestCase):
    def test_数量与网格一致(self):
        hs = imaging.region_hashes(quad(), nx=2, ny=2)
        self.assertEqual(len(hs), 4)
        self.assertTrue(all(isinstance(x, int) for x in hs))

    def test_同图哈希一致(self):
        self.assertEqual(imaging.region_hashes(quad()), imaging.region_hashes(quad()))

    def test_改动只影响对应区域(self):
        a = imaging.region_hashes(quad(), nx=2, ny=2)
        b = imaging.region_hashes(quad(flip_br=True), nx=2, ny=2)
        diffs = [i for i in range(4) if a[i] != b[i]]
        self.assertEqual(diffs, [3], "只改右下区 → 仅索引 3 的哈希应变")

    def test_非法网格参数报错(self):
        for bad in ((0, 2), (2, 0), (-1, 3), (2.5, 2)):
            with self.assertRaises(ValueError):
                imaging.region_hashes(quad(), nx=bad[0], ny=bad[1])

    def test_坏图报错(self):
        with self.assertRaises(ValueError):
            imaging.region_hashes(b"not a png")


class 基线区域化(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.store = Path(self._d.name) / "baseline.json"
        self.addCleanup(self._d.cleanup)

    def test_基线存区域哈希(self):
        vibaseline.check("k", quad(), store_path=self.store)
        entry = json.loads(self.store.read_text(encoding="utf-8"))["k"]
        self.assertIn("regions", entry)
        self.assertEqual(len(entry["regions"]), 16)   # 默认 4×4

    def test_同图无区域变化(self):
        vibaseline.check("k", quad(), store_path=self.store)
        r = vibaseline.check("k", quad(), store_path=self.store)
        self.assertFalse(r["changed"])
        self.assertEqual(r.get("regions_changed"), [])

    def test_变化定位到区域(self):
        vibaseline.check("k", quad(), store_path=self.store, nx=2, ny=2)
        r = vibaseline.check("k", quad(flip_br=True), store_path=self.store, nx=2, ny=2)
        self.assertTrue(r["changed"])
        self.assertEqual(r.get("regions_changed"), [3], "变化应定位到右下区（行主序索引 3）")

    def test_旧格式基线无区域字段不崩(self):
        h = imaging.dhash(quad(), size=vibaseline._HASH_SIZE)
        self.store.write_text(json.dumps({"k": {"dhash": h, "size": vibaseline._HASH_SIZE}}), encoding="utf-8")
        r = vibaseline.check("k", quad(), store_path=self.store, nx=2, ny=2)
        self.assertTrue(r["ok"])
        self.assertEqual(r.get("regions_changed"), [])   # 旧基线没区域可比，如实给空
        # 基线顺势升级：再比一次就能定位区域了
        r2 = vibaseline.check("k", quad(flip_br=True), store_path=self.store, nx=2, ny=2)
        self.assertEqual(r2.get("regions_changed"), [3])

    def test_网格口径变了不错比(self):
        # 红队：基线存的是 4×4 区域哈希，这次按 2×2 比 → 异网格哈希不可比，须如实给空而非错位误报
        vibaseline.check("k", quad(), store_path=self.store)                 # 默认 4×4
        r = vibaseline.check("k", quad(flip_br=True), store_path=self.store, nx=2, ny=2)
        self.assertEqual(r.get("regions_changed"), [])


class 两图区域比对(unittest.TestCase):
    def test_一致距离0(self):
        r = vibaseline.compare_pngs(quad(), quad(), nx=2, ny=2)
        self.assertTrue(r["ok"])
        self.assertEqual(r["distance"], 0)
        self.assertEqual(r["regions_changed"], [])

    def test_改动定位且距离大于零(self):
        r = vibaseline.compare_pngs(quad(), quad(flip_br=True), nx=2, ny=2)
        self.assertTrue(r["ok"])
        self.assertGreater(r["distance"], 0)
        self.assertEqual(r["regions_changed"], [3])

    def test_坏图优雅降级(self):
        self.assertFalse(vibaseline.compare_pngs(b"junk", quad())["ok"])
        self.assertFalse(vibaseline.compare_pngs(quad(), b"junk")["ok"])


class 迭代预算与回滚(unittest.TestCase):
    def test_首轮继续(self):
        loop = vibaseline.FitLoop()
        d = loop.record(10)
        self.assertEqual(d["action"], "continue")
        self.assertEqual(d["round"], 0)

    def test_两轮预算耗尽强制停止(self):
        loop = vibaseline.FitLoop()
        loop.record(10)
        loop.record(8)
        d = loop.record(6)   # 持续改善，但第 2 轮修复用完 → 停
        self.assertEqual(d["action"], "stop")
        self.assertEqual(d["budget_left"], 0)

    def test_退化回滚历史最优(self):
        loop = vibaseline.FitLoop()
        loop.record(10)
        d = loop.record(12)   # 距离变大=退化 → 回滚到第 0 轮并停止
        self.assertEqual(d["action"], "rollback")
        self.assertEqual(d["best_round"], 0)

    def test_先好后退化回滚到最优轮(self):
        loop = vibaseline.FitLoop()
        loop.record(10)
        loop.record(8)
        d = loop.record(12)
        self.assertEqual(d["action"], "rollback")
        self.assertEqual(d["best_round"], 1)   # 历史最优是第 1 轮（距离 8）

    def test_持平不算退化(self):
        loop = vibaseline.FitLoop()
        loop.record(10)
        d = loop.record(10)
        self.assertEqual(d["action"], "continue")


class 三值判决(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.store = Path(self._d.name) / "baseline.json"
        self.addCleanup(self._d.cleanup)

    def test_判决集合恰好三值(self):
        self.assertEqual({vibaseline.PASS, vibaseline.FAIL, vibaseline.INCONCLUSIVE},
                         {"PASS", "FAIL", "INCONCLUSIVE"})

    def test_错误路径判INCONCLUSIVE(self):
        r = vibaseline.check("k", b"garbage", store_path=self.store)
        self.assertEqual(r["verdict"], "INCONCLUSIVE")

    def test_首次渲染基线缺失判INCONCLUSIVE(self):
        r = vibaseline.check("k", quad(), store_path=self.store)
        self.assertEqual(r["verdict"], "INCONCLUSIVE")
        self.assertNotEqual(r["verdict"], "PASS")   # 红队：INCONCLUSIVE 绝不可当 PASS 用

    def test_无梯度页判INCONCLUSIVE(self):
        vibaseline.check("k", solid(), store_path=self.store)
        r = vibaseline.check("k", solid(rgb=(30, 30, 30)), store_path=self.store)
        self.assertEqual(r["verdict"], "INCONCLUSIVE")

    def test_与基线一致判PASS(self):
        vibaseline.check("k", quad(), store_path=self.store)
        r = vibaseline.check("k", quad(), store_path=self.store)
        self.assertEqual(r["verdict"], "PASS")

    def test_与基线不同判FAIL(self):
        # 变化探测器语境：FAIL = 与基线不同（疑似回归信号），不等于「页面错」
        vibaseline.check("k", quad(), store_path=self.store)
        r = vibaseline.check("k", quad(flip_br=True), store_path=self.store)
        self.assertEqual(r["verdict"], "FAIL")


if __name__ == "__main__":
    unittest.main(verbosity=2)
