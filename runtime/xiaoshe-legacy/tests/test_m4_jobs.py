"""M4 · 后台任务跨重启（语义 A：记录+日志落盘，进程仍在退出时收掉）。TDD 红→绿。

- 任务档案（命令/pid/日志/状态）落盘 .state/jobs/<id>.json，日志落 <id>.log
- 重启后（内存 _JOBS 清空）仍能从盘上查到历史记录与输出
- 启动时 reconcile：running 记录若 pid 已死 → 纠为 interrupted
- shutdown 把在跑任务记 interrupted 并保留日志（供下次查），不留孤儿进程

运行：仓库根 `python -m unittest discover -s tests -v`
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import jobs


class M4后台任务落盘跨重启(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self._patch = mock.patch.object(jobs, "JOBS_DIR", Path(self.d))
        self._patch.start()
        jobs._JOBS.clear()

    def tearDown(self):
        for j in list(jobs._JOBS.values()):
            try:
                j["proc"].kill()
                j["proc"].wait(timeout=2)  # 回收子进程，严格 ResourceWarning 门不接受仅 kill 不 wait。
            except Exception:
                pass
        jobs._JOBS.clear()
        self._patch.stop()

    def test_start后任务记录落盘_含命令pid状态(self):
        jid = jobs.start("echo hi", self.d)
        rec = json.loads((Path(self.d) / f"{jid}.json").read_text(encoding="utf-8"))
        self.assertEqual(rec["command"], "echo hi")
        self.assertIn("pid", rec)
        self.assertIn(rec["status"], ("running", "done"))

    def test_跨重启_清空内存JOBS后仍能从盘查到记录与输出(self):
        jid = jobs.start(f'{sys.executable} -c "print(123)"', self.d)
        jobs._JOBS[jid]["proc"].wait(timeout=10)  # 等它跑完、输出落盘
        jobs._JOBS.clear()                         # 模拟重启：内存没了
        st = jobs.status(jid)
        self.assertTrue(st["ok"], "盘上应还查得到")
        self.assertIn("123", st["output_tail"])
        self.assertFalse(st["running"])

    def test_list_jobs列出落盘的历史任务(self):
        a = jobs.start("echo a", self.d)
        b = jobs.start("echo b", self.d)
        ids = [r["id"] for r in jobs.list_jobs()]
        self.assertIn(a, ids)
        self.assertIn(b, ids)

    def test_reconcile把pid已死的running记录纠为interrupted(self):
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        (Path(self.d) / "job-x.json").write_text(json.dumps(
            {"id": "job-x", "command": "c", "pid": dead.pid,
             "log_path": str(Path(self.d) / "job-x.log"), "status": "running",
             "started_at": "2026-01-01T00:00:00", "returncode": None, "ended_at": None}),
            encoding="utf-8")
        jobs.reconcile()
        rec = json.loads((Path(self.d) / "job-x.json").read_text(encoding="utf-8"))
        self.assertEqual(rec["status"], "interrupted")

    @unittest.skipIf(sys.platform == "win32", "POSIX kill 语义")
    def test_shutdown把在跑任务记interrupted并保留日志(self):
        jid = jobs.start(f'{sys.executable} -c "import time; time.sleep(30)"', self.d)
        with mock.patch.object(jobs, "_KILL_GRACE_S", 0.5):
            jobs.shutdown()
        rec = json.loads((Path(self.d) / f"{jid}.json").read_text(encoding="utf-8"))
        self.assertEqual(rec["status"], "interrupted")
        self.assertTrue((Path(self.d) / f"{jid}.log").exists(), "日志应保留供下次查")

    def test_list_background工具列出历史任务_含命令(self):
        from harness import tools as tools_mod
        jobs.start("echo aaa", self.d)
        out = tools_mod.execute("list_background", {}, {}).content
        self.assertIn("echo aaa", out)

    def test_list_background是安全工具且在工具声明里(self):
        from harness import permission, tools as tools_mod
        self.assertEqual(permission.check("list_background", {}).action, "approve")
        names = [s["function"]["name"] for s in tools_mod.all_specs()]
        self.assertIn("list_background", names)

    def test_并发在跑达上限_start拒起并友好报错(self):
        with mock.patch.object(jobs, "_MAX_RUNNING", 2):
            jobs.start(f'{sys.executable} -c "import time; time.sleep(30)"', self.d)
            jobs.start(f'{sys.executable} -c "import time; time.sleep(30)"', self.d)
            with self.assertRaises(RuntimeError):
                jobs.start("echo x", self.d)  # 第 3 个超并发上限


if __name__ == "__main__":
    unittest.main()
