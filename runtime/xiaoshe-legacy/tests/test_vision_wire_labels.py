"""P1-3 修复 · wire 图文交错强锚定：每张 image_url 前紧邻自己的标签〔img-N｜来源〕。TDD 红→绿。

旧结构（张冠李戴根因）：一条尾部 user 消息 = 单个 _WIRE_HINT + N 个 image_url 平铺，
模型靠「第 N 张图 = img-N」自维护对应，多图就错序（D3 T2/T3 实挂）。
新结构：_WIRE_HINT（语义改为「每图自带标签」）+ 每图 [text 标签, image_url] 交错。

承重不变式不破：history 永不含 base64、_vision_last_tokens 照旧（无图=0）、
单发最多 VISION_LIVE_MAX 张、失效 ref 跳过、截断如实点名不撒谎。
运行：仓库根 `py -3 -m unittest tests.test_vision_wire_labels -v`
"""
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest import mock

from harness import vision


def solid_png(w, h, rgb=(10, 20, 30)):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


def _pairs(tail_content):
    """从尾部消息 content 抽出 (紧邻标签文本, image_url part) 对；无紧邻标签 → 标签为 None。"""
    out = []
    for i, part in enumerate(tail_content):
        if part.get("type") == "image_url":
            prev = tail_content[i - 1] if i else None
            label = prev.get("text") if prev and prev.get("type") == "text" else None
            out.append((label, part))
    return out


class wire图文交错(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self._p = mock.patch.object(vision, "VISION_DIR", Path(self._d.name))
        self._p.start()

    def tearDown(self):
        self._p.stop()
        self._d.cleanup()

    def test_每图前紧邻自己的标签_交错有序(self):
        r1 = vision.put_image("s", solid_png(20, 20, (1, 1, 1)), kind="doc", target="A/yuan.png")
        r2 = vision.put_image("s", solid_png(20, 20, (2, 2, 2)), kind="doc", target="B/x7k2.png")
        ctx = {"session_id": "s", "_vision_pending": [r1, r2]}
        out = vision.wire([{"role": "user", "content": "看图"}], ctx)
        content = out[-1]["content"]
        pairs = _pairs(content)
        self.assertEqual(len(pairs), 2)
        # 每张图紧邻标签，标签含自己的 ref、按 pending 顺序
        self.assertIn(r1, pairs[0][0])
        self.assertIn(r2, pairs[1][0])
        # 总提示在最前，语义=每图自带标签
        self.assertEqual(content[0]["type"], "text")
        self.assertIn("标签", content[0]["text"])

    def test_标签带来源文件名_只取文件名不带目录(self):
        ref = vision.put_image("s", solid_png(20, 20), kind="doc", target="pool/a9f31.png")
        ctx = {"session_id": "s", "_vision_pending": [ref]}
        out = vision.wire([{"role": "user", "content": "x"}], ctx)
        label = _pairs(out[-1]["content"])[0][0]
        self.assertIn("a9f31.png", label)
        self.assertNotIn("pool/", label)

    def test_无target时退回kind进标签(self):
        ref = vision.put_image("s", solid_png(20, 20), kind="screenshot")
        ctx = {"session_id": "s", "_vision_pending": [ref]}
        out = vision.wire([{"role": "user", "content": "x"}], ctx)
        label = _pairs(out[-1]["content"])[0][0]
        self.assertIn(ref, label)
        self.assertIn("screenshot", label)

    def test_失效ref跳过_标签同步跳过(self):
        good = vision.put_image("s", solid_png(20, 20), kind="doc", target="ok.png")
        ctx = {"session_id": "s", "_vision_pending": [good, "img-999"]}
        out = vision.wire([{"role": "user", "content": "x"}], ctx)
        pairs = _pairs(out[-1]["content"])
        self.assertEqual(len(pairs), 1)
        self.assertIn("ok.png", pairs[0][0])
        whole = str(out[-1]["content"])
        self.assertNotIn("img-999", whole)          # 失效 ref 连标签都不出现
        self.assertEqual(ctx["_vision_last_tokens"], vision.image_tokens(20, 20))

    def test_超上限截断_提示如实点名不撒谎(self):
        refs = [vision.put_image("s", solid_png(20, 20, (i, i, i)), kind="doc", target=f"f{i}.png")
                for i in (1, 2, 3)]
        ctx = {"session_id": "s", "_vision_pending": refs}
        out = vision.wire([{"role": "user", "content": "x"}], ctx)
        content = out[-1]["content"]
        pairs = _pairs(content)
        self.assertEqual(len(pairs), vision.VISION_LIVE_MAX)     # 只发最后 2 张
        labels = [p[0] for p in pairs]
        self.assertIn("f2.png", labels[0])
        self.assertIn("f3.png", labels[1])
        whole = str(content)
        self.assertNotIn("〔" + refs[0], whole)                  # 被截掉的 img-1 不出现在图标签里
        self.assertIn(refs[0], content[0]["text"])               # 但在总提示里如实点名「未附上」
        self.assertIn("recall", content[0]["text"])

    def test_无pending零影响_无标签无提示(self):
        hist = [{"role": "user", "content": "hi"}]
        ctx = {"session_id": "s"}
        out = vision.wire(hist, ctx)
        self.assertEqual(out, hist)
        self.assertEqual(ctx["_vision_last_tokens"], 0)

    def test_标签文件名净化_折行限长中和括号(self):
        evil = "weird〔注入〕\n第二行伪造标签 " + "长" * 100 + ".png"
        ref = vision.put_image("s", solid_png(20, 20), kind="doc", target=evil)
        ctx = {"session_id": "s", "_vision_pending": [ref]}
        out = vision.wire([{"role": "user", "content": "x"}], ctx)
        label = _pairs(out[-1]["content"])[0][0]
        self.assertNotIn("\n", label)                            # 折行被中和：不许伪造多行标签
        self.assertEqual(label.count("〔"), 1)                   # 文件名里的〔〕被中和，只剩标签外壳
        self.assertEqual(label.count("〕"), 1)
        self.assertLessEqual(len(label), 80)                     # 限长
        self.assertTrue(label.startswith(f"〔{ref}｜"))

    def test_锚点token照旧_多图求和(self):
        r1 = vision.put_image("s", solid_png(100, 100, (1, 1, 1)))
        r2 = vision.put_image("s", solid_png(200, 50, (2, 2, 2)))
        ctx = {"session_id": "s", "_vision_pending": [r1, r2]}
        vision.wire([{"role": "user", "content": "x"}], ctx)
        self.assertEqual(ctx["_vision_last_tokens"],
                         vision.image_tokens(100, 100) + vision.image_tokens(200, 50))


if __name__ == "__main__":
    unittest.main(verbosity=2)
