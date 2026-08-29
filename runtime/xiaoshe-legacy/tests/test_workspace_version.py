import subprocess, tempfile, unittest
from pathlib import Path
from harness.git_status import WorkspaceStatus
from harness.workspace_version import WorkspaceSnapshot, WorkspaceVersionService, compute_workspace_version

class WorkspaceVersionTests(unittest.TestCase):
 def test_same_snapshot_is_order_independent(self):
  a=WorkspaceSnapshot("a","a",WorkspaceStatus(untracked=("b.txt","a.txt")),"t","s",({"path":"b.txt","sha256":"b"},{"path":"a.txt","sha256":"a"}))
  b=WorkspaceSnapshot("a","a",WorkspaceStatus(untracked=("a.txt","b.txt")),"t","s",tuple(reversed(a.untracked)))
  self.assertEqual(compute_workspace_version(a),compute_workspace_version(b))
 def test_untracked_content_change_with_same_size_changes_version(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp); subprocess.run(["git","init","-q",str(root)],check=True); (root/"new.txt").write_bytes(b"aa")
   service=WorkspaceVersionService(); first=service.current(root); (root/"new.txt").write_bytes(b"bb")
   self.assertNotEqual(first,service.current(root))
