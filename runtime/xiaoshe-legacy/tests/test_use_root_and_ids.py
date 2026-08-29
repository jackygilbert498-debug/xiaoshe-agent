"""P2 · #33 use_root contextvar + #35 session 进程内发号。TDD 红→绿。

#33：工作区根切换（无头 --workdir / 子 agent）过去是"改全局 permission.ROOT + finally 恢复"，
并发/重入/异常路径下会串味。改成 contextvar 覆盖：active_root() 上下文优先、从不动全局。
#35：session id 同进程同秒两次调用在落盘前都看不到文件 → 会撞；补进程内单调计数器（jobs 已有）。
运行：仓库根 `python -m unittest discover -s tests -v`
"""
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from harness import permission, session


class use_root隔离(unittest.TestCase):
    def test_默认回退到模块ROOT(self):
        self.assertEqual(permission.active_root(), Path(permission.ROOT).resolve())

    def test_块内覆盖_块后恢复_且从不改全局(self):
        before = permission.ROOT
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d).resolve()
            with permission.use_root(tmp):
                self.assertEqual(permission.active_root(), tmp)
                self.assertIs(permission.ROOT, before)  # 全局纹丝不动
            self.assertEqual(permission.active_root(), Path(before).resolve())

    def test_异常路径也恢复(self):
        before_active = permission.active_root()
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                with permission.use_root(Path(d).resolve()):
                    raise ValueError("boom")
        self.assertEqual(permission.active_root(), before_active)

    def test_嵌套覆盖_内层退出回到外层而非全局(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            pa, pb = Path(a).resolve(), Path(b).resolve()
            with permission.use_root(pa):
                with permission.use_root(pb):
                    self.assertEqual(permission.active_root(), pb)
                self.assertEqual(permission.active_root(), pa)  # 回到外层，不是全局

    def test_覆盖不泄漏到新线程(self):
        with tempfile.TemporaryDirectory() as a:
            pa = Path(a).resolve()
            seen = {}

            def worker():
                seen["root"] = permission.active_root()

            with permission.use_root(pa):
                t = threading.Thread(target=worker)
                t.start()
                t.join()
            self.assertEqual(seen["root"], Path(permission.ROOT).resolve())  # 新线程起于空上下文

    def test_边界随覆盖走_块内放行块外越界(self):
        with tempfile.TemporaryDirectory() as a:
            pa = Path(a).resolve()
            target = str(pa / "x.txt")
            with permission.use_root(pa):
                self.assertEqual(permission.safe_path(target), pa / "x.txt")
            with self.assertRaises(permission.PathError):
                permission.safe_path(target)  # 出了块，tmp 越出真正的 ROOT


class session进程内发号(unittest.TestCase):
    def test_同进程连发两个id不撞_即使都未落盘(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(session, "SESSIONS_DIR", Path(d)):
                a = session.new_session_id("headless-")
                b = session.new_session_id("headless-")  # 期间不落盘
                self.assertNotEqual(a, b)


if __name__ == "__main__":
    unittest.main(verbosity=2)
