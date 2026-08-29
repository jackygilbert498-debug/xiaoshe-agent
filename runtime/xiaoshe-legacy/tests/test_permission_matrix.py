import unittest

from harness.permission import Decision
from harness.permission_matrix import DECISION_RANK, PermissionContext, PermissionMatrix


class PermissionMatrixTests(unittest.TestCase):
    def setUp(self):
        self.matrix = PermissionMatrix()

    def test_matrix_never_weakens_raw_decision(self):
        contexts = [
            PermissionContext(mode="collaborate"),
            PermissionContext(mode="observe", unattended=True),
            PermissionContext(taint="external_untrusted", workspace_capability="shared"),
        ]
        for raw_action in DECISION_RANK:
            for context in contexts:
                with self.subTest(raw=raw_action, context=context):
                    final = self.matrix.evaluate(Decision(raw_action, "raw"), context,
                                                 {"tool": "write_file", "effect": "write"})
                    self.assertGreaterEqual(DECISION_RANK[final.action], DECISION_RANK[raw_action])
                    self.assertEqual(raw_action, final.raw_action)
                    self.assertTrue(final.context_hash.startswith("sha256:"))

    def test_force_ask_survives_plan_and_unattended_authorization(self):
        raw = Decision("ask", "force-ask:sensitive-path", True, "PERMISSION_FORCE_ASK")
        final = self.matrix.evaluate(raw, PermissionContext(mode="collaborate", unattended=True),
                                     {"tool": "write_file", "effect": "write"})
        self.assertEqual("ask", final.action)
        self.assertTrue(final.force_ask)
        self.assertEqual("PERMISSION_FORCE_ASK", final.code)

    def test_untrusted_mutation_and_unisolated_workspace_require_confirmation(self):
        final = self.matrix.evaluate(Decision("approve"), PermissionContext(
            taint="external_untrusted", workspace_capability="shared"),
            {"tool": "write_file", "effect": "write"})
        self.assertEqual("ask", final.action)
        self.assertTrue(final.force_ask)

    def test_recovery_delete_is_force_ask(self):
        final = self.matrix.evaluate(Decision("approve"), PermissionContext(operation_kind="recovery"),
                                     {"tool": "recovery_execute", "effect": "write", "operation": "delete"})
        self.assertEqual("ask", final.action)
        self.assertEqual("PERMISSION_RECOVERY_STRONG_CONFIRMATION", final.code)


if __name__ == "__main__":
    unittest.main()
