"""后台任务（阶段3 + M4 跨重启·语义A）：把慢活丢后台跑，主线不卡着等。

start() 用 subprocess.Popen 非阻塞启动命令，自成进程组（便于连孙进程一起终止），
输出重定向到 .state/jobs/<id>.log；任务档案（命令/pid/日志/状态）落 .state/jobs/<id>.json。
status()/list_jobs() 既查本会话在跑的、也能从盘上查历史（重启后仍可查输出与状态）。
reconcile() 在启动时核对：running 记录若 pid 已死 → 纠为 interrupted，并清理超限旧记录。
shutdown() 挂 atexit：终止所有还在跑的后台任务（两阶段杀，不留孤儿进程），把其记录落成
interrupted 并**保留日志**供下次查。

语义 A（用户 2026-07-09 拍板）：记录跨重启、进程不跨——退出仍干净收掉在跑任务，不引入
无人值守 detached 进程；detach（睡前起长任务次日拿结果）留到 P6 连墙钟硬超时一起做。
"""
from __future__ import annotations

import atexit
import itertools
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from . import _io, config, ui_bus

_JOBS: dict = {}                       # 本会话在跑的 job：{jid: {proc, command, log_path}}
_counter = itertools.count(1)
JOBS_DIR = config.ROOT / ".state" / "jobs"
_MAX_JOB_RECORDS = 200                 # 落盘记录保留上限（超了清最老的终态记录）
_MAX_RUNNING = 32                      # 并发在跑上限（#42 硬背压）：满了拒起，别把资源耗尽
_KILL_GRACE_S = 5                      # SIGTERM 后的宽限秒数，超过还没死就升级 SIGKILL


def _popen_kwargs() -> dict:
    if sys.platform == "win32":
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}  # 自成进程组，kill 时能连孙进程一起收


def _sig(proc, force: bool) -> None:
    """给进程(组)发信号：温柔=SIGTERM/taskkill，force=SIGKILL/taskkill /F。已退出/出错都吞掉。"""
    try:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/T", "/PID", str(proc.pid)] + (["/F"] if force else []),
                           capture_output=True)  # /T 连子孙；/F 强杀
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL if force else signal.SIGTERM)
    except Exception:
        try:
            (proc.kill if force else proc.terminate)()
        except Exception:
            pass


def _terminate(proc) -> None:
    """两阶段杀一个进程树（#20）：SIGTERM → 宽限轮询 → 仍活则 SIGKILL 兜底，别留孤儿。"""
    if proc.poll() is not None:
        return
    _sig(proc, force=False)
    deadline = time.monotonic() + _KILL_GRACE_S
    while time.monotonic() < deadline and proc.poll() is None:
        time.sleep(0.1)
    if proc.poll() is None:
        _sig(proc, force=True)
        try:
            proc.wait(timeout=2)  # SIGKILL 后收尸，避免 ResourceWarning
        except Exception:
            pass


# —— 落盘档案 —— #

def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _rec_path(jid: str) -> Path:
    return JOBS_DIR / f"{jid}.json"


def _log_path(jid: str) -> Path:
    return JOBS_DIR / f"{jid}.log"


def _read_rec(jid: str) -> dict | None:
    try:
        return json.loads(_rec_path(jid).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None


def _write_rec(rec: dict) -> None:
    _io.atomic_write_json(_rec_path(rec["id"]), rec)


def _ui_job_update() -> None:
    """UI 观测层（SPEC §6.6）：状态翻转直发 job.update——总线未 init 时零开销 no-op，异常吞掉。"""
    try:
        if not ui_bus.initialized():
            return
        ui_bus.emit("job.update", {"jobs": list_jobs()})
    except Exception:
        pass


def _finalize(jid: str, status: str, rc) -> None:
    """把记录落成终态（done/failed/interrupted）——只在当前还是 running 时改，别覆盖已终态。"""
    rec = _read_rec(jid)
    if rec is None or rec.get("status") != "running":
        return
    rec.update(status=status, returncode=rc, ended_at=_now())
    _write_rec(rec)
    _ui_job_update()   # 终态翻转（done/failed/interrupted 全经此漏斗，含 reconcile 纠正）


def _pid_alive(pid) -> bool:
    """子进程是否还活着（跨平台探活，不真发信号）。jobs 自带一份，不反向依赖 schedule。"""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if sys.platform == "win32":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}"],
                             capture_output=True, text=True)
        return str(pid) in (out.stdout or "")
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True   # 存在但不属我们——仍算活着
    except OSError:
        return False


def _tail(log_path, n: int = 2000) -> str:
    try:
        # 日志字节是子进程真实编码（中文 Windows 的 cmd 子进程常吐 GBK）——走共享回退链
        # （utf-8 严格 → mbcs → 替换符兜底），别 utf-8+replace 硬读把中文全毁成 �
        return _io.decode_cmd_output(Path(log_path).read_bytes())[-n:]
    except OSError:
        return ""


def _new_job_id() -> str:
    # 时间戳 + pid + 进程内序号：跨重启也唯一，历史记录不互相覆盖。
    return f"job-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{os.getpid()}-{next(_counter)}"


