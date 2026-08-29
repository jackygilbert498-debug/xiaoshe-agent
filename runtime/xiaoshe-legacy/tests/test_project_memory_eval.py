import json, subprocess, sys, tempfile, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
class ProjectMemoryEvalTests(unittest.TestCase):
 def test_frozen_suite_meets_safety_gates(self):
  cases=ROOT/'tests/fixtures/memory/eval_cases.json'
  with tempfile.TemporaryDirectory() as d:
   out=Path(d)/'report.json';subprocess.run([sys.executable,'scripts/eval_project_memory.py','--cases',str(cases),'--output',str(out)],cwd=ROOT,check=True)
   r=json.loads(out.read_text());self.assertEqual(40,r['case_count'])
   for k in ('project_leakage','unapproved_injection','expired_injection','forgotten_recovery'):self.assertEqual(0,r[k])
   self.assertEqual(1.0,r['receipt_precision']);self.assertGreaterEqual(r['relevant_recall_at_5'],.85);self.assertLessEqual(r['irrelevant_injection_rate'],.1)
