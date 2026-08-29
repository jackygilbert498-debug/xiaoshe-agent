import tempfile,unittest
from pathlib import Path
from harness.task_api import TaskAPI
from harness.task_store import TaskStore
class BetaObservabilityTests(unittest.TestCase):
 def test_gate_board_never_exposes_payload_text(self):
  with tempfile.TemporaryDirectory() as d:
   api=TaskAPI(TaskStore(Path(d)/"tasks.db"),workspace_root=Path(d));body=api.dispatch("GET","/api/v2/beta-observability").body
   self.assertEqual(1,body["v"]);self.assertEqual("missing",body["gates"]["resources"]["state"]);self.assertNotIn("prompt",str(body))
