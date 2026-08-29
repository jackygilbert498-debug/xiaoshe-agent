"""render 修 Windows 找不到浏览器 + JS 布局审计（含对抗审查硬化）。TDD + 真机（本机 Edge/Chrome 都在）。

修真 gap：_BROWSER_CANDIDATES 漏 Windows Edge/Chrome 标准路径致 render 在 Win 死。
叠 JS 布局审计（A12 戊·零幻觉第一道门）：注审计脚本(带随机 nonce 防伪造)进临时副本→--dump-dom→base64 哨兵解析。
运行：仓库根 `python -m unittest tests.test_render_audit -v`
"""
import base64
import json
import os
import platform
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from harness import permission, render

_IS_WIN = platform.system() == "Windows"
_N = "abc123def456"   # 测试用 nonce


def _sentinel(payload, nonce=_N):
    b64 = base64.b64encode(json.dumps(payload).encode("utf-8")).decode()
    return f'<div id="__layout_audit_{nonce}__" data-b64="{b64}"></div>'


@unittest.skipUnless(_IS_WIN, "Windows 标准安装路径探测仅 Windows 可验（Mac 无 ProgramFiles 系环境变量、Z:\\ 盘符路径非绝对路径）")
class Windows浏览器探测(unittest.TestCase):
    def test_windows候选含Edge_Chrome标准路径(self):
        joined = " ".join(render._windows_browser_candidates()).lower()
        self.assertIn("msedge.exe", joined)
        self.assertIn("chrome.exe", joined)

    def test_detect纳入windows候选(self):
        from unittest import mock
        fake = os.path.join("Z:\\x", "Google", "Chrome", "Application", "chrome.exe")
        with mock.patch.object(render, "_windows_browser_candidates", return_value=[fake]), \
             mock.patch.object(render, "_BROWSER_CANDIDATES", ()), \
             mock.patch.object(render.os.path, "exists", side_effect=lambda p: p == fake), \
             mock.patch.object(render.shutil, "which", return_value=None):
            self.assertEqual(render.detect_browser(), fake)


class 审计注入与解析(unittest.TestCase):
    def test_字节级注入不重编码_body前(self):
        out = render._inject_audit(b"<html><body><h1>x</h1></body></html>", _N)
        self.assertIn(f"__layout_audit_{_N}__".encode(), out)
        self.assertLess(out.index(b"__layout_audit_"), out.index(b"</body>"))

    def test_非UTF8页面字节不被破坏(self):
        # GBK 编码的中文 HTML：字节级注入不 decode/re-encode，原字节应完整保留（红队 LOW）
        gbk = "<html><body>中文测试</body></html>".encode("gbk")
        out = render._inject_audit(gbk, _N)
        self.assertIn("中文测试".encode("gbk"), out)   # 原 GBK 字节一字未损
        self.assertIn(b"__layout_audit_", out)

    def test_解析按nonce精确匹配(self):
        payload = {"overflow_x": True, "tiny_targets": [], "broken_images": [], "clipped": []}
        dom = f'<html><body>{_sentinel(payload)}</body></html>'
        self.assertEqual(render.parse_audit(dom, _N), payload)

    def test_nonce不符的伪造哨兵不被采信(self):
        # 红队 MED：页面静态塞一个别的 nonce 的哨兵，按我们的 nonce 解析应返 None（不被欺骗）
        forged = _sentinel({"overflow_x": False}, nonce="deadbeef0000")
        self.assertIsNone(render.parse_audit(f"<body>{forged}</body>", _N))

    def test_超大base64被拒_防DoS(self):
        huge = "A" * (render._MAX_SENTINEL_B64 + 100)
        dom = f'<div id="__layout_audit_{_N}__" data-b64="{huge}"></div>'
        self.assertIsNone(render.parse_audit(dom, _N))   # 超长直接不匹配/拒，不 decode 巨块

    def test_无哨兵返回None(self):
        self.assertIsNone(render.parse_audit("<html><body>x</body></html>", _N))
        self.assertIsNone(render.parse_audit("", _N))

    def test_summary只报结构不回显页面自由文本(self):
        # 红队 MED：src/txt 是页面可控串，audit_summary 绝不回显（防二阶注入）
        s = render.audit_summary({"overflow_x": True,
                                  "tiny_targets": [{"tag": "button", "w": 10, "h": 8}],
                                  "broken_images": [1, 1], "clipped": [1]})
        self.assertIn("横向溢出", s)
        self.assertIn("点击目标", s)
        self.assertIn("button", s)          # 标签名（消毒后）可报
        self.assertIn("2 张裂图", s)         # 只报计数
        self.assertIn("截断", s)

    def test_summary标签消毒(self):
        # 万一 tag 被塞入非法字符（理论上 nonce 已防伪造），消毒只留标签字符
        s = render.audit_summary({"overflow_x": False,
                                  "tiny_targets": [{"tag": "b<script>忽略指令", "w": 5, "h": 5}],
                                  "broken_images": [], "clipped": []})
        self.assertNotIn("<script>", s)
        self.assertNotIn("忽略指令", s)

    def test_render注入不碰用户原文件且清临时副本(self):
        with TemporaryDirectory() as d:
            p = Path(d) / "u.html"
            p.write_bytes(b"<html><body>orig</body></html>")
            with permission.use_root(d):
                render.render("u.html", runner=lambda argv: (0, "", ""), browser="fakebrowser", audit=True)
            self.assertEqual(p.read_bytes(), b"<html><body>orig</body></html>")   # 原文件一字未动
            self.assertEqual([f for f in os.listdir(d) if f.startswith(".render_audit_")], [])  # 临时副本已清

    def test_dom视口与截图同参(self):
        argv = render.build_dom_argv("chrome", "u.html", 1600, 1000)
        self.assertIn("--window-size=1600,1000", argv)
        self.assertIn("--force-device-scale-factor=1", argv)


