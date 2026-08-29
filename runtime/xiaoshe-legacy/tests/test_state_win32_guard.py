"""对抗审查·收口 Win32「尾点/空格」等价绕过 .state 敏感护栏。TDD 红→绿。

背景：ab29851 已把整个 .state 树纳入 _is_sensitive（写类工具 write_file/edit 走 safe_path 硬拒）。但判定按
`.state` **字面**比对 path 段——Windows 建/开文件时会静默剥掉每段尾部的 '.' 与空格，故 `.state./approvals.json`
落盘即真 `.state/approvals.json`，却因 parts 里是 `.state.`（带尾点）逃过字面比对 → 静默篡改审计账本(effects.jsonl)/
放行清单(approvals.json)/工具注册表，且 undo 兜不住二进制/账本覆盖。
（run_command/press_keys/type_text 通道走 `.state` 子串扫描，`.state.` 含子串已被 force_ask 拦；唯文件路径写通道漏网。）

修复：_is_sensitive 比对前对每段做 Win32 等价归一（剥尾部点/空格），这族变体与真名同判。连带堵住凭据后缀
同族绕过（secret.pem␠ / deploy.pem.）。
运行：仓库根 `python -m unittest tests.test_state_win32_guard -v`
"""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import permission


class Win32尾点空格绕过state(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.root = Path(self._d.name)   # 全新临时根：无 .state 目录，resolve 不会把 `.state.` 归并掉，坐实字面比对漏洞
        self._rp = mock.patch.object(permission, "ROOT", self.root)
        self._rp.start()
        self.addCleanup(self._rp.stop)
        self.addCleanup(self._d.cleanup)

    # ---- 决策层 check：写类工具 ----
    def test_write_file写state尾点变体被拒(self):
        for bad in (".state./approvals.json", ".state /approvals.json",
                    ".state.../effects.jsonl", ".state. /user_tools/x.json"):
            d = permission.check("write_file", {"path": bad, "content": "x"})
            self.assertEqual(d.action, "deny", msg=f"该拒没拒：{bad}")

    def test_edit改state尾点变体被拒(self):
        for bad in (".state./hooks.json", ".state /schedule/tasks/a.json"):
            d = permission.check("edit", {"path": bad})
            self.assertEqual(d.action, "deny", msg=f"该拒没拒：{bad}")

    def test_写普通state仍被拒_回归(self):
        self.assertEqual(permission.check("write_file", {"path": ".state/approvals.json", "content": "x"}).action, "deny")
        self.assertEqual(permission.check("edit", {"path": ".state/hooks.json"}).action, "deny")

    # ---- 执行层 safe_path（写工具执行前再兜一层）----
    def test_safe_path对state尾点变体抛错(self):
        for bad in (".state./approvals.json", ".state /x.json"):
            with self.assertRaises(permission.PathError, msg=bad):
                permission.safe_path(bad)
        # 反斜杠变体是 Windows 专属语义：Win 下 `\` 是分隔符，`.state...` 段归一为 `.state` 必拦；
        # POSIX 下 `\` 是文件名字面字符，`.state...\blobs\y.png` 不落在 .state 树内，按设计不拦
        # （否则把合法 POSIX 文件名过杀）。照 1fb4571/62b8f0b 先例加平台分支，Win 分支保持原字面断言。
        if sys.platform == "win32":
            for bad in (".state...\\blobs\\y.png", ".state.\\effects.jsonl"):
                with self.assertRaises(permission.PathError, msg=bad):
                    permission.safe_path(bad)

    # ---- 不误伤正常路径 ----
    def test_正常路径不误伤(self):
        for ok in ("docs/state.md", "mystate/x.json", "notes/state_machine.py",
                   "src/statement.txt", "state/config.json", "README.md"):
            self.assertNotEqual(permission.check("write_file", {"path": ok, "content": "x"}).action,
                                "deny", msg=f"误伤（决策层）：{ok}")
            self.assertIsInstance(permission.safe_path(ok), Path)   # 执行层也不抛

    # ---- 连带：凭据后缀/整目录同族绕过也堵 ----
    def test_凭据同族尾空格点绕过也堵(self):
        for bad in ("secret.pem ", "deploy.pem.", "server.key ", ".ssh./known_hosts"):
            with self.assertRaises(permission.PathError, msg=bad):
                permission.safe_path(bad)

    def test_归一只加拦不放宽_原被拒字面名仍拒(self):
        # 护栏归一必须单向：`.env.example.`/`id_rsa.pub.` 原本按字面前缀被拒；若归一后走了豁免/公钥分支
        # 反而放行，POSIX 上它们是独立文件、等于归一把旧护栏拆了。原字面判定与归一后判定须**取并集拦**。
        for bad in (".env.example.", "id_rsa.pub.", "id_rsa.pub "):
            with self.assertRaises(permission.PathError, msg=bad):
                permission.safe_path(bad)

    def test_豁免与公钥正字面照旧放行_回归(self):
        for ok in (".env.example", "id_rsa.pub"):
            self.assertIsInstance(permission.safe_path(ok), Path, msg=f"误伤：{ok}")


if __name__ == "__main__":
    unittest.main()
