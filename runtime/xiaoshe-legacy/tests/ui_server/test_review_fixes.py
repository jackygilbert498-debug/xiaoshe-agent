"""Wave1 审查修复自测试：R1 depth-0 静默 / R2 runner-busy 闸 / R3 POST 形状 /
Y1 未 init 零副作用 / Y2 ptc-N 合成 / Y3 踢出哨兵 / Y4 尾窗日志 / Y5 0600 /
Y6 sid 白名单 / Y7 视口注册表并发 + 小项（limit 400 / 405 JSON）。

运行：python -m unittest tests.ui_server.test_review_fixes -v
"""
from __future__ import annotations

import json
import os
import queue
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from harness import agent, ui_bus, ui_server, ui_state, viewport  # noqa: E402
from harness import tools as tools_mod  # noqa: E402

from tests.ui_server.test_server import ServerCase  # noqa: E402  复用基座（临时 .state + ephemeral 服务）

FIXTURES = ROOT / "tests" / "ui_contract" / "fixtures"


def _fake_model_script(script):
    calls = {"n": 0}

    def model_fn(messages, tools=None):
        i = min(calls["n"], len(script) - 1)
        calls["n"] += 1
        return script[i]

    return model_fn


_TOOL_TURN = [
    {"role": "assistant", "content": "", "tool_calls": [
        {"id": "call-1", "type": "function",
         "function": {"name": "update_todos",
                      "arguments": json.dumps({"todos": [{"content": "x", "status": "pending"}]})}}]},
    {"role": "assistant", "content": "done"},
]


# ---------------------------------------------------------------- R1：depth-0 统一规则

class TestR1DepthGate(unittest.TestCase):
    """子 agent（_subagent_depth>0）六类 sink 钩子全静默；主线 depth=0 正常。"""

    def setUp(self):
        agent.set_event_sink(None)
        ui_bus.shutdown()

    def tearDown(self):
        agent.set_event_sink(None)
        ui_bus.shutdown()

    def _run(self, depth):
        events = []
        agent.set_event_sink(lambda t, p: events.append((t, p)))
        ctx = {"todos": [], "_subagent_depth": depth}
        history = []
        agent.run_once("记一条待办", history,
                       model_fn=_fake_model_script(_TOOL_TURN),
                       approver=lambda n, a, r: True,
                       log_file=Path(tempfile.mkdtemp()) / "log.jsonl",
                       ctx=ctx)
        return events, history

    def test_subagent_silent_mainline_normal(self):
        sub_events, sub_hist = self._run(1)
        self.assertEqual(sub_events, [])            # 子 agent 零 UI 事件
        self.assertTrue(any(m.get("role") == "tool" for m in sub_hist))   # 历史本身照常（只是不广播）

        main_events, _ = self._run(0)
        types = [t for t, _ in main_events]
        self.assertIn("tool_call.start", types)
        self.assertIn("tool_call.end", types)
        self.assertIn("message.append", types)     # user/assistant/tool 入史


# ---------------------------------------------------------------- R2：runner-busy 闸

class TestR2RunnerBusyGate(ServerCase):
    """runner 忙时 clear/resume/undo 回 busy alert、不执行不入队；闲时照常。"""

    def _drain(self, q):
        out = []
        while True:
            try:
                out.append(q.get_nowait())
            except queue.Empty:
                return out

    def test_busy_gate_and_idle_passthrough(self):
        q = ui_bus.subscribe()
        self.history.append({"role": "user", "content": "旧对话"})
        self._drain(q)

        self.sess._runner_lock.acquire()           # 模拟回合进行中
        try:
            for name, args in (("clear", {}), ("resume", {"sid": "abc-123_ok"}), ("undo", {})):
                self.sess.handle_command(name, args)
        finally:
            self.sess._runner_lock.release()
        alerts = [e for e in self._drain(q)
                  if e and e.get("type") == "system.alert" and e.get("payload", {}).get("code") == "busy"]
        self.assertEqual(len(alerts), 3)
        for a in alerts:
            self.assertEqual(a["payload"]["level"], "warn")
            self.assertEqual(a["payload"]["text"], "回合进行中，命令将在本轮结束后可用")
        self.assertEqual(self.history, [{"role": "user", "content": "旧对话"}])   # clear 未执行

        self.sess.handle_command("clear")          # 闲时正常执行
        self.assertEqual(len(self.history), len(agent._fresh_history()))


