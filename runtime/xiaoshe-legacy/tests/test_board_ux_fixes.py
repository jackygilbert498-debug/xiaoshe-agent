"""云端看板 #0015/#0017/#0018/#0019 的稳定 UI/状态契约。"""
import unittest
import tempfile
import threading
from pathlib import Path
from unittest import mock

from harness import agent, ui_bus, ui_state

ROOT = Path(__file__).resolve().parent.parent


class BoardUxFixes(unittest.TestCase):
    def test_tool_round_limit_default_and_env_bounds(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertEqual(agent._tool_round_limit(), agent.MAX_TOOL_ROUNDS)
        with mock.patch.dict("os.environ", {"XIAOSHE_MAX_TOOL_ROUNDS": "1000"}, clear=True):
            self.assertEqual(agent._tool_round_limit(), 200)
        with mock.patch.dict("os.environ", {"XIAOSHE_MAX_TOOL_ROUNDS": "1"}, clear=True):
            self.assertEqual(agent._tool_round_limit(), 20)

    def test_snapshot_exposes_run_and_tool_round(self):
        ctx = {"_run_active": True, "_tool_round": {"used": 7, "limit": 60,
               "remaining": 53, "status": "running"}}
        snap = ui_state.snapshot_full(ctx)
        self.assertTrue(snap["run_active"])
        self.assertEqual(snap["tool_round"]["remaining"], 53)
        patch = dict(ui_state.collect_dirty(ctx, ["run_active", "tool_round"]))["state.patch"]
        self.assertEqual(patch["tool_round"]["used"], 7)

    def test_event_bus_accepts_new_observability_keys(self):
        self.assertIn("run_active", ui_bus._DIRTY_KEYS)
        self.assertIn("tool_round", ui_bus._DIRTY_KEYS)

    def test_usage_always_exposes_effective_context_window(self):
        with mock.patch.object(ui_state.calibrate, "effective_window", return_value=1_000_000):
            self.assertEqual(ui_state.usage_safe({"_last_usage": {"prompt_tokens": 123}})["window"],
                             1_000_000)

    def test_cancel_during_approval_stops_before_another_model_request(self):
        cancel = threading.Event()
        calls = []

        def model(_messages, tools=None):
            calls.append(1)
            return {"content": "", "tool_calls": [{"id": "cmd-1", "type": "function",
                    "function": {"name": "run_command", "arguments": '{"command":"pwd"}'}}]}

        def approver(*_args):
            cancel.set()
            return False

        history = []
        with tempfile.TemporaryDirectory() as td:
            reply = agent.run_once("run pwd", history, model_fn=model, approver=approver,
                                   log_file=Path(td) / "agent.jsonl",
                                   ctx={"todos": [], "_cancel_event": cancel})
        self.assertEqual(len(calls), 1)
        self.assertEqual(reply, "（已取消）")
        self.assertEqual(history[-1]["role"], "tool")
        self.assertEqual(history[-1]["tool_call_id"], "cmd-1")

    def test_fixed_status_cancel_button_and_complete_watermark_contract(self):
        html = (ROOT / "ui/index.html").read_text(encoding="utf-8")
        input_js = (ROOT / "ui/js/input.js").read_text(encoding="utf-8")
        css = (ROOT / "ui/styles/base.css").read_text(encoding="utf-8")
        server = (ROOT / "harness/ui_server.py").read_text(encoding="utf-8")
        self.assertIn('id="context-usage"', html)
        self.assertIn('id="tool-round-status"', html)
        self.assertIn('running ? "#stop" : "#send"', input_js)
        block = css.split(".stage-wm {", 1)[1].split("}", 1)[0]
        self.assertNotIn("bottom: -", block)
        self.assertIn("bottom: 24px", block)
        self.assertIn("#btn-model .pill-text", css)
        self.assertIn('self._emit_dirty("run_active", "tool_round", "usage")', server)


if __name__ == "__main__":
    unittest.main()
