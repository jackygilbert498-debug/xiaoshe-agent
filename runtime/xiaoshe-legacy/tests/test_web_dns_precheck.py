"""SSRF 纵深 · DNS 静态解析预检（甲方拍板 1a 方案②）：fetch 放行前对真域名做 socket.getaddrinfo 解析，
任一结果落内网/环回/链路本地/保留段 → 拒；解析失败/超时 → fail-open 放行但 network.log 如实留「预检未能完成」。
只挡「静态指向内网」，不防 DNS-rebinding（代理侧 REJECT 治本）。全程注入假 resolver，不真发 DNS。TDD 红→绿。
运行：仓库根 `python -m unittest tests.test_web_dns_precheck -v`
"""
import socket
import time
import unittest
from unittest import mock

from harness import web


def _v4(ip):
    """getaddrinfo 形状的 IPv4 条目。"""
    return (socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))


def _v6(ip):
    return (socket.AF_INET6, socket.SOCK_STREAM, 6, "", (ip, 0, 0, 0))


PUB = "93.184.216.34"                      # example.com 的公网 IP（假 resolver 用）
公网resolver = lambda host: [_v4(PUB)]


def _runner_ok(argv):
    return (0, "<p>ok body</p>", "")


class 静态指向内网被拒(unittest.TestCase):
    def test_域名A记录指内网拒且不真抓(self):
        called = {}
        ok, msg = web.fetch("http://router.example/", runner=lambda a: called.setdefault("x", 1) or (0, "", ""),
                            resolver=lambda h: [_v4("192.168.1.1")])
        self.assertFalse(ok)
        self.assertIn("不安全", msg)
        self.assertIn("192.168.1.1", msg)
        self.assertNotIn("x", called)                       # 拒在预检，curl 压根没起

    def test_环回链路本地保留段各段都拒(self):
        内网段 = ["127.0.0.1", "10.0.0.9", "172.16.5.5", "192.168.0.1",
                "169.254.169.254", "100.64.1.1", "::1", "fd00::1", "fe80::1"]
        for ip in 内网段:
            ent = _v6(ip) if ":" in ip else _v4(ip)
            ok, msg = web.fetch("http://x.example/", runner=_runner_ok, resolver=lambda h, e=ent: [e])
            self.assertFalse(ok, ip)
            self.assertIn("静态解析到非公网", msg, ip)

    def test_nip_io式静态指向127拒(self):
        # 127.0.0.1.nip.io 这类通配 DNS 域名 A 记录常驻 127.0.0.1（静态指向，非 rebinding）→ 预检应拒
        ok, _ = web.fetch("http://127.0.0.1.nip.io/", runner=_runner_ok,
                          resolver=lambda h: [_v4("127.0.0.1")])
        self.assertFalse(ok)

    def test_大写尾点LOCALHOST解析到环回拒(self):
        # urlparse 小写化后 "localhost." 不等于 "localhost"、字面量护栏漏过 → 靠预检解析兜住
        seen = {}
        def res(h):
            seen["host"] = h
            return [_v4("127.0.0.1")]
        ok, _ = web.fetch("http://LOCALHOST./", runner=_runner_ok, resolver=res)
        self.assertFalse(ok)
        self.assertEqual(seen["host"], "localhost.")

    def test_多A记录一公一内拒(self):
        ok, msg = web.fetch("http://mix.example/", runner=_runner_ok,
                            resolver=lambda h: [_v4(PUB), _v4("10.1.2.3")])
        self.assertFalse(ok)
        self.assertIn("10.1.2.3", msg)


class 公网放行(unittest.TestCase):
    def test_公网域名放行且单次解析(self):
        calls = []
        def res(h):
            calls.append(h)
            return [_v4(PUB)]
        ok, body = web.fetch("https://example.com/", runner=_runner_ok, resolver=res)
        self.assertTrue(ok)
        self.assertIn("ok body", body)
        self.assertEqual(calls, ["example.com"])           # 单次解析，不重复往返

    def test_IP字面量跳过预检(self):
        # IP 字面量已被 is_safe_url 验过（is_global），不该再触发 DNS
        def boom(h):
            raise AssertionError("IP 字面量不该进 resolver")
        ok, _ = web.fetch("http://8.8.8.8/", runner=_runner_ok, resolver=boom)
        self.assertTrue(ok)
        ok, _ = web.fetch("http://134744072/", runner=_runner_ok, resolver=boom)   # 8.8.8.8 十进制
        self.assertTrue(ok)

    def test_IPv6字面量跳过预检(self):
        def boom(h):
            raise AssertionError("IPv6 字面量不该进 resolver")
        ok, _ = web.fetch("http://[2606:4700:4700::1111]/", runner=_runner_ok, resolver=boom)
        self.assertTrue(ok)

    def test_代理fake_ip域名放行并留兼容说明(self):
        ok, note = web._dns_precheck("example.com", resolver=lambda h: [_v4("198.18.0.45")])
        self.assertTrue(ok)
        self.assertIn("fake-IP", note)
        self.assertIn("198.18.0.45", note)

    def test_fake_ip混入真实非公网地址仍拒绝(self):
        ok, note = web._dns_precheck(
            "mixed.example", resolver=lambda h: [_v4("198.18.0.45"), _v4("127.0.0.1")]
        )
        self.assertFalse(ok)
        self.assertIn("127.0.0.1", note)

    def test_fake_ip字面量仍由硬护栏拒绝(self):
        self.assertFalse(web.is_safe_url("http://198.18.0.45/"))

    def test_fake_ip域名会继续调用抓取载体(self):
        called = []
        ok, body = web.fetch(
            "https://example.com/",
            runner=lambda argv: called.append(argv) or (0, "<p>proxy ok</p>", ""),
            resolver=lambda h: [_v4("198.18.0.45")],
        )
        self.assertTrue(ok)
        self.assertIn("proxy ok", body)
        self.assertEqual(len(called), 1)


