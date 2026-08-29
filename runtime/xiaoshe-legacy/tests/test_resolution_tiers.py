"""§4.1.1 内容感知分辨率三档（2026-07-24 视觉升级方案）。TDD 红→绿。

只吸收「档位制」：低保真档（look 整屏概览且文字稀疏，长边 768 省 token）/ 中档（现状 1600，
**默认行为锚**——既有调用方不传 max_edge 时一字节不动）/ 高保真档（zoom 细节场景，长边 2400
近原始发送）。方案自承具体像素/密度阈值是拍脑袋建议值 → 全部集中在 vision.py 顶部命名常量，
钉值测试防静默改动，A/B 校准时只改那一处。

选档信号 = OCR 词密度（look 链路 OCR 本就跑，免费）；OCR 不可用拿不到信号 → 不盲降、回中档
现状行为（fail-soft：宁可多花 token，不在没证据时把文字密集屏压成低保真误事）。
运行：仓库根 `py -3 -m unittest tests.test_resolution_tiers -v`
"""
import base64
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import imaging, viewport, vision
from harness import tools as tools_mod


def _word(text, x, y, w, h):
    return "WORD|" + base64.b64encode(text.encode("utf-8")).decode("ascii") + f"|{x}|{y}|{w}|{h}"


def _ok(text):
    return "OK|" + base64.b64encode(text.encode("utf-8")).decode("ascii")


def _ocr_out(*words):
    return "\n".join(_word(*wd) for wd in words) + "\n" + _ok(" ".join(wd[0] for wd in words))


def seq_runner(items, record=None):
    q = list(items)

    def fake(argv):
        if record is not None:
            record.append(list(argv))
        return q.pop(0) if len(q) > 1 else q[0]
    return fake


def fake_png(w, h):
    return imaging.encode_png(w, h, (b"\xc8\xd2\xdc\xff") * (w * h))


_PNG_PATH = re.compile(r"[^'\"\s]+\.png")


def echo_shot_runner(png):
    def fake(argv):
        for a in argv:
            m = _PNG_PATH.search(a)
            if m:
                Path(m.group(0)).write_bytes(png)
                break
        return (0, "", "")
    return fake


def rec_sips(record):
    """录 argv、回报失败 → downscale 优雅回落原图，但调用的 max_edge 已被记下。"""
    def fake(argv):
        record.append(list(argv))
        return (1, "", "no sips")
    return fake


def make_ctx(root, ocrs, sips_rec):
    return {"session_id": "s",
            "_ax_runner": seq_runner(("",)),
            "_screencapture_runner": echo_shot_runner(fake_png(*root)),
            "_screen_size_runner": lambda argv: (0, f"{root[0]},{root[1]}\n", ""),
            "_ocr_runner": seq_runner([(0, o, "") for o in ocrs]),
            "_sips_runner": rec_sips(sips_rec),
            # zoom 重 OCR 词数 <8 触发 VLM 直读兜底闸 → 不注入会真发 API（无代理每次 ~6s×2）。
            # 本文件只断言 sips 压图档位，不断言兜底文本 → 假 fn 离线化。
            "_vlm_read_fn": lambda png: "UNREADABLE"}


class 阈值常量钉死(unittest.TestCase):
    """红队「阈值常量被静默改动」：钉值即校准口的保险丝——改阈值必须连本测试一起改，留痕。"""

    def test_三档长边常量(self):
        self.assertEqual(vision.TIER_LOW_EDGE, 768)
        self.assertEqual(vision.TIER_MID_EDGE, 1600)
        self.assertEqual(vision.TIER_HIGH_EDGE, 2400)

    def test_词密度门常量(self):
        self.assertEqual(vision._TIER_LOW_DENSITY, 15.0)

    def test_中档就是现状默认锚(self):
        self.assertEqual(vision.TIER_MID_EDGE, vision._MAX_EDGE,
                         "字节冻结：中档必须等于现状 _MAX_EDGE，既有调用方默认行为不变")
        self.assertEqual(vision.plan_downscale(3200, 2400), (1600, 1200),
                         "plan_downscale 不传 max_edge 仍按 1600（既有调用方行为不变）")


