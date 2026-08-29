"""viewport.py · 视口坐标变换 + 会话内注册表（统一「裁剪-重问」子系统 P1 的心脏）。TDD 红→绿。

spec：docs/superpowers/specs/2026-07-19-统一裁剪重问子系统-design.md §核心不变式/§组件 1/§数据流。
不变式①：屏幕坐标 = origin + 图内坐标 / scale（「屏幕坐标」= 执行层坐标系：Mac 逻辑点 / Win 物理像素）。
坐标变换全纯函数、逐条 TDD；注册表会话内存、上限 8 LRU、不落盘。
运行：仓库根 `python -m unittest tests.test_viewport -v`
"""
import unittest

from harness import viewport


def _vp(vid="v1", origin=(0, 0), scale=1, size=(3120, 2080), marks=None, parent_id=None):
    return viewport.new_viewport(vid, origin=origin, scale=scale, size=size,
                                 marks=marks, parent_id=parent_id)


class 建视口(unittest.TestCase):
    def test_字段齐全_默认marks空表(self):
        vp = _vp()
        self.assertEqual(vp["id"], "v1")
        self.assertEqual(vp["origin"], (0, 0))
        self.assertEqual(vp["scale"], 1)
        self.assertEqual(vp["size"], (3120, 2080))
        self.assertEqual(vp["marks"], {})
        self.assertIsNone(vp["parent_id"])

    def test_marks带屏幕坐标与来源(self):
        marks = {3: {"no": 3, "label": "5", "screen_cx": 828, "screen_cy": 1358, "source": "ocr"}}
        vp = _vp(marks=marks)
        self.assertEqual(vp["marks"][3]["screen_cx"], 828)
        self.assertEqual(vp["marks"][3]["source"], "ocr")

    def test_非法scale或尺寸_ValueError(self):
        with self.assertRaises(ValueError):
            _vp(scale=0)
        with self.assertRaises(ValueError):
            _vp(scale=-1)
        with self.assertRaises(ValueError):
            _vp(size=(0, 100))

    def test_NaN或无穷scale_ValueError(self):
        # NaN：nan <= 0 为 False 会漏过校验，to_screen 到点击时才炸；
        # inf：x/inf=0，一切点击静默落回 origin——必须在建视口时拦
        for bad in (float("nan"), float("inf")):
            with self.assertRaises(ValueError, msg=f"scale={bad!r} 应报 ValueError"):
                _vp(scale=bad)

    def test_NaN或无穷尺寸_ValueError(self):
        for bad in ((float("nan"), 100), (float("inf"), 100), (100, float("nan"))):
            with self.assertRaises(ValueError, msg=f"size={bad!r} 应报 ValueError"):
                _vp(size=bad)

    def test_非法mark来源_ValueError(self):
        bad = {1: {"no": 1, "label": "x", "screen_cx": 0, "screen_cy": 0, "source": "gnss"}}
        with self.assertRaises(ValueError):
            _vp(marks=bad)


class 回屏变换(unittest.TestCase):
    """to_screen：屏幕坐标 = origin + 图内坐标 / scale（不变式①）。"""

    def test_根视口scale1_原样返回(self):
        vp = _vp(origin=(0, 0), scale=1)
        self.assertEqual(viewport.to_screen(vp, 100, 200), (100, 200))

    def test_根视口带origin(self):
        vp = _vp(origin=(620, 1100), scale=1)
        self.assertEqual(viewport.to_screen(vp, 208, 258), (828, 1358))

    def test_Retina根视口scale2_除法(self):
        # Mac Retina：截图=物理像素、执行层=逻辑点，根视口 scale=2 → 图内坐标除 2
        vp = _vp(origin=(0, 0), scale=2)
        self.assertEqual(viewport.to_screen(vp, 100, 200), (50, 100))

    def test_分数scale_Windows百分之150DPI(self):
        # Win 150% DPI：scale=1.5 也要除对（浮点 scale 不假设为整数）
        vp = _vp(origin=(0, 0), scale=1.5)
        self.assertEqual(viewport.to_screen(vp, 9, 3), (6, 2))

    def test_子视口scale4_父2乘k2(self):
        # Retina 根(scale=2) 上 zoom k=2 → 子视口 scale=4
        vp = _vp(origin=(10, 20), scale=4)
        self.assertEqual(viewport.to_screen(vp, 8, 4), (12, 21))

    def test_返回整数_四舍五入(self):
        vp = _vp(origin=(0, 0), scale=2)
        sx, sy = viewport.to_screen(vp, 7, 9)   # 3.5, 4.5 → round → int
        self.assertIsInstance(sx, int)
        self.assertIsInstance(sy, int)
        self.assertEqual((sx, sy), (round(3.5), round(4.5)))


