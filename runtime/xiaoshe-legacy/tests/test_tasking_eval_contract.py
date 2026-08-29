import hashlib,json,unittest
from pathlib import Path
class TaskingEvalContractTests(unittest.TestCase):
 def test_suite_has_exact_distribution_and_hashes(self):
  root=Path("evals/tasking_v1"); suite=json.loads((root/"manifest.json").read_text(encoding="utf-8"))
  self.assertEqual(100,len(suite["tasks"])); self.assertEqual({"bugfix":25,"feature":20,"test":15,"refactor":10,"docs_config":10,"review_only":5,"recovery":5,"permission_security":5,"background_memory":5},suite["distribution"])
  for item in suite["tasks"]:
   payload=json.loads((root/item["path"]).read_text(encoding="utf-8"));self.assertTrue(payload["acceptance"] and payload["oracle"]);self.assertEqual(item["sha256"],"sha256:"+hashlib.sha256((root/item["path"]).read_bytes()).hexdigest())
