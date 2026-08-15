"""UI 桥接服务（SPEC v2 §3/§7/§8/§9/§11）：安全门 + HTTP/REST 13 路由 + 手写 RFC6455 WS + serve 驱动。

- 纯标准库，零第三方依赖（WebSocket 为 RFC6455 子集手写：text/ping/pong/close、mask 必需、
  三档长度、单帧 1MB 上限、不支持分片）。
- 安全门五条（§7）：S1 仅绑 127.0.0.1（无 0.0.0.0 选项）；S2 配对 token（.state/ui_token 0600、
  REST Bearer / WS 子协议 xs-token.<token>、无 401 错 403、连续 10 错锁 60s 429、日志掩码、
  POST /api/token/reset 需旧 token）；S3 Host 白名单（其余 421）；S4 Origin 白名单（跨源 403）；
  S5 CSP + ui_schema.check 入参校验 + permission.safe_path 路径闸 + 静态 realpath 限定 ui/ 树内。
- 审批（§8）：ui_approver 组 approval.request（ap-N 单调 / approval_key=agent._approval_key /
  resolved_path=permission.resolve / tainted=taint_gate / force_ask 入参）→ register_approval →
  wait_verdict（0.3s 轮询，cancel/中断/关停 → False fail-closed）；approve 回执重算指纹不一致 → 以 n
  结案 + system.alert（R2 §9-4）。UI 批准只喂注入的 approver，执行永远走 agent._run_tool（红线 5）。
- agent.set_event_sink / set_bus_approver 由并行施工提供：缺失时 import/运行容错（getattr 探测，
  桥接层自补 message.append/state.patch 兜底事件），存在时走正式路径。
"""
from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import itertools
import json
import os
import platform
import queue
import re
import secrets
import socket
import threading
import time
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit, parse_qs

from . import (agent, approvals, checkpoint, config, jobs, memory, mcp_client, notes,
               permission, project_memory, projects, selflearn, session, subagent_store,
               trust, ui_bus, ui_schema, ui_state, vision)
from . import tools as tools_mod
from ._io import wrap_untrusted
from .kimi_client import KimiError
from .kimi_client import chat as kimi_chat
from .model_client import ModelClient
from .model_registry import ModelRegistry, ModelRegistryError
from .runtime_controls import RuntimeControlError, RuntimeControlStore

# ---------------------------------------------------------------- 常量

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_WS_MAX_FRAME = 1 << 20          # 单帧上限 1MB（SPEC §3.3，超限 close 1009）
_WS_HEARTBEAT = 15.0             # 心跳间隔秒；三拍未应断开
_WS_MAX_MISSED = 3
_TOKEN_FAILS_LOCK = 10           # 连续错 token 次数 → 锁 60s（429）
_TOKEN_LOCK_SECS = 60.0
_THUMB_EDGE = 480                # ?thumb=1 最长边
_BIND_HOST = "127.0.0.1"         # S1：钉死回环，不提供 0.0.0.0 选项

_REF_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$")     # 图片/vision ref 形态（拒绝穿越）
_JOB_RE = re.compile(r"^job-[A-Za-z0-9-]{1,64}$")
_SID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")                 # Y6：resume sid 白名单（session.py 直拼文件名，防穿越）
_MODEL_PROFILE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$")
_STATE_REWRITE_COMMANDS = ("clear", "resume", "undo")          # R2：runner 忙时禁入的就地改写类命令

_MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
         ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
         ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
         ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
         ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8"}

_CSP = ("default-src 'self'; img-src 'self' data: blob:; script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:{p} "
        "http://127.0.0.1:{p} ws://localhost:{p} http://localhost:{p}; "
        "font-src 'self'; frame-ancestors 'none'")


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _runtime_controls_response(state: dict) -> dict:
    """Add truthful, side-effect-free execution capability facts to persisted choices."""
    sandbox_enabled = state["sandbox_enabled"]
    selected_network = state["network_mode"]
    if not sandbox_enabled:
        execution = {
            "mode": "host", "isolated": False, "backend": "host",
            "availability": "available", "verification": "not_required",
        }
    else:
        system = platform.system()
        candidate = {"Windows": "appcontainer", "Darwin": "seatbelt"}.get(system)
        if candidate is None:
            execution = {
                "mode": "sandbox_unavailable", "isolated": False, "backend": "unsupported",
                "availability": "unsupported", "verification": "not_applicable",
            }
        else:
            # Platform support is only a candidate. The launcher re-verifies the
            # actual isolation boundary for every execution and fails closed.
            execution = {
                "mode": "sandbox_planned", "isolated": None, "backend": candidate,
                "availability": "candidate", "verification": "at_execution",
            }
    network = {
        "selected_mode": selected_network,
        "host_tools": {"mode": selected_network, "verification": "at_process_start"},
        "sandbox_scripts": {"mode": "off", "verification": "at_execution"},
    }
    return {**state, "effective": {"execution": execution, "network": network}}


def _etag_opaque(tag: str) -> str | None:
    """Return an ETag's opaque value, ignoring weak/strong distinction."""
    tag = tag.strip()
    if tag.startswith("W/"):
        tag = tag[2:]
    if len(tag) < 2 or tag[0] != '"' or tag[-1] != '"':
        return None
    return tag[1:-1]


def _if_none_match_matches(current_etag: str, header: str | None) -> bool:
    """Minimal If-None-Match weak comparison for an existing GET resource."""
    current = _etag_opaque(current_etag)
    if current is None or not header:
        return False
    i, n = 0, len(header)
    while i < n:
        while i < n and header[i] in " \t":
            i += 1
        if i >= n:
            break
        if header[i] == "*":
            return header[i + 1:].strip() == ""
        start = i
        if header.startswith("W/", i):
            i += 2
        if i >= n or header[i] != '"':
            while i < n and header[i] != ",":
                i += 1
        else:
            i += 1
            while i < n and header[i] != '"':
                if header[i] == "\\" and i + 1 < n:
                    i += 2
                else:
                    i += 1
            if i >= n:
                return False
            i += 1
            tag = header[start:i]
            tail = i
            while tail < n and header[tail] in " \t":
                tail += 1
            if tail == n or header[tail] == ",":
                if _etag_opaque(tag) == current:
                    return True
                i = tail
            else:
                i = tail
                while i < n and header[i] != ",":
                    i += 1
        while i < n and header[i] in " \t":
            i += 1
        if i < n:
            if header[i] != ",":
                return False
            i += 1
    return False


# ---------------------------------------------------------------- S2：配对 token

class TokenManager:
    """配对 token：secrets.token_hex(16) 落 .state/ui_token（0600，原子写）；
    校验失败计数——连续 10 次错锁 60s（SPEC §7-S2）。"""

    def __init__(self, state_dir):
        self._path = Path(state_dir) / "ui_token"
        self._token = None
        self._fails = 0
        self._locked_until = 0.0
        self._lock = threading.Lock()

    @property
    def path(self) -> Path:
        return self._path

    def generate(self) -> str:
        token = secrets.token_hex(16)
        self._write(token)
        with self._lock:
            self._token = token
            self._fails = 0
            self._locked_until = 0.0
        return token

    def _write(self, token: str) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_name(self._path.name + ".tmp")
        # os.open 带 0o600 原子创建：消掉「写后 chmod 前」的 644 窗口（真机 NTFS/ext4/APFS 生效；
        # 个别挂载文件系统会静默忽略权限位——chmod 兜底保留，烟雾测试用探针判定 FS 能力）
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, token.encode("utf-8"))
        finally:
            os.close(fd)
        tmp.replace(self._path)
        try:
            self._path.chmod(0o600)
        except OSError:
            pass

    def check(self, token) -> str:
        """→ "ok" / "missing" / "bad" / "locked"（时序安全比较）。"""
        with self._lock:
            if time.monotonic() < self._locked_until:
                return "locked"
            if not token:
                return "missing"
            if self._token and secrets.compare_digest(str(token), self._token):
                self._fails = 0
                return "ok"
            self._fails += 1
            if self._fails >= _TOKEN_FAILS_LOCK:
                self._locked_until = time.monotonic() + _TOKEN_LOCK_SECS
                self._fails = 0
            return "bad"

    def reset(self) -> str:
        """POST /api/token/reset（需旧 token 通过校验）：换新、旧即作废、落盘 0600。"""
        return self.generate()

    def mask(self, text: str) -> str:
        """日志掩码：任何日志串里出现 token 一律打码。"""
        t = self._token
        if t:
            text = text.replace(t, "***")
        return text


# ---------------------------------------------------------------- S3/S4：Host / Origin 白名单

def _norm_host_header(h: str) -> str:
    """规范化：小写、去主机名尾点（localhost. → localhost）。"""
    h = (h or "").strip().lower()
    if h.endswith("."):
        h = h[:-1]
    host, sep, port = h.rpartition(":")
    if sep and host.endswith("."):
        h = host[:-1] + ":" + port
    return h


def host_allowed(host_header: str, port: int) -> bool:
    """S3：仅 127.0.0.1:port / localhost:port（DNS 重绑定防御）；端口跟随实际监听。"""
    h = _norm_host_header(host_header)
    return h in {f"127.0.0.1:{port}", f"localhost:{port}"}


def origin_allowed(origin: str | None, port: int) -> bool:
    """S4：无 Origin（curl/同源导航）放行；有 Origin 仅放行本服务两个源，其余（跨源）拒。"""
    if not origin:
        return True
    o = origin.strip().lower().rstrip("/")
    return o in {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}


# ---------------------------------------------------------------- msg_id 编号（D8：ui_server 持有的会话单调计数）

class _MsgIds:
    """history 平行编号器：前后缀指纹对齐，扛追加/回滚/压缩三类改写；计数永不复用（会话内单调）。"""

    def __init__(self):
        self._n = 0
        self._fps: list = []
        self._ids: list = []
        self._lock = threading.Lock()

    @staticmethod
    def fp(msg) -> str:
        if not isinstance(msg, dict):
            return ("?", hashlib.sha256(repr(msg).encode()).hexdigest()[:16])
        try:
            blob = json.dumps(msg, ensure_ascii=False, sort_keys=True, default=str)
        except (TypeError, ValueError):
            blob = repr(msg)
        return (msg.get("role"), msg.get("tool_call_id") or "",
                hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16])

    def sync(self, history: list) -> list:
        """对齐当前 history，返回平行 msg_id 列表。"""
        with self._lock:
            fps = [self.fp(m) for m in history]
            old_fps, old_ids = self._fps, self._ids
            p = 0
            while p < len(old_fps) and p < len(fps) and old_fps[p] == fps[p]:
                p += 1
            s = 0
            while (s < len(old_fps) - p and s < len(fps) - p
                   and old_fps[len(old_fps) - 1 - s] == fps[len(fps) - 1 - s]):
                s += 1
            mid = len(fps) - p - s
            ids = old_ids[:p] + [self._next_locked() for _ in range(mid)] \
                + (old_ids[len(old_ids) - s:] if s else [])
            self._fps, self._ids = fps, ids
            return list(ids)

    def _next_locked(self) -> int:
        self._n += 1
        return self._n

    def next_external(self) -> int:
        """不进 history 的合成消息（命令回显等）也占号——保证全流单调不撞号。"""
        with self._lock:
            return self._next_locked()


# ---------------------------------------------------------------- 手写 RFC6455（SPEC §3.3）

_OP_TEXT, _OP_CLOSE, _OP_PING, _OP_PONG = 0x1, 0x8, 0x9, 0xA


class WSProtocolError(Exception):
    """帧解析异常：带 close code；绝不抛进 harness（解析层就地 close+日志）。"""

    def __init__(self, code: int, msg: str):
        super().__init__(msg)
        self.code = code


def ws_accept(key: str) -> str:
    return base64.b64encode(hashlib.sha1((key + _WS_GUID).encode("ascii")).digest()).decode("ascii")