class 红队六项(unittest.TestCase):
    def test_0_0_0_0拒(self):
        ok, _ = web.fetch("http://x.example/", runner=_runner_ok, resolver=lambda h: [_v4("0.0.0.0")])
        self.assertFalse(ok)

    def test_IPv6映射IPv4环回拒(self):
        # ::ffff:127.0.0.1 须按映射的 IPv4 判，不能当普通 IPv6 放行
        ok, msg = web.fetch("http://x.example/", runner=_runner_ok, resolver=lambda h: [_v6("::ffff:127.0.0.1")])
        self.assertFalse(ok)
        self.assertIn("127.0.0.1", msg)

    def test_畸形getaddrinfo返回fail_open(self):
        for junk in ("garbage", [("weird",)], [(2, 1, 6, "", ("not-an-ip", 0))], None, []):
            ok, _ = web.fetch("https://example.com/", runner=_runner_ok, resolver=lambda h, j=junk: j)
            self.assertTrue(ok, repr(junk))                # 畸形/空 → 未能完成 → 放行（不锁死）

    def test_解析失败fail_open且日志如实留痕(self):
        with mock.patch.object(web, "_audit_net") as audit:
            ok, _ = web.fetch("https://example.com/", runner=_runner_ok,
                              resolver=lambda h: (_ for _ in ()).throw(socket.gaierror("DNS 暂不可达")))
            self.assertTrue(ok)                            # fail-open：不硬拒正常用网
        allows = [c for c in audit.call_args_list if c.args[1] == "allow"]
        self.assertTrue(allows)
        self.assertIn("预检未能完成", allows[0].kwargs.get("note", ""))   # 如实告知，不装成「已验证」

    def test_解析超时fail_open不假死(self):
        # 注入假死 resolver，超时上限须封顶（patch 小超时让测试快），fetch 不得被拖死
        def slow(h):
            time.sleep(30)
            return [_v4(PUB)]
        with mock.patch.object(web, "_DNS_TIMEOUT", 0.5), \
             mock.patch.object(web, "_audit_net") as audit:
            t0 = time.monotonic()
            ok, _ = web.fetch("https://example.com/", runner=_runner_ok, resolver=slow)
            dt = time.monotonic() - t0
        self.assertTrue(ok)
        self.assertLess(dt, 5)                             # 远超 0.5s 上限即失败：假死被封顶放行
        allows = [c for c in audit.call_args_list if c.args[1] == "allow"]
        self.assertIn("预检未能完成", allows[0].kwargs.get("note", ""))


class 重定向与文档(unittest.TestCase):
    def test_重定向目标域名也过预检(self):
        answers = {"start.example": [_v4(PUB)], "internal.example": [_v4("192.168.0.1")]}
        calls = []
        def runner(argv):
            calls.append(argv)
            if len(calls) == 1:
                return (0, "stub" + web._REDIR_MARK + "http://internal.example/", "")
            return (0, "<p>should not reach</p>", "")
        ok, msg = web.fetch("http://start.example/", runner=runner,
                            resolver=lambda h: answers[h])
        self.assertFalse(ok)
        self.assertIn("重定向", msg)
        self.assertEqual(len(calls), 1)                    # 第二跳被预检拒掉，没真抓

    def test_docstring如实标注不防rebinding(self):
        doc = web._dns_precheck.__doc__
        self.assertIn("rebinding", doc)
        self.assertIn("代理", doc)                         # 写明治本在代理侧 REJECT
        self.assertIn("fail-open", doc)


if __name__ == "__main__":
    unittest.main(verbosity=2)
