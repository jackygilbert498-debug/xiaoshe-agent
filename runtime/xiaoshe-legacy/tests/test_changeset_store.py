import tempfile, unittest
from pathlib import Path
from harness.task_engine import TaskEngine
from harness.task_model import CreateTask, StartRun, TaskStatus
from harness.task_store import TaskStore

class ChangeSetStoreTests(unittest.TestCase):
 def test_metadata_is_persisted_without_patch_body(self):
  with tempfile.TemporaryDirectory() as tmp:
   store=TaskStore(Path(tmp)/"db.sqlite"); project=store.create_project("p",Path(tmp)/"repo"); engine=TaskEngine(store); task=engine.create_task(CreateTask(project["id"],"t","g",("ok",))); ready=engine.transition(task["id"],TaskStatus.READY,task["version"],"u"); task,run=engine.start_run(StartRun(ready["id"],ready["version"],"a")); saved=store.insert_changeset(task["id"],run["id"],"wsv1:x","sha256:y",{"files":[{"path":"a.py","patch_artifact":"artifacts/tsk/a.patch"}]})
   self.assertEqual("sha256:y",saved["diff_hash"]); self.assertEqual(saved["id"],store.list_changesets(task["id"])[0]["id"]); self.assertNotIn("patch_body",str(store.list_changesets(task["id"])))
   review=store.record_review(saved["id"],"req_review_1","approve","ok","sha256:y","wsv1:x"); self.assertEqual(review["id"],store.record_review(saved["id"],"req_review_1","approve","ok","sha256:y","wsv1:x")["id"])
