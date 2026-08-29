"""UI 事件总线（M0 地基）：serve 模式的事件中枢。

纪律（SPEC v2 §1/§4）：
- 本模块不得 import 任何 harness 模块（防循环依赖）；状态快照能力由 init 注入（ui_state）。
- 未 init 时全部公开 API 安全 no-op —— 红线 3：harness 默认不注册总线，行为与基线逐字节一致。
- 线程模型：多生产者（harness 主线程 / runner 线程 / jobs 监工线程）多消费者（每 WS 客户端一队列）；
  seq 分配与缓冲入队持同一把内部锁，状态快照统一走 STATE_LOCK。
"""
from __future__ import annotations

import json
import os
import queue
import threading
from datetime import datetime
from pathlib import Path

# 状态快照锁：ui_state 快照与 harness 侧 dirty 标记共用，保证快照不撕裂（SPEC §3）
STATE_LOCK = threading.RLock()

_RING_MAX = 1000            # 事件环形缓冲（⌘K 导出日志用，SPEC §3.2/12.2）
_SUB_QUEUE_MAX = 1000       # 慢客户端保护：订阅队列满即踢出（客户端经 seq 跳空重同步）

_lock = threading.Lock()    # seq/缓冲/订阅者/未决审批表 的内部锁
_buf: list[dict] = []       # 环形事件缓冲
_subs: set[queue.Queue] = set()
_seq = 0
_sid: str | None = None
_state_dir: Path | None = None
_snapshot_fn = None         # init 注入：fn(ctx, dirty_keys: list[str]) -> list[(channel, payload)]
_ready = False

_pending: dict[str, dict] = {}        # request_id -> {"req": dict, "event": threading.Event, "verdict": object}
_pending_file: Path | None = None

_DIRTY_KEYS = {             # 合法 dirty 子树键（SPEC §4）
    "todos", "notes", "vision_pending", "approved_tools", "denied_calls",
    "stall", "usage", "viewport", "jobs", "subagents", "pick_diff", "compaction",
    "run_active", "tool_round",
}


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def init(ctx: dict, sid: str, state_dir: Path, snapshot_fn=None) -> None:
    """serve 启动时调用一次。snapshot_fn 由 ui_state 提供：吃 dirty 键列表，吐 (channel, payload) 列表。"""
    global _sid, _state_dir, _snapshot_fn, _pending_file, _ready, _seq
    with _lock:
        _sid = sid
        _state_dir = Path(state_dir)
        _snapshot_fn = snapshot_fn
        _pending_file = _state_dir / "ui_pending_approval.json"
        _seq = 0
        _buf.clear()
        _ready = True
    ctx.setdefault("_ui_dirty", set())


def initialized() -> bool:
    return _ready


def shutdown() -> None:
    """serve 收尾：总线归零（不结案未决审批——那是 close_all_pending 的职责）。"""
    global _ready, _sid, _snapshot_fn, _pending_file
    with _lock:
        _ready = False
        _sid = None
        _snapshot_fn = None
        _pending_file = None
        _subs.clear()
        _buf.clear()


# ---------------------------------------------------------------- 事件发送

def _envelope(type_: str, payload: dict) -> dict:
    global _seq
    with _lock:
        _seq += 1
        env = {"v": 1, "seq": _seq, "ts": _now(), "type": type_, "sid": _sid, "payload": payload}
        _buf.append(env)
        if len(_buf) > _RING_MAX:
            del _buf[: len(_buf) - _RING_MAX]
    return env


def _broadcast(env: dict) -> None:
    dead = []
    with _lock:
        subs = list(_subs)
    for q in subs:
        try:
            q.put_nowait(env)
        except queue.Full:
            dead.append(q)      # 慢客户端踢出，等它重连重同步
            try:
                q.get_nowait()          # 队列已满：腾一格投哨兵（客户端反正已掉队，丢一条无妨）
                q.put_nowait(None)      # Y3：哨兵——_ws_sender 收到即 close(1001) 令其重连重同步
            except Exception:
                pass
        except Exception:
            dead.append(q)
    if dead:
        with _lock:
            for q in dead:
                _subs.discard(q)


_flushing = threading.local()


def emit(type_: str, payload: dict) -> None:
    """派发一条下行事件（自动先 flush dirty 子树）。任何异常吞掉——观测层绝不阻塞（红线 6）。"""
    if not _ready:
        return
    try:
        if not getattr(_flushing, "on", False):
            ctx = _current_ctx()
            if ctx is not None:
                flush(ctx)
    except Exception:
        pass
    try:
        _broadcast(_envelope(type_, payload))
    except Exception:
        pass


def _emit_direct(type_: str, payload: dict) -> None:
    """flush 内部用：直接发，不递归触发 flush。"""
    try:
        _broadcast(_envelope(type_, payload))
    except Exception:
        pass


# ---------------------------------------------------------------- dirty 汇聚

