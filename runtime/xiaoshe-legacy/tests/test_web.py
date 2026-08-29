"""P4 · M5 Web 工具：web_fetch（抓网页→正文）+ web_search（搜索→结果表）。纯标准库 + 系统 curl。TDD 红→绿。

网页内容 = 不可信外部数据 → 走污点管道（同 MCP/OCR）。SSRF 硬护栏：只放行公网 http(s)，拒 file://、localhost、
内网/云元数据 IP。大页落盘走 vision spill 供 recall。可注入 runner/fetcher 离线 TDD。
运行：仓库根 `python -m unittest tests.test_web -v`
"""
import unittest
from unittest import mock

from harness import permission, web
from harness import tools as tools_mod

# 假 resolver：公网 IP，免真发 DNS（getaddrinfo 条目形状）
_公网resolver = lambda host: [(2, 1, 6, "", ("93.184.216.34", 0))]


class html转文本(unittest.TestCase):
    def test_剥script_style_保留正文(self):
        html = ("<html><head><style>a{color:red}</style></head><body>"
                "<h1>标题</h1><p>正文一</p><script>evil()</script><p>正文二</p></body></html>")
        txt = web.html_to_text(html)
        self.assertIn("标题", txt)
        self.assertIn("正文一", txt)
        self.assertIn("正文二", txt)
        self.assertNotIn("evil", txt)         # script 内容剥掉
        self.assertNotIn("color:red", txt)    # style 内容剥掉

    def test_解实体保留文本(self):
        self.assertIn("A&B", web.html_to_text("<p>A&amp;B</p>"))


class url安全(unittest.TestCase):
    def test_放行公网http_s(self):
        self.assertTrue(web.is_safe_url("https://example.com/x"))
        self.assertTrue(web.is_safe_url("http://news.example.org"))

    def test_拒非http协议(self):
        for u in ("file:///etc/passwd", "ftp://x/y", "gopher://x", "data:text/html,x", ""):
            self.assertFalse(web.is_safe_url(u), u)

    def test_拒localhost内网元数据IP(self):
        for u in ("http://localhost/x", "http://127.0.0.1", "http://169.254.169.254/latest/meta-data",
                  "http://10.0.0.1", "http://192.168.1.1", "http://172.16.0.9", "http://[::1]/",
                  "http://foo.local/x"):
            self.assertFalse(web.is_safe_url(u), u)

    def test_拒非常规IP编码_curl会解析到内网(self):
        # curl(inet_aton) 把这些非点分数字形式解析成内网/元数据，但 ipaddress 不认→曾被当域名放行(SSRF HIGH)
        for u in ("http://2130706433/",          # 十进制 = 127.0.0.1
                  "http://2852039166/latest",     # 十进制 = 169.254.169.254（云元数据）
                  "http://0x7f000001/",           # hex = 127.0.0.1
                  "http://0177.0.0.1/",           # 八进制 = 127.0.0.1
                  "http://127.1/",                # 短式 = 127.0.0.1
                  "http://0/"):                   # = 0.0.0.0
            self.assertFalse(web.is_safe_url(u), u)

    def test_拒host含glob元字符(self):
        # http://{169.254.169.254}/ urlparse 当域名放行、curl 会展开 {} 连内网 → host 非法字符一律拒
        self.assertFalse(web.is_safe_url("http://{169.254.169.254}/latest"))

    def test_放行公网数字IP(self):
        self.assertTrue(web.is_safe_url("http://8.8.8.8/"))          # 公网 IP 仍放行
        self.assertTrue(web.is_safe_url("http://134744072/"))        # 8.8.8.8 的十进制=公网，放行

    def test_curl禁用glob(self):
        self.assertIn("-g", web._curl_argv("https://x.com", 100, 5))   # -g/--globoff 防 {} 绕过


