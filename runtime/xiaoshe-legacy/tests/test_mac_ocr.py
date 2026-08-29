"""Mac OCR 引擎：/usr/bin/swift + Vision（VNRecognizeTextRequest）——P2「裁剪-重问」前置。TDD 红→绿。

对齐 Windows 行协议：boxes 模式每词一行 WORD|b64(词文本)|x|y|w|h（**图片像素、top-left 原点**坐标，
由 Vision 归一化 bottom-left 原点 boundingBox 换算）+ 末行 OK|b64(全文)；错误统一 ERR|...。
path 走 base64 嵌 Swift 脚本（防注入，同 Windows 侧 _ps_b64 先例）。发射上限 800 词（同 _OCR_PS_MAX_WORDS）。
真机测 skipUnless(darwin + /usr/bin/swift 在)：swift 渲染黑字白底图 → 真跑 Vision → 断言识别+词框在图内。
运行：仓库根 `python -m pytest tests/test_mac_ocr.py -v`
"""
import base64
import os
import re
import subprocess
import sys
import tempfile
import unittest

from harness import imaging, observe


def _word(text, x, y, w, h):
    return "WORD|" + base64.b64encode(text.encode("utf-8")).decode("ascii") + f"|{x}|{y}|{w}|{h}"


def _ok(text):
    return "OK|" + base64.b64encode(text.encode("utf-8")).decode("ascii")


class mac_ocr脚本生成(unittest.TestCase):
    def test_darwin走swift_Vision框架(self):
        seen = {}
        ok, txt = observe.ocr_image(
            "shot.png", runner=lambda a: (seen.update(argv=a), (0, _ok("小蛇"), ""))[1], plat="darwin")
        self.assertTrue(ok)
        self.assertEqual(txt, "小蛇")
        self.assertEqual(seen["argv"][0], "/usr/bin/swift")
        self.assertEqual(seen["argv"][1], "-e")
        script = seen["argv"][-1]
        self.assertIn("VNRecognizeTextRequest", script)
        self.assertIn("import Vision", script)
        self.assertIn(".accurate", script)
        self.assertIn("zh-Hans", script)

    def test_危险path走base64杜绝注入(self):
        evil = "x’);import Foundation;system(\"rm -rf ~\");#.png"
        s = observe._mac_ocr_swift(evil)
        self.assertNotIn("rm -rf", s)
        self.assertNotIn("system(", s.replace("system(\"rm -rf ~\")", ""))  # 原文不进脚本
        self.assertNotIn(evil, s)
        # b64 可解回原路径（无损往返）
        m = re.search(r'Data\(base64Encoded: "([A-Za-z0-9+/=]+)"\)', s)
        self.assertIsNotNone(m, "脚本里应嵌 base64 路径")
        self.assertEqual(base64.b64decode(m.group(1)).decode("utf-8"), evil)

    def test_boxes模式发射WORD且封顶800(self):
        s = observe._mac_ocr_swift("a.png", boxes=True)
        self.assertIn("WORD|", s)
        self.assertIn("800", s)                      # 发射上限对齐 _OCR_PS_MAX_WORDS
        self.assertIn("boundingBox", s)
        self.assertIn("1 - bb.maxY", s)              # bottom-left → top-left 原点换算

    def test_文本模式不发射WORD(self):
        s = observe._mac_ocr_swift("a.png", boxes=False)
        self.assertNotIn('print("WORD|', s)
        self.assertIn('print("OK|"', s)


class mac_ocr分发解析(unittest.TestCase):
    def test_WORD行解析进words(self):
        out = _word("小蛇", 147, 180, 800, 220) + "\n" + _word("42", 900, 180, 60, 220) + "\n" + _ok("小蛇 42")
        ok, txt, words = observe.ocr_words("x.png", runner=lambda a: (0, out, ""), plat="darwin")
        self.assertTrue(ok)
        self.assertEqual(txt, "小蛇 42")
        self.assertEqual(words, [{"text": "小蛇", "x": 147, "y": 180, "w": 800, "h": 220},
                                 {"text": "42", "x": 900, "y": 180, "w": 60, "h": 220}])

    def test_ERR行透传(self):
        ok, info, words = observe.ocr_words("x.png", runner=lambda a: (0, "ERR|图片文件不存在", ""), plat="darwin")
        self.assertFalse(ok)
        self.assertIn("图片文件不存在", info)
        self.assertEqual(words, [])

    def test_超400词截断(self):
        out = "\n".join(_word(f"w{i}", i, 0, 10, 10) for i in range(500)) + "\n" + _ok("x")
        ok, _, words = observe.ocr_words("x.png", runner=lambda a: (0, out, ""), plat="darwin")
        self.assertTrue(ok)
        self.assertEqual(len(words), observe._OCR_MAX_WORDS)   # 解析上限封顶

    def test_非零退出失败(self):
        ok, _, _ = observe.ocr_words("x.png", runner=lambda a: (1, "", "boom"), plat="darwin")
        self.assertFalse(ok)

    def test_linux无runner不支持_文案平台感知(self):
        ok, info, _ = observe.ocr_words("x.png", plat="linux")
        self.assertFalse(ok)
        self.assertIn("macOS", info)                  # 不再说「仅 Windows」
        self.assertNotIn("仅 Windows）", info)


# 真机渲染脚本：AppKit 黑粗体白底画文字 → PNG（draw_label 的 3×5 点阵数字 Vision 认不出，须真字体）
_RENDER_SWIFT = """import AppKit
let pd = Data(base64Encoded: "%s")!
let out = String(data: pd, encoding: .utf8)!
let img = NSImage(size: NSSize(width: 800, height: 300))
img.lockFocus()
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: 800, height: 300).fill()
let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.boldSystemFont(ofSize: 120),
                                            .foregroundColor: NSColor.black]
NSAttributedString(string: "小蛇42", attributes: attrs).draw(at: NSPoint(x: 80, y: 90))
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
"""


@unittest.skipUnless(sys.platform == "darwin" and os.path.exists("/usr/bin/swift"), "仅 macOS 真机（swift 在）")
class mac_ocr真机(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fd, cls.png = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        b64 = base64.b64encode(cls.png.encode("utf-8")).decode("ascii")
        subprocess.run(["/usr/bin/swift", "-e", _RENDER_SWIFT % b64],
                       check=True, capture_output=True, timeout=120)   # 冷模块缓存首编可能 ~10s
        with open(cls.png, "rb") as f:
            w, h, _ = imaging.decode_png(f.read())
        cls.size = (w, h)

    @classmethod
    def tearDownClass(cls):
        os.unlink(cls.png)

    def test_真跑Vision识别所画文字且词框在图内(self):
        ok, text, words = observe.ocr_words(self.png)   # 不注入 runner、不指定 plat → 真分发真跑
        self.assertTrue(ok, text)
        squashed = (text + "".join(w["text"] for w in words)).replace(" ", "")
        self.assertIn("小蛇", squashed)
        self.assertIn("42", squashed)
        self.assertTrue(words, "应至少识别出一个词框")
        W, H = self.size
        for w in words:
            self.assertGreaterEqual(w["x"], 0)
            self.assertGreaterEqual(w["y"], 0)
            self.assertGreater(w["w"], 0)
            self.assertGreater(w["h"], 0)
            self.assertLessEqual(w["x"] + w["w"], W + 1)   # 词框须在图内（±1 取整余量）
            self.assertLessEqual(w["y"] + w["h"], H + 1)

    def test_真跑纯文本模式(self):
        ok, text = observe.ocr_image(self.png)
        self.assertTrue(ok, text)
        self.assertIn("42", text.replace(" ", ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