def ws_read_frame(sock: socket.socket):
    """读一帧 → (opcode, payload bytes)。客户端帧必须带 mask（否则 1002）；
    不支持分片（continuation / FIN=0 数据帧 → 1003）；单帧 >1MB → 1009。"""
    hdr = _recv_exact(sock, 2)
    if hdr is None:
        raise WSProtocolError(1001, "连接关闭")
    b1, b2 = hdr[0], hdr[1]
    fin = bool(b1 & 0x80)
    opcode = b1 & 0x0F
    masked = bool(b2 & 0x80)
    length = b2 & 0x7F
    if opcode == 0x0:
        raise WSProtocolError(1003, "不支持分片（continuation）")
    if opcode not in (_OP_TEXT, _OP_CLOSE, _OP_PING, _OP_PONG, 0x2):
        raise WSProtocolError(1003, f"未知 opcode {opcode}")
    if opcode == 0x2:
        raise WSProtocolError(1003, "不支持二进制帧")
    if not masked:
        raise WSProtocolError(1002, "客户端帧必须带 mask")
    if opcode in (_OP_CLOSE, _OP_PING, _OP_PONG) and not fin:
        raise WSProtocolError(1002, "控制帧不得分片")
    if not fin:
        raise WSProtocolError(1003, "不支持分片消息")
    if length == 126:
        ext = _recv_exact(sock, 2)
        if ext is None:
            raise WSProtocolError(1001, "连接关闭")
        length = int.from_bytes(ext, "big")
    elif length == 127:
        ext = _recv_exact(sock, 8)
        if ext is None:
            raise WSProtocolError(1001, "连接关闭")
        length = int.from_bytes(ext, "big")
        if length >> 63:
            raise WSProtocolError(1002, "64bit 长度最高位非法")
    if length > _WS_MAX_FRAME:
        raise WSProtocolError(1009, f"单帧超 1MB 上限（{length}）")
    mask = _recv_exact(sock, 4)
    if mask is None:
        raise WSProtocolError(1001, "连接关闭")
    data = _recv_exact(sock, length) if length else b""
    if data is None:
        raise WSProtocolError(1001, "连接关闭")
    payload = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return opcode, payload


def _recv_exact(sock: socket.socket, n: int):
    buf = bytearray()
    while len(buf) < n:
        try:
            chunk = sock.recv(n - len(buf))
        except (ConnectionError, OSError):
            return None
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def ws_build_frame(opcode: int, payload: bytes = b"") -> bytes:
    """服务端帧（不 mask，SPEC §3.3）；三档长度。"""
    b1 = 0x80 | (opcode & 0x0F)
    n = len(payload)
    if n < 126:
        hdr = bytes((b1, n))
    elif n <= 0xFFFF:
        hdr = bytes((b1, 126)) + n.to_bytes(2, "big")
    else:
        hdr = bytes((b1, 127)) + n.to_bytes(8, "big")
    return hdr + payload


def ws_client_frame(opcode: int, payload: bytes = b"", mask_key: bytes | None = None) -> bytes:
    """客户端帧（带 mask）——供 scripts/wsprobe.py 与 tests 复用的编码侧（服务端只解码）。"""
    mask_key = mask_key or secrets.token_bytes(4)
    b1 = 0x80 | (opcode & 0x0F)
    n = len(payload)
    if n < 126:
        hdr = bytes((b1, 0x80 | n))
    elif n <= 0xFFFF:
        hdr = bytes((b1, 0x80 | 126)) + n.to_bytes(2, "big")
    else:
        hdr = bytes((b1, 0x80 | 127)) + n.to_bytes(8, "big")
    masked = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
    return hdr + mask_key + masked


# ---------------------------------------------------------------- 会话（serve 驱动核心）

