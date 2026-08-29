import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from harness.task_api import TaskAPI
from harness.task_engine import TaskEngine
from harness.task_model import CreateTask, ReviewPlan, StartRun
from harness.task_store import TaskStore

class BackgroundControlTests(unittest.TestCase):
 def ready_task_with_workspace(self, store, project):
  task=TaskEngine(store).create_task(CreateTask(project["id"],"t","g",("proof",)))
  engine=TaskEngine(store)
  plan=engine.propose_plan(task["id"],{"objective":"g","assumptions":[],"steps":[{"id":"work","title":"work","intent":"work","files":["README.md"],"validation":["proof"],"risk":"low","depends_on":[]}],"acceptance_mapping":{"proof":["work"]},"estimated_budget":{}},"test",task["version"])
  engine.review_plan(ReviewPlan(task["id"],plan["revision"],"approve","ok",store.get_task(task["id"])["version"],"test"))
  workspace=store.reserve_workspace(task["id"],project["id"],"isolated",{"kind":"test"})
  store.activate_workspace(workspace["id"],Path(project["root"]),"test:1")
  return store.get_task(task["id"])

 def test_pause_resume_cancel_are_queue_only_and_serializable(self):
  with tempfile.TemporaryDirectory() as temp:
   store=TaskStore(Path(temp)/"t.db"); project=store.create_project("p",Path(temp)); task=self.ready_task_with_workspace(store,project)
   api=TaskAPI(store); body={"trigger_kind":"manual","trigger_key":"request:1","priority":0,"not_before":datetime.now(UTC).isoformat(),"policy_id":"p","expected_version":task["version"]}
   created=api.dispatch("POST",f"/api/v2/tasks/{task['id']}/queue",body).body["queue_item"]
   paused=api.dispatch("POST",f"/api/v2/queue/{created['id']}/pause",{"expected_version":created["version"]}).body["queue_item"]
   self.assertEqual("paused",paused["status"]); self.assertEqual("Ready",store.get_task(task["id"])["status"])
   cancelled=api.dispatch("POST",f"/api/v2/queue/{created['id']}/cancel",{"expected_version":paused["version"]}).body["queue_item"]
   self.assertEqual("cancelled",cancelled["status"])

 def test_queue_rejects_a_draft_task_before_it_creates_a_queue_item(self):
  with tempfile.TemporaryDirectory() as temp:
   store=TaskStore(Path(temp)/"t.db"); project=store.create_project("p",Path(temp)); task=store.create_task(CreateTask(project["id"],"t","g",("proof",)))
   response=TaskAPI(store).dispatch("POST",f"/api/v2/tasks/{task['id']}/queue",{"trigger_kind":"manual","trigger_key":"request:draft","priority":0,"not_before":datetime.now(UTC).isoformat(),"policy_id":"p","expected_version":task["version"]})
   self.assertEqual(422,response.status)
   self.assertEqual("TASK_UNATTENDED_PRECONDITION_REQUIRED",response.body["error"]["code"])
   self.assertEqual([],store.list_queue_items(task["id"]))

 def test_task_cancel_terminates_active_run_but_is_not_queue_cancel(self):
  with tempfile.TemporaryDirectory() as temp:
   store=TaskStore(Path(temp)/"t.db"); project=store.create_project("p",Path(temp)); task=store.create_task(CreateTask(project["id"],"t","g",("proof",)))
   ready=store.transition_task(task["id"],task["version"],"Ready","test")
   running, run=store.start_run(StartRun(ready["id"],ready["version"],"test"))
   response=TaskAPI(store).dispatch("POST",f"/api/v2/tasks/{task['id']}/cancel",{"actor":"user","expected_version":running["version"]})
   self.assertEqual("Cancelled",response.body["task"]["status"])
   self.assertIsNone(response.body["task"]["active_run_id"])
   self.assertEqual("Cancelled",response.body["run"]["status"])