def mark_dirty(ctx: dict, *keys: str) -> None:
    """在状态变更点打点（一行，fail-soft）。合法键见 _DIRTY_KEYS；非法键静默忽略。"""
    if not _ready or ctx is None:
        return
    try:
        with STATE_LOCK:
            d = ctx.setdefault("_ui_dirty", set())
            for k in keys:
                if k in _DIRTY_KEYS:
                    d.add(k)
    except Exception:
        pass


def flush(ctx: dict) -> None:
    """把 dirty 子树经注入的快照函数换算成 state.patch / viewport.update / job.update / subagent.update 广播。"""
    if not _ready or ctx is None or _snapshot_fn is None:
        return
    if getattr(_flushing, "on", False):
        return
    try:
        with STATE_LOCK:
            dirty = ctx.get("_ui_dirty") or set()
            if not dirty:
                return
            keys = sorted(dirty)
            dirty.clear()
        _flushing.on = True
        try:
            patches = _snapshot_fn(ctx, keys) or []
        finally:
            _flushing.on = False
        for channel, payload in patches:
            _emit_direct(channel, payload)
    except Exception:
        pass


# ---------------------------------------------------------------- 订阅（WS 客户端）

def subscribe() -> queue.Queue:
    q: queue.Queue = queue.Queue(maxsize=_SUB_QUEUE_MAX)
    with _lock:
        _subs.add(q)
    return q


def unsubscribe(q: queue.Queue) -> None:
    with _lock:
        _subs.discard(q)


def ring_buffer() -> list[dict]:
    """1000 条环形事件缓冲快照（导出日志用）。"""
    with _lock:
        return list(_buf)


def current_seq() -> int:
    with _lock:
        return _seq


# ---------------------------------------------------------------- 未决审批（SPEC §8）

def register_approval(req: dict) -> None:
    """登记未决审批 + 落 .state/ui_pending_approval.json（原子写，0600：含路径等敏感参数）。"""
    if not _ready:
        return
    rid = req.get("request_id")
    if not rid:
        return
    with _lock:
        _pending[rid] = {"req": dict(req), "event": threading.Event(), "verdict": None}
        _persist_pending()


def wait_verdict(ctx: dict, request_id: str, poll: float = 0.3):
    """审批等待方（runner 线程内调用）：轮询等回执，保 Ctrl+C/中断可打断。
    返回四值之一：True / "always" / "persist" / False（fail-closed，SPEC §8-3）。"""
    entry = _pending.get(request_id)
    if entry is None:
        return False
    ev: threading.Event = entry["event"]
    while True:
        try:
            if ev.wait(timeout=poll):
                return entry["verdict"] if entry["verdict"] is not None else False
        except KeyboardInterrupt:
            resolve_approval(request_id, False)     # 中断 = 以 n 结案并记日志（fail-closed）
            raise
        cancel = ctx.get("_cancel_event") if isinstance(ctx, dict) else None
        if cancel is not None and getattr(cancel, "is_set", lambda: False)():
            resolve_approval(request_id, False)
            return False
        if not _ready:                              # 服务关停 → 不 hang
            return False


def resolve_approval(request_id: str, verdict) -> bool:
    """回执入队唤醒等待方 + 广播 approval.resolved + 删持久化条目。返回是否命中未决。"""
    with _lock:
        entry = _pending.pop(request_id, None)
        _persist_pending()
    if entry is None:
        return False
    entry["verdict"] = verdict
    entry["event"].set()
    decision = {True: "y", False: "n", "always": "a", "persist": "p"}.get(verdict, "n")
    _emit_direct("approval.resolved", {"request_id": request_id, "decision": decision})
    return True


def pending_approvals() -> list[dict]:
    """快照用：重连时 session.snapshot 带回全部未决审批（刷新/断网不丢审批卡）。"""
    with _lock:
        return [dict(e["req"]) for e in _pending.values()]


def close_all_pending(reason: str = "closed") -> None:
    """cancel/会话结束：全部未决以 n 结案（fail-closed，防 harness 等一个不会来的回答）。"""
    with _lock:
        ids = list(_pending.keys())
    for rid in ids:
        resolve_approval(rid, False)


def _persist_pending() -> None:
    """未决表原子落盘（持 _lock 内调用）。"""
    if _pending_file is None:
        return
    try:
        _pending_file.parent.mkdir(parents=True, exist_ok=True)
        data = json.dumps([e["req"] for e in _pending.values()], ensure_ascii=False, indent=1)
        tmp = _pending_file.with_suffix(".tmp")
        # Y5：os.open 带 0o600 原子创建（照 TokenManager._write）——消掉「写后 chmod 前」的 644 窗口；
        # 挂载文件系统可能静默忽略权限位 → chmod 兜底保留。
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, data.encode("utf-8"))
        finally:
            os.close(fd)
        tmp.replace(_pending_file)
        try:
            _pending_file.chmod(0o600)
        except OSError:
            pass
    except Exception:
        pass


# ---------------------------------------------------------------- 内部

_ctx_ref: dict | None = None


def bind_ctx(ctx: dict) -> None:
    """init 后由 serve 绑定会话 ctx（emit 自动 flush 需要拿到它）。"""
    global _ctx_ref
    _ctx_ref = ctx


def _current_ctx() -> dict | None:
    return _ctx_ref
