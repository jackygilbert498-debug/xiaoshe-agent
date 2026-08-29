"""tests/ui_server：安全门五条攻击用例 / WS 编解码 round-trip / 审批生命周期 / 快照脱敏 / msg_id 分页。

每个用例起 ephemeral 端口（port=0）的真实服务实例 + 临时 .state，互不污染。
运行：python -m unittest tests.ui_server.test_server -v
"""
from __future__ import annotations

import http.client
import json
import os
import queue
import socket
import sys
import tempfile
import threading
import time
import unittest
from copy import deepcopy
from collections import OrderedDict
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from harness import agent, permission, tools as tools_mod, ui_bus, ui_server, ui_state, viewport  # noqa: E402
from wsprobe import WSClient, HandshakeError  # noqa: E402

OP_TEXT, OP_CLOSE, OP_PING, OP_PONG = 0x1, 0x8, 0x9, 0xA


def _fake_ctx(sid: str, tmp: Path) -> dict:
    return {"todos": [], "memory_file": tmp / "memory.json", "_interactive": True,
            "_persistent_approved": set(), "_vision_pending": [], "_notes": [],
            "_denied_calls": 0, "session_id": sid}


class ServerCase(unittest.TestCase):
    """基座：临时 state_dir + UISession + ui_bus.init + ephemeral HTTP。"""

    static_with_index = False

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        self.state_dir = tmp / ".state"
        self.state_dir.mkdir(parents=True)
        self.sid = "test-" + os.urandom(3).hex()
        self.history = []
        self.ctx = _fake_ctx(self.sid, tmp)
        ui_bus.init(self.ctx, self.sid, self.state_dir, snapshot_fn=ui_state.collect_dirty)
        ui_bus.bind_ctx(self.ctx)
        self.sess = ui_server.UISession(self.ctx, self.sid, self.history,
                                        self.state_dir / "log.jsonl", self.state_dir,
                                        model_fn=lambda *a, **k: {"role": "assistant", "content": "ok"})
        self.token = self.sess.tokens.generate()
        static = None
        if self.static_with_index:
            static = tmp / "ui"
            static.mkdir()
            (static / "index.html").write_text("<html><body>xs</body></html>", encoding="utf-8")
        self.httpd = ui_server.create_server(self.sess, port=0, static_root=static)
        self.port = self.httpd.server_address[1]
        self._t = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05},
                                   daemon=True)
        self._t.start()

    def tearDown(self):
        try:
            self.httpd.shutdown()
            self.httpd.server_close()
        finally:
            ui_bus.close_all_pending("test-teardown")
            ui_bus.shutdown()
            self._tmp.cleanup()

    # ---------------- HTTP 小助手

    def http(self, method, path, token="__KEEP__", headers=None, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        hdrs = dict(headers or {})
        if token == "__KEEP__":                       # 默认带上本用例的合法 token
            hdrs.setdefault("Authorization", f"Bearer {self.token}")
        if isinstance(body, (dict, list)):
            # http.client 在 Python 3.13 拒绝含中文的 str body（默认按 latin-1 编码）；
            # 真实浏览器发的是 UTF-8 字节，测试助手也必须一致。
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            hdrs.setdefault("Content-Type", "application/json")
        conn.request(method, path, body=body, headers=hdrs)
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        try:
            parsed = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            parsed = None
        return resp.status, dict(resp.getheaders()), parsed, data

    def get(self, path, **kw):
        return self.http("GET", path, **kw)


# ---------------------------------------------------------------- S1–S5 安全门

class TestSecurityGates(ServerCase):
    static_with_index = True

    def test_s1_bind_loopback_only(self):
        """S1：仅绑 127.0.0.1；create_server 不提供 host/0.0.0.0 配置项。"""
        self.assertEqual(self.httpd.server_address[0], "127.0.0.1")
        import inspect
        params = set(inspect.signature(ui_server.create_server).parameters)
        self.assertNotIn("host", params)
        self.assertNotIn("bind", params)

    def test_s2_token_gates(self):
        """S2：无 token 401、错 403；token 文件 0600；reset 后旧 token 作废。"""
        st, _, body, _ = self.http("GET", "/api/state", token=None)
        self.assertEqual(st, 401)
        self.assertEqual(body["error"]["code"], "unauthorized")
        st, _, _, _ = self.http("GET", "/api/state", headers={"Authorization": "Bearer " + "0" * 32},
                                token=None)
        self.assertEqual(st, 403)
        st, _, body, _ = self.get("/api/state")
        self.assertEqual(st, 200)
        self.assertEqual(body["v"], 1)
        mode = os.stat(self.state_dir / "ui_token").st_mode & 0o777
        if sys.platform == "win32":
            # Windows NTFS 无 Unix 权限位：os.open(0o600)/chmod(0o600) 在 NTFS 上静默忽略，
            # stat 返回 0666（MSVCRT 模拟层行为）。安全语义由「仅绑 127.0.0.1 + token 配对」承接，
            # 权限位在 Windows 上不可达，放宽断言（POSIX 平台仍硬断言 0600）。
            self.assertIn(mode, (0o600, 0o666), oct(mode))
        else:
            self.assertEqual(mode, 0o600, oct(mode))
        # reset：旧 token 换新，旧即作废
        st, _, body, _ = self.http("POST", "/api/token/reset", body={})
        self.assertEqual(st, 200)
        new_token = body["token"]
        self.assertNotEqual(new_token, self.token)
        st, _, _, _ = self.http("GET", "/api/state", headers={"Authorization": f"Bearer {self.token}"},
                                token=None)
        self.assertEqual(st, 403)
        st, _, _, _ = self.http("GET", "/api/state", headers={"Authorization": f"Bearer {new_token}"},
                                token=None)
        self.assertEqual(st, 200)

    def test_s2_lockout_429(self):
        """S2：连续 10 次错锁 60s——第 11 次（含正确 token）→ 429。"""
        for i in range(10):
            st, _, _, _ = self.http("GET", "/api/state",
                                    headers={"Authorization": f"Bearer bad{i}"}, token=None)
            self.assertEqual(st, 403, f"第 {i + 1} 次应为 403")
        st, _, body, _ = self.http("GET", "/api/state",
                                   headers={"Authorization": "Bearer bad11"}, token=None)
        self.assertEqual(st, 429)
        self.assertEqual(body["error"]["code"], "locked")
        st, _, _, _ = self.get("/api/state")    # 锁定期内正确 token 也 429
        self.assertEqual(st, 429)

    def test_s2_token_masked_in_logs(self):
        masked = self.sess.tokens.mask(f"token={self.token} 泄密检查")
        self.assertNotIn(self.token, masked)
        self.assertIn("***", masked)

    def test_s3_host_whitelist(self):
        """S3：错 Host → 421；localhost:port / 尾点变体放行。"""
        st, _, body, _ = self.get("/api/state", headers={"Host": "evil.rebind.com"})
        self.assertEqual(st, 421)
        self.assertEqual(body["error"]["code"], "bad_host")
        st, _, _, _ = self.get("/api/state", headers={"Host": "10.0.0.9:7788"})
        self.assertEqual(st, 421)
        st, _, _, _ = self.get("/api/state", headers={"Host": f"localhost:{self.port}"})
        self.assertEqual(st, 200)
        st, _, _, _ = self.get("/api/state", headers={"Host": f"LOCALHOST.:{self.port}"})
        self.assertEqual(st, 200)   # 规范化：大小写 + 尾点

    def test_s4_origin_whitelist(self):
        """S4：跨源 → 403；无 Origin 放行；本服务源放行。"""
        st, _, _, _ = self.get("/api/state", headers={"Origin": "http://evil.com"})
        self.assertEqual(st, 403)
        st, _, _, _ = self.get("/api/state", headers={"Origin": "https://127.0.0.1:%d" % self.port})
        self.assertEqual(st, 403)   # scheme 不符也拒（仅 http）
        st, _, _, _ = self.get("/api/state", headers={"Origin": f"http://127.0.0.1:{self.port}"})
        self.assertEqual(st, 200)
        st, _, _, _ = self.get("/api/state", headers={"Origin": f"http://localhost:{self.port}"})
        self.assertEqual(st, 200)

    def test_s5_static_containment_and_csp(self):
        """S5：静态 realpath 限定 ui/ 树内（穿越 404）；CSP 头在 HTML 响应上。"""
        st, _, _, _ = self.get("/../run.py")
        self.assertEqual(st, 404)
        st, _, _, _ = self.get("/..%2f..%2f.env")
        self.assertEqual(st, 404)
        st, hdrs, _, _ = self.get("/")
        self.assertEqual(st, 200)
        csp = hdrs.get("Content-Security-Policy", "")
        for frag in ("default-src 'self'", "script-src 'self'", "frame-ancestors 'none'",
                     f"ws://127.0.0.1:{self.port}"):
            self.assertIn(frag, csp)
        st, _, _, _ = self.get("/nonexistent.js")
        self.assertEqual(st, 404)   # 优雅 404

    def test_s5_images_traversal_404(self):
        """S5：/api/images/../ui_token 与 %2e 变体 → 404（ref 形态闸）。"""
        st, _, body, _ = self.get("/api/images/../ui_token")
        self.assertEqual(st, 404)
        self.assertEqual(body["error"]["code"], "not_found")
        st, _, _, _ = self.get("/api/images/..%2Fui_token")
        self.assertEqual(st, 404)
        st, _, _, _ = self.get("/api/images/img-999")
        self.assertEqual(st, 404)

    def test_ws_auth_and_host_gates(self):
        """S2/S3 在 WS 侧：无 token 401、错 403、错 Host 421、跨源 403。"""
        with self.assertRaises(HandshakeError) as cm:
            WSClient.connect("127.0.0.1", self.port, token=None)
        self.assertEqual(cm.exception.status, 401)
        with self.assertRaises(HandshakeError) as cm:
            WSClient.connect("127.0.0.1", self.port, token="0" * 32)
        self.assertEqual(cm.exception.status, 403)
        with self.assertRaises(HandshakeError) as cm:
            WSClient.connect("127.0.0.1", self.port, token=self.token,
                             host_header="evil.rebind.com")
        self.assertEqual(cm.exception.status, 421)
        with self.assertRaises(HandshakeError) as cm:
            WSClient.connect("127.0.0.1", self.port, token=self.token,
                             origin="http://evil.com")
        self.assertEqual(cm.exception.status, 403)
        ws = WSClient.connect("127.0.0.1", self.port, token=self.token)   # 子协议通道
        snap = ws.recv_json(timeout=5)
        self.assertEqual(snap["type"], "session.snapshot")
        ws.close()
        ws = WSClient.connect("127.0.0.1", self.port, token=self.token,
                              use_subprotocol=False)                     # Bearer 通道
        snap = ws.recv_json(timeout=5)
        self.assertEqual(snap["type"], "session.snapshot")
        ws.close()


# ---------------------------------------------------------------- WS 编解码 round-trip

class TestWSCodec(unittest.TestCase):
    """服务端帧构造（ws_build_frame）vs wsprobe 解析；客户端 mask 帧 vs 服务端 ws_read_frame。"""

    def _pair(self):
        a, b = socket.socketpair()
        if sys.platform != "win32":
            # macOS AF_UNIX socketpair 默认 SO_SNDBUF 仅 8KB：大载荷（65535/65536/100000 字节档）
            # sendall 在缓冲写满后永久阻塞（对端 recv 要等 sendall 返回才启动）→ 死锁。
            # Windows 的 socketpair 是 TCP 回环仿真，缓冲充足无此问题；故只在非 Windows 侧加大缓冲，
            # Windows 分支保持原字面逻辑（两侧语义零弱化）。
            a.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1 << 20)
            b.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1 << 20)
            a.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
            b.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
        return a, b

    def test_build_frame_three_length_tiers(self):
        for n in (0, 5, 125, 126, 200, 65535, 65536, 100_000):
            a, b = self._pair()
            payload = bytes(range(256)) * (n // 256) + bytes(range(n % 256))
            a.sendall(ui_server.ws_build_frame(OP_TEXT, payload))
            client = WSClient(b)
            opcode, got = client.recv_frame(timeout=5)
            self.assertEqual(opcode, OP_TEXT)
            self.assertEqual(got, payload, f"n={n}")
            a.close()
            b.close()

    def test_read_frame_masked_client(self):
        a, b = self._pair()
        client = WSClient(a)
        client.send_frame(OP_TEXT, b"hello-server")
        opcode, payload = ui_server.ws_read_frame(b)
        self.assertEqual((opcode, payload), (OP_TEXT, b"hello-server"))
        client.send_frame(OP_PING, b"x")
        opcode, payload = ui_server.ws_read_frame(b)
        self.assertEqual((opcode, payload), (OP_PING, b"x"))
        a.close()
        b.close()

    def test_unmasked_client_frame_rejected_1002(self):
        a, b = self._pair()
        a.sendall(bytes((0x81, 0x02)) + b"hi")     # 无 mask
        with self.assertRaises(ui_server.WSProtocolError) as cm:
            ui_server.ws_read_frame(b)
        self.assertEqual(cm.exception.code, 1002)
        a.close()
        b.close()

    def test_continuation_rejected_1003(self):
        a, b = self._pair()
        a.sendall(ui_server.ws_client_frame(0x0, b"cont"))   # continuation：不支持分片
        with self.assertRaises(ui_server.WSProtocolError) as cm:
            ui_server.ws_read_frame(b)
        self.assertEqual(cm.exception.code, 1003)
        a.close()
        b.close()

    def test_fragmented_data_frame_rejected_1003(self):
        a, b = self._pair()
        frame = ui_server.ws_client_frame(OP_TEXT, b"frag")
        frame = bytes((frame[0] & 0x7F,)) + frame[1:]         # FIN 置 0
        a.sendall(frame)
        with self.assertRaises(ui_server.WSProtocolError) as cm:
            ui_server.ws_read_frame(b)
        self.assertEqual(cm.exception.code, 1003)
        a.close()
        b.close()

    def test_oversize_frame_rejected_1009(self):
        a, b = self._pair()
        hdr = bytes((0x81, 0x80 | 127)) + (ui_server._WS_MAX_FRAME + 1).to_bytes(8, "big")
        a.sendall(hdr + b"\x00" * 4)                          # 声明 >1MB（不用真发负载）
        with self.assertRaises(ui_server.WSProtocolError) as cm:
            ui_server.ws_read_frame(b)
        self.assertEqual(cm.exception.code, 1009)
        a.close()
        b.close()


class TestWSLive(ServerCase):
    """活服务上的 WS 行为：snapshot 首发、ping/pong、无 mask 客户端被 close 1002。"""

    def test_snapshot_then_events_and_pong(self):
        ws = WSClient.connect("127.0.0.1", self.port, token=self.token)
        snap = ws.recv_json(timeout=5)
        self.assertEqual(snap["type"], "session.snapshot")
        payload = snap["payload"]
        self.assertEqual(payload["contract_v"], 1)
        self.assertEqual(payload["negotiated"], {"v": 1})
        for k in ("messages_tail", "state", "pending_approvals"):
            self.assertIn(k, payload)
        ui_bus.emit("system.alert", {"level": "info", "code": "t", "text": "hello"})
        ev = ws.recv_json(timeout=5)
        self.assertEqual(ev["type"], "system.alert")
        self.assertGreater(ev["seq"], snap["seq"])      # seq 单调
        ws.ping(b"hb")
        opcode, payload_b = ws.recv_frame(timeout=5)
        self.assertEqual((opcode, payload_b), (OP_PONG, b"hb"))
        ws.close()

    def test_unmasked_client_gets_close_1002(self):
        ws = WSClient.connect("127.0.0.1", self.port, token=self.token)
        ws.recv_json(timeout=5)
        ws.sock.sendall(bytes((0x81, 0x02)) + b"hi")    # 裸发无 mask 帧
        opcode, payload = ws.recv_frame(timeout=5)
        self.assertEqual(opcode, OP_CLOSE)
        self.assertEqual(int.from_bytes(payload[:2], "big"), 1002)
        ws.close()


# ---------------------------------------------------------------- 审批生命周期（SPEC §8）

class TestApprovalLifecycle(ServerCase):
    def _approver_thread(self, name, args, reason="r", force_ask=False):
        box = {}
        t = threading.Thread(
            target=lambda: box.setdefault("verdict", self.sess.ui_approver(
                name, args, reason, force_ask=force_ask)),
            daemon=True)
        t.start()
        return t, box

    def _wait_request(self, subq, timeout=5):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                ev = subq.get(timeout=deadline - time.time())
            except queue.Empty:
                break
            if ev.get("type") == "approval.request":
                return ev
        self.fail("没等到 approval.request")

    def test_request_fields_and_four_verdicts(self):
        """register→request 事件（字段齐）→resolve→resolved 事件→wait_verdict 四值。"""
        subq = ui_bus.subscribe()
        try:
            for decision, expect in (("y", True), ("n", False), ("a", "always"), ("p", "persist")):
                t, box = self._approver_thread("write_file", {"path": "笔记.md", "content": "x"})
                ev = self._wait_request(subq)
                p = ev["payload"]
                self.assertRegex(p["request_id"], r"^ap-\d+$")
                self.assertEqual(p["tool"], "write_file")
                self.assertEqual(p["approval_key"], "write_file:笔记.md")   # R2 §1 原文指纹
                self.assertEqual(p["resolved_path"], str(permission.resolve("笔记.md")))
                self.assertFalse(p["tainted"])
                self.assertFalse(p["force_ask"])
                self.assertIn(p, ui_bus.pending_approvals())                 # 断线未决不丢（重连带回）
                ok = self.sess.handle_approve({"request_id": p["request_id"], "decision": decision})
                self.assertTrue(ok)
                t.join(timeout=5)
                self.assertEqual(box.get("verdict"), expect, decision)
                resolved = subq.get(timeout=5)
                self.assertEqual(resolved["type"], "approval.resolved")
                self.assertEqual(resolved["payload"], {"request_id": p["request_id"], "decision": decision})
                self.assertEqual(ui_bus.pending_approvals(), [])
        finally:
            ui_bus.unsubscribe(subq)

    def test_resolved_path_variants(self):
        """resolved_path：非 path 类 null / resolve 异常 {"error":"path_error","raw"}。"""
        self.assertIsNone(ui_server._resolved_path_for("run_command", {"command": "ls"}))
        v = ui_server._resolved_path_for("write_file", {"path": "a.txt"})
        self.assertEqual(v, str(permission.resolve("a.txt")))
        v = ui_server._resolved_path_for("write_file", {"path": "a\x00b.txt"})
        self.assertIsInstance(v, dict)
        self.assertEqual(v["error"], "path_error")
        self.assertEqual(v["raw"], "a\x00b.txt")

    def test_resolved_path_rejects_control_before_pathlib_and_truncates_raw(self):
        raw = "x" * 100 + "\x00tail"
        value = ui_server._resolved_path_for("write_file", {"path": raw})
        self.assertEqual(value, {"error": "path_error", "raw": "x" * 80})

    def test_args_tamper_closes_with_n(self):
        """R2 §9-4：批准后 args 快照被改写（pick 视口注册表被清）→ 指纹重算不一致 → 以 n 结案 + system.alert。"""
        reg = OrderedDict()
        reg["v1"] = viewport.new_viewport("v1", (0, 0), 1.0, (100, 100), marks={
            1: {"no": 1, "label": "btn", "screen_cx": 10, "screen_cy": 20, "source": "uia"}})
        self.ctx["_viewport_registry"] = reg
        subq = ui_bus.subscribe()
        try:
            t, box = self._approver_thread("pick", {"viewport_id": "v1", "mark_no": 1})
            ev = self._wait_request(subq)
            self.assertEqual(ev["payload"]["approval_key"], "pick:v1,1:10,20")
            self.ctx["_viewport_registry"] = OrderedDict()      # 篡改：注册表被换 → 重算指纹变
            ok = self.sess.handle_approve({"request_id": ev["payload"]["request_id"], "decision": "y"})
            self.assertTrue(ok)
            t.join(timeout=5)
            self.assertIs(box.get("verdict"), False)            # fail-closed
            resolved = subq.get(timeout=5)
            self.assertEqual(resolved["payload"]["decision"], "n")
            alert = subq.get(timeout=5)
            self.assertEqual(alert["type"], "system.alert")
            self.assertEqual(alert["payload"]["code"], "approval_args_mismatch")
        finally:
            ui_bus.unsubscribe(subq)

    def test_pending_survives_and_close_all_pending_n(self):
        """断线未决仍在 pending_approvals；close_all_pending 全部以 n 结案。"""
        t, box = self._approver_thread("run_command", {"command": "echo hi"})
        deadline = time.time() + 5
        while not ui_bus.pending_approvals() and time.time() < deadline:
            time.sleep(0.05)
        pending = ui_bus.pending_approvals()
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["approval_key"], "run_command:echo hi")
        ui_bus.close_all_pending("cancel")
        t.join(timeout=5)
        self.assertIs(box.get("verdict"), False)
        self.assertEqual(ui_bus.pending_approvals(), [])

    def test_cancel_event_closes_pending(self):
        """上行 cancel：_cancel_event 置位 + 未决审批以 n 结案（wait_verdict 返回 False）。"""
        t, box = self._approver_thread("run_command", {"command": "sleep 9"})
        deadline = time.time() + 5
        while not ui_bus.pending_approvals() and time.time() < deadline:
            time.sleep(0.05)
        self.sess.handle_cancel()
        t.join(timeout=5)
        self.assertIs(box.get("verdict"), False)
        self.assertTrue(self.ctx["_cancel_event"].is_set())


