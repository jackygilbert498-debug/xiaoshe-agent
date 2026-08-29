"""P3 v1.1 · 渲染腿地基：本地 HTML 解析(安全)+ 浏览器命令构建 + 廉价 DOM 硬信号。TDD 红→绿。

设计：浏览器真机才 shell out，命令构建/DOM 校验是纯函数、离线可测。只渲染 ROOT 内 file://，
拒 http(s)（远程渲染属 P4）。DOM 关键字硬信号先粗筛，全绿才值得花一发 Kimi 判优（省按次计费）。
运行：仓库根 `python -m unittest discover -s tests -v`
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import permission, render


class HTML安全解析(unittest.TestCase):
    def test_拒绝http_only本地文件(self):
        with self.assertRaises(ValueError):
            render.resolve_html("https://evil.example.com/x.html")
        with self.assertRaises(ValueError):
            render.resolve_html("http://localhost/x.html")

    def test_越界路径被硬拒(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(permission, "ROOT", Path(d)):
                with self.assertRaises(permission.PathError):
                    render.resolve_html("/etc/passwd")

    def test_ROOT内存在的文件_返回路径(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(permission, "ROOT", Path(d)):
                (Path(d) / "page.html").write_text("<h1>hi</h1>", encoding="utf-8")
                p = render.resolve_html("page.html")
                self.assertEqual(p, (Path(d) / "page.html").resolve())  # safe_path 会展开符号链接(/var→/private/var)

    def test_不存在的文件_报错(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(permission, "ROOT", Path(d)):
                with self.assertRaises(FileNotFoundError):
                    render.resolve_html("nope.html")


class 浏览器命令构建(unittest.TestCase):
    def test_命令含无头截图与固定缩放(self):
        argv = render.build_render_argv("chrome", "/tmp/a.html", "/tmp/o.png", 1600, 1000)
        self.assertEqual(argv[0], "chrome")
        joined = " ".join(argv)
        self.assertIn("--headless", joined)
        self.assertIn("--screenshot=/tmp/o.png", joined)
        self.assertIn("--window-size=1600,1000", joined)
        self.assertIn("--force-device-scale-factor=1", joined)  # 逻辑像素=物理像素，坐标不脱靶
        self.assertIn("/tmp/a.html", argv)


class DOM硬信号(unittest.TestCase):
    def test_全部关键字都在_过(self):
        ok, missing = render.dom_has_all("<h1>登录</h1><button>提交</button>", ["登录", "提交"])
        self.assertTrue(ok)
        self.assertEqual(missing, [])

    def test_缺关键字_不过且列出缺哪个(self):
        ok, missing = render.dom_has_all("<h1>登录</h1>", ["登录", "提交"])
        self.assertFalse(ok)
        self.assertEqual(missing, ["提交"])

    def test_空dom或空关键字不炸(self):
        self.assertTrue(render.dom_has_all("anything", [])[0])   # 无要求→过
        self.assertFalse(render.dom_has_all("", ["x"])[0])       # 空 dom 缺 x


if __name__ == "__main__":
    unittest.main(verbosity=2)
