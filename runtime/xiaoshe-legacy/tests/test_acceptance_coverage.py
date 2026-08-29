import unittest
from harness.acceptance import evaluate
class AcceptanceCoverageTests(unittest.TestCase):
 def test_each_acceptance_has_own_status(self):
  items=evaluate(['a','b'],{'a':['unit'],'b':['lint']},[{'check_id':'unit','status':'passed'},{'check_id':'lint','status':'failed'}])
  self.assertEqual(['covered_pass','covered_fail'],[item.status for item in items])
 def test_missing_mapping_is_not_implicitly_green(self): self.assertEqual('not_covered',evaluate(['a'],{},[])[0].status)
