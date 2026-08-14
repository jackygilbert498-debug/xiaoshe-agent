"""定时调度（M3）：任务登记落盘 + 薄监工执行 + 执行历史。系统调度器安装见 _install_* 后端。

形态（见 docs/superpowers/specs/2026-07-03-m3-scheduling-design.md）：
- 系统调度器（任务计划/launchd）到点唤起 `run.py schedule run <名>`；
- 监工不跑模型：查 killswitch/enabled → 按任务名拿非阻塞锁（防重入）→ 落 pidfile →
  起子进程（M2 无头，白名单/硬护栏全复用）→ 墙钟超时两阶段杀 → 写执行历史。
- 任务档案只能由人敲 `schedule add` 产生；`.state/schedule/` 对 agent 设防（permission）。

监工退出码：0=done/跳过（跳过不算失败）；1=failed；124=timeout（GNU timeout 惯例）；130=被 Ctrl+C。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

from . import _io, config

SCHEDULE_DIR = config.STATE_DIR / "schedule"
TASKS_DIR = SCHEDULE_DIR / "tasks"
HISTORY_DIR = SCHEDULE_DIR / "history"
RUNNING_DIR = SCHEDULE_DIR / "running"

KILLSWITCH_ENV = "HARNESS_DISABLE_SCHEDULE"  # =1 时一切定时执行一票停摆（抄 Kimi 的 KIMI_DISABLE_CRON）
_NAME_RE = re.compile(r"^[\w一-鿿-]{1,40}$")  # 字母数字下划线中文连字符：防路径穿越（抄 Kimi id 白名单思路）
_MAX_TASKS = 50            # 任务数上限（抄 Kimi 会话内 cron 上限）
_MAX_PROMPT_BYTES = 8192   # prompt 按 UTF-8 字节封顶（抄 Kimi：防按字符数低估中文）
_DEFAULT_MAX_MINUTES = 30  # 墙钟总超时默认值（Kimi 子 agent 同款 30 分钟）
_MAX_MAX_MINUTES = 24 * 60
_KILL_GRACE_S = 5          # 两阶段杀的宽限（SIGTERM→5s→SIGKILL，Kimi 同款）
_TAIL_CHARS = 500          # 历史里保留的输出尾部长度
_MAX_HISTORY_LINES = 2000  # 执行历史行数上限（#26）：超了锁内轮转，防长期任务把 history 撑到无限大
_KEEP_HISTORY_LINES = 1500 # 轮转后保留的最近行数（留水位差，别每次 append 都重写）


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


# —— 节奏表达 —— #

def parse_every(text: str) -> int:
    """'30m'/'2h' → 分钟数（1 分钟 ~ 24 小时）。"""
    m = re.fullmatch(r"(\d+)([mh])", (text or "").strip().lower())
    if not m:
        raise ValueError(f"--every 要写成 30m / 1h 这样：{text!r}")
    minutes = int(m.group(1)) * (60 if m.group(2) == "h" else 1)
    if not 1 <= minutes <= 24 * 60:
        raise ValueError(f"--every 需在 1 分钟到 24 小时之间：{text!r}")
    return minutes


def parse_daily(text: str) -> str:
    """'HH:MM' 校验并规整（24 小时制）。"""
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", (text or "").strip())
    if not m or not (0 <= int(m.group(1)) <= 23 and 0 <= int(m.group(2)) <= 59):
        raise ValueError(f"--daily 要写成 08:30 这样的 24 小时制：{text!r}")
    return f"{int(m.group(1)):02d}:{m.group(2)}"


# —— 任务档案 —— #

def _task_path(name: str) -> Path:
    return TASKS_DIR / f"{name}.json"


def _save_task(task: dict) -> None:
    _io.atomic_write_json(_task_path(task["name"]), task, indent=2)


def add_task(name: str, prompt: str, every: str | None = None, daily: str | None = None,
             allow: tuple[str, ...] = (), workdir: str | None = None,
             max_minutes: float = _DEFAULT_MAX_MINUTES, mcp: bool = False,
             task_id: str | None = None, policy_id: str | None = None) -> dict:
    """建任务档案（人敲命令行的那一刻 = 审批那一刻）。校验全部往严处收，非法即拒。"""
    if not _NAME_RE.fullmatch(name or ""):
        raise ValueError("任务名只能是 1~40 个中文/字母/数字/下划线/连字符（防路径穿越）")
    if not (prompt or "").strip():
        raise ValueError("任务内容（prompt）不能为空")
    if len(prompt.encode("utf-8")) > _MAX_PROMPT_BYTES:
        raise ValueError(f"任务内容超过 {_MAX_PROMPT_BYTES} 字节上限（防档案膨胀）")
    if (every is None) == (daily is None):
        raise ValueError("节奏必须二选一：--every 30m/1h 或 --daily HH:MM")
    if not 1 <= float(max_minutes) <= _MAX_MAX_MINUTES:
        raise ValueError(f"--max-minutes 需在 1 到 {_MAX_MAX_MINUTES} 之间")
    if _task_path(name).exists():
        raise ValueError(f"任务「{name}」已存在——先 schedule remove 再重建")
    TASKS_DIR.mkdir(parents=True, exist_ok=True)
    if len(list(TASKS_DIR.glob("*.json"))) >= _MAX_TASKS:
        raise ValueError(f"任务数已达上限 {_MAX_TASKS} 个——清掉不用的再建")
    if (task_id is None) != (policy_id is None):
        raise ValueError("--task-id 与 --policy-id 必须同时提供")
    if task_id is not None and (not isinstance(task_id, str) or not task_id.startswith("tsk_")):
        raise ValueError("--task-id 必须是有效的 tsk_ 任务 ID")
    if policy_id is not None and not (isinstance(policy_id, str) and policy_id.strip()):
        raise ValueError("--policy-id 不能为空")
    task = {"name": name, "prompt": prompt, "allow": list(allow),
            "workdir": workdir, "mcp": bool(mcp),
            "every_minutes": parse_every(every) if every else None,
            "daily": parse_daily(daily) if daily else None,
            "max_minutes": float(max_minutes), "enabled": True, "created_at": _now(),
            # No binding preserves the historical direct-headless behavior.
            # A binding is explicit opt-in and is only enqueued by run_task.
            "task_id": task_id, "policy_id": policy_id}
    _save_task(task)
    return task


def load_task(name: str) -> dict | None:
    """读任务档案。解析失败 → None（配置解析失败往严处收：拒绝执行而不是猜）。"""
    p = _task_path(name)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        _io.warn(f"[!] 任务档案损坏，拒绝执行：{p}")
        return None
    if not (isinstance(data, dict) and data.get("name") == name and str(data.get("prompt", "")).strip()):
        _io.warn(f"[!] 任务档案内容非法，拒绝执行：{p}")
        return None
    return data


def list_tasks() -> list[dict]:
    if not TASKS_DIR.exists():
        return []
    out = []
    for p in sorted(TASKS_DIR.glob("*.json")):
        t = load_task(p.stem)
        if t:
            out.append(t)
    return out


def set_enabled(name: str, enabled: bool) -> bool:
    t = load_task(name)
    if not t:
        return False
    t["enabled"] = bool(enabled)
    _save_task(t)
    return True


def remove_task(name: str) -> bool:
    """档案改名 .removed（历史保留，可追溯）。"""
    p = _task_path(name)
    if not p.exists():
        return False
    try:
        p.replace(p.with_name(p.name + ".removed"))
    except OSError as e:
        _io.warn(f"[!] 任务档案移除失败：{e}")
        return False
    return True


# —— 执行历史 —— #

def _history_path(name: str) -> Path:
    return HISTORY_DIR / f"{name}.jsonl"


def append_history(name: str, record: dict) -> None:
    """追加一行执行记录（带锁：并发的 skipped 记录也不互相撕）。写失败只告警。"""
    try:
        HISTORY_DIR.mkdir(parents=True, exist_ok=True)
        p = _history_path(name)
        with _io.file_lock(p, timeout=2.0):
            with p.open("a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
            lines = p.read_text(encoding="utf-8").splitlines()  # #26 轮转：超上限锁内裁到保留水位
            if len(lines) > _MAX_HISTORY_LINES:
                p.write_text("\n".join(lines[-_KEEP_HISTORY_LINES:]) + "\n", encoding="utf-8")
    except (OSError, TimeoutError) as e:
        _io.warn(f"[!] 执行历史写入失败（不影响任务本身）：{e}")


def _consume_stop_marker(name: str, child_pid) -> bool:
    """检查并消费 .stopped 停止标记：只有标记里的 pid == 本次 child_pid 才算「被人停掉」。

    #41：标记带 pid，防陈旧标记（针对别的运行、或停止与运行结束擦肩）毒化本次——不匹配也清掉。
    """
    stopped = RUNNING_DIR / f"{name}.stopped"
    if not stopped.exists():
        return False
    try:
        marked = stopped.read_text(encoding="utf-8").strip()
    except OSError:
        marked = ""
    stopped.unlink(missing_ok=True)
    return marked == str(child_pid)


def read_history(name: str, n: int = 10) -> list[dict]:
    p = _history_path(name)
    if not p.exists():
        return []
    out = []
    try:
        for line in p.read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # 半行/坏行跳过（历史是留痕，不因一行坏全盘拒读）
    except (OSError, UnicodeDecodeError):
        return []
    return out[-n:]


# —— 监工执行 —— #

def _child_cmd(task: dict) -> list[str]:
    """构造子进程命令：复用 M2 无头入口（白名单/硬护栏/留痕全在那边）。"""
    cmd = [sys.executable, str(config.ROOT / "run.py"),
           "-p", task["prompt"], "--session-prefix", f"sched-{task['name']}-"]
    if task.get("allow"):
        cmd += ["--allow", ",".join(task["allow"])]
    if task.get("workdir"):
        cmd += ["--workdir", str(task["workdir"])]
    if not task.get("mcp"):
        cmd += ["--no-mcp"]  # 定时任务默认不连 MCP（对齐 Claude Code --bare 方向）
    return cmd


def _kill_tree(proc: subprocess.Popen) -> None:
    """两阶段杀整棵子进程树：先温柔、宽限、再强杀（Windows 没有优雅信号，直接 taskkill /T /F）。"""
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                       capture_output=True, timeout=30)
    else:
        import signal
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except OSError:
            proc.terminate()
        deadline = time.monotonic() + _KILL_GRACE_S
        while time.monotonic() < deadline and proc.poll() is None:
            time.sleep(0.1)
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                proc.kill()


def _pid_path(name: str) -> Path:
    return RUNNING_DIR / f"{name}.pid"


def _queue_bound_task(task: dict, nominal_time: datetime):
    """Emit an opt-in scheduled Task into the shared queue, never a subprocess Run."""
    from .task_store import TaskStore
    from .task_triggers import TaskingTriggerBridge
    store = TaskStore(config.ROOT / ".state" / "tasking" / "tasks.db")
    return TaskingTriggerBridge(store).schedule_fire(task["task_id"], task["name"], nominal_time, task["policy_id"])


def run_task(name: str, popen=subprocess.Popen) -> int:
    """监工：被系统调度器（或人工）唤起，跑一次任务。见模块 docstring 的退出码语义。"""
    task = load_task(name)
    if task is None:
        _io.warn(f"[!] 没有名为「{name}」的任务（schedule list 可查）。")
        return 1
    start = _now()
    t0 = time.monotonic()

    def _skip(outcome: str) -> int:
        append_history(name, {"start": start, "end": _now(), "outcome": outcome,
                              "exit_code": 0, "duration_s": 0, "denied_calls": None,
                              "session_id": None, "output_tail": ""})
        return 0

    if os.environ.get(KILLSWITCH_ENV):
        _io.warn(f"[i] {KILLSWITCH_ENV}=1，定时执行一票停摆：跳过「{name}」。")
        return _skip("skipped_killswitch")
    if not task.get("enabled", True):
        return _skip("skipped_disabled")
    RUNNING_DIR.mkdir(parents=True, exist_ok=True)
    try:
        lock = _io.file_lock(RUNNING_DIR / name, timeout=0)
        lock.__enter__()
    except TimeoutError:
        _io.warn(f"[i] 「{name}」上一次还没跑完，这次跳过（防重入）。")
        return _skip("skipped_overlap")
    except OSError as e:  # #17 锁/目录出错（权限/磁盘满/文件锁系统错）：别甩裸 traceback，落一条历史再退
        _io.warn(f"[!] 「{name}」启动失败（锁/目录出错）：{e}")
        append_history(name, {"start": start, "end": _now(), "outcome": "local_error", "exit_code": 1,
                              "duration_s": 0, "denied_calls": None, "session_id": None,
                              "output_tail": str(e)[:_TAIL_CHARS]})
        return 1  # 锁没进入，别落到下面 finally 的 lock.__exit__
    summary_file = RUNNING_DIR / f"{name}.summary.json"
    try:
        if task.get("task_id"):
            # Scheduled Task mode is a trigger, not another execution engine.
            # If the application is not running, the durable item remains
            # pending rather than pretending the OS scheduler kept a worker.
            try:
                _queue_bound_task(task, datetime.now(UTC))
            except (KeyError, ValueError) as exc:
                append_history(name, {"start": start, "end": _now(), "outcome": "failed", "exit_code": 1,
                                      "duration_s": round(time.monotonic() - t0, 1), "denied_calls": None,
                                      "session_id": None, "output_tail": str(exc)[:_TAIL_CHARS]})
                return 1
            append_history(name, {"start": start, "end": _now(), "outcome": "queued", "exit_code": 0,
                                  "duration_s": round(time.monotonic() - t0, 1), "denied_calls": None,
                                  "session_id": None, "output_tail": "已进入 TaskQueue；需保持小蛇运行以领取执行。"})
            return 0
        # 强制子进程 UTF-8 I/O：任务计划唤起时环境干净（无 PYTHONUTF8），Windows 下子进程会按
        # GBK 输出、而监工按 UTF-8 读管道 → output_tail 乱码。这里补上，两端编码对齐（真机验证发现）。
        # 但 PYTHONUTF8 只罩得住 Python 子进程，任务链里夹 cmd 内置命令仍可能吐 GBK——读侧收字节，
        # 用共享回退链（_io.decode_cmd_output）解，别再 text=True encoding=utf-8 锁死。
        env = dict(os.environ, HARNESS_RUN_SUMMARY=str(summary_file),
                   PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
        kwargs = dict(stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=str(config.ROOT),
                      env=env)
        if os.name != "nt":
            kwargs["start_new_session"] = True  # 成组，超时可 killpg 整树；Windows 用 taskkill /T
        try:
            proc = popen(_child_cmd(task), **kwargs)
        except OSError as e:  # #17 子进程起不来（坏解释器路径/句柄耗尽/可执行不存在）：落 failed 历史再退，不甩裸 traceback
            _io.warn(f"[!] 「{name}」子进程启动失败：{e}")
            append_history(name, {"start": start, "end": _now(), "outcome": "failed", "exit_code": 1,
                                  "duration_s": round(time.monotonic() - t0, 1), "denied_calls": None,
                                  "session_id": None, "output_tail": str(e)[:_TAIL_CHARS]})
            return 1  # 在大 try 内，finally 会正常清 pidfile(尚未写,missing_ok 安全)/锁
        _io.atomic_write_json(_pid_path(name), {"supervisor_pid": os.getpid(), "child_pid": proc.pid,
                                                "started_at": start})
        outcome, out = "done", b""
        try:
            out, _ = proc.communicate(timeout=float(task.get("max_minutes", _DEFAULT_MAX_MINUTES)) * 60)
            rc = proc.returncode
            if rc == 130:
                outcome = "interrupted"
            elif rc != 0:
                outcome = "failed"
        except subprocess.TimeoutExpired:
            _kill_tree(proc)
            try:
                out, _ = proc.communicate(timeout=15)  # 杀完收尸并拿到已产出的输出
            except (subprocess.TimeoutExpired, OSError):
                out = b""
            outcome, rc = "timeout", 124
        except KeyboardInterrupt:
            _kill_tree(proc)
            try:
                proc.communicate(timeout=15)
            except (subprocess.TimeoutExpired, OSError):
                pass
            outcome, rc = "interrupted", 130
        if _consume_stop_marker(name, proc.pid):  # #41：只认针对本次运行 pid 的停止标记，陈旧标记不毒化
            outcome, rc = "interrupted", 130
        summary = {}
        try:
            summary = json.loads(summary_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            pass  # 子进程没写成摘要（被杀/崩了）——历史里这两栏就是 None，如实
        append_history(name, {"start": start, "end": _now(), "outcome": outcome, "exit_code": rc,
                              "duration_s": round(time.monotonic() - t0, 1),
                              "denied_calls": summary.get("denied_calls"),
                              "session_id": summary.get("session_id"),
                              "output_tail": _io.decode_cmd_output(out or b"")[-_TAIL_CHARS:]})
        return {"done": 0, "failed": 1, "timeout": 124, "interrupted": 130}[outcome]
    finally:
        summary_file.unlink(missing_ok=True)
        _pid_path(name).unlink(missing_ok=True)
        lock.__exit__(None, None, None)


def _pid_alive(pid) -> bool:
    """子进程是否还活着（跨平台探活，不真的发信号）。缺失/非法/已消失一律 False。"""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if os.name == "nt":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}"],
                             capture_output=True, text=True, timeout=30)
        return str(pid) in (out.stdout or "")
    try:
        os.kill(pid, 0)  # 信号 0：只探活
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # 存在但不属我们——仍算活着
    except OSError:
        return False


def stop_task(name: str) -> bool:
    """急停正在跑的那一次（按 pidfile 两阶段杀子进程树）。没在跑返回 False。"""
    p = _pid_path(name)
    try:
        info = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        _io.warn(f"[i] 「{name}」现在没有在跑。")
        return False
    pid = info.get("child_pid")
    if not _pid_alive(pid):  # #31/#32：pidfile 陈旧（监工被强杀没清）/缺 child_pid——别落 .stopped 毒化下一次正常运行
        p.unlink(missing_ok=True)  # 清掉陈旧记录
        _io.warn(f"[i] 「{name}」现在没有在跑（已清理陈旧记录）。")
        return False
    (RUNNING_DIR / f"{name}.stopped").write_text(str(pid), encoding="utf-8")  # 带 child_pid：run_task 只认本次（#41）
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True, timeout=30)
    else:
        import signal
        try:
            os.killpg(int(pid), signal.SIGTERM)
        except OSError:
            pass
    _io.warn(f"[i] 已发停止指令：「{name}」（child_pid={pid}）。结果看 schedule history。")
    return True
