"""OCR 盲区选型回归集（evals/ocr_blindspot_suite.py）离线单元测试。

不碰浏览器、不碰真 OCR：统计逻辑（run_case/summarize/judge/退出码）全部注入假 OCR 验证；
Tesseract 臂注入假 runner/假探测函数验证臂分流、未安装跳过、双臂对照表与退出码语义；
反色通道用 harness.imaging 现造小 PNG 走真反色，验证「主跑漏 → 反色救回」的记账。
运行：仓库根 `py -3 -m unittest tests.test_ocr_blindspot_suite -v`
"""
import unittest
from unittest import mock

from evals import ocr_blindspot_suite as suite
from harness import imaging


def _tiny_png():
    """4x4 真 PNG（纯标准库 imaging 现造），供反色通道真跑。"""
    return imaging.encode_png(4, 4, bytes([10, 20, 30, 255] * 16))


class TokenMatching(unittest.TestCase):
    def test_cjk空格压平命中(self):
        # WinRT 的 CJK 结果字间带空格（「显 示 为 5 2」），压平后应命中整词
        hay = suite.collect_text("显 示 为 5 2\n简 体 中 文", [{"text": "52"}])
        self.assertIn(suite.squash("显示为"), hay)
        self.assertIn("52", hay)
        self.assertIn(suite.squash("简体中文"), hay)

    def test_词表与全文合并比对(self):
        hay = suite.collect_text("只有全文", [{"text": "词表词"}])
        self.assertIn("只有全文", hay)
        self.assertIn("词表词", hay)


class RunCase(unittest.TestCase):
    def _case(self):
        return {"id": "t", "cls": suite.CLS_DIGITS, "html": "x.html",
                "expect": ["5", "52", "CE"], "digits": ["5"]}

    def test_全命中不触发反色(self):
        png = _tiny_png()
        calls = []

        def ocr(p):
            calls.append(p)
            return True, "5 52 CE", [{"text": "5"}, {"text": "52"}, {"text": "CE"}]

        r = suite.run_case(self._case(), png, ocr)
        self.assertEqual(r["hits"], ["5", "52", "CE"])
        self.assertEqual(r["misses"], [])
        self.assertFalse(r["invert_used"])          # 零漏认 → 不白跑补跑
        self.assertEqual(len(calls), 1)
        self.assertEqual(r["digit_dropped"], [])

    def test_漏认触发反色救回记账(self):
        png = _tiny_png()
        inv = suite.invert_png(png)
        self.assertIsNotNone(inv)

        def ocr(p):
            if p == inv:        # 反色图：把「5」救回来
                return True, "5", [{"text": "5", "x": 0, "y": 0, "w": 1, "h": 1}]
            return True, "52 CE", []   # 主跑：孤立 5 被丢

        r = suite.run_case(self._case(), png, ocr)
        self.assertEqual(r["misses"], ["5"])
        self.assertEqual(r["rescued"], ["5"])
        self.assertTrue(r["invert_used"])
        self.assertEqual(r["digit_dropped"], ["5"])

    def test_主跑失败全漏且反色救不回(self):
        png = _tiny_png()

        def ocr(_p):
            return False, "引擎不可用", []

        r = suite.run_case(self._case(), png, ocr)
        self.assertFalse(r["ocr_ok"])
        self.assertEqual(r["misses"], ["5", "52", "CE"])
        self.assertEqual(r["rescued"], [])
        self.assertEqual(r["word_count"], 0)

    def test_无效png反色静默降级(self):
        def ocr(_p):
            return True, "52 CE", []

        r = suite.run_case(self._case(), b"not-a-png", ocr)
        self.assertEqual(r["misses"], ["5"])
        self.assertFalse(r["invert_used"])          # 反色图造不出来 → 不补跑、不炸
        self.assertEqual(r["rescued"], [])