def list_jobs() -> list[dict]:
    """列出落盘的任务记录（含历史），按开始时间排。"""
    if not JOBS_DIR.exists():
        return []
    recs = []
    for p in JOBS_DIR.glob("job-*.json"):
        try:
            recs.append(json.loads(p.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            pass
    return sorted(recs, key=lambda r: r.get("started_at", ""))


def _evict_records() -> None:
    """超上限时清理最老的、已终态的记录（连日志一起删；running 的绝不动）。"""
    recs = list_jobs()
    excess = len(recs) - _MAX_JOB_RECORDS
    if excess <= 0:
        return
    terminal = [r for r in recs if r.get("status") != "running"]
    for r in terminal[:excess]:
        _rec_path(r["id"]).unlink(missing_ok=True)
        try:
            Path(r.get("log_path", "")).unlink(missing_ok=True)
        except OSError:
            pass


def reconcile() -> None:
    """启动时核对：running 记录若 pid 已死 → 纠为 interrupted（进程随上次退出没了）；清超限旧记录。"""
    for rec in list_jobs():
        if rec.get("status") == "running" and not _pid_alive(rec.get("pid")):
            _finalize(rec["id"], "interrupted", None)
    _evict_records()


def start(command: str, cwd: str, env: dict | None = None) -> str:
    """非阻塞启动一条命令，返回 job_id。输出写进落盘日志；任务档案落盘（重启后可查）。

    env 由调用方（tools 层）从会话 ctx['_child_env'] 透传（D1-1b 出网管控）；默认 None = 继承现状，
    与旧行为逐字节等价（评审必修）。"""
    running = sum(1 for j in _JOBS.values() if j["proc"].poll() is None)
    if running >= _MAX_RUNNING:  # #42 硬背压：并发在跑到顶就拒起（别静默耗尽资源），友好报错由工具层转 is_error
        raise RuntimeError(f"后台任务已达并发上限（{_MAX_RUNNING} 个在跑），先等一些跑完再起新的。")
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    jid = _new_job_id()
    log = _log_path(jid)
    f = open(log, "w", encoding="utf-8")
    try:
        proc = subprocess.Popen(command, shell=True, cwd=cwd, stdout=f,
                                stderr=subprocess.STDOUT, env=env, **_popen_kwargs())
    except BaseException:  # 起不来（坏命令/句柄耗尽）：先关文件（Windows 删不了打开的文件）再删空日志，别留孤儿
        f.close()
        try:
            os.unlink(log)
        except OSError:
            pass
        raise
    else:
        f.close()  # 子进程已复制 fd，父进程这份关掉不影响子进程继续写
    _JOBS[jid] = {"proc": proc, "command": command, "log_path": str(log)}
    _write_rec({"id": jid, "command": command, "pid": proc.pid, "log_path": str(log),
                "status": "running", "started_at": _now(), "returncode": None, "ended_at": None})
    _ui_job_update()   # 启动翻转 running
    _evict_records()
    return jid


def status(job_id: str) -> dict:
    """查一个后台任务：本会话在跑的 poll 活进程；否则从盘上查（重启后仍可查历史/输出/状态）。"""
    job = _JOBS.get(job_id)
    if job:
        rc = job["proc"].poll()
        if rc is not None:  # 刚跑完：把记录落成终态
            _finalize(job_id, "done" if rc == 0 else "failed", rc)
        return {"ok": True, "running": rc is None, "returncode": rc,
                "output_tail": _tail(job["log_path"]), "command": job["command"],
                "status": "running" if rc is None else ("done" if rc == 0 else "failed")}
    rec = _read_rec(job_id)  # 不在本会话 → 盘上查
    if rec is None:
        return {"ok": False, "error": f"没有这个后台任务：{job_id}"}
    running = rec.get("status") == "running" and _pid_alive(rec.get("pid"))
    return {"ok": True, "running": running, "returncode": rec.get("returncode"),
            "output_tail": _tail(rec.get("log_path")), "command": rec.get("command"),
            "status": rec.get("status")}


def shutdown() -> None:
    """终止所有还在跑的后台任务（两阶段杀，不留孤儿进程），记录落成 interrupted 并保留日志。"""
    # 两趟收敛（#20）：先给所有存活进程广播 SIGTERM（不逐个等），一个宽限期后仍活的批量 SIGKILL。
    alive = []
    for jid in list(_JOBS):
        job = _JOBS.get(jid)
        if job and job["proc"].poll() is None:
            _sig(job["proc"], force=False)
            alive.append(job["proc"])
    deadline = time.monotonic() + _KILL_GRACE_S
    while time.monotonic() < deadline and any(p.poll() is None for p in alive):
        time.sleep(0.1)
    for proc in alive:
        if proc.poll() is None:
            _sig(proc, force=True)
    for jid in list(_JOBS):
        job = _JOBS.get(jid)
        if not job:
            continue
        try:
            job["proc"].wait(timeout=2)  # 收尸，避免 ResourceWarning
        except Exception:
            pass
        if "log_path" in job:  # 真 job（非测试注入）：还在 running 的记录落成 interrupted，日志保留供下次查
            _finalize(jid, "interrupted", None)
    _JOBS.clear()


atexit.register(shutdown)
