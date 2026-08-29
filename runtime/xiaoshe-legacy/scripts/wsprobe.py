"""最小手写 WS 客户端（RFC6455 子集，纯标准库）——smoke 与 tests/ui_server 复用。

用法：
    from wsprobe import WSClient
    c = WSClient.connect("127.0.0.1", 7788, token="<配对token>")
    snap = c.recv_json()                      # session.snapshot
    c.send_json({"v": 1, "seq": 0, "type": "send", "payload": {"text": "hi"}})
    ev = c.recv_json()
    c.close()
"""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import socket

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_TEXT, OP_BIN, OP_CLOSE, OP_PING, OP_PONG = 0x1, 0x2, 0x8, 0x9, 0xA


class HandshakeError(Exception):
    def __init__(self, status: int, headers: dict, body: bytes = b""):
        super().__init__(f"WS 握手被拒：HTTP {status}")
        self.status = status
        self.headers = headers
        self.body = body


class WSClient:
    """客户端帧必带 mask；服务端帧不 mask。收 ping 自动回 pong。"""

    def __init__(self, sock: socket.socket, buffered: bytes = b""):
        self.sock = sock
        self.closed = False
        self._buf = bytearray(buffered)   # 握手响应同段到达的残留字节（服务端抢发的首帧）

    # ---------------- 握手

    @classmethod
    def connect(cls, host: str, port: int, path: str = "/ws", token: str | None = None,
                use_subprotocol: bool = True, timeout: float = 10.0,
                extra_headers: dict | None = None,
                host_header: str | None = None, origin: str | None = None) -> "WSClient":
        """token 默认走 Sec-WebSocket-Protocol 子协议（xs-token.<token>，浏览器同款）；
        use_subprotocol=False 时走 Authorization: Bearer。握手被拒抛 HandshakeError(带 HTTP 状态)。"""
        sock = socket.create_connection((host, port), timeout=timeout)
        key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        headers = [f"GET {path} HTTP/1.1",
                   f"Host: {host_header or f'{host}:{port}'}",
                   "Upgrade: websocket", "Connection: Upgrade",
                   f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13"]
        if origin is not None:
            headers.append(f"Origin: {origin}")
        if token:
            if use_subprotocol:
                headers.append(f"Sec-WebSocket-Protocol: xs-token.{token}")
            else:
                headers.append(f"Authorization: Bearer {token}")
        for k, v in (extra_headers or {}).items():
            headers.append(f"{k}: {v}")
        sock.sendall(("\r\n".join(headers) + "\r\n\r\n").encode("ascii"))
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = sock.recv(4096)
            if not chunk:
                sock.close()
                raise HandshakeError(-1, {}, resp)
            resp += chunk
        head, _, _rest = resp.partition(b"\r\n\r\n")
        lines = head.decode("iso-8859-1").split("\r\n")
        try:
            status = int(lines[0].split()[1])
        except (IndexError, ValueError):
            sock.close()
            raise HandshakeError(-1, {}, resp)
        h = {}
        for ln in lines[1:]:
            if ":" in ln:
                k, _, v = ln.partition(":")
                h[k.strip().lower()] = v.strip()
        if status != 101:
            sock.close()
            raise HandshakeError(status, h, resp)
        expect = base64.b64encode(hashlib.sha1((key + _GUID).encode("ascii")).digest()).decode("ascii")
        if h.get("sec-websocket-accept") != expect:
            sock.close()
            raise HandshakeError(-2, h, resp)
        return cls(sock, buffered=_rest)

    # ---------------- 帧编解码

    def send_frame(self, opcode: int, payload: bytes = b"") -> None:
        mask = secrets.token_bytes(4)
        n = len(payload)
        b1 = 0x80 | opcode
        if n < 126:
            hdr = bytes((b1, 0x80 | n))
        elif n <= 0xFFFF:
            hdr = bytes((b1, 0x80 | 126)) + n.to_bytes(2, "big")
        else:
            hdr = bytes((b1, 0x80 | 127)) + n.to_bytes(8, "big")
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(hdr + mask + masked)

    def send_json(self, obj: dict) -> None:
        self.send_frame(OP_TEXT, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def ping(self, payload: bytes = b"") -> None:
        self.send_frame(OP_PING, payload)

    def _recv_exact(self, n: int) -> bytes:
        buf = bytearray()
        if self._buf:                     # 先吃握手残留缓冲
            take = min(n, len(self._buf))
            buf += self._buf[:take]
            del self._buf[:take]
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("对端关闭")
            buf.extend(chunk)
        return bytes(buf)

    def recv_frame(self, timeout: float | None = None):
        """→ (opcode, payload)。服务端帧不 mask（mask 置位则视为协议错）。"""
        old = self.sock.gettimeout()
        if timeout is not None:
            self.sock.settimeout(timeout)
        try:
            b1, b2 = self._recv_exact(2)
            opcode = b1 & 0x0F
            masked = bool(b2 & 0x80)
            length = b2 & 0x7F
            if length == 126:
                length = int.from_bytes(self._recv_exact(2), "big")
            elif length == 127:
                length = int.from_bytes(self._recv_exact(8), "big")
            mask = self._recv_exact(4) if masked else None
            data = self._recv_exact(length) if length else b""
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            return opcode, data
        finally:
            if timeout is not None:
                self.sock.settimeout(old)

    def recv_json(self, timeout: float | None = None) -> dict:
        """收下一条 text 帧并 JSON 解析；途中 ping 自动回 pong、pong 跳过、close 抛 ConnectionError。"""
        while True:
            opcode, payload = self.recv_frame(timeout=timeout)
            if opcode == OP_PING:
                self.send_frame(OP_PONG, payload)
                continue
            if opcode == OP_PONG:
                continue
            if opcode == OP_CLOSE:
                self.closed = True
                code = int.from_bytes(payload[:2], "big") if len(payload) >= 2 else 1005
                raise ConnectionError(f"对端关闭（close {code}）")
            if opcode == OP_TEXT:
                return json.loads(payload.decode("utf-8"))

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            self.send_frame(OP_CLOSE, b"")
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass
