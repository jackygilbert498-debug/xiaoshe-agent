"""项目分组（UI 批次 B）：项目 = 会话的分组，归属映射落盘 `.state/projects.json`，不动会话存档本身。

- 形状：{"projects": [{"id": "proj-<8hex>", "name", "session_ids": [...], "created": iso}]}
- 单一归属：一个会话至多属一个项目——assign 自动把它从其他项目移出。
- 删除项目不删会话：项目记录一删，会话自然回到「未分组」。
- 坏档案不硬崩（自家状态文件纪律）：读失败/形状坏一律按空表，坏条目跳过。
- 写路径原子写（_io.atomic_write_json）；HTTP 多线程并发经模块锁串行。
"""
from __future__ import annotations

import json
import re
import secrets
import threading
from datetime import datetime
from pathlib import Path

from . import _io, config, session

PROJECTS_FILE = config.ROOT / ".state" / "projects.json"

PID_RE = re.compile(r"^proj-[0-9a-f]{8}$")
SID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")     # 与 ui_server._SID_RE 同口径（session.py 直拼文件名）
NAME_MAX = 60
_SESSIONS_LIMIT = 50                              # 与 session._MAX_SESSIONS 前台池对齐

_lock = threading.Lock()


class ProjectError(ValueError):
    """入参非法（空名/坏 id）——路由层转 400。"""


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _clean_name(name) -> str:
    if not isinstance(name, str):
        raise ProjectError("项目名必须是字符串")
    name = " ".join(name.split())                  # 压空白，防换行撕乱侧栏显示
    if not name:
        raise ProjectError("项目名不能为空")
    if len(name) > NAME_MAX:
        raise ProjectError(f"项目名超长（上限 {NAME_MAX} 字）")
    return name


def _check_pid(pid) -> str:
    if not isinstance(pid, str) or not PID_RE.match(pid):
        raise ProjectError("项目 id 非法（形如 proj-xxxxxxxx）")
    return pid


def _check_sid(sid) -> str:
    if not isinstance(sid, str) or not SID_RE.match(sid):
        raise ProjectError("会话 id 非法（仅允许字母/数字/_/-，1~64 字符）")
    return sid


def load(path=None) -> dict:
    """读项目表；文件不存在/坏 JSON/形状坏 → 空表；坏条目跳过（照会话档案纪律）。"""
    p = Path(path) if path else PROJECTS_FILE
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return {"projects": []}
    if not isinstance(data, dict) or not isinstance(data.get("projects"), list):
        return {"projects": []}
    out = []
    for pr in data["projects"]:
        if not isinstance(pr, dict):
            continue
        pid, name = pr.get("id"), pr.get("name")
        if not (isinstance(pid, str) and PID_RE.match(pid)):
            continue
        if not isinstance(name, str) or not name.strip():
            continue
        sids = pr.get("session_ids")
        if not isinstance(sids, list):
            sids = []
        seen: set = set()
        sids = [s for s in sids
                if isinstance(s, str) and SID_RE.match(s) and not (s in seen or seen.add(s))]
        out.append({"id": pid, "name": name, "session_ids": sids,
                    "created": pr.get("created") if isinstance(pr.get("created"), str) else ""})
    return {"projects": out}


def save(data: dict, path=None) -> None:
    _io.atomic_write_json(Path(path) if path else PROJECTS_FILE, data)


def _find(data: dict, pid: str) -> dict | None:
    return next((pr for pr in data["projects"] if pr["id"] == pid), None)


def create(name: str, path=None) -> dict:
    name = _clean_name(name)
    with _lock:
        data = load(path)
        pr = {"id": f"proj-{secrets.token_hex(4)}", "name": name,
              "session_ids": [], "created": _now()}
        data["projects"].append(pr)
        save(data, path)
    return pr


def rename(pid: str, name: str, path=None) -> dict | None:
    """→ 更新后的项目；项目不存在 → None。"""
    pid, name = _check_pid(pid), _clean_name(name)
    with _lock:
        data = load(path)
        pr = _find(data, pid)
        if pr is None:
            return None
        pr["name"] = name
        save(data, path)
    return pr


def delete(pid: str, path=None) -> bool:
    """删项目不删会话（会话回到未分组）。→ 项目是否存在过。"""
    pid = _check_pid(pid)
    with _lock:
        data = load(path)
        pr = _find(data, pid)
        if pr is None:
            return False
        data["projects"].remove(pr)
        save(data, path)
    return True


def assign(pid: str, sid: str, path=None) -> bool:
    """会话加进项目（单一归属：先自动从其他项目移出；幂等）。→ 项目是否存在。"""
    pid, sid = _check_pid(pid), _check_sid(sid)
    with _lock:
        data = load(path)
        pr = _find(data, pid)
        if pr is None:
            return False
        for other in data["projects"]:
            if other is not pr and sid in other["session_ids"]:
                other["session_ids"].remove(sid)
        if sid not in pr["session_ids"]:
            pr["session_ids"].append(sid)
        save(data, path)
    return True


def unassign(pid: str, sid: str, path=None) -> bool:
    """会话移出项目（幂等）。→ 项目是否存在。"""
    pid, sid = _check_pid(pid), _check_sid(sid)
    with _lock:
        data = load(path)
        pr = _find(data, pid)
        if pr is None:
            return False
        if sid in pr["session_ids"]:
            pr["session_ids"].remove(sid)
            save(data, path)
    return True


def remove_session(sid: str, path=None) -> None:
    """删除会话时清理全部项目引用；幂等。"""
    sid = _check_sid(sid)
    with _lock:
        data = load(path)
        changed = False
        for pr in data["projects"]:
            if sid in pr["session_ids"]:
                pr["session_ids"].remove(sid)
                changed = True
        if changed:
            save(data, path)


def project_of(sid: str, path=None) -> str | None:
    """会话当前归属的项目 id（无 → None）。"""
    for pr in load(path)["projects"]:
        if sid in pr["session_ids"]:
            return pr["id"]
    return None


def sessions_index(limit: int = _SESSIONS_LIMIT) -> list[dict]:
    """会话列表（含 saved_at，供侧栏按日期搜索）——同 session.list_sessions 口径加时间键。
    坏档案跳过；无头/调度档案不进列表。"""
    out = []
    for s in session.list_sessions(limit=limit):
        rec = session.load_session(s["id"]) or {}
        saved_at = rec.get("saved_at")
        out.append({**s, "saved_at": saved_at if isinstance(saved_at, str) else ""})
    return out