# ---------------------------------------------------------------- tools validator / 快照脱敏 + msg_id

class TestToolsEtag(ServerCase):
    def test_tools_weak_etag_ignores_server_time(self):
        """稳定 tools 资源跨秒仍命中弱验证器；200 响应保留 v1 server_time。"""
        with mock.patch.object(ui_server, "_now", side_effect=[
                "2026-08-02T04:18:40+08:00", "2026-08-02T04:18:41+08:00"]):
            st1, hdr1, body1, _ = self.get("/api/tools")
            etag = hdr1.get("ETag", "")
            st2, hdr2, body2, raw2 = self.get(
                "/api/tools", headers={"If-None-Match": etag})

        self.assertEqual(st1, 200)
        self.assertEqual(body1["v"], 1)
        self.assertIn("server_time", body1)
        self.assertTrue(etag.startswith('W/"'))
        self.assertEqual(st2, 304)
        self.assertEqual(body2, None)
        self.assertEqual(raw2, b"")
        self.assertEqual(hdr2.get("ETag"), etag)

    def test_tools_validator_matches_tag_on_later_repeated_header_line(self):
        """重复 If-None-Match 字段的后续行命中当前弱验证器时仍返回 304。"""
        st, hdrs, _, _ = self.get("/api/tools")
        self.assertEqual(st, 200)
        etag = hdrs["ETag"]

        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.putrequest("GET", "/api/tools")
        conn.putheader("Authorization", f"Bearer {self.token}")
        conn.putheader("If-None-Match", 'W/"miss"')
        conn.putheader("If-None-Match", etag)
        conn.endheaders()
        resp = conn.getresponse()
        raw = resp.read()
        response_headers = dict(resp.getheaders())
        conn.close()

        self.assertEqual(resp.status, 304)
        self.assertEqual(raw, b"")
        self.assertEqual(response_headers.get("ETag"), etag)

    def test_tools_validator_changes_when_description_changes(self):
        """描述变更也必须使稳定 tools resource validator 失效。"""
        original = tools_mod.all_specs()
        changed = deepcopy(original)
        changed[0]["function"]["description"] = "etag regression: changed description"
        with mock.patch.object(tools_mod, "all_specs", side_effect=[original, changed]):
            st1, hdr1, body1, _ = self.get("/api/tools")
            etag1 = hdr1.get("ETag", "")
            st2, hdr2, body2, _ = self.get(
                "/api/tools", headers={"If-None-Match": etag1})

        self.assertEqual(st1, 200)
        self.assertTrue(etag1.startswith('W/"'))
        self.assertEqual(st2, 200)
        self.assertNotEqual(hdr2.get("ETag"), etag1)
        for key in ("v", "server_time", "count", "tools", "registry_rev"):
            self.assertIn(key, body2)
        self.assertEqual(body1["registry_rev"], body2["registry_rev"])
        self.assertNotEqual(body1["tools"][0]["description"], body2["tools"][0]["description"])

    def test_tools_validator_uses_weak_if_none_match_comparison(self):
        """强/弱、列表及通配符按弱比较命中；畸形 token 不得命中。"""
        st, hdrs, _, _ = self.get("/api/tools")
        self.assertEqual(st, 200)
        weak = hdrs["ETag"]
        strong = weak[2:]
        headers_and_expected = [
            (strong, 304),
            ('"other", ' + strong, 304),
            ("*", 304),
            ('W/"opaque,with-comma", ' + strong, 304),
            ("opaque", 200),
        ]
        for header, expected in headers_and_expected:
            with self.subTest(header=header):
                got, _, _, _ = self.get("/api/tools", headers={"If-None-Match": header})
                self.assertEqual(got, expected)


