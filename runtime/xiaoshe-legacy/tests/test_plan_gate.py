import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from harness.agent import run_once
from harness.plan_gate import PlanGate
from harness.task_model import RunContext
from harness import tools


def tool_call(name):
    def model(messages, **_kwargs):
        if any(message.get("role") == "tool" for message in messages):
            return {"role": "assistant", "content": "已停止"}
        return {"role": "assistant", "content": "", "tool_calls": [{
            "id": "call_1", "type": "function",
            "function": {"name": name, "arguments": json.dumps({"path": "README.md", "content": "x"})},
        }]}
    return model


class PlanGateTests(unittest.TestCase):
    def test_simple_read_only_request_can_start_without_plan(self):
        req = PlanGate().classify_request("读取 README 并总结", ["read_file"])
        self.assertFalse(req.requires_plan)

    def test_unknown_and_registered_tools_have_conservative_effects(self):
        self.assertEqual("read", tools.effect_kind("read_file"))
        self.assertEqual("mutate", tools.effect_kind("write_file"))
        self.assertEqual("external", tools.effect_kind("unregistered_tool"))
        self.assertEqual("external", tools.effect_kind("mcp__server__tool"))

    def test_mutation_is_blocked_before_permission_or_dispatch(self):
        events = []
        context = RunContext("tsk_1", "run_1", None, "ws_1", {}, lambda kind, payload: events.append((kind, payload)))
        history = []
        with tempfile.TemporaryDirectory() as td, \
             patch("harness.agent.permission.check") as permission_check, \
             patch("harness.agent.tools_mod.execute") as execute:
            run_once("改文件", history, model_fn=tool_call("write_file"), log_file=Path(td) / "agent.jsonl", run_context=context)
        execute.assert_not_called()
        permission_check.assert_not_called()
        stopped = next(payload for kind, payload in events if kind == "run.preflight_stopped")
        self.assertEqual("PLAN_REQUIRED_BEFORE_MUTATION", stopped["code"])
        self.assertIn("批准计划", next(item["content"] for item in history if item.get("role") == "tool"))

    def test_read_action_remains_available_without_plan(self):
        events = []
        context = RunContext("tsk_1", "run_1", None, "ws_1", {}, lambda kind, payload: events.append((kind, payload)))
        with tempfile.TemporaryDirectory() as td:
            reply = run_once("读文件", [], model_fn=tool_call("read_file"), log_file=Path(td) / "agent.jsonl", run_context=context)
        self.assertIn("已停止", reply)
        self.assertEqual(["action.started", "action.finished"], [kind for kind, _ in events])


if __name__ == "__main__":
    unittest.main()
