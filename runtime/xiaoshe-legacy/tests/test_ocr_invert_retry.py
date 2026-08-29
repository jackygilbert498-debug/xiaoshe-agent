"""OCR 健壮性增强 · 反色补跑 + 小图双跑合并（白字深底/孤立字符漏识）。TDD 红→绿。

真机探针结论（2026-07-22，计算器真跑 Vision OCR 对比）：
- 显示屏白-on-深灰「0」原图稳定漏识（复现金标准旁证）；反色图 zh-Hans,en 认出字形但判成
  字母 O、反色图 ja 稳定判成真「0」；二值化各阈值全灭（不实现）。
- 数字键盘区原图有结果但仍漏字（漏 5/0/3/7）；反色补跑认出的集合与原图互补 → 双跑合并。
- 坐标不受反色影响（几何不变），合并去重用 viewport.merge_marks 的中心距思路、主跑优先。
重试成本：仅「主跑空结果」（look/整屏路径）或 dual=True（zoom 小图）时才多跑 1 次 Vision。
2026-07-23 追加：ja 补跑贡献的词含 CJK 统一表意文字时，用同一张反色图 + zh-Hans,en 第三跑确认
（治 ja 对白字深底中文的繁体/异体误判，真机探针：访达→訪汰、显示→盪示），每次调用至多 3 跑。
运行：仓库根 `python -m unittest tests.test_ocr_invert_retry -v`
"""
import base64
import os
import re
import sys
import unittest
from unittest import mock

from harness import imaging, observe, viewport
from harness import tools as tools_mod


def _word(text, x, y, w, h):
    return "WORD|" + base64.b64encode(text.encode("utf-8")).decode("ascii") + f"|{x}|{y}|{w}|{h}"


def _ok(text):
    return "OK|" + base64.b64encode(text.encode("utf-8")).decode("ascii")


def _ocr_out(*words):
    """words = [(text,x,y,w,h)...]；末行 OK 全文按词拼接（真假无所谓，测试不断言它）。"""
    return "\n".join(_word(*wd) for wd in words) + "\n" + _ok(" ".join(wd[0] for wd in words))


def seq_runner(items, record=None):
    """按调用序喂 (rc,out,err)；录 argv（验补跑语言参数/收到的图/临时文件路径）。"""
    q = list(items)

    def fake(argv):
        if record is not None:
            record.append(list(argv))
        return q.pop(0) if len(q) > 1 else q[0]
    return fake


def received_png(argv):
    """从 OCR 子进程 argv（Mac Swift / Win PS 两形态）解出临时 PNG 路径与字节。"""
    script = argv[-1]
    m = (re.search(r"FromBase64String\('([^']+)'\)", script)
         or re.search(r'Data\(base64Encoded: "([^"]+)"\)', script))
    assert m, f"OCR 脚本里应嵌 base64 路径：{script[:120]}"
    path = base64.b64decode(m.group(1)).decode("utf-8")
    with open(path, "rb") as f:
        return path, f.read()


def make_png(w=12, h=8, rgb=(200, 210, 220)):
    return imaging.encode_png(w, h, (bytes(rgb) + b"\xff") * (w * h))