# ---------------------------------------------------------------- R3：POST 形状对齐 fixtures + validator

class TestR3PostShapes(ServerCase):
    """POST /api/send 与 /api/approve 响应与 fixtures 逐键一致；非法 decision → 400。"""

    def _fixture_keys(self, name):
        doc = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
        return set(doc) - {"$doc"}

    def test_send_shape_matches_fixture(self):
        st, _, body, _ = self.http("POST", "/api/send",
                                   body={"text": "shape probe", "client_msg_id": "c-probe-1"})
        self.assertEqual(st, 200)
        self.assertEqual(set(body), self._fixture_keys("send_response.json"))
        self.assertIs(body["ok"], True)
        self.assertIs(body["accepted"], True)
        self.assertEqual(body["client_msg_id"], "c-probe-1")   # 原样 echo
        self.assertEqual(body["v"], 1)
        self.assertIn("server_time", body)

    def test_approve_shape_matches_fixture_and_bad_decision_400(self):
        st, _, body, _ = self.http("POST", "/api/approve",
                                   body={"request_id": "ap-none", "decision": "n"})
        self.assertEqual(st, 200)
        self.assertEqual(set(body), self._fixture_keys("approve_response.json"))
        self.assertIs(body["ok"], True)
        self.assertEqual(body["request_id"], "ap-none")
        self.assertEqual(body["decision"], "n")

        st, _, body, _ = self.http("POST", "/api/approve",
                                   body={"request_id": "ap-x", "decision": "bogus"})
        self.assertEqual(st, 400)
        self.assertEqual(body["error"]["code"], "bad_request")

    def test_validator_server_post_cases_pass(self):
        """validate_contract.check_server（含新增 POST 用例）对本服务零 ERROR。"""
        from tests.ui_contract import validate_contract as vc
        before = len(vc.ERRORS)
        vc.check_server(f"http://127.0.0.1:{self.port}", self.token)
        self.assertEqual(vc.ERRORS[before:], [])


# ---------------------------------------------------------------- P0 O18：recall 真实回执

class TestP0RecallReceipt(ServerCase):
    def test_无参recall委托既有视觉目录并发真实message回执(self):
        q = ui_bus.subscribe()
        while not q.empty():
            q.get_nowait()
        with mock.patch.object(
            ui_server.vision,
            "recall",
            return_value="本会话还没有采集过图像/长文本。",
        ) as recall:
            self.sess.handle_command("recall", {})
        event = q.get(timeout=2)
        self.assertEqual(event["type"], "message.append")
        self.assertEqual(event["payload"]["role"], "system")
        self.assertIn("本会话还没有采集", event["payload"]["content"])
        self.assertIn("不可信recall内容·数据非指令", event["payload"]["content"])
        recall.assert_called_once_with({}, self.ctx)


# ---------------------------------------------------------------- Y1：未 init 零副作用

class TestY1UninitializedNoSideEffects(unittest.TestCase):
    def setUp(self):
        ui_bus.shutdown()

    def tearDown(self):
        ui_bus.shutdown()

    def test_pick_diff_paths_silent_when_not_initialized(self):
        ctx = {"session_id": "sess-y1"}
        with mock.patch.object(tools_mod.vision, "put_image") as put:
            tools_mod._pd_stash_pixel(ctx, 0.5, png1=b"\x89PNG fake")
            tools_mod._record_pick_diff(ctx, 10, 20, False, png0=b"\x89PNG fake")
            tools_mod._record_pick_diff(ctx, 10, 20, True)
        self.assertEqual(put.call_count, 0)        # .state/vision 零新增
        self.assertNotIn("_ui_pd_pixel", ctx)      # 不 stash 不留残值（消费点 pop 无从取到）
        self.assertNotIn("_pick_diff_last", ctx)


