import tempfile,unittest
from pathlib import Path
from harness.task_api import TaskAPI
from harness.task_store import TaskStore
class BetaApiTests(unittest.TestCase):
 def setUp(self): self.d=tempfile.TemporaryDirectory();self.api=TaskAPI(TaskStore(Path(self.d.name)/"tasks.db"))
 def tearDown(self):self.d.cleanup()
 def test_privacy_is_off_and_preview_precedes_export(self):
  self.assertEqual("off",self.api.dispatch("GET","/api/v2/privacy").body["consent"])
  self.assertEqual(200,self.api.dispatch("POST","/api/v2/privacy",{"consent":"on","consent_version":1}).status)
  p=self.api.dispatch("POST","/api/v2/diagnostics/preview",{"task_counts":{"Ready":1}}).body
  self.assertEqual(201,self.api.dispatch("POST","/api/v2/diagnostics/export",{"preview_id":p["preview_id"]}).status)

 def test_privacy_control_is_discoverable_without_a_task(self):
  root=Path(__file__).resolve().parents[1]
  self.assertIn('id="beta-privacy"',(root/"ui/index.html").read_text(encoding="utf-8"))
  self.assertIn("openPrivacy(event.currentTarget, { notify })",(root/"ui/js/tasking/inbox.js").read_text(encoding="utf-8"))
