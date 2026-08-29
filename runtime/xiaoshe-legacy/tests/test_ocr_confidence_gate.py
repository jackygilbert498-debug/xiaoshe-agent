"""§4.4.3 Mac OCR 置信度门控补跑（2026-07-24 视觉升级方案）。TDD 红→绿。

Mac Vision（VNRecognizeTextRequest）每个候选本带 confidence：行协议 WORD 行扩第 7 字段
（0~1 三位小数），`_ocr_words_of_png` 据此门控——主跑高置信（均值 ≥ 门）单跑放行，低置信/
空白才反色 ja 补跑，为高置信样本省约 2/3 补跑调用。门限是方案自承的拍脑袋值，集中在
tools._OCR_CONF_GATE 待 A/B 校准。

字节冻结：Windows WinRT 无 confidence 概念 → 6 字段行解析出的词**不带** confidence 键
（dict 形状不变），门控对无置信度信号一律回落现状行为（look 有词不补跑 / zoom dual 恒双跑）。
畸形/越界 confidence（恶意或坏输出）→ 不当信号、不崩、fail-soft 回现状。
离线 18 条注入假 runner 回放 Swift 输出（Windows 可跑）；macOS 真机验收 2 条 skipUnless(darwin)：
AppKit 渲染清晰大字/小字两图 → 计数 runner 真跑 Vision → 高置信调用=1 放行、低置信调用=2 补跑
且识别不降（2026-07-27 真机验收通过，输出见 macOS真机验收 类docstring）。
运行：仓库根 `py -3 -m unittest tests.test_ocr_confidence_gate -v`
"""
import base64
import os
import subprocess
import sys
import tempfile
import unittest

from harness import imaging, observe
from harness import tools as tools_mod


def _word(text, x, y, w, h, conf=None):
    line = "WORD|" + base64.b64encode(text.encode("utf-8")).decode("ascii") + f"|{x}|{y}|{w}|{h}"
    return line + (f"|{conf}" if conf is not None else "")


def _ok(text):
    return "OK|" + base64.b64encode(text.encode("utf-8")).decode("ascii")


def _ocr_out(*words):
    return "\n".join(words) + "\n" + _ok("x")


def seq_runner(items, record=None):
    q = list(items)

    def fake(argv):
        if record is not None:
            record.append(list(argv))
        return q.pop(0) if len(q) > 1 else q[0]
    return fake


def make_png(w=12, h=8):
    return imaging.encode_png(w, h, (b"\xc8\xd2\xdc\xff") * (w * h))


class 门限常量钉死(unittest.TestCase):
    def test_置信度门常量(self):
        self.assertEqual(tools_mod._OCR_CONF_GATE, 0.80,
                         "红队「阈值被静默改动」：门限钉值，改动必须连本测试一起改留痕")


class 行协议解析(unittest.TestCase):
    """observe._ocr_run：WORD 行 6 字段（WinRT，无 confidence）与 7 字段（Mac Vision）双兼容。"""

    def _parse(self, out):
        return observe.ocr_words("x.png", runner=seq_runner([(0, out, "")]), plat="darwin")

    def test_7字段带置信度解析进words(self):
        ok, _, words = self._parse(_ocr_out(_word("5", 10, 10, 20, 20, conf="0.930")))
        self.assertTrue(ok)
        self.assertEqual(words[0]["confidence"], 0.93)

    def test_6字段不带confidence键_Windows形状不变(self):
        ok, _, words = self._parse(_ocr_out(_word("5", 10, 10, 20, 20)))
        self.assertTrue(ok)
        self.assertNotIn("confidence", words[0],
                         "字节冻结：6 字段（WinRT）解析出的词不得多键，下游 dict 形状不变")

    def test_畸形confidence_不崩且不带键(self):
        for bad in ("abc", "1.5", "-0.1", "nan", "NaN", "inf", "1e999", ""):
            ok, _, words = self._parse(_ocr_out(_word("5", 10, 10, 20, 20, conf=bad)))
            self.assertTrue(ok, bad)
            self.assertEqual(len(words), 1, f"confidence 坏不该连累词本身：{bad!r}")
            self.assertEqual(words[0]["text"], "5")
            self.assertNotIn("confidence", words[0], f"畸形 confidence 不当信号：{bad!r}")

    def test_边界值0与1合法(self):
        for good in ("0", "0.0", "1", "1.0", "0.5"):
            _, _, words = self._parse(_ocr_out(_word("5", 10, 10, 20, 20, conf=good)))
            self.assertIn("confidence", words[0], good)

    def test_8字段行跳过不崩(self):
        out = ("WORD|" + base64.b64encode("evil".encode()).decode() + "|1|2|3|4|0.9|extra\n"
               + _word("5", 10, 10, 20, 20, conf="0.9") + "\n" + _ok("x"))
        ok, _, words = self._parse(out)
        self.assertTrue(ok)
        self.assertEqual([w["text"] for w in words], ["5"], "字段数不对的坏行整条跳过")