class 空结果反色补跑(unittest.TestCase):
    def test_主跑有词且非dual_不补跑(self):
        rec = []
        r = seq_runner([(0, _ocr_out(("5", 10, 10, 20, 20)), "")], record=rec)
        ok, info, words = tools_mod._ocr_words_of_png(make_png(), r)
        self.assertTrue(ok)
        self.assertEqual([w["text"] for w in words], ["5"])
        self.assertEqual(len(rec), 1, "主跑有词且非 dual：不应多跑第二次 OCR")

    def test_主跑空结果_反色ja重试(self):
        rec = []
        r = seq_runner([(0, _ok(""), ""), (0, _ocr_out(("0", 10, 10, 20, 20)), "")], record=rec)
        ok, info, words = tools_mod._ocr_words_of_png(make_png(), r)
        self.assertTrue(ok)
        self.assertEqual([w["text"] for w in words], ["0"])
        self.assertEqual(len(rec), 2, "主跑空结果必须反色补跑一次")
        script = rec[1][-1]
        if sys.platform == "darwin":
            self.assertIn('recognitionLanguages = ["ja"]', script,
                          "补跑走 ja（真机探针：zh-Hans,en 把孤立「0」判成 O，ja 判成 0）")
        else:
            # Windows 侧 langs 按设计不透传（WinRT 引擎取用户配置语言，钉在 langs参数.test_windows路径语义不受langs影响）；
            # 平台无关语义已验：补跑确实多跑一次（len(rec)==2）且补跑词并入结果
            self.assertNotIn('"ja"', script, "langs 不得渗进 Windows 路径（WinRT 用用户配置语言）")

    def test_补跑收到的是反色图(self):
        got = []

        def r(argv):   # 临时文件用完即删，必须在调用进行中把字节捞出来
            _, raw = received_png(argv)
            got.append(raw)
            return (0, _ok(""), "")
        png = make_png()
        tools_mod._ocr_words_of_png(png, r)
        self.assertEqual(len(got), 2)
        w1, h1, px1 = imaging.decode_png(got[0])
        w2, h2, px2 = imaging.decode_png(got[1])
        self.assertEqual((w1, h1), (w2, h2), "反色几何不变（坐标才能并回原坐标系）")
        self.assertEqual(bytes(px1), bytes(imaging.decode_png(png)[2]))
        self.assertEqual(bytes(px2), bytes(imaging.invert(w1, h1, px1)),
                         "第二次调用收到的必须是第一次的反色图")

    def test_主跑空_补跑也空_如实回空(self):
        r = seq_runner([(0, _ok(""), ""), (0, _ok(""), "")])
        ok, info, words = tools_mod._ocr_words_of_png(make_png(), r)
        self.assertTrue(ok)
        self.assertEqual(words, [])

    def test_主跑失败_不补跑(self):
        rec = []
        r = seq_runner([(0, "ERR|swift 不在", "")], record=rec)
        ok, info, words = tools_mod._ocr_words_of_png(make_png(), r)
        self.assertFalse(ok)
        self.assertEqual(len(rec), 1, "主跑失败（引擎不可用）：补跑也会失败，不白跑")

    def test_补跑失败_回落主跑结果(self):
        r = seq_runner([(0, _ocr_out(("5", 10, 10, 20, 20)), ""), (0, "ERR|boom", "")])
        ok, info, words = tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertTrue(ok)
        self.assertEqual([w["text"] for w in words], ["5"])

    def test_非有效PNG_不炸不补跑(self):
        rec = []
        r = seq_runner([(0, _ocr_out(("5", 10, 10, 20, 20)), "")], record=rec)
        ok, info, words = tools_mod._ocr_words_of_png("这不是PNG".encode("utf-8"), r, dual=True)
        self.assertTrue(ok)
        self.assertEqual([w["text"] for w in words], ["5"])
        self.assertEqual(len(rec), 1, "反色预处理解不了码：原样回主跑结果，不补跑不炸")


class dual双跑合并(unittest.TestCase):
    def test_dual主跑有词也补跑(self):
        rec = []
        r = seq_runner([(0, _ocr_out(("5", 10, 10, 20, 20)), ""),
                        (0, _ocr_out(("7", 200, 200, 20, 20)), "")], record=rec)
        ok, _, words = tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertTrue(ok)
        self.assertEqual(len(rec), 2, "dual（zoom 小图）：治「原图有结果但仍漏字」，必须双跑")
        self.assertEqual(sorted(w["text"] for w in words), ["5", "7"])

    def test_近中心重复词去重_主跑优先(self):
        # 同位置词两跑都认出（显示屏 0 现场：主跑判 5 补跑判 O）→ 只留一个，label/框都取主跑
        r = seq_runner([(0, _ocr_out(("5", 100, 100, 20, 20)), ""),
                        (0, _ocr_out(("O", 102, 101, 20, 20)), "")])
        ok, _, words = tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertEqual(len(words), 1)
        self.assertEqual(words[0]["text"], "5")
        self.assertEqual((words[0]["x"], words[0]["y"], words[0]["w"], words[0]["h"]),
                         (100, 100, 20, 20), "合并坐标几何不变、取主跑框")

    def test_合并阈值恰好16不合并(self):
        # merge_marks 钉死的规则：中心距 < 16 才并（恰好 16 不并）——双跑合并复用同阈值
        r = seq_runner([(0, _ocr_out(("5", 0, 0, 10, 10)), ""),      # 中心 (5,5)
                        (0, _ocr_out(("7", 16, 0, 10, 10)), "")])    # 中心 (21,5)，距 16
        ok, _, words = tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertEqual(sorted(w["text"] for w in words), ["5", "7"])

    def test_补跑词坐标原样并入(self):
        r = seq_runner([(0, _ok(""), ""),
                        (0, _ocr_out(("0", 33, 44, 20, 20), ("7", 300, 300, 20, 20)), "")])
        ok, _, words = tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        got = {w["text"]: (w["x"], w["y"], w["w"], w["h"]) for w in words}
        self.assertEqual(got, {"0": (33, 44, 20, 20), "7": (300, 300, 20, 20)})


