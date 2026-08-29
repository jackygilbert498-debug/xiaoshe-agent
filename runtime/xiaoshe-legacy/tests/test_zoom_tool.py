"""统一「裁剪-重问」子系统 P3 · zoom 工具：建子视口 + 迭代收窄。TDD 红→绿。

spec：docs/superpowers/specs/2026-07-19-统一裁剪重问子系统-design.md §组件3 zoom 行 / §错误处理 / §数据流。
- 子视口 = crop_viewport(父, region, k)：origin 递推 + clamp 到父视口内（P1 已验）。
- **重新截屏**该区域（所见即当下：父图可能已被 downscale/画面已变；region 截屏 Mac/Win 都支持），
  新截 region → upscale k 倍（整数最近邻）当子视口的图。
- 重新截屏的像素密度 = 设备固定倍率（Mac Retina 2× / Win 1×），**不是**父视口 scale——
  故子视口 scale 实测（放大后图像素 ÷ 区域屏幕尺寸，同 P2 根视口「实测不假设」）：
  第一层 zoom 与递推一致；嵌套 zoom（zoom 的 zoom）若沿用递推 scale 会虚高（Mac 第二层起差 2 倍）。
- 框源重建：对放大后小图重新 OCR（治整屏漏孤立数字的病根）+ 新 capture_ax 过滤相交元素换算进子图
  → merge_marks 合并去重（同 look 规则）→ draw_marks 重编号。
全部注入 runner 离线；真机冒烟一条 skipUnless(darwin)。
运行：仓库根 `python -m unittest tests.test_zoom_tool -v`
"""
import base64
import re as _re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import imaging, observe, permission, viewport
from harness import tools as tools_mod
from harness import vision

_DUMP_FAR = """APP: TestApp
WIN: 演示窗口
AXButton | 远角 | pos=10,10 | size=20x10"""

_DUMP_TARGET = """APP: TestApp
WIN: 演示窗口
AXButton | 目标 | pos=100,100 | size=40x20"""

_PNG_PATH = _re.compile(r"[^'\"\s]+\.png")


def _region_of_argv(argv):
    """从截图 argv 解出请求区域 (x,y,w,h)，两形态都认（假 runner 平台无关的关键）：
    Mac = screencapture 的独立元素 `-R x,y,w,h`；Win = PS 脚本内嵌
    `CopyFromScreen(x,y,0,0,$b.Size)` + `[Drawing.Bitmap]::new(w,h)`。整屏（无区域）→ None。
    （照 test_observe_tool「.png 承载路径两形态」先例：同一语义断言点，按平台载体各解各的。）"""
    if "-R" in argv:
        return tuple(int(v) for v in argv[argv.index("-R") + 1].split(","))
    script = argv[-1] if argv else ""
    mxy = _re.search(r"CopyFromScreen\((-?\d+),(-?\d+),0,0,\$b\.Size\)", script)
    mwh = _re.search(r"Bitmap\]::new\((\d+),(\d+)\)", script)
    if mxy and mwh:
        x, y, w, h = int(mxy.group(1)), int(mxy.group(2)), int(mwh.group(1)), int(mwh.group(2))
        return (x, y, w, h) if w > 0 and h > 0 else None   # w=h=0 = 脚本内取整屏
    return None


def fake_png(w, h, rgb=(32, 48, 64)):
    """imaging.encode_png 造假截图（纯色），IHDR 尺寸 = 截图像素尺寸。"""
    return imaging.encode_png(w, h, (bytes(rgb) + b"\xff") * (w * h))


def _word(text, x, y, w, h):
    return "WORD|" + base64.b64encode(text.encode("utf-8")).decode("ascii") + f"|{x}|{y}|{w}|{h}"


def _ok(text):
    return "OK|" + base64.b64encode(text.encode("utf-8")).decode("ascii")


def _ocr_out(text, x, y, w, h):
    return _word(text, x, y, w, h) + "\n" + _ok(text)


def seq_runner(items):
    """依次弹出喂多次调用；只剩最后一个就一直用它（look/zoom/再 zoom 按序喂）。"""
    q = list(items)
    return lambda *a: q.pop(0) if len(q) > 1 else q[0]


def echo_shot_runner(root_png, record=None):
    """假截屏：argv 带区域（Mac -R / Win PS 脚本，两形态都认）→ 回该区域尺寸的假图
    （region 截屏 Mac/Win 都已支持）；否则回整屏 root_png。record 传入 list 可录下每次 argv。"""
    def fake(argv):
        if record is not None:
            record.append(list(argv))
        png = root_png
        region = _region_of_argv(argv)
        if region:
            png = fake_png(region[2], region[3])
        for a in argv:
            m = _PNG_PATH.search(a)
            if m:
                Path(m.group(0)).write_bytes(png)
                break
        return (0, "", "")
    return fake