class 抓取(unittest.TestCase):
    def test_注入runner返回正文(self):
        ok, body = web.fetch("https://example.com", runner=lambda argv: (0, "<p>hi there</p>", ""),
                             resolver=_公网resolver)
        self.assertTrue(ok)
        self.assertIn("hi there", body)

    def test_不安全url不真抓(self):
        called = {}
        ok, _ = web.fetch("http://127.0.0.1", runner=lambda a: called.setdefault("x", 1) or (0, "", ""))
        self.assertFalse(ok)
        self.assertNotIn("x", called)          # 压根没调 runner

    def test_curl非零退出判失败(self):
        ok, _ = web.fetch("https://example.com", runner=lambda a: (7, "", "conn refused"),
                          resolver=_公网resolver)
        self.assertFalse(ok)

    def test_真实curl接收本轮冻结的网络环境(self):
        completed = mock.Mock(returncode=0, stdout="<p>ok</p>" + web._REDIR_MARK, stderr="")
        guarded = {"HTTPS_PROXY": "http://127.0.0.1:1"}
        with mock.patch.object(web.subprocess, "run", return_value=completed) as run:
            ok, body = web.fetch("https://example.com", resolver=_公网resolver, env=guarded)
        self.assertTrue(ok)
        self.assertIn("ok", body)
        self.assertIs(run.call_args.kwargs["env"], guarded)

    def test_重定向继续沿用同一网络环境(self):
        guarded = {"HTTPS_PROXY": "http://127.0.0.1:1"}
        responses = [
            mock.Mock(returncode=0, stdout="stub" + web._REDIR_MARK + "https://final.example/", stderr=""),
            mock.Mock(returncode=0, stdout="<p>final</p>" + web._REDIR_MARK, stderr=""),
        ]
        with mock.patch.object(web.subprocess, "run", side_effect=responses) as run:
            ok, body = web.fetch("https://start.example", resolver=_公网resolver, env=guarded)
        self.assertTrue(ok)
        self.assertIn("final", body)
        self.assertEqual(2, run.call_count)
        self.assertTrue(all(call.kwargs["env"] is guarded for call in run.call_args_list))

    def test_重定向到内网被拒(self):
        # 不用 curl -L 自动跟；Python 层拿到重定向目标复校验 is_safe_url，指向内网就拒（防重定向 SSRF）
        out = "moved stub" + web._REDIR_MARK + "http://169.254.169.254/latest"
        ok, msg = web.fetch("https://safe.example", runner=lambda a: (0, out, ""),
                            resolver=_公网resolver)
        self.assertFalse(ok)
        self.assertIn("重定向", msg)

    def test_重定向到安全url跟随一跳(self):
        calls = []
        def runner(argv):
            calls.append(argv)
            if len(calls) == 1:
                return (0, "stub" + web._REDIR_MARK + "https://final.example/", "")
            return (0, "<p>final body</p>" + web._REDIR_MARK, "")   # 2xx：重定向标记为空
        ok, body = web.fetch("https://start.example", runner=runner, resolver=_公网resolver)
        self.assertTrue(ok)
        self.assertIn("final body", body)          # 跟到了终点
        self.assertNotIn(web._REDIR_MARK, body)    # 标记已剥掉、不混进正文
        self.assertEqual(len(calls), 2)            # 跟随了一跳


class 搜索(unittest.TestCase):
    # Mojeek 结果结构：外层 <a class="ob">（带 url span，须忽略）+ <h2><a class="title" href="直链">标题</a></h2> + <p class="s">摘要</p>
    MOJEEK = ('<ul class="results-standard">'
              '<li class="r1"><a href="https://example.com/page" class="ob"><p class="i">'
              '<span class="url">https://example.com</span></p></a>'
              '<h2><a class="title" href="https://example.com/page">结果标题一</a></h2>'
              '<p class="s">这是第一段摘要文本</p></li>'
              '<li class="r2"><a href="https://example.org/b" class="ob"></a>'
              '<h2><a class="title" href="https://example.org/b">结果二</a></h2>'
              '<p class="s">第二段摘要</p></li></ul>')

    def test_解析标题url摘要(self):
        res = web.search("查询词", fetcher=lambda url: (True, self.MOJEEK))
        self.assertEqual(len(res), 2)
        self.assertEqual(res[0]["title"], "结果标题一")     # 取的是 h2 里的 title 锚，不是外层 ob 链接
        self.assertEqual(res[0]["url"], "https://example.com/page")
        self.assertIn("第一段摘要", res[0]["snippet"])

    # 真机确认的当前结构：摘要含 <strong> 高亮，其内文本也须收进 snippet。锁定解析器吃真结构。
    MOJEEK_REAL = ('<li class="r1"><a href="https://www.python.org/downloads/" class="ob"><p class="i">'
                   '<span class="url">python.org</span></p></a>'
                   '<h2><a class="title" href="https://www.python.org/downloads/">Download Python | Python.org</a></h2>'
                   '<p class="s">This <strong>site</strong> hosts <strong>Python</strong>.</p></li>')

    def test_解析真实结构含strong高亮(self):
        res = web.search("x", fetcher=lambda url: (True, self.MOJEEK_REAL))
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["url"], "https://www.python.org/downloads/")
        self.assertIn("Download Python", res[0]["title"])
        self.assertIn("site", res[0]["snippet"])            # <strong> 内文本一并收进摘要
        self.assertIn("Python", res[0]["snippet"])

    def test_抓取失败回空(self):
        self.assertEqual(web.search("x", fetcher=lambda url: (False, "err")), [])


