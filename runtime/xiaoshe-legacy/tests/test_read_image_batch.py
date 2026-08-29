"""P1-3 离线验收件：批量 read_image 图-名锚定（D3 T2/T3 失败场景离线复跑）。TDD 红→绿。

T2 实挂：一次 read_image 6 张，模型把蓝方认成红圆（图与文件对错号）。
T3 实挂：6 图同发自述「只显示了前两张」、编号对应搞糊涂。
本文件用 make_fixtures 既有生成器造同一批图，做两层断言：
- 消息装配断言：wire 尾部消息里每张 image_url 紧邻自己的标签，标签文件名与图像**字节级**对应
  （像素级张冠李戴在结构上不可能）；
- 假模型回放错序场景：假模型只看发给它的消息，按「标签文件名 + 像素分类」回报每张图，
  必须与 fixtures 真值一致；6 图同发时被截掉的图在提示里如实点名。
- read_image 结果文案：多图引导 + 图序自检模板 + 超上限如实警告。

不碰真 Kimi、不碰公网。运行：仓库根 `py -3 -m unittest tests.test_read_image_batch -v`
"""
import base64
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from evals.real_tasks import make_fixtures as fx
from evals.real_tasks import verifiers as vf
from harness import permission
from harness import tools as tools_mod
from harness import vision


def _read_all(paths, ctx):
    """模拟模型一批连续 read_image；返回最后一次的工具结果。"""
    res = None
    for p in paths:
        res = tools_mod.execute("read_image", {"path": p}, ctx)
        assert not res.is_error, res.content
    return res


def _wired_label_image_pairs(ctx, hist=None):
    """wire 后从尾部消息抽 (标签文本, 图像字节) 对；无紧邻标签 → 标签 None（旧结构会在此暴露）。"""
    out = vision.wire(hist or [{"role": "user", "content": "看图"}], ctx)
    content = out[-1]["content"]
    pairs = []
    for i, part in enumerate(content):
        if part.get("type") == "image_url":
            prev = content[i - 1] if i else {}
            label = prev.get("text") if prev.get("type") == "text" else None
            raw = base64.b64decode(part["image_url"]["url"].split(",", 1)[1])
            pairs.append((label, raw))
    return content, pairs


