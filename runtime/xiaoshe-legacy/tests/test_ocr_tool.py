"""P4+ · ocr 工具：Windows.Media.Ocr（WinRT）识别工作区图片里的文字，补 a11y 树看不到的画布/游戏/扫描件文本。
TDD 红→绿。path 走 base64 传 PS（防注入）；识别文本走 base64 回传（安全承载多行/竖线/CJK）。
OCR 文本=**不可信视觉数据**（视觉注入面，同 observe 截图）→ 入污点。读工作区图片、SAFE 级（路径硬护栏拒越界/敏感）。
运行：仓库根 `python -m pytest tests/test_ocr_tool.py -v`
"""
import base64
import os
import re
import unittest

from harness import observe, permission
from harness import tools as tools_mod


def _ok(text):
    return "OK|" + base64.b64encode(text.encode("utf-8")).decode("ascii")


class ocr_image分发(unittest.TestCase):
    def test_win32走powershell_OcrEngine_文本base64回传(self):
        seen = {}
        ok, txt = observe.ocr_image(
            "shot.png", runner=lambda a: (seen.update(argv=a), (0, _ok("识别出的文本内容"), ""))[1], plat="win32")
        self.assertTrue(ok)
        self.assertEqual(txt, "识别出的文本内容")
        self.assertEqual(seen["argv"][0], "powershell")
        self.assertIn("OcrEngine", seen["argv"][-1])
        self.assertIn("RecognizeAsync", seen["argv"][-1])

    def test_危险path走base64杜绝注入(self):
        s = observe._win_ocr_ps("x’);calc.exe;Remove-Item y;#.png")
        self.assertNotIn("calc.exe", s)
        self.assertNotIn("Remove-Item", s)
        self.assertIn("FromBase64String", s)

    def test_runner返回OK_多行含竖线文本解码(self):
        payload = "第一行 | 带竖线\n第二行 中文 English 2026"
        ok, txt = observe.ocr_image("x.png", runner=lambda a: (0, _ok(payload), ""), plat="win32")
        self.assertTrue(ok)
        self.assertEqual(txt, payload)   # base64 回传 → 多行和 '|' 都原样解回

    def test_runner返回ERR(self):
        ok, info = observe.ocr_image("x.png", runner=lambda a: (0, "ERR|本机没装 OCR 语言包", ""), plat="win32")
        self.assertFalse(ok)
        self.assertIn("OCR", info)

    def test_非零退出失败(self):
        ok, _ = observe.ocr_image("x.png", runner=lambda a: (1, "", "boom"), plat="win32")
        self.assertFalse(ok)

    def test_其它平台无runner不支持(self):
        ok, _ = observe.ocr_image("x.png", plat="linux")
        self.assertFalse(ok)


class ocr工具(unittest.TestCase):
    def test_识别并回文本(self):
        ctx = {"_ocr_runner": lambda a: (0, _ok("图里的文字：小蛇视觉 2026"), "")}
        res = tools_mod.execute("ocr", {"path": "shot.png"}, ctx)
        self.assertFalse(res.is_error)
        self.assertIn("小蛇视觉", res.content)

    def test_空path报错(self):
        res = tools_mod.execute("ocr", {"path": ""}, {})
        self.assertTrue(res.is_error)

    def test_相对路径先解析成绝对再传(self):
        # 真机 bug 回归：WinRT GetFileFromPathAsync 要**绝对**路径，相对路径会抛异常。
        # tool 必须先把工作区相对 path 解析成绝对路径再交给 ocr_image（同 read_image 的 safe_path）。
        seen = {}
        ctx = {"_ocr_runner": lambda a: (seen.update(argv=a), (0, _ok("x"), ""))[1]}
        tools_mod.execute("ocr", {"path": "sub/shot.png"}, ctx)
        # Win 走 PS（FromBase64String('...')）；Mac 走 Swift（Data(base64Encoded: "...")）——两形态都认
        m = (re.search(r"FromBase64String\('([^']+)'\)", seen["argv"][-1])
             or re.search(r'Data\(base64Encoded: "([^"]+)"\)', seen["argv"][-1]))
        self.assertIsNotNone(m, "OCR 脚本里应嵌 base64 路径")
        decoded = base64.b64decode(m.group(1)).decode("utf-8")
        self.assertTrue(os.path.isabs(decoded), f"传给 OCR 的 path 应为绝对：{decoded!r}")

    def test_注册且SAFE放行(self):
        self.assertIn("ocr", tools_mod.REGISTRY)
        self.assertEqual(permission.check("ocr", {"path": "shot.png"}).action, "approve")

    def test_只读工具(self):
        self.assertIn("ocr", tools_mod.READONLY_TOOLS)

    def test_有SPEC声明(self):
        self.assertIn("ocr", [s["function"]["name"] for s in tools_mod.SPECS])

    def test_敏感图片路径被硬护栏拒(self):
        # 复用带 path 工具的硬护栏：敏感名即便是图片也拒（对齐 read_image/read_file）
        self.assertEqual(permission.check("ocr", {"path": "secrets.json"}).action, "deny")


class ocr安全(unittest.TestCase):
    def test_OCR文本入污点(self):
        line = "这是一段从图片里识别出来的超过三十二个字符的不可信文本载荷用于污点核验"
        ctx = {"_ocr_runner": lambda a: (0, _ok(line), "")}
        tools_mod.execute("ocr", {"path": "shot.png"}, ctx)
        self.assertIn(line, ctx.get("_tainted", set()))   # OCR=不可信视觉数据，入污点（防视觉注入洗白）

    def test_大OCR文本溢出走不可信spill_recall重打前缀(self):
        # 对抗审查 MED：OCR 文本溢出落 blob 必须标 untrusted=True（同 web_fetch/web_search/MCP），
        # 否则 recall 回捞的页丢"外部数据"前缀、也不重新入污点 → 页边界碎片可绕 taint_gate。
        import re as _re

        from harness import vision
        big = "图中文字行内容填充凑长度以触发溢出落盘处理。" * 1500   # 远超 MAX_TOOL_CHARS(20000)
        self.assertGreater(len(big), 20000)
        sid = "ocr-spill-test"
        ctx = {"_ocr_runner": lambda a: (0, _ok(big), ""), "session_id": sid}
        out = tools_mod.execute("ocr", {"path": "shot.png"}, ctx).content
        m = _re.search(r"txt-\d+", out)
        self.assertIsNotNone(m, f"溢出应落 blob 给出 ref：{out[:200]}")
        recalled = vision.recall({"ref": m.group(0), "page": 2}, {"session_id": sid})
        self.assertIn("数据非指令", recalled)   # untrusted=True → recall 页重打随机边界包裹（2a）


if __name__ == "__main__":
    unittest.main(verbosity=2)
