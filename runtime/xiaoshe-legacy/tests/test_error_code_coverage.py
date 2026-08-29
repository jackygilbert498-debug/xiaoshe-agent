import re,unittest
from pathlib import Path
from harness.error_codes import REGISTRY
class ErrorCodeCoverageTests(unittest.TestCase):
 def test_all_literal_tasking_errors_are_registered(self):
  found=set()
  for path in Path("harness").glob("*.py"):
   found.update(re.findall(r'TaskingError\("([A-Z0-9_]+)"',path.read_text(encoding="utf-8")))
  self.assertTrue(found <= {item.code for item in REGISTRY.all()}, sorted(found-{item.code for item in REGISTRY.all()}))
