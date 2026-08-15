"""M3 双平台安装器：把任务装进 Windows 任务计划（schtasks /XML）/ macOS launchd（LaunchAgent）。

设计（见 2026-07-03-m3-scheduling-design.md §7 + 调研结论）：
- 生成内容（XML/plist）与「真正执行 schtasks/launchctl」分离——后者是可注入的 runner，
  单测断言生成内容与调用参数，不真装。
- Windows 坑：电池策略默认 true 必须显式关；周期走 /XML 的 Repetition Interval（ISO8601）；
  MultipleInstancesPolicy=IgnoreNew（系统层也防重叠）；StartWhenAvailable=true（关机错过补跑）；
  schtasks 输出是 OEM/GBK 编码，runner 按 GBK 解码。
- macOS 坑：launchctl bootstrap 对已加载服务报错——先 bootout（忽略失败）再 bootstrap；
  RunAtLoad=false（否则每次加载立即跑一次）；ProgramArguments 用绝对路径解释器（PATH 几乎为空）。

边界（写进契约）：不带凭据的用户级任务通常仅「用户已登录」时运行——「重启照跑」= 重启并登录后照跑。
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from xml.sax.saxutils import escape

from . import config

_TN_PREFIX = "Harness"                    # 任务计划里的文件夹前缀：Harness\<name>
_LABEL_PREFIX = "com.harness."            # launchd label 前缀：com.harness.<name>


class InstallError(Exception):
    """安装/卸载系统调度器失败（带上系统命令的 stderr 便于排障）。"""


# —— 通用 —— #

def _abs_python() -> str:
    return sys.executable


def _abs_run_py() -> str:
    return str(config.ROOT / "run.py")


def _default_runner_win(argv: list[str]) -> tuple[int, str, str]:
    # schtasks 输出走系统 OEM 代码页（简体中文为 GBK）——按 GBK 解码，避免 UTF-8 解码乱码
    p = subprocess.run(argv, capture_output=True, timeout=60)
    dec = lambda b: b.decode("gbk", errors="replace") if b else ""
    return p.returncode, dec(p.stdout), dec(p.stderr)


def _default_runner_posix(argv: list[str]) -> tuple[int, str, str]:
    p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=60)
    return p.returncode, p.stdout or "", p.stderr or ""


# —— Windows：任务计划 XML —— #

def build_task_xml(task: dict, python: str, run_py: str) -> str:
    """按任务节奏生成任务计划 XML（Repetition 间隔 或 CalendarTrigger 每天定点）。"""
    ns = "http://schemas.microsoft.com/windows/2004/02/mit/task"
    if task.get("every_minutes"):
        mins = int(task["every_minutes"])
        iso = f"PT{mins // 60}H" if mins % 60 == 0 and mins >= 60 else f"PT{mins}M"
        trigger = (
            "    <TimeTrigger>\n"
            "      <StartBoundary>2026-01-01T00:00:00</StartBoundary>\n"
            "      <Enabled>true</Enabled>\n"
            "      <Repetition>\n"
            f"        <Interval>{iso}</Interval>\n"
            "        <StopAtDurationEnd>false</StopAtDurationEnd>\n"
            "      </Repetition>\n"
            "    </TimeTrigger>\n")
    else:
        hh, mm = task["daily"].split(":")
        trigger = (
            "    <CalendarTrigger>\n"
            f"      <StartBoundary>2026-01-01T{hh}:{mm}:00</StartBoundary>\n"
            "      <Enabled>true</Enabled>\n"
            "      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>\n"
            "    </CalendarTrigger>\n")
    args = f'schedule run "{task["name"]}"'
    return (
        '<?xml version="1.0" encoding="UTF-16"?>\n'
        f'<Task version="1.3" xmlns="{ns}">\n'
        "  <RegistrationInfo>\n"
        f"    <Description>{escape(task.get('prompt', '')[:120])}</Description>\n"
        "  </RegistrationInfo>\n"
        "  <Triggers>\n" + trigger + "  </Triggers>\n"
        "  <Settings>\n"
        "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n"
        "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n"
        "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n"
        "    <StartWhenAvailable>true</StartWhenAvailable>\n"
        "    <Enabled>true</Enabled>\n"
        f"    <ExecutionTimeLimit>PT{int(task.get('max_minutes', 30)) + 5}M</ExecutionTimeLimit>\n"
        "  </Settings>\n"
        "  <Actions>\n"
        "    <Exec>\n"
        f"      <Command>{escape(python)}</Command>\n"
        f"      <Arguments>{escape(f'\"{run_py}\" ' + args)}</Arguments>\n"
        f"      <WorkingDirectory>{escape(str(config.ROOT))}</WorkingDirectory>\n"
        "    </Exec>\n"
        "  </Actions>\n"
        "</Task>\n")


def _tn(name: str) -> str:
    return f"{_TN_PREFIX}\\{name}"


# —— macOS：launchd plist —— #

def _label(name: str) -> str:
    return _LABEL_PREFIX + name


def build_plist(task: dict, python: str, run_py: str, logs_dir: str) -> str:
    """生成 LaunchAgent plist（StartInterval 秒 或 StartCalendarInterval 时分）。"""
    label = _label(task["name"])
    if task.get("every_minutes"):
        sched = f"  <key>StartInterval</key>\n  <integer>{int(task['every_minutes']) * 60}</integer>\n"
    else:
        hh, mm = task["daily"].split(":")
        sched = ("  <key>StartCalendarInterval</key>\n  <dict>\n"
                 f"    <key>Hour</key><integer>{int(hh)}</integer>\n"
                 f"    <key>Minute</key><integer>{int(mm)}</integer>\n  </dict>\n")
    out_log = str(Path(logs_dir) / f"{task['name']}.out.log")
    err_log = str(Path(logs_dir) / f"{task['name']}.err.log")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        '<plist version="1.0">\n<dict>\n'
        f"  <key>Label</key>\n  <string>{escape(label)}</string>\n"
        "  <key>ProgramArguments</key>\n  <array>\n"
        f"    <string>{escape(python)}</string>\n"
        f"    <string>{escape(run_py)}</string>\n"
        "    <string>schedule</string>\n    <string>run</string>\n"
        f"    <string>{escape(task['name'])}</string>\n  </array>\n"
        + sched +
        "  <key>RunAtLoad</key>\n  <false/>\n"
        f"  <key>WorkingDirectory</key>\n  <string>{escape(str(config.ROOT))}</string>\n"
        f"  <key>StandardOutPath</key>\n  <string>{escape(out_log)}</string>\n"
        f"  <key>StandardErrorPath</key>\n  <string>{escape(err_log)}</string>\n"
        "</dict>\n</plist>\n")


def _plist_path(name: str) -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{_label(name)}.plist"


def _uid() -> int:
    return getattr(os, "getuid", lambda: 0)()  # Windows 上跑 darwin 分支的单测不炸（os.getuid 仅 POSIX）


# —— 五操作对外接口 —— #

def _platform() -> str:
    return sys.platform


def install(task: dict, python: str | None = None, run_py: str | None = None,
            runner=None, logs_dir: str | None = None, plat: str | None = None) -> None:
    """把任务装进系统调度器（幂等：已存在先删/卸再装）。失败抛 InstallError。"""
    python = python or _abs_python()
    run_py = run_py or _abs_run_py()
    plat = plat or _platform()
    name = task["name"]
    if plat == "darwin":
        runner = runner or _default_runner_posix
        logs_dir = logs_dir or str(config.ROOT / ".state" / "schedule" / "logs")
        Path(logs_dir).mkdir(parents=True, exist_ok=True)
        pp = _plist_path(name)
        pp.parent.mkdir(parents=True, exist_ok=True)
        pp.write_text(build_plist(task, python, run_py, logs_dir), encoding="utf-8")
        uid = _uid()
        runner(["launchctl", "bootout", f"gui/{uid}/{_label(name)}"])  # 忽略失败：本来没加载
        rc, out, err = runner(["launchctl", "bootstrap", f"gui/{uid}", str(pp)])
        if rc != 0:
            raise InstallError(f"launchctl bootstrap 失败：{err or out}")
    else:
        runner = runner or _default_runner_win
        import tempfile
        # XML 用 UTF-16 落盘（schtasks /XML 的编码要求）
        fd, xmlpath = tempfile.mkstemp(suffix=".xml")
        try:
            with os.fdopen(fd, "w", encoding="utf-16") as f:
                f.write(build_task_xml(task, python, run_py))
            rc, out, err = runner(["schtasks", "/Create", "/TN", _tn(name),
                                   "/XML", xmlpath, "/F"])
            if rc != 0:
                raise InstallError(f"schtasks /Create 失败：{err or out}")
        finally:
            try:
                os.unlink(xmlpath)
            except OSError:
                pass


def uninstall(name: str, runner=None, plat: str | None = None) -> None:
    plat = plat or _platform()
    if plat == "darwin":
        runner = runner or _default_runner_posix
        runner(["launchctl", "bootout", f"gui/{_uid()}/{_label(name)}"])
        try:
            _plist_path(name).unlink()
        except OSError:
            pass
    else:
        runner = runner or _default_runner_win
        runner(["schtasks", "/Delete", "/TN", _tn(name), "/F"])


def set_enabled_os(name: str, enabled: bool, runner=None, plat: str | None = None) -> None:
    plat = plat or _platform()
    if plat == "darwin":
        runner = runner or _default_runner_posix
        sub = "enable" if enabled else "disable"
        runner(["launchctl", sub, f"gui/{_uid()}/{_label(name)}"])
    else:
        runner = runner or _default_runner_win
        runner(["schtasks", "/Change", "/TN", _tn(name),
                "/ENABLE" if enabled else "/DISABLE"])
