import unittest
from harness.completion import CompletionInputs,CompletionPolicy
class CompletionPolicyTests(unittest.TestCase):
 def valid(self): return CompletionInputs('wsv1:a',{'decision':'approve','workspace_version':'wsv1:a'},{'workspace_version':'wsv1:a','stale_at':None},{'status':'passed','workspace_version':'wsv1:a'},[{'status':'covered_pass'}])
 def test_final_model_text_is_not_completion_evidence(self):
  decision=CompletionPolicy().evaluate(CompletionInputs('wsv1:a',{'decision':'approve','workspace_version':'wsv1:a'},{'workspace_version':'wsv1:a' },None,[{'status':'covered_pass'}]))
  self.assertFalse(decision.allowed); self.assertIn('VERIFICATION_MISSING',decision.blocker_codes)
 def test_stale_or_failed_evidence_blocks(self):
  decision=CompletionPolicy().evaluate(CompletionInputs('wsv1:a',{'decision':'approve','workspace_version':'wsv1:a'},{'workspace_version':'wsv1:a'}, {'status':'failed','workspace_version':'wsv1:a'},[{'status':'not_covered'}]))
  self.assertIn('CHECK_FAILED',decision.blocker_codes); self.assertIn('ACCEPTANCE_NOT_SATISFIED',decision.blocker_codes)