class SummarizeAndJudge(unittest.TestCase):
    def _mk(self, cls, hits, misses, digits=(), rescued=(), gate=True):
        expect = hits + misses
        return {"id": "x", "cls": cls, "expect": expect, "hits": hits, "misses": misses,
                "rescued": rescued, "digits": list(digits), "gate": gate,
                "digit_dropped": [t for t in digits if t in misses]}

    def test_分类聚合三指标(self):
        results = [
            self._mk(suite.CLS_DIGITS, hits=["52", "CE"], misses=["0", "5"],
                     digits=["0", "5"], rescued=["5"]),
            self._mk(suite.CLS_CJK, hits=["显示为", "设置"], misses=["檔案"], rescued=["檔案"]),
            self._mk(suite.CLS_SMALL, hits=["render", "52"], misses=[]),
        ]
        s = suite.summarize(results)
        d = s["per_cls"][suite.CLS_DIGITS]
        self.assertAlmostEqual(d["recall"], 2 / 4)
        self.assertAlmostEqual(d["digit_drop"], 1.0)       # 两个孤立数字全丢
        self.assertAlmostEqual(d["rescue"], 0.5)           # 漏 2 救回 1
        c = s["per_cls"][suite.CLS_CJK]
        self.assertAlmostEqual(c["recall"], 2 / 3)
        self.assertIsNone(c["digit_drop"])                 # 非数字类不算丢弃率
        self.assertAlmostEqual(c["rescue"], 1.0)
        # 门禁类合并召回：CJK 2/3 + SMALL 2/2 → 4/5
        self.assertAlmostEqual(s["gate_recall"], 4 / 5)

    def test_门禁判定双向与退出码(self):
        ok_results = [self._mk(suite.CLS_CJK, hits=["a"] * 9, misses=["b"]),
                      self._mk(suite.CLS_SMALL, hits=["c"], misses=[])]
        j = suite.judge(suite.summarize(ok_results))
        self.assertFalse(j["over_gate"])                   # 10/11 ≈ 0.91 ≥ 0.85 → 达标
        self.assertEqual(suite.exit_code_of(j), 0)

        bad_results = [self._mk(suite.CLS_CJK, hits=["a"], misses=["b", "c", "d"]),
                       self._mk(suite.CLS_SMALL, hits=["e"], misses=["f", "g"])]
        j2 = suite.judge(suite.summarize(bad_results))
        self.assertTrue(j2["over_gate"])                   # 2/6 ≈ 0.33 < 0.85 → 超门槛
        self.assertEqual(suite.exit_code_of(j2), 1)

    def test_孤立数字类不计入门禁(self):
        # 数字类全丢（UIA 承接的已知盲区）但门禁类全中 → 仍达标
        results = [self._mk(suite.CLS_DIGITS, hits=[], misses=["5", "0"], digits=["5", "0"]),
                   self._mk(suite.CLS_CJK, hits=["显示为"], misses=[]),
                   self._mk(suite.CLS_SMALL, hits=["render"], misses=[])]
        s = suite.summarize(results)
        self.assertAlmostEqual(s["per_cls"][suite.CLS_DIGITS]["recall"], 0.0)
        self.assertAlmostEqual(s["gate_recall"], 1.0)
        self.assertFalse(suite.judge(s)["over_gate"])

    def test_gate假标记用例不计入门禁(self):
        # zoom 小字·原尺（gate=False，zoom 放大承接）全丢，门禁用例全中 → 仍达标；
        # 它的漏认只进分类汇总、不拉低门禁召回率
        results = [self._mk(suite.CLS_SMALL, hits=[], misses=["a", "b"], gate=False),
                   self._mk(suite.CLS_SMALL, hits=["c", "d"], misses=[], gate=True),
                   self._mk(suite.CLS_CJK, hits=["e"], misses=[])]
        s = suite.summarize(results)
        self.assertAlmostEqual(s["per_cls"][suite.CLS_SMALL]["recall"], 0.5)   # 分类汇总照算
        self.assertAlmostEqual(s["gate_recall"], 1.0)                          # 门禁只算 gate=True
        self.assertFalse(suite.judge(s)["over_gate"])

    def test_宽松口径滤标点(self):
        # 「width=1600」被 WinRT 读成「width：1600」（=→：）→ 严格漏、宽松中
        png = _tiny_png()

        def ocr(_p):
            return True, "width：1600 52", []

        r = suite.run_case({"id": "t", "cls": suite.CLS_SMALL, "expect": ["width=1600", "52"]},
                           png, ocr)
        self.assertEqual(r["hits"], ["52"])
        self.assertEqual(r["loose_hits"], ["width=1600", "52"])

    def test_run_case携带gate与upscale(self):
        png = _tiny_png()

        def ocr(_p):
            return True, "5", [{"text": "5"}]

        r = suite.run_case({"id": "t", "cls": suite.CLS_SMALL, "expect": ["5"],
                            "gate": False, "upscale": 3}, png, ocr)
        self.assertFalse(r["gate"])
        self.assertEqual(r["upscale"], 3)


