"""UI 批次 D：模型切换下拉 + 会话级自主模式（A 案）。

覆盖面：
- config.model_candidates：XS_MODELS 逗号列表解析 / 缺省单模型降级 / 去重保序、当前模型恒首位。
- kimi_client.chat(model=...)：会话级模型覆盖进 payload；缺省回 config.MODEL。
- 自主模式（ctx['_autonomy']，复用 agent._approved 会话通道，不发明第三套）：
  ask 自动放行（不问、不落白名单、不落盘）；deny 恒拦（permission.check 零改动）；
  force_ask / 污点 仍逐条问；切回即刻恢复逐条问；两个 ctx 会话隔离。
- REST：GET /api/models、POST /api/model（非法模型 400）、POST /api/autonomy（坏入参 400）、
  /api/state 带 autonomy/model 两键、开新会话重置回默认。
- UISession 默认 model_fn：按 ctx['_model'] 走（不落 .env，重启回默认）。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import types
import unittest
from urllib.parse import quote
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from harness import agent, approvals, config, kimi_client, model_client, permission, ui_bus, ui_server  # noqa: E402
from harness.model_client import ModelError  # noqa: E402
from harness.model_registry import ModelRegistry  # noqa: E402
from tests.ui_server.test_server import ServerCase  # noqa: E402


# ---------------------------------------------------------------- 模型清单（config）

class TestModelCandidates(unittest.TestCase):
    """XS_MODELS（环境变量/.env 逗号列表）+ 当前 KIMI_MODEL 恒在首位；缺省如实降级为单模型。"""

    def setUp(self):
        self._old = os.environ.get("XS_MODELS")

    def tearDown(self):
        if self._old is None:
            os.environ.pop("XS_MODELS", None)
        else:
            os.environ["XS_MODELS"] = self._old

    def test_default_single_model_degrade(self):
        os.environ["XS_MODELS"] = ""
        self.assertEqual(config.model_candidates(), [config.MODEL])

    def test_comma_list_parsed_deduped_current_first(self):
        os.environ["XS_MODELS"] = " k2-thinking , k2-instruct, k2-thinking "
        cands = config.model_candidates()
        self.assertEqual(cands[0], config.MODEL)                 # 当前模型恒首位
        self.assertEqual(cands[1:], ["k2-thinking", "k2-instruct"])  # 去重保序、空白剥离

    def test_current_model_in_list_not_duplicated(self):
        os.environ["XS_MODELS"] = f"{config.MODEL}, k2-thinking"
        cands = config.model_candidates()
        self.assertEqual(cands.count(config.MODEL), 1)
        self.assertEqual(cands, [config.MODEL, "k2-thinking"])


# ---------------------------------------------------------------- kimi_client 模型覆盖

class TestKimiClientModelParam(unittest.TestCase):
    """chat(model=...) 会话级覆盖：payload 用覆盖值；不传则回 config.MODEL（重启回默认）。"""

    def _capture(self, **kw):
        seen = {}

        def fake_post(payload, timeout, retry):
            seen["payload"] = payload
            return {"choices": [{"message": {"content": "ok"}}], "model": payload["model"]}
        with mock.patch.object(kimi_client, "_post", fake_post):
            kimi_client.chat([{"role": "user", "content": "hi"}], **kw)
        return seen["payload"]

    def test_model_override_in_payload(self):
        payload = self._capture(model="k2-thinking")
        self.assertEqual(payload["model"], "k2-thinking")

    def test_default_falls_back_to_config(self):
        payload = self._capture()
        self.assertEqual(payload["model"], config.MODEL)


# ---------------------------------------------------------------- 自主模式（agent._approved 通道）

class _Recorder:
    def __init__(self, verdict=False):
        self.calls = []
        self.verdict = verdict

    def __call__(self, name, args, reason):
        self.calls.append((name, args, reason))
        return self.verdict


class TestAutonomyApproved(unittest.TestCase):
    """自主模式复用 _approved 会话通道：ask 自动过、deny 照拦、force_ask/污点仍问、切回恢复、会话隔离。"""

    def _ctx(self, autonomy=True):
        return {"_autonomy": autonomy, "_persistent_approved": set(), "_denied_calls": 0}

    def test_ask_auto_approved_without_asking(self):
        ctx = self._ctx(True)
        rec = _Recorder(verdict=False)   # 即便底层 approver 会拒，自主模式也不该问到它
        ok = agent._approved("write_file", {"path": "a.txt", "content": "x"}, "要执行 write_file", rec, ctx)
        self.assertTrue(ok)
        self.assertEqual(rec.calls, [], "自主模式 ask 级不许弹审批")
        self.assertNotIn("_approved_tools", ctx, "自主放行不落会话白名单（切回要恢复逐条问）")

    def test_autonomy_off_restores_asking(self):
        ctx = self._ctx(True)
        agent._approved("write_file", {"path": "a.txt"}, "r", _Recorder(False), ctx)
        ctx["_autonomy"] = False          # 切回审批模式
        rec = _Recorder(verdict=False)
        ok = agent._approved("write_file", {"path": "a.txt"}, "r", rec, ctx)
        self.assertFalse(ok)
        self.assertEqual(len(rec.calls), 1, "切回后同一调用必须重新逐条问")

    def test_deny_never_bypassed(self):
        """deny 级（敏感文件硬护栏）自主模式下照拦：check 直接 deny，_approved 根本不被触及。"""
        ctx = self._ctx(True)
        d = permission.check("write_file", {"path": ".env", "content": "x"})
        self.assertEqual(d.action, "deny")
        rec = _Recorder(verdict=True)     # 设 True 探针：deny 路径若误入审批通道会露出
        content, is_error, executed = agent._run_tool(
            "write_file", {"path": ".env", "content": "x"}, ctx, rec, Path(tempfile.mkdtemp()) / "l.jsonl")
        self.assertFalse(executed)
        self.assertTrue(is_error)
        self.assertIn("拒绝", content)
        self.assertEqual(rec.calls, [], "deny 恒不可绕——自主模式也不许进审批通道")

    def test_force_ask_still_asks(self):
        ctx = self._ctx(True)
        rec = _Recorder(verdict=False)
        ok = agent._approved("run_command", {"command": "echo hi"}, "混淆管道", rec, ctx, force_ask=True)
        self.assertFalse(ok)
        self.assertEqual(len(rec.calls), 1, "force_ask（混淆/.state 触达）自主模式下仍必问")

    def test_tainted_still_asks(self):
        span = "不可信来源注入的够长文本片段-" + "x" * 40
        ctx = self._ctx(True)
        ctx["_tainted"] = {span}
        rec = _Recorder(verdict=False)
        ok = agent._approved("write_file", {"path": "a.txt", "content": span}, "r", rec, ctx)
        self.assertFalse(ok)
        self.assertEqual(len(rec.calls), 1, "污点参数自主模式下仍必问（防注入洗白）")

    def test_session_isolation(self):
        ctx_a, ctx_b = self._ctx(True), self._ctx(False)
        self.assertTrue(agent._approved("run_command", {"command": "ls"}, "r", _Recorder(False), ctx_a))
        rec = _Recorder(verdict=False)
        self.assertFalse(agent._approved("run_command", {"command": "ls"}, "r", rec, ctx_b))
        self.assertEqual(len(rec.calls), 1, "另一个会话（ctx）不受自主模式影响")

    def test_no_persistence_to_disk(self):
        """自主放行不落盘：approvals.add 不被调用、持久放行清单不增。"""
        ctx = self._ctx(True)
        with mock.patch.object(approvals, "add") as add_mock:
            self.assertTrue(agent._approved("run_command", {"command": "ls"}, "r", _Recorder(False), ctx))
        add_mock.assert_not_called()
        self.assertEqual(ctx["_persistent_approved"], set())


# ---------------------------------------------------------------- REST：模型切换 + 自主开关

class TestModelAutonomyApi(ServerCase):
    """GET /api/models · POST /api/model · POST /api/autonomy · /api/state 两键 · 新会话重置。"""

    def setUp(self):
        self._old = os.environ.get("XS_MODELS")
        self._old_kimi_key = os.environ.get("KIMI_API_KEY")
        self._old_deepseek_key = os.environ.get("DEEPSEEK_API_KEY")
        os.environ["XS_MODELS"] = ""
        os.environ["KIMI_API_KEY"] = "fixture-kimi-key"
        os.environ["DEEPSEEK_API_KEY"] = "fixture-deepseek-key"
        super().setUp()

    def tearDown(self):
        super().tearDown()
        if self._old is None:
            os.environ.pop("XS_MODELS", None)
        else:
            os.environ["XS_MODELS"] = self._old
        for name, previous in (("KIMI_API_KEY", self._old_kimi_key),
                               ("DEEPSEEK_API_KEY", self._old_deepseek_key)):
            if previous is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = previous

    # ---- /api/models ----

    def test_models_default_single_not_switchable(self):
        st, _, body, _ = self.get("/api/models")
        self.assertEqual(st, 200)
        self.assertEqual(body["models"], [config.MODEL])
        self.assertEqual(body["current"], config.MODEL)
        self.assertIs(body["switchable"], False)
        self.assertEqual({item["provider"] for item in body["items"]}, {"Kimi", "DeepSeek"})
        self.assertIn(body["current_id"], {item["id"] for item in body["items"]})
        self.assertIn(body["default_id"], {item["id"] for item in body["items"]})

    def test_models_with_candidates_switchable(self):
        os.environ["XS_MODELS"] = "k2-thinking,k2-instruct"
        st, _, body, _ = self.get("/api/models")
        self.assertEqual(st, 200)
        self.assertEqual(body["models"], [config.MODEL, "k2-thinking", "k2-instruct"])
        self.assertIs(body["switchable"], True)

    # ---- POST /api/model ----

    def test_model_switch_session_scoped(self):
        os.environ["XS_MODELS"] = "k2-thinking"
        st, _, body, _ = self.http("POST", "/api/model", body={"model": "k2-thinking"})
        self.assertEqual(st, 200)
        self.assertEqual({k: body[k] for k in ("ok", "model", "persisted")},
                         {"ok": True, "model": "k2-thinking", "persisted": False})
        self.assertEqual(self.ctx.get("_model"), "k2-thinking")
        st, _, body, _ = self.get("/api/models")
        self.assertEqual(body["current"], "k2-thinking")
        st, _, state, _ = self.get("/api/state")
        self.assertEqual(state["model"], "k2-thinking")

    def test_model_switch_rejects_unknown(self):
        os.environ["XS_MODELS"] = "k2-thinking"
        st, _, body, _ = self.http("POST", "/api/model", body={"model": "gpt-99"})
        self.assertEqual(st, 400)
        self.assertEqual(body["error"]["code"], "bad_request")
        self.assertNotIn("_model", self.ctx)

    def test_model_switch_bad_shape_400(self):
        st, _, _, _ = self.http("POST", "/api/model", body={})
        self.assertEqual(st, 400)
        st, _, _, _ = self.http("POST", "/api/model", body={"model": "a", "model_id": "b"})
        self.assertEqual(st, 400)

    def test_model_id_switch_updates_cross_provider_state(self):
        """Stable model IDs may choose another provider; no global config is modified."""
        registry = ModelRegistry(self.state_dir, process_env={}, env_file={
            "KIMI_API_KEY": "fixture-kimi-key", "DEEPSEEK_API_KEY": "fixture-deepseek-key",
        })
        self.sess.model_registry = registry
        self.sess.model_client = model_client.ModelClient(registry)
        self.sess._reset_model_selection()
        deepseek_id = next(item["id"] for item in registry.public_items()
                           if item["provider"] == "DeepSeek")

        st, _, body, _ = self.http("POST", "/api/model", body={"model_id": deepseek_id})

        self.assertEqual(st, 200)
        self.assertEqual(body["model_id"], deepseek_id)
        self.assertEqual(body["provider"], "DeepSeek")
        self.assertEqual(self.ctx["_model_profile_id"], deepseek_id)
        st, _, state, _ = self.get("/api/state")
        self.assertEqual(state["model_id"], deepseek_id)
        self.assertEqual(state["provider"], "DeepSeek")

    def test_model_switch_single_candidate_locked(self):
        """缺省单模型：连切换到自己以外的值都 400（如实降级，不假装可切）。"""
        st, _, _, _ = self.http("POST", "/api/model", body={"model": "anything-else"})
        self.assertEqual(st, 400)

    # ---- POST /api/autonomy ----

    def test_autonomy_toggle_api(self):
        st, _, state, _ = self.get("/api/state")
        self.assertIs(state["autonomy"], False, "默认审批模式")
        st, _, body, _ = self.http("POST", "/api/autonomy", body={"on": True})
        self.assertEqual(st, 200)
        self.assertEqual({k: body[k] for k in ("ok", "autonomy")}, {"ok": True, "autonomy": True})
        self.assertIs(self.ctx["_autonomy"], True)
        st, _, state, _ = self.get("/api/state")
        self.assertIs(state["autonomy"], True)
        st, _, body, _ = self.http("POST", "/api/autonomy", body={"on": False})
        self.assertEqual({k: body[k] for k in ("ok", "autonomy")}, {"ok": True, "autonomy": False})
        self.assertIs(self.ctx["_autonomy"], False)

    def test_autonomy_bad_shape_400(self):
        st, _, _, _ = self.http("POST", "/api/autonomy", body={"on": "yes"})
        self.assertEqual(st, 400)
        st, _, _, _ = self.http("POST", "/api/autonomy", body={})
        self.assertEqual(st, 400)

    def test_autonomy_api_no_persist_write(self):
        """开关自主 + 自主放行都不写 .state/approvals.json。"""
        with mock.patch.object(approvals, "add") as add_mock:
            self.http("POST", "/api/autonomy", body={"on": True})
            agent._approved("run_command", {"command": "ls"}, "r", _Recorder(False), self.ctx)
        add_mock.assert_not_called()

    # ---- 自主模式经总线审批通道（serve 形态）----

    def test_autonomy_bypasses_bus_approver_but_not_after_off(self):
        agent.set_bus_approver(self.sess.ui_approver)
        try:
            self.http("POST", "/api/autonomy", body={"on": True})
            ok = agent._approved("run_command", {"command": "ls"}, "r", None, self.ctx)
            self.assertTrue(ok)
            self.assertEqual(ui_bus.pending_approvals(), [], "自主中不许登记审批卡")
            self.http("POST", "/api/autonomy", body={"on": False})
            verdict_holder = {}

            def answer():
                import time
                for _ in range(100):
                    time.sleep(0.05)
                    pend = ui_bus.pending_approvals()
                    if pend:
                        verdict_holder["rid"] = pend[0]["request_id"]
                        self.sess.handle_approve({"request_id": pend[0]["request_id"],
                                                  "decision": "n"})
                        return
            import threading
            t = threading.Thread(target=answer, daemon=True)
            t.start()
            ok = agent._approved("run_command", {"command": "ls"}, "r", None, self.ctx)
            t.join(timeout=10)
            self.assertFalse(ok, "切回审批模式后 ask 恢复弹卡（此处答 n 应拒）")
            self.assertIn("rid", verdict_holder, "切回后审批卡必须真的弹出来")
        finally:
            agent.set_bus_approver(None)

    # ---- 新会话重置 ----

    def test_new_session_resets_autonomy_and_model(self):
        os.environ["XS_MODELS"] = "k2-thinking"
        self.http("POST", "/api/autonomy", body={"on": True})
        self.http("POST", "/api/model", body={"model": "k2-thinking"})
        st, _, body, _ = self.http("POST", "/api/sessions/new")
        self.assertEqual(st, 200)
        self.assertTrue(body["switched"])
        self.assertIs(self.ctx["_autonomy"], False, "新会话回审批模式")
        self.assertNotIn("_model", self.ctx, "新会话模型回 .env 默认")
        st, _, state, _ = self.get("/api/state")
        self.assertIs(state["autonomy"], False)
        self.assertEqual(state["model"], config.MODEL)

    # ---- UISession 默认 model_fn 按 ctx 模型档案 ID 走 ----

    def test_session_default_model_fn_uses_ctx_model_id(self):
        sess2 = ui_server.UISession(self.ctx, self.sid, self.history,
                                    self.state_dir / "l2.jsonl", self.state_dir)   # 不传 model_fn
        first_id = "fixture-provider:model-a"
        second_id = "fixture-provider:model-b"
        self.ctx["_model_profile_id"] = first_id
        reply = {"content": "ok", "tool_calls": [], "model": "fixture-upstream", "usage": {}}
        with mock.patch.object(sess2.model_registry, "model", side_effect=lambda model_id: object()):
            with mock.patch.object(sess2.model_client, "chat", return_value=reply) as chat:
                sess2.model_fn([{"role": "user", "content": "hi"}])
                self.ctx["_model_profile_id"] = second_id
                sess2.model_fn([{"role": "user", "content": "hi"}])
        self.assertEqual([call.kwargs["model_id"] for call in chat.call_args_list],
                         [first_id, second_id],
                         "会话级切换后下一次调用必须使用新的模型档案 ID")


# ---------------------------------------------------------------- 本地模型资料 API（只读视图绝不回显密钥）

class ModelProfileApiTests(ServerCase):
    valid_profile = {
        "provider_name": "Example Provider",
        "protocol": "openai_compatible",
        "base_url": "https://example.invalid/v1",
        "auth_mode": "bearer",
        "display_name": "Example Chat",
        "upstream_model": "example-chat",
        "capabilities": ["stream", "tools"],
    }

    def setUp(self):
        super().setUp()
        registry = ModelRegistry(self.state_dir, process_env={}, env_file={
            "KIMI_API_KEY": "fixture-kimi-key",
            "DEEPSEEK_API_KEY": "fixture-deepseek-key",
        })
        self.sess.model_registry = registry
        self.sess.model_client = model_client.ModelClient(registry)
        self.sess._reset_model_selection()
        self.kimi_id = next(item["id"] for item in registry.public_items()
                            if item["provider"] == "Kimi")

    def create_local(self, api_key="fixture-local-key"):
        return self.sess.model_registry.create_profile(self.valid_profile, api_key=api_key).id

    def test_profile_get_never_returns_saved_key(self):
        self.create_local("sk-api-never-return")
        st, _, body, raw = self.get("/api/model-profiles")
        self.assertEqual(st, 200)
        self.assertNotIn(b"sk-api-never-return", raw)
        local = next(p for p in body["profiles"] if p["provider_name"] == "Example Provider")
        self.assertTrue(local["key_configured"])
        self.assertNotIn("api_key", local)

    def test_profile_post_treats_api_key_as_write_only(self):
        payload = self.valid_profile | {"api_key": "sk-write-only"}
        st, _, body, raw = self.http("POST", "/api/model-profiles", body=payload)
        self.assertEqual(st, 201)
        self.assertNotIn(b"sk-write-only", raw)
        self.assertNotIn("api_key", body["profile"])
        self.assertTrue(body["profile"]["key_configured"])

    def test_profile_api_rejects_query_marker_without_echoing_it(self):
        marker = "DO_NOT_EXPOSE_QUERY_MARKER"
        payload = self.valid_profile | {
            "base_url": f"https://example.invalid/v1?token={marker}",
            "api_key": "fixture-write-only",
        }

        st, _, _, raw = self.http("POST", "/api/model-profiles", body=payload)
        self.assertEqual(st, 400)
        self.assertNotIn(marker.encode("ascii"), raw)
        _, _, _, profiles_raw = self.get("/api/model-profiles")
        self.assertNotIn(marker.encode("ascii"), profiles_raw)

    def test_blank_key_on_patch_preserves_saved_key(self):
        model_id = self.create_local("old-secret")
        st, _, body, raw = self.http(
            "PATCH", f"/api/model-profiles/{quote(model_id, safe='')}",
            body={"display_name": "Renamed", "api_key": ""})
        self.assertEqual(st, 200)
        self.assertNotIn(b"old-secret", raw)
        self.assertEqual(self.sess.model_registry.resolve(model_id).api_key, "old-secret")
        self.assertEqual(body["profile"]["display_name"], "Renamed")

    def test_builtin_delete_is_rejected_without_touching_environment(self):
        st, _, body, _ = self.http("DELETE", f"/api/model-profiles/{quote(self.kimi_id, safe='')}")
        self.assertEqual(st, 409)
        self.assertEqual(body["error"]["code"], "conflict")
        self.assertIn(self.kimi_id, {item["id"] for item in self.sess.model_registry.public_items()})

    def test_active_builtin_cannot_be_hidden(self):
        st, _, body, _ = self.http(
            "PATCH", f"/api/model-profiles/{quote(self.kimi_id, safe='')}", body={"enabled": False})
        self.assertEqual(st, 409)
        self.assertEqual(body["error"]["code"], "conflict")
        self.assertTrue(self.sess.model_registry.model(self.kimi_id).enabled)

    def test_connection_test_does_not_persist_availability(self):
        with mock.patch.object(self.sess.model_client, "probe",
                               side_effect=ModelError("quota_limited", "Kimi")):
            st, _, body, _ = self.http(
                "POST", f"/api/model-profiles/{quote(self.kimi_id, safe='')}/test")
        self.assertEqual(st, 429)
        self.assertEqual(body["error"]["code"], "quota_limited")
        self.assertTrue(self.sess.model_registry.model(self.kimi_id).enabled)

    def test_connection_route_revalidates_endpoint_before_transport(self):
        provider = self.sess.model_registry._providers["builtin-kimi"]
        self.sess.model_registry._providers["builtin-kimi"] = provider.__class__(
            **{**provider.__dict__, "base_url": "http://169.254.169.254/latest/meta-data"}
        )

        with mock.patch("harness.model_adapters.get_adapter") as adapter:
            st, _, body, raw = self.http(
                "POST", f"/api/model-profiles/{quote(self.kimi_id, safe='')}/test")

        self.assertEqual(st, 400)
        self.assertEqual(body["error"]["code"], "invalid_url")
        self.assertNotIn(b"169.254.169.254", raw)
        adapter.assert_not_called()


if __name__ == "__main__":
    unittest.main()
