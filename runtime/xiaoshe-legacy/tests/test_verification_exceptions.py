import unittest
from datetime import datetime,timedelta
from harness.verification_exceptions import KnownFailureService,KnownFailureError
class KnownFailureTests(unittest.TestCase):
 def test_new_failure_cannot_be_waived_as_known(self):
  with self.assertRaisesRegex(KnownFailureError,'KNOWN_FAILURE_BASELINE_REQUIRED'): KnownFailureService().create(check={'check_id':'x','profile_checksum':'p','fingerprint':'f'},baseline=None,reason='以前就坏了',actor='u',expires_at='2999-01-01T00:00:00+00:00')
 def test_touched_related_file_cannot_reuse_exception(self):
  item=KnownFailureService().create(check={'check_id':'x','profile_checksum':'p','fingerprint':'f'},baseline={'status':'failed','verification_id':'v'},reason='old',actor='u',expires_at='2999-01-01T00:00:00+00:00',affected_globs=['src/*'])
  self.assertFalse(KnownFailureService().applies(item,check_id='x',profile_checksum='p',fingerprint='f',changed_paths=['src/a.py']))
