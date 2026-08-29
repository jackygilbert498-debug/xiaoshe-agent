import json
import unittest
from pathlib import Path

class ReleaseGatesTests(unittest.TestCase):
    def test_any_user_work_loss_is_immediate_rollback_condition(self):
        gates=json.loads((Path("docs/release/beta-gates.json")).read_text())
        self.assertIn("user_work_loss>0",gates["rollback"])
        self.assertEqual(1000,gates["cohorts"]["commercial_beta"]["min_tasks"])
