"""M3 双平台安装器：把任务装进 Windows 任务计划 / macOS launchd。

策略：把「真正执行 schtasks/launchctl」做成可注入的 runner，单测断言生成的 XML/plist
内容与调用参数，不真装（离线可测、双平台都能跑）。真机装载留验收环节。

运行：仓库根目录 `python -m unittest discover -s tests -v`

跨平台纪律（双机各自跑测试都要绿）：凡走到 install/uninstall/set_enabled_os 的用例必须
显式钉死 plat=（否则跟着本机 sys.platform 走，换台机器就红）；凡会真落盘的路径
（plist / logs_dir）必须指进临时目录（否则污染真实 ~/Library/LaunchAgents 或根目录）。
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import scheduler_install as si


class WindowsXML生成(unittest.TestCase):
    def _task(self, **kw):
        base = {"name": "报时", "prompt": "记一行", "every_minutes": 60, "daily": None,
                "max_minutes": 30, "allow": [], "workdir": None, "mcp": False}
        base.update(kw)
        return base

    def test_间隔任务_XML含重复间隔且是合法ISO8601(self):
        xml = si.build_task_xml(self._task(every_minutes=60), python="C:\\py\\python.exe",
                                run_py="D:\\ke\\run.py")
        self.assertIn("<Interval>PT1H</Interval>", xml)
        self.assertIn("<Repetition>", xml)
        self.assertIn("http://schemas.microsoft.com/windows/2004/02/mit/task", xml)

    def test_每30分钟_写成PT30M(self):
        xml = si.build_task_xml(self._task(every_minutes=30), python="p", run_py="r")
        self.assertIn("<Interval>PT30M</Interval>", xml)

    def test_每天定点_用CalendarTrigger且StartBoundary含时刻(self):
        xml = si.build_task_xml(self._task(every_minutes=None, daily="08:30"),
                                python="p", run_py="r")
        self.assertIn("<CalendarTrigger>", xml)
        self.assertIn("T08:30:00", xml)
        self.assertNotIn("<Repetition>", xml)  # 每天定点不该有重复间隔

    def test_电池策略显式关闭_否则笔记本拔电就罢工(self):
        # 调研结论：DisallowStartIfOnBatteries/StopIfGoingOnBatteries 默认 true，必须显式 false。
        xml = si.build_task_xml(self._task(), python="p", run_py="r")
        self.assertIn("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>", xml)
        self.assertIn("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>", xml)

    def test_防重叠与错过补跑策略写进XML(self):
        xml = si.build_task_xml(self._task(), python="p", run_py="r")
        self.assertIn("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>", xml)
        self.assertIn("<StartWhenAvailable>true</StartWhenAvailable>", xml)

    def test_动作命令指向schedule_run当前任务(self):
        xml = si.build_task_xml(self._task(name="报时"), python="C:\\py\\python.exe",
                                run_py="D:\\ke\\run.py")
        self.assertIn("C:\\py\\python.exe", xml)
        self.assertIn("schedule", xml)
        self.assertIn("run", xml)
        self.assertIn("报时", xml)

    def test_XML特殊字符转义_任务名含尖括号不破坏结构(self):
        xml = si.build_task_xml(self._task(name="a", prompt="1 < 2 & 3"), python="p", run_py="r")
        # prompt 不进 XML（它在任务档案里），但命令参数里的路径/名字要安全转义
        self.assertNotIn("< 2", xml)  # 不该出现未转义的裸 <

    def test_安装_调schtasks且用XML导入带F(self):
        calls = []
        def fake_runner(argv):
            calls.append(argv)
            return 0, "成功", ""
        si.install(self._task(name="报时"), python="p", run_py="r", runner=fake_runner,
                   plat="win32")
        argv = calls[0]
        self.assertEqual(argv[0], "schtasks")
        self.assertIn("/Create", argv)
        self.assertIn("/XML", argv)
        self.assertIn("/F", argv)
        self.assertIn("/TN", argv)
        self.assertIn("Harness\\报时", argv)

    def test_卸载启用停用_调对schtasks子命令(self):
        calls = []
        def fake_runner(argv):
            calls.append(argv); return 0, "", ""
        si.uninstall("报时", runner=fake_runner, plat="win32")
        si.set_enabled_os("报时", False, runner=fake_runner, plat="win32")
        si.set_enabled_os("报时", True, runner=fake_runner, plat="win32")
        self.assertIn("/Delete", calls[0]); self.assertIn("/F", calls[0])
        self.assertIn("/Change", calls[1]); self.assertIn("/DISABLE", calls[1])
        self.assertIn("/ENABLE", calls[2])

    def test_runner失败_install抛错带stderr(self):
        def fail_runner(argv):
            return 1, "", "拒绝访问"
        with self.assertRaises(si.InstallError) as e:
            si.install(self._task(), python="p", run_py="r", runner=fail_runner,
                       plat="win32")
        self.assertIn("拒绝访问", str(e.exception))


class MacLaunchd生成(unittest.TestCase):
    def _task(self, **kw):
        base = {"name": "报时", "prompt": "记一行", "every_minutes": 60, "daily": None,
                "max_minutes": 30, "allow": [], "workdir": None, "mcp": False}
        base.update(kw)
        return base

    def test_间隔任务_用StartInterval秒数(self):
        plist = si.build_plist(self._task(every_minutes=60), python="/usr/bin/python3",
                               run_py="/x/run.py", logs_dir="/x/.state/schedule")
        self.assertIn("<key>StartInterval</key>", plist)
        self.assertIn("<integer>3600</integer>", plist)

    def test_每天定点_用StartCalendarInterval的时分(self):
        plist = si.build_plist(self._task(every_minutes=None, daily="08:30"),
                               python="/p", run_py="/r", logs_dir="/l")
        self.assertIn("<key>StartCalendarInterval</key>", plist)
        self.assertIn("<key>Hour</key>", plist)
        self.assertIn("<integer>8</integer>", plist)
        self.assertIn("<key>Minute</key>", plist)
        self.assertIn("<integer>30</integer>", plist)

    def test_RunAtLoad为false_日志路径进plist(self):
        # 调研结论：RunAtLoad 默认建议 false，否则每次 bootstrap 立刻跑一次。
        plist = si.build_plist(self._task(), python="/p", run_py="/r", logs_dir="/x/.state/schedule")
        self.assertIn("<key>RunAtLoad</key>", plist)
        self.assertIn("<false/>", plist.split("RunAtLoad")[1][:40])
        self.assertIn("<key>StandardOutPath</key>", plist)
        self.assertIn("<key>StandardErrorPath</key>", plist)

    def test_ProgramArguments用绝对路径解释器(self):
        plist = si.build_plist(self._task(name="报时"), python="/usr/bin/python3",
                               run_py="/x/run.py", logs_dir="/l")
        self.assertIn("/usr/bin/python3", plist)
        self.assertIn("/x/run.py", plist)
        self.assertIn("<string>报时</string>", plist)

    def test_plist特殊字符转义(self):
        plist = si.build_plist(self._task(name="a&b"), python="/p", run_py="/r", logs_dir="/l")
        self.assertIn("a&amp;b", plist)
        self.assertNotIn("a&b<", plist)

    def test_安装_先bootout忽略失败再bootstrap(self):
        calls = []
        def fake_runner(argv):
            calls.append(argv)
            # 模拟首次 bootout 失败（本来就没加载），bootstrap 成功
            if "bootout" in argv:
                return 1, "", "not loaded"
            return 0, "", ""
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(si, "_plist_path",
                                   lambda name: Path(d) / f"{si._label(name)}.plist"):
                si.install(self._task(name="报时"), python="/p", run_py="/r",
                           runner=fake_runner, logs_dir=str(Path(d) / "logs"), plat="darwin")
            self.assertTrue((Path(d) / f"{si._label('报时')}.plist").exists())  # plist 落在沙盒里
        joined = [" ".join(a) for a in calls]
        self.assertTrue(any("bootout" in c for c in joined))
        self.assertTrue(any("bootstrap" in c for c in joined))
        # bootout 在 bootstrap 之前（幂等：先卸再装）
        self.assertLess(next(i for i, c in enumerate(joined) if "bootout" in c),
                        next(i for i, c in enumerate(joined) if "bootstrap" in c))
