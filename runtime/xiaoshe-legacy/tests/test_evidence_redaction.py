import unittest
from pathlib import Path
from harness.evidence_redaction import EvidenceRedactor

class EvidenceRedactionTests(unittest.TestCase):
 def test_secret_split_across_chunks_is_redacted(self):
  redactor=EvidenceRedactor(Path('/tmp/project'),['sk-live-abcdef'])
  self.assertEqual(b'',redactor.feed(b'token=sk-live-'))
  stored=redactor.feed(b'abcdef\n')+redactor.finalize()
  self.assertNotIn(b'sk-live-abcdef',stored); self.assertIn(b'[REDACTED_SECRET]',stored)
 def test_paths_and_url_credentials_are_folded(self):
  redactor=EvidenceRedactor(Path('/tmp/project'))
  stored=redactor.feed(b'https://u:p@example.com /tmp/project/src/a.py /Users/alice/x')+redactor.finalize()
  self.assertNotIn(b'u:p',stored); self.assertIn(b'<PROJECT>/src/a.py',stored); self.assertNotIn(b'alice',stored)
