import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from harness.agent import _run_tool, run_once
from harness.task_model import RunContext


def _allowing_plan_gate_module() -> types.ModuleType:
    """Keep this Task 3 adapter test runnable without later-plan modules."""
    module = types.ModuleType("harness.plan_gate")

    class PlanGate:
        def before_action(self, *_args, **_kwargs):
            return None

    module.PlanGate = PlanGate
    return module


def one_tool_then_final(messages, **_kwargs):
    if any(message.get("role") == "tool" for message in messages):
        return {"role": "assistant", "content": "完成"}
    return {"role": "assistant", "content": "", "tool_calls": [{
        "id": "call_1", "type": "function",
        "function": {"name": "read_file", "arguments": json.dumps({"path": "README.md"})},
    }]}


class TaskRunAdapterTests(unittest.TestCase):
    def test_run_context_emits_paired_action_events(self):
        events = []
        context = RunContext("tsk_1", "run_1", None, "ws_1", {}, lambda kind, payload: events.append((kind, payload)))
        with tempfile.TemporaryDirectory() as td, \
             mock.patch.dict(sys.modules, {"harness.plan_gate": _allowing_plan_gate_module()}):
            reply = run_once("读取说明", [], model_fn=one_tool_then_final, approver=lambda *_: True,
                             log_file=Path(td) / "agent.jsonl", run_context=context)
        self.assertEqual("完成", reply)
        self.assertEqual(["action.started", "action.finished"], [kind for kind, _ in events])
        self.assertTrue(events[-1][1]["ok"])

    def test_legacy_call_does_not_require_run_context(self):
        reply = run_once("你好", [], model_fn=lambda *_args, **_kwargs: {"role": "assistant", "content": "好"})
        self.assertEqual("好", reply)

    def test_tool_exception_preserves_unknown_task_action_outcome(self):
        events = []
        context = RunContext("tsk_1", "run_1", None, "ws_1", {}, lambda kind, payload: events.append((kind, payload)))
        with mock.patch("harness.agent.permission.check", return_value=mock.Mock(action="approve", reason="")), \
             mock.patch("harness.agent.tools_mod.execute", side_effect=RuntimeError("boom")):
            with mock.patch.dict(sys.modules, {"harness.plan_gate": _allowing_plan_gate_module()}):
                with self.assertRaisesRegex(RuntimeError, "boom"):
                    _run_tool("read_file", {"path": "README.md"}, {"_run_context": context}, lambda *_: True, Path("/tmp/task.log"))
        self.assertEqual(["action.started", "action.outcome_unknown"], [kind for kind, _ in events])
        self.assertEqual("tool_response_unknown", events[-1][1]["reason_code"])
        self.assertTrue(events[-1][1]["reconciliation_required"])
        self.assertEqual(events[0][1]["action_id"], events[-1][1]["action_id"])