def retina_shot_runner(root_png):
    """假 Retina 截屏：区域按设备 2× 密度回图（截图像素 = 请求点数 ×2，Mac Retina 真机行为）。"""
    def fake(argv):
        png = root_png
        region = _region_of_argv(argv)
        if region:
            png = fake_png(region[2] * 2, region[3] * 2)
        for a in argv:
            m = _PNG_PATH.search(a)
            if m:
                Path(m.group(0)).write_bytes(png)
                break
        return (0, "", "")
    return fake


def make_ctx(root=(800, 600), dumps=("",), ocrs=(_ok(""),), record=None):
    """Windows 风格 scale=1 场景（截图像素 = 屏幕逻辑尺寸）。dumps/ocrs 按调用序喂（look 先、zoom 后）。"""
    return {"session_id": "s",
            "_ax_runner": seq_runner(dumps),
            "_screencapture_runner": echo_shot_runner(fake_png(*root), record=record),
            "_screen_size_runner": lambda argv: (0, f"{root[0]},{root[1]}\n", ""),
            "_ocr_runner": seq_runner([(0, o, "") for o in ocrs]),
            "_sips_runner": lambda argv: (1, "", "no sips"),   # 压图失败 → 优雅回落原图
            # zoom 重 OCR 词数 <8 会触发 VLM 直读兜底闸（排序2）——不注入就会真发 API 调用
            # （无代理环境每次 curl 超时 ~6s×2，是慢测试头号来源）。本文件不断言兜底文本，
            # 照 test_zoom_vlm_read 先例注入假 fn 离线跑，UNREADABLE → 判「未确认」不采用。
            "_vlm_read_fn": lambda png: "UNREADABLE"}


def do_look(ctx):
    with mock.patch.object(imaging, "draw_marks", lambda p, m, **k: p):
        return tools_mod.execute("look", {}, ctx)


def do_zoom(ctx, args):
    with mock.patch.object(imaging, "draw_marks", lambda p, m, **k: p):
        return tools_mod.execute("zoom", args, ctx)


