from __future__ import annotations
import unittest
from harness.verification_model import profile_checksum
from tests.test_verification_service import VerificationServiceTests

class VerificationApiTests(VerificationServiceTests):
 def test_profile_and_run_routes_expose_redacted_evidence_on_demand(self):
  profiles=self.api.dispatch('GET',f"/api/v2/projects/{self.task['project_id']}/verification-profiles")
  self.assertEqual(200,profiles.status); self.assertTrue(profiles.body['candidates'])
  result=self.api.dispatch('POST',f"/api/v2/tasks/{self.task['id']}/verifications",{'profile_checksum':profile_checksum(self.profile),'actor':'u','expected_version':self.task['version']})
  self.assertEqual(202,result.status); verification=result.body['verification']; self.assertTrue(verification['checks'])
  check=verification['checks'][0]
  evidence=self.api.dispatch('GET',f"/api/v2/tasks/{self.task['id']}/evidence/{verification['id']}/{check['id']}")
  self.assertEqual(200,evidence.status); self.assertIn('artifact',evidence.body)

if __name__ == '__main__': unittest.main()