class Swift脚本发射(unittest.TestCase):
    def test_boxes模式发射confidence(self):
        s = observe._mac_ocr_swift("a.png", boxes=True)
        self.assertIn("cand.confidence", s)
        self.assertIn("%.3f", s, "confidence 以三位小数进 WORD 行第 7 字段")

    def test_文本模式不发射confidence(self):
        s = observe._mac_ocr_swift("a.png", boxes=False)
        self.assertNotIn("confidence", s)


class 置信度门控补跑(unittest.TestCase):
    """_ocr_words_of_png：高置信单跑放行；低置信/无信号按现状与新规分路。"""

    def test_高置信dual_单跑放行省补跑(self):
        rec = []
        r = seq_runner([(0, _ocr_out(_word("5", 10, 10, 20, 20, conf="0.95")), "")], record=rec)
        ok, _, words = tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertTrue(ok)
        self.assertEqual([w["text"] for w in words], ["5"])
        self.assertEqual(len(rec), 1, "§4.4.3：高置信单跑放行，zoom dual 也省掉反色 ja 补跑")

    def test_高置信非dual_单跑放行(self):
        rec = []
        r = seq_runner([(0, _ocr_out(_word("5", 10, 10, 20, 20, conf="0.99")), "")], record=rec)
        tools_mod._ocr_words_of_png(make_png(), r)
        self.assertEqual(len(rec), 1)

    def test_低置信dual_仍补跑(self):
        rec = []
        r = seq_runner([(0, _ocr_out(_word("5", 10, 10, 20, 20, conf="0.30")), ""),
                        (0, _ocr_out(_word("7", 200, 200, 20, 20, conf="0.90")), "")], record=rec)
        ok, _, words = tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertTrue(ok)
        self.assertEqual(len(rec), 2, "低置信不得放行，反色 ja 补跑兜底")
        self.assertEqual(sorted(w["text"] for w in words), ["5", "7"])

    def test_低置信非dual有词_触发补跑(self):
        # §4.4.3 新行为：look 路径补跑触发从「仅空白」扩展为「低置信或空白」
        rec = []
        r = seq_runner([(0, _ocr_out(_word("O", 10, 10, 20, 20, conf="0.20")), ""),
                        (0, _ocr_out(_word("0", 12, 10, 20, 20, conf="0.90")), "")], record=rec)
        ok, _, words = tools_mod._ocr_words_of_png(make_png(), r)
        self.assertTrue(ok)
        self.assertEqual(len(rec), 2, "主跑低置信：look 有词也要反色补跑")
        # 同位（中心距 <16）去重主跑优先：补跑词被吸收，label/框仍取主跑（合并规则不动）
        self.assertEqual([w["text"] for w in words], ["O"])

    def test_无置信度非dual有词_维持现状不补跑(self):
        # Windows WinRT 路径字节冻结：6 字段无 confidence → look 有词即回，行为一字节不动
        rec = []
        r = seq_runner([(0, _ocr_out(_word("5", 10, 10, 20, 20)), "")], record=rec)
        tools_mod._ocr_words_of_png(make_png(), r)
        self.assertEqual(len(rec), 1, "无置信度信号（WinRT）：look 有词不补跑（现状）")

    def test_无置信度dual_维持现状恒双跑(self):
        rec = []
        r = seq_runner([(0, _ocr_out(_word("5", 10, 10, 20, 20)), ""),
                        (0, _ocr_out(_word("7", 200, 200, 20, 20)), "")], record=rec)
        ok, _, words = tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertTrue(ok)
        self.assertEqual(len(rec), 2, "无置信度信号（WinRT）：zoom dual 恒双跑（现状）")
        self.assertEqual(sorted(w["text"] for w in words), ["5", "7"])

    def test_畸形confidence非dual_回落现状不补跑(self):
        rec = []
        r = seq_runner([(0, _ocr_out(_word("5", 10, 10, 20, 20, conf="abc")), "")], record=rec)
        tools_mod._ocr_words_of_png(make_png(), r)
        self.assertEqual(len(rec), 1, "confidence 解析不出=无信号，回落现状行为（fail-soft）")

    def test_部分词缺置信度_不判高置信(self):
        # 一词有 confidence 一词没有 → 信号不完整，绝不放行（fail-safe 方向：多补跑不少补跑）
        rec = []
        r = seq_runner([(0, _ocr_out(_word("5", 10, 10, 20, 20, conf="0.99"),
                                     _word("7", 200, 200, 20, 20)), ""),
                        (0, _ok(""), "")], record=rec)
        tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertEqual(len(rec), 2, "部分词缺 confidence：不得判高置信放行")

    def test_均值恰好等于门限_放行(self):
        rec = []
        r = seq_runner([(0, _ocr_out(_word("5", 10, 10, 20, 20, conf="0.80"),
                                     _word("7", 200, 200, 20, 20, conf="0.80")), "")], record=rec)
        tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertEqual(len(rec), 1, "均值 ≥ 门限即高置信（边界含等于）")

    def test_均值恰低于门限_补跑(self):
        rec = []
        r = seq_runner([(0, _ocr_out(_word("5", 10, 10, 20, 20, conf="0.79"),
                                     _word("7", 200, 200, 20, 20, conf="0.79")), ""),
                        (0, _ok(""), "")], record=rec)
        tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertEqual(len(rec), 2, "均值 < 门限：补跑")