class UISession:
    """一个 serve 会话：ctx/history/log_file + msg_id 编号 + 单飞 runner + 审批桥 + 命令分发。"""

    def __init__(self, ctx: dict, sid: str, history: list, log_file: Path,
                 state_dir: Path, model_fn=None, model_registry=None, model_client=None):
        self.ctx = ctx
        self.sid = sid
        self.history = history
        self.log_file = Path(log_file)
        self.state_dir = Path(state_dir)
        self.runtime_controls = RuntimeControlStore(self.state_dir / "runtime-controls.json")
        self.ctx["_runtime_control_store"] = self.runtime_controls
        self.model_registry = model_registry or ModelRegistry(self.state_dir)
        self.model_client = model_client or ModelClient(self.model_registry)
        self.tasking_mode = config.tasking_mode()
        self.task_api = None
        self.task_worker = None
        self._task_worker_stop = threading.Event()
        self._task_worker_thread = None
        self.tasking_diagnostic = {"mode": self.tasking_mode, "store": "not_started"}
        if self.tasking_mode == "on":
            # 惰性导入确保 off 模式不触碰 SQLite，也不改变旧 Session 的启动路径。
            from .task_api import TaskAPI
            from .task_engine import TaskEngine
            from .session_import import SessionImporter
            from .task_store import TaskStore
            try:
                task_store = TaskStore(self.state_dir / "tasking" / "tasks.db")
                task_engine = TaskEngine(task_store)
                self.task_api = TaskAPI(task_store, task_engine, workspace_root=config.ROOT,
                                        event_sink=self._emit_task_event,
                                        session_importer=SessionImporter(task_store, task_engine, self.state_dir / "sessions"),
                                        user_tools_base=self.state_dir / "user_tools")
                self.tasking_diagnostic["store"] = "ready"
            except Exception as exc:
                # 新账本不可用时保留旧会话服务；不删除、不重建、更不把底层路径/异常正文暴露给 UI。
                self.tasking_diagnostic.update(store="unavailable", code="TASK_STORE_UNAVAILABLE",
                                               reason=type(exc).__name__)
        elif self.tasking_mode == "shadow":
            self.tasking_diagnostic["store"] = "shadow_not_opened"
        self._reset_model_selection()
        if model_fn is None:
            # 默认模型句柄在每次 agent 调用前读取会话 profile ID。ModelClient 会把它一次性
            # 解析为不可变请求目标，切换只影响下一次请求，绝不改进程全局配置。
            def model_fn(messages, tools=None):
                return self.model_client.chat(
                    messages, tools=tools, model_id=self.current_model_id())
        self.model_fn = model_fn
        ctx["_history_ref"] = history          # ui_state 消息编号平行表（不导出：快照全白名单）
        ctx.setdefault("_cancel_event", threading.Event())
        self.msg_ids = _MsgIds()
        self.tokens = TokenManager(self.state_dir)
        self._ap_seq = itertools.count(1)
        self._ptc_seq = itertools.count(1)     # Y2：PTC 路径 tool_call.* 的 call_id 合成计数（会话内单调）
        self._runner_lock = threading.Lock()   # 同时只跑一轮（steering 留 backlog，SPEC §9-6）
        self._shutdown = threading.Event()
        # agent 事件 sink 由并行施工提供；缺失时桥接层自补 message.append/state.patch（容错降级）
        self._fallback_events = getattr(agent, "set_event_sink", None) is None

    def bind_tasking_project(self, project_id: str | None, *, quiet: bool = False) -> bool:
        """把当前会话显式绑定到 Tasking Project；没有有效项目时绝不注入项目记忆。"""
        self.ctx.pop("_tasking_project_id", None)
        self.ctx.pop("_project_memory_retriever", None)
        if project_id is None:
            return True
        if self.task_api is None or not isinstance(project_id, str):
            return False
        try:
            self.task_api.store.get_project(project_id)
        except KeyError:
            return False
        from .project_memory_retrieval import ProjectMemoryRetriever
        self.ctx["_tasking_project_id"] = project_id
        self.ctx["_project_memory_retriever"] = ProjectMemoryRetriever(self.task_api.store)
        if not quiet:
            self._emit_system(f"（已绑定 Tasking 项目 {project_id}；后续对话仅使用该项目已批准记忆）")
        return True

    def _run_background_task(self, run_context) -> None:
        """Run a queued Task through the ordinary Agent runtime with no hidden approval grant."""
        if self.task_api is None:
            raise RuntimeError("TASK_RUNTIME_UNAVAILABLE")
        from .run_control import RunControl
        from .task_model import AskQuestion
        task = self.task_api.store.get_task(run_context.task_id)
        frozen_controls = {key: run_context.policy_snapshot.get(key)
                           for key in ("sandbox_enabled", "network_mode", "heartbeat_enabled")}
        runtime_ctx = {"todos": [], "memory_file": memory.MEMORY_FILE,
                       "_run_control": RunControl(self.task_api.store), "_task_engine": self.task_api.engine,
                       "_background_task": True, "_runtime_control_snapshot": frozen_controls}
        # Project Memory is scoped to this Task's Project and only appended when
        # actually selected.  The receipt is the durable source of truth for UI
        # claims that a memory affected this Run.
        from .project_memory_retrieval import ProjectMemoryRetriever, RetrievalQuery
        retriever = ProjectMemoryRetriever(self.task_api.store)
        retrieved = retriever.retrieve(RetrievalQuery(task["project_id"], task["goal"]))
        history = []
        if retrieved.records:
            retriever.record_usage(task["project_id"], run_context.run_id, None,
                                   retrieved.injected_ids, retrieved.query_hash)
            history.append({"role": "system", "content": retriever.render_for_context(retrieved)})
        # A background worker can never turn an ask into an allow.  Agent
        # keeps its standard tool pipeline; after the turn we materialize a
        # structured Question so the Inbox, rather than a chat sentence, owns
        # the required human decision.
        with permission.headless_mode(()) :
            agent.run_once(task["goal"], history, model_fn=self.model_fn, approver=lambda *_args: False,
                           log_file=self.log_file, ctx=runtime_ctx, run_context=run_context)
        if runtime_ctx.get("_denied_calls", 0):
            run = self.task_api.store.get_run(run_context.run_id)
            current = self.task_api.store.get_task(run_context.task_id)
            if run["status"] == "Running" and current["status"] == "Running":
                self.task_api.engine.ask_question(AskQuestion(
                    run_context.run_id, "后台执行遇到需要你明确确认的操作。", ("允许后继续", "保持停止"),
                    True, "BACKGROUND_PERMISSION_REQUIRED", "task-worker"))

    def start_task_worker(self) -> None:
        """Start only with Tasking v2 enabled; app exit stops the worker honestly."""
        if self.task_api is None or self._task_worker_thread is not None:
            return
        from .run_lease import RunLeaseService
        from .task_worker import TaskWorker
        self.task_worker = TaskWorker(self.task_api.store, RunLeaseService(self.task_api.store), self.task_api.engine,
                                      worker_id=f"serve-{os.getpid()}-{self.sid}", runner=self._run_background_task,
                                      event_sink=lambda type_, payload: self._emit_task_event({"type": type_, **payload}),
                                      runtime_controls=self.runtime_controls)
        self._task_worker_thread = threading.Thread(target=self.task_worker.serve,
                                                    args=(self._task_worker_stop,), name="xiaoshe-task-worker", daemon=True)
        self._task_worker_thread.start()

    def stop_task_worker(self) -> None:
        self._task_worker_stop.set()
        if self._task_worker_thread is not None:
            self._task_worker_thread.join(timeout=2)

    # ---------------- 日志（token 掩码，S2）

    def log(self, msg: str) -> None:
        try:
            print(self.tokens.mask(f"[ui] {msg}"), flush=True)
        except Exception:
            pass

    def _emit_task_event(self, event: dict) -> None:
        """事务提交后才广播；旧客户端收到未知 task.* 事件会安全忽略。"""
        try:
            ui_bus.emit(event.get("type", "task.event"), event)
        except Exception:
            pass

    # ---------------- 事件 sink 适配器（type,payload → ui_bus.emit；message.append 补 msg_id）

    def sink(self, type_: str, payload) -> None:
        try:
            if type_ == "message.append" and isinstance(payload, dict):
                payload = dict(payload)
                payload["msg_id"] = self._id_for_message(payload)
            elif type_ in ("tool_call.start", "tool_call.end") and isinstance(payload, dict):
                if payload.get("call_id") is None:   # Y2：PTC 路径无真实 id——合成 ptc-N（单调不撞键）
                    payload = dict(payload)
                    payload["call_id"] = f"ptc-{next(self._ptc_seq)}"
            ui_bus.emit(type_, payload if isinstance(payload, dict) else {"data": payload})
        except Exception:
            pass    # 观测层绝不阻塞（红线 6）

    def _id_for_message(self, msg: dict) -> int:
        with ui_bus.STATE_LOCK:
            ids = self.msg_ids.sync(self.history)
            if ids and self.history and _MsgIds.fp(self.history[-1]) == _MsgIds.fp(msg):
                return ids[-1]
        return self.msg_ids.next_external()

    # ---------------- 快照（WS 连接首发 + clear/resume 重同步）

    def snapshot_payload(self) -> dict:
        with ui_bus.STATE_LOCK:
            ids = self.msg_ids.sync(self.history)
            return {"contract_v": 1,
                    "messages_tail": ui_state.messages_tail(self.ctx, 50, ids),
                    "state": ui_state.snapshot_full(self.ctx),
                    "pending_approvals": ui_bus.pending_approvals(),
                    "negotiated": {"v": 1}}

    # ---------------- 上行：send（单飞 runner 线程）

    def handle_send(self, text: str, client_msg_id: str | None = None) -> bool:
        """→ True 已受理；False=忙（上一轮未收尾，已回 system.alert busy）。"""
        if self._shutdown.is_set():
            ui_bus.emit("system.alert", {"level": "warn", "code": "closing", "text": "服务正在收尾，不再受理"})
            return False
        if not text.strip():
            ui_bus.emit("system.alert", {"level": "warn", "code": "empty", "text": "空消息不发送"})
            return True
        if not self._runner_lock.acquire(blocking=False):
            ui_bus.emit("system.alert", {"level": "warn", "code": "busy",
                                         "text": "上一轮还在跑——等它收尾，或先发送 cancel 取消"})
            return False
        try:
            self.ctx["_cancel_event"].clear()
        except Exception:
            pass
        t = threading.Thread(target=self._runner_body, args=(text,), daemon=True, name="ui-runner")
        t.start()
        return True

    def _runner_body(self, text: str) -> None:
        pre_ids = None
        try:
            if self._fallback_events:
                with ui_bus.STATE_LOCK:
                    pre_ids = set(self.msg_ids.sync(self.history))
            reply = agent.run_once(text, self.history, model_fn=self.model_fn,
                                   approver=agent._default_approver,
                                   log_file=self.log_file, ctx=self.ctx)
        except KimiError as e:
            self._emit_system(f"（出错了，但没崩）{e}")
            ui_bus.emit("system.alert", {"level": "error",
                         "code": getattr(e, "code", "model_error"), "text": str(e)[:500]})
        except KeyboardInterrupt:
            self._emit_system("（已中断）")
        except Exception as e:   # 兜底不崩服务（对齐 repl :1551）
            self._emit_system(f"（出错了，但没崩）{type(e).__name__}: {e}")
            ui_bus.emit("system.alert", {"level": "error", "code": "runner_error",
                                         "text": f"{type(e).__name__}: {e}"[:500]})
        finally:
            try:
                if self._fallback_events:
                    self._fallback_emit_new_messages(pre_ids or set())
                    ui_bus.mark_dirty(self.ctx, "todos", "notes", "usage", "denied_calls",
                                      "vision_pending", "subagents", "stall", "compaction",
                                      "approved_tools", "viewport", "pick_diff", "jobs")
                    ui_bus.flush(self.ctx)
                if agent._ends_clean(self.history):   # 只存干净断点（repl :1557-1561）
                    try:
                        session.save_session(self.sid, self.history,
                                             self.ctx.get("todos", []), notes.current(self.ctx),
                                             tasking_project_id=self.ctx.get("_tasking_project_id"))
                    except OSError as e:
                        self.log(f"会话存档失败（对话不受影响）：{e}")
            except Exception:
                pass
            self._runner_lock.release()

    def _fallback_emit_new_messages(self, pre_ids: set) -> None:
        """基线 agent 无 sink 时的降级：回合结束后按 history 差量补发 message.append（编号连续）。"""
        with ui_bus.STATE_LOCK:
            ids = self.msg_ids.sync(self.history)
            new = [(m, i) for m, i in zip(self.history, ids) if i not in pre_ids]
        for m, mid in new:
            payload = dict(m)
            payload["msg_id"] = mid
            ui_bus.emit("message.append", payload)

    # ---------------- 上行：approve（R2 §9-4 执行时重算指纹）

    def handle_approve(self, payload: dict) -> bool:
        """decision y/n/a/p → True/False/"always"/"persist"（白名单映射，不透传）。
        args 快照一致性：重算 _approval_key 与登记不一致 → 以 n 结案 + system.alert。"""
        rid = payload.get("request_id")
        verdict = {"y": True, "n": False, "a": "always", "p": "persist"}.get(payload.get("decision"))
        if verdict is None or not rid:
            return False
        req = next((r for r in ui_bus.pending_approvals() if r.get("request_id") == rid), None)
        if req is None:
            return False
        try:
            key_now = agent._approval_key(req.get("tool", ""), req.get("args") or {}, self.ctx)
        except Exception:
            key_now = req.get("approval_key")
        if key_now != req.get("approval_key"):
            ui_bus.resolve_approval(rid, False)
            ui_bus.emit("system.alert", {"level": "error", "code": "approval_args_mismatch",
                                         "text": "审批参数在批准前被改写，指纹不一致——已按拒绝结案（安全闸 R2-9.4）"})
            return True
        return ui_bus.resolve_approval(rid, verdict)

    # ---------------- 总线审批（SPEC §8；agent._approved 的 _BUS_APPROVER 分支调用）

    def ui_approver(self, name, args, reason, force_ask: bool = False, ctx: dict | None = None):
        """组 approval.request → register_approval → wait_verdict（0.3s 轮询；
        cancel/中断/服务关停 → False fail-closed）。返回四值 True/"always"/"persist"/False。"""
        ctx = ctx if isinstance(ctx, dict) else self.ctx
        rid = f"ap-{next(self._ap_seq)}"
        try:
            key = agent._approval_key(name, args, ctx)
        except Exception:
            key = str(name)
        resolved = _resolved_path_for(name, args)
        try:
            # 污点徽标双门叠加：内容门（taint_gate）+ 来源/能力标签门（trust.label_gate，S4）——
            # 任一命中都亮 tainted，让用户审批时看到「参数来自不可信渠道」。
            tainted = bool(permission.taint_gate(name, args, ctx.get("_tainted", ()))
                           or trust.label_gate(name, args, ctx))
        except Exception:
            tainted = False
        req = {"request_id": rid, "tool": name,
               "args": copy.deepcopy(args) if isinstance(args, dict) else args,
               "reason": reason, "approval_key": key, "resolved_path": resolved,
               "tainted": tainted, "force_ask": bool(force_ask)}
        ui_bus.register_approval(req)
        ui_bus.emit("approval.request", req)
        verdict = ui_bus.wait_verdict(ctx, rid)      # 阻塞等回执（runner 线程内）
        decision = {True: "y", False: "n", "always": "a", "persist": "p"}.get(verdict, "n")
        try:    # JSONL 审计（SPEC §8-6，role=system 兼容模式 R1 ⑨-7）
            agent.log_turn({"ts": _now(), "role": "system", "event": "approval",
                            "request_id": rid, "tool": name, "approval_key": key,
                            "resolved_path": resolved, "tainted": tainted,
                            "decision": decision}, self.log_file)
        except Exception:
            pass
        return verdict

    # ---------------- 上行：cancel / vision_pending.remove

    def handle_cancel(self) -> None:
        try:
            self.ctx["_cancel_event"].set()
        except Exception:
            pass
        ui_bus.close_all_pending("cancel")           # 未决审批以 n 结案（fail-closed）

    # ---------------- 上行：模型切换 / 自主模式（UI 批次 D，均会话级不落盘）

    def _reset_model_selection(self) -> None:
        """Install a valid default profile ID without treating it as a user override."""
        model_id = self.model_registry.default_id()
        if not model_id:
            return
        try:
            model = self.model_registry.model(model_id)
            provider = self.model_registry.resolve(model_id).provider.display_name
        except ModelRegistryError:
            # A missing credential must not make the UI state malformed.  Selection remains
            # visible; an actual request will surface the sanitized configuration error.
            try:
                model = self.model_registry.model(model_id)
                provider = next(item["provider"] for item in self.model_registry.public_items()
                                if item["id"] == model_id)
            except (ModelRegistryError, StopIteration):
                return
        self.ctx["_model_profile_id"] = model_id
        self.ctx["_model_provider"] = provider

    def current_model_id(self) -> str:
        model_id = self.ctx.get("_model_profile_id")
        if isinstance(model_id, str) and model_id:
            try:
                self.model_registry.model(model_id)
                return model_id
            except ModelRegistryError:
                pass
        self._reset_model_selection()
        return str(self.ctx.get("_model_profile_id") or "")

    def current_model(self) -> str:
        model_id = self.current_model_id()
        try:
            return self.model_registry.model(model_id).upstream_model
        except ModelRegistryError:
            return str(self.ctx.get("_model") or config.MODEL)

    def current_provider(self) -> str:
        model_id = self.current_model_id()
        try:
            return next(item["provider"] for item in self.model_registry.public_items()
                        if item["id"] == model_id)
        except StopIteration:
            return str(self.ctx.get("_model_provider") or "")

    def handle_set_model_id(self, model_id: str) -> tuple[bool, str]:
        """Select one configured profile for this session; credentials stay in the registry."""
        try:
            resolved = self.model_registry.resolve(model_id)
        except ModelRegistryError as exc:
            return False, exc.code
        self.ctx["_model_profile_id"] = resolved.model.id
        self.ctx["_model_provider"] = resolved.provider.display_name
        self.ctx["_model"] = resolved.model.upstream_model   # legacy snapshot field
        self._emit_dirty("model")
        self.log(f"模型已切换（会话级，不落 .env）：{resolved.provider.display_name} / {resolved.model.display_name}")
        return True, "ok"

    def handle_set_model(self, model: str) -> tuple[bool, str]:
        """Legacy name switch: resolve only within the active default provider."""
        if model not in config.model_candidates():
            return False, "not_in_candidates"
        # config.model_candidates() is intentionally read at request time for legacy pages.
        # Refresh once so a just-started process and its registry cannot disagree about XS_MODELS.
        registries = (self.model_registry, ModelRegistry(self.state_dir))
        for registry in registries:
            try:
                default = registry.model(registry.default_id())
                candidate = next(item for item in registry.list_models()
                                 if item.provider_id == default.provider_id
                                 and item.upstream_model == model)
            except (ModelRegistryError, StopIteration):
                continue
            if registry is not self.model_registry:
                self.model_registry = registry
                self.model_client = ModelClient(registry)
            return self.handle_set_model_id(candidate.id)
        return False, "not_in_candidates"

    def handle_set_autonomy(self, on: bool) -> bool:
        """POST /api/autonomy：自主模式开关（ctx['_autonomy']）。deny 硬护栏不受影响（check 已截流）。"""
        self.ctx["_autonomy"] = bool(on)
        self._emit_dirty("autonomy")
        self.log("自主模式已开启（ask 级自动放行，deny 硬护栏照拦）" if on
                 else "自主模式已关闭（恢复逐条审批）")
        return bool(on)

    def handle_vision_remove(self, ref: str) -> bool:
        removed = False
        with ui_bus.STATE_LOCK:
            vp = self.ctx.get("_vision_pending")
            if isinstance(vp, list) and ref in vp:
                vp.remove(ref)
                removed = True
        if removed:
            ui_bus.mark_dirty(self.ctx, "vision_pending")
            ui_bus.flush(self.ctx)
        return removed

    # ---------------- 上行：command（复刻 repl :1516-1529 本地命令链，回显走 message.append/state.patch）

    def _emit_system(self, text: str) -> None:
        ui_bus.emit("message.append", {"role": "system", "content": text,
                                       "msg_id": self.msg_ids.next_external()})

    def _emit_dirty(self, *keys: str) -> None:
        ui_bus.mark_dirty(self.ctx, *keys)
        ui_bus.flush(self.ctx)

    def handle_command(self, name: str, args: dict | None = None) -> None:
        args = args if isinstance(args, dict) else {}
        try:
            self._dispatch_command(name, args)
        except Exception as e:
            self._emit_system(f"（命令 {name} 执行出错：{type(e).__name__}: {e}）")

    def _confirm_fn(self, args: dict):
        """本地命令的二次确认：仅当客户端显式带 {"yes": true} 才答 y（undo/skills 批准类）。"""
        yes = args.get("yes") is True
        return lambda *a, **k: ("y" if yes else "n")

    def _capture(self, fn, *fargs, **fkw) -> str:
        lines: list = []
        fn(*fargs, out=lines.append, **fkw)
        return "\n".join(lines)

    def _dispatch_command(self, name: str, args: dict) -> None:
        # R2 runner-busy 闸：状态改写类命令（就地换 history 表）与 run_once 并发会撕裂——
        # runner 忙时直接回 busy alert，不执行不入队。
        if name in _STATE_REWRITE_COMMANDS and self._runner_lock.locked():
            ui_bus.emit("system.alert", {"level": "warn", "code": "busy",
                                         "text": "回合进行中，命令将在本轮结束后可用"})
            return
        if name == "todos":
            self._emit_dirty("todos")
        elif name == "notes":
            self._emit_dirty("notes")
        elif name == "memory":
            cmd = ":memory" + (f" {args['cmd']}" if isinstance(args.get("cmd"), str) else "")
            out = self._capture(agent._handle_memory_command, cmd,
                                confirm=self._confirm_fn(args), path=self.ctx.get("memory_file"))
            self._emit_system(out or "（:memory 无输出）")
        elif name == "skills":
            cmd = ":skills"
            if isinstance(args.get("cmd"), str):
                cmd += f" {args['cmd']}"
            elif args.get("action") in ("approve", "discard") and isinstance(args.get("index"), int):
                cmd += f" {args['action']} {args['index']}"
            out = self._capture(selflearn.handle_skills_command, cmd,
                                confirm=self._confirm_fn(args))
            self._emit_system(out or "（:skills 无输出）")
            self._emit_dirty("notes")
        elif name == "effects":
            out = self._capture(agent._handle_effects_command, ":effects", session_id=self.sid)
            self._emit_system(out or "（本会话还没有副作用记录）")
        elif name == "undo":
            out = self._capture(agent._handle_undo_command, ":undo",
                                confirm=self._confirm_fn(args), session_id=self.sid)
            self._emit_system(out or "（没有可撤销的文件改动）")
        elif name == "clear":
            with ui_bus.STATE_LOCK:
                self.history[:] = agent._fresh_history()
                self.msg_ids.sync(self.history)
            self._emit_system("（已开新对话——上方为全新会话）")
            ui_bus.emit("session.snapshot", self.snapshot_payload())
        elif name == "help":
            self._emit_system(_HELP_TEXT)
        elif name == "recall":
            self._emit_system(wrap_untrusted(vision.recall(args, self.ctx), "recall"))
        elif name == "recall_subagent":
            ref_id = args.get("ref_id")
            rec = subagent_store.get(ref_id) if isinstance(ref_id, str) else None
            if rec is None:
                self._emit_system(f"（没有子结论 {ref_id}——可能已被淘汰或编号有误）")
            else:
                self._emit_system(wrap_untrusted(
                    f"子结论 {ref_id}｜目标：{rec.get('objective', '')}\n{rec.get('text', '')[:4000]}",
                    "子 agent 结论"))
        elif name == "sessions":
            lst = session.list_sessions(limit=20)
            if not lst:
                self._emit_system("（没有历史会话档案）")
            else:
                body = "\n".join(f"  {i}) {s['id']} · {s['n_messages']} 条 · 「{s['preview']}」"
                                 for i, s in enumerate(lst, 1))
                self._emit_system(f"历史会话（command resume + args.sid 装载）：\n{body}")
        elif name == "resume":
            self._resume(args)
        else:
            ui_bus.emit("system.alert", {"level": "warn", "code": "unknown_command",
                                         "text": f"未知命令：{name}"})

    def _resume(self, args: dict) -> bool:
        """装载历史会话（只装内容、不动当前 sid）。→ True 已恢复 / False 拒绝或不可读。"""
        sid = args.get("sid")
        if not isinstance(sid, str) or not sid:
            ui_bus.emit("system.alert", {"level": "warn", "code": "bad_args",
                                         "text": "resume 需要 args.sid（先 command sessions 看列表）"})
            return False
        if not _SID_RE.match(sid):   # Y6：session.load_session 直拼文件名——先过白名单，防路径穿越
            ui_bus.emit("system.alert", {"level": "warn", "code": "bad_args",
                                         "text": "sid 非法（仅允许字母/数字/_/-，1~64 字符）"})
            return False
        data = session.load_session(sid)
        if not data:
            self._emit_system(f"（会话档案 {sid} 已不可读）")
            return False
        with ui_bus.STATE_LOCK:   # 只装内容、不动当前 sid（serve 单会话进程；日志/图床归属不变）
            self.history[:] = data["history"]
            self.ctx["todos"] = data.get("todos", [])
            notes.restore(self.ctx, data.get("notes"))
            self.bind_tasking_project(data.get("tasking_project_id"), quiet=True)
            memory.refresh_pinned_system(self.history)
            self.msg_ids.sync(self.history)
        self._emit_system(f"（已恢复会话 {sid}）")
        ui_bus.emit("session.snapshot", self.snapshot_payload())
        self._emit_dirty("todos", "notes")
        return True

    # ---------------- 上行：REST 会话管理（UI 批次 B：resume 复用 + 新会话切换）

    def handle_resume_rest(self, sid: str) -> tuple[bool, str]:
        """POST /api/sessions/resume：runner 忙拒（对齐 _STATE_REWRITE_COMMANDS 闸）。"""
        if self._runner_lock.locked():
            ui_bus.emit("system.alert", {"level": "warn", "code": "busy",
                                         "text": "回合进行中，会话切换将在本轮结束后可用"})
            return False, "busy"
        return (True, "ok") if self._resume({"sid": sid}) else (False, "unreadable")

    def handle_new_session(self) -> str | None:
        """POST /api/sessions/new：旧会话（有实质内容且干净）存档 → 换新 sid + 全新 history → 重同步。
        runner 忙 → None（已发 busy alert）。"""
        if self._shutdown.is_set():
            return None
        if not self._runner_lock.acquire(blocking=False):
            ui_bus.emit("system.alert", {"level": "warn", "code": "busy",
                                         "text": "回合进行中，新会话将在本轮结束后可用"})
            return None
        try:
            if (any(m.get("role") == "user" for m in self.history)
                    and agent._ends_clean(self.history)):      # 对齐 runner 收尾的存档纪律
                try:
                    session.save_session(self.sid, self.history,
                                         self.ctx.get("todos", []), notes.current(self.ctx),
                                         tasking_project_id=self.ctx.get("_tasking_project_id"))
                except OSError as e:
                    self.log(f"会话存档失败（不影响开新会话）：{e}")
            new_sid = session.new_session_id()
            with ui_bus.STATE_LOCK:
                self.history[:] = agent._fresh_history()
                self.sid = new_sid
                self.log_file = session.session_log_file(new_sid)
                self.ctx["session_id"] = new_sid
                self.ctx["todos"] = []
                notes.restore(self.ctx, None)
                self.bind_tasking_project(None, quiet=True)
                # UI 批次 D：自主模式/模型切换都是会话级——新会话如实回默认（审批模式 + .env 默认模型）
                self.ctx["_autonomy"] = False
                self.ctx.pop("_model", None)
                self.ctx.pop("_model_profile_id", None)
                self.ctx.pop("_model_provider", None)
                self._reset_model_selection()
                self.msg_ids = _MsgIds()                     # 编号器随新会话归零
            # 总线重挂新 sid（seq 归零、缓冲清空）；客户端随 session.snapshot 整体重同步
            ui_bus.init(self.ctx, new_sid, self.state_dir, snapshot_fn=ui_state.collect_dirty)
            ui_bus.bind_ctx(self.ctx)
            self._emit_system(f"（已开新会话 {new_sid}）")
            ui_bus.emit("session.snapshot", self.snapshot_payload())
            return new_sid
        finally:
            self._runner_lock.release()


