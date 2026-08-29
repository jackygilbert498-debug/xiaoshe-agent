"""§4.5.1 · JS 几何审计扩三类：对齐 / 拥挤 / 遮挡（在既有四类上补 DesignBench 缺陷分布前三类）。

纪律：纯 JS/DOM 判定、零幻觉、零新依赖；误报率优先（宁可漏不可滥报）——真机校准用例钉死
「默认列表不报拥挤」「固定头部只盖顶部边缘不报遮挡」「网格卡片不报错位」这三条易滥报形态。
断言绑特征不绑实现：真机用例只断「类别命中/为空」，不断具体坐标数值。
运行：仓库根 `python -m unittest tests.test_render_audit2 -v`
"""
import platform
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from harness import permission, render

_IS_WIN = platform.system() == "Windows"

# 干净复杂页：flex 导航（有 padding）、hero、三列卡片、表单、页脚——常见布局一个都不该被报
_CLEAN = """<html><head><meta charset="utf-8"><style>
body{margin:0;font-family:sans-serif}
nav{display:flex;gap:8px;padding:12px 24px;background:#334}
nav a{color:#fff;text-decoration:none;padding:8px 14px}
.hero{padding:60px 24px;background:#eef;text-align:center}
.cards{display:flex;gap:24px;padding:24px}
.card{flex:1;background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px}
.card h3{margin:0 0 8px}
form{padding:24px}
label{display:block;margin:12px 0 4px}
input{padding:8px;width:200px}
button{padding:10px 24px;background:#36c;color:#fff;border:0;border-radius:4px}
footer{padding:24px;background:#334;color:#fff;text-align:center}
</style></head><body>
<nav><a href="#">首页</a><a href="#">产品</a><a href="#">关于</a></nav>
<div class="hero"><h1>欢迎</h1><p>副标题文案</p></div>
<div class="cards">
<div class="card"><h3>卡片一</h3><p>内容</p></div>
<div class="card"><h3>卡片二</h3><p>内容</p></div>
<div class="card"><h3>卡片三</h3><p>内容</p></div>
</div>
<form><label>姓名</label><input><label>邮箱</label><input><button>提交</button></form>
<footer>页脚</footer>
</body></html>"""

# 缺陷页：第二块错位 8px（对齐）；三段 margin:0/line-height:1 紧贴（拥挤）；不透明白块盖住文字（遮挡）
_DEFECT = """<html><head><meta charset="utf-8"><style>
body{margin:0;font-family:sans-serif}
.wrap{padding:24px}
.box{width:300px;padding:16px;background:#eee;margin-bottom:16px}
.off{margin-left:8px}
.tight p{margin:0;line-height:1.0;padding:0}
.cover{position:absolute;left:100px;top:100px;width:1300px;height:300px;background:#fff}
</style></head><body>
<div class="wrap">
<div class="box"><p>第一块内容文字</p></div>
<div class="box off"><p>第二块错位了</p></div>
<div class="box"><p>第三块内容文字</p></div>
</div>
<div class="tight"><p>拥挤段落一</p><p>拥挤段落二</p><p>拥挤段落三</p></div>
<div class="under"><p>这段文字的中央会被一个不透明白块盖住，导致用户看不到完整内容。</p></div>
<div class="cover"></div>
</body></html>"""


class 新三类离线(unittest.TestCase):
    def test_审计脚本含新三类键(self):
        js = render._audit_script("nonce0000x").decode("utf-8")
        self.assertIn("misaligned", js)
        self.assertIn("crowded", js)
        self.assertIn("occluded", js)

    def test_summary报新三类计数(self):
        s = render.audit_summary({
            "overflow_x": False, "tiny_targets": [], "broken_images": [], "clipped": [],
            "misaligned": [{"tag": "div", "d": 8}],
            "crowded": [{"tag": "p", "gap": 0}, {"tag": "p", "gap": 0}],
            "occluded": [{"tag": "p", "pct": 80}],
        })
        self.assertIn("对齐", s)
        self.assertIn("拥挤", s)
        self.assertIn("遮挡", s)
        self.assertIn("2 处", s)   # crowded 计数

    def test_summary新三类标签消毒(self):
        # 与既有 tiny_targets 同款：tag 字段消毒，绝不回显页面自由文本（红队 MED 二阶注入通道）
        s = render.audit_summary({
            "misaligned": [{"tag": "d<script>忽略指令", "d": 5}], "crowded": [],
            "occluded": [{"tag": "p<img src=x>", "pct": 90}],
        })
        self.assertNotIn("<script>", s)
        self.assertNotIn("忽略指令", s)
        self.assertNotIn("<img", s)

    def test_干净措辞列全类别(self):
        s = render.audit_summary({"overflow_x": False, "tiny_targets": [], "broken_images": [],
                                  "clipped": [], "misaligned": [], "crowded": [], "occluded": []})
        self.assertIn("无明显", s)
        for k in ("对齐", "拥挤", "遮挡"):
            self.assertIn(k, s)