class 裁子视口(unittest.TestCase):
    def test_origin与scale递推(self):
        # spec §数据流实例：v1 origin=(0,0) scale=1，zoom region=(620,1100,800,600) k=2
        v1 = _vp(origin=(0, 0), scale=1, size=(3120, 2080))
        p = viewport.crop_viewport(v1, (620, 1100, 800, 600), k=2)
        self.assertEqual(p["origin"], (620, 1100))
        self.assertEqual(p["scale"], 2)
        self.assertEqual(p["size"], (1600, 1200))   # 裁剪 800×600 放大 2×
        self.assertEqual(p["parent_id"], "v1")
        self.assertEqual(p["marks"], {})            # 子视口重新打框，编号不继承

    def test_再钻一层_scale连乘(self):
        v1 = _vp(origin=(0, 0), scale=1, size=(3120, 2080))
        p2 = viewport.crop_viewport(v1, (620, 1100, 800, 600), k=2)
        v2 = _vp("v2", origin=p2["origin"], scale=p2["scale"], size=p2["size"], parent_id="v1")
        p3 = viewport.crop_viewport(v2, (100, 100, 400, 300), k=2)
        self.assertEqual(p3["origin"], (670, 1150))  # 620+100/2, 1100+100/2
        self.assertEqual(p3["scale"], 4)
        self.assertEqual(p3["size"], (800, 600))
        self.assertEqual(p3["parent_id"], "v2")

    def test_Retina根上zoom_scale2乘k(self):
        v1 = _vp(origin=(0, 0), scale=2, size=(3120, 2080))
        p = viewport.crop_viewport(v1, (200, 100, 400, 200), k=2)
        self.assertEqual(p["origin"], (100, 50))     # 图内 200,100 ÷ scale 2
        self.assertEqual(p["scale"], 4)

    def test_region越界_clamp到父视口内(self):
        v1 = _vp(origin=(0, 0), scale=1, size=(1000, 800))
        p = viewport.crop_viewport(v1, (900, 700, 500, 500), k=2)
        # clamp 后区域 (900,700,100,100)
        self.assertEqual(p["origin"], (900, 700))
        self.assertEqual(p["size"], (200, 200))

    def test_region负起点_clamp到父视口内(self):
        v1 = _vp(origin=(0, 0), scale=1, size=(1000, 800))
        p = viewport.crop_viewport(v1, (-50, -50, 200, 200), k=2)
        self.assertEqual(p["origin"], (0, 0))
        self.assertEqual(p["size"], (300, 300))      # clamp 后 150×150 ×2

    def test_完全越界_ValueError(self):
        v1 = _vp(origin=(0, 0), scale=1, size=(1000, 800))
        for bad in ((2000, 0, 100, 100), (0, 900, 100, 100), (-300, -300, 100, 100)):
            with self.assertRaises(ValueError, msg=f"region={bad} 应报 ValueError"):
                viewport.crop_viewport(v1, bad, k=2)

    def test_非法放大倍数_ValueError(self):
        v1 = _vp()
        with self.assertRaises(ValueError):
            viewport.crop_viewport(v1, (0, 0, 100, 100), k=4)