class CJK判定(unittest.TestCase):
    """第三跑确认只对「CJK 统一表意文字（汉字）」触发；假名/标点/全角符号不触发——
    ja 补跑对假名/标点的判断本就可靠，多跑一次 Vision（~0.4s）纯属白花。"""

    def test_简体繁体汉字算CJK(self):
        self.assertTrue(tools_mod._has_cjk_ideograph("访达"))
        self.assertTrue(tools_mod._has_cjk_ideograph("訪汰"))

    def test_扩展A与扩展B算CJK(self):
        self.assertTrue(tools_mod._has_cjk_ideograph("㐂"))            # U+3402 扩A
        self.assertTrue(tools_mod._has_cjk_ideograph("\U00020000"))    # U+20000 扩B

    def test_日文假名不算CJK(self):
        self.assertFalse(tools_mod._has_cjk_ideograph("ひらがな"))      # 平假名
        self.assertFalse(tools_mod._has_cjk_ideograph("カタカナ"))      # 片假名
        self.assertFalse(tools_mod._has_cjk_ideograph("ｶﾀｶﾅ"))         # 半角片假名

    def test_CJK标点与全角符号不算(self):
        self.assertFalse(tools_mod._has_cjk_ideograph("、。「」【】"))   # CJK 标点块
        self.assertFalse(tools_mod._has_cjk_ideograph("！＂＃％＆"))     # 全角符号块

    def test_混入一个汉字即触发(self):
        self.assertTrue(tools_mod._has_cjk_ideograph("12访3"))

    def test_空串与ASCII与None不触发不炸(self):
        self.assertFalse(tools_mod._has_cjk_ideograph(""))
        self.assertFalse(tools_mod._has_cjk_ideograph("abc 123"))
        self.assertFalse(tools_mod._has_cjk_ideograph(None))


