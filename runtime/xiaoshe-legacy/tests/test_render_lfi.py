"""P3 审查修复 [HIGH] · render_check 任意本地文件外泄。TDD 红→绿。

对抗审查真机复现：模型写 leak.html 内含 <iframe src="file:///etc/passwd">，render_check 只校验顶层
leak.html（在 ROOT、非敏感→放行），但 Chrome 照常加载 iframe 里的 file:///etc/passwd 渲进截图回喂模型，
绕过 safe_path「越界/敏感即使读也 deny」。修：render 改走 localhost http 服务器加载——http 源无法加载
file:// 子资源（浏览器 scheme 安全边界天然拦死），相对子资源经服务器约束在 ROOT 内、`..` 穿越被拦。
运行：仓库根 `python -m unittest discover -s tests -v`
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import permission, render


class 渲染走http堵file外泄(unittest.TestCase):
    def test_渲染入口是localhost_http_而非file路径(self):
        seen = {}

        def spy_runner(argv):
            # argv 最后一项是渲染入口 URL；截图轮写个假 png
            seen.setdefault("urls", []).append(argv[-1])
            for a in argv:
                if a.startswith("--screenshot="):
                    Path(a.split("=", 1)[1]).write_bytes(b"\x89PNG\r\n\x1a\n")
            return (0, "<html></html>", "")

        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(permission, "ROOT", Path(d)):
                (Path(d) / "leak.html").write_text(
                    '<iframe src="file:///etc/passwd"></iframe>', encoding="utf-8")
                render.render("leak.html", browser="chrome", runner=spy_runner)
                # 关键：喂给浏览器的是 http://127.0.0.1 本地服务器 URL，不是 file 路径/绝对路径
                for u in seen["urls"]:
                    self.assertTrue(u.startswith("http://127.0.0.1"), f"渲染入口应是 localhost http，实为 {u}")
                    self.assertNotIn("file://", u)
                    self.assertIn("leak.html", u)   # 仍渲染的是目标文件

    def test_仍拒模型直接传http(self):
        with self.assertRaises(ValueError):
            render.render("http://evil.example.com/x.html", browser="chrome", runner=lambda a: (0, "", ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