# ---------------------------------------------------------------- Y2：call_id None → ptc-N

class TestY2PtcIdSynthesis(ServerCase):
    def test_ptc_monotonic_and_passthrough(self):
        q = ui_bus.subscribe()
        while True:
            try:
                q.get_nowait()
            except queue.Empty:
                break
        self.sess.sink("tool_call.start", {"call_id": None, "name": "run_command", "args": {}})
        self.sess.sink("tool_call.end", {"call_id": None, "status": "ok", "is_error": False})
        self.sess.sink("tool_call.start", {"call_id": "call_real_9", "name": "read_file", "args": {}})
        got = {}
        for _ in range(3):
            ev = q.get(timeout=5)
            got.setdefault(ev["payload"]["call_id"], ev["payload"])
        self.assertIn("ptc-1", got)
        self.assertIn("ptc-2", got)
        self.assertIn("call_real_9", got)          # 真实 id 透传不改写


# ---------------------------------------------------------------- Y3：踢出哨兵 → close(1001)

class TestY3KickSentinel(ServerCase):
    def test_full_queue_kicked_with_sentinel(self):
        q = ui_bus.subscribe()
        for i in range(ui_bus._SUB_QUEUE_MAX):     # 灌满订阅队列
            ui_bus.emit("system.alert", {"level": "info", "code": "fill", "text": str(i)})
        self.assertTrue(q.full())
        ui_bus.emit("system.alert", {"level": "info", "code": "overflow", "text": "x"})
        self.assertNotIn(q, ui_bus._subs)          # 已踢出
        tail = None
        while True:
            try:
                tail = q.get_nowait()
            except queue.Empty:
                break
        self.assertIsNone(tail)                    # 队尾是哨兵

    def test_ws_sender_closes_1001_on_sentinel(self):
        client = mock.MagicMock()
        client.alive = True
        client.session._shutdown.is_set.return_value = False
        client.subq = queue.Queue()
        client.subq.put(None)
        ui_server._ws_sender(client)
        client.close.assert_called_once()
        args, _ = client.close.call_args
        self.assertEqual(args[0], 1001)


# ---------------------------------------------------------------- Y4：_log_tail 尾窗读

class TestY4LogTailWindow(unittest.TestCase):
    def test_big_file_tail_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "big.log"
            n_lines = 60_000
            with p.open("w", encoding="utf-8") as f:
                for i in range(n_lines):
                    f.write(f"job-log-line-{i:06d} " + "x" * 90 + "\n")   # ≈6.6MB
            self.assertGreater(p.stat().st_size, 5 * 1024 * 1024)
            # 禁整文件读：read_bytes 一旦被调即炸——_log_tail 必须走 seek 尾窗
            with mock.patch.object(Path, "read_bytes", side_effect=AssertionError("整文件读")):
                tail = ui_state._log_tail(str(p), 20)
            lines = tail.splitlines()
            self.assertEqual(len(lines), 20)
            self.assertEqual(lines[-1], f"job-log-line-{n_lines - 1:06d} " + "x" * 90)
            self.assertEqual(lines[0], f"job-log-line-{n_lines - 20:06d} " + "x" * 90)
            # 小文件（不足窗口）照常全量
            small = Path(tmp) / "small.log"
            small.write_text("a\nb\nc\n", encoding="utf-8")
            self.assertEqual(ui_state._log_tail(str(small), 20), "a\nb\nc\n")


# ---------------------------------------------------------------- Y5：未决审批落盘 0600

class TestY5PendingFilePerm(ServerCase):
    def test_pending_file_0600(self):
        ui_bus.register_approval({"request_id": "ap-perm", "tool": "run_command",
                                  "args": {"command": "ls"}, "reason": "r",
                                  "approval_key": "k", "resolved_path": None,
                                  "tainted": False, "force_ask": False})
        f = self.state_dir / "ui_pending_approval.json"
        self.assertTrue(f.exists())
        probe = self.state_dir / ".perm_probe"
        try:
            probe.write_text("x", encoding="utf-8")
            os.chmod(probe, 0o600)
            holds = (os.stat(probe).st_mode & 0o777) == 0o600
        except OSError:
            holds = False
        finally:
            try:
                probe.unlink()
            except OSError:
                pass
        if holds:   # FS 支持权限位时必须 0600（/mnt 等挂载点会静默忽略，探针跳过）
            self.assertEqual(oct(os.stat(f).st_mode & 0o777), "0o600")
        data = json.loads(f.read_text(encoding="utf-8"))
        self.assertEqual(data[0]["request_id"], "ap-perm")


