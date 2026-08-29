"""Focused recovery-contract coverage retained by the Task 5 plan command."""
from __future__ import annotations

import unittest

from harness.effect_outcomes import recovery_options


class TaskRecoveryEffectTruthTests(unittest.TestCase):
    def test_unknown_external_write_requires_confirmation_not_reinvocation(self):
        self.assertEqual(
            ("confirmed_succeeded", "confirmed_failed", "compensate"),
            recovery_options({
                "outcome_state": "outcome_unknown",
                "idempotency_class": "non_idempotent",
                "idempotency_proven": False,
                "tool": "run_command",
            }),
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