class 参数与视口校验(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self._p = mock.patch.object(vision, "VISION_DIR", Path(self._d.name))
        self._p.start()
        viewport._REGISTRY.clear()

    def tearDown(self):
        self._p.stop()
        self._d.cleanup()
        viewport._REGISTRY.clear()

    def test_视口不存在_报视口已过期引导重新look(self):
        ctx = make_ctx()
        res = do_zoom(ctx, {"viewport_id": "v9", "region": [0, 0, 100, 100]})
        self.assertIn("视口已过期", res.content)          # spec §错误处理原话
        self.assertIn("重新 look", res.content)
        self.assertEqual(len(ctx.get("_viewport_registry", {})), 0)

    def test_视口被LRU淘汰_同样报已过期(self):
        ctx = make_ctx(dumps=(_DUMP_FAR,))
        for _ in range(9):                               # 注册表上限 8：第 9 次 look 把 v1 挤掉
            do_look(ctx)
        self.assertEqual(len(ctx["_viewport_registry"]), 8)
        res = do_zoom(ctx, {"viewport_id": "v1", "region": [0, 0, 100, 100]})
        self.assertIn("视口已过期", res.content)
        self.assertIn("重新 look", res.content)

    def test_缺viewport_id_报错(self):
        res = tools_mod.execute("zoom", {"region": [0, 0, 10, 10]}, make_ctx())
        self.assertTrue(res.is_error)
        self.assertIn("viewport_id", res.content)

    def test_mark_no与region二选一_缺一或都给都报错(self):
        ctx = make_ctx(dumps=(_DUMP_FAR,))
        do_look(ctx)
        both = tools_mod.execute("zoom", {"viewport_id": "v1", "mark_no": 1, "region": [0, 0, 10, 10]}, ctx)
        self.assertTrue(both.is_error)
        self.assertIn("二选一", both.content)
        neither = tools_mod.execute("zoom", {"viewport_id": "v1"}, ctx)
        self.assertTrue(neither.is_error)

    def test_region形态非法_报错(self):
        ctx = make_ctx(dumps=(_DUMP_FAR,))
        do_look(ctx)
        for bad in ([1, 2, 3], "0,0,10,10", [0, 0, "x", 10]):
            res = tools_mod.execute("zoom", {"viewport_id": "v1", "region": bad}, ctx)
            self.assertTrue(res.is_error, f"region={bad!r} 应报错")
        self.assertEqual(len(ctx["_viewport_registry"]), 1)   # 不产幽灵视口

    def test_mark_no无效_报错列出有效编号(self):
        dump = "APP: T\nWIN: W\nAXButton | a | pos=10,10 | size=20x10\nAXButton | b | pos=200,10 | size=20x10"
        ctx = make_ctx(dumps=(dump,))
        do_look(ctx)
        res = do_zoom(ctx, {"viewport_id": "v1", "mark_no": 99})
        self.assertIn("99", res.content)
        self.assertIn("1~2", res.content)                     # 列出有效编号范围
        res0 = do_zoom(ctx, {"viewport_id": "v1", "mark_no": 0})
        self.assertIn("1~2", res0.content)
        self.assertEqual(len(ctx["_viewport_registry"]), 1)   # 不产子视口

    def test_k非法_报错(self):
        ctx = make_ctx(dumps=(_DUMP_FAR,))
        do_look(ctx)
        for bad in (1, 4, 2.5):
            res = tools_mod.execute("zoom", {"viewport_id": "v1", "region": [0, 0, 10, 10], "k": bad}, ctx)
            self.assertTrue(res.is_error, f"k={bad!r} 应报错")
            self.assertIn("2/3", res.content)

    def test_region元素必须严格整数_浮点数字符串布尔都报错(self):
        """红队 2026-07-22 真跑：int() 静默截断浮点（100.9→100）、收数字字符串、把 True 当 1——
        契约写「region 必须是整数」，宽松入口让模型的错参静默跑偏，一律拒并报清楚。"""
        ctx = make_ctx(dumps=(_DUMP_FAR,))
        do_look(ctx)
        for bad in ([0, 0, 100.9, 100], [0, 0, "100", 100], [0, 0, True, 100]):
            res = tools_mod.execute("zoom", {"viewport_id": "v1", "region": bad}, ctx)
            self.assertTrue(res.is_error, f"region={bad!r} 应报错")
            self.assertIn("整数", res.content)
        self.assertEqual(len(ctx["_viewport_registry"]), 1)   # 不产幽灵视口

    def test_mark_no布尔或浮点_报错(self):
        """int(True)=1 会把 mark_no=true 静默当 1 号标记——布尔/浮点一律拒。"""
        ctx = make_ctx(dumps=(_DUMP_FAR,))
        do_look(ctx)
        for bad in (True, 1.0, 1.5):
            res = tools_mod.execute("zoom", {"viewport_id": "v1", "mark_no": bad}, ctx)
            self.assertTrue(res.is_error, f"mark_no={bad!r} 应报错")
            self.assertIn("整数", res.content)
        self.assertEqual(len(ctx["_viewport_registry"]), 1)


class 裁剪与放大(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self._p = mock.patch.object(vision, "VISION_DIR", Path(self._d.name))
        self._p.start()
        viewport._REGISTRY.clear()

    def tearDown(self):
        self._p.stop()
        self._d.cleanup()
        viewport._REGISTRY.clear()

    def test_mark_no路径_外扩1点5倍居中_逆变换回父图坐标(self):
        """mark 屏幕框 (100,50,20,10) 中心 (110,55)：外扩 1.5 倍 → (30,15) 居中 → 屏幕区域 (95,47.5,30,15)；
        scale=1 逆变换回父图 = (95,48,30,15)（round 半到偶）；子视口 origin/scale/size 由 crop_viewport 递推。"""
        dump = "APP: T\nWIN: W\nAXButton | 关闭 | pos=100,50 | size=20x10"
        record = []
        ctx = make_ctx(dumps=(dump, dump), ocrs=(_ok(""), _ocr_out("词", 4, 4, 20, 10)), record=record)
        do_look(ctx)
        res = do_zoom(ctx, {"viewport_id": "v1", "mark_no": 1})
        self.assertFalse(res.is_error)
        zoom_argv = [a for a in record if _region_of_argv(a)]
        self.assertEqual(len(zoom_argv), 1)
        self.assertEqual(_region_of_argv(zoom_argv[0]), (95, 48, 30, 15))   # 重新截屏的区域 = 外扩后屏幕区域
        reg = ctx["_viewport_registry"]
        self.assertEqual(len(reg), 2)
        v2 = reg["v2"]
        self.assertEqual(v2["parent_id"], "v1")
        self.assertEqual(v2["origin"], (95, 48))
        self.assertEqual(v2["size"], (60, 30))                # clamp 后 (30,15) × k=2
        self.assertEqual(v2["scale"], 2.0)
        self.assertIn("v2", res.content)
        self.assertEqual(ctx["_vision_pending"], ["img-1", "img-2"])

    def test_mark_no外扩出界_clamp到父视口内(self):
        """mark 屏幕框 (0,0,20,10) 中心 (10,5)：外扩 (30,15) → 区域 (-5,-2.5,30,15) 出界 → clamp 到 (0,0,25,13)。"""
        dump = "APP: T\nWIN: W\nAXButton | 角 | pos=0,0 | size=20x10"
        record = []
        ctx = make_ctx(dumps=(dump, dump), ocrs=(_ok(""), _ocr_out("词", 2, 2, 10, 8)), record=record)
        do_look(ctx)
        res = do_zoom(ctx, {"viewport_id": "v1", "mark_no": 1})
        self.assertFalse(res.is_error)
        zoom_argv = [a for a in record if _region_of_argv(a)][0]
        self.assertEqual(_region_of_argv(zoom_argv), (0, 0, 25, 13))        # clamp 后的屏幕区域
        v2 = ctx["_viewport_registry"]["v2"]
        self.assertEqual(v2["origin"], (0, 0))
        self.assertEqual(v2["size"], (50, 26))                # (25,13) × 2
        self.assertEqual(v2["scale"], 2.0)

    def test_region越界_clamp到父视口内(self):
        record = []
        ctx = make_ctx(dumps=("",), ocrs=(_ok(""), _ocr_out("词", 4, 4, 20, 10)), record=record)
        # look 两路会全空？不会——look 的 OCR 也空、AX 也空就不产视口。给 look 一个 OCR 词。
        ctx = make_ctx(dumps=(_DUMP_FAR,), ocrs=(_ok(""), _ocr_out("词", 4, 4, 20, 10)), record=record)
        do_look(ctx)
        res = do_zoom(ctx, {"viewport_id": "v1", "region": [700, 500, 200, 200]})
        self.assertFalse(res.is_error)
        zoom_argv = [a for a in record if _region_of_argv(a)][0]
        self.assertEqual(_region_of_argv(zoom_argv), (700, 500, 100, 100))   # 800x600 视口内 clamp
        v2 = ctx["_viewport_registry"]["v2"]
        self.assertEqual(v2["origin"], (700, 500))
        self.assertEqual(v2["size"], (200, 200))
        self.assertEqual(v2["scale"], 2.0)

    def test_region完全不相交_报错不产视口(self):
        ctx = make_ctx(dumps=(_DUMP_FAR,))
        do_look(ctx)
        res = tools_mod.execute("zoom", {"viewport_id": "v1", "region": [900, 0, 50, 50]}, ctx)
        self.assertTrue(res.is_error)
        self.assertIn("不相交", res.content)
        self.assertEqual(len(ctx["_viewport_registry"]), 1)

    def test_放大超50M闸_拒绝并建议缩小region或降k(self):
        """4000x3200 区域 ×2 = 6400x8000 超 50M 像素闸（imaging.upscale 抛 ValueError）→ 兜住转错误文案。"""
        ctx = make_ctx(root=(4100, 3300), dumps=(_DUMP_FAR,))
        do_look(ctx)
        res = do_zoom(ctx, {"viewport_id": "v1", "region": [0, 0, 4000, 3200], "k": 2})
        self.assertIn("像素", res.content)
        self.assertIn("缩小", res.content)                    # 建议缩小 region
        self.assertIn("k", res.content)                       # 或降 k
        self.assertEqual(len(ctx["_viewport_registry"]), 1)   # 不产幽灵子视口

    def test_截屏失败_错误态不产幽灵视口(self):
        ctx = make_ctx(dumps=(_DUMP_FAR,))
        do_look(ctx)
        ctx["_screencapture_runner"] = lambda argv: (1, "", "could not create image from display")
        res = do_zoom(ctx, {"viewport_id": "v1", "region": [0, 0, 100, 100]})
        self.assertIn("截图失败", res.content)
        self.assertEqual(len(ctx["_viewport_registry"]), 1)   # 父视口还在、不产子视口

    def test_区域截屏字节非有效PNG_错误态不产幽灵视口(self):
        """红队 2026-07-22 补钉：CONTRACT 声称「非有效 PNG → 错误态」有测试，实际只钉了截屏失败——补真。"""
        def garbage_shot(argv):
            for a in argv:
                m = _PNG_PATH.search(a)
                if m:
                    Path(m.group(0)).write_bytes(b"not a png at all")
                    break
            return (0, "", "")
        ctx = make_ctx(dumps=(_DUMP_FAR,))
        do_look(ctx)
        ctx["_screencapture_runner"] = garbage_shot
        res = do_zoom(ctx, {"viewport_id": "v1", "region": [0, 0, 100, 100]})
        self.assertIn("有效 PNG", res.content)
        self.assertEqual(len(ctx["_viewport_registry"]), 1)   # 不产幽灵视口

    def test_放大超50M闸_decode前先拒_不先做大分配(self):
        """红队 2026-07-22 真跑：超闸请求在 decode 阶段先峰值分配 ~157MB 才被 upscale 闸拦——
        IHDR 读尺寸就够判，闸前置：decode_png 根本不该被调到。"""
        ctx = make_ctx(root=(4100, 3300), dumps=(_DUMP_FAR,))
        do_look(ctx)
        with mock.patch.object(imaging, "decode_png",
                               side_effect=AssertionError("超闸请求不应触发 decode 大分配")) as dec:
            res = do_zoom(ctx, {"viewport_id": "v1", "region": [0, 0, 4000, 3200], "k": 2})
        self.assertEqual(dec.call_count, 0)
        self.assertIn("放大被拒", res.content)
        self.assertIn("缩小", res.content)
        self.assertEqual(len(ctx["_viewport_registry"]), 1)   # 不产幽灵子视口


class 框源重建与编号(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self._p = mock.patch.object(vision, "VISION_DIR", Path(self._d.name))
        self._p.start()
        viewport._REGISTRY.clear()

    def tearDown(self):
        self._p.stop()
        self._d.cleanup()
        viewport._REGISTRY.clear()

    def test_OCR空只AX框源_如实说明(self):
        dump = "APP: T\nWIN: W\nAXButton | 钮 | pos=100,100 | size=40x20"
        ctx = make_ctx(dumps=(dump, dump), ocrs=(_ok(""), _ok("")))
        do_look(ctx)
        res = do_zoom(ctx, {"viewport_id": "v1", "region": [50, 50, 200, 200]})
        self.assertFalse(res.is_error)
        v2 = ctx["_viewport_registry"]["v2"]
        self.assertTrue(v2["marks"])
        self.assertTrue(all(m["source"] == "uia" for m in v2["marks"].values()))
        self.assertIn("OCR", res.content)                     # 如实说明 OCR 没认出词框

    def test_AX空只OCR框源(self):
        ctx = make_ctx(dumps=(_DUMP_FAR, ""), ocrs=(_ok(""), _ocr_out("孤立数字5", 40, 20, 20, 10)))
        do_look(ctx)
        res = do_zoom(ctx, {"viewport_id": "v1", "region": [0, 0, 200, 200]})
        self.assertFalse(res.is_error)
        v2 = ctx["_viewport_registry"]["v2"]
        self.assertEqual(len(v2["marks"]), 1)
        self.assertEqual(v2["marks"][1]["source"], "ocr")
        self.assertEqual(v2["marks"][1]["label"], "孤立数字5")

    def test_两路全空_引导observe_不产子视口但附放大图(self):
        ctx = make_ctx(dumps=(_DUMP_FAR, ""), ocrs=(_ok(""), _ok("")))
        do_look(ctx)
        res = do_zoom(ctx, {"viewport_id": "v1", "region": [0, 0, 200, 200]})
        self.assertIn("observe", res.content)                 # spec §错误处理：两路全空引导换 observe
        self.assertEqual(len(ctx["_viewport_registry"]), 1)   # 不产子视口
        self.assertEqual(ctx["_vision_pending"], ["img-1", "img-2"])   # 放大图仍附上给模型亲眼看

    def test_AX过滤_只留与子视口区域相交的元素并换算进子图(self):
        """区域内元素 (700,1200,40,20) → 子图 ((700-620)*2,(1200-1100)*2,80,40)；区外元素不进。"""
        dump1 = _DUMP_FAR
        dump2 = ("APP: T\nWIN: W\n"
                 "AXButton | 五 | pos=700,1200 | size=40x20\n"
                 "AXButton | 区外 | pos=0,0 | size=50x50")
        # root 只需容得下 region (620,1100,800,600) 不触发 clamp（1420x1700 即可，留几 px 余量）——
        # 几何断言全是相对 region 的数值，与 root 绝对尺寸无关；3120x2080 白烧 6.5M px 像素腿。
        ctx = make_ctx(root=(1424, 1704), dumps=(dump1, dump2), ocrs=(_ok(""), _ok("")))
        do_look(ctx)
        res = do_zoom(ctx, {"viewport_id": "v1", "region": [620, 1100, 800, 600]})
        self.assertFalse(res.is_error)
        v2 = ctx["_viewport_registry"]["v2"]
        self.assertEqual(len(v2["marks"]), 1)                 # 区外元素被过滤
        m = v2["marks"][1]
        self.assertEqual(m["label"], "五")
        # 子图内框 (160,200,80,40) 中心 (200,220) → 屏幕 (620+100, 1100+110)
        self.assertEqual((m["screen_cx"], m["screen_cy"]), (720, 1210))
        self.assertEqual((m["screen_w"], m["screen_h"]), (40, 20))

    def test_编号上限40_截断并提示(self):
        lines = ["APP: T", "WIN: W"] + [f"AXButton | b{i} | pos=100,100 | size=40x20" for i in range(50)]
        dump = "\n".join(lines)
        ctx = make_ctx(dumps=(_DUMP_FAR, dump), ocrs=(_ok(""), _ok("")))
        do_look(ctx)
        res = do_zoom(ctx, {"viewport_id": "v1", "region": [50, 50, 200, 200]})
        v2 = ctx["_viewport_registry"]["v2"]
        self.assertEqual(len(v2["marks"]), tools_mod._SOM_MAX_MARKS)
        self.assertIn(str(tools_mod._SOM_MAX_MARKS), res.content)


class 实测scale反向校验(unittest.TestCase):
    """红队 2026-07-22 真跑复现：「origin 递推 + scale 实测」混搭的静默破口——
    实测 scale 应恒 ≈ 根视口 scale × k（重新截屏密度=设备固定倍率，根 scale 即其测量值），
    背离只可能是父链 scale 测错（look 回退 1.0）或截屏被系统裁切 → 不变式①破 → 必须如实警示。"""

    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self._p = mock.patch.object(vision, "VISION_DIR", Path(self._d.name))
        self._p.start()
        viewport._REGISTRY.clear()

    def tearDown(self):
        self._p.stop()
        self._d.cleanup()
        viewport._REGISTRY.clear()

    def test_Retina加look的scale回退_实测与根scale乘k背离_如实警示(self):
        """Retina 2× 机（截图像素=点数×2）+ screen_logical_size 失败回退 scale=1.0：
        zoom 的 origin 递推/截屏请求按错的父 scale 换算，实测 scale=4 与根 scale×k=2 背离 2 倍——
        红队真跑：声明屏幕坐标偏出真实屏 (3000,1786) vs (2560,1440)。必须警示。"""
        ctx = {"session_id": "s",
               "_ax_runner": seq_runner((_DUMP_TARGET, _DUMP_TARGET)),
               # 根图尺寸不影响断言：look 的 scale 是回退 1.0（screen_logical_size 失败），
               # v2 scale 实测 = 重截密度 2×k = 4 只取决于 region 与 Retina runner 的 ×2——
               # 5120x2880 真机尺寸纯属摆设，缩小到「容得下 region 且 region 罩住 AX 元素
               # (100,100,40,20)」即可（框源不空才建子视口；离线纯 Python 像素腿按像素计费，
               # 14.7M px 的 decode/invert/upscale 白烧几秒）。
               "_screencapture_runner": retina_shot_runner(fake_png(160, 160)),
               "_screen_size_runner": lambda argv: (1, "", "jxa 失败"),   # → look 回退 scale=1.0
               "_ocr_runner": seq_runner([(0, _ok(""), ""), (0, _ok(""), "")]),
               "_sips_runner": lambda argv: (1, "", "no sips"),
               "_vlm_read_fn": lambda png: "UNREADABLE"}   # 同 make_ctx：兜底闸离线化
        do_look(ctx)
        self.assertEqual(ctx["_viewport_registry"]["v1"]["scale"], 1.0)   # 确认回退前提
        res = do_zoom(ctx, {"viewport_id": "v1", "region": [90, 90, 60, 40], "k": 2})
        self.assertFalse(res.is_error)
        self.assertEqual(ctx["_viewport_registry"]["v2"]["scale"], 4.0)   # 实测=设备2×k2
        self.assertIn("坐标可能有偏差", res.content)
        self.assertIn("重新 look", res.content)

    def test_截回图单边被裁_x与y向scale不一致_同样警示(self):
        """请求区域触到显示器排列外沿被系统单边裁切时 vps≠vpsy（真机实测底边裁切 100x200→100x40），
        to_screen 的 y 用 vps、screen_h 用 vpsy 两套尺度混在一个 mark 里 → 警示。"""
        def lopside_shot(argv):
            png = fake_png(800, 600)
            region = _region_of_argv(argv)
            if region:
                png = fake_png(region[2], region[3] // 2)   # y 向被裁一半
            for a in argv:
                m = _PNG_PATH.search(a)
                if m:
                    Path(m.group(0)).write_bytes(png)
                    break
            return (0, "", "")
        ctx = make_ctx(dumps=(_DUMP_TARGET, _DUMP_TARGET), ocrs=(_ok(""), _ok("")))
        ctx["_screencapture_runner"] = lopside_shot
        do_look(ctx)
        res = do_zoom(ctx, {"viewport_id": "v1", "region": [50, 50, 200, 200]})
        self.assertFalse(res.is_error)
        self.assertIn("坐标可能有偏差", res.content)

    def test_实测scale正常_不多嘴警示(self):
        ctx = make_ctx(dumps=(_DUMP_TARGET, _DUMP_TARGET), ocrs=(_ok(""), _ok("")))
        do_look(ctx)
        res = do_zoom(ctx, {"viewport_id": "v1", "region": [50, 50, 200, 200]})
        self.assertFalse(res.is_error)
        self.assertNotIn("坐标可能有偏差", res.content)


class 坐标链与迭代收窄(unittest.TestCase):
    """spec §数据流 实例延伸：v1（整屏 scale=1，root 只需容得下 region 链）→ zoom → v2 → 再 zoom → v3，坐标链逐层精确。"""

    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self._p = mock.patch.object(vision, "VISION_DIR", Path(self._d.name))
        self._p.start()
        viewport._REGISTRY.clear()

    def tearDown(self):
        self._p.stop()
        self._d.cleanup()
        viewport._REGISTRY.clear()

    def test_两层坐标链精确_spec数据流实例延伸(self):
        dump1 = _DUMP_FAR
        dump2 = ("APP: T\nWIN: W\n"
                 "AXButton | 五 | pos=700,1200 | size=40x20\n"
                 "AXButton | 区外 | pos=0,0 | size=50x50")
        # OCR 喂给序列对齐新调用形态（2026-07-22 反色补跑）：look 主跑空→反色重试吃 2 次；
        # zoom dual=True 恒双跑（原图+反色）吃 2 次——各次的第 2 口喂空=反色补跑没多认出词，结果与旧单跑一致
        # root 只需容得下 spec 实例 region (620,1100,800,600) 与第二层 (670,1150,200,150)
        # 不触发 clamp（1420x1700 即可，留几 px 余量）；坐标链断言全是递推数值，与 root 绝对尺寸无关。
        ctx = make_ctx(root=(1424, 1704),
                       dumps=(dump1, dump2, ""),
                       ocrs=(_ok(""), _ok(""),
                             _ocr_out("5", 416, 516, 40, 20), _ok(""),
                             _ocr_out("7", 40, 20, 20, 10), _ok("")))
        do_look(ctx)
        # 第一层：zoom(v1, region=(620,1100,800,600)) k=2 —— spec §数据流 原例
        res2 = do_zoom(ctx, {"viewport_id": "v1", "region": [620, 1100, 800, 600], "k": 2})
        self.assertFalse(res2.is_error)
        reg = ctx["_viewport_registry"]
        v1, v2 = reg["v1"], reg["v2"]
        self.assertEqual(v2["parent_id"], "v1")
        self.assertEqual(v2["origin"], (620, 1100))
        self.assertEqual(v2["size"], (1600, 1200))            # (800,600)×2
        self.assertEqual(v2["scale"], 2.0)
        # OCR 词框图内 (416,516,40,20) 中心 (436,526) → 屏幕 (620+218, 1100+263)
        ocr_mark = [m for m in v2["marks"].values() if m["source"] == "ocr"][0]
        self.assertEqual(ocr_mark["label"], "5")
        self.assertEqual((ocr_mark["screen_cx"], ocr_mark["screen_cy"]), (838, 1363))
        self.assertEqual(viewport.to_screen(v2, 436, 526), (838, 1363))   # 往返精确
        # 第二层：zoom 的 zoom——v2 图内 (100,100,400,300) 再 k=2
        res3 = do_zoom(ctx, {"viewport_id": "v2", "region": [100, 100, 400, 300], "k": 2})
        self.assertFalse(res3.is_error)
        v3 = reg["v3"]
        self.assertEqual(v3["parent_id"], "v2")
        # origin 递推：(620+100/2, 1100+100/2)
        self.assertEqual(v3["origin"], (670, 1150))
        # 重新截屏 (670,1150,200,150) 屏幕区域 → 200x150 图 ×2 = 400x300：
        # scale 实测 = 400/200 = 2（重新截屏密度=设备倍率，不是递推的 4——嵌套 zoom 递推 scale 会虚高）
        self.assertEqual(v3["size"], (400, 300))
        self.assertEqual(v3["scale"], 2.0)
        mark3 = v3["marks"][1]
        self.assertEqual(mark3["label"], "7")
        # 图内 (40,20,20,10) 中心 (50,25) → 屏幕 (670+50/2, 1150+25/2) = (695, round(1162.5)=1162 半到偶)
        self.assertEqual((mark3["screen_cx"], mark3["screen_cy"]), (695, 1162))
        self.assertEqual(viewport.to_screen(v3, 50, 25), (695, 1162))
        # id 链单调：v1 → v2 → v3
        self.assertEqual([vp["id"] for vp in reg.values()], ["v1", "v2", "v3"])

    def test_迭代收窄_子视口按mark_no再zoom_parent链自然成立(self):
        record = []
        ctx = make_ctx(dumps=(_DUMP_TARGET, _DUMP_TARGET, _DUMP_TARGET),
                       ocrs=(_ok(""), _ok(""), _ok("")), record=record)
        do_look(ctx)
        # look 的 mark 1：屏幕框 (100,100,40,20) 中心 (120,110) → 外扩 (60,30) → 区域 (90,95,60,30)
        do_zoom(ctx, {"viewport_id": "v1", "mark_no": 1})
        reg = ctx["_viewport_registry"]
        v2 = reg["v2"]
        self.assertEqual(v2["origin"], (90, 95))
        self.assertEqual(v2["parent_id"], "v1")
        # v2 内同一元素换算后仍命中 mark 1（屏幕中心不变 (120,110)）→ 按 mark_no 再 zoom
        m = v2["marks"][1]
        self.assertEqual((m["screen_cx"], m["screen_cy"]), (120, 110))
        res3 = do_zoom(ctx, {"viewport_id": "v2", "mark_no": 1})
        self.assertFalse(res3.is_error)
        v3 = reg["v3"]
        self.assertEqual(v3["parent_id"], "v2")
        self.assertEqual(v3["origin"], (90, 95))              # 区域与 v2 重合（外扩后仍钳在 v2 内）
        self.assertEqual(v3["scale"], 2.0)                    # 实测：60x30 截屏 ×2 = 120x60
        zoom_regions = [_region_of_argv(a) for a in record if _region_of_argv(a)]
        self.assertEqual(zoom_regions, [(90, 95, 60, 30), (90, 95, 60, 30)])

    def test_污点录入_子视口AX名与OCR文本都进(self):
        long_ax = "这是zoom子视口里一段足够长的界面文本标签专门用来验证污点录入超过三十二字符"
        long_ocr = "这是zoom子视口OCR认出的一段足够长的文本用来验证污点录入需要超过三十二字符"
        dump = f"APP: T\nWIN: W\nAXButton | {long_ax} | pos=100,100 | size=40x20"
        ctx = make_ctx(dumps=(dump, dump), ocrs=(_ok(""), _ocr_out(long_ocr, 400, 10, 80, 20)))
        do_look(ctx)
        do_zoom(ctx, {"viewport_id": "v1", "region": [50, 50, 200, 200]})
        self.assertTrue(permission.taint_gate("run_command", {"command": f"echo {long_ax}"}, ctx["_tainted"]))
        self.assertTrue(permission.taint_gate("run_command", {"command": f"echo {long_ocr}"}, ctx["_tainted"]))

    def test_会话隔离_两个ctx各自zoom互不串(self):
        ctx1 = make_ctx(dumps=(_DUMP_TARGET, _DUMP_TARGET), ocrs=(_ok(""), _ok("")))
        ctx2 = make_ctx(dumps=(_DUMP_TARGET, _DUMP_TARGET), ocrs=(_ok(""), _ok("")))
        do_look(ctx1)
        do_zoom(ctx1, {"viewport_id": "v1", "mark_no": 1})
        do_look(ctx2)
        do_zoom(ctx2, {"viewport_id": "v1", "mark_no": 1})
        self.assertEqual(len(ctx1["_viewport_registry"]), 2)
        self.assertEqual(len(ctx2["_viewport_registry"]), 2)
        self.assertIsNot(ctx1["_viewport_registry"], ctx2["_viewport_registry"])
        self.assertEqual(len(viewport._REGISTRY), 0)          # 模块级单例没被碰

    def test_注册进工具表_权限ask对齐look_只读_工具数38(self):
        self.assertIn("zoom", tools_mod.REGISTRY)
        self.assertEqual(len(tools_mod.REGISTRY), 38)         # 36 → 37 → 38（P4a 加 pick）
        spec = [s for s in tools_mod.SPECS if s["function"]["name"] == "zoom"][0]
        fn = spec["function"]
        self.assertIn("viewport_id", fn["parameters"]["required"])
        self.assertIn("mark_no", fn["description"])           # 文档串引导优先 mark_no（零算术）
        d = permission.check("zoom", {})
        self.assertEqual(d.action, "ask")                     # 读屏 ask 对齐 look
        self.assertIn("视觉缓存", d.reason)
        self.assertNotIn("不落盘", d.reason)
        self.assertIn("zoom", tools_mod.READONLY_TOOLS)


@unittest.skipUnless(sys.platform == "darwin", "仅 macOS 真机冒烟")
class zoom真机冒烟(unittest.TestCase):
    """真 look 建根视口 → 真 zoom 中心区域（不注入任何 runner）。需屏幕录制/辅助功能授权。"""

    def test_真跑zoom建子视口(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        with mock.patch.object(vision, "VISION_DIR", Path(d.name)):
            ctx = {"session_id": "smoke-zoom"}
            res1 = tools_mod.execute("look", {}, ctx)
            self.assertFalse(res1.is_error)
            reg = ctx.get("_viewport_registry")
            self.assertTrue(reg, "look 应建成根视口")
            v1 = next(iter(reg.values()))
            w, h = v1["size"]
            res2 = tools_mod.execute("zoom", {"viewport_id": v1["id"],
                                              "region": [w // 4, h // 4, w // 2, h // 2], "k": 2}, ctx)
        print("\n===== zoom 真机冒烟输出 =====")
        print(res2.content[:2000])
        print("===== 输出结束 =====")
        self.assertFalse(res2.is_error)
        if "都没在小图里认出任何框" in res2.content:
            # 环境依赖：zoom 区域（屏幕中心 1/4）当前没有 AX/OCR 可识别的框（如整片文档文本区/桌面），
            # 工具如实回报「没认出框 → 不建子视口」属正确行为而非产品缺陷——认不出框时跳过，
            # 认出了框却建不成子视口才是真回归（仍走下面断言）。仅 darwin 真机冒烟，与 Windows 语义无关。
            self.skipTest("当前屏幕 zoom 区域无可识别框（环境依赖），工具如实未建子视口")
        vps = list(reg.values())
        self.assertEqual(len(vps), 2, "应建成子视口")
        v2 = vps[-1]
        print(f"子视口 {v2['id']}: size={v2['size']} scale={v2['scale']} marks={len(v2['marks'])} parent={v2['parent_id']}")
        self.assertEqual(v2["parent_id"], v1["id"])
        self.assertGreater(v2["scale"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