class TestIfNoneMatchParsing(unittest.TestCase):
    def test_weak_comparison_handles_quotes_lists_and_wildcard(self):
        current = 'W/"opaque,with-comma"'
        self.assertTrue(ui_server._if_none_match_matches(current, '"opaque,with-comma"'))
        self.assertTrue(ui_server._if_none_match_matches(
            current, 'W/"other,tag", "opaque,with-comma"'))
        self.assertTrue(ui_server._if_none_match_matches(current, "*"))
        self.assertFalse(ui_server._if_none_match_matches(current, "opaque,with-comma"))
        self.assertFalse(ui_server._if_none_match_matches(current, 'W/"other,tag"'))


# ---------------------------------------------------------------- 快照脱敏 + msg_id

class TestSnapshotSanitize(ServerCase):
    def test_snapshot_no_sensitive_leak(self):
        """快照不含 token/.env/_tainted 原文/runtime 句柄键（白名单产出天然脱敏）。"""
        secret_taint = "SECRET_TAINT_SPAN_绝不许出现_1234567890abcdef"
        self.ctx["_tainted"] = {secret_taint}
        self.ctx["_model_fn"] = object()
        self.ctx["_log_file"] = Path("/tmp/x")
        self.ctx["_approved_tools"] = {"write_file:a.txt"}
        self.ctx["_vision_pending"] = ["img-1"]
        self.ctx["todos"] = [{"content": "干活", "status": "in_progress"}]
        self.ctx["_stall"] = {"count": 1, "limit": 3, "at": "t"}
        self.ctx["_last_usage"] = {"prompt_tokens": 100, "completion_tokens": 9,
                                   "prompt_tokens_details": {"cached_tokens": 40},
                                   "secret_field": "绝不许出现_secret_field"}
        snap = ui_state.snapshot_full(self.ctx)
        blob = json.dumps(snap, ensure_ascii=False)
        for bad in (secret_taint, "_tainted", "_model_fn", "_log_file", "secret_field", self.token):
            self.assertNotIn(bad, blob)
        self.assertEqual(snap["todos"][0]["content"], "干活")
        self.assertEqual(snap["approved_tools"], [{"key": "write_file:a.txt", "scope": "session"}])
        self.assertEqual(snap["vision_pending"], [{"ref": "img-1", "target": None}])
        self.assertEqual(snap["usage"]["input_tokens"], 100)
        self.assertEqual(snap["usage"]["cache_read"], 40)
        self.assertEqual(snap["denied_calls"], 0)
        # state 经 REST 也一样
        st, _, body, _ = self.get("/api/state")
        self.assertEqual(st, 200)
        self.assertNotIn(secret_taint, json.dumps(body, ensure_ascii=False))

    def test_collect_dirty_channels(self):
        out = ui_state.collect_dirty(self.ctx, ["todos", "viewport", "jobs", "pick_diff"])
        channels = [c for c, _ in out]
        self.assertIn("state.patch", channels)
        self.assertIn("viewport.update", channels)
        self.assertIn("job.update", channels)
        patch = dict(out)["state.patch"]
        self.assertIn("todos", patch)
        self.assertEqual(patch["pick_diff"]["status"], "unknown")     # 空态
        self.assertEqual(dict(out)["viewport.update"]["viewport_id"], None)

    def test_viewport_current_chain_and_updated_at(self):
        reg = OrderedDict()
        reg["v1"] = viewport.new_viewport("v1", (0, 0), 1.0, (100, 100), marks={
            2: {"no": 2, "label": "x", "screen_cx": 1, "screen_cy": 2, "source": "ocr"}})
        reg["v2"] = viewport.new_viewport("v2", (0, 0), 2.0, (50, 50), parent_id="v1")
        reg["v2"]["screenshot_ref"] = "img-7"
        reg["v2"]["created_at"] = "2026-07-26T10:00:00+08:00"
        self.ctx["_viewport_registry"] = reg
        cur = ui_state.viewport_current(self.ctx)
        self.assertEqual(cur["viewport_id"], "v2")
        self.assertEqual(cur["chain"], ["v1", "v2"])
        self.assertEqual(cur["screenshot_ref"], "img-7")
        self.assertEqual(cur["updated_at"], "2026-07-26T10:00:00+08:00")   # 契约仲裁 1：created_at→updated_at
        self.assertEqual(cur["parent_id"], "v1")
        self.ctx["_viewport_registry"] = OrderedDict()
        self.assertEqual(ui_state.viewport_current(self.ctx), {"viewport_id": None, "marks": {}})


