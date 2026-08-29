"""统一「裁剪-重问」子系统 P2 · look 工具：建根视口 + AX/OCR 双框源 + SoM 编号图。TDD 红→绿。

spec：docs/superpowers/specs/2026-07-19-统一裁剪重问子系统-design.md §组件3 look 行 / §框源 / §错误处理 / §Mac 适配。
- 根视口：origin=(0,0)，scale=截图像素宽÷屏幕逻辑宽（实测不假设，Mac Retina=2 / Win=1），
  新增 platform_caps.screen_logical_size（可注入 runner 离线 TDD）。
- 双框源：AX 元素（执行层坐标→图内像素×scale）+ OCR 词框（图内像素）→ viewport.merge_marks 合并去重
  （中心距<16 物理像素并为一个编号，AX 名优先做 label，合并框 source 记 "uia+ocr"——规则在本文件钉死）。
- 注册表按会话隔离：ctx["_viewport_registry"]（模块级 register/get 仅留纯函数测试用）。
- 错误处理：OCR 缺→只用 AX 并如实说明；两路全空→引导 observe/click_at；截屏失败→不产幽灵视口。
全部注入 runner 离线；真机冒烟一条 skipUnless(darwin)。
运行：仓库根 `python -m unittest tests.test_look_tool -v`
"""
import base64
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import imaging, observe, permission, platform_caps, viewport
from harness import tools as tools_mod
from harness import vision

_DUMP = """APP: TestApp
WIN: 演示窗口
AXButton | 关闭 | pos=100,50 | size=20x10
AXStaticText | 这是一段足够长的界面文本标签专门用来验证污点录入机制要求超过三十二个字符 | pos=700,900 | size=100x20"""


def fake_png(w, h, rgb=(32, 48, 64)):
    """imaging.encode_png 造假截图（纯色），IHDR 尺寸 = 截图像素尺寸。"""
    return imaging.encode_png(w, h, (bytes(rgb) + b"\xff") * (w * h))


def _word(text, x, y, w, h):
    return "WORD|" + base64.b64encode(text.encode("utf-8")).decode("ascii") + f"|{x}|{y}|{w}|{h}"


def _ok(text):
    return "OK|" + base64.b64encode(text.encode("utf-8")).decode("ascii")


import re as _re
_PNG_PATH = _re.compile(r"[^'\"\s]+\.png")


def shot_runner(png):
    """假 screencapture：把假截图写进 argv 里的 .png 承载路径（照 test_observe_tool 先例）。"""
    def fake(argv):
        for a in argv:
            m = _PNG_PATH.search(a)
            if m:
                Path(m.group(0)).write_bytes(png)
                break
        return (0, "", "")
    return fake


def size_runner(text="1512,982", rc=0):
    return lambda argv: (rc, text + "\n", "")


def ocr_runner(out=None, rc=0, err=""):
    return lambda argv: (rc, out if out is not None else _ok(""), err)


def retina_ctx(dump=_DUMP, ocr_out=None, png=None):
    """Mac Retina 场景：截图 3024×1964 物理像素、屏幕逻辑 1512×982 → scale=2。"""
    return {"session_id": "s",
            "_ax_runner": lambda script: dump,
            "_screencapture_runner": shot_runner(png if png is not None else fake_png(3024, 1964)),
            "_screen_size_runner": size_runner(),
            "_ocr_runner": ocr_runner(ocr_out),
            "_sips_runner": lambda argv: (1, "", "no sips")}   # 压图失败 → 优雅回落原图


