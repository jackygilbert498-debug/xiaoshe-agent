"""M3 定时调度：欠账清偿（原子写唯一临时名 / 会话档案分池）+ 调度器本体的回归测试。

运行：仓库根目录 `python -m unittest discover -s tests -v`
"""
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import UTC, datetime
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

from harness import (_io, agent, headless, memory, permission, schedule,
                     schedule_cli, session)


class 原子写唯一临时名(unittest.TestCase):
    def test_别的进程半成品临时文件在场_原子写不碰它照样成功(self):
        # M1 契约自认的坑：固定 <名>.tmp 双开同瞬落档互抢。改唯一名后：别人的半成品原样保留。
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "x.json"
            other = Path(d) / "x.json.tmp"          # 假装另一进程正在写的半成品
            other.write_text("别人的半成品", encoding="utf-8")
            _io.atomic_write_text(target, "我的内容")
            self.assertEqual(target.read_text(encoding="utf-8"), "我的内容")
            self.assertEqual(other.read_text(encoding="utf-8"), "别人的半成品")  # 不该被覆盖或搬走

    def test_原子写完成后_不留自己的临时文件(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "y.json"
            _io.atomic_write_text(target, "内容")
            leftovers = [p.name for p in Path(d).iterdir() if p.name != "y.json"]
            self.assertEqual(leftovers, [])


class 会话档案分池(unittest.TestCase):
    def _tmp(self, d):
        return mock.patch.object(session, "SESSIONS_DIR", Path(d) / "sessions")

    def test_恢复列表只显示交互会话_无头和调度档案不出现(self):
        with tempfile.TemporaryDirectory() as d, self._tmp(d):
            session.save_session("20260703-1", [{"role": "user", "content": "交互会话"}], [])
            session.save_session("headless-20260703-2", [{"role": "user", "content": "无头任务"}], [])
            session.save_session("sched-报时-20260703-3", [{"role": "user", "content": "定时任务"}], [])
            lst = session.list_sessions(limit=5)
            self.assertEqual([s["id"] for s in lst], ["20260703-1"])

    def test_无头档案再多_也挤不掉交互会话(self):
        # 体检结论：不分池则每小时定时任务约两天挤空全部交互档案。分池后各清各的。
        with tempfile.TemporaryDirectory() as d, self._tmp(d), \
             mock.patch.object(session, "_MAX_SESSIONS", 3), \
             mock.patch.object(session, "_MAX_BG_SESSIONS", 2):
            for i in range(3):
                session.save_session(f"s{i}", [{"role": "user", "content": str(i)}], [])
                f = session.SESSIONS_DIR / f"s{i}.json"
                os.utime(f, (f.stat().st_mtime - 1000 + i,) * 2)   # 交互档案都比无头旧
            for i in range(5):
                session.save_session(f"headless-h{i}", [{"role": "user", "content": str(i)}], [])
            left = {p.stem for p in session.SESSIONS_DIR.glob("*.json")}
            self.assertTrue({"s0", "s1", "s2"} <= left)            # 交互一个不少
            self.assertEqual(len([x for x in left if x.startswith("headless-")]), 2)  # 无头按自己的上限清


def _sandbox_sched(d):
    """把调度目录整体指进临时目录。"""
    base = Path(d) / "schedule"
    return (mock.patch.object(schedule, "TASKS_DIR", base / "tasks"),
            mock.patch.object(schedule, "HISTORY_DIR", base / "history"),
            mock.patch.object(schedule, "RUNNING_DIR", base / "running"))


class 任务登记(unittest.TestCase):
    def test_建任务_档案落盘且能读回(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = _sandbox_sched(d)
            with p1, p2, p3:
                schedule.add_task("报时", "记一行时间戳", every="1h", allow=("write_file",))
                t = schedule.load_task("报时")
                self.assertEqual(t["prompt"], "记一行时间戳")
                self.assertEqual(t["every_minutes"], 60)
                self.assertEqual(t["allow"], ["write_file"])
                self.assertTrue(t["enabled"])

    def test_任务名带路径穿越_拒绝(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = _sandbox_sched(d)
            with p1, p2, p3:
                for bad in ("..", "a/b", "a\\b", "x" * 41, ""):
                    with self.assertRaises(ValueError, msg=bad):
                        schedule.add_task(bad, "x", every="1h")

    def test_节奏解析_间隔与每天定点(self):
        self.assertEqual(schedule.parse_every("30m"), 30)
        self.assertEqual(schedule.parse_every("2h"), 120)
        for bad in ("0m", "25h", "abc", "90x", ""):
            with self.assertRaises(ValueError, msg=bad):
                schedule.parse_every(bad)
        self.assertEqual(schedule.parse_daily("08:30"), "08:30")
        for bad in ("24:00", "8点半", "08:60", ""):
            with self.assertRaises(ValueError, msg=bad):
                schedule.parse_daily(bad)

    def test_every和daily必须二选一(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = _sandbox_sched(d)
            with p1, p2, p3:
                with self.assertRaises(ValueError):
                    schedule.add_task("a", "x")                      # 都没给
                with self.assertRaises(ValueError):
                    schedule.add_task("a", "x", every="1h", daily="08:00")  # 都给了

    def test_prompt超8KiB字节上限_拒绝(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = _sandbox_sched(d)
            with p1, p2, p3:
                with self.assertRaises(ValueError):
                    schedule.add_task("a", "汉" * 3000, every="1h")   # 3000 汉字 = 9000 字节

    def test_任务档案损坏_拒绝执行而不是猜(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = _sandbox_sched(d)
            with p1, p2, p3:
                schedule.TASKS_DIR.mkdir(parents=True)
                (schedule.TASKS_DIR / "坏.json").write_text("{断", encoding="utf-8")
                self.assertIsNone(schedule.load_task("坏"))          # 解析失败往严处收


class 监工执行(unittest.TestCase):
    def _prep(self, d, **kw):
        kw.setdefault("every", "1h")
        schedule.add_task("测", "干活", **kw)

    def test_killswitch环境变量_一票停摆记入历史(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = _sandbox_sched(d)
            with p1, p2, p3, mock.patch.dict(os.environ, {"HARNESS_DISABLE_SCHEDULE": "1"}):
                self._prep(d)
                def 不许起子进程(*a, **k):
                    raise AssertionError("killswitch 下不该起子进程")
                code = schedule.run_task("测", popen=不许起子进程)
                self.assertEqual(code, 0)                            # 跳过不算失败
                hist = schedule.read_history("测")
                self.assertEqual(hist[-1]["outcome"], "skipped_killswitch")

    def test_任务被暂停_运行入口双保险跳过(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = _sandbox_sched(d)
            with p1, p2, p3:
                self._prep(d)
                schedule.set_enabled("测", False)
                code = schedule.run_task("测", popen=lambda *a, **k: (_ for _ in ()).throw(AssertionError))
                self.assertEqual(code, 0)
                self.assertEqual(schedule.read_history("测")[-1]["outcome"], "skipped_disabled")

    def test_子进程正常跑完_历史记done退出码0(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = _sandbox_sched(d)
            with p1, p2, p3:
                self._prep(d)
                with mock.patch.object(schedule, "_child_cmd",
                                       return_value=[sys.executable, "-c", "print('干完了')"]):
                    code = schedule.run_task("测")
                rec = schedule.read_history("测")[-1]
                self.assertEqual(code, 0)
                self.assertEqual(rec["outcome"], "done")
                self.assertIn("干完了", rec["output_tail"])

    def test_子进程超时_两阶段杀掉记timeout退出码124(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = _sandbox_sched(d)
            with p1, p2, p3:
                self._prep(d, max_minutes=1)
                t = schedule.load_task("测"); t["max_minutes"] = 0.03  # 1.8 秒，测试专用
                schedule._save_task(t)
                start = time.monotonic()
                with mock.patch.object(schedule, "_child_cmd",
                                       return_value=[sys.executable, "-c", "import time; time.sleep(60)"]):
                    code = schedule.run_task("测")
                self.assertLess(time.monotonic() - start, 30)        # 没等满 60 秒
                rec = schedule.read_history("测")[-1]
                self.assertEqual(code, 124)                          # GNU timeout 惯例
                self.assertEqual(rec["outcome"], "timeout")

    def test_上一次还没跑完_这次跳过记skipped_overlap(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = _sandbox_sched(d)
            with p1, p2, p3:
                self._prep(d)
                schedule.RUNNING_DIR.mkdir(parents=True, exist_ok=True)
                holder = subprocess.Popen(
                    [sys.executable, str(Path(__file__).resolve().parent / "_lock_holder.py"),
                     str(schedule.RUNNING_DIR / "测"), "2.0"],
                    stdout=subprocess.PIPE, text=True, encoding="utf-8")
                assert holder.stdout is not None
                line = holder.stdout.readline().strip()
                holder.stdout.close()
                if line != "LOCKED":
                    holder.kill()
                    holder.wait()
                    raise AssertionError(f"锁夹具启动失败：{line!r}")
                try:
                    code = schedule.run_task("测", popen=lambda *a, **k: (_ for _ in ()).throw(AssertionError))
                    self.assertEqual(code, 0)
                    self.assertEqual(schedule.read_history("测")[-1]["outcome"], "skipped_overlap")
                finally:
                    holder.wait()

    def test_子进程环境强制UTF8_否则Windows输出乱码进历史(self):
        # 真机暴露：不设 PYTHONUTF8，子进程在 Windows 按 GBK 输出、监工按 UTF-8 读 → output_tail 全是乱码。
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = _sandbox_sched(d)
            with p1, p2, p3:
                self._prep(d)
                captured = {}
                real_popen = subprocess.Popen

                def spy_popen(cmd, **kw):
                    captured["env"] = kw.get("env")
                    return real_popen(cmd, **kw)

                # 清掉环境里的 PYTHONUTF8，模拟「任务计划唤起时的干净环境」——监工必须自己补上
                env_no_utf8 = {k: v for k, v in os.environ.items() if k != "PYTHONUTF8"}
                with mock.patch.dict(os.environ, env_no_utf8, clear=True), \
                     mock.patch.object(schedule, "_child_cmd",
                                       return_value=[sys.executable, "-c", "print('ok')"]):
                    schedule.run_task("测", popen=spy_popen)
                self.assertEqual(captured["env"].get("PYTHONUTF8"), "1")

    def test_子进程报告的越权次数_进执行历史(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = _sandbox_sched(d)
            with p1, p2, p3:
                self._prep(d)
                写摘要 = ("import os, json; "
                          "p = os.environ['HARNESS_RUN_SUMMARY']; "
                          "open(p, 'w', encoding='utf-8').write(json.dumps({'denied_calls': 2, 'session_id': 'x'}))")
                with mock.patch.object(schedule, "_child_cmd",
                                       return_value=[sys.executable, "-c", 写摘要]):
                    schedule.run_task("测")
                self.assertEqual(schedule.read_history("测")[-1]["denied_calls"], 2)

    def test_显式绑定Task的定时任务只入统一队列不启动子进程(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = _sandbox_sched(d)
            with p1, p2, p3, mock.patch.dict(os.environ, {"XIAOSHE_TASKING_V2": "on"}):
                schedule.add_task("测", "兼容占位", every="1h", task_id="tsk_bound", policy_id="policy_1")
                task = schedule.load_task("测")
                task["created_at"] = "2026-08-15T10:00:00Z"
                schedule._save_task(task)
                moments = [
                    datetime(2026, 8, 15, 10, 5, tzinfo=UTC),
                    datetime(2026, 8, 15, 10, 55, tzinfo=UTC),
                ]
                with mock.patch.object(schedule, "_queue_bound_task") as enqueue, \
                     mock.patch.object(schedule, "_utc_now", side_effect=moments):
                    for _ in moments:
                        code = schedule.run_task("测", popen=lambda *a, **k: (_ for _ in ()).throw(AssertionError("不应启动旧子进程")))
                        self.assertEqual(0, code)
                self.assertEqual(2, enqueue.call_count)
                self.assertEqual(enqueue.call_args_list[0].args[1], enqueue.call_args_list[1].args[1])
                self.assertEqual("queued", schedule.read_history("测")[-1]["outcome"])

    def test_schedule_cli绑定Task受feature_gate控制且可走到队列入口(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = _sandbox_sched(d)
            argv = ["add", "--name", "测", "--prompt", "兼容占位", "--every", "1h",
                    "--task-id", "tsk_bound", "--policy-id", "policy_1"]
            with p1, p2, p3, mock.patch.object(schedule_cli.scheduler_install, "install"):
                with mock.patch.dict(os.environ, {"XIAOSHE_TASKING_V2": "off"}):
                    self.assertEqual(2, schedule_cli.main(argv))
                    self.assertIsNone(schedule.load_task("测"))
                with mock.patch.dict(os.environ, {"XIAOSHE_TASKING_V2": "on"}):
                    self.assertEqual(0, schedule_cli.main(argv))
                    with mock.patch.object(schedule, "_queue_bound_task") as enqueue:
                        self.assertEqual(0, schedule.run_task(
                            "测", popen=lambda *a, **k: (_ for _ in ()).throw(
                                AssertionError("绑定调度不得启动子进程"))))
                    enqueue.assert_called_once()


class 无人值守安全闸(unittest.TestCase):
    def test_任务档案目录设防_写文件与命令都碰不得(self):
        self.assertEqual(permission.check(
            "write_file", {"path": ".state/schedule/tasks/评估.json", "content": "x"}).action, "deny")
        self.assertEqual(permission.check(
            "run_command", {"command": r"echo x > .state\schedule\tasks\评估.json"}).action, "deny")

    def test_无头模式统计被拒调用数(self):
        def 拒一切(tool_name, args, reason):
            return False
        ctx = {"todos": [], "memory_file": memory.MEMORY_FILE}
        写文件 = {"content": "", "tool_calls": [{"id": "t1", "function": {
            "name": "write_file", "arguments": json.dumps({"path": "a.txt", "content": "hi"})}}]}
        完成 = {"content": "好", "tool_calls": []}
        seq = [写文件, 完成]
        with tempfile.TemporaryDirectory() as d:
            agent.run_once("写个文件", [], model_fn=lambda h, tools=None: seq.pop(0),
                           approver=拒一切, log_file=Path(d) / "l.jsonl", ctx=ctx)
        self.assertEqual(ctx.get("_denied_calls", 0), 1)

    def test_无头结束_把运行摘要写到环境变量指定的文件(self):
        with tempfile.TemporaryDirectory() as d:
            summary = Path(d) / "s.json"
            with mock.patch.object(session, "SESSIONS_DIR", Path(d) / "se"), \
                 mock.patch.object(session, "LOGS_DIR", Path(d) / "lg"), \
                 mock.patch.dict(os.environ, {"HARNESS_RUN_SUMMARY": str(summary)}):
                with redirect_stderr(io.StringIO()):
                    headless.run_headless("说句话", model_fn=lambda h, tools=None: {"content": "好", "tool_calls": []})
            data = json.loads(summary.read_text(encoding="utf-8"))
            self.assertIn("denied_calls", data)
            self.assertIn("session_id", data)

    def test_无头可以不连MCP(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(session, "SESSIONS_DIR", Path(d) / "se"), \
                 mock.patch.object(session, "LOGS_DIR", Path(d) / "lg"), \
                 mock.patch("harness.mcp_client.connect_configured",
                            side_effect=AssertionError("--no-mcp 下不该连 MCP")):
                code = headless.run_headless("说句话", no_mcp=True,
                                             model_fn=lambda h, tools=None: {"content": "好", "tool_calls": []})
            self.assertEqual(code, 0)


class 调度命令行(unittest.TestCase):
    def _run(self, d, argv):
        p1, p2, p3 = _sandbox_sched(d)
        with p1, p2, p3:
            return schedule_cli.main(argv)

    def test_add_建档案并装进系统调度器(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(schedule_cli.scheduler_install, "install") as inst:
                code = self._run(d, ["add", "--name", "报时", "--prompt", "记一行",
                                     "--every", "1h", "--allow", "write_file"])
            self.assertEqual(code, 0)
            inst.assert_called_once()                       # 真的调了系统调度器安装
            p1, p2, p3 = _sandbox_sched(d)
            with p1, p2, p3:
                self.assertIsNotNone(schedule.load_task("报时"))

    def test_add_装载失败则回滚档案不留半拉子任务(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(schedule_cli.scheduler_install, "install",
                                   side_effect=schedule_cli.scheduler_install.InstallError("拒绝访问")):
                code = self._run(d, ["add", "--name", "报时", "--prompt", "x", "--every", "1h"])
            self.assertNotEqual(code, 0)                    # 失败非零退出
            p1, p2, p3 = _sandbox_sched(d)
            with p1, p2, p3:
                self.assertIsNone(schedule.load_task("报时"))  # 档案回滚，不留半拉子

    def test_pause和resume_同时改档案层和系统层(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(schedule_cli.scheduler_install, "install"), \
                 mock.patch.object(schedule_cli.scheduler_install, "set_enabled_os") as setos:
                self._run(d, ["add", "--name", "报时", "--prompt", "x", "--every", "1h"])
                self._run(d, ["pause", "报时"])
                self._run(d, ["resume", "报时"])
            p1, p2, p3 = _sandbox_sched(d)
            with p1, p2, p3:
                self.assertTrue(schedule.load_task("报时")["enabled"])  # resume 后档案层已恢复
            self.assertEqual(setos.call_count, 2)           # 系统层也各调一次

    def test_remove_卸载系统调度器并归档档案(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(schedule_cli.scheduler_install, "install"), \
                 mock.patch.object(schedule_cli.scheduler_install, "uninstall") as uninst:
                self._run(d, ["add", "--name", "报时", "--prompt", "x", "--every", "1h"])
                code = self._run(d, ["remove", "报时"])
            self.assertEqual(code, 0)
            uninst.assert_called_once()
            p1, p2, p3 = _sandbox_sched(d)
            with p1, p2, p3:
                self.assertIsNone(schedule.load_task("报时"))  # 档案已归档，list 不再显示

    def test_list与history_不炸且含任务名(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(schedule_cli.scheduler_install, "install"):
                self._run(d, ["add", "--name", "报时", "--prompt", "x", "--every", "1h"])
            buf = io.StringIO()
            p1, p2, p3 = _sandbox_sched(d)
            with p1, p2, p3, mock.patch("sys.stdout", buf):
                schedule_cli.main(["list"])
                schedule_cli.main(["history", "报时"])
            self.assertIn("报时", buf.getvalue())
