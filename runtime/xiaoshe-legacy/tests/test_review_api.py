"""ChangeSet API 和 Review 事务的本地 Git 集成测试。"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from harness.task_api import TaskAPI
from harness.task_engine import TaskEngine
from harness.task_model import FinishRun, RunStatus
from harness.task_store import TaskStore


class ReviewApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "repo 空格"
        self.root.mkdir()
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        (self.root / "a.py").write_text("value = 1\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(self.root), "add", "a.py"], check=True)
        subprocess.run(["git", "-C", str(self.root), "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"], check=True)
        self.store = TaskStore(Path(self.temp.name) / "tasks.sqlite")
        self.engine = TaskEngine(self.store)
        self.api = TaskAPI(self.store, self.engine)
        created = self.api.dispatch("POST", "/api/v2/projects", {"name": "p", "root": str(self.root)}).body["project"]
        self.task = self.api.dispatch("POST", "/api/v2/tasks", {
            "project_id": created["id"], "title": "改 a", "goal": "改 a", "acceptance": ["可审查"],
        }).body["task"]
        self.task = self.api.dispatch("POST", f"/api/v2/tasks/{self.task['id']}/transition", {
            "to": "Ready", "actor": "user", "expected_version": self.task["version"],
        }).body["task"]
        started = self.api.dispatch("POST", f"/api/v2/tasks/{self.task['id']}/runs", {
            "actor": "agent", "expected_version": self.task["version"],
        }).body
        self.task, self.run = started["task"], started["run"]
        (self.root / "a.py").write_text("value = 2\n", encoding="utf-8")
        self.task, self.run = self.engine.finish_run(FinishRun(
            self.run["id"], self.task["version"], "agent", RunStatus.COMPLETED,
        ))

    def tearDown(self):
        self.temp.cleanup()

    def capture(self):
        result = self.api.dispatch("POST", f"/api/v2/tasks/{self.task['id']}/changesets", {"run_id": self.run["id"]})
        self.assertIn(result.status, {200, 201})
        return result.body["changeset"]

    def test_completed_git_run_is_captured_before_review_and_capture_is_idempotent(self):
        automatic = self.store.current_changeset(self.task["id"])
        self.assertIsNotNone(automatic)
        self.assertEqual(self.run["id"], automatic["run_id"])
        repeated = self.capture()
        self.assertEqual(automatic["id"], repeated["id"])
        self.assertEqual(1, len(self.store.list_changesets(self.task["id"])))

    def review_body(self, changeset, decision="approve"):
        return {"changeset_id": changeset["id"], "diff_hash": changeset["diff_hash"],
                "workspace_version": changeset["workspace_version"], "decision": decision,
                "feedback": "请只改解析器" if decision == "request_changes" else "可以",
                "request_id": "req_review_1", "actor": "user", "expected_version": self.task["version"]}

    def test_capture_current_artifact_and_approve_are_bound_to_same_version(self):
        changeset = self.capture()
        current = self.api.dispatch("GET", f"/api/v2/tasks/{self.task['id']}/changesets/current")
        self.assertEqual(changeset["id"], current.body["changeset"]["id"])
        patch = self.api.dispatch("GET", f"/api/v2/tasks/{self.task['id']}/changesets/{changeset['id']}/artifacts/tracked")
        self.assertEqual(200, patch.status)
        self.assertIn("value = 2", patch.body["text"])
        reviewed = self.api.dispatch("POST", f"/api/v2/tasks/{self.task['id']}/reviews", self.review_body(changeset))
        self.assertEqual(200, reviewed.status)
        self.assertEqual("Verifying", reviewed.body["task"]["status"])
        self.assertEqual("approve", reviewed.body["review"]["decision"])

    def test_drift_returns_409_marks_old_changeset_stale_and_does_not_record_review(self):
        changeset = self.capture()
        (self.root / "late.py").write_text("late = True\n", encoding="utf-8")
        rejected = self.api.dispatch("POST", f"/api/v2/tasks/{self.task['id']}/reviews", self.review_body(changeset))
        self.assertEqual(409, rejected.status)
        self.assertEqual("REVIEW_CHANGESET_STALE", rejected.body["error"]["code"])
        self.assertIsNotNone(self.store.get_changeset(changeset["id"])["stale_at"])
        self.assertEqual([], self.store.list_review_decisions(changeset["id"]))

    def test_request_changes_starts_a_new_run_and_keeps_old_review(self):
        changeset = self.capture()
        reviewed = self.api.dispatch("POST", f"/api/v2/tasks/{self.task['id']}/reviews", self.review_body(changeset, "request_changes"))
        self.assertEqual(200, reviewed.status)
        self.assertEqual("Running", reviewed.body["task"]["status"])
        next_run = reviewed.body["run"]
        self.assertEqual(self.run["id"], next_run["supersedes_run_id"])
        self.assertEqual(self.run["attempt"] + 1, next_run["attempt"])
        self.assertEqual("request_changes", self.store.list_review_decisions(changeset["id"])[0]["decision"])


if __name__ == "__main__":
    unittest.main()
