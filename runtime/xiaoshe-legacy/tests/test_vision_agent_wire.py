"""P3 v0.5 · 心脏集成：run_once 送点包 wire + 压缩锚点扣图。TDD 红→绿。

- 发给模型的是 wire 后的副本（尾部带图）；持久 history 永不含 base64（resume 免疫）。
- 压缩锚点用上一发真 token，但要扣掉那一发临时图的 token（否则锚点虚高、压缩晚触发/欠触发）。
运行：仓库根 `python -m unittest discover -s tests -v`
"""
import json
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest import mock

from harness import agent, vision
from harness.context_budget import ContextBudgetError
from harness.kimi_client import KimiError
from harness.runtime_factory import runtime_session_scope
from tests.test_context_budget import _runtime_fixture


def solid_png(w, h, rgb=(10, 20, 30)):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


class 心脏集成(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self._p = mock.patch.object(vision, "VISION_DIR", Path(self._d.name))
        self._p.start()
        self._log = Path(self._d.name) / "l.jsonl"

    def tearDown(self):
        self._p.stop()
        self._d.cleanup()

    def test_pending图发给模型时materialize_但history不落base64(self):
        ref = vision.put_image("sess", solid_png(100, 100))
        seen = {}

        def fake_model(messages, tools=None):
            seen["msgs"] = messages
            return {"content": "看到了", "tool_calls": []}

        history = []
        ctx = {"todos": [], "session_id": "sess", "_vision_pending": [ref], "_approved_tools": set()}
        reply = agent.run_once("这是什么", history, model_fn=fake_model,
                               approver=lambda *a: True, log_file=self._log, ctx=ctx)
        self.assertEqual(reply, "看到了")
        # 模型收到的消息里带图
        self.assertIn("data:image", json.dumps(seen["msgs"], ensure_ascii=False))
        # ★ 但持久 history 里没有任何 base64（resume 免疫）
        self.assertNotIn("base64", json.dumps(history, ensure_ascii=False))
        self.assertNotIn("_vision_pending", ctx)  # 已被 wire 消费

    def test_压缩锚点扣掉上一发的图token(self):
        captured = {}

        def spy(history, model_fn, summarizer=None, used_tokens=None, **kw):
            captured["used"] = used_tokens
            return False

        def fake_model(messages, tools=None):
            return {"content": "ok", "tool_calls": []}

        ctx = {"todos": [], "session_id": "sess", "_approved_tools": set(),
               "_last_usage": {"prompt_tokens": 5000}, "_vision_last_tokens": 1200}
        with mock.patch.object(agent.compaction, "maybe_compact", spy):
            agent.run_once("hi", [], model_fn=fake_model,
                           approver=lambda *a: True, log_file=self._log, ctx=ctx)
        self.assertEqual(captured["used"], 5000 - 1200)  # 锚点扣掉上一发临时图 token

    def test_budget_path_selects_only_safe_refs_then_materializes_for_provider(self):
        ref = vision.put_image("sess", solid_png(20, 20))
        ctx = {"todos": [], "session_id": "sess", "_vision_pending": [ref],
               "_approved_tools": set(), "_context_budget_enabled": True}
        observed = {}
        original_prepare = agent._prepare_budgeted_send

        def inspect_prepare(messages, request_ctx):
            rendered = json.dumps(messages, ensure_ascii=False)
            observed["budget_input"] = rendered
            self.assertNotIn("data:image", rendered)
            self.assertNotIn("SECRETBINARY", rendered)
            return original_prepare(messages, request_ctx)

        def fake_model(messages, tools=None):
            observed["provider"] = json.dumps(messages, ensure_ascii=False)
            return {"content": "ok", "tool_calls": []}

        runtime, _snapshot = _runtime_fixture(session_id="sess")
        with runtime_session_scope(runtime), \
             mock.patch.object(agent.calibrate, "effective_window", return_value=8_000), \
             mock.patch.object(agent, "_prepare_budgeted_send", side_effect=inspect_prepare), \
             mock.patch.object(vision, "_wire_image_uri",
                               return_value="data:image/png;base64,SECRETBINARY"):
            agent.run_once("inspect", [], model_fn=fake_model,
                           approver=lambda *a: True, log_file=self._log, ctx=ctx)
        self.assertIn(ref, observed["budget_input"])
        self.assertIn("data:image/png;base64,SECRETBINARY", observed["provider"])

    def test_image_tokens_are_reserved_and_oversized_images_fail_before_provider(self):
        ref = vision.put_image("sess", solid_png(20, 20))
        ctx = {"session_id": "sess", "_vision_pending": [ref],
               "_context_budget_enabled": True}
        runtime, _ = _runtime_fixture(session_id="sess")
        original_meta = vision.meta

        def huge_meta(sid, image_ref):
            value = dict(original_meta(sid, image_ref))
            value["tokens_est"] = 31_900
            return value

        model = mock.Mock(return_value={"content": "should not run"})
        with runtime_session_scope(runtime), \
             mock.patch.object(agent.calibrate, "effective_window", return_value=32_000), \
             mock.patch.object(vision, "meta", side_effect=huge_meta), \
             self.assertRaises(ContextBudgetError) as caught:
            agent._send(model, [], ctx, None, [])
        self.assertEqual("image_context_overflow", caught.exception.code)
        model.assert_not_called()

    def test_provider_overflow_retry_reuses_the_same_immutable_image_refs(self):
        ref = vision.put_image("sess", solid_png(20, 20))
        ctx = {"session_id": "sess", "_vision_pending": [ref],
               "_context_budget_enabled": True}
        runtime, _ = _runtime_fixture(session_id="sess")
        attempts = []

        def model(messages, tools=None):
            attempts.append(json.dumps(messages, ensure_ascii=False))
            if len(attempts) == 1:
                raise KimiError("token limit: 16384 (requested: 20000)")
            return {"content": "ok"}

        with runtime_session_scope(runtime), \
             mock.patch.object(agent.calibrate, "effective_window", side_effect=lambda state: state.get("_context_window", 32_000)), \
             mock.patch.object(agent.calibrate, "learn_window", side_effect=lambda window, requested, state: state.__setitem__("_context_window", window)), \
             mock.patch.object(vision, "_wire_image_uri", return_value="data:image/png;base64,SAMEIMAGE"):
            result = agent._send(model, [], ctx, None, [])
        self.assertEqual("ok", result["content"])
        self.assertEqual(2, len(attempts))
        self.assertTrue(all("SAMEIMAGE" in attempt for attempt in attempts))
        self.assertNotIn("_vision_pending", ctx)


if __name__ == "__main__":
    unittest.main(verbosity=2)