_HELP_TEXT = (
    "可用命令（⌘K / command 事件）：\n"
    "  todos / notes        刷新待办、工作笔记面板\n"
    "  memory               记忆大脑总览（args.cmd 透传 :memory 子命令，如 \"revive 2\"）\n"
    "  skills               技能库（正式+待审）；args.action=approve|discard + args.index 走人审门\n"
    "  effects              本会话动了什么（副作用账本）\n"
    "  undo                 撤销最近一次文件改动（破坏性，需 args.yes=true 确认）\n"
    "  clear                开新对话（当前会话内容清空，存档仍在）\n"
    "  recall               取回溢出内容（args.ref）\n"
    "  recall_subagent      取回子结论全文（args.ref_id）\n"
    "  sessions / resume    历史会话列表 / 装载（args.sid）\n"
    "  help                 本帮助")


def _resolved_path_for(name, args):
    """SPEC §8-1：仅 path 类（write_file/edit）逐一 permission.resolve()；
    单值字符串 / 多值列表 / 无路径参数 null / resolve 异常 → {"error":"path_error","raw":原始串}。"""
    if name not in ("write_file", "edit") or not isinstance(args, dict):
        return None
    cands = []
    p = args.get("path")
    if isinstance(p, str) and p:
        cands.append(p)
    try:
        for s in permission._iter_pathlike(args):   # R2 §3：args["path"] 及 pathlike 候选各算一次
            if isinstance(s, str) and s not in cands:
                cands.append(s)
    except Exception:
        pass
    vals = []
    for c in cands:
        try:
            vals.append(str(permission.resolve(c)))
        except Exception:
            vals.append({"error": "path_error", "raw": c})
    if not vals:
        return None
    return vals[0] if len(vals) == 1 else vals


# ---------------------------------------------------------------- WS 客户端会话

