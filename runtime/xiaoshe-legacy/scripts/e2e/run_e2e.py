"""E2E 场景回归：SPEC §13 的 8 条「小蛇界面」端到端场景，WS/REST 协议层驱动（不依赖浏览器）。

用法：python scripts/e2e/run_e2e.py [--port 17900]     退出码非 0 即有失败场景。

起服方式照 scripts/smoke_serve.py：同进程线程里 ui_server.serve_main(..., model_fn=剧本假模型)，
WS 客户端复用 scripts/wsprobe.py。剧本假模型经 SCRIPT["fn"] 按场景热切换。

覆盖层级说明：
- 场景③（压缩四 kind）走 serve 全链路（假 history + 假溢出 400 驱动 run_once/_send 真实压缩路径，
  事件经真实 WS 下行）；不是单测级直调 compaction。
- 场景④（look→zoom→pick→差分）是「runner 注入模拟」级：屏幕/OCR/点击子系统用 ctx 的
  _screencapture_runner/_ax_runner/_screen_size_runner/_ocr_runner/_clickxy_runner 注入句柄
  （tools.py 既有依赖注入点，test_look_tool 同款手法），其余链路（视口注册表/审批/WS 事件/REST）全真。
"""
from __future__ import annotations

import base64
import json
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from harness import agent, approvals, calibrate, imaging, ui_bus, ui_server, vision  # noqa: E402
from harness.kimi_client import KimiError  # noqa: E402
from wsprobe import WSClient  # noqa: E402

PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 17900
BASE = f"http://127.0.0.1:{PORT}"
RUN = f"{int(time.time()) % 100000}"          # 本次运行唯一后缀：审批指纹/文件名不跨运行复用（可连跑）
RESULTS: list = []
FIXTURES = ROOT / "tests" / "ui_contract" / "fixtures"


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{('  —— ' + str(detail)) if detail else ''}")
    return ok


# ---------------------------------------------------------------- 剧本假模型（按场景热切换）

SCRIPT: dict = {"fn": None}


def dispatch_model_fn(messages, tools=None, **kw):
    fn = SCRIPT.get("fn")
    if fn is None:
        return _assistant("（无剧本）")
    return fn(messages)


def _assistant(text: str):
    return {"role": "assistant", "content": text,
            "usage": {"prompt_tokens": 10, "completion_tokens": 4}}


