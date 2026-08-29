import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock
import run as run_entry
from harness import config
from harness.task_model import CreateTask
from harness.task_queue import TaskQueue
from harness.task_store import TaskStore
from harness.task_engine import TaskEngine
from harness.task_model import ReviewPlan
from harness.task_triggers import HeadlessTrigger, JobTrigger, ScheduleTrigger, TaskingTriggerBridge

class TaskAdapterTests(unittest.TestCase):
    def test_same_nominal_schedule_time_enqueues_once_and_shutdown_is_honest(self):
        with tempfile.TemporaryDirectory() as temp:
            store=TaskStore(Path(temp)/"t.db"); project=store.create_project("p",Path(temp)); task=store.create_task(CreateTask(project["id"],"t","g",()))
            trigger=ScheduleTrigger(TaskQueue(store)); now=datetime(2026,8,4,tzinfo=UTC)
            a=trigger.fire(task,"s1",now,"p1"); b=trigger.fire(task,"s1",now,"p1")
            self.assertEqual(a.queue_item_id,b.queue_item_id)
            self.assertEqual("pending_app_closed",JobTrigger(TaskQueue(store)).on_app_shutdown(a).display_status)

    def test_headless_requires_explicit_unattended_policy(self):
        with tempfile.TemporaryDirectory() as temp:
            store=TaskStore(Path(temp)/"t.db"); project=store.create_project("p",Path(temp)); task=store.create_task(CreateTask(project["id"],"t","g",()))
            with self.assertRaisesRegex(ValueError,"UNATTENDED_POLICY_REQUIRED"):
                HeadlessTrigger(TaskQueue(store)).enqueue(task,"r1",None,datetime(2026,8,4,tzinfo=UTC))

    def test_bridge_requires_ready_approved_task_before_schedule_enters_queue(self):
        with tempfile.TemporaryDirectory() as temp:
            store=TaskStore(Path(temp)/"t.db"); project=store.create_project("p",Path(temp)); task=store.create_task(CreateTask(project["id"],"t","g",("proof",)))
            bridge=TaskingTriggerBridge(store)
            with self.assertRaisesRegex(ValueError,"UNATTENDED_TASK_PRECONDITION_REQUIRED"):
                bridge.schedule_fire(task["id"],"s1",datetime(2026,8,4,tzinfo=UTC),"p1")
            engine=TaskEngine(store)
            plan=engine.propose_plan(task["id"],{"objective":"g","assumptions":[],"steps":[{"id":"work","title":"work","intent":"work","files":["README.md"],"validation":["proof"],"risk":"low","depends_on":[]}],"acceptance_mapping":{"proof":["work"]},"estimated_budget":{}},"agent",task["version"])
            engine.review_plan(ReviewPlan(task["id"],plan["revision"],"approve","ok",store.get_task(task["id"])["version"],"user"))
            result=bridge.schedule_fire(task["id"],"s1",datetime(2026,8,4,tzinfo=UTC),"p1")
            self.assertEqual("pending",TaskQueue(store).get(result.queue_item_id).status)

    def test_cli_headless_binding_writes_queue_instead_of_running_freeform_prompt(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(config, "ROOT", Path(temp)), mock.patch.object(config, "tasking_mode", return_value="on"):
            root=Path(temp); store=TaskStore(root/".state"/"tasking"/"tasks.db"); project=store.create_project("p",root/"repo")
            task=store.create_task(CreateTask(project["id"],"t","g",("proof",))); engine=TaskEngine(store)
            plan=engine.propose_plan(task["id"],{"objective":"g","assumptions":[],"steps":[{"id":"work","title":"work","intent":"work","files":["README.md"],"validation":["proof"],"risk":"low","depends_on":[]}],"acceptance_mapping":{"proof":["work"]},"estimated_budget":{}},"agent",task["version"])
            engine.review_plan(ReviewPlan(task["id"],plan["revision"],"approve","ok",store.get_task(task["id"])["version"],"user"))
            with mock.patch("sys.argv",["run.py","--task-id",task["id"],"--policy-id","p1","--request-id","r1"]):
                self.assertEqual(0,run_entry.main())
            self.assertEqual(1,len(store.list_queue_items(task["id"])))