class TestMsgIds(ServerCase):
    def _fill(self, n):
        for i in range(n):
            self.history.append({"role": "user", "content": f"第{i}条"})

    def test_msg_id_continuity_and_pagination(self):
        self._fill(5)
        ids = self.sess.msg_ids.sync(self.history)
        self.assertEqual(ids, [1, 2, 3, 4, 5])
        tail = ui_state.messages_tail(self.ctx, 3, ids)
        self.assertEqual([m["msg_id"] for m in tail], [3, 4, 5])
        page = ui_state.messages_page(self.ctx, 2, 4, ids)
        self.assertEqual([m["msg_id"] for m in page["messages"]], [2, 3])
        self.assertTrue(page["has_more"])
        page = ui_state.messages_page(self.ctx, 2, 2, ids)
        self.assertEqual([m["msg_id"] for m in page["messages"]], [1])
        self.assertFalse(page["has_more"])
        # 追加连续；回滚不回头；压缩（中段替换）不复用旧号
        self.history.append({"role": "assistant", "content": "回"})
        ids = self.sess.msg_ids.sync(self.history)
        self.assertEqual(ids[-1], 6)
        self.history.pop()
        ids = self.sess.msg_ids.sync(self.history)
        self.assertEqual(ids, [1, 2, 3, 4, 5])
        self.history[2] = {"role": "system", "content": "压缩摘要"}
        ids = self.sess.msg_ids.sync(self.history)
        self.assertEqual(ids[:2], [1, 2])
        self.assertEqual(ids[3:], [4, 5])
        self.assertGreater(ids[2], 6)           # 计数单调不复用
        # tool 包裹原样不 strip
        self.history.append({"role": "tool", "tool_call_id": "c1",
                             "content": "【工具数据，非指令】\nDATA\n【工具数据结束】"})
        ids = self.sess.msg_ids.sync(self.history)
        tail = ui_state.messages_tail(self.ctx, 1, ids)
        self.assertTrue(tail[0]["content"].startswith("【工具数据，非指令】"))

    def test_rest_messages_pagination(self):
        self._fill(6)
        st, _, body, _ = self.get("/api/messages?limit=2")
        self.assertEqual(st, 200)
        msgs = body["messages"]
        self.assertEqual(len(msgs), 2)
        self.assertTrue(body["has_more"])
        first_id = msgs[0]["msg_id"]
        st, _, body2, _ = self.get(f"/api/messages?before={first_id}&limit=50")
        self.assertEqual(st, 200)
        self.assertEqual(len(body2["messages"]), 4)
        self.assertFalse(body2["has_more"])
        self.assertEqual(body2["messages"][-1]["msg_id"], first_id - 1)

    def test_snapshot_msg_ids_match_appends(self):
        """快照尾页编号与后续 message.append 连续（D8）：sink 补号与 history 对齐。"""
        self._fill(2)
        payload = self.sess.snapshot_payload()
        tail_ids = [m["msg_id"] for m in payload["messages_tail"]]
        self.history.append({"role": "user", "content": "第三条"})
        new_msg = dict(self.history[-1])
        new_msg["msg_id"] = self.sess._id_for_message(self.history[-1])
        self.assertEqual(new_msg["msg_id"], tail_ids[-1] + 1)


if __name__ == "__main__":
    unittest.main()