class CJK误判第三跑确认(unittest.TestCase):
    """ja 补跑贡献的词含 CJK 表意文字 → 反色图 + zh-Hans,en 第三跑确认（治 ja 对白字深底
    中文的繁体/异体误判：探针见过 访达→訪汰）。同位（中心距 <16px）有词则替换文本、框保留
    补跑的；同位没词/第三跑失败 → 保留 ja 词（有词总比没词强）。每次调用至多 3 跑。"""

    def test_补跑CJK词_第三跑同位有词则替换文本框保留(self):
        rec = []
        r = seq_runner([(0, _ocr_out(("文件", 10, 10, 20, 20)), ""),     # 主跑 zh-Hans,en
                        (0, _ocr_out(("訪汰", 200, 200, 40, 20)), ""),    # 反色 ja 误判
                        (0, _ocr_out(("访达", 201, 200, 40, 20)), "")],   # 反色 zh-Hans,en 确认
                       record=rec)
        ok, _, words = tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertTrue(ok)
        self.assertEqual(len(rec), 3, "CJK 补跑词必须触发一次第三跑确认")
        got = {w["text"]: (w["x"], w["y"], w["w"], w["h"]) for w in words}
        self.assertIn("访达", got, "第三跑同位有词 → 用第三跑文本替换 ja 误判")
        self.assertNotIn("訪汰", got)
        self.assertEqual(got["访达"], (200, 200, 40, 20),
                         "只换文本：框保留补跑的（同一反色图几何，该框已过主跑去重，换掉可能引入重叠）")
        if sys.platform == "darwin":
            self.assertIn('recognitionLanguages = ["ja"]', rec[1][-1])
            self.assertIn('recognitionLanguages = ["zh-Hans", "en"]', rec[2][-1],
                          "第三跑回默认 zh-Hans,en（对简体最可靠）")

    def test_第三跑收到的是反色图(self):
        got = []
        outs = iter([(0, _ok(""), ""), (0, _ocr_out(("訪汰", 5, 5, 30, 20)), ""),
                     (0, _ocr_out(("访达", 5, 5, 30, 20)), "")])

        def r(argv):
            _, raw = received_png(argv)
            got.append(raw)
            return next(outs)
        tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertEqual(len(got), 3)
        w1, h1, px1 = imaging.decode_png(got[0])
        self.assertEqual(bytes(imaging.decode_png(got[2])[2]), bytes(imaging.invert(w1, h1, px1)),
                         "第三跑收到的必须是同一张反色图")

    def test_第三跑同位没词_保留ja词(self):
        r = seq_runner([(0, _ok(""), ""),
                        (0, _ocr_out(("訪汰", 200, 200, 40, 20)), ""),
                        (0, _ok(""), "")])    # 第三跑空
        ok, _, words = tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertEqual([w["text"] for w in words], ["訪汰"], "第三跑同位没词：保留 ja 词")

    def test_第三跑同位空文本词_保留ja词(self):
        """审查 MED-1：第三跑同位吐退化空文本词时，不许把好 ja 词换成空串。"""
        r = seq_runner([(0, _ok(""), ""),
                        (0, _ocr_out(("訪汰", 200, 200, 40, 20)), ""),
                        (0, _ocr_out(("", 201, 200, 40, 20)), "")])    # 第三跑同位空文本
        ok, _, words = tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertEqual([w["text"] for w in words], ["訪汰"],
                         "第三跑同位为空文本词：按「同位没词」语义保留 ja 词")

    def test_第三跑恰好16px不算同位(self):
        # 与 merge_marks 同阈值：中心距 <16 才算同位，恰好 16 不算
        r = seq_runner([(0, _ok(""), ""),
                        (0, _ocr_out(("訪汰", 0, 0, 10, 10)), ""),       # 中心 (5,5)
                        (0, _ocr_out(("访达", 16, 0, 10, 10)), "")])     # 中心 (21,5)，距 16
        ok, _, words = tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertEqual([w["text"] for w in words], ["訪汰"])

    def test_第三跑失败_保留ja词(self):
        rec = []
        r = seq_runner([(0, _ok(""), ""),
                        (0, _ocr_out(("訪汰", 200, 200, 40, 20)), ""),
                        (0, "ERR|boom", "")], record=rec)
        ok, _, words = tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertTrue(ok)
        self.assertEqual([w["text"] for w in words], ["訪汰"], "第三跑失败回落补跑结果，不炸")
        self.assertEqual(len(rec), 3)

    def test_假名补跑词不触发第三跑(self):
        rec = []
        r = seq_runner([(0, _ok(""), ""),
                        (0, _ocr_out(("カタカナ", 200, 200, 60, 20)), "")], record=rec)
        ok, _, words = tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertEqual([w["text"] for w in words], ["カタカナ"])
        self.assertEqual(len(rec), 2, "假名不算 CJK：ja 对假名判断可靠，不白跑第三跑")

    def test_主跑空文本词不得吸收ja误判_仍触发确认(self):
        # 红队 2026-07-23 真跑复现：主跑吐空文本词（Vision 退化候选/坏行解析产物）与 ja CJK 词
        # 同位时，merge_marks 的 label 回落（a["label"] or ocr label）让 ja 误判以 source="uia+ocr"
        # 混进合并结果——确认只认 source=="ocr"，误判就此绕过第三跑。空文本词不携带任何信息，
        # 进合并前两跑都滤掉，ja 词回到 source="ocr" 正常走确认。
        rec = []
        r = seq_runner([(0, _ocr_out(("", 100, 100, 40, 20)), ""),        # 主跑空文本词
                        (0, _ocr_out(("訪汰", 101, 100, 40, 20)), ""),     # 反色 ja 误判（同位）
                        (0, _ocr_out(("访达", 101, 100, 40, 20)), "")],    # 第三跑确认
                       record=rec)
        ok, _, words = tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertEqual([w["text"] for w in words], ["访达"],
                         "空文本主跑词不得把 ja 误判以 uia+ocr 身份带进结果、绕过确认")
        self.assertEqual(len(rec), 3, "ja CJK 词未被空词吸收 → 必须触发第三跑确认")

    def test_成本封顶_多CJK词只第三跑一次(self):
        rec = []
        r = seq_runner([(0, _ocr_out(("文件", 10, 10, 20, 20)), ""),
                        (0, _ocr_out(("訪汰", 200, 200, 40, 20), ("備忘", 400, 400, 40, 20)), ""),
                        (0, _ocr_out(("访达", 200, 200, 40, 20), ("备忘", 400, 400, 40, 20)), "")],
                       record=rec)
        ok, _, words = tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertEqual(len(rec), 3, "每次调用至多 3 跑（主+补+确认），多个 CJK 词也只确认一次")
        self.assertEqual(sorted(w["text"] for w in words), ["备忘", "文件", "访达"])

    def test_主跑已覆盖位置_不触发第三跑(self):
        # 主跑 zh-Hans,en 已认出的中文位置：ja 误判词被去重吸收（主跑优先）→ 无需确认
        rec = []
        r = seq_runner([(0, _ocr_out(("访达", 100, 100, 40, 20)), ""),
                        (0, _ocr_out(("訪汰", 101, 100, 40, 20)), "")], record=rec)
        ok, _, words = tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertEqual([w["text"] for w in words], ["访达"])
        self.assertEqual(len(rec), 2, "主跑覆盖位置的 ja 误判已被去重吸收，不该触发第三跑")

    def test_非dual空结果补跑_CJK同样确认(self):
        rec = []
        r = seq_runner([(0, _ok(""), ""),
                        (0, _ocr_out(("訪汰", 200, 200, 40, 20)), ""),
                        (0, _ocr_out(("访达", 201, 200, 40, 20)), "")], record=rec)
        ok, _, words = tools_mod._ocr_words_of_png(make_png(), r)    # 非 dual（look 空结果路径）
        self.assertEqual(len(rec), 3, "look 空结果补跑路径同样适用第三跑确认")
        self.assertEqual([w["text"] for w in words], ["访达"])