# ---- E3 macOS 真机验收：真跑 Vision，计数 runner 统计 OCR 调用次数 ----
# 参数化渲染脚本（照 test_mac_ocr 的 AppKit 先例）：cfg = b64("输出路径|字号")，黑粗体白底画「小蛇42」。
# 真机探针（2026-07-27）：Vision 逐词 confidence 实测呈量化分布——清晰大字（120pt）稳定 1.0，
# 小字（≤24pt 或低对比）稳定 0.5；sips 缩糊再放大的图字形仍清晰，confidence 反而仍报 1.0，
# 故低置信场景用「直接渲染小字」构造而非缩糊。
_RENDER_GATE_SWIFT = """import AppKit
let pd = Data(base64Encoded: "%s")!
let cfg = String(data: pd, encoding: .utf8)!.split(separator: "|")
let out = String(cfg[0])
let fontSize = Double(cfg[1])!
let img = NSImage(size: NSSize(width: 800, height: 300))
img.lockFocus()
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: 800, height: 300).fill()
let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.boldSystemFont(ofSize: fontSize),
                                            .foregroundColor: NSColor.black]
NSAttributedString(string: "小蛇42", attributes: attrs).draw(at: NSPoint(x: 40, y: 140 - fontSize / 2))
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
"""


def _render_label_png(font_size):
    """AppKit 渲染「小蛇42」黑字白底 → PNG 字节（临时文件用完即删）。"""
    fd, tmp = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        cfg = base64.b64encode(f"{tmp}|{font_size}".encode("utf-8")).decode("ascii")
        subprocess.run(["/usr/bin/swift", "-e", _RENDER_GATE_SWIFT % cfg],
                       check=True, capture_output=True, timeout=120)   # 冷缓存首编可能 ~10s
        with open(tmp, "rb") as f:
            return f.read()
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _counting_runner(record):
    """计数 runner：记录每次 argv 后真分发子进程（照 observe._ocr_run 真跑路径）。"""

    def run(argv):
        record.append(list(argv))
        p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=60)
        return p.returncode, p.stdout, p.stderr
    return run