class pick_tier_edge选档(unittest.TestCase):
    def test_空屏低密度_低保真档(self):
        self.assertEqual(vision.pick_tier_edge(0, 2560, 1440), 768)

    def test_文字密集_中档(self):
        # 2560×1440 = 3.6864 Mpx；200 词 → 密度 ~54/Mpx ≫ 门
        self.assertEqual(vision.pick_tier_edge(200, 2560, 1440), 1600)

    def test_密度恰在门下_降档(self):
        self.assertEqual(vision.pick_tier_edge(14, 1000, 1000), 768)   # 14/Mpx < 15

    def test_密度恰好等于门_不降档(self):
        # 边界用例（红队「选档边界」）：等于门不算低——宁可中档保信息
        self.assertEqual(vision.pick_tier_edge(15, 1000, 1000), 1600)

    def test_OCR失败无信号_不盲降(self):
        # 红队「低保真档信息丢失误事」：拿不到密度信号时绝不安降，回现状中档
        self.assertEqual(vision.pick_tier_edge(0, 2560, 1440, ocr_ok=False), 1600)

    def test_尺寸非法_回中档不炸(self):
        self.assertEqual(vision.pick_tier_edge(0, 0, 0), 1600)
        self.assertEqual(vision.pick_tier_edge(0, -5, 100), 1600)


class look接线选档(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self._p = mock.patch.object(vision, "VISION_DIR", Path(self._d.name))
        self._p.start()
        viewport._REGISTRY.clear()

    def tearDown(self):
        self._p.stop()
        self._d.cleanup()
        viewport._REGISTRY.clear()

    def _look(self, root, ocrs):
        rec = []
        ctx = make_ctx(root, ocrs, rec)
        with mock.patch.object(imaging, "draw_marks", lambda p, m, **k: p):
            tools_mod.execute("look", {}, ctx)
        return rec

    def test_文字稀疏_整屏两路全空走低保真768(self):
        """两路全空（AX 空 + OCR 空结果）时，整屏截图按词密度选档：稀疏 → 768。"""
        rec = []
        ctx = make_ctx((2000, 1000), (_ok(""),), rec)  # OCR 空结果（非失败）→ 两路全空
        with mock.patch.object(imaging, "draw_marks", lambda p, m, **k: p):
            tools_mod.execute("look", {}, ctx)
        self.assertTrue(rec, "图大于档位长边时必须调用 sips 压图")
        self.assertIn("768", rec[-1], f"稀疏整屏两路全空应按低保真档压到 768：{rec[-1]}")

    def test_文字稀疏_SoM编号截图固定中档1600(self):
        """SoM 编号截图固定 1600：红色框角小号码是 pick 定位关键信号，低保真档会糊掉（审查 MED-1）。"""
        rec = self._look((2000, 1000), (_ocr_out(("hi", 10, 10, 20, 20)),))  # 0.5 词/Mpx < 15
        self.assertTrue(rec, "图大于档位长边时必须调用 sips 压图")
        self.assertIn("1600", rec[-1], f"SoM 编号截图固定中档 1600：{rec[-1]}")

    def test_文字密集_整屏保持中档1600(self):
        words = tuple((f"w{i}", (i * 7) % 1900, (i * 13) % 900, 20, 20) for i in range(100))
        rec = self._look((2000, 1000), (_ocr_out(*words),))                  # 50 词/Mpx ≥ 15
        self.assertIn("1600", rec[-1], f"密集整屏应保持中档 1600：{rec[-1]}")

    def test_OCR失败_不盲降_按中档1600(self):
        rec = self._look((2000, 1000), ("ERR|引擎不可用",))
        self.assertIn("1600", rec[-1], f"OCR 失败拿不到密度信号，不得降低保真：{rec[-1]}")


class zoom高保真档(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self._p = mock.patch.object(vision, "VISION_DIR", Path(self._d.name))
        self._p.start()
        viewport._REGISTRY.clear()

    def tearDown(self):
        self._p.stop()
        self._d.cleanup()
        viewport._REGISTRY.clear()

    def test_zoom放大图按高保真2400而非1600(self):
        rec = []
        ctx = make_ctx((2000, 1000),
                       (_ocr_out(("a", 10, 10, 20, 20)),                 # look 主跑
                        _ocr_out(("5", 100, 100, 40, 40)),               # zoom dual 主跑
                        _ocr_out(("7", 500, 500, 40, 40))),              # zoom dual 补跑
                       rec)
        with mock.patch.object(imaging, "draw_marks", lambda p, m, **k: p):
            tools_mod.execute("look", {}, ctx)
            tools_mod.execute("zoom", {"viewport_id": "v1", "region": [0, 0, 1500, 800], "k": 2}, ctx)
        flat = [a for argv in rec for a in argv]
        self.assertIn("2400", flat, f"zoom 细节场景应按高保真档 2400 压图：{rec}")
        # SoM 编号截图固定 1600（look 的）；zoom 放大图必须 2400，不允许 zoom 也按 1600 压
        zoom_calls = [argv for argv in rec if "2400" in argv]
        self.assertTrue(zoom_calls, f"zoom 放大图必须走 2400 高保真档：{rec}")
        self.assertNotIn("1600", [a for argv in zoom_calls for a in argv],
                         "zoom 放大图不按 1600 压（高保真档近原始发送）")


if __name__ == "__main__":
    unittest.main()