class 零残留红线(unittest.TestCase):
    def test_主跑补跑临时文件都用完即删(self):
        rec = []
        r = seq_runner([(0, _ok(""), ""), (0, _ocr_out(("0", 1, 2, 3, 4)), "")], record=rec)
        tools_mod._ocr_words_of_png(make_png(), r)
        self.assertEqual(len(rec), 2)
        paths = []
        for argv in rec:
            script = argv[-1]
            m = (re.search(r"FromBase64String\('([^']+)'\)", script)
                 or re.search(r'Data\(base64Encoded: "([^"]+)"\)', script))
            paths.append(base64.b64decode(m.group(1)).decode("utf-8"))
        for p in paths:
            self.assertFalse(os.path.exists(p), f"OCR 临时文件必须用完即删（零残留红线）：{p}")

    def test_补跑失败临时文件也不留(self):
        rec = []
        r = seq_runner([(0, _ok(""), ""), (1, "", "boom")], record=rec)
        ok, _, _ = tools_mod._ocr_words_of_png(make_png(), r)
        self.assertTrue(ok)   # 主跑 ok 空结果，补跑失败 → 仍回主跑（空）
        script = rec[1][-1]
        m = re.search(r'Data\(base64Encoded: "([^"]+)"\)', script) \
            or re.search(r"FromBase64String\('([^']+)'\)", script)
        self.assertFalse(os.path.exists(base64.b64decode(m.group(1)).decode("utf-8")))

    def test_第三跑临时文件也用完即删(self):
        rec = []
        r = seq_runner([(0, _ok(""), ""),
                        (0, _ocr_out(("訪汰", 200, 200, 40, 20)), ""),
                        (0, _ocr_out(("访达", 201, 200, 40, 20)), "")], record=rec)
        tools_mod._ocr_words_of_png(make_png(), r, dual=True)
        self.assertEqual(len(rec), 3)
        for argv in rec:
            script = argv[-1]
            m = (re.search(r"FromBase64String\('([^']+)'\)", script)
                 or re.search(r'Data\(base64Encoded: "([^"]+)"\)', script))
            p = base64.b64decode(m.group(1)).decode("utf-8")
            self.assertFalse(os.path.exists(p), f"第三跑临时文件也必须用完即删（零残留红线）：{p}")


