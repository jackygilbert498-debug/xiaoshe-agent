import subprocess, tempfile, unittest
from pathlib import Path
from harness.artifact_store import ArtifactStore
from harness.change_set import ChangeSetService
from harness.diff_capture import DiffCapture
from harness.review_service import ReviewCommand, ReviewError, ReviewService

class ReviewServiceTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(); self.root=Path(self.tmp.name)/"repo"; self.root.mkdir(); subprocess.run(["git","init","-q",str(self.root)],check=True); (self.root/"a.py").write_text("a=1\n"); subprocess.run(["git","-C",str(self.root),"add","a.py"],check=True); subprocess.run(["git","-C",str(self.root),"-c","user.name=t","-c","user.email=t@x","commit","-qm","init"],check=True); (self.root/"a.py").write_text("a=2\n"); head=subprocess.check_output(["git","-C",str(self.root),"rev-parse","HEAD"]).decode().strip(); self.cs=ChangeSetService(DiffCapture(ArtifactStore(Path(self.tmp.name)/"out"))).capture_changes("tsk_1","run_1",self.root,head); self.reviews=ReviewService()
 def tearDown(self): self.tmp.cleanup()
 def command(self,request="req_1"): return ReviewCommand(self.cs,self.root,self.cs.diff_hash,self.cs.workspace_version,"approve","ok",request)
 def test_workspace_drift_rejects_review_without_decision(self):
  (self.root/"late.py").write_text("late\n")
  with self.assertRaisesRegex(ReviewError,"REVIEW_CHANGESET_STALE"): self.reviews.submit(self.command())
 def test_decision_is_idempotent_by_request_id(self):
  self.assertEqual(self.reviews.submit(self.command()),self.reviews.submit(self.command()))