class 屏幕逻辑尺寸(unittest.TestCase):
    """platform_caps.screen_logical_size：Mac=Finder desktop bounds（逻辑点）、Win=PrimaryScreen.Bounds。"""

    def test_mac走JXA_NSScreen主屏且解析逻辑点(self):
        # 主屏（非全显器并集）：2026-07-22 双显器真机实证 Finder desktop bounds=并集 5120x1440、
        # 主屏截图 2560x1440 → 并集当分母测出 scale=0.5 全错；NSScreen.mainScreen 才与截图/AX/点击同指主屏
        seen = {}
        got = platform_caps.screen_logical_size(
            runner=lambda a: (seen.update(argv=a), (0, "1512,982\n", ""))[1], plat="darwin")
        self.assertEqual(got, (1512, 982))
        self.assertEqual(seen["argv"][0], "osascript")
        self.assertIn("NSScreen.mainScreen", seen["argv"][-1])
        self.assertNotIn("window of desktop", seen["argv"][-1])     # 并集探针已被真机证据否掉

    def test_mac小数输出取整(self):
        got = platform_caps.screen_logical_size(runner=lambda a: (0, "1512.0,981.5\n", ""), plat="darwin")
        self.assertEqual(got, (1512, 982))

    def test_win走PS且脚本先自设DPI感知(self):
        seen = {}
        got = platform_caps.screen_logical_size(
            runner=lambda a: (seen.update(argv=a), (0, "3120,2080\n", ""))[1], plat="win32")
        self.assertEqual(got, (3120, 2080))
        script = seen["argv"][-1]
        self.assertIn("PrimaryScreen.Bounds", script)
        # 不 DPI 感知时 Bounds 是缩放后逻辑尺寸，与物理截图差倍率——必须先自设（同 _win_shot_ps 先例）
        self.assertLess(script.index("SetProcessDPIAware"), script.index("PrimaryScreen"))

    def test_失败或坏输出回None(self):
        self.assertIsNone(platform_caps.screen_logical_size(runner=lambda a: (1, "", "boom"), plat="darwin"))
        self.assertIsNone(platform_caps.screen_logical_size(runner=lambda a: (0, "not-a-size\n", ""), plat="darwin"))
        self.assertIsNone(platform_caps.screen_logical_size(runner=lambda a: (0, "0,0\n", ""), plat="darwin"))

    def test_不支持平台无runner回None(self):
        self.assertIsNone(platform_caps.screen_logical_size(plat="linux"))


class 合并去重(unittest.TestCase):
    """viewport.merge_marks：中心距 < 16 物理像素的 AX/OCR 框并为一个编号（规则在此钉死）。"""

    def test_重叠框合并_AX名优先_source记双源(self):
        ax = [{"label": "关闭", "box": (100, 100, 40, 20)}]          # 中心 (120,110)
        ocr = [{"label": "关闭", "box": (105, 102, 40, 20)}]         # 中心 (125,112)，距 ~5.4 <16
        merged = viewport.merge_marks(ax, ocr)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["label"], "关闭")
        self.assertEqual(merged[0]["box"], (100, 100, 40, 20))       # 框取 AX 框（执行层语义可靠）
        self.assertEqual(merged[0]["source"], "uia+ocr")

    def test_AX名空_回落OCR文本做label(self):
        ax = [{"label": "", "box": (100, 100, 40, 20)}]
        ocr = [{"label": "5", "box": (102, 101, 40, 20)}]
        self.assertEqual(viewport.merge_marks(ax, ocr)[0]["label"], "5")

    def test_阈值边界_恰好16不合并_小于16合并(self):
        ax = [{"label": "a", "box": (0, 0, 10, 10)}]                 # 中心 (5,5)
        ocr_on = [{"label": "b", "box": (16, 0, 10, 10)}]            # 中心 (21,5)，距恰 16 → 不合并
        self.assertEqual(len(viewport.merge_marks(ax, ocr_on)), 2)
        ocr_in = [{"label": "b", "box": (15, 0, 10, 10)}]            # 中心 (20,5)，距 15 <16 → 合并
        self.assertEqual(len(viewport.merge_marks(ax, ocr_in)), 1)

    def test_对角距离按欧氏算(self):
        ax = [{"label": "a", "box": (0, 0, 10, 10)}]                 # 中心 (5,5)
        ocr = [{"label": "b", "box": (11, 11, 10, 10)}]              # 中心 (16,16)，距 √242≈15.6 <16
        self.assertEqual(len(viewport.merge_marks(ax, ocr)), 1)
        ocr_far = [{"label": "b", "box": (12, 11, 10, 10)}]          # 中心 (17,16)，距 √265≈16.3 → 不合并
        self.assertEqual(len(viewport.merge_marks(ax, ocr_far)), 2)

    def test_未配对各记各源_顺序AX先OCR后(self):
        ax = [{"label": "a", "box": (0, 0, 10, 10)}]
        ocr = [{"label": "b", "box": (500, 500, 10, 10)}]
        merged = viewport.merge_marks(ax, ocr)
        self.assertEqual([(m["label"], m["source"]) for m in merged], [("a", "uia"), ("b", "ocr")])

    def test_一个OCR框至多被一个AX吸收_取最近(self):
        ax = [{"label": "a1", "box": (0, 0, 10, 10)},                # 中心 (5,5)
              {"label": "a2", "box": (12, 0, 10, 10)}]               # 中心 (17,5)
        ocr = [{"label": "b", "box": (1, 0, 10, 10)}]                # 中心 (6,5)：距 a1=1、距 a2=11
        merged = viewport.merge_marks(ax, ocr)
        self.assertEqual([(m["label"], m["source"]) for m in merged],
                         [("a1", "uia+ocr"), ("a2", "uia")])         # b 被最近的 a1 吸收，不再配 a2

    def test_合并源是合法mark来源(self):
        vp = viewport.new_viewport("v1", origin=(0, 0), scale=1, size=(100, 100),
                                   marks={1: {"no": 1, "label": "x", "screen_cx": 0, "screen_cy": 0,
                                              "source": "uia+ocr"}})
        self.assertEqual(vp["marks"][1]["source"], "uia+ocr")


