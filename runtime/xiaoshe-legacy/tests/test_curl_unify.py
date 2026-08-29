"""传输统一 curl（外围排期项）收口测试：TDD 红→绿。

排查结论（harness/ 全部出网 HTTP 传输点）：kimi_client（API）与 web（抓取/搜索）均已走系统 curl；
本测试锁定统一后的口径——
- 代理串（可能含 user:pass@ 凭据）不进进程 argv：与 kimi_client 密钥同哲学，经 curl -K stdin 配置传入（curl_transport）。
- 两处共用同一套 -K 配置转义规则（escape_cfg）。
- web 抓取错误串脱敏 URL 内嵌凭据再回传（防 curl stderr 带出代理/URL 凭据）。
- curl argv 注入面：timeout/max_bytes 强制正常数（str 拼 argv，垃圾值不破坏 argv 结构）、有上限。
- 站岗守卫：harness/ 不得新增裸 HTTP 传输（urllib.request/http.client/requests/httpx 等）。
运行：仓库根 `py -3 -m unittest tests.test_curl_unify -v`
"""
import ast
import types
import unittest
from pathlib import Path
from unittest import mock

from harness import config, kimi_client, web

# 假 resolver：公网 IP，免真发 DNS（getaddrinfo 条目形状）
_公网resolver = lambda host: [(2, 1, 6, "", ("93.184.216.34", 0))]

_HARNESS = Path(web.__file__).resolve().parent


def _imports_of(path):
    """文件顶层绝对 import 的完整点分模块名（相对 import 跳过）。"""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield alias.name
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            yield node.module


# 裸 HTTP 传输黑名单（前缀匹配）。urllib.parse（纯解析）/ http.server（render.py 本机入站预览，非出网）不在列。
_BARE_HTTP = ("urllib.request", "http.client", "requests", "httpx", "aiohttp", "smtplib", "ftplib")


class 传输排查守卫(unittest.TestCase):
    def test_harness出网HTTP无裸传输(self):
        offenders = []
        for py in sorted(_HARNESS.glob("*.py")):
            for mod in _imports_of(py):
                for bad in _BARE_HTTP:
                    if mod == bad or mod.startswith(bad + "."):
                        offenders.append(f"{py.name}: {mod}")
        self.assertEqual(offenders, [], f"harness 出现裸 HTTP 传输（应统一走系统 curl）：{offenders}")

    def test_守卫本身能抓到违规(self):
        # 自检：喂一个临时"违规模块名清单"逻辑——直接用同规则判一段样例源码
        tree = ast.parse("import urllib.request\nimport http.client\nimport urllib.parse\nimport http.server")
        names = [a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names]
        hits = [m for m in names for bad in _BARE_HTTP if m == bad or m.startswith(bad + ".")]
        self.assertIn("urllib.request", hits)
        self.assertIn("http.client", hits)
        self.assertNotIn("urllib.parse", hits)   # 纯解析不是传输
        self.assertNotIn("http.server", hits)    # 本机入站服务不是出网传输


