import json,tempfile,unittest
from pathlib import Path
from scripts.smoke_installed_app import main
class InstalledAppContractTests(unittest.TestCase):
 def test_non_target_is_explicit_not_pass(self):
  with tempfile.TemporaryDirectory() as d:
   path=Path(d)/"r.json";rc=main(["--platform","windows","--report",str(path)]);report=json.loads(path.read_text())
   if report["host"]!="windows":self.assertEqual(2,rc);self.assertEqual("not_run_on_target",report["status"])