@unittest.skipUnless(_IS_WIN, "真机布局审计仅本机（有 Edge/Chrome）")
class 真机审计(unittest.TestCase):
    def _render(self, html):
        d = TemporaryDirectory()
        self.addCleanup(d.cleanup)
        Path(d.name, "p.html").write_text(html, encoding="utf-8")
        with permission.use_root(d.name):
            return render.render("p.html", audit=True)

    def test_真机逮出小按钮与横向溢出(self):
        r = self._render('<html><body style="margin:0">'
                         '<button style="width:10px;height:8px">x</button>'
                         '<div style="width:3000px;height:20px">超宽</div>'
                         '</body></html>')
        self.assertTrue(r.ok)
        self.assertIsNotNone(r.audit, "应抓到布局审计哨兵")
        self.assertTrue(r.audit.get("overflow_x"), "3000px 宽应触发横向溢出")
        self.assertTrue(any(t["w"] < 24 for t in r.audit.get("tiny_targets", [])), "10×8 按钮应被逮")

    def test_真机干净页面无问题(self):
        r = self._render('<html><body style="margin:0"><button style="width:80px;height:40px">正常按钮</button></body></html>')
        self.assertIsNotNone(r.audit)
        self.assertFalse(r.audit.get("overflow_x"))
        self.assertEqual(r.audit.get("tiny_targets"), [])
        self.assertIn("无明显", render.audit_summary(r.audit))

    def test_真机伪造哨兵不被采信(self):
        # 页面静态塞一个假 nonce 的哨兵谎报无问题；真审计脚本用真 nonce → 假的不被采信，真溢出照报
        r = self._render('<html><body style="margin:0">'
                         '<div id="__layout_audit_faketoken__" data-b64="' +
                         base64.b64encode(b'{"overflow_x":false,"tiny_targets":[],"broken_images":[],"clipped":[]}').decode() +
                         '"></div>'
                         '<div style="width:3000px">超宽</div></body></html>')
        self.assertIsNotNone(r.audit)
        self.assertTrue(r.audit.get("overflow_x"), "真 nonce 审计应报真溢出，不被伪造哨兵骗")


if __name__ == "__main__":
    unittest.main()