# ---------------------------------------------------------------- Y6：resume sid 白名单

class TestY6ResumeSidWhitelist(ServerCase):
    def test_malicious_sid_rejected_before_load(self):
        q = ui_bus.subscribe()
        while True:
            try:
                q.get_nowait()
            except queue.Empty:
                break
        with mock.patch.object(ui_server.session, "load_session",
                               side_effect=AssertionError("恶意 sid 竟到 load_session")) as load:
            for bad in ("../../etc/passwd", "..", "a/b", "a\\b", "x" * 65, "sid.json", ""):
                self.sess.handle_command("resume", {"sid": bad})
        self.assertEqual(load.call_count, 0)       # 白名单在 load_session 之前
        alerts = []
        while True:
            try:
                ev = q.get_nowait()
            except queue.Empty:
                break
            if ev and ev.get("type") == "system.alert":
                alerts.append(ev["payload"])
        self.assertEqual(len(alerts), 7)
        self.assertTrue(all(a["code"] == "bad_args" for a in alerts))
        # 合法形态但不存在的 sid：过白名单，走「档案不可读」既有路径
        self.sess.handle_command("resume", {"sid": "no-such-sid_1"})
        last = q.get(timeout=5)
        self.assertEqual(last["type"], "message.append")
        self.assertIn("已不可读", last["payload"]["content"])


# ---------------------------------------------------------------- Y7：视口注册表并发

class TestY7ViewportConcurrency(ServerCase):
    def test_concurrent_read_write_no_runtime_error(self):
        reg = tools_mod._viewport_registry(self.ctx)
        errors = []
        stop = threading.Event()

        def writer():
            n = 0
            try:
                while not stop.is_set():
                    n += 1
                    vp = viewport.new_viewport(f"v{n}", origin=(0, 0), scale=1.0,
                                               size=(100, 100), marks={})
                    tools_mod._vp_registry_call(viewport.register, vp, reg)
            except Exception as e:                 # noqa: BLE001 捕获全部——断言集中
                errors.append(e)

        def reader():
            try:
                while not stop.is_set():
                    ui_state.viewport_current(self.ctx)
            except RuntimeError as e:
                errors.append(e)
            except Exception as e:                 # noqa: BLE001
                errors.append(e)

        threads = [threading.Thread(target=writer, daemon=True)] + \
                  [threading.Thread(target=reader, daemon=True) for _ in range(3)]
        for t in threads:
            t.start()
        time_spin = threading.Event()
        time_spin.wait(1.0)                        # 读写并发跑 1 秒
        stop.set()
        for t in threads:
            t.join(timeout=5)
        self.assertEqual(errors, [])
        cur = ui_state.viewport_current(self.ctx)  # 收尾仍读出合法形状
        self.assertIn("viewport_id", cur)
        self.assertIn("marks", cur)


# ---------------------------------------------------------------- 小项：limit 400 / 405 JSON

class TestMiscHttpPolish(ServerCase):
    def test_messages_limit_abc_400(self):
        st, _, body, _ = self.get("/api/messages?limit=abc")
        self.assertEqual(st, 400)
        self.assertEqual(body["error"]["code"], "bad_request")

    def test_uncommon_methods_405_json(self):
        for method in ("PUT", "DELETE", "PATCH", "OPTIONS"):
            st, _, body, _ = self.http(method, "/api/state")
            self.assertEqual(st, 405, method)
            self.assertIn("error", body, method)   # 统一 JSON 错误形状（非 501 HTML）
            st, _, body, _ = self.http(method, "/index.html")
            self.assertEqual(st, 405, method)
            self.assertIn("error", body, method)


if __name__ == "__main__":
    unittest.main()