@unittest.skipUnless(sys.platform == "darwin" and os.path.exists("/usr/bin/swift"),
                     "仅 macOS 真机（swift 在）")
class macOS真机验收(unittest.TestCase):
    """E3 真机验收（2026-07-27 真跑 Vision 通过）：

    - 高置信（120pt 清晰大字，confidence 实测 1.0）：look 调用=1、zoom dual 调用=1——单跑放行，
      补跑全省（对照门控前：dual 恒 2 跑）。
    - 低置信（14pt 小字，confidence 实测 0.5 < 门 0.80）：look 调用=2（主跑 + 反色 ja 补跑），
      合并结果识别不降（主跑词全保留，补跑在空位补词）。
    """

    @classmethod
    def setUpClass(cls):
        cls.clear_png = _render_label_png(120)   # 高置信场景：清晰大字
        cls.small_png = _render_label_png(14)    # 低置信场景：小字

    def test_高置信单跑放行_look与dual都1次(self):
        for dual in (False, True):
            rec = []
            ok, text, words = tools_mod._ocr_words_of_png(self.clear_png, _counting_runner(rec),
                                                          dual=dual)
            self.assertTrue(ok, text)
            self.assertIn("小蛇42", text.replace(" ", ""))
            self.assertTrue(words, "清晰大字应识别出词")
            for w in words:   # 真机行协议第 7 字段：词必带 confidence 键
                self.assertIn("confidence", w, "Mac Vision 真跑 WORD 行应带第 7 字段 confidence")
            mean = sum(w["confidence"] for w in words) / len(words)
            self.assertGreaterEqual(mean, tools_mod._OCR_CONF_GATE,
                                    f"清晰大字均值 {mean} 应 ≥ 门（否则场景构造失效）")
            self.assertEqual(len(rec), 1,
                             f"dual={dual}：高置信单跑放行，OCR 调用应恰为 1 次（省补跑）")

    def test_低置信触发补跑_识别率不降(self):
        # 主跑单独先跑一次作识别率基线
        fd, tmp = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            with open(tmp, "wb") as f:
                f.write(self.small_png)
            ok0, _t0, main_words = observe.ocr_words(tmp)
        finally:
            os.unlink(tmp)
        self.assertTrue(ok0)
        self.assertTrue(main_words, "小字主跑应有词（空结果走的是空白补跑路径，非本验收点）")
        main_confs = [w.get("confidence") for w in main_words]
        if not all(isinstance(c, float) for c in main_confs) or \
                sum(main_confs) / len(main_confs) >= tools_mod._OCR_CONF_GATE:
            self.skipTest(f"本机 Vision 对小字图置信度未低于门（{main_confs}），低置信场景构造失效")
        rec = []
        ok, text, words = tools_mod._ocr_words_of_png(self.small_png, _counting_runner(rec))
        self.assertTrue(ok, text)
        self.assertGreaterEqual(len(rec), 2, "低置信不得放行：应触发反色 ja 补跑（调用 ≥2）")
        merged_texts = [w["text"] for w in words]
        for w in main_words:   # 识别率不降：主跑认出的词补跑合并后一个不少（去重主跑优先）
            self.assertIn(w["text"], merged_texts)
        self.assertIn("小蛇42", "".join(merged_texts).replace(" ", ""))
        print(f"\n===== E3 真机：低置信补跑 调用={len(rec)} 主跑={[(w['text'], w['confidence']) for w in main_words]}"
              f" 合并后={merged_texts} =====")


if __name__ == "__main__":
    unittest.main()