def _tool_call(cid: str, name: str, args: dict):
    return {"role": "assistant", "content": "",
            "tool_calls": [{"id": cid, "type": "function",
                            "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 4}}


def _n_tool_msgs(messages) -> int:
    return sum(1 for m in messages if isinstance(m, dict) and m.get("role") == "tool")


def _is_summarize_req(messages) -> bool:
    return any(isinstance(m, dict) and m.get("role") == "system"
               and "对话压缩器" in str(m.get("content", "")) for m in messages[:2])


# ---------------------------------------------------------------- WS 事件收集器

class Collector:
    """包一层 WSClient：后台线程收事件进列表；wait_for/wait_scan 条件等待。"""

    def __init__(self, ws: WSClient):
        self.ws = ws
        self.events: list = []
        self.dead = False
        self._cv = threading.Condition()
        self._t = threading.Thread(target=self._loop, daemon=True, name="e2e-ws-reader")
        self._t.start()

    @classmethod
    def connect(cls, token: str) -> "Collector":
        return cls(WSClient.connect("127.0.0.1", PORT, token=token))

    def _loop(self):
        while not self.dead:
            try:
                ev = self.ws.recv_json(timeout=1.0)
            except (socket.timeout, TimeoutError):
                continue
            except (ConnectionError, OSError):
                self.dead = True
                break
            except (json.JSONDecodeError, ValueError):
                continue
            with self._cv:
                self.events.append(ev)
                self._cv.notify_all()

    def mark(self) -> int:
        with self._cv:
            return len(self.events)

    def slice(self, since: int = 0) -> list:
        with self._cv:
            return list(self.events[since:])

    def wait_for(self, pred, timeout: float = 30.0, since: int = 0):
        deadline = time.time() + timeout
        with self._cv:
            while True:
                for ev in self.events[since:]:
                    try:
                        if pred(ev):
                            return ev
                    except Exception:
                        pass
                if self.dead:
                    return None
                rem = deadline - time.time()
                if rem <= 0:
                    return None
                self._cv.wait(min(0.5, rem))

    def wait_scan(self, scan, timeout: float = 30.0, since: int = 0):
        """scan(events_slice) -> truthy 结果（用于跨事件关联断言）。"""
        deadline = time.time() + timeout
        while True:
            got = scan(self.slice(since))
            if got:
                return got
            if self.dead or time.time() >= deadline:
                return None
            time.sleep(0.1)

    def send_json(self, obj: dict) -> None:
        self.ws.send_json(obj)

    def send_text(self, text: str, cmid: str) -> None:
        self.send_json({"v": 1, "seq": 0, "type": "send",
                        "payload": {"text": text, "client_msg_id": cmid}})

    def approve(self, request_id: str, decision: str) -> None:
        self.send_json({"v": 1, "seq": 0, "type": "approve",
                        "payload": {"request_id": request_id, "decision": decision}})

    def command(self, name: str, args: dict | None = None) -> None:
        self.send_json({"v": 1, "seq": 0, "type": "command",
                        "payload": {"name": name, "args": args or {}}})

    def close(self) -> None:
        self.dead = True
        self.ws.close()

    def kill(self) -> None:
        """模拟断线：直接掐 socket（不发 close 帧、不应答任何未决审批）。"""
        self.dead = True
        try:
            self.ws.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.ws.sock.close()
        except OSError:
            pass


# ---------------------------------------------------------------- 事件谓词小助手

def ev_message_with(text: str):
    return lambda e: e.get("type") == "message.append" \
        and text in str(e.get("payload", {}).get("content", ""))


def ev_approval(path_sub: str | None = None):
    def pred(e):
        if e.get("type") != "approval.request":
            return False
        if path_sub is None:
            return True
        return path_sub in json.dumps(e.get("payload", {}).get("args", {}), ensure_ascii=False)
    return pred


def ev_compaction(kind: str):
    return lambda e: e.get("type") == "compaction.event" and e.get("payload", {}).get("kind") == kind


def scan_tool_end(status: str | None = None, path_sub: str | None = None):
    """跨事件关联：tool_call.start( args 含 path ) ↔ tool_call.end(status)。"""
    def scan(events):
        got = scan_tool_ends(status, path_sub)(events)
        return got[0] if got else None
    return scan


def scan_tool_ends(status: str | None = None, path_sub: str | None = None):
    """同 scan_tool_end，返回全部匹配对（用于「同指纹第二次」这类计数断言）。"""
    def scan(events):
        starts = {}
        for e in events:
            if e.get("type") == "tool_call.start":
                p = e.get("payload", {})
                starts[p.get("call_id")] = p
        out = []
        for e in events:
            if e.get("type") == "tool_call.end":
                p = e.get("payload", {})
                st = starts.get(p.get("call_id"), {})
                if status and p.get("status") != status:
                    continue
                if path_sub and path_sub not in json.dumps(st.get("args", {}), ensure_ascii=False):
                    continue
                out.append({"start": st, "end": p})
        return out
    return scan


def count_events(events, type_: str, path_sub: str | None = None) -> int:
    n = 0
    for e in events:
        if e.get("type") != type_:
            continue
        if path_sub is None or path_sub in json.dumps(e.get("payload", {}), ensure_ascii=False):
            n += 1
    return n


# ---------------------------------------------------------------- REST 小助手（urllib，Bearer token）

def http_req(path: str, token: str | None, method: str = "GET", body: dict | None = None):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if token is not None:
        req.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read()
            return resp.status, _json_or_raw(raw)
    except urllib.error.HTTPError as e:
        return e.code, _json_or_raw(e.read())
    except (urllib.error.URLError, OSError) as e:
        return -1, {"_raw": str(e)}


def _json_or_raw(raw: bytes):
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {"_raw": raw[:200].hex()}


# ---------------------------------------------------------------- 会话状态小助手

def session_obj():
    return ui_server.active_server()["session"]


def reset_history() -> None:
    sess = session_obj()
    with ui_bus.STATE_LOCK:
        sess.history[:] = agent._fresh_history()
        sess.msg_ids.sync(sess.history)
        sess.ctx.pop("_stall", None)


def seed_history(messages: list) -> None:
    sess = session_obj()
    with ui_bus.STATE_LOCK:
        sess.history[:] = messages
        sess.msg_ids.sync(sess.history)


def wait_runner_idle(timeout: float = 20.0) -> bool:
    """等上一轮 runner 彻底收尾（含 finally 里的存档）——否则下一条 send 会被 busy 拒掉。"""
    sess = session_obj()
    deadline = time.time() + timeout
    while time.time() < deadline:
        if sess._runner_lock.acquire(blocking=False):
            sess._runner_lock.release()
            return True
        time.sleep(0.1)
    return False


# ================================================================ 场景① 发送-工具-审批全链（y/n/a/p）

def sc1_approval_chain(col: Collector, token: str) -> None:
    print("== 场景① 发送 → write_file×4 → 审批 y/n/a/p 全链")
    f1, f2, f3, f4 = (f"e2e-{RUN}-f{i}.txt" for i in (1, 2, 3, 4))
    paths = [f1, f2, f3, f3, f4]           # 第 4 次 = 与 f3 同指纹（验 'a' 不再问）

    def script(messages):
        n = _n_tool_msgs(messages)
        if n < len(paths):
            return _tool_call(f"call_sc1_{n}", "write_file",
                              {"path": paths[n], "content": f"e2e 场景① 落盘 {paths[n]}\n"})
        return _assistant("E2E-SC1-DONE 四种审批决定已走完全链")

    SCRIPT["fn"] = script
    m0 = col.mark()
    col.send_text("依次写四个文件", "e2e-sc1")
    # 全程 since=m0 + 按路径区分审批（f1..f4 互不相同），避免「上一事件后 mark 已越过下一审批」的游标竞态

    # ---- y：批准后落盘
    ev = col.wait_for(ev_approval(f1), 30, since=m0)
    if not check("① y：approval.request 弹出（write_file f1）", ev):
        return
    p = ev["payload"]
    check("① 审批卡带 approval_key + realpath 规范化路径",
          p.get("approval_key") == f"write_file:{f1}"
          and isinstance(p.get("resolved_path"), str) and p["resolved_path"].endswith(f1),
          f"key={p.get('approval_key')} resolved={p.get('resolved_path')}")
    col.approve(p["request_id"], "y")
    got = col.wait_scan(scan_tool_end("ok", f1), 30, since=m0)
    check("① y：tool_call.end ok 且文件落盘",
          got and (ROOT / f1).is_file() and f"落盘 {f1}" in (ROOT / f1).read_text(encoding="utf-8"))

    # ---- n：拒绝后 denied 且不写盘
    ev = col.wait_for(ev_approval(f2), 30, since=m0)
    if not check("① n：approval.request 弹出（write_file f2）", ev):
        return
    col.approve(ev["payload"]["request_id"], "n")
    got = col.wait_scan(scan_tool_end("denied", f2), 30, since=m0)
    check("① n：tool_call.end status=denied 且不写盘", got and not (ROOT / f2).exists())
    check("① n：approval.resolved decision=n 广播",
          any(e.get("type") == "approval.resolved" and e.get("payload", {}).get("decision") == "n"
              for e in col.slice(m0)))

    # ---- a：会话白名单——同指纹第二次不再弹审批
    ev = col.wait_for(ev_approval(f3), 30, since=m0)
    if not check("① a：approval.request 弹出（write_file f3 第一次）", ev):
        return
    col.approve(ev["payload"]["request_id"], "a")
    got2 = col.wait_scan(lambda evs: scan_tool_ends("ok", f3)(evs)
                         if len(scan_tool_ends("ok", f3)(evs)) >= 2 else None, 30, since=m0)
    check("① a：同指纹第二次直接执行成功（两次 end ok）", got2 is not None)
    n_req_f3 = count_events(col.slice(m0), "approval.request", f3)
    check("① a：同指纹第二次不再弹审批", n_req_f3 == 1, f"f3 审批请求共 {n_req_f3} 次")
    check("① a：f3 落盘", (ROOT / f3).is_file())

    # ---- p：跨会话持久放行
    ev = col.wait_for(ev_approval(f4), 30, since=m0)
    if not check("① p：approval.request 弹出（write_file f4）", ev):
        return
    col.approve(ev["payload"]["request_id"], "p")
    check("① p：最终回复结案", col.wait_for(ev_message_with("E2E-SC1-DONE"), 60, since=m0) is not None)
    key4 = f"write_file:{f4}"
    check("① p：approvals.json 含该指纹", key4 in approvals.load(),
          f"approvals={sorted(approvals.load())[-3:]}")
    st, body = http_req("/api/state", token)
    approved = body.get("approved_tools", [])
    check("① p：/api/state approved_tools 含 {key, scope:persist}",
          st == 200 and any(a.get("key") == key4 and a.get("scope") == "persist" for a in approved),
          f"approved_tools 尾={approved[-3:]}")
    check("① 收尾：f4 落盘", (ROOT / f4).is_file())


# ================================================================ 场景② 敏感护栏 deny

def sc2_sensitive_deny(col: Collector, token: str) -> None:
    print("== 场景② 敏感护栏：read_file .env 直接 deny（不弹审批）")

    def script(messages):
        if _n_tool_msgs(messages) == 0:
            return _tool_call("call_sc2_0", "read_file", {"path": ".env"})
        return _assistant("E2E-SC2-DONE 敏感护栏已拦下")

    SCRIPT["fn"] = script
    st, before = http_req("/api/state", token)
    denied_before = before.get("denied_calls", 0) if st == 200 else None
    m0 = col.mark()
    col.send_text("读一下 .env", "e2e-sc2")
    check("② 回合正常结案", col.wait_for(ev_message_with("E2E-SC2-DONE"), 60, since=m0) is not None)
    evs = col.slice(m0)
    check("② 全程无 approval.request（硬护栏不经审批）",
          count_events(evs, "approval.request") == 0)
    start = next((e["payload"] for e in evs
                  if e.get("type") == "tool_call.start"
                  and e.get("payload", {}).get("name") == "read_file"), None)
    check("② tool_call.start permission=deny", start is not None and start.get("permission") == "deny",
          f"start={start}")
    got = col.wait_scan(scan_tool_end("denied"), 5, since=m0)
    check("② tool_call.end status=denied", got is not None)
    st, after = http_req("/api/state", token)
    check("② denied_calls +1（/api/state）",
          st == 200 and denied_before is not None and after.get("denied_calls") == denied_before + 1,
          f"{denied_before} → {after.get('denied_calls')}")


# ================================================================ 场景③ 压缩事件四 kind（serve 全链路级）

def _seed_history_auto_clearing() -> list:
    """造一段「近预算 + 旧大工具结果」的 history：should_clear + maybe_compact 在 run_once 入口双触发。"""
    big = "数据" * 4000                       # 8000 字符/条 ≫ _CLEAR_MIN_CHARS(800)
    h = agent._fresh_history()
    h.append({"role": "user", "content": "最初任务：整理 e2e 语料（逐字留存用）"})
    for r in range(4):
        h.append({"role": "assistant", "content": f"第 {r} 轮读取",
                  "tool_calls": [{"id": f"seed-tc-{r}a", "type": "function",
                                  "function": {"name": "read_file", "arguments": "{}"}}]})
        h.append({"role": "tool", "tool_call_id": f"seed-tc-{r}a", "content": f"结果{r}a " + big})
        h.append({"role": "tool", "tool_call_id": f"seed-tc-{r}b", "content": f"结果{r}b " + big})
    return h


def _check_compaction_shape(ev, kinds_fixture: dict, expect_cleared: bool) -> bool:
    """对照 fixtures/compaction_kinds.json 的契约形状：kind/before{msgs,chars}/after{msgs,chars}/cleared/depth。"""
    p = ev.get("payload", {})
    keys_ok = set(p.keys()) == {"kind", "before", "after", "cleared", "depth"}
    ba_ok = (isinstance(p.get("before"), dict) and isinstance(p.get("after"), dict)
             and all(isinstance(p[b].get(k), int) for b in ("before", "after") for k in ("msgs", "chars")))
    cleared_ok = (isinstance(p.get("cleared"), int) and p["cleared"] > 0) if expect_cleared \
        else p.get("cleared") is None
    kind_ok = p.get("kind") in {f["payload"]["kind"] for f in kinds_fixture.get("frames", [])}
    depth_ok = isinstance(p.get("depth"), int)
    return keys_ok and ba_ok and cleared_ok and kind_ok and depth_ok


def sc3_compaction(col: Collector, token: str) -> None:
    print("== 场景③ 压缩事件四 kind（serve 全链路：假 history + 假溢出 400 驱动真实压缩路径）")
    kinds_fixture = json.loads((FIXTURES / "compaction_kinds.json").read_text(encoding="utf-8"))
    sess = session_obj()
    ctx = sess.ctx
    window_file = Path(calibrate._WINDOW_FILE)
    window_backup = window_file.read_bytes() if window_file.exists() else None
    try:
        # ---- ③A auto_compact + tool_result_clearing：run_once 入口 75% 预算双触发
        def script_a(messages):
            if _is_summarize_req(messages):
                return _assistant("压缩摘要：用户目标与已完成事项要点。")
            return _assistant("E2E-SC3A-DONE 入口压缩已触发")

        SCRIPT["fn"] = script_a
        with ui_bus.STATE_LOCK:
            saved_window = ctx.get("_context_window")
            ctx["_context_window"] = 16384      # WINDOW_MIN：trigger_budget=12288，80k 字符史必触发
            # 清掉前序场景残留的 usage 锚点——锚点若非 None 会优先于内部估算、压不触发
            for k in ("_last_usage", "_vision_last_tokens", "_notes_last_tokens"):
                ctx.pop(k, None)
        seed_history(_seed_history_auto_clearing())
        m0 = col.mark()
        col.send_text("继续", "e2e-sc3a")
        ev_clear = col.wait_for(ev_compaction("tool_result_clearing"), 60, since=m0)
        check("③A tool_result_clearing 事件下行", ev_clear is not None)
        ev_auto = col.wait_for(ev_compaction("auto_compact"), 60, since=m0)
        check("③A auto_compact 事件下行", ev_auto is not None)
        check("③A 回合结案", col.wait_for(ev_message_with("E2E-SC3A-DONE"), 60, since=m0) is not None)
        if ev_clear:
            check("③A clearing 载荷契约形状（cleared=int>0）",
                  _check_compaction_shape(ev_clear, kinds_fixture, expect_cleared=True),
                  json.dumps(ev_clear.get("payload", {}), ensure_ascii=False)[:200])
        if ev_auto:
            check("③A auto 载荷契约形状（cleared=null）",
                  _check_compaction_shape(ev_auto, kinds_fixture, expect_cleared=False),
                  json.dumps(ev_auto.get("payload", {}), ensure_ascii=False)[:200])
        with ui_bus.STATE_LOCK:
            if saved_window is None:
                ctx.pop("_context_window", None)
            else:
                ctx["_context_window"] = saved_window
        wait_runner_idle()               # ③A runner 收尾后再发 ③B（防 busy 拒发）
        reset_history()

        # ---- ③B force_compact + emergency_truncate：假 provider 400 驱动 _send 应急缩史两步
        state = {"raised": False}

        def script_b(messages):
            if _is_summarize_req(messages):
                return _assistant("长摘要。" * 7000)      # ~21000 字符：压完仍超 target → 保证②硬截断也触发
            if not state["raised"]:
                state["raised"] = True
                raise KimiError("provider 400: token limit: 32768 (requested: 60000)")
            return _assistant("E2E-SC3B-DONE 超限自救成功")

        SCRIPT["fn"] = script_b
        with ui_bus.STATE_LOCK:
            for k in ("_last_usage", "_vision_last_tokens", "_notes_last_tokens"):
                ctx.pop(k, None)
        h = agent._fresh_history()
        for i in range(7):
            h.append({"role": "user", "content": f"第{i}问 " + "问" * 1800})
            h.append({"role": "assistant", "content": f"第{i}答 " + "答" * 1800})
        seed_history(h)                              # ~28k 字符 ≪ 默认预算：入口压缩不触发
        m1 = col.mark()
        col.send_text("发一条会超限的请求", "e2e-sc3b")
        ev_force = col.wait_for(ev_compaction("force_compact"), 60, since=m1)
        check("③B force_compact 事件下行", ev_force is not None)
        ev_emerg = col.wait_for(ev_compaction("emergency_truncate"), 60, since=m1)
        check("③B emergency_truncate 事件下行", ev_emerg is not None)
        check("③B 超限后重试结案", col.wait_for(ev_message_with("E2E-SC3B-DONE"), 60, since=m1) is not None)
        if ev_force:
            check("③B force 载荷契约形状（cleared=null）",
                  _check_compaction_shape(ev_force, kinds_fixture, expect_cleared=False),
                  json.dumps(ev_force.get("payload", {}), ensure_ascii=False)[:200])
        if ev_emerg:
            check("③B emergency 载荷契约形状（cleared=null）",
                  _check_compaction_shape(ev_emerg, kinds_fixture, expect_cleared=False),
                  json.dumps(ev_emerg.get("payload", {}), ensure_ascii=False)[:200])
        kinds = {e["payload"]["kind"] for e in col.slice(m0) if e.get("type") == "compaction.event"}
        check("③ 四 kind 全覆盖", kinds == {"auto_compact", "force_compact",
                                        "emergency_truncate", "tool_result_clearing"}, str(sorted(kinds)))
        reset_history()
    finally:
        # calibrate.learn_window 会落 .state/context_window.json——还原，别污染工作区
        try:
            if window_backup is None:
                if window_file.exists():
                    window_file.unlink()
            else:
                window_file.write_bytes(window_backup)
        except OSError:
            pass
        with ui_bus.STATE_LOCK:
            ctx.pop("_context_window", None)


# ================================================================ 场景④ look→zoom→pick→差分（runner 注入模拟级）

def _solid_png(w: int, h: int, rgb=(236, 232, 220)) -> bytes:
    row = bytes((*rgb, 255)) * w
    return imaging.encode_png(w, h, row * h)


_AX_BASE = ("APP: FakeApp\nWIN: FakeWin\n"
            "AXButton | 确定 | pos=10,10 | size=60x20\n"
            "AXStaticText | 标题 | pos=100,50 | size=80x20\n")
_AX_CHANGED = _AX_BASE + "AXButton | 新按钮 | pos=20,80 | size=50x20\n"


def sc4_look_zoom_pick(col: Collector, token: str) -> None:
    print("== 场景④ look→zoom→pick→差分（runner 注入模拟级：屏幕/OCR/点击全注入，协议链全真）")
    sess = session_obj()
    ctx = sess.ctx
    png = _solid_png(400, 300)
    ocr_ok_line = "OK|" + base64.b64encode("mock".encode()).decode()
    ax_calls = {"n": 0}

    def screencapture_runner(argv):                 # (argv)->(rc,out,err)；截图字节写 argv 末位临时文件
        # Windows 的 argv 是 ["powershell", "-NoProfile", "-Command", script]，tmp 路径在 script 的 Save('...') 里
        if argv and argv[0] == "powershell":
            m = re.search(r"Save\('([^']+)'\)", argv[-1])
            tmp = m.group(1) if m else argv[-1]
        else:
            tmp = argv[-1]                      # macOS 的 argv 是 ["screencapture", ..., tmp]
        try:
            with open(tmp, "wb") as f:
                f.write(png)
        except OSError:
            return (1, "", "写临时文件失败")
        return (0, "", "")

    def ax_runner(script):                          # (script)->归一 dump；pick 点后（第 4 次）新增一个元素 → effective
        ax_calls["n"] += 1
        return _AX_CHANGED if ax_calls["n"] >= 4 else _AX_BASE

    def ocr_runner(argv):                           # (argv)->(rc,out,err)；无词框（只用 AX 框源）
        return (0, ocr_ok_line + "\n", "")

    injected = {
        "_screencapture_runner": screencapture_runner,
        "_screen_size_runner": lambda argv: (0, "200,150", ""),    # 400/200 → 根视口 scale=2
        "_ax_runner": ax_runner,
        "_ocr_runner": ocr_runner,
        "_clickxy_runner": lambda argv: (0, "CLICKED|", ""),
    }

    def script(messages):
        n = _n_tool_msgs(messages)
        if n == 0:
            return _tool_call("call_sc4_0", "look", {})
        if n == 1:
            return _tool_call("call_sc4_1", "zoom", {"viewport_id": "v1", "mark_no": 1})
        if n == 2:
            return _tool_call("call_sc4_2", "pick", {"viewport_id": "v2", "mark_no": 1})
        return _assistant("E2E-SC4-DONE 视口链路完成")

    SCRIPT["fn"] = script
    with ui_bus.STATE_LOCK:
        ctx.update(injected)
    try:
        m0 = col.mark()
        col.send_text("看一下屏幕然后点确定", "e2e-sc4")
        # look/zoom/pick 三次 ask，按 tool 名区分、全程 since=m0（防游标竞态）
        for step in ("look", "zoom", "pick"):
            ev = col.wait_for(lambda e, s=step: e.get("type") == "approval.request"
                              and e.get("payload", {}).get("tool") == s, 30, since=m0)
            if not check(f"④ {step}：approval.request 弹出", ev is not None):
                return
            col.approve(ev["payload"]["request_id"], "y")
        check("④ 回合结案", col.wait_for(ev_message_with("E2E-SC4-DONE"), 60, since=m0) is not None)

        evs = col.slice(m0)
        vp_ids = [e["payload"].get("viewport_id") for e in evs if e.get("type") == "viewport.update"]
        check("④ viewport.update 事件下行（look→v1、zoom→v2）", "v1" in vp_ids and "v2" in vp_ids,
              f"收到 viewport.update：{vp_ids}")
        st, cur = http_req("/api/viewport/current", token)
        marks = cur.get("marks", {})
        check("④ /api/viewport/current 当前=v2 且带 marks",
              st == 200 and cur.get("viewport_id") == "v2" and isinstance(marks, dict) and len(marks) >= 1,
              f"viewport_id={cur.get('viewport_id')} marks={list(marks)[:4]}")
        check("④ marks 编号为字符串键（JSON 序列化）且 chain 沿 v1→v2",
              all(isinstance(k, str) for k in marks)
              and isinstance(cur.get("chain"), list) and cur["chain"][-1] == "v2" and "v1" in cur["chain"],
              f"chain={cur.get('chain')}")
        st, diff = http_req("/api/pick/diff", token)
        check("④ /api/pick/diff 三态之一且本次 effective（AX 差分有新增）",
              st == 200 and diff.get("status") in ("effective", "suspected_noop", "unknown")
              and diff.get("status") == "effective",
              f"status={diff.get('status')} ratio={diff.get('ratio')}")
        check("④ pick 差分带 target.no=1 与点前帧 ref",
              diff.get("target", {}).get("no") == 1 and bool(diff.get("pair", {}).get("before_ref")),
              f"target={diff.get('target')} pair={diff.get('pair')}")
        check("④ pick tool_call.end ok",
              col.wait_scan(scan_tool_end("ok", "v2"), 5, since=m0) is not None)
    finally:
        with ui_bus.STATE_LOCK:                      # 还原：注入 runner 只在本场景存活
            for k in injected:
                ctx.pop(k, None)


# ================================================================ 场景⑤ 断线重连：未决审批不丢

def sc5_reconnect(col: Collector, token: str) -> None:
    print("== 场景⑤ 断线重连：审批弹出后杀 WS（不答）→ 重连 snapshot 带回未决审批 → 回答结案")
    f5 = f"e2e-{RUN}-f5.txt"

    def script(messages):
        if _n_tool_msgs(messages) == 0:
            return _tool_call("call_sc5_0", "write_file",
                              {"path": f5, "content": "e2e 场景⑤ 断线重连后批准落盘\n"})
        return _assistant("E2E-SC5-DONE 重连批准已结案")

    SCRIPT["fn"] = script
    col1 = Collector.connect(token)                  # 本场景专用连接（要杀的就是它；主连接保持存活）
    try:
        col1.wait_for(lambda e: e.get("type") == "session.snapshot", 15)
        m0 = col1.mark()
        col1.send_text("写一个需要批准的文件", "e2e-sc5")
        ev = col1.wait_for(ev_approval(f5), 30, since=m0)
        if not check("⑤ approval.request 弹出", ev is not None):
            return
        rid = ev["payload"]["request_id"]
        col1.kill()                                  # 断线：不答审批、不发 close 帧
        check("⑤ 旧连接已死（审批悬而未决）", col1.dead)
        time.sleep(0.5)
    finally:
        col1.kill()

    col2 = Collector.connect(token)
    try:
        snap = col2.wait_for(lambda e: e.get("type") == "session.snapshot", 15)
        pend = (snap or {}).get("payload", {}).get("pending_approvals", [])
        got = next((p for p in pend if p.get("request_id") == rid), None)
        if not check("⑤ 重连 session.snapshot 的 pending_approvals 带回该审批", got is not None,
                     f"pending={[p.get('request_id') for p in pend]}"):
            return
        check("⑤ 带回的审批字段完整（tool/approval_key/resolved_path）",
              got.get("tool") == "write_file" and got.get("approval_key") == f"write_file:{f5}"
              and isinstance(got.get("resolved_path"), str) and got["resolved_path"].endswith(f5))
        col2.approve(rid, "y")
        check("⑤ 回答后 approval.resolved 广播",
              col2.wait_for(lambda e: e.get("type") == "approval.resolved"
                            and e.get("payload", {}).get("request_id") == rid
                            and e.get("payload", {}).get("decision") == "y", 30) is not None)
        check("⑤ 正常结案（tool end ok + 文件落盘 + 最终回复）",
              col2.wait_for(ev_message_with("E2E-SC5-DONE"), 60) is not None and (ROOT / f5).is_file())
    finally:
        col2.close()


# ================================================================ 场景⑥ 待发图增删与多客户端同步

def sc6_vision_pending(col: Collector, token: str) -> None:
    print("== 场景⑥ 待发图增删：A 侧 REST remove → B 侧 state.patch 同步")
    sess = session_obj()
    ctx = sess.ctx
    with ui_bus.STATE_LOCK:                          # 隔离前序场景（look 链产过待发图）
        ctx["_vision_pending"] = []
    ref = vision.put_image(sess.sid, _solid_png(64, 48, (80, 120, 160)),
                           kind="screenshot", target="e2e 场景⑥ 注入待发图")

    col_a = Collector.connect(token)
    col_b = Collector.connect(token)
    try:
        for c in (col_a, col_b):                     # 各自先吃掉首发 snapshot
            c.wait_for(lambda e: e.get("type") == "session.snapshot", 15)
        with ui_bus.STATE_LOCK:                      # 注入一张待发图（等价 read_image/look 产出路径）
            ctx["_vision_pending"].append(ref)
        ui_bus.mark_dirty(ctx, "vision_pending")
        ui_bus.flush(ctx)
        mb = col_b.mark()

        def has_ref(e):
            return e.get("type") == "state.patch" \
                and any(v.get("ref") == ref for v in e.get("payload", {}).get("vision_pending", []))

        check("⑥ 注入后 A/B 均收到 state.patch 且 vision_pending 带新图",
              col_a.wait_for(has_ref, 15) is not None and col_b.wait_for(has_ref, 15) is not None)
        st, body = http_req("/api/state", token)
        check("⑥ /api/state vision_pending 带 {ref,target}",
              st == 200 and any(v.get("ref") == ref and v.get("target") == "e2e 场景⑥ 注入待发图"
                                for v in body.get("vision_pending", [])),
              f"vision_pending={body.get('vision_pending')}")

        st, body = http_req("/api/vision/pending/remove", token, method="POST", body={"ref": ref})
        check("⑥ A 侧 POST /api/vision/pending/remove → removed=true",
              st == 200 and body.get("removed") is True, f"HTTP {st} {body}")

        def no_ref(e):
            if e.get("type") != "state.patch":
                return False
            vp = e.get("payload", {}).get("vision_pending")
            return isinstance(vp, list) and not any(v.get("ref") == ref for v in vp)

        check("⑥ B 侧收到 state.patch 且 vision_pending 已同步移除",
              col_b.wait_for(no_ref, 15, since=mb) is not None)
    finally:
        col_a.close()
        col_b.close()
        with ui_bus.STATE_LOCK:
            if ref in (ctx.get("_vision_pending") or []):
                ctx["_vision_pending"].remove(ref)


# ================================================================ 场景⑦ jobs 面板

def sc7_jobs(col: Collector, token: str) -> None:
    print("== 场景⑦ jobs 面板：run_in_background → job.update + 状态翻转 + tail + /log")
    # sleep 不是 Windows 命令；始终复用当前解释器，避免 macOS/Linux 上不存在 py -3。
    cmd = f'"{sys.executable}" -c "import time; time.sleep(1); print(\'e2e-job-{RUN}\')"'
    # 注意：jobs 没有监工线程——终态翻转由 check_background/status() 触发（真实模型同款路径），
    # 故剧本第二轮先等任务跑完再 check_background，驱动 running→done 翻转。
    jid_box = {"jid": None}

    def script(messages):
        n = _n_tool_msgs(messages)
        if n == 0:
            return _tool_call("call_sc7_0", "run_in_background", {"command": cmd})
        if n == 1:
            last_tool = next(m for m in reversed(messages) if m.get("role") == "tool")
            m = re.search(r"job-\d{8}-\d{6}-\d+-\d+", str(last_tool.get("content", "")))
            jid_box["jid"] = m.group(0) if m else None
            time.sleep(1.5)                      # 等 sleep 1 跑完
            return _tool_call("call_sc7_1", "check_background", {"job_id": jid_box["jid"] or "job-0"})
        return _assistant("E2E-SC7-DONE 后台任务已结案")

    SCRIPT["fn"] = script
    m0 = col.mark()
    col.send_text("后台跑个短任务", "e2e-sc7")
    ev = col.wait_for(ev_approval("e2e-job"), 30, since=m0)
    if not check("⑦ run_in_background approval.request 弹出", ev is not None):
        return
    col.approve(ev["payload"]["request_id"], "y")
    check("⑦ 回合结案", col.wait_for(ev_message_with("E2E-SC7-DONE"), 60, since=m0) is not None)

    def find_job(events, status=None):
        for e in events:
            if e.get("type") != "job.update":
                continue
            for j in e.get("payload", {}).get("jobs", []):
                if "e2e-job" in str(j.get("command", "")) and (status is None or j.get("status") == status):
                    return j
        return None

    j_running = col.wait_scan(lambda evs: find_job(evs, "running"), 15, since=m0)
    check("⑦ job.update 事件且任务 running", j_running is not None,
          f"job={(j_running or {}).get('id')}")
    jid = (j_running or {}).get("id")
    deadline = time.time() + 30
    j_done = None
    while time.time() < deadline and not j_done:
        st, body = http_req("/api/jobs", token)
        for j in body.get("jobs", []):
            if j.get("id") == jid and j.get("status") == "done":
                j_done = j
                break
        if not j_done:
            time.sleep(0.5)
    check("⑦ /api/jobs 状态翻转 running→done（returncode=0）",
          j_done is not None and j_done.get("returncode") == 0,
          f"status={(j_done or {}).get('status')}")
    check("⑦ /api/jobs 带 tail 且含任务输出",
          j_done is not None and f"e2e-job-{RUN}" in str(j_done.get("tail", "")),
          f"tail={(j_done or {}).get('tail', '')[-80:]}")
    check("⑦ 终态 job.update 事件下行（done）",
          col.wait_scan(lambda evs: find_job(evs, "done"), 10, since=m0) is not None)
    if jid:
        st, body = http_req(f"/api/jobs/{jid}/log", token)
        log = body.get("log", "")
        job8 = body.get("job", {})
        check("⑦ /api/jobs/{id}/log 返回日志且 job 八键齐全",
              st == 200 and f"e2e-job-{RUN}" in log
              and set(job8.keys()) == {"id", "command", "pid", "log_path", "status",
                                       "started_at", "returncode", "ended_at"},
              f"HTTP {st} keys={sorted(job8.keys())} log尾={log[-60:]}")


# ================================================================ 场景⑧ 命令回执（⌘K harness 命令组）

def sc8_commands(col: Collector, token: str) -> None:
    print("== 场景⑧ 命令回执：todos/memory/skills/notes/effects/undo/clear/help 逐条有下文")
    receipts = ("message.append", "state.patch", "session.snapshot", "system.alert")
    for name in ("todos", "memory", "skills", "notes", "effects", "undo", "clear", "help"):
        m0 = col.mark()
        try:
            col.command(name)
        except (ConnectionError, OSError) as e:
            check(f"⑧ command {name} → 有回执", False, f"上行失败：{e}")
            continue
        ev = col.wait_for(lambda e: e.get("type") in receipts, 20, since=m0)
        extra = ""
        if name == "clear" and ev is not None:
            # clear 还应重发 session.snapshot（消息流重置）——顺手钉契约
            got_snap = col.wait_for(lambda e: e.get("type") == "session.snapshot", 10, since=m0)
            extra = "；snapshot 重发" + ("✓" if got_snap else "✗")
            check("⑧ command clear → 重发 session.snapshot", got_snap is not None)
        check(f"⑧ command {name} → 有回执", ev is not None,
              f"首条回执={ev.get('type') if ev else '无'}{extra}")


# ================================================================ 主流程

def main() -> int:
    print(f"== run_e2e：线程内起 serve（:{PORT}，--no-browser --no-mcp，剧本假模型），run={RUN}")
    ap_file = Path(approvals.APPROVALS_FILE)
    ap_backup = ap_file.read_bytes() if ap_file.exists() else None   # 场景① p 会写持久白名单——跑完还原
    serve_t = threading.Thread(
        target=ui_server.serve_main,
        args=(["--port", str(PORT), "--no-browser", "--no-mcp"],),
        kwargs={"model_fn": dispatch_model_fn}, daemon=True, name="e2e-serve")
    serve_t.start()

    token = None
    for _ in range(150):
        time.sleep(0.1)
        tf = ROOT / ".state" / "ui_token"
        if ui_server.active_server().get("httpd") and tf.exists():
            token = tf.read_text(encoding="utf-8").strip()
            break
    if not check("起服 + token 落盘", token, f"port={PORT}"):
        return _finale(ap_file, ap_backup)

    col = None
    try:
        col = Collector.connect(token)
        snap = col.wait_for(lambda e: e.get("type") == "session.snapshot", 15)
        if not check("WS 握手 + session.snapshot 首发", snap is not None):
            return _finale(ap_file, ap_backup, col)

        scenarios = [
            ("① 发送-工具-审批全链", sc1_approval_chain),
            ("② 敏感护栏 deny", sc2_sensitive_deny),
            ("③ 压缩事件四 kind", sc3_compaction),
            ("④ look→zoom→pick→差分", sc4_look_zoom_pick),
            ("⑤ 断线重连", sc5_reconnect),
            ("⑥ 待发图增删与多客户端同步", sc6_vision_pending),
            ("⑦ jobs 面板", sc7_jobs),
            ("⑧ 命令回执", sc8_commands),
        ]
        for title, fn in scenarios:
            SCRIPT["fn"] = None
            wait_runner_idle()          # 上一场 runner 的 finally 可能还在跑——send 前先等它收尾
            reset_history()
            try:
                fn(col, token)
            except Exception as e:                  # 单场景崩溃不拖垮其余场景
                check(f"{title}：场景执行异常", False, f"{type(e).__name__}: {e}")
    finally:
        SCRIPT["fn"] = None
        return _finale(ap_file, ap_backup, col)


def _finale(ap_file: Path, ap_backup: bytes | None, col: Collector | None = None) -> int:
    print("== 收尾")
    if col is not None:
        try:
            col.close()
        except Exception:
            pass
    ui_server.stop_active()
    time.sleep(1.5)
    try:                                            # 还原持久白名单与落盘文件（多跑稳定）
        if ap_backup is None:
            if ap_file.exists():
                ap_file.unlink()
        else:
            ap_file.write_bytes(ap_backup)
    except OSError:
        pass
    for p in ROOT.glob(f"e2e-{RUN}-*.txt"):
        try:
            p.unlink()
        except OSError:
            pass
    n_fail = sum(1 for _, ok, _ in RESULTS if not ok)
    print(f"\n===== E2E 汇总：{len(RESULTS) - n_fail} PASS / {n_fail} FAIL =====")
    if n_fail:
        for name, ok, detail in RESULTS:
            if not ok:
                print(f"  FAIL  {name}  —— {detail}")
    return 1 if n_fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
