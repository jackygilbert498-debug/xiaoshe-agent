import tempfile
import unittest
from pathlib import Path
from harness.task_inbox import TaskInbox
from harness.task_model import CreateTask
from harness.task_store import TaskStore

class TaskInboxTests(unittest.TestCase):
    def test_needs_user_is_derived_only_from_task_status(self):
        with tempfile.TemporaryDirectory() as temp:
            store=TaskStore(Path(temp)/"t.db"); project=store.create_project("p",Path(temp)); tasks=[]
            for title,status in (("wait","WaitingUser"),("review","Review"),("run","Running")):
                task=store.create_task(CreateTask(project["id"],title,"g",())); tasks.append(store.transition_task(task["id"],task["version"],status,"test"))
            result=TaskInbox(store).query(needs_user=True)
            self.assertEqual({"WaitingUser","Review"},{item["status"] for item in result.items})