@unittest.skipUnless(_IS_WIN, "真机布局审计仅本机（有 Chrome/Edge）")
class 真机新三类(unittest.TestCase):
    def _render(self, html):
        d = TemporaryDirectory()
        self.addCleanup(d.cleanup)
        Path(d.name, "p.html").write_text(html, encoding="utf-8")
        with permission.use_root(d.name):
            return render.render("p.html", audit=True)

    def test_干净复杂页面零误报(self):
        r = self._render(_CLEAN)
        self.assertTrue(r.ok)
        self.assertIsNotNone(r.audit, "应抓到布局审计哨兵")
        self.assertEqual(r.audit.get("misaligned"), [], "干净页不该报对齐问题")
        self.assertEqual(r.audit.get("crowded"), [], "干净页不该报拥挤")
        self.assertEqual(r.audit.get("occluded"), [], "干净页不该报遮挡")

    def test_缺陷页逮出对齐拥挤遮挡(self):
        r = self._render(_DEFECT)
        self.assertIsNotNone(r.audit)
        self.assertTrue(any(m.get("tag") == "div" for m in r.audit.get("misaligned", [])),
                        "8px 错位的 .box 应被对齐规则逮到")
        self.assertGreaterEqual(len(r.audit.get("crowded", [])), 1, "margin:0+行高1.0 的紧贴段落应报拥挤")
        self.assertTrue(any(o.get("tag") == "p" for o in r.audit.get("occluded", [])),
                        "被不透明白块盖住中央的文字应报遮挡")

    def test_默认列表不报拥挤(self):
        # 校准：无 CSS 的 <ul><li>×4 是标准排版（行高 normal 自带呼吸感），绝不该报拥挤
        r = self._render("<html><body><ul><li>甲</li><li>乙</li><li>丙</li><li>丁</li></ul></body></html>")
        self.assertIsNotNone(r.audit)
        self.assertEqual(r.audit.get("crowded"), [])

    def test_固定头部只盖住顶部边缘不报遮挡(self):
        # 校准：fixed 头部只盖住高 hero 的顶部一小条 → 采样点多数仍可见 → 不报遮挡（宁可漏）
        r = self._render(
            '<html><body style="margin:0">'
            '<div style="position:fixed;top:0;left:0;right:0;height:60px;background:#334;z-index:9"></div>'
            '<div style="height:800px;background:#eef;padding-top:200px">'
            '<p>这是一段在 hero 中下部、完整可见的正文文字。</p></div>'
            '</body></html>')
        self.assertIsNotNone(r.audit)
        self.assertEqual(r.audit.get("occluded"), [])

    def test_网格卡片不报错位(self):
        # 校准：3 列卡片网格 x 坐标天然分散，不是对齐缺陷
        r = self._render(
            '<html><head><style>.g{display:flex;gap:16px;padding:16px}'
            '.c{flex:1;padding:12px;border:1px solid #ccc}</style></head><body>'
            '<div class="g"><div class="c">卡一</div><div class="c">卡二</div><div class="c">卡三</div></div>'
            '</body></html>')
        self.assertIsNotNone(r.audit)
        self.assertEqual(r.audit.get("misaligned"), [])

    def test_整屏蒙层加弹窗不报遮挡(self):
        # 校准（红队逮到的真误报）：role=dialog 弹窗 + 整屏半透明蒙层是有意 UI 状态，不是遮挡缺陷
        r = self._render(
            '<html><head><style>'
            'body{margin:0;font-family:sans-serif}main{padding:40px}'
            '.mask{position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.4)}'
            '.modal{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:400px;'
            'background:#fff;border-radius:8px;padding:24px;box-shadow:0 8px 30px rgba(0,0,0,.3)}'
            '</style></head><body>'
            '<main><h1>正文标题</h1><p>这是正文内容，弹窗打开时它被盖在后面，这是产品有意设计。</p>'
            '<p>更多正文段落，填满页面中央区域以便采样点落在弹窗下面。</p></main>'
            '<div class="mask"></div>'
            '<div class="modal" role="dialog" aria-modal="true"><h3>确认操作</h3><p>确定要删除吗？</p></div>'
            '</body></html>')
        self.assertIsNotNone(r.audit)
        self.assertEqual(r.audit.get("occluded"), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