class langs参数(unittest.TestCase):
    def test_mac脚本默认语言不变(self):
        s = observe._mac_ocr_swift("a.png")
        self.assertIn('recognitionLanguages = ["zh-Hans", "en"]', s)

    def test_mac脚本langs注入(self):
        s = observe._mac_ocr_swift("a.png", langs=("ja",))
        self.assertIn('recognitionLanguages = ["ja"]', s)
        self.assertIn("base64Encoded", s)   # 路径 base64 防注入不受影响

    def test_langs非法字符响亮拒(self):
        with self.assertRaises(ValueError):
            observe._mac_ocr_swift("a.png", langs=('ja"]; evil(); //',))

    def test_ocr_words透传langs(self):
        # langs 仅 Mac 侧生效（换 Vision 识别语言组）→ 固定 darwin 以在任何 OS 上确定验 mac 分支
        # （照 test_observe_tool.test_AX不可用_mac给辅助功能引导 先例；Win 侧语义另有 test_windows路径语义不受langs影响 钉着）
        rec = []
        observe.ocr_words("x.png", runner=seq_runner([(0, _ok(""), "")], record=rec),
                          plat="darwin", langs=("ja",))
        self.assertIn('recognitionLanguages = ["ja"]', rec[0][-1])

    def test_windows路径语义不受langs影响(self):
        rec = []
        ok, _, _ = observe.ocr_words("x.png", runner=seq_runner([(0, _ok(""), "")], record=rec),
                                     plat="win32", langs=("ja",))
        self.assertTrue(ok)
        self.assertEqual(rec[0][0], "powershell")
        self.assertIn("OcrEngine", rec[0][-1])
        self.assertNotIn('"ja"', rec[0][-1], "WinRT 用用户配置语言，langs 不得渗进 Windows 路径")


class look_zoom接线(unittest.TestCase):
    """look 保持「空才补跑」（整屏成本敏感）；zoom 小图走 dual 双跑合并（治有结果仍漏字）。"""

    def _ctx(self):
        png = make_png(80, 60)

        def shot(argv):
            for a in argv:
                m = re.search(r"[^'\"\s]+\.png", a)
                if m:
                    with open(m.group(0), "wb") as f:
                        f.write(png)
                    break
            return (0, "", "")
        return {"_ax_runner": lambda a: "",
                "_screencapture_runner": shot,
                "_screen_size_runner": lambda a: (0, "80,60\n", ""),
                "_sips_runner": lambda a: (1, "", "no sips"),
                # zoom 重 OCR 词数 <8 触发 VLM 直读兜底闸 → 不注入会真发 API（无代理每次 ~6s×2）。
                # 本类只断言 _ocr_words_of_png 的 dual 形态，不断言兜底文本 → 假 fn 离线化。
                "_vlm_read_fn": lambda png: "UNREADABLE"}

    def _spy(self, calls):
        def fake(png, runner, dual=False):
            calls.append(dual)
            return (True, "", [{"text": "5", "x": 4, "y": 4, "w": 20, "h": 20}])
        return fake

    def test_look不dual(self):
        calls = []
        with mock.patch.object(tools_mod, "_ocr_words_of_png", self._spy(calls)):
            tools_mod._look({}, self._ctx())
        self.assertEqual(calls, [False])

    def test_zoom走dual双跑(self):
        calls = []
        ctx = self._ctx()
        with mock.patch.object(tools_mod, "_ocr_words_of_png", self._spy(calls)), \
                mock.patch.object(imaging, "draw_marks", lambda p, m, **k: p):
            tools_mod._look({}, ctx)
            tools_mod._zoom({"viewport_id": "v1", "region": [0, 0, 40, 30], "k": 2}, ctx)
        self.assertEqual(calls, [False, True])


@unittest.skipUnless(sys.platform == "darwin", "macOS 真机冒烟")
class 真机冒烟(unittest.TestCase):
    def test_真截图dual双跑端到端(self):
        png, guide = observe.capture_screenshot(region=(0, 0, 800, 24))   # 主屏菜单栏（必有文字）
        if not png:
            self.skipTest(f"屏幕录制未授权：{guide[:60]}")
        ok, info, words = tools_mod._ocr_words_of_png(png, None, dual=True)   # 不注入 runner = 真 Vision
        self.assertTrue(ok, info)
        self.assertTrue(words, "菜单栏真 OCR 双跑合并后应有词框")


if __name__ == "__main__":
    unittest.main()