class 批量read_image离线验收(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.root = Path(self._d.name)
        self._vp = mock.patch.object(vision, "VISION_DIR", self.root / "v")
        self._rp = mock.patch.object(permission, "ROOT", self.root)
        self._vp.start()
        self._rp.start()

    def tearDown(self):
        self._vp.stop()
        self._rp.stop()
        self._d.cleanup()

    # ── read_image 结果文案（辅修 2/3） ─────────────────────────────

    def test_多图结果带引导与图序自检模板(self):
        fx.setup_t3(self.root)
        ctx = {"session_id": "s"}
        r1 = tools_mod.execute("read_image", {"path": "pool/a9f31.png"}, ctx)
        self.assertNotIn("自检", r1.content)                     # 单图不加噪
        r2 = tools_mod.execute("read_image", {"path": "pool/k2x87.png"}, ctx)
        self.assertIn("自检", r2.content)                        # 图序自检要求
        self.assertIn("img-N 我看到", r2.content)                # 一行模板
        self.assertIn("分小批", r2.content)                      # 精确配对建议分小批

    def test_超上限时结果如实警告(self):
        fx.setup_t3(self.root)
        ctx = {"session_id": "s"}
        res = _read_all([f"pool/{n}" for n in fx.T3_ALL[:3]], ctx)
        self.assertIn(f"最多附 {vision.VISION_LIVE_MAX} 张", res.content)
        self.assertIn("recall", res.content)

    # ── T2 场景：消息装配断言（主修 1） ─────────────────────────────

    def test_t2场景_标签文件名与图像字节级对应(self):
        """T2 同批图：每张图紧邻标签，标签里的文件名 = 图像真实来源（字节相等）。"""
        fx.setup_t2(self.root)
        ctx = {"session_id": "s"}
        _read_all(["A/yuan.png", "B/x7k2.png"], ctx)             # 红圆 A / 红圆 B（T2 被对错号的一对）
        _content, pairs = _wired_label_image_pairs(ctx)
        self.assertEqual(len(pairs), 2)
        for label, raw in pairs:
            self.assertIsNotNone(label, "图像前必须有紧邻标签（旧平铺结构在此挂）")
            name = re.search(r"〔(img-\d+)｜([^〕]+)〕", label or "")
            self.assertIsNotNone(name, f"标签格式不对：{label!r}")
            fname = name.group(2).strip()
            hits = list(self.root.rglob(fname))
            self.assertEqual(len(hits), 1, f"标签文件名 {fname} 在工作区不唯一/不存在")
            self.assertEqual(hits[0].read_bytes(), raw,          # ★ 字节级对应：张冠李戴结构上不可能
                             f"标签说 {fname}，图却是别的文件的字节")

    # ── T3 场景：假模型回放错序（6 图同发） ─────────────────────────

    def test_t3六图同发_假模型回放_配对不错乱(self):
        """假模型只看发给它的消息：按标签文件名+像素分类回报，必须等于 fixtures 真值；
        被 VISION_LIVE_MAX 截掉的图在总提示里如实点名（不撒谎）。"""
        fx.setup_t3(self.root)
        ctx = {"session_id": "s"}
        paths = [f"pool/{n}" for n in fx.T3_ALL]                 # 6 张同批读（T3 实跑姿态）
        last = _read_all(paths, ctx)
        content, pairs = _wired_label_image_pairs(ctx)

        # 假模型：只从「标签 + 像素」建立 文件名→颜色 映射（不靠自己脑补序号）
        truth = {n: "red" for n in fx.T3_TARGET}
        truth.update({n: c for n, (_s, c) in fx.T3_DECOYS.items()})
        report = {}
        for label, raw in pairs:
            self.assertIsNotNone(label, "无标签则假模型只能靠序号脑补——T2/T3 错序根因")
            m = re.search(r"〔(img-\d+)｜([^〕]+)〕", label or "")
            fname = m.group(2).strip()
            report[fname] = vf.classify(vf.avg_color(raw))       # 自检：img-N 我看到 <颜色>
        for fname, color in report.items():
            self.assertEqual(truth[fname], color, f"{fname} 图-名对错号")

        # 截断诚实：只附了最后 2 张，前面 4 张的 ref 在总提示里点名「未附上 + recall」
        self.assertEqual(len(pairs), vision.VISION_LIVE_MAX)
        attached = set(report)
        self.assertEqual(attached, set(fx.T3_ALL[-2:]))
        hint = content[0]["text"]
        for ref in ("img-1", "img-2", "img-3", "img-4"):
            self.assertIn(ref, hint)
        self.assertIn("recall", hint)
        # 工具结果侧也如实警告过（模型在两处都能看到「不是 6 张全到」）
        self.assertIn("最多附", last.content)

    def test_t3分小批读_全量配对正确(self):
        """按引导分小批（每批 ≤VISION_LIVE_MAX）：每批 wire 出去的消息都字节级对应。"""
        fx.setup_t3(self.root)
        ctx = {"session_id": "s"}
        names = list(fx.T3_ALL)
        for i in range(0, len(names), vision.VISION_LIVE_MAX):
            batch = names[i:i + vision.VISION_LIVE_MAX]
            _read_all([f"pool/{n}" for n in batch], ctx)
            _content, pairs = _wired_label_image_pairs(ctx)
            self.assertEqual(len(pairs), len(batch))
            for (label, raw), fname in zip(pairs, batch):
                self.assertIn(fname, label)
                self.assertEqual((self.root / "pool" / fname).read_bytes(), raw)


if __name__ == "__main__":
    unittest.main(verbosity=2)
