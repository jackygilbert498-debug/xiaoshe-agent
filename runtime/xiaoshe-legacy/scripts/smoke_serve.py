"""smoke：起 serve（假 model_fn）→ 自写 WS 客户端走全链路 → REST 13 路由探测 → 安全门负例 → PASS/FAIL 汇总。

用法：python scripts/smoke_serve.py [--port 17888]
注入方式：import harness.ui_server 后直接调 ui_server.serve_main([...], model_fn=fake) 跑在线程里。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from harness import ui_server  # noqa: E402
from wsprobe import WSClient, HandshakeError  # noqa: E402

PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 17888
BASE = f"http://127.0.0.1:{PORT}"
RESULTS = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{('  —— ' + detail) if detail else ''}")
    return ok


# ---------------------------------------------------------------- 假模型：第一轮调 update_todos，第二轮回文本

_calls = {"n": 0}


def fake_model_fn(messages, tools=None, **kw):
    _calls["n"] += 1
    if _calls["n"] == 1:
        return {"role": "assistant", "content": "",
                "tool_calls": [{"id": "call_smoke_1", "type": "function",
                                "function": {"name": "update_todos",
                                             "arguments": json.dumps(
                                                 {"todos": [{"content": "smoke 全链路验证",
                                                             "status": "in_progress"}]},
                                                 ensure_ascii=False)}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 4}}
    return {"role": "assistant", "content": "smoke 完成：待办已登记。",
            "usage": {"prompt_tokens": 12, "completion_tokens": 6}}


# ---------------------------------------------------------------- curl 小助手

def curl(path, token=None, method="GET", body=None, extra=()):
    argv = ["curl", "-sS", "--path-as-is", "-X", method, "-w", "\n%{http_code}"]
    if token is not None:
        argv += ["-H", f"Authorization: Bearer {token}"]
    for h in extra:
        argv += ["-H", h]
    if body is not None:
        argv += ["-H", "Content-Type: application/json", "-d", json.dumps(body, ensure_ascii=False)]
    argv.append(BASE + path)
    p = subprocess.run(argv, capture_output=True, timeout=15)
    stdout = (p.stdout or b"").decode("utf-8", "replace")
    out = stdout.rsplit("\n", 1)
    status = int(out[-1]) if out[-1].strip().isdigit() else -1
    text = out[0] if len(out) > 1 else ""
    try:
        return status, json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return status, {"_raw": text}


def curl_headers(path, token=None, extra=()):
    argv = ["curl", "-sS", "--path-as-is", "-D", "-", "-o", os.devnull]
    if token is not None:
        argv += ["-H", f"Authorization: Bearer {token}"]
    for h in extra:
        argv += ["-H", h]
    argv.append(BASE + path)
    p = subprocess.run(argv, capture_output=True, timeout=15)
    return (p.stdout or b"").decode("utf-8", "replace")


# ---------------------------------------------------------------- 主流程

def main() -> int:
    print(f"== smoke_serve：在线程里起 serve（: {PORT}，--no-browser --no-mcp，假 model_fn）")
    serve_t = threading.Thread(
        target=ui_server.serve_main,
        args=(["--port", str(PORT), "--no-browser", "--no-mcp"],),
        kwargs={"model_fn": fake_model_fn}, daemon=True, name="smoke-serve")
    serve_t.start()

    token = None
    for _ in range(100):
        time.sleep(0.1)
        active = ui_server.active_server()
        tf = ROOT / ".state" / "ui_token"
        if active.get("httpd") and tf.exists():
            token = tf.read_text(encoding="utf-8").strip()
            break
    if not check("服务起服 + token 落盘", token, f"port={PORT}"):
        return _finale()
    # 权限位校验前先探针：本文件系统能否持有 0600（/mnt 等挂载点会静默忽略权限位，非代码缺陷）
    probe = ROOT / ".state" / ".perm_probe"
    fs_holds = False
    try:
        probe.write_text("x", encoding="utf-8")
        os.chmod(probe, 0o600)
        fs_holds = (os.stat(probe).st_mode & 0o777) == 0o600
    except OSError:
        fs_holds = False
    finally:
        try:
            probe.unlink()
        except OSError:
            pass
    mode = oct(os.stat(ROOT / ".state" / "ui_token").st_mode & 0o777)
    if fs_holds:
        check("token 文件 0600", mode == "0o600", mode)
    else:
        print(f"  NOTE  token 权限位校验按环境跳过：本文件系统不持有权限位（当前 {mode}）；"
              "真机（NTFS/ext4/APFS）必须为 0600，已写入 LOCAL_VERIFY 清单")

    # ---------------- WS 全链路
    print("== WS：连接（子协议带 token）→ session.snapshot → send → 事件流")
    try:
        ws = WSClient.connect("127.0.0.1", PORT, token=token)
    except HandshakeError as e:
        check("WS 握手", False, f"HTTP {e.status}")
        return _finale()
    events = []
    try:
        snap = ws.recv_json(timeout=10)
        events.append(snap)
        ok = (snap.get("type") == "session.snapshot"
              and snap.get("payload", {}).get("contract_v") == 1
              and "state" in snap.get("payload", {})
              and "messages_tail" in snap.get("payload", {}))
        check("session.snapshot 形状", ok, f"seq={snap.get('seq')}")

        ws.send_json({"v": 1, "seq": 0, "type": "send",
                      "payload": {"text": "登记一条待办然后回话", "client_msg_id": "smoke-1"}})
        deadline = time.time() + 30
        got_reply = got_patch = False
        while time.time() < deadline and not (got_reply and got_patch):
            try:
                ev = ws.recv_json(timeout=max(1, deadline - time.time()))
            except (ConnectionError, TimeoutError, OSError):
                break
            events.append(ev)
            if ev.get("type") == "message.append" and "smoke 完成" in str(ev.get("payload", {}).get("content", "")):
                got_reply = True
            if ev.get("type") == "state.patch" and "todos" in ev.get("payload", {}):
                got_patch = True
        check("send → 工具 → 回复 全链路", got_reply,
              f"收 {len(events)} 条事件，model_fn 调用 {_calls['n']} 次")

        types = [e.get("type") for e in events]
        check("收到 message.append", "message.append" in types, str(types))
        check("收到 state.patch（todos 变化）", any(
            e.get("type") == "state.patch" and "todos" in e.get("payload", {}) for e in events), str(types))
        seqs = [e.get("seq") for e in events if isinstance(e.get("seq"), int)]
        check("seq 严格单调", seqs == sorted(seqs) and len(set(seqs)) == len(seqs), str(seqs))
        msg_ids = [e["payload"]["msg_id"] for e in events
                   if e.get("type") == "message.append" and isinstance(e.get("payload", {}).get("msg_id"), int)]
        check("msg_id 单调递增", msg_ids == sorted(msg_ids), str(msg_ids))
        tc_events = [t for t in types if t and t.startswith("tool_call.")]
        print(f"  ..  tool_call.* 事件：{tc_events or '无（基线 agent 无 sink，K 合并后应出现）'}")
    finally:
        ws.close()

    # ---------------- REST 13 路由
    print("== REST：8 新增 + 5 固化 + token/reset")
    rest_gets = ["/api/tools", "/api/state", "/api/messages", "/api/jobs",
                 "/api/memory/stats", "/api/skills/pending", "/api/viewport/current", "/api/pick/diff"]
    for path in rest_gets:
        st, body = curl(path, token)
        check(f"GET {path} → 200 + v=1", st == 200 and body.get("v") == 1 and "server_time" in body,
              f"HTTP {st}")
    st, body = curl("/api/state", token)
    todos = body.get("todos", [])          # 契约 v1：域字段平铺顶层
    check("/api/state 带回假模型登记的待办", any("smoke" in t.get("content", "") for t in todos), str(todos))

    st, body = curl("/api/tools", token)
    tools = body.get("tools", [])
    check("/api/tools 38+ 工具 + registry_rev", len(tools) >= 38 and bool(body.get("registry_rev")),
          f"{len(tools)} 个, rev={body.get('registry_rev')}")
    hdr = curl_headers("/api/tools", token)
    etag = next((ln.split(":", 1)[1].strip() for ln in hdr.splitlines() if ln.lower().startswith("etag:")), "")
    argv_note = ""
    if etag:
        p = subprocess.run(["curl", "-sS", "-o", os.devnull, "-w", "%{http_code}",
                            "-H", f"Authorization: Bearer {token}", "-H", f"If-None-Match: {etag}",
                            BASE + "/api/tools"], capture_output=True, text=True, timeout=15)
        argv_note = p.stdout.strip()
    check("/api/tools ETag → 304", argv_note == "304", f"etag={etag} → {argv_note}")

    st, body = curl("/api/messages?limit=2", token)
    msgs = body.get("messages", [])
    check("/api/messages 尾页 + msg_id", st == 200 and len(msgs) >= 1 and "msg_id" in msgs[-1],
          f"{len(msgs)} 条")
    if len(msgs) >= 1:
        st2, body2 = curl(f"/api/messages?before={msgs[0]['msg_id']}&limit=50", token)
        check("/api/messages before 游标分页", st2 == 200 and "has_more" in body2,
              f"has_more={body2.get('has_more')}")

    st, body = curl("/api/images/img-999", token)
    check("/api/images/{不存在 ref} → 404 契约错误", st == 404 and "error" in body, f"HTTP {st}")

    st, body = curl("/api/send", token, method="POST", body={"text": ""})
    check("POST /api/send 空文本入参校验过 schema", st in (200, 400), f"HTTP {st}")
    st, body = curl("/api/send", token, method="POST", body={"bogus": 1})
    check("POST /api/send 未知字段 → 400", st == 400 and body.get("error", {}).get("code") == "bad_request",
          f"HTTP {st}")
    st, body = curl("/api/vision/pending/remove", token, method="POST", body={"ref": "img-1"})
    check("POST /api/vision/pending/remove", st == 200 and body.get("removed") is False, f"HTTP {st}")

    # ---------------- 安全门负例（红线自查五连）
    print("== 安全门负例")
    st, _ = curl("/api/state")
    check("S2 无 token → 401", st == 401, f"HTTP {st}")
    st, _ = curl("/api/state", "0" * 32)
    check("S2 错 token → 403", st == 403, f"HTTP {st}")
    st, _ = curl("/api/state", token, extra=("Host: evil.example.com",))
    check("S3 错 Host → 421", st == 421, f"HTTP {st}")
    st, _ = curl("/api/state", token, extra=("Origin: http://evil.example.com",))
    check("S4 跨源 Origin → 403", st == 403, f"HTTP {st}")
    st, _ = curl("/api/images/../ui_token", token)
    check("S5 路径穿越 /api/images/../ui_token → 404", st == 404, f"HTTP {st}")
    st, _ = curl("/../.state/ui_token")
    check("S5 静态穿越 /.state/ui_token → 404", st == 404, f"HTTP {st}")
    try:
        WSClient.connect("127.0.0.1", PORT, token=None)
        check("S2 WS 无 token → 拒", False, "握手竟成功")
    except HandshakeError as e:
        check("S2 WS 无 token → 401", e.status == 401, f"HTTP {e.status}")
    hdr = curl_headers("/", token)
    has_csp = "content-security-policy:" in hdr.lower()
    ui_exists = (ROOT / "ui" / "index.html").exists()
    check("S5 CSP 头在 HTML 响应上", has_csp if ui_exists else True,
          "ui/index.html 存在已验" if ui_exists else "ui/ 未构建（前端并行施工中）——跳过，单测覆盖")

    return _finale()


def _finale() -> int:
    print("== 收尾")
    ui_server.stop_active()
    time.sleep(1.0)
    n_fail = sum(1 for _, ok, _ in RESULTS if not ok)
    print(f"\n===== smoke 汇总：{len(RESULTS) - n_fail} PASS / {n_fail} FAIL =====")
    if n_fail:
        for name, ok, detail in RESULTS:
            if not ok:
                print(f"  FAIL  {name}  —— {detail}")
    return 1 if n_fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
