import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from harness.plan_store import PlanStore
from harness.task_engine import TaskEngine
from harness.task_model import CreateTask, ReviewPlan, StartRun, TaskingError
from harness.task_store import TaskStore


def fixture_plan():
    return json.loads((Path(__file__).parent / "fixtures" / "tasking" / "plan_v1.json").read_text(encoding="utf-8"))


class PlanStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.temp.name) / "tasks.db")
        project = self.store.create_project("repo", Path(self.temp.name) / "repo")
        self.task = self.store.create_task(CreateTask(project["id"], "修复", "修复解析器", ("解析器返回明确错误", "回归测试通过")))
        self.plans = PlanStore(self.store)
        self.engine = TaskEngine(self.store, self.plans)

    def tearDown(self):
        self.temp.cleanup()

    def propose(self):
        return self.engine.propose_plan(self.task["id"], fixture_plan(), "agent", self.store.get_task(self.task["id"])["version"])

    def approve(self):
        plan = self.propose()
        return self.engine.review_plan(ReviewPlan(self.task["id"], plan["revision"], "approve", "可以执行", self.store.get_task(self.task["id"])["version"], "user"))

    def test_edit_and_approve_creates_new_revision(self):
        first = self.propose()
        edited = fixture_plan()
        edited["steps"][0]["title"] = "用户改过"
        approved = self.engine.review_plan(ReviewPlan(
            task_id=self.task["id"], revision=first["revision"], decision="edit-and-approve",
            feedback="缩小范围", edited_body=edited, expected_version=self.store.get_task(self.task["id"])["version"], actor="user",
        ))
        self.assertEqual(2, approved["revision"])
        self.assertEqual("proposed", self.plans.get(self.task["id"], 1)["status"])
        self.assertEqual("approved", approved["status"])
        self.assertEqual("Ready", self.store.get_task(self.task["id"])["status"])

    def test_run_referenced_revision_cannot_be_deleted_or_mutated(self):
        plan = self.approve()
        task = self.store.get_task(self.task["id"])
        self.engine.start_run(StartRun(self.task["id"], task["version"], "agent"))
        with self.assertRaisesRegex(TaskingError, "TASK_PLAN_IMMUTABLE"):
            self.plans.replace_body(self.task["id"], plan["revision"], fixture_plan())

    def test_reject_returns_task_to_planning_and_records_feedback(self):
        plan = self.propose()
        result = self.engine.review_plan(ReviewPlan(self.task["id"], plan["revision"], "reject", "范围太大", self.store.get_task(self.task["id"])["version"], "user"))
        self.assertEqual("rejected", result["status"])
        self.assertEqual("范围太大", result["feedback"])
        self.assertEqual("Planning", self.store.get_task(self.task["id"])["status"])

    def test_generic_transition_cannot_bypass_plan_submission(self):
        self.engine.transition(self.task["id"], __import__("harness.task_model", fromlist=["TaskStatus"]).TaskStatus.PLANNING, 0, "user")
        with self.assertRaisesRegex(TaskingError, "TASK_PLAN_REQUIRED"):
            self.engine.transition(self.task["id"], __import__("harness.task_model", fromlist=["TaskStatus"]).TaskStatus.AWAITING_PLAN_APPROVAL, 1, "user")

    def test_migrates_v3_fixture_to_plan_schema(self):
        path = Path(self.temp.name) / "v3.db"
        conn = sqlite3.connect(path)
        conn.executescript((Path(__file__).parent / "fixtures" / "tasking" / "schema_v2.sql").read_text(encoding="utf-8"))
        conn.close()
        migrated = TaskStore(path)
        conn = migrated._connect()
        try:
            self.assertEqual(TaskStore.SCHEMA_VERSION, conn.execute("SELECT version FROM schema_meta").fetchone()[0])
            self.assertIn("active_plan_revision", {row[1] for row in conn.execute("PRAGMA table_info(tasks)")})
            self.assertIn("plan_revisions", {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")})
            self.assertIn("task_questions", {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")})
            self.assertIn("run_controls", {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")})
            self.assertIn("changesets", {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")})
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