class 会话注册表(unittest.TestCase):
    """viewport 注册表包一层：ctx 挂一份（会话隔离），模块级 _REGISTRY 只留纯函数测试。"""

    def test_register走指定registry_不碰模块级(self):
        reg = viewport.new_registry()
        viewport.register(viewport.new_viewport("v1", origin=(0, 0), scale=1, size=(10, 10)), reg)
        self.assertIn("v1", reg)
        self.assertEqual(len(viewport._REGISTRY), 0)

    def test_两份registry互不串_LRU各自淘汰(self):
        r1, r2 = viewport.new_registry(), viewport.new_registry()
        for i in range(1, 10):
            viewport.register(viewport.new_viewport(f"v{i}", origin=(0, 0), scale=1, size=(10, 10)), r1)
        viewport.register(viewport.new_viewport("v1", origin=(0, 0), scale=1, size=(10, 10)), r2)
        self.assertEqual(len(r1), 8)
        self.assertIsNone(viewport.get("v1", r1))       # r1 的 v1 已被淘汰
        self.assertIsNotNone(viewport.get("v1", r2))    # r2 的 v1 不受影响

    def test_next_id避开已占用(self):
        reg = viewport.new_registry()
        self.assertEqual(viewport.next_id(reg), "v1")
        viewport.register(viewport.new_viewport("v1", origin=(0, 0), scale=1, size=(10, 10)), reg)
        self.assertEqual(viewport.next_id(reg), "v2")


