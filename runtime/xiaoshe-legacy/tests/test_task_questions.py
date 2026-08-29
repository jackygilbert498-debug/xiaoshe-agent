import tempfile
import unittest
from pathlib import Path

from harness.task_engine import TaskEngine
from harness.task_model import AnswerQuestion, AskQuestion, CreateTask, StartRun, TaskStatus, TaskingError
from harness.task_store import TaskStore


class TaskQuestionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.temp.name) / "tasks.db")
        project = self.store.create_project("repo", Path(self.temp.name) / "repo")
        self.engine = TaskEngine(self.store)
        task = self.engine.create_task(CreateTask(project["id"], "修复", "修复解析器", ("测试通过",)))
        ready = self.engine.transition(task["id"], TaskStatus.READY, task["version"], "user")
        self.task, self.run = self.engine.start_run(StartRun(ready["id"], ready["version"], "agent"))

    def tearDown(self):
        self.temp.cleanup()

    def ask(self, choices=("保留", "覆盖"), allow_free_text=False):
        return self.engine.ask_question(AskQuestion(self.run["id"], "检测到本地修改，如何处理？", choices, allow_free_text, "FILE_CONFLICT"))

    def test_answer_resumes_same_run_once(self):
        waiting, question = self.ask()
        self.assertEqual("WaitingUser", waiting["status"])
        first, answered = self.engine.answer_question(AnswerQuestion(waiting["id"], question["id"], "保留", waiting["version"]))
        second, again = self.engine.answer_question(AnswerQuestion(first["id"], question["id"], "保留", first["version"]))
        self.assertEqual(self.run["id"], first["active_run_id"])
        self.assertEqual(first["version"], second["version"])
        self.assertEqual("answered", again["status"])
        self.assertEqual(1, sum(event["type"] == "question.answered" for event in self.store.list_events(self.task["id"])))
        self.assertEqual(answered["id"], question["id"])

    def test_question_is_single_open_validates_choices_and_persists(self):
        waiting, question = self.ask()
        with self.assertRaisesRegex(TaskingError, "TASK_RUN_NOT_ACTIVE"):
            self.ask()
        with self.assertRaisesRegex(TaskingError, "TASK_QUESTION_ANSWER_INVALID"):
            self.engine.answer_question(AnswerQuestion(waiting["id"], question["id"], "删除", waiting["version"]))
        reloaded = TaskStore(self.store.db_path)
        self.assertEqual(question["id"], TaskEngine(reloaded).questions.list_open(waiting["id"])[0]["id"])

    def test_closed_run_cannot_be_resumed_by_old_question(self):
        waiting, question = self.ask()
        with self.store.transaction() as conn:
            conn.execute("UPDATE runs SET status='Stopped' WHERE id=?", (self.run["id"],))
        with self.assertRaisesRegex(TaskingError, "TASK_RUN_NOT_ACTIVE"):
            self.engine.answer_question(AnswerQuestion(waiting["id"], question["id"], "保留", waiting["version"]))


if __name__ == "__main__":
    unittest.main()