class web工具(unittest.TestCase):
    def test_web工具转发本轮冻结的网络环境(self):
        guarded = {"HTTPS_PROXY": "http://127.0.0.1:1"}
        ctx = {"session_id": "s", "_child_env": guarded}
        with mock.patch.object(web, "fetch", return_value=(True, "<p>ok</p>")) as fetch:
            tools_mod.execute("web_fetch", {"url": "https://example.com"}, ctx)
        self.assertIs(fetch.call_args.kwargs["env"], guarded)
        with mock.patch.object(web, "search", return_value=[]) as search:
            tools_mod.execute("web_search", {"query": "x"}, ctx)
        self.assertIs(search.call_args.kwargs["env"], guarded)

    def test_web_fetch转正文加不可信前缀且入污点(self):
        page = "<p>这是一段足够长的外部不可信网页正文内容用于验证污点记录是否生效必须超过三十二个字符</p>"
        ctx = {"session_id": "s", "_web_runner": lambda argv: (0, page, "")}
        with mock.patch.object(web, "_default_resolver", _公网resolver):   # tools 层注入不到 resolver，patch 默认解析器免真 DNS
            res = tools_mod.execute("web_fetch", {"url": "https://example.com"}, ctx)
        self.assertFalse(res.is_error)
        self.assertIn("外部", res.content)                         # 不可信前缀
        self.assertIn("网页正文内容", res.content)                  # 抽出了正文
        self.assertTrue(any("外部不可信网页正文" in t for t in ctx.get("_tainted", set())))  # 短页也入污点

    def test_web_fetch不安全url不抓(self):
        res = tools_mod.execute("web_fetch", {"url": "http://169.254.169.254/latest"}, {"session_id": "s"})
        self.assertIn("不安全", res.content)

    def test_web_search回结果表(self):
        ctx = {"_web_runner": lambda argv: (0, 搜索.MOJEEK, "")}
        with mock.patch.object(web, "_default_resolver", _公网resolver):
            res = tools_mod.execute("web_search", {"query": "查询词"}, ctx)
        self.assertIn("结果标题一", res.content)
        self.assertIn("example.com/page", res.content)

    def test_web_search结果url也入污点(self):
        # url 与 title/snippet 同源不可信（攻击者可在搜索引擎上架自家站控制它），须一并入污点，别留洗白缺口
        m = ('<li><h2><a class="title" href="https://attacker.example/一条足够长的攻击者可控不可信结果链接超过三十二个字符哦">T</a></h2>'
             '<p class="s">snip</p></li>')
        ctx = {"_web_runner": lambda a: (0, m, "")}
        with mock.patch.object(web, "_default_resolver", _公网resolver):
            tools_mod.execute("web_search", {"query": "x"}, ctx)
        self.assertTrue(any("attacker.example/一条足够长" in t for t in ctx.get("_tainted", set())))

    def test_注册且默认ask(self):
        for t in ("web_fetch", "web_search"):
            self.assertIn(t, tools_mod.REGISTRY)
        self.assertEqual(permission.check("web_fetch", {"url": "https://e.com"}).action, "ask")
        self.assertEqual(permission.check("web_search", {"query": "x"}).action, "ask")

    def test_不安全url权限层也硬拒(self):
        self.assertEqual(permission.check("web_fetch", {"url": "http://127.0.0.1/x"}).action, "deny")


if __name__ == "__main__":
    unittest.main(verbosity=2)