class 代理口径(unittest.TestCase):
    def test_代理不进argv(self):
        # 代理串可能含 user:pass@ 凭据——进 argv 会被本机进程列表窥见；与 kimi_client 密钥同哲学，只走 stdin 配置
        with mock.patch.object(config, "PROXY", "http://user:secret@127.0.0.1:7890"):
            argv = web._curl_argv("https://example.com/", 1000, 10)
        joined = " ".join(argv)
        self.assertNotIn("secret", joined)
        self.assertNotIn("7890", joined)
        self.assertNotIn("-x", argv)

    def test_代理在argv留K入口(self):
        # argv 只留 `-K -` 入口标记，代理本体经 stdin 配置传入（curl 语义与 -x 完全等价：均覆盖 env 代理变量）
        with mock.patch.object(config, "PROXY", "http://127.0.0.1:7890"):
            argv = web._curl_argv("https://example.com/", 1000, 10)
        self.assertIn("-K", argv)
        self.assertEqual(argv[argv.index("-K") + 1], "-")

    def test_无代理不留K入口(self):
        with mock.patch.object(config, "PROXY", ""):
            argv = web._curl_argv("https://example.com/", 1000, 10)
        self.assertNotIn("-K", argv)

    def test_代理stdin配置转义与kimi同规则(self):
        from harness import curl_transport
        tricky = 'http://u"\\x@h:1'
        with mock.patch.object(config, "PROXY", tricky):
            cfg = curl_transport.proxy_stdin_config()
        self.assertEqual(cfg, f'proxy = "{curl_transport.escape_cfg(tricky)}"\n')
        # 与 kimi_client 同一套转义（转义后双引号/反斜杠不破坏 -K 解析）
        self.assertEqual(kimi_client._escape_cfg(tricky), curl_transport.escape_cfg(tricky))
        self.assertNotIn('\nproxy', cfg.strip())   # 单行，无法注入额外配置行

    def test_无代理stdin配置为None(self):
        from harness import curl_transport
        with mock.patch.object(config, "PROXY", ""):
            self.assertIsNone(curl_transport.proxy_stdin_config())

    def test_explicit_proxy_overrides_legacy_global_default(self):
        """A resolved request proxy must not inherit another provider's global proxy."""
        from harness import curl_transport
        with mock.patch.object(config, "PROXY", "http://global.invalid:1"):
            cfg = curl_transport.proxy_stdin_config(
                proxy="http://resolved.invalid:2", proxy_env="TEST_PROXY")
        self.assertEqual(cfg, 'proxy = "http://resolved.invalid:2"\n')

    def test_代理含换行硬拒_防配置注入(self):
        # KIMI_PROXY 若含 \r\n（坏 env/手工塞入），单行配置会被撑成多行 → 可注入任意 curl 选项。硬拒，绝不静默放行。
        from harness import curl_transport
        for bad in ("http://h:1\nmax-time = 9999", "http://h:1\r\nx = 1"):
            with mock.patch.object(config, "PROXY", bad):
                with self.assertRaises(ValueError):
                    curl_transport.proxy_stdin_config()

    def test_控制字符代理错误指向活动提供商变量(self):
        from harness import curl_transport
        with mock.patch.object(config, "PROXY_ENV", "DEEPSEEK_PROXY", create=True), \
             mock.patch.object(config, "PROXY", "http://h:1\nmax-time = 9999"):
            with self.assertRaises(ValueError) as caught:
                curl_transport.proxy_stdin_config()
        message = str(caught.exception)
        self.assertIn("DEEPSEEK_PROXY", message)
        self.assertNotIn("KIMI_PROXY", message)

    def test_fetch收到含换行代理不崩_按失败返回(self):
        # web 层：坏代理配置 → fetch 不炸，按 (False, 原因) 返回（ValueError 走既有的抓取失败兜底）
        with mock.patch.object(config, "PROXY", "http://h:1\nmax-time = 9999"):
            ok, msg = web.fetch("https://example.com/", runner=lambda a: (0, "x", ""),
                                resolver=_公网resolver)
        self.assertFalse(ok)
        self.assertIn("代理", msg)

    def test_fetch真跑分支把代理喂stdin(self):
        # 不真发网：patch subprocess.run 抓取调用参数，验证 input=代理配置、argv 含 -K -
        seen = {}

        def fake_run(argv, **kw):
            seen["argv"] = argv
            seen["input"] = kw.get("input")
            return types.SimpleNamespace(returncode=0, stdout="<p>ok body</p>", stderr="")

        with mock.patch.object(config, "PROXY", "http://user:secret@127.0.0.1:7890"), \
             mock.patch.object(web.subprocess, "run", fake_run):
            ok, body = web.fetch("https://example.com/", resolver=_公网resolver)
        self.assertTrue(ok)
        self.assertIn("-K", seen["argv"])
        self.assertIn('proxy = "http://user:secret@127.0.0.1:7890"', seen["input"])
        self.assertNotIn("secret", " ".join(seen["argv"]))

    def test_kimi代理行走stdin配置且与web同一转义(self):
        from harness import curl_transport
        with mock.patch.object(config, "PROXY", 'http://u"\\x@h:1'):
            cfg = kimi_client._curl_config("p.json", 90, 5)
        self.assertIn(f'proxy = "{curl_transport.escape_cfg("http://u\"\\x@h:1")}"', cfg)


class 错误口径(unittest.TestCase):
    def test_stderr内嵌凭据脱敏(self):
        # curl 报错可能带出 URL/代理里的 user:pass@——回传给模型/日志前抹掉（对齐 kimi_client._scrub 哲学）
        err = "curl: (7) Failed to connect to http://user:secret@proxy.example:8080 after 3 ms"
        ok, msg = web.fetch("https://example.com/", runner=lambda a: (7, "", err),
                            resolver=_公网resolver)
        self.assertFalse(ok)
        self.assertNotIn("secret", msg)
        self.assertNotIn("user", msg.split("://")[1].split("@")[0])   # userinfo 整体抹掉
        self.assertIn("proxy.example", msg)                           # 排障信息（host）保留


class argv注入面(unittest.TestCase):
    def test_timeout体积强制正常数(self):
        # str 拼 argv：垃圾值（字符串/负数/0）不许破坏 argv 结构或生成非法 curl 参数
        argv = web._curl_argv("https://x.com/", "garbage", -5)
        t = argv[argv.index("--max-time") + 1]
        s = argv[argv.index("--max-filesize") + 1]
        self.assertTrue(t.isdigit() and int(t) >= 1)
        self.assertTrue(s.isdigit() and int(s) >= 1)

    def test_超时体积有上限(self):
        argv = web._curl_argv("https://x.com/", 10**15, 10**9)
        t = int(argv[argv.index("--max-time") + 1])
        s = int(argv[argv.index("--max-filesize") + 1])
        self.assertLessEqual(t, 300)            # 抓取超时上限（kimi API 走自己的 hard_timeout 口径，不混）
        self.assertLessEqual(s, 20_000_000)     # 抓取体积上限（Python 侧 body 截断之外的第二道）

    def test_fetch收到垃圾timeout也不崩(self):
        ok, _ = web.fetch("https://example.com/", runner=lambda a: (0, "x", ""),
                          timeout="garbage", resolver=_公网resolver)
        self.assertTrue(ok)

    def test_url仍是argv最后一参且glob关闭(self):
        # URL 只以独立 argv 元素传入（无 shell 拼接）；is_safe_url 已拒控制字符/glob 元字符（test_web 站岗），此处锁 argv 形状
        with mock.patch.object(config, "PROXY", ""):   # 隔离本机 .env 代理（有代理时 argv 尾部多 `-K -` 入口）
            argv = web._curl_argv("https://example.com/path?q=1", 1000, 10)
        self.assertEqual(argv[-1], "https://example.com/path?q=1")
        self.assertIn("-g", argv)


if __name__ == "__main__":
    unittest.main(verbosity=2)