class TesseractArm(unittest.TestCase):
    """Tesseract 臂：探测、语言包前缀、假 runner 分流、未安装跳过——全程不碰真 tesseract。"""

    def test_探测优先PATH(self):
        exe = suite.find_tesseract(which=lambda name: "/usr/bin/tesseract",
                                   isfile=lambda p: False)
        self.assertEqual(exe, "/usr/bin/tesseract")

    def test_探测回落常见安装路径(self):
        exe = suite.find_tesseract(which=lambda name: None,
                                   isfile=lambda p: p == r"C:\Program Files\Tesseract-OCR\tesseract.exe")
        self.assertEqual(exe, r"C:\Program Files\Tesseract-OCR\tesseract.exe")

    def test_探测不到返回None(self):
        self.assertIsNone(suite.find_tesseract(which=lambda name: None,
                                               isfile=lambda p: False))

    def test_语言包前缀三级回落(self):
        # exe 旁 tessdata 齐 → 不设前缀
        self.assertIsNone(suite.find_tessdata_prefix(r"C:\T\tesseract.exe", isfile=lambda p: True))
        # exe 旁缺 chi、.state/tessdata 齐 → 回落前缀
        def isfile(p):
            return p.startswith(suite.TESSDATA_FALLBACK)
        self.assertEqual(suite.find_tessdata_prefix(r"C:\T\tesseract.exe", isfile=isfile),
                         suite.TESSDATA_FALLBACK)
        # 两处都缺 → None（子进程会如实报错）
        self.assertIsNone(suite.find_tessdata_prefix(r"C:\T\tesseract.exe", isfile=lambda p: False))

    def test_假runner正常分流(self):
        seen = {}

        def fake(argv, env):
            seen["argv"] = argv
            seen["env"] = env
            return 0, "显示为 52\n设置\n".encode("utf-8"), b""

        ok, text, words = suite.tesseract_ocr(_tiny_png(), runner=fake, psm=6,
                                              exe="tess.exe", tessdata_prefix="/td")
        self.assertTrue(ok)
        self.assertIn("显示为", text)
        self.assertEqual([w["text"] for w in words], ["显示为", "52", "设置"])
        self.assertEqual(seen["argv"][0], "tess.exe")
        self.assertEqual(seen["argv"][1].lower().endswith(".png"), True)   # 临时 png 喂子进程
        self.assertIn("--psm", seen["argv"])
        self.assertEqual(seen["argv"][seen["argv"].index("-l") + 1], suite.TESS_LANGS)
        self.assertEqual(seen["env"]["TESSDATA_PREFIX"], "/td")

    def test_假runner失败如实记坏(self):
        def fake(_argv, _env):
            return 1, b"", b"read_params_file: Can't open psm"

        ok, err, words = suite.tesseract_ocr(_tiny_png(), runner=fake,
                                             exe="tess.exe", tessdata_prefix="/td")
        self.assertFalse(ok)
        self.assertIn("Can't open psm", err)
        self.assertEqual(words, [])

    def test_未安装臂跳过不硬炸(self):
        with mock.patch.object(suite, "find_tesseract", return_value=None):
            ok, err, words = suite.tesseract_ocr(_tiny_png())
        self.assertFalse(ok)
        self.assertIn("未安装", err)
        self.assertEqual(words, [])

    def test_臂结果走同一统计口径(self):
        # tesseract_ocr 的产出直接喂 run_case：命中/漏认/丢弃率记账与 WinRT 臂同构
        png = _tiny_png()

        def fake(_argv, _env):
            return 0, "0 1 2 3 4 5 6 7 8 9 52 CE".encode("utf-8"), b""

        def ocr(p):
            return suite.tesseract_ocr(p, runner=fake, psm=6, exe="tess.exe", tessdata_prefix="/td")

        case = {"id": "t", "cls": suite.CLS_DIGITS, "expect": ["5", "52", "CE"], "digits": ["5"]}
        r = suite.run_case(case, png, ocr)
        self.assertEqual(r["hits"], ["5", "52", "CE"])
        self.assertEqual(r["digit_dropped"], [])

    def test_对照表双臂并排与分别判定(self):
        def mk(hits, misses):
            return [{"id": "c1", "cls": suite.CLS_CJK, "note": "", "expect": hits + misses,
                     "hits": hits, "misses": misses, "rescued": [], "invert_used": False,
                     "ocr_ok": True, "word_count": 1, "digits": [], "digit_dropped": []}]

        win = mk(["a"] * 9, ["b"])          # 9/10 达标
        tess = mk(["a"], ["b"] * 9)         # 1/10 超门槛
        s1, j1 = suite.summarize(win), None
        j1 = suite.judge(s1)
        s2 = suite.summarize(tess)
        j2 = suite.judge(s2)
        text = suite.format_report(win, s1, j1, tess=(tess, s2, j2))
        self.assertIn("双臂对照", text)
        self.assertIn("WinRT 臂门禁判定", text)
        self.assertIn("Tesseract 臂门禁判定", text)
        self.assertIn("90.0%", text)
        self.assertIn("10.0%", text)
        self.assertIn("Tesseract 臂）", text)      # 双臂时附 Tesseract 明细节
        # 退出码语义不变：只看主臂（WinRT）判定；Tesseract 臂只做对照不影响退出码
        self.assertEqual(suite.exit_code_of(j1), 0)
        self.assertEqual(suite.exit_code_of(j2), 1)

    def test_无tesseract臂报告退化为单臂(self):
        results = [{"id": "c1", "cls": suite.CLS_CJK, "note": "", "expect": ["a"], "hits": ["a"],
                    "misses": [], "rescued": [], "invert_used": False, "ocr_ok": True,
                    "word_count": 1, "digits": [], "digit_dropped": []}]
        s = suite.summarize(results)
        text = suite.format_report(results, s, suite.judge(s), tess=None)
        self.assertNotIn("双臂对照", text)
        self.assertNotIn("Tesseract 臂门禁判定", text)


class Report(unittest.TestCase):
    def test_报告含判定与门槛(self):
        results = [{"id": "c1", "cls": suite.CLS_CJK, "note": "", "expect": ["a"], "hits": ["a"],
                    "misses": [], "rescued": [], "invert_used": False, "ocr_ok": True,
                    "word_count": 1, "digits": [], "digit_dropped": []}]
        s = suite.summarize(results)
        j = suite.judge(s)
        text = suite.format_report(results, s, j)
        self.assertIn("判定", text)
        self.assertIn("85%", text)
        self.assertIn("c1", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