class _WSClient:
    """一个 WS 连接：ui_bus.subscribe 队列 + sender 线程（心跳 15s，三拍未应断开）。"""

    def __init__(self, sock: socket.socket, sess: UISession, addr):
        self.sock = sock
        self.session = sess
        self.addr = addr
        self.subq = None           # ui_bus 订阅队列（snapshot 发出后再 subscribe，防首发乱序）
        self.alive = True
        self.send_lock = threading.Lock()
        self.missed = 0            # 连续未应心跳拍数

    def send_frame(self, opcode: int, payload: bytes = b"") -> None:
        with self.send_lock:
            self.sock.sendall(ws_build_frame(opcode, payload))

    def send_json(self, obj: dict) -> None:
        self.send_frame(_OP_TEXT, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def close(self, code: int = 1000, reason: bytes = b"") -> None:
        if not self.alive:
            return
        self.alive = False
        try:
            self.send_frame(_OP_CLOSE, code.to_bytes(2, "big") + reason[:123])
        except (ConnectionError, OSError):
            pass
        # 温和收尾（Windows 必需）：协议错误在读完整个入帧前就判出，接收缓冲常剩未读字节；
        # 此时直接 close 内核会回 RST，把在途 close 帧掐掉（对端 recv 得 ConnectionResetError）。
        # 先 SHUT_WR 让 close 帧随 FIN 有序送达，再有界排空对端残余（至 EOF 或超时），最后才 close。
        try:
            self.sock.shutdown(socket.SHUT_WR)
        except OSError:
            pass
        try:
            self.sock.settimeout(0.3)
            for _ in range(4):                              # 至多 ~1.2s，绝不永久阻塞
                try:
                    chunk = self.sock.recv(65536)
                except socket.timeout:
                    continue
                if not chunk:                               # 对端 EOF：残余已排空
                    break
        except (ConnectionError, OSError):
            pass
        try:
            self.sock.close()
        except OSError:
            pass
        if self.subq is not None:
            ui_bus.unsubscribe(self.subq)
            try:
                self.subq.put_nowait(None)   # 叫醒 sender 退出
            except queue.Full:
                pass


def _ws_sender(client: _WSClient) -> None:
    """每客户端 sender 线程：取 ui_bus 订阅队列发出；15s 空转一拍心跳，三拍未应断开。"""
    while client.alive and not client.session._shutdown.is_set():
        try:
            item = client.subq.get(timeout=_WS_HEARTBEAT)
        except queue.Empty:
            client.missed += 1
            if client.missed >= _WS_MAX_MISSED:
                client.session.log(f"WS 客户端 {client.addr} 三拍心跳未应——断开")
                client.close(1001, b"heartbeat timeout")
                return
            try:
                client.send_frame(_OP_PING, b"hb")
            except (ConnectionError, OSError):
                client.close()
                return
            continue
        if item is None:
            if client.alive:   # Y3：总线踢出慢订阅者投的哨兵——关连接让客户端重连重同步（不发则僵尸保活）
                client.session.log(f"WS 客户端 {client.addr} 掉队被总线踢出——close 1001 令其重连重同步")
                client.close(1001, b"kicked: resync required")
            return
        if not client.alive:
            return
        try:
            client.send_json(item)
        except (ConnectionError, OSError):
            client.close()
            return


# ---------------------------------------------------------------- HTTP / REST / 静态 / WS 握手

class _UIServer(ThreadingHTTPServer):
    daemon_threads = True
    # Windows 的 SO_REUSEADDR 语义与 Unix 不同：允许两个活实例同绑一个端口互相抢连接
    # （壳/浏览器会连上旧实例 → token 不匹配「未连接」）。Windows 关 reuse：重复起服
    # 立刻 OSError 如实报错（对齐 tauri/SMOKE 2c 期望）；Unix 保留 reuse 便于快速重启。
    allow_reuse_address = (os.name != "nt")


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "xs-ui/1.0"

    def log_message(self, fmt, *args):    # 默认 stderr 日志 → 会话日志（token 掩码）
        try:
            self.server.session.log("http " + (fmt % args))
        except Exception:
            pass

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    # 非常用方法也走同一总闸（Host/Origin 检查同款路径），最终落统一 405 JSON——
    # 不给 BaseHTTPRequestHandler 默认的 501 HTML 机会（响应形状纪律）。
    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_OPTIONS(self):
        self._dispatch("OPTIONS")

    # ---------------- 总闸 + 分发

    def _dispatch(self, method: str) -> None:
        self.close_connection = True      # 短连接模型：响应都带 Content-Length，省心正确
        try:
            self._route(method)
        except (ConnectionError, BrokenPipeError):
            pass
        except Exception as e:
            try:
                self.server.session.log(f"内部错误：{type(e).__name__}: {e}")
                self._err(500, "internal", "服务端内部错误", "看服务端日志")
            except Exception:
                pass

    def _route(self, method: str) -> None:
        port = self.server.server_address[1]
        if not host_allowed(self.headers.get("Host", ""), port):          # S3
            self._err(421, "bad_host", "Host 不在白名单",
                      f"仅允许 127.0.0.1:{port} / localhost:{port}")
            return
        if not origin_allowed(self.headers.get("Origin"), port):          # S4
            self._err(403, "bad_origin", "跨源请求被拒", "Origin 仅放行本服务自身源")
            return
        u = urlsplit(self.path)
        path = unquote(u.path)
        query = parse_qs(u.query)
        if path == "/ws" and method == "GET":
            self._handle_ws()
            return
        if path.startswith("/api/"):
            if not self._auth():                                          # S2
                return
            self._api(method, path, query)
            return
        if method != "GET":
            self._err(405, "method_not_allowed", "只支持 GET", "静态资源只读")
            return
        self._static(path)

    # ---------------- S2：token 鉴权（REST：Authorization: Bearer；图片二进制端点例外放行 ?token=）

    # <img>/<link> 标签无法带 Authorization 头——仅二进制图片端点接受 query token（JSON API 一律要头，
    # 收窄 token 出现在 URL 里的暴露面；服务端日志已对 token 掩码）。
    _QUERY_TOKEN_PATHS = ("/api/images/",)

    def _auth(self) -> bool:
        auth = self.headers.get("Authorization", "")
        token = auth[7:].strip() if auth.startswith("Bearer ") else None
        if token is None:
            path = self.path.split("?", 1)[0]
            if path.startswith(self._QUERY_TOKEN_PATHS) or path.endswith("/screenshot"):
                query = parse_qs(urlsplit(self.path).query)
                token = (query.get("token") or [None])[0]
        res = self.server.session.tokens.check(token)
        if res == "ok":
            return True
        self._auth_error(res)
        return False

    def _auth_error(self, res: str) -> None:
        if res == "missing":
            self._err(401, "unauthorized", "缺少配对 token",
                      "启动日志打印的 URL 带 ?token=；REST 用 Authorization: Bearer <token>")
        elif res == "locked":
            self._err(429, "locked", "连续错误过多，已锁定 60 秒", "稍后重试，或用正确 token 调 /api/token/reset")
        else:
            self._err(403, "forbidden", "token 错误", "确认是本次启动打印的那个 token（重启会换）")

    # ---------------- REST 13+2 路由（SPEC §11）

    def _api(self, method: str, path: str, query: dict) -> None:
        try:
            self._api_inner(method, path, query)
        except ui_schema.SchemaError as e:
            self._err(400, "bad_request", e.message, e.hint or "按契约修入参")

    def _api_inner(self, method: str, path: str, query: dict) -> None:
        sess = self.server.session
        if path.startswith("/api/v2/"):
            if sess.task_api is None:
                return self._err(404, "not_found", "Task 工作台未启用", "设置 XIAOSHE_TASKING_V2=on 后重启")
            raw = self._read_body() if method in {"POST", "PATCH"} else None
            payload = self._json_body(raw) if raw else None
            if path == "/api/v2/session/project" and method == "POST":
                project_id = payload.get("project_id") if isinstance(payload, dict) else None
                if project_id is not None and not isinstance(project_id, str):
                    return self._err(400, "bad_request", "project_id 必须是字符串或 null", "选择现有 Tasking 项目")
                if not sess.bind_tasking_project(project_id):
                    return self._err(404, "not_found", "Tasking 项目不存在或不可用", "先在任务工作台创建或选择项目")
                return self._json({"project_id": sess.ctx.get("_tasking_project_id")})
            result = sess.task_api.dispatch(method, path, payload, dict(self.headers), query)
            return self._json(result.body, status=result.status, headers=result.headers)
        if method == "GET":
            if path == "/api/runtime-controls":
                return self._json(_runtime_controls_response(sess.runtime_controls.load()))
            if path == "/api/runtime-controls/heartbeat":
                state = sess.runtime_controls.load()
                return self._json({
                    "server_time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "heartbeat_enabled": state["heartbeat_enabled"],
                })
            if path == "/api/tools":
                return self._tools()
            if path == "/api/state":
                # 契约 v1：域字段平铺顶层（PLAN §4 示例为准），sid/pending_approvals 为附加顶层键
                return self._json({"sid": sess.sid, **ui_state.snapshot_full(sess.ctx),
                                   "pending_approvals": ui_bus.pending_approvals()})
            if path == "/api/messages":
                before = (query.get("before") or [None])[0]
                limit = (query.get("limit") or ["50"])[0]
                try:    # limit/before 非整数 → 400（入参错误不该吞成 500）
                    int(limit)
                    if before is not None:
                        int(before)
                except (TypeError, ValueError):
                    return self._err(400, "bad_request", "limit/before 必须是整数",
                                     "?limit=50&before=<msg_id>")
                with ui_bus.STATE_LOCK:
                    ids = sess.msg_ids.sync(sess.history)
                    page = ui_state.messages_page(sess.ctx, limit, before, ids)
                return self._json(page)
            if path == "/api/viewport/current":
                return self._json(ui_state.viewport_current(sess.ctx))   # 平铺顶层（契约 v1）
            m = re.fullmatch(r"/api/viewport/([^/]+)/screenshot", path)
            if m:
                return self._viewport_screenshot(m.group(1), query)
            if path == "/api/pick/diff":
                return self._json(ui_state.pick_diff(sess.ctx))          # 平铺顶层（契约 v1）
            if path == "/api/jobs":
                return self._json({"jobs": ui_state.jobs_list()})
            m = re.fullmatch(r"/api/jobs/([^/]+)/log", path)
            if m:
                return self._job_log(m.group(1), query)
            if path == "/api/memory/stats":
                return self._json(ui_state.memory_stats())               # 平铺顶层（契约 v1）
            # ---- UI 批次 C：三层记忆（长期/项目/短期）----
            if path == "/api/memory/layers":
                return self._json(ui_state.memory_layers(sess.ctx.get("memory_file"), sess.ctx,
                                                         self._projects_file(), self._pm_file()))
            if path == "/api/skills/pending":
                return self._json(ui_state.skills_pending())             # 平铺顶层（契约 v1）
            m = re.fullmatch(r"/api/images/([^/]+)", path)
            if m:
                return self._serve_image(m.group(1), thumb=(query.get("thumb") == ["1"]))
            # ---- UI 批次 B：项目分组 + 会话管理 ----
            if path == "/api/projects":
                return self._json({"projects": projects.load(self._projects_file())["projects"]})
            if path == "/api/sessions":
                return self._json({"current": sess.sid,
                                   "sessions": projects.sessions_index(limit=50)})
            # ---- 模型清单：旧页面继续使用上游模型名，新页面使用跨服务商稳定 ID ----
            if path == "/api/models":
                cands = config.model_candidates()
                return self._json({"models": cands, "current": sess.current_model(),
                                   "default": config.MODEL, "switchable": len(cands) > 1,
                                   "items": sess.model_registry.public_items(),
                                   "current_id": sess.current_model_id(),
                                   "default_id": sess.model_registry.default_id()})
            if path == "/api/model-profiles":
                return self._json({"profiles": sess.model_registry.public_profiles()})
            return self._err(404, "not_found", f"没有这条路由：{path}", "见契约 §11 的 13 条路由")
        if method == "POST":
            if path == "/api/token/reset":    # S2：需旧 token（已过 _auth 闸）；重置后旧即作废
                new = sess.tokens.reset()
                sess.log("配对 token 已重置（旧 token 作废，新 token 已落盘 0600）")
                return self._json({"token": new})
            body = self._read_body()
            if path == "/api/model-profiles":
                p = self._json_body(body)
                ui_schema.check(p, ui_schema.SCHEMA_MODEL_PROFILE_CREATE, "model_profiles.create")
                api_key = p.get("api_key", "")
                values = {key: value for key, value in p.items() if key != "api_key"}
                try:
                    profile = sess.model_registry.create_profile(values, api_key=api_key)
                except ModelRegistryError as exc:
                    return self._err(400, "bad_request", f"模型资料无效：{exc.code}",
                                     "检查协议、接口地址、认证方式和模型名")
                return self._json({"profile": self._public_model_profile(sess, profile.id)}, status=201)
            profile_test = re.fullmatch(r"/api/model-profiles/([^/]+)/test", path)
            if profile_test:
                model_id = self._profile_id(profile_test.group(1))
                if model_id is None:
                    return self._err(404, "not_found", "模型资料不存在", "刷新模型列表后重试")
                try:
                    result = sess.model_client.probe(model_id)
                except Exception as exc:
                    return self._model_probe_error(exc)
                return self._json(result)
            if path == "/api/send":
                p = self._json_body(body)
                ui_schema.check(p, ui_schema.SCHEMA_SEND, "send")
                # R3：形状对齐 fixtures/send_response.json（client_msg_id 原样 echo）；G4：忙时带 reason
                accepted = sess.handle_send(p["text"], p.get("client_msg_id"))
                resp = {"ok": True, "accepted": accepted, "client_msg_id": p.get("client_msg_id")}
                if not accepted:
                    resp["reason"] = "busy"
                return self._json(resp)
            if path == "/api/approve":
                p = self._json_body(body)
                ui_schema.check(p, ui_schema.SCHEMA_APPROVE, "approve")
                # R3：形状对齐 fixtures/approve_response.json；非法 decision 已被 schema 闸 400
                sess.handle_approve(p)
                return self._json({"ok": True, "request_id": p["request_id"],
                                   "decision": p["decision"]})
            if path == "/api/vision/pending/remove":
                p = self._json_body(body)
                ui_schema.check(p, ui_schema.SCHEMA_VISION_REMOVE, "vision_pending.remove")
                return self._json({"removed": sess.handle_vision_remove(p["ref"])})
            # ---- UI 批次 B：项目分组 + 会话管理 ----
            if path == "/api/sessions/new":
                new_sid = sess.handle_new_session()
                resp = {"ok": True, "switched": new_sid is not None}
                if new_sid is not None:
                    resp["sid"] = new_sid
                else:
                    resp["reason"] = "busy"
                return self._json(resp)
            if path == "/api/sessions/resume":
                p = self._json_body(body)
                ui_schema.check(p, ui_schema.SCHEMA_RESUME, "sessions.resume")
                resumed, reason = sess.handle_resume_rest(p["sid"])
                resp = {"ok": True, "resumed": resumed}
                if not resumed:
                    resp["reason"] = reason
                return self._json(resp)
            if path == "/api/projects":
                p = self._json_body(body)
                ui_schema.check(p, ui_schema.SCHEMA_PROJECT_CREATE, "projects.create")
                try:
                    return self._json({"project": projects.create(p["name"], self._projects_file())})
                except projects.ProjectError as e:
                    return self._err(400, "bad_request", str(e), "项目名 1~60 字、不能为空")
            if path == "/api/projects/rename":
                p = self._json_body(body)
                ui_schema.check(p, ui_schema.SCHEMA_PROJECT_RENAME, "projects.rename")
                try:
                    pr = projects.rename(p["id"], p["name"], self._projects_file())
                except projects.ProjectError as e:
                    return self._err(400, "bad_request", str(e), "项目 id 形如 proj-xxxxxxxx")
                if pr is None:
                    return self._err(404, "not_found", f"项目不存在：{p['id']}",
                                     "GET /api/projects 看全量")
                return self._json({"project": pr})
            if path == "/api/projects/delete":
                p = self._json_body(body)
                ui_schema.check(p, ui_schema.SCHEMA_PROJECT_ID, "projects.delete")
                try:
                    existed = projects.delete(p["id"], self._projects_file())
                except projects.ProjectError as e:
                    return self._err(400, "bad_request", str(e), "项目 id 形如 proj-xxxxxxxx")
                if not existed:
                    return self._err(404, "not_found", f"项目不存在：{p['id']}",
                                     "删除项目不删会话——会话会回到未分组")
                return self._json({"ok": True, "deleted": p["id"]})
            if path in ("/api/projects/assign", "/api/projects/unassign"):
                p = self._json_body(body)
                ui_schema.check(p, ui_schema.SCHEMA_PROJECT_ASSIGN, "projects.assign")
                fn = projects.assign if path.endswith("/assign") else projects.unassign
                try:
                    found = fn(p["id"], p["sid"], self._projects_file())
                except projects.ProjectError as e:
                    return self._err(400, "bad_request", str(e),
                                     "项目 id 形如 proj-xxxxxxxx；sid 仅字母/数字/_/-")
                if not found:
                    return self._err(404, "not_found", f"项目不存在：{p['id']}",
                                     "GET /api/projects 看全量")
                return self._json({"ok": True, "project_id": p["id"], "sid": p["sid"]})
            # ---- UI 批次 C：三层记忆实时编辑 ----
            if path == "/api/memory/item":
                p = self._json_body(body)
                ui_schema.check(p, ui_schema.SCHEMA_MEMORY_ITEM, "memory.item")
                return self._memory_item(sess, p)
            if path == "/api/memory/notes":
                p = self._json_body(body)
                ui_schema.check(p, ui_schema.SCHEMA_MEMORY_NOTE, "memory.notes")
                return self._memory_notes(sess, p)
            # ---- UI 批次 D：模型切换（会话级不落 .env）+ 自主模式开关（会话级不落盘）----
            if path == "/api/model":
                p = self._json_body(body)
                ui_schema.check(p, ui_schema.SCHEMA_MODEL, "model")
                has_name = isinstance(p.get("model"), str) and bool(p["model"].strip())
                has_id = isinstance(p.get("model_id"), str) and bool(p["model_id"].strip())
                if has_name == has_id:  # both true or both false: exact one is required
                    raise ui_schema.SchemaError("model 与 model_id 必须且只能提供一个",
                                                "旧页面传 model；新页面传 model_id")
                if has_id:
                    ok, reason = sess.handle_set_model_id(p["model_id"].strip())
                else:
                    ok, reason = sess.handle_set_model(p["model"].strip())
                if not ok:
                    return self._err(400, "bad_request",
                                     f"模型不可用：{reason}",
                                     "GET /api/models 查看已配置模型后重试")
                return self._json({"ok": True, "model": sess.current_model(),
                                   "model_id": sess.current_model_id(),
                                   "provider": sess.current_provider(), "persisted": False})
            if path == "/api/autonomy":
                p = self._json_body(body)
                ui_schema.check(p, ui_schema.SCHEMA_AUTONOMY, "autonomy")
                return self._json({"ok": True, "autonomy": sess.handle_set_autonomy(p["on"])})
            return self._err(404, "not_found", f"没有这条路由：{path}", "见契约 §11 的 13 条路由")
        if method == "PATCH":
            if path == "/api/runtime-controls":
                p = self._json_body(self._read_body())
                ui_schema.check(p, ui_schema.SCHEMA_RUNTIME_CONTROLS, "runtime_controls.patch")
                if not p:
                    raise ui_schema.SchemaError("运行控制更新不能为空", "至少提供一个运行控制字段")
                try:
                    return self._json(_runtime_controls_response(sess.runtime_controls.update(p)))
                except RuntimeControlError as exc:
                    return self._err(400, "bad_request", str(exc), "按运行控制契约修正后重试")
            match = re.fullmatch(r"/api/model-profiles/([^/]+)", path)
            if not match:
                return self._err(405, "method_not_allowed", "PATCH 不支持", "GET/POST/PATCH/DELETE")
            model_id = self._profile_id(match.group(1))
            if model_id is None:
                return self._err(404, "not_found", "模型资料不存在", "刷新模型列表后重试")
            p = self._json_body(self._read_body())
            ui_schema.check(p, ui_schema.SCHEMA_MODEL_PROFILE_PATCH, "model_profiles.patch")
            api_key = p.pop("api_key", None)
            try:
                if model_id.startswith("builtin-"):
                    if set(p) != {"enabled"}:
                        return self._err(409, "conflict", "内置模型只能隐藏或恢复显示", "请新建本地模型资料以修改连接配置")
                    if not p["enabled"] and model_id == sess.current_model_id():
                        return self._err(409, "conflict", "不能隐藏当前会话正在使用的模型", "先切换到另一个模型")
                    sess.model_registry.hide_builtin(model_id, hidden=not p["enabled"])
                else:
                    if not p and api_key in (None, ""):
                        return self._json({"profile": self._public_model_profile(sess, model_id)})
                    sess.model_registry.update_profile(
                        model_id, p, api_key=api_key if api_key else None)
            except ModelRegistryError as exc:
                return self._err(400, "bad_request", f"模型资料无效：{exc.code}",
                                 "检查字段后重试")
            return self._json({"profile": self._public_model_profile(sess, model_id)})
        if method == "DELETE":
            match = re.fullmatch(r"/api/model-profiles/([^/]+)", path)
            if not match:
                return self._err(405, "method_not_allowed", "DELETE 不支持", "GET/POST/PATCH/DELETE")
            model_id = self._profile_id(match.group(1))
            if model_id is None:
                return self._err(404, "not_found", "模型资料不存在", "刷新模型列表后重试")
            if model_id.startswith("builtin-"):
                return self._err(409, "conflict", "内置模型不能删除，只能隐藏", "PATCH enabled:false 可隐藏")
            if model_id == sess.current_model_id():
                return self._err(409, "conflict", "不能删除当前会话正在使用的模型", "先切换到另一个模型")
            try:
                sess.model_registry.delete_profile(model_id)
            except ModelRegistryError as exc:
                return self._err(404, "not_found", f"模型资料不存在：{exc.code}", "刷新模型列表后重试")
            return self._json({"ok": True, "deleted": model_id})
        return self._err(405, "method_not_allowed", f"{method} 不支持", "GET/POST/PATCH/DELETE")

    @staticmethod
    def _profile_id(raw: str) -> str | None:
        model_id = unquote(raw)
        return model_id if _MODEL_PROFILE_ID_RE.fullmatch(model_id) else None

    @staticmethod
    def _public_model_profile(sess: UISession, model_id: str) -> dict:
        try:
            return next(item for item in sess.model_registry.public_profiles() if item["id"] == model_id)
        except StopIteration:
            raise ModelRegistryError("unknown_model") from None

    def _model_probe_error(self, exc: Exception) -> None:
        if isinstance(exc, ModelRegistryError):
            return self._err(400, "bad_request", f"模型资料不可用：{exc.code}", "检查配置后重试")
        if isinstance(exc, KimiError):
            code = getattr(exc, "code", "upstream_error")
            status = {"authentication_failed": 401, "quota_limited": 429,
                      "model_not_found": 404, "timeout": 504,
                      "network_error": 502, "protocol_error": 502}.get(code, 502)
            return self._err(status, code, f"连接测试失败：{code}", "模型资料未被修改，可检查后再次测试")
        return self._err(502, "upstream_error", "连接测试失败", "模型资料未被修改，可稍后重试")

    def _read_body(self, limit: int = 2 << 20) -> bytes:
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n > limit:
            raise ui_schema.SchemaError("请求体过大", "上限 2MB")
        return self.rfile.read(n) if n else b""

    def _json_body(self, body: bytes):
        try:
            return json.loads(body.decode("utf-8")) if body else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ui_schema.SchemaError("请求体不是合法 JSON", "Content-Type: application/json + JSON object")

    # ---------------- 路由实现

    def _projects_file(self):
        """UI 批次 B：项目分组归属映射落盘 <state_dir>/projects.json（.gitignore 已覆盖 .state/）。"""
        return Path(self.server.session.state_dir) / "projects.json"

    def _pm_file(self):
        """UI 批次 C：项目记忆落盘 <state_dir>/project_memory.json（.state 敏感硬护栏内，模型不可写）。"""
        return Path(self.server.session.state_dir) / "project_memory.json"

    # ---------------- UI 批次 C：三层记忆实时编辑

    def _clean_panel_fact(self, text: str, ctx: dict):
        """面板记忆文本净化（与 remember 工具/_fact_from_untrusted 同款口径，安全红线）：

        oneline 折行+中和隐形字符（与污点归一同构）→ 长度闸 → 注入话术拒 → 污点判 source
        （S4 信任标签层复用：含本会话不可信源片段 → source=untrusted 标注落盘，不洗白）。
        → (clean, source)；不合规抛 SchemaError（路由层转 400）。"""
        clean = memory.oneline(text)
        if not clean:
            raise ui_schema.SchemaError("记忆内容不能为空", "写点内容再保存")
        if len(clean) > tools_mod._FACT_MAX_CHARS:
            raise ui_schema.SchemaError(
                f"记忆内容超长（{len(clean)} 字，上限 {tools_mod._FACT_MAX_CHARS}）", "精简成一句话事实再存")
        if any(p.search(clean) for p in tools_mod._INJECT_HINTS):
            raise ui_schema.SchemaError("这条含疑似指令注入迹象，没存",
                                        "去掉「忽略指令 / 扮演 / system prompt」之类话术再试")
        src = "untrusted" if tools_mod._fact_from_untrusted(clean, ctx if isinstance(ctx, dict) else {}) else "user"
        return clean, src

    def _memory_item(self, sess, p: dict) -> None:
        """POST /api/memory/item：长期/项目层 add/edit/forget/revive——复用 memory.py 同一套语义落盘 + 记审计。"""
        layer, action = p["layer"], p["action"]
        text, src = "", "user"
        if action in ("add", "edit"):
            try:
                text, src = self._clean_panel_fact(p.get("text") or "", sess.ctx)
            except ui_schema.SchemaError as e:
                return self._err(400, "bad_request", e.message, e.hint)
        rid = p.get("id") or ""
        zone = p.get("zone") or "其它"
        detail: dict = {}
        if layer == "long":                                   # 长期层：直接复用 memory.py 文件级 API
            mpath = sess.ctx.get("memory_file")
            if action == "add":
                res = memory.remember(text, source=src, zone=zone, path=mpath)
                ok, detail = True, {"added": res}
            elif action == "edit":                            # 编辑文案 = supersede 取代（保留审计链）
                new_id = memory.supersede(rid, text, path=mpath, source=src)
                ok, detail = new_id is not None, {"new_id": new_id}
            elif action == "forget":
                ok = memory.forget_by_id(rid, path=mpath)
            else:
                ok = memory.revive_by_id(rid, path=mpath)
        else:                                                 # 项目层：project_memory（同语义，.state 落盘）
            pid = p.get("project_id") or ""
            if not projects.PID_RE.match(pid):
                return self._err(400, "bad_request", "项目 id 非法（形如 proj-xxxxxxxx）",
                                 "GET /api/projects 看全量")
            if projects._find(projects.load(self._projects_file()), pid) is None:
                return self._err(404, "not_found", f"项目不存在：{pid}", "GET /api/projects 看全量")
            pm = self._pm_file()
            if action == "add":
                res = project_memory.add(pid, text, source=src, zone=zone, path=pm)
                if res == "full":
                    return self._err(400, "bad_request",
                                     f"项目记忆已满（{project_memory._MAX_PER_PROJECT} 条上限）",
                                     "先清理旧条目再新增")
                ok, detail = True, {"added": res in ("added", "revived")}
            elif action == "edit":
                new_id = project_memory.edit(pid, rid, text, source=src, path=pm)
                ok, detail = new_id is not None, {"new_id": new_id}
            elif action == "forget":
                ok = project_memory.forget(pid, rid, path=pm)
            else:
                ok = project_memory.revive(pid, rid, path=pm)
        sess.log(f"面板记忆编辑 layer={layer} action={action} id={rid or '-'} ok={ok}")   # 审计（:memory 同级）
        if not ok:
            return self._err(404, "not_found", "目标记忆不存在或已变化",
                             "刷新面板后重试（编辑按内容 id 定位，TOCTOU 免疫）")
        return self._json({"ok": True, "action": action, "layer": layer, **detail})

    def _memory_notes(self, sess, p: dict) -> None:
        """POST /api/memory/notes：短期层（本会话便签）新增/删除——走 notes.py 同一净化闸，落 ctx。"""
        if p["action"] == "add":
            with ui_bus.STATE_LOCK:
                try:
                    cur = notes.add(sess.ctx, p.get("text") or "")
                except ValueError as e:
                    return self._err(400, "bad_request", str(e), "便签会作为提示注入，注入话术/超长会拒")
            sess.log("面板短期便签新增")
            return self._json({"ok": True, "notes": list(cur)})
        idx = p.get("index")
        with ui_bus.STATE_LOCK:
            cur = notes.current(sess.ctx)
            if not (isinstance(idx, int) and 1 <= idx <= len(cur)):
                return self._err(404, "not_found", f"没有第 {idx} 条便签", "刷新面板看最新列表")
            removed = cur.pop(idx - 1)
            sess.ctx["_notes"] = cur
        sess.log("面板短期便签删除")
        return self._json({"ok": True, "removed": removed, "notes": list(cur)})

    def _tools(self) -> None:
        """运行时枚举注册表全集（内置 38 + mcp__/自定义动态出现；R9 不写死）。"""
        entries = []
        try:
            specs = tools_mod.all_specs()
        except Exception:
            specs = []
        safe = set(permission.SAFE_TOOLS) | set(permission._USER_TOOL_SAFE)
        for spec in specs:
            fn = (spec or {}).get("function") or {}
            name = fn.get("name")
            if not name:
                continue
            meta = ui_schema.tool_meta(name)
            entries.append({"name": name,
                            "description": fn.get("description", ""),
                            "args_schema": fn.get("parameters") or {},   # 契约 v1 §5.3 键名 args_schema（draft-07）
                            "category": meta["category"],
                            "category_label": ui_schema.CATEGORY_LABEL.get(meta["category"], meta["category"]),
                            "permission_default": "allow" if name in safe else "ask",
                            "approval_key_rule": meta["approval_key_rule"],
                            "persistable": meta["persistable"],
                            "taint_high_risk": meta["taint_high_risk"],
                            "display": {"icon": meta["icon"], "arg_format": meta["arg_format"]}})
        rev = hashlib.sha256(json.dumps(sorted(e["name"] for e in entries),
                                        ensure_ascii=False).encode()).hexdigest()[:12]
        return self._json({"count": len(entries), "tools": entries, "registry_rev": rev}, etag_auto=True)

    def _job_log(self, jid: str, query: dict) -> None:
        if not _JOB_RE.match(jid):
            return self._err(404, "not_found", "任务不存在", "job id 形如 job-YYYYMMDD-HHMMSS-pid-n")
        rec = next((r for r in jobs.list_jobs() if r.get("id") == jid), None)
        if rec is None:
            return self._err(404, "not_found", f"任务不存在：{jid}", "GET /api/jobs 看全量")
        try:
            lines = int((query.get("lines") or ["20"])[0])
        except (TypeError, ValueError):
            lines = 20
        lines = max(1, min(lines, 200))
        job = {k: rec.get(k) for k in    # 契约仲裁 3：8 键（无 cwd，含 log_path）
               ("id", "command", "pid", "log_path", "status", "started_at", "returncode", "ended_at")}
        return self._json({"job": job, "log": ui_state._log_tail(rec.get("log_path"), lines)})

    def _viewport_screenshot(self, vid: str, query: dict) -> None:
        # Y7 读侧：tools 写侧（look/zoom）持锁变更注册表；此处捕获并发迭代 RuntimeError 重试一次
        vp = None
        for _attempt in range(2):
            try:
                with ui_bus.STATE_LOCK:
                    reg = self.server.session.ctx.get("_viewport_registry") or {}
                    vp = reg.get(vid)
                break
            except RuntimeError:
                continue
        ref = vp.get("screenshot_ref") if isinstance(vp, dict) else None
        if not ref:
            return self._err(404, "not_found", f"视口 {vid} 无截图（或视口已过期）",
                             "重新 look/zoom 生成视口")
        return self._serve_image(ref, thumb=(query.get("thumb") == ["1"]))

    def _serve_image(self, ref: str, thumb: bool = False) -> None:
        sess = self.server.session
        if not _REF_RE.match(ref):    # 形态闸：../、分隔符、%2e 全部拒（S5）
            return self._err(404, "not_found", "图片不存在", "ref 形如 img-3 / txt-2")
        meta = vision.meta(sess.sid, ref)
        if not meta:
            return self._err(404, "not_found", f"图片不存在：{ref}", "可能已被降档清除；重新采集")
        base = os.path.realpath(vision._sdir(sess.sid))
        real = os.path.realpath(vision._blob_path(sess.sid, meta))
        if real != base and not real.startswith(base + os.sep):    # 静态 containment 同款纪律
            return self._err(404, "not_found", "图片不存在", "ref 非法")
        try:
            data = Path(real).read_bytes()
        except OSError:
            return self._err(404, "not_found", f"图片文件缺失：{ref}", "blob 已被清理")
        if thumb:
            try:
                data = vision.downscale_to_max(data, _THUMB_EDGE)   # 缺 sips 回落原图（优雅降级）
            except Exception:
                pass
        etag = '"%s%s"' % (meta.get("sha256") or hashlib.sha256(data).hexdigest(), "-t" if thumb else "")
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        mime = _MIME.get("." + str(meta.get("ext", "png")).lower(), "image/png")
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "private")     # 本机图片仍防共享缓存（S5 表）
        self.end_headers()
        self.wfile.write(data)

    # ---------------- 静态伺服（ui/ 树内 containment；前端由并行施工构建，缺失优雅 404）

    def _static(self, path: str) -> None:
        root = self.server.static_root
        if root is None or "\x00" in path:
            return self._err(404, "not_found", "前端资源不存在", "ui/ 目录由前端施工提供")
        if path in ("", "/"):
            path = "/index.html"
        cand = os.path.realpath(os.path.join(root, path.lstrip("/")))
        if cand != root and not cand.startswith(root + os.sep):   # S5：realpath 限定 ui/ 树内
            return self._err(404, "not_found", "资源不存在", "路径越出 ui/ 树")
        if not os.path.isfile(cand):
            return self._err(404, "not_found", f"资源不存在：{path}", "ui/ 前端构建中或路径有误")
        try:
            data = Path(cand).read_bytes()
        except OSError:
            return self._err(404, "not_found", "资源不可读", "权限或占用问题")
        ext = os.path.splitext(cand)[1].lower()
        port = self.server.server_address[1]
        self.send_response(200)
        self.send_header("Content-Type", _MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-cache")     # 全部静态资源禁用启发式缓存——本地起服零成本，改动刷新即生效
        if ext == ".html":
            self.send_header("Content-Security-Policy", _CSP.format(p=port))   # S5：CSP 在 HTML 响应上
        self.end_headers()
        self.wfile.write(data)

    # ---------------- 响应封装（顶层 v + server_time；错误 {"error":{code,message,hint}}）

    def _json(self, obj: dict, status: int = 200, etag_auto: bool = False, headers: dict[str, str] | None = None) -> None:
        payload = {"v": 1, "server_time": _now()}
        payload.update(obj)
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        etag = None
        if etag_auto:
            # server_time 是响应元数据，每次请求都会变；弱验证器只表示资源内容未变。
            etag_payload = {"v": 1}
            etag_payload.update(obj)
            etag_body = json.dumps(etag_payload, ensure_ascii=False,
                                   sort_keys=True, separators=(",", ":")).encode("utf-8")
            etag = 'W/"%s"' % hashlib.sha256(etag_body).hexdigest()[:32]
            if _if_none_match_matches(etag, ",".join(self.headers.get_all("If-None-Match", []))):
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if etag:
            self.send_header("ETag", etag)
        for key, value in (headers or {}).items():
            if key.lower() != "content-length":
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _err(self, status: int, code: str, message: str, hint: str = "") -> None:
        self._json({"error": {"code": code, "message": message, "hint": hint}}, status=status)

    # ---------------- WS（握手校验 + token 先于升级 + 收发循环）

    def _handle_ws(self) -> None:
        sess = self.server.session
        token, subproto = None, None
        for p in (self.headers.get("Sec-WebSocket-Protocol") or "").split(","):
            p = p.strip()
            if p.startswith("xs-token."):           # 浏览器：子协议携带（响应回选）
                token, subproto = p[len("xs-token."):], p
                break
        if token is None:                            # 非浏览器：Authorization: Bearer
            auth = self.headers.get("Authorization", "")
            if auth.startswith("Bearer "):
                token = auth[7:].strip()
        res = sess.tokens.check(token)
        if res != "ok":
            return self._auth_error(res)
        if "websocket" not in (self.headers.get("Upgrade") or "").lower():
            return self._err(400, "bad_handshake", "缺 Upgrade: websocket", "这是 WS 端点")
        if "upgrade" not in (self.headers.get("Connection") or "").lower():
            return self._err(400, "bad_handshake", "缺 Connection: Upgrade", "这是 WS 端点")
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            return self._err(400, "bad_handshake", "缺 Sec-WebSocket-Key", "RFC6455 握手必填")
        if (self.headers.get("Sec-WebSocket-Version") or "") != "13":
            self.send_response(426)
            self.send_header("Sec-WebSocket-Version", "13")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        lines = ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
                 f"Sec-WebSocket-Accept: {ws_accept(key)}"]
        if subproto:
            lines.append(f"Sec-WebSocket-Protocol: {subproto}")
        self.connection.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))
        self.close_connection = True
        client = _WSClient(self.connection, sess, self.client_address)
        try:    # 首发 session.snapshot（seq=当前总线 seq，后续事件 seq 严格递增；跳空 → 客户端 REST 重同步）
            client.send_json({"v": 1, "seq": ui_bus.current_seq(), "ts": _now(),
                              "type": "session.snapshot", "sid": sess.sid,
                              "payload": sess.snapshot_payload()})
        except (ConnectionError, OSError):
            client.close()
            return
        client.subq = ui_bus.subscribe()
        threading.Thread(target=_ws_sender, args=(client,), daemon=True,
                         name=f"ui-ws-sender-{self.client_address}").start()
        try:
            while client.alive and not sess._shutdown.is_set():
                opcode, payload = ws_read_frame(self.connection)
                client.missed = 0                       # 任何入帧都算活着
                if opcode == _OP_CLOSE:
                    break
                if opcode == _OP_PING:
                    client.send_frame(_OP_PONG, payload)
                elif opcode == _OP_TEXT:
                    self._ws_message(client, payload)
        except WSProtocolError as e:                    # 解析异常 → close + 日志，绝不抛进 harness
            sess.log(f"WS 协议错误（{e}），close {e.code}")
            client.close(e.code, str(e).encode("utf-8")[:120])
        except (ConnectionError, OSError):
            pass
        finally:
            client.close()

    def _ws_message(self, client: _WSClient, payload: bytes) -> None:
        sess = client.session
        try:
            msg = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return ui_bus.emit("system.alert", {"level": "warn", "code": "bad_json",
                                                "text": "上行帧不是合法 JSON"})
        if not isinstance(msg, dict):
            return ui_bus.emit("system.alert", {"level": "warn", "code": "bad_envelope",
                                                "text": "上行信封必须是 JSON 对象"})
        mtype = msg.get("type")
        p = msg.get("payload") or {}
        try:
            if mtype == "send":
                ui_schema.check(p, ui_schema.SCHEMA_SEND, "send.payload")
                sess.handle_send(p["text"], p.get("client_msg_id"))
            elif mtype == "approve":
                ui_schema.check(p, ui_schema.SCHEMA_APPROVE, "approve.payload")
                if not sess.handle_approve(p):
                    ui_bus.emit("system.alert", {"level": "warn", "code": "unknown_request",
                                                 "text": f"没有未决审批 {p.get('request_id')}（可能已结案）"})
            elif mtype == "cancel":
                sess.handle_cancel()
            elif mtype == "command":
                ui_schema.check(p, ui_schema.SCHEMA_COMMAND, "command.payload")
                sess.handle_command(p["name"], p.get("args"))
            elif mtype == "vision_pending.remove":
                ui_schema.check(p, ui_schema.SCHEMA_VISION_REMOVE, "vision_pending.remove.payload")
                sess.handle_vision_remove(p["ref"])
            else:
                ui_bus.emit("system.alert", {"level": "warn", "code": "unknown_type",
                                             "text": f"未知上行事件类型：{mtype}"})
        except ui_schema.SchemaError as e:
            ui_bus.emit("system.alert", {"level": "warn", "code": "bad_request",
                                         "text": f"入参校验失败：{e.message}（{e.hint}）"})


