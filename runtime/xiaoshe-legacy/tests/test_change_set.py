import subprocess, tempfile, unittest
from pathlib import Path
from harness.artifact_store import ArtifactStore
from harness.change_set import ChangeSetService
from harness.diff_capture import DiffCapture

class ChangeSetTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(); self.root=Path(self.tmp.name)/"repo"; self.root.mkdir(); subprocess.run(["git","init","-q",str(self.root)],check=True)
  (self.root/"a.py").write_text("x=1\n"); subprocess.run(["git","-C",str(self.root),"add","a.py"],check=True); subprocess.run(["git","-C",str(self.root),"-c","user.name=t","-c","user.email=t@x","commit","-qm","init"],check=True)
  self.service=ChangeSetService(DiffCapture(ArtifactStore(Path(self.tmp.name)/"out")))
 def tearDown(self): self.tmp.cleanup()
 def test_shell_generated_file_is_captured_and_attributed(self):
  (self.root/"generated.py").write_text("x=1\n"); head=subprocess.check_output(["git","-C",str(self.root),"rev-parse","HEAD"]).decode().strip()
  cs=self.service.capture_changes("tsk_1","run_1",self.root,head,{"steps":[{"id":"gen","files":["generated.py"]}],"acceptance_mapping":{"generated":["gen"]}},[{"id":"ef_1","action_id":"act_1","targets":["generated.py"]}])
  item=cs.file("generated.py"); self.assertEqual(("act_1",),item.origin_action_ids); self.assertEqual(("gen",),item.plan_step_ids)
 def test_unattributed_user_change_is_visible_and_highlighted(self):
  (self.root/"surprise.txt").write_text("human\n"); head=subprocess.check_output(["git","-C",str(self.root),"rev-parse","HEAD"]).decode().strip(); item=self.service.capture_changes("tsk_1","run_1",self.root,head).file("surprise.txt")
  self.assertEqual("unknown",item.origin); self.assertIn("UNATTRIBUTED_CHANGE",item.risk_flags)
 def test_rename_delete_and_mode_metadata_remain_visible_in_manifest(self):
  head=subprocess.check_output(["git","-C",str(self.root),"rev-parse","HEAD"]).decode().strip()
  subprocess.run(["git","-C",str(self.root),"mv","a.py","renamed.py"],check=True)
  cs=self.service.capture_changes("tsk_1","run_1",self.root,head)
  renamed=cs.file("renamed.py")
  self.assertEqual("renamed",renamed.change_type); self.assertIn("R",renamed.xy)
  self.assertEqual("renamed",next(item for item in cs.manifest()["files"] if item["path"] == "renamed.py")["change_type"])
 def test_staged_delete_is_not_silently_dropped(self):
  head=subprocess.check_output(["git","-C",str(self.root),"rev-parse","HEAD"]).decode().strip()
  subprocess.run(["git","-C",str(self.root),"rm","-q","a.py"],check=True)
  item=self.service.capture_changes("tsk_1","run_1",self.root,head).file("a.py")
  self.assertEqual("deleted",item.change_type); self.assertIn("D",item.xy)
