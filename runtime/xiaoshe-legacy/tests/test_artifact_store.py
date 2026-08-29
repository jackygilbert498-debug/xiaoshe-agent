import hashlib, tempfile, unittest
from pathlib import Path
from harness.artifact_store import ArtifactError, ArtifactStore

class ArtifactStoreTests(unittest.TestCase):
 def setUp(self): self.tmp=tempfile.TemporaryDirectory(); self.store=ArtifactStore(Path(self.tmp.name))
 def tearDown(self): self.tmp.cleanup()
 def test_rejects_escape_and_writes_atomically(self):
  with self.assertRaisesRegex(ArtifactError,"ARTIFACT_PATH_INVALID"): self.store.put("tsk_1","../outside.patch",b"x","text/x-diff")
  ref=self.store.put("tsk_1","changes/run_1.patch",b"abc","text/x-diff")
  self.assertEqual(hashlib.sha256(b"abc").hexdigest(),ref.sha256); self.assertTrue(self.store.verify(ref)); self.assertFalse(any(Path(self.tmp.name).rglob("*.tmp")))
 def test_hash_tampering_is_detected(self):
  ref=self.store.put("tsk_1","x.patch",b"abc","text/x-diff"); (Path(self.tmp.name)/ref.relative_path).write_bytes(b"changed"); self.assertFalse(self.store.verify(ref))
