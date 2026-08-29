import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

from harness.task_api import TaskAPI
from harness.task_engine import TaskEngine
from harness.task_model import CreateTask
from harness.project_memory_retrieval import ProjectMemoryRetriever, RetrievalQuery
from harness.task_store import TaskStore


class ProjectMemoryAPITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.temp.name) / "tasks.db")
        self.left = self.store.create_project("left", Path(self.temp.name) / "left")
        self.right = self.store.create_project("right", Path(self.temp.name) / "right")
        self.api = TaskAPI(self.store)

    def tearDown(self):
        self.temp.cleanup()

    def create_candidate(self, project=None):
        project = project or self.left
        response = self.api.dispatch("POST", f"/api/v2/projects/{project['id']}/memories", {
            "kind": "convention", "text": "变更后运行单元测试", "source_ref": "user:req_memory_api",
            "source_trust": "deterministic_evidence", "confidence": 0.8, "actor": "user",
            "request_id": "req_memory_api_create",
        })
        self.assertEqual(201, response.status)
        return response.body["memory"]

    def test_candidate_lifecycle_is_versioned_and_source_trust_is_server_derived(self):
        candidate = self.create_candidate()
        self.assertEqual("candidate", candidate["status"])
        self.assertEqual("user_direct", candidate["source_trust"])
        listed = self.api.dispatch("GET", f"/api/v2/projects/{self.left['id']}/memories")
        self.assertEqual([candidate["id"]], [item["id"] for item in listed.body["memories"]])
        approved = self.api.dispatch("POST", f"/api/v2/projects/{self.left['id']}/memories/{candidate['id']}/approve", {
            "expected_version": candidate["version"], "actor": "reviewer",
        })
        self.assertEqual(200, approved.status)
        self.assertEqual("approved", approved.body["memory"]["status"])
        stale = self.api.dispatch("POST", f"/api/v2/projects/{self.left['id']}/memories/{candidate['id']}/reject", {
            "expected_version": candidate["version"], "actor": "reviewer",
        })
        self.assertEqual(409, stale.status)
        self.assertEqual("TASK_VERSION_CONFLICT", stale.body["error"]["code"])

    def test_forget_requires_reason_and_removes_text(self):
        candidate = self.create_candidate()
        approved = self.api.dispatch("POST", f"/api/v2/projects/{self.left['id']}/memories/{candidate['id']}/approve", {
            "expected_version": candidate["version"], "actor": "reviewer",
        }).body["memory"]
        missing_reason = self.api.dispatch("POST", f"/api/v2/projects/{self.left['id']}/memories/{candidate['id']}/forget", {
            "expected_version": approved["version"], "actor": "reviewer",
        })
        self.assertEqual(400, missing_reason.status)
        forgotten = self.api.dispatch("POST", f"/api/v2/projects/{self.left['id']}/memories/{candidate['id']}/forget", {
            "expected_version": approved["version"], "actor": "reviewer", "reason": "用户撤回",
        })
        self.assertEqual(200, forgotten.status)
        self.assertEqual("forgotten", forgotten.body["memory"]["status"])
        self.assertIsNone(forgotten.body["memory"]["text"])

    def test_rewrite_and_approve_preserves_original_candidate(self):
        candidate = self.create_candidate()
        response = self.api.dispatch("POST", f"/api/v2/projects/{self.left['id']}/memories/{candidate['id']}/rewrite-and-approve", {
            "expected_version": candidate["version"], "actor": "reviewer", "text": "改写后的测试约定",
        })
        self.assertEqual(200, response.status)
        self.assertEqual("approved", response.body["memory"]["status"])
        self.assertNotEqual(candidate["id"], response.body["memory"]["id"])
        self.assertEqual("candidate", self.store.memory_record(candidate["id"], self.left["id"])["status"])

    def test_supersede_requires_explicit_approved_replacement_and_version(self):
        old = self.create_candidate()
        old = self.api.dispatch("POST", f"/api/v2/projects/{self.left['id']}/memories/{old['id']}/approve", {"expected_version": old["version"], "actor": "reviewer"}).body["memory"]
        replacement = self.api.dispatch("POST", f"/api/v2/projects/{self.left['id']}/memories", {"kind": "convention", "text": "新测试约定", "source_ref": "user:req_memory_api_replacement", "confidence": 0.9, "actor": "user", "request_id": "req_memory_api_replacement"}).body["memory"]
        replacement = self.api.dispatch("POST", f"/api/v2/projects/{self.left['id']}/memories/{replacement['id']}/approve", {"expected_version": replacement["version"], "actor": "reviewer"}).body["memory"]
        response = self.api.dispatch("POST", f"/api/v2/projects/{self.left['id']}/memories/{old['id']}/supersede", {"expected_version": old["version"], "actor": "reviewer", "new_memory_id": replacement["id"]})
        self.assertEqual(200, response.status)
        self.assertEqual("superseded", response.body["memory"]["status"])

    def test_expired_memory_can_only_be_renewed_with_an_explicit_future_review_date(self):
        candidate = self.create_candidate()
        approved = self.api.dispatch("POST", f"/api/v2/projects/{self.left['id']}/memories/{candidate['id']}/approve", {"expected_version": candidate["version"], "actor": "reviewer"}).body["memory"]
        with self.store.transaction() as conn:
            conn.execute("UPDATE memory_records SET status='expired', version=version+1 WHERE id=?", (approved["id"],))
        expired = self.store.memory_record(approved["id"], self.left["id"])
        review_at = (datetime.now(UTC) + timedelta(days=30)).isoformat().replace("+00:00", "Z")
        response = self.api.dispatch("POST", f"/api/v2/projects/{self.left['id']}/memories/{approved['id']}/review", {"expected_version": expired["version"], "actor": "reviewer", "review_after": review_at})
        self.assertEqual(200, response.status)
        self.assertEqual("approved", response.body["memory"]["status"])

    def test_source_summary_is_project_scoped(self):
        source = self.api.dispatch("GET", f"/api/v2/projects/{self.left['id']}/memory-sources", query={"source_ref": ["user:req_memory_api"]})
        self.assertEqual(200, source.status)
        self.assertEqual("user_direct", source.body["source"]["trust"])
        task = TaskEngine(self.store).create_task(CreateTask(self.left["id"], "left task", "keep source private", ("proof",)))
        source_ref = f"task_event:{task['id']}:1"
        resolved = self.api.dispatch("GET", f"/api/v2/projects/{self.left['id']}/memory-sources", query={"source_ref": [source_ref]})
        self.assertEqual(200, resolved.status)
        other_project = self.api.dispatch("GET", f"/api/v2/projects/{self.right['id']}/memory-sources", query={"source_ref": [source_ref]})
        self.assertEqual(404, other_project.status)
        self.assertEqual("TASK_MEMORY_SOURCE_NOT_FOUND", other_project.body["error"]["code"])
        missing = self.api.dispatch("GET", f"/api/v2/projects/{self.left['id']}/memory-sources")
        self.assertEqual(400, missing.status)

    def test_usage_receipts_are_project_scoped_and_do_not_include_text(self):
        candidate = self.create_candidate()
        approved = self.api.dispatch("POST", f"/api/v2/projects/{self.left['id']}/memories/{candidate['id']}/approve", {
            "expected_version": candidate["version"], "actor": "reviewer",
        }).body["memory"]
        retriever = ProjectMemoryRetriever(self.store)
        result = retriever.retrieve(RetrievalQuery(self.left["id"], "变更 测试"))
        retriever.record_usage(self.left["id"], "run_memory_api", None, result.injected_ids, result.query_hash)
        response = self.api.dispatch("GET", f"/api/v2/projects/{self.left['id']}/memory-usage-receipts", query={"run_id": ["run_memory_api"]})
        self.assertEqual(200, response.status)
        self.assertEqual([approved["id"]], response.body["receipts"][0]["record_ids"])
        self.assertNotIn("text", response.body["receipts"][0])
        other = self.api.dispatch("GET", f"/api/v2/projects/{self.right['id']}/memory-usage-receipts")
        self.assertEqual([], other.body["receipts"])


if __name__ == "__main__":
    unittest.main()
