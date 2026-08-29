"""P3 v0.6b · 长文本溢出走同一 blob 库 + recall 翻页；截断收口到 execute。TDD 红→绿。

评委点名：_io.truncate 无 ctx、砍尾丢数据。改为收口到 execute（有 ctx）：超长输出**全文落 blob**、
回"头部预览+指针（含页数）"，模型可 recall(ref, page=n) 翻页取全文。无 session（单测/直调）回落纯截断
——是旧行为的安全超集、无数据丢失回归。read_file/长命令输出/大 MCP 输出全部受益。
运行：仓库根 `python -m unittest discover -s tests -v`
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import _io, permission
from harness import tools as tools_mod
from harness import vision


class 溢出收口(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self._p = mock.patch.object(vision, "VISION_DIR", Path(self._d.name))
        self._p.start()

    def tearDown(self):
        self._p.stop()
        self._d.cleanup()

    def test_短文本原样不动(self):
        self.assertEqual(vision.spill_or_truncate("短", {"session_id": "s"}), "短")

    def test_无session_回落纯截断_无数据丢失回归(self):
        big = "x" * (_io.MAX_TOOL_CHARS + 5000)
        out = vision.spill_or_truncate(big, {})           # 无 session_id
        self.assertIn("已截断", out)
        self.assertLessEqual(len(out), _io.MAX_TOOL_CHARS + 60)

    def test_有session_全文落blob_回预览加指针且可recall取全文(self):
        big = "".join(f"第{i}行内容。" for i in range(4000))  # 远超上限
        out = vision.spill_or_truncate(big, {"session_id": "s"})
        self.assertIn("txt-", out)
        self.assertIn("recall", out)
        self.assertLess(len(out), len(big))               # 只回预览
        # recall 该 txt ref 能翻页取回全文（拼起来覆盖原文）
        ref = out.split("txt-", 1)[1].split("｜")[0]
        ref = "txt-" + ref.split("\"")[0].strip()
        pages = []
        for pg in range(1, 20):
            chunk = vision.recall({"ref": ref, "page": pg}, {"session_id": "s"})
            pages.append(chunk)
            if "末页" in chunk:
                break
        joined = "".join(pages)
        self.assertIn("第0行内容", joined)
        self.assertIn("第3999行内容", joined)


class execute截断收口(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        root = Path(self._d.name)
        (root / "big.txt").write_text("y" * (_io.MAX_TOOL_CHARS + 8000), encoding="utf-8")
        self._vp = mock.patch.object(vision, "VISION_DIR", root / "v")
        self._rp = mock.patch.object(permission, "ROOT", root)
        self._vp.start()
        self._rp.start()
        self._root = root

    def tearDown(self):
        self._vp.stop()
        self._rp.stop()
        self._d.cleanup()

    def test_read_file超长_有session溢出成指针可recall(self):
        res = tools_mod.execute("read_file", {"path": "big.txt"}, {"session_id": "s"})
        self.assertFalse(res.is_error)
        self.assertIn("txt-", res.content)          # 溢出成指针而非砍尾
        self.assertIn("recall", res.content)

    def test_read_file超长_无session仍纯截断不炸(self):
        res = tools_mod.execute("read_file", {"path": "big.txt"}, {})
        self.assertIn("已截断", res.content)


if __name__ == "__main__":
    unittest.main(verbosity=2)
