import unittest
from pathlib import Path
from unittest.mock import patch

from harness.agent import _run_tool
from harness.permission import Decision
from harness.run_policy import ExecutionMode, apply_mode, classify_deviation, freeze_policy_snapshot
from harness.task_model import RunContext


class RunPolicyTests(unittest.TestCase):
    def test_plan_approval_never_turns_permission_ask_into_approve(self):
        raw = Decision("ask", "network requires confirmation")
        final = apply_mode(raw, ExecutionMode.COLLABORATE, "web_search")
        self.assertEqual("ask", final.action)

    def test_observe_mode_only_tightens_a_permissive_mutation(self):
        final = apply_mode(Decision("approve"), ExecutionMode.OBSERVE, "write_file")
        self.assertEqual("ask", final.action)
        self.assertTrue(final.force_ask)

    def test_snapshot_is_stable_and_deviation_is_pre_dispatch(self):
        snapshot = freeze_policy_snapshot("collaborate", plan_revision=3, plan_files=("harness/parser.py", "tests/*.py"))
        self.assertEqual("none", classify_deviation(snapshot, "write_file", {"path": "harness/parser.py"}).level)
        self.assertEqual("material", classify_deviation(snapshot, "write_file", {"path": "harness/auth.py"}).level)
        self.assertEqual("material", classify_deviation(snapshot, "mcp__remote__write", {}).level)
        self.assertEqual("critical", classify_deviation(snapshot, "write_file", {"path": ".state/x"}).level)

    def test_material_deviation_is_blocked_before_permission_or_dispatch(self):
        events = []
        context = RunContext("tsk_1", "run_1", "3", "ws_1", freeze_policy_snapshot("collaborate", plan_revision=3, plan_files=("harness/parser.py",)), lambda kind, payload: events.append((kind, payload)))
        with patch("harness.agent.permission.check") as permission_check, patch("harness.agent.tools_mod.execute") as execute:
            content, is_error, executed = _run_tool("write_file", {"path": "harness/auth.py", "content": "x"}, {"_run_context": context}, lambda *_: True, Path("/tmp/plan-policy.log"))
        self.assertTrue(is_error)
        self.assertFalse(executed)
        self.assertIn("修订", content)
        permission_check.assert_not_called()
        execute.assert_not_called()
        self.assertEqual("material", events[0][1]["level"])


if __name__ == "__main__":
    unittest.main()