class 往返恒等(unittest.TestCase):
    """spec §数据流金实例：screen→crop→to_screen 回到原屏幕坐标，逐数断言。"""

    def test_spec实例_828_1358_精确成立(self):
        # 整屏 3120×2080 根视口 v1；zoom region=(620,1100,800,600) k=2 → v2
        v1 = _vp("v1", origin=(0, 0), scale=1, size=(3120, 2080))
        p2 = viewport.crop_viewport(v1, (620, 1100, 800, 600), k=2)
        v2 = _vp("v2", origin=p2["origin"], scale=p2["scale"], size=p2["size"], parent_id="v1")
        # v2 图内 (416,516) → 屏幕 (620+416/2, 1100+516/2) = (828,1358)
        self.assertEqual(viewport.to_screen(v2, 416, 516), (828, 1358))
        # 同一屏幕点走根视口换算回来也一致（两路对得上——UIA 实测「五」键中心恰为 (828,1358)）
        self.assertEqual(viewport.to_screen(v1, 828, 1358), (828, 1358))

    def test_往返_图内经子视口回屏_与直达一致(self):
        # 任意点：父图内 (px,py) ⊂ region → 子图内 ((px-rx)*k, (py-ry)*k) → to_screen 应回到父的换算值
        v1 = _vp("v1", origin=(100, 200), scale=2, size=(3000, 2000))
        region = (400, 600, 800, 400)
        p2 = viewport.crop_viewport(v1, region, k=2)
        v2 = _vp("v2", origin=p2["origin"], scale=p2["scale"], size=p2["size"], parent_id="v1")
        px, py = 700, 750                                   # 父图内一点（region 内）
        cx, cy = (px - region[0]) * 2, (py - region[1]) * 2  # 对应子图内坐标
        self.assertEqual(viewport.to_screen(v2, cx, cy), viewport.to_screen(v1, px, py))


class 注册表(unittest.TestCase):
    def setUp(self):
        viewport._REGISTRY.clear()
        self.addCleanup(viewport._REGISTRY.clear)

    def test_注册后可取回(self):
        viewport.register(_vp("a"))
        got = viewport.get("a")
        self.assertIsNotNone(got)
        self.assertEqual(got["id"], "a")

    def test_get不存在_返回None(self):
        # 上层据此报「视口已过期，重新 look」
        self.assertIsNone(viewport.get("不存在"))

    def test_同id覆盖_不占两个坑(self):
        viewport.register(_vp("a"))
        viewport.register(_vp("a", origin=(1, 1)))
        self.assertEqual(len(viewport._REGISTRY), 1)
        self.assertEqual(viewport.get("a")["origin"], (1, 1))

    def test_第9个淘汰最久未访问(self):
        for i in range(1, 9):
            viewport.register(_vp(f"v{i}"))
        viewport.register(_vp("v9"))                 # 第 9 个 → 挤掉最旧的 v1
        self.assertIsNone(viewport.get("v1"))
        self.assertIsNotNone(viewport.get("v9"))
        self.assertEqual(len(viewport._REGISTRY), 8)

    def test_get刷新热度_淘汰顺延(self):
        for i in range(1, 9):
            viewport.register(_vp(f"v{i}"))
        viewport.get("v1")                           # v1 被访问 → 不再是「最久未访问」
        viewport.register(_vp("v9"))
        self.assertIsNotNone(viewport.get("v1"))     # v1 保住了
        self.assertIsNone(viewport.get("v2"))        # v2 成了最旧、被淘汰


class 视口id分配(unittest.TestCase):
    def test_淘汰id不复用_会话内单调(self):
        # 红队真跑复现：LRU 淘汰后 next_id 从 v1 扫空位会复用已淘汰 id——模型上下文里还留着
        # 旧 v1 的编号图，复用后「zoom v1」张冠李戴点错视口（心脏病）。id 须会话内单调不回收。
        reg = viewport.new_registry()
        ids = []
        for _ in range(10):
            vid = viewport.next_id(reg)
            viewport.register(_vp(vid), reg)
            ids.append(vid)
        self.assertEqual(len(set(ids)), 10)          # 10 次分配全不同
        self.assertNotIn("v1", reg)                  # v1 早被 LRU 淘汰
        self.assertEqual(ids[0], "v1")
        self.assertEqual(ids[-1], "v10")             # 单调递增，不回收空位

    def test_显式注册高号id_后续分配避让(self):
        reg = viewport.new_registry()
        viewport.register(_vp("v5"), reg)
        vid = viewport.next_id(reg)                  # 计数器从 1 起，撞 v5 要避让
        self.assertNotEqual(vid, "v5")
        viewport.register(_vp(vid), reg)
        for _ in range(4):                           # 一路分配到撞上 v5 的那次也必须跳过
            vid = viewport.next_id(reg)
            viewport.register(_vp(vid), reg)
        self.assertEqual(len(set(reg.keys())), 6)



if __name__ == "__main__":
    unittest.main()