class look工具(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self._p = mock.patch.object(vision, "VISION_DIR", Path(self._d.name))
        self._p.start()
        viewport._REGISTRY.clear()

    def tearDown(self):
        self._p.stop()
        self._d.cleanup()
        viewport._REGISTRY.clear()

    def test_Retina场景_scale实测2_坐标换算精确(self):
        """截图 3024×1964 像素 ÷ 逻辑 1512×982 → scale=2；
        AX 元素 (100,50,20,10) 逻辑点 → 图内 (200,100,40,20)；OCR 词框图内 (416,516) → 屏幕 (208,258)。"""
        ocr_out = _word("你好世界这是一段够长的OCR识别文本用来验证污点", 416, 516, 40, 20) + "\n" + _ok("x")
        captured = {}

        def fake_marks(png, marks, **kw):
            captured["marks"] = marks
            return png
        ctx = retina_ctx(ocr_out=ocr_out)
        with mock.patch.object(imaging, "draw_marks", fake_marks):
            res = tools_mod.execute("look", {}, ctx)
        self.assertFalse(res.is_error)
        reg = ctx["_viewport_registry"]
        self.assertEqual(len(reg), 1)
        vp = next(iter(reg.values()))
        self.assertEqual(vp["scale"], 2.0)                       # 实测：3024÷1512
        self.assertEqual(vp["origin"], (0, 0))
        self.assertEqual(vp["size"], (3024, 1964))
        # AX (100,50,20,10) 逻辑 → 图内 (200,100,40,20) 画框
        boxes = [m["box"] for m in captured["marks"]]
        self.assertIn((200, 100, 40, 20), boxes)
        # OCR 词框图内 (416,516,40,20) → 中心屏幕 (208+10, 258+5) = (218,263)
        ocr_marks = [m for m in vp["marks"].values() if m["source"] == "ocr"]
        self.assertEqual(len(ocr_marks), 1)
        self.assertEqual((ocr_marks[0]["screen_cx"], ocr_marks[0]["screen_cy"]), (218, 263))
        self.assertEqual((ocr_marks[0]["screen_w"], ocr_marks[0]["screen_h"]), (20, 10))
        # AX 元素中心屏幕坐标 = (110,55)
        ax_marks = [m for m in vp["marks"].values() if m["source"] == "uia"]
        self.assertIn((110, 55), [(m["screen_cx"], m["screen_cy"]) for m in ax_marks])
        # 往返精确：to_screen(图内 416,516) 与建表换算一致
        self.assertEqual(viewport.to_screen(vp, 416, 516), (208, 258))
        # 编号表行进返回：label + 屏幕坐标 + 来源
        self.assertIn("关闭", res.content)
        self.assertIn("(110, 55)", res.content)
        self.assertIn("uia", res.content)
        self.assertEqual(ctx.get("_vision_pending"), ["img-1"])
        self.assertIn("img-1", res.content)
        self.assertIn(vp["id"], res.content)

    def test_合并去重端到端_AX与OCR重叠并成一个编号(self):
        # AX (100,50,20,10) 逻辑 → 图内中心 (220,110)；OCR 词框图内 (216,106,40,20) 中心 (236,116) 距 ~17 不合？
        # 用距 <16 的：OCR (214,104,40,20) 中心 (234,114)，距 √(14²+4²)≈14.6 <16 → 合并
        ocr_out = _word("关闭", 214, 104, 40, 20) + "\n" + _ok("x")
        captured = {}
        ctx = retina_ctx(ocr_out=ocr_out)
        with mock.patch.object(imaging, "draw_marks", lambda p, m, **k: captured.update(marks=m) or p):
            tools_mod.execute("look", {}, ctx)
        vp = next(iter(ctx["_viewport_registry"].values()))
        srcs = sorted(m["source"] for m in vp["marks"].values())
        self.assertIn("uia+ocr", srcs)
        self.assertEqual(len([m for m in vp["marks"].values() if m["source"] == "uia+ocr"]), 1)
        # 合并框 label 取 AX 名
        merged_mark = [m for m in vp["marks"].values() if m["source"] == "uia+ocr"][0]
        self.assertEqual(merged_mark["label"], "关闭")

    def test_逻辑尺寸取不到_scale回退1且如实说明(self):
        ctx = retina_ctx()
        ctx["_screen_size_runner"] = lambda argv: (1, "", "boom")
        with mock.patch.object(imaging, "draw_marks", lambda p, m, **k: p):
            res = tools_mod.execute("look", {}, ctx)
        vp = next(iter(ctx["_viewport_registry"].values()))
        self.assertEqual(vp["scale"], 1.0)
        self.assertIn("1.0", res.content)
        self.assertIn("逻辑尺寸", res.content)               # 如实说明，别假装测到了

    def test_OCR缺失_只用AX框源并如实说明(self):
        ctx = retina_ctx()
        ctx["_ocr_runner"] = lambda argv: (0, "ERR|swift 不在", "")
        with mock.patch.object(imaging, "draw_marks", lambda p, m, **k: p):
            res = tools_mod.execute("look", {}, ctx)
        self.assertFalse(res.is_error)
        vp = next(iter(ctx["_viewport_registry"].values()))
        self.assertTrue(vp["marks"])
        self.assertTrue(all(m["source"] == "uia" for m in vp["marks"].values()))
        self.assertIn("OCR", res.content)                    # 如实说明 OCR 不可用

    def test_AX为空_只用OCR框源(self):
        ctx = retina_ctx(dump="", ocr_out=_word("孤立词", 416, 516, 40, 20) + "\n" + _ok("孤立词"))
        with mock.patch.object(imaging, "draw_marks", lambda p, m, **k: p):
            res = tools_mod.execute("look", {}, ctx)
        vp = next(iter(ctx["_viewport_registry"].values()))
        self.assertEqual(len(vp["marks"]), 1)
        self.assertEqual(vp["marks"][1]["source"], "ocr")

    def test_两路全空_引导observe或click_at_不产视口(self):
        ctx = retina_ctx(dump="", ocr_out=_ok(""))
        with mock.patch.object(imaging, "draw_marks", lambda p, m, **k: p):
            res = tools_mod.execute("look", {}, ctx)
        self.assertIn("observe", res.content)
        self.assertIn("click_at", res.content)
        self.assertEqual(len(ctx["_viewport_registry"]), 0)  # 不产幽灵视口

    def test_截屏失败_错误态不产幽灵视口(self):
        ctx = retina_ctx()
        ctx["_screencapture_runner"] = lambda argv: (1, "", "could not create image from display")
        res = tools_mod.execute("look", {}, ctx)
        self.assertIn("屏幕录制", res.content)
        self.assertEqual(len(ctx["_viewport_registry"]), 0)  # 注册表不进任何东西
        self.assertNotIn("_vision_pending", ctx)

    def test_污点录入_AX名与OCR文本都进(self):
        ocr_text = "这是一段够长的OCR识别文本内容用来验证污点录入需要超过三十二字符"
        ctx = retina_ctx(ocr_out=_word(ocr_text, 416, 516, 40, 20) + "\n" + _ok(ocr_text))
        with mock.patch.object(imaging, "draw_marks", lambda p, m, **k: p):
            tools_mod.execute("look", {}, ctx)
        ax_name = "这是一段足够长的界面文本标签专门用来验证污点录入机制要求超过三十二个字符"
        self.assertTrue(permission.taint_gate("run_command", {"command": f"echo {ax_name}"}, ctx["_tainted"]))
        self.assertTrue(permission.taint_gate("run_command", {"command": f"echo {ocr_text}"}, ctx["_tainted"]))

    def test_会话隔离_两个ctx互不串(self):
        with mock.patch.object(imaging, "draw_marks", lambda p, m, **k: p):
            ctx1, ctx2 = retina_ctx(), retina_ctx()
            tools_mod.execute("look", {}, ctx1)
            tools_mod.execute("look", {}, ctx2)
        self.assertEqual(len(ctx1["_viewport_registry"]), 1)
        self.assertEqual(len(ctx2["_viewport_registry"]), 1)
        self.assertIsNot(ctx1["_viewport_registry"], ctx2["_viewport_registry"])
        self.assertEqual(len(viewport._REGISTRY), 0)          # 模块级单例没被碰

    def test_编号上限40_截断并提示先zoom(self):
        lines = ["APP: T", "WIN: W"] + [f"AXButton | b{i} | pos={i * 30},0 | size=20x10" for i in range(50)]
        ctx = retina_ctx(dump="\n".join(lines))
        with mock.patch.object(imaging, "draw_marks", lambda p, m, **k: p):
            res = tools_mod.execute("look", {}, ctx)
        vp = next(iter(ctx["_viewport_registry"].values()))
        self.assertEqual(len(vp["marks"]), tools_mod._SOM_MAX_MARKS)
        self.assertIn("zoom", res.content)                    # 提示可先 zoom 某区域细化

    def test_小图真画框_编号从1连续(self):
        """不 mock draw_marks 的小图全链路：画框真跑、编号 1..N 连续且与表对齐。"""
        ctx = retina_ctx(png=fake_png(600, 400))
        ctx["_screen_size_runner"] = size_runner("600,400")   # scale=1
        res = tools_mod.execute("look", {}, ctx)
        self.assertFalse(res.is_error)
        vp = next(iter(ctx["_viewport_registry"].values()))
        self.assertEqual(sorted(vp["marks"]), list(range(1, len(vp["marks"]) + 1)))
        # 画过框的图与原图字节不同（红框真画上去了）
        self.assertNotEqual(vision._read_index("s"), [])

    def test_注册进工具表_权限ask带整屏隐私文案_只读(self):
        self.assertIn("look", tools_mod.REGISTRY)
        self.assertIn("look", [s["function"]["name"] for s in tools_mod.SPECS])
        d = permission.check("look", {})
        self.assertEqual(d.action, "ask")
        self.assertIn("窗口", d.reason)                       # 审批文案说清整屏隐私面（同 screenshot 先例）
        self.assertIn("look", tools_mod.READONLY_TOOLS)

    def test_审批与工具文案不谎称不落盘(self):
        # 红队真跑复现：put_image 把编号图真落盘 .state/vision/<sid>/img-N.png（874KB 整屏图，
        # purge_session 才删）——「不落盘」是假文案，用户按它审批=被误导。须如实说视觉缓存。
        d = permission.check("look", {})
        self.assertNotIn("不落盘", d.reason)
        self.assertIn("视觉缓存", d.reason)
        spec = [s for s in tools_mod.SPECS if s["function"]["name"] == "look"][0]
        self.assertNotIn("不落盘", spec["function"]["description"])

    def test_连续look十次_id单调不复用(self):
        # 注册表上限 8：第 9/10 次 look 若复用淘汰的 v1/v2，模型拿旧 id 会点错视口（红队心脏病）
        ctx = retina_ctx()
        seen = []
        with mock.patch.object(imaging, "draw_marks", lambda p, m, **k: p):
            for _ in range(10):
                tools_mod.execute("look", {}, ctx)
                seen.append(next(reversed(ctx["_viewport_registry"])))   # 最新注册的视口 id
        self.assertEqual(len(set(seen)), 10)
        self.assertEqual(len(ctx["_viewport_registry"]), 8)


@unittest.skipUnless(sys.platform == "darwin", "仅 macOS 真机冒烟")
class look真机冒烟(unittest.TestCase):
    """真截图 + 真 AX + 真 OCR + 真建视口（不注入任何 runner）。需屏幕录制/辅助功能授权。"""

    def test_真跑look建根视口(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        with mock.patch.object(vision, "VISION_DIR", Path(d.name)):
            ctx = {"session_id": "smoke"}
            res = tools_mod.execute("look", {}, ctx)
        print("\n===== look 真机冒烟输出 =====")
        print(res.content[:2000])
        print("===== 输出结束 =====")
        self.assertFalse(res.is_error)
        reg = ctx.get("_viewport_registry")
        self.assertTrue(reg, "应建成根视口")
        vp = next(iter(reg.values()))
        print(f"视口 {vp['id']}: size={vp['size']} scale={vp['scale']} marks={len(vp['marks'])}")
        self.assertGreater(vp["scale"], 0)
        self.assertTrue(ctx.get("_vision_pending"), "编号图应入 vision 管道")


if __name__ == "__main__":
    unittest.main(verbosity=2)