def create_server(sess: UISession, port: int = 7788, static_root=None) -> _UIServer:
    """起 HTTP 服务（S1：绑死 127.0.0.1，无 0.0.0.0 选项；port=0 取随机端口，供测试）。"""
    root = static_root if static_root is not None else (config.ROOT / "ui")
    httpd = _UIServer((_BIND_HOST, int(port)), _Handler)
    httpd.session = sess
    httpd.static_root = os.path.realpath(root) if root else None
    return httpd


# ---------------------------------------------------------------- serve 驱动（SPEC §9，镜像 repl 生命周期 R1 ⑤）

_ACTIVE_LOCK = threading.Lock()
_ACTIVE: dict = {}


def active_server() -> dict:
    """嵌入/测试用：取当前活服务 {"httpd", "session"}（无则空）。"""
    with _ACTIVE_LOCK:
        return dict(_ACTIVE)


def stop_active() -> None:
    """嵌入/测试用：请求关停当前服务（serve_forever 返回后走温和收尾）。"""
    with _ACTIVE_LOCK:
        httpd = _ACTIVE.get("httpd")
    if httpd is not None:
        threading.Thread(target=httpd.shutdown, daemon=True).start()


def serve_main(argv=None, model_fn=None) -> int:
    """run.py serve 入口。model_fn 可注入（默认 kimi_client.chat）——smoke/测试用假模型。"""
    p = argparse.ArgumentParser(prog="run.py serve", description="小蛇界面桥接服务（仅本机回环）")
    p.add_argument("--port", type=int, default=7788, help="监听端口（默认 7788；0=随机）")
    p.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    p.add_argument("--no-mcp", action="store_true", help="不连 mcp.json 里的 server")
    args = p.parse_args(argv)
    return _serve(args, model_fn)


