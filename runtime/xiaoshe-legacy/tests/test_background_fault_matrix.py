import json
import unittest
from pathlib import Path

class BackgroundFaultMatrixTests(unittest.TestCase):
 def test_required_fault_matrix_is_complete_and_unique(self):
  scenarios=json.loads((Path(__file__).parent/"fixtures"/"background"/"scenarios.json").read_text())
  self.assertEqual(15,len(scenarios)); self.assertEqual(15,len(set(scenarios)))
  self.assertIn("worker_killed_during_write",scenarios); self.assertIn("duplicate_schedule_fire",scenarios)
