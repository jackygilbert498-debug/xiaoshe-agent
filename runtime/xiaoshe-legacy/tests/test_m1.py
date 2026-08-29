"""M1 引擎整备：文件锁 / 记忆并发 / 多会话档案 / 会话选择 的回归测试。

运行：仓库根目录 `python -m unittest discover -s tests -v`
"""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import _io, memory
from harness import session

_HOLDER = Path(__file__).resolve().parent / "_lock_holder.py"
_WRITER = Path(__file__).resolve().parent / "_mem_writer.py"


def _hold_lock(target: Path, seconds: float) -> subprocess.Popen:
    """起一个子进程锁住 target，等它打出 LOCKED 再返回（保证锁已在手）。"""
    proc = subprocess.Popen([sys.executable, str(_HOLDER), str(target), str(seconds)],
                            stdout=subprocess.PIPE, text=True, encoding="utf-8")
    assert proc.stdout is not None
    line = proc.stdout.readline().strip()
    proc.stdout.close()  # 子进程只输出这一行；父进程必须立即释放管道句柄。
    if line != "LOCKED":
        proc.kill()
        proc.wait()
        raise AssertionError(f"锁夹具启动失败：{line!r}")
    return proc


class 文件锁(unittest.TestCase):
    def test_锁被其他进程持有时_等待超时抛TimeoutError(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "shared.json"
            proc = _hold_lock(target, 1.0)
            try:
                with self.assertRaises(TimeoutError):
                    with _io.file_lock(target, timeout=0.3):
                        pass
            finally:
                proc.wait()

    def test_锁释放后_能再次获得(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "shared.json"
            with _io.file_lock(target, timeout=1.0):
                pass
            with _io.file_lock(target, timeout=1.0):
                pass  # 顺序两次都拿得到，说明释放干净

    def test_锁内代码抛异常_锁仍被释放(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "shared.json"
            try:
                with _io.file_lock(target, timeout=1.0):
                    raise ValueError("锁内故意炸")
            except ValueError:
                pass
            with _io.file_lock(target, timeout=0.5):
                pass  # 异常后还能拿到锁


class 记忆并发(unittest.TestCase):
    def test_六个进程同时记事_一条都不丢(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "memory.json"
            facts = [f"事实{i}" for i in range(6)]
            procs = [subprocess.Popen([sys.executable, str(_WRITER), str(p), f])
                     for f in facts]
            for proc in procs:
                proc.wait()
            self.assertEqual(sorted(memory.load(p)), sorted(facts))

    def test_记忆文件被锁住_remember抛超时且一个字不写(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "memory.json"
            proc = _hold_lock(p, 1.5)
            try:
                with mock.patch.object(memory, "_LOCK_TIMEOUT", 0.2):
                    with self.assertRaises(TimeoutError):
                        memory.remember("锁着呢", p)
                self.assertFalse(p.exists())  # 一个字都没写
            finally:
                proc.wait()

    def test_记忆锁超时_模型收到错误而非早就记着了(self):
        from harness import tools as tools_mod
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "memory.json"
            proc = _hold_lock(p, 1.5)
            try:
                with mock.patch.object(memory, "_LOCK_TIMEOUT", 0.2):
                    result = tools_mod.execute("remember", {"fact": "x"}, {"memory_file": p})
                self.assertTrue(result.is_error)
                self.assertNotIn("早就记着了", result.content)
            finally:
                proc.wait()

    def test_合并命令拿不到锁_文件不动且返回False(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "memory.json"
            conflicted = '[\n<<<<<<< HEAD\n  "a"\n=======\n  "b"\n>>>>>>> other\n]\n'
            p.write_text(conflicted, encoding="utf-8")
            proc = _hold_lock(p, 1.5)
            try:
                with mock.patch.object(memory, "_LOCK_TIMEOUT", 0.2):
                    self.assertFalse(memory.resolve_conflict_file(p))
                self.assertEqual(p.read_text(encoding="utf-8"), conflicted)
            finally:
                proc.wait()


class 会话档案(unittest.TestCase):
    def _tmp(self, d):
        return mock.patch.object(session, "SESSIONS_DIR", Path(d) / "sessions")

    def test_新会话id_同秒重复时自动加后缀(self):
        with tempfile.TemporaryDirectory() as d, self._tmp(d):
            sid1 = session.new_session_id()
            session.save_session(sid1, [{"role": "user", "content": "hi"}], [])
            sid2 = session.new_session_id()
            self.assertNotEqual(sid1, sid2)

    def test_按id存取会话_往返内容一致(self):
        with tempfile.TemporaryDirectory() as d, self._tmp(d):
            hist = [{"role": "user", "content": "你好"}, {"role": "assistant", "content": "嗯"}]
            todos = [{"content": "A", "status": "pending"}]
            session.save_session("s1", hist, todos)
            data = session.load_session("s1")
            self.assertEqual(data["history"], hist)
            self.assertEqual(data["todos"], todos)

    def test_会话列表_最近的排前面且带预览(self):
        with tempfile.TemporaryDirectory() as d, self._tmp(d):
            session.save_session("old", [{"role": "user", "content": "旧会话的第一句话"}], [])
            session.save_session("new", [{"role": "system", "content": "记忆"},
                                         {"role": "user", "content": "新会话的第一句话"}], [])
            f_old = session.SESSIONS_DIR / "old.json"
            os.utime(f_old, (f_old.stat().st_mtime - 100, f_old.stat().st_mtime - 100))
            lst = session.list_sessions()
            self.assertEqual([s["id"] for s in lst], ["new", "old"])
            self.assertIn("新会话的第一句话"[:10], lst[0]["preview"])
            self.assertEqual(lst[0]["n_messages"], 2)

    def test_会话档案超过上限_自动清掉最旧的(self):
        with tempfile.TemporaryDirectory() as d, self._tmp(d), \
             mock.patch.object(session, "_MAX_SESSIONS", 3):
            for i in range(5):
                session.save_session(f"s{i}", [{"role": "user", "content": str(i)}], [])
                f = session.SESSIONS_DIR / f"s{i}.json"
                os.utime(f, (f.stat().st_mtime - (5 - i) * 10,) * 2)
            session.save_session("s5", [{"role": "user", "content": "5"}], [])
            left = {p.stem for p in session.SESSIONS_DIR.glob("*.json")}
            self.assertEqual(len(left), 3)
            self.assertIn("s5", left)

    def test_旧单档案存在_迁移进列表且原文件改名不再重复迁(self):
        with tempfile.TemporaryDirectory() as d, self._tmp(d):
            legacy = Path(d) / ".session" / "last.json"
            legacy.parent.mkdir(parents=True)
            legacy.write_text('{"history": [{"role": "user", "content": "老会话"}], "todos": []}',
                              encoding="utf-8")
            with mock.patch.object(session, "LEGACY_FILE", legacy):
                self.assertTrue(session.migrate_legacy())
                self.assertFalse(legacy.exists())
                self.assertTrue(legacy.with_name("last.json.migrated").exists())
                self.assertEqual(len(session.list_sessions()), 1)
                self.assertFalse(session.migrate_legacy())  # 第二次无事可做

    def test_两个进程同秒取id_互不相同(self):
        code = ("import sys, os; sys.path.insert(0, os.getcwd()); "
                "from harness import session; print(session.new_session_id())")
        root = str(Path(__file__).resolve().parent.parent)
        procs = [subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE,
                                  text=True, encoding="utf-8", cwd=root) for _ in range(2)]
        ids = [p.communicate()[0].strip() for p in procs]
        self.assertNotEqual(ids[0], ids[1])

    def test_档案在排序途中被删_按最旧处理不崩(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(session._mtime(Path(d) / "gone.json"), 0.0)

    def test_坏档案不挤占列表名额(self):
        with tempfile.TemporaryDirectory() as d, self._tmp(d):
            for i in range(3):
                session.save_session(f"g{i}", [{"role": "user", "content": str(i)}], [])
            bad = session.SESSIONS_DIR / "zbad.json"
            bad.write_text("{断", encoding="utf-8")
            future = bad.stat().st_mtime + 100
            os.utime(bad, (future, future))
            lst = session.list_sessions(limit=3)
            self.assertEqual(len(lst), 3)
            self.assertNotIn("zbad", [s["id"] for s in lst])

    def test_预览含换行_压成单行显示(self):
        with tempfile.TemporaryDirectory() as d, self._tmp(d):
            session.save_session("s1", [{"role": "user", "content": "第一行\n第二行\r\n第三行"}], [])
            lst = session.list_sessions()
            self.assertNotIn("\n", lst[0]["preview"])
            self.assertNotIn("\r", lst[0]["preview"])
            self.assertIn("第一行 第二行", lst[0]["preview"])


class 会话选择与日志路径(unittest.TestCase):
    SESSIONS = [{"id": "a", "n_messages": 1, "preview": "x"},
                {"id": "b", "n_messages": 2, "preview": "y"}]

    def test_回车_开新会话(self):
        self.assertIsNone(session.pick_session(self.SESSIONS, ""))

    def test_输合法编号_恢复对应会话(self):
        self.assertEqual(session.pick_session(self.SESSIONS, "2"), "b")

    def test_非法输入_一律按新会话处理(self):
        for bad in ("abc", "0", "99", " 3 ", "-1", "②", "²"):
            self.assertIsNone(session.pick_session(self.SESSIONS, bad), bad)

    def test_会话日志路径_按会话id分文件(self):
        p = session.session_log_file("s1")
        self.assertEqual(p.name, "s1.jsonl")
        self.assertEqual(p.parent, session.LOGS_DIR)