def _serve(args, model_fn) -> int:
    state_dir = config.ROOT / ".state"
    session.migrate_legacy()
    # 1. ctx 初始化（与 repl :1382-1383 对齐 + SPEC §9-1 显式键；headless 专有差异勿混入，R1 ⑨-4）
    ctx: dict = {"todos": [], "memory_file": memory.MEMORY_FILE, "_interactive": True,
                 "_persistent_approved": approvals.load(),
                 "_vision_pending": [], "_notes": [], "_denied_calls": 0,
                 "session_id": session.new_session_id()}
    sid = ctx["session_id"]
    history = agent._fresh_history()
    log_file = session.session_log_file(sid)
    sess = UISession(ctx, sid, history, log_file, state_dir, model_fn=model_fn)
    httpd = None
    try:
        agent._fire_session_hook("SessionStart", ctx)          # 2. 开工 hook（fire-and-forget）
        jobs.reconcile()                                       # 3. 后台任务档案对账
        try:
            checkpoint.reconcile()                             # 文件级 undo 对账（回收孤儿 blob）
        except Exception:
            pass
        n_ut, ut_problems = tools_mod.load_user_tools()        # 装载已批准自定义工具
        if n_ut:
            sess.log(f"已装载 {n_ut} 个自定义工具")
        for prob in ut_problems:
            sess.log(f"[!] 自定义工具：{prob}")
        if not args.no_mcp:                                    # 4. MCP 连接（--no-mcp 跳过）
            try:
                n_mcp = mcp_client.connect_configured()
                if n_mcp:
                    sess.log(f"已接入 {n_mcp} 个 MCP server，外部工具就绪")
            except Exception as e:
                sess.log(f"MCP 连接失败（不影响内置工具）：{e}")
        try:
            agent._print_memory_glance(ctx.get("memory_file"))   # 记忆速览（打服务端日志，空记忆静默）
        except Exception:
            pass
        # 5. 总线 + agent 钩子（set_event_sink/set_bus_approver 由并行施工提供，缺失容错降级）
        ui_bus.init(ctx, sid, state_dir, snapshot_fn=ui_state.collect_dirty)
        ui_bus.bind_ctx(ctx)
        if hasattr(agent, "set_event_sink"):
            agent.set_event_sink(sess.sink)
            sess._fallback_events = False
        else:
            sess.log("agent 无事件 sink（基线）——桥接层以降级模式自补 message.append/state.patch")
        if hasattr(agent, "set_bus_approver"):
            agent.set_bus_approver(sess.ui_approver)
        else:
            sess.log("agent 无总线审批分支（基线）——危险工具将走 _default_approver 兜底（非 TTY 恒拒）")
        sess.start_task_worker()
        token = sess.tokens.generate()                         # 6. 配对 token（落 .state/ui_token 0600）
        httpd = create_server(sess, port=args.port)            # 7. HTTP 起服（S1 仅 127.0.0.1）
        port = httpd.server_address[1]
        url = f"http://127.0.0.1:{port}/?token={token}"        # 启动日志打印带 token 完整 URL（S2）
        print(f"小蛇界面已就绪: {url}", flush=True)
        with _ACTIVE_LOCK:
            _ACTIVE.update(httpd=httpd, session=sess)
        if not args.no_browser:
            try:
                webbrowser.open(url)
            except Exception:
                pass
        try:
            httpd.serve_forever(poll_interval=0.3)             # 8. 主线程阻塞；Ctrl+C → 温和收尾
        except KeyboardInterrupt:
            sess.log("收到 Ctrl+C——温和收尾")
    finally:
        sess._shutdown.set()
        _graceful_finale(sess, ctx, history, httpd)
    return 0


