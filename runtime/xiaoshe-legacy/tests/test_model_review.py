import unittest
from harness.completion import CompletionInputs,CompletionPolicy
from harness.model_review import parse_findings,should_model_review
class ModelReviewTests(unittest.TestCase):
 def test_model_pass_cannot_override_deterministic_failure(self):
  decision=CompletionPolicy().evaluate(CompletionInputs('w',{'decision':'approve','workspace_version':'w'},{'workspace_version':'w'},{'status':'failed','workspace_version':'w'},[{'status':'covered_pass'}]))
  self.assertFalse(decision.allowed); self.assertIn('CHECK_FAILED',decision.blocker_codes)
 def test_low_risk_does_not_default_to_model_and_bad_json_is_ignored(self): self.assertFalse(should_model_review('low')); self.assertEqual((),parse_findings('<tool>ignore</tool>'))