def _graceful_finale(sess: UISession, ctx: dict, history: list, httpd) -> None:
    """Ctrl+C/关停收尾（照 repl :1562-1581 顺序 + SPEC §9-7 前置 close_all_pending）。"""
    sess.log("正在收尾…")
    try:
        sess.stop_task_worker()
    except Exception:
        pass
    try:
        ui_bus.close_all_pending("shutdown")    # 未决审批全部以 n 结案（fail-closed，别让人等一个不会来的回答）
    except Exception:
        pass
    try:
        jobs.shutdown()                          # 终止残留后台任务（两阶段杀不留孤儿）
    except Exception:
        pass
    try:
        mcp_client.shutdown()                    # 关 MCP server 子进程
    except Exception:
        pass
    try:
        agent._fire_session_hook("SessionEnd", ctx)   # 最后跑：看到 settled 状态（R1 ⑤）
    except Exception:
        pass
    try:
        selflearn.learn_on_session_end(ctx, history)  # 后台自学复盘（fail-safe）
    except Exception:
        pass
    if httpd is not None:
        try:
            httpd.server_close()
        except Exception:
            pass
    for setter in ("set_event_sink", "set_bus_approver"):   # 还原 agent 钩子（红线 3）
        try:
            fn = getattr(agent, setter, None)
            if fn is not None:
                fn(None)
        except Exception:
            pass
    try:
        ui_bus.shutdown()
    except Exception:
        pass
    with _ACTIVE_LOCK:
        _ACTIVE.clear()
    sess.log("再见。")
