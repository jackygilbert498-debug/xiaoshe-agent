from __future__ import annotations

import importlib
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path
from unittest import mock

from harness import config, tools, ui_server, user_tools
from harness.artifact_store import ArtifactStore
from harness.diff_capture import DiffCapture
from harness.task_api import TaskAPI
from harness.task_model import CreateTask, StartRun, TaskingError
from harness.task_store import TaskStore
from harness.workspace_version import WorkspaceVersionService


def _restore(patch: bytes, path: str) -> bytes:
    """Load the wished-for parser without turning a missing feature into import noise."""
    try:
        module = importlib.import_module("harness.task_tool_proposals")
        restore = module._restore_added_file_patch
    except (ModuleNotFoundError, AttributeError) as exc:
        raise AssertionError("task tool proposal patch parser is missing") from exc
    return restore(patch, path)


class AddedFilePatchRestoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        (self.root / "tracked.txt").write_text("base\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(self.root), "add", "tracked.txt"], check=True)
        subprocess.run(
            ["git", "-C", str(self.root), "-c", "user.name=test", "-c", "user.email=test@example.invalid",
             "commit", "-qm", "base"],
            check=True,
        )
        self.baseline = subprocess.check_output(
            ["git", "-C", str(self.root), "rev-parse", "HEAD"], text=True
        ).strip()
        self.store = ArtifactStore(Path(self.temp.name) / "artifacts")
        self.capture = DiffCapture(self.store)

    def tearDown(self):
        self.temp.cleanup()

    def test_restores_diff_capture_added_file_bytes_exactly(self):
        cases = {
            "empty.ps1": b"",
            "no-final-newline.ps1": b"Write-Output 'ok'",
            "trailing-newline.ps1": b"Write-Output 'ok'\n",
            "empty-lines.ps1": b"\n\nWrite-Output 'ok'\n\n",
            "leading-plus.ps1": b"+literal\n++still-literal",
            "\u5de5\u5177.PS1": "param([string]$\u540d\u79f0)\nWrite-Output \"\u4f60\u597d $\u540d\u79f0\"".encode("utf-8"),
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                (self.root / path).write_bytes(expected)
                bundle = self.capture.capture("tsk_parser", self.root, self.baseline)
                item = next(entry for entry in bundle.untracked if entry.path == path)
                patch = self.store.read(item.content_artifact)
                self.assertEqual(expected, _restore(patch, path))

    def test_rejects_any_shape_outside_diff_capture_fixed_added_file_format(self):
        malformed = {
            "tracked header": b"--- a/tool.ps1\n+++ b/tool.ps1\n@@ -1 +1 @@\n-old\n+new",
            "wrong target": b"--- /dev/null\n+++ b/other.ps1\n@@ -0,0 +1 @@\n+x",
            "wrong hunk": b"--- /dev/null\n+++ b/tool.ps1\n@@ -0,0 +1,2 @@\n+x\n+y",
            "context line": b"--- /dev/null\n+++ b/tool.ps1\n@@ -0,0 +1 @@\n+one\ncontext",
            "deletion line": b"--- /dev/null\n+++ b/tool.ps1\n@@ -0,0 +1 @@\n+one\n-deleted",
            "second patch": b"--- /dev/null\n+++ b/tool.ps1\n@@ -0,0 +1 @@\n+one\n--- /dev/null",
            "missing added marker": b"--- /dev/null\n+++ b/tool.ps1\n@@ -0,0 +1 @@\none",
        }
        for label, patch in malformed.items():
            with self.subTest(label=label):
                with self.assertRaises(ValueError):
                    _restore(patch, "tool.ps1")


def _proposal_service(*args, **kwargs):
    try:
        module = importlib.import_module("harness.task_tool_proposals")
        service_type = module.TaskToolProposalService
    except (ModuleNotFoundError, AttributeError) as exc:
        raise AssertionError("task tool proposal service is missing") from exc
    return service_type(*args, **kwargs)


class TaskToolProposalServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.root = base / "repo"
        self.root.mkdir()
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        (self.root / "tracked.txt").write_text("base\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(self.root), "add", "tracked.txt"], check=True)
        subprocess.run(
            ["git", "-C", str(self.root), "-c", "user.name=test", "-c", "user.email=test@example.invalid",
             "commit", "-qm", "base"],
            check=True,
        )
        self.store = TaskStore(base / "state" / "tasks.db")
        self.artifacts = ArtifactStore(base / "state" / "review-artifacts")
        self.user_tools_base = self.store.db_path.parent / "user_tools"
        self.project = self.store.create_project("proposal project", self.root)
        self.task, self.run = self._new_task_and_run()
        self.service = _proposal_service(self.store, self.artifacts)
        self._artifact_counter = 0

    def tearDown(self):
        self.temp.cleanup()

    def _new_task_and_run(self):
        task = self.store.create_task(CreateTask(
            self.project["id"], "save a tool", "save a reviewed script", ("tests pass",)
        ))
        with self.store.transaction() as conn:
            conn.execute("UPDATE tasks SET status='Ready' WHERE id=?", (task["id"],))
        running, run = self.store.start_run(StartRun(task["id"], task["version"], "agent"))
        return running, run

    def _mark_succeeded(self, task_id=None, run_id=None):
        task_id = task_id or self.task["id"]
        run_id = run_id or self.run["id"]
        with self.store.transaction() as conn:
            conn.execute("UPDATE runs SET status='Completed', ended_at='2026-08-09T00:00:00Z' WHERE id=?", (run_id,))
            conn.execute(
                "UPDATE tasks SET status='Succeeded', active_run_id=NULL, version=version+1 WHERE id=?",
                (task_id,),
            )

    @staticmethod
    def _patch(path: str, data: bytes) -> bytes:
        return (b"--- /dev/null\n+++ b/" + os.fsencode(path.replace("\\", "/"))
                + b"\n@@ -0,0 +1 @@\n+" + data.replace(b"\n", b"\n+"))

    def _candidate(self, *, path="tool.ps1", data=b"Write-Output 'ok'", policy="text",
                   include_artifact=True, task_id=None, run_id=None, file_sha=None):
        task_id = task_id or self.task["id"]
        run_id = run_id or self.run["id"]
        self._artifact_counter += 1
        ref = None
        if include_artifact:
            ref = self.artifacts.put(
                task_id,
                f"changes/candidate-{self._artifact_counter}.patch",
                self._patch(path, data),
                "text/x-diff",
            )
        manifest = {
            "files": [],
            "artifacts": {
                "tracked": None,
                "staged": None,
                "untracked": [{
                    "path": path,
                    "size": len(data),
                    "sha256": file_sha or hashlib.sha256(data).hexdigest(),
                    "content_policy": policy,
                    "content_artifact": asdict(ref) if ref is not None else None,
                }],
            },
        }
        version = WorkspaceVersionService().current(self.root)
        changeset = self.store.insert_changeset(
            task_id, run_id, version, "sha256:" + hashlib.sha256(repr(manifest).encode()).hexdigest(), manifest
        )
        return changeset

    @staticmethod
    def _request(changeset, **overrides):
        request = {
            "task_id": changeset["task_id"],
            "changeset_id": changeset["id"],
            "artifact_key": "untracked-0",
            "name": "csv_stats",
            "description": "summarize a CSV file",
            "params": [{"name": "path", "description": "CSV path", "required": True}],
        }
        request.update(overrides)
        return request

    def _assert_no_tool_state(self):
        self.assertEqual([], user_tools.list_pending(self.user_tools_base))
        self.assertEqual([], user_tools.list_active(self.user_tools_base))
        self.assertFalse((self.user_tools_base / "manifest.json").exists())
        self.assertFalse((self.user_tools_base / "active").exists())

    def _verified_candidates(self, task_id):
        method = getattr(self.service, "verified_candidates", None)
        self.assertTrue(callable(method), "server-verified tool candidate reader is missing")
        return method(task_id)

    def _replace_candidate_item(self, changeset, **updates):
        manifest = json.loads(json.dumps(changeset["manifest"]))
        manifest["artifacts"]["untracked"][0].update(updates)
        with self.store.transaction() as conn:
            conn.execute(
                "UPDATE changesets SET manifest_json=? WHERE id=?",
                (json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")), changeset["id"]),
            )
        return self.store.get_changeset(changeset["id"])

    def _rejects(self, changeset, code, **overrides):
        with self.assertRaises(TaskingError) as caught:
            self.service.propose(**self._request(changeset, **overrides))
        self.assertEqual(code, caught.exception.code)
        self._assert_no_tool_state()

    def test_success_writes_only_pending_under_task_store_parent(self):
        changeset = self._candidate(path="tools/report.PS1", data="Write-Output '完成'".encode("utf-8"))
        self._mark_succeeded()

        proposal = self.service.propose(**self._request(changeset))

        self.assertEqual("pending", proposal["status"])
        self.assertEqual("csv_stats", proposal["name"])
        self.assertNotIn("code", proposal)
        self.assertNotIn("path", proposal)
        pending = user_tools.list_pending(self.user_tools_base)
        self.assertEqual(["csv_stats"], [item["name"] for item in pending])
        self.assertFalse((self.user_tools_base / "active").exists())
        self.assertFalse((self.user_tools_base / "manifest.json").exists())
        loaded, problems = user_tools.load_active(self.user_tools_base, reserved=set())
        self.assertEqual(([], []), (loaded, problems))
        from harness import tools
        self.assertNotIn("csv_stats", tools.REGISTRY)

    def test_verified_candidates_returns_only_sanitized_fully_verified_entries(self):
        changeset = self._candidate(path="tools/report.PS1", data="Write-Output '完成'".encode("utf-8"))
        self._mark_succeeded()

        result = self._verified_candidates(self.task["id"])

        self.assertEqual({
            "changeset_id": changeset["id"],
            "candidates": [{"artifact_key": "untracked-0", "display_name": "report.PS1"}],
        }, result)
        public = json.dumps(result, ensure_ascii=False).lower()
        for forbidden in ("tools/", "write-output", "wsv", "sha", "hash", "relative_path", "content_artifact"):
            self.assertNotIn(forbidden, public)
        self._assert_no_tool_state()

    def test_verified_candidates_excludes_sensitive_malformed_and_tampered_artifacts_while_post_rejects(self):
        cases = ("sensitive", "malformed-ref", "tampered")
        for case in cases:
            with self.subTest(case=case):
                changeset = self._candidate(path="secret-token.ps1" if case == "sensitive" else "tool.ps1")
                if case == "malformed-ref":
                    changeset = self._replace_candidate_item(changeset, content_artifact={})
                elif case == "tampered":
                    raw_ref = changeset["manifest"]["artifacts"]["untracked"][0]["content_artifact"]
                    (self.artifacts.base / raw_ref["relative_path"]).write_bytes(b"tampered secret source")
                self._mark_succeeded()

                result = self._verified_candidates(self.task["id"])
                self.assertEqual([], result["candidates"])
                self.assertEqual(changeset["id"], result["changeset_id"])
                expected = {
                    "sensitive": "TASK_ARTIFACT_NOT_TEXT",
                    "malformed-ref": "TASK_NOT_FOUND",
                    "tampered": "TASK_ARTIFACT_HASH_MISMATCH",
                }[case]
                self._rejects(changeset, expected)

    def test_verified_candidates_marks_workspace_drift_stale_without_internal_details(self):
        changeset = self._candidate()
        self._mark_succeeded()
        (self.root / "late.txt").write_text("drift\n", encoding="utf-8")

        with self.assertRaises(TaskingError) as caught:
            self._verified_candidates(self.task["id"])

        self.assertEqual("REVIEW_CHANGESET_STALE", caught.exception.code)
        self.assertEqual({}, caught.exception.details)
        self.assertIsNotNone(self.store.get_changeset(changeset["id"])["stale_at"])
        self._assert_no_tool_state()

    def test_api_get_returns_verified_candidates_and_fails_closed_on_drift(self):
        changeset = self._candidate(path="tools/report.ps1")
        self._mark_succeeded()
        api = TaskAPI(self.store, workspace_root=self.root, artifact_store=self.artifacts)

        result = api.dispatch("GET", f"/api/v2/tasks/{self.task['id']}/tool-proposals")

        self.assertEqual(200, result.status)
        self.assertEqual([{"artifact_key": "untracked-0", "display_name": "report.ps1"}], result.body["candidates"])
        public = json.dumps(result.body, ensure_ascii=False).lower()
        for forbidden in ("tools/", "write-output", "wsv", "sha", "hash", "relative_path", "content_artifact"):
            self.assertNotIn(forbidden, public)

        (self.root / "late.txt").write_text("drift\n", encoding="utf-8")
        stale = api.dispatch("GET", f"/api/v2/tasks/{self.task['id']}/tool-proposals")
        self.assertEqual(409, stale.status)
        self.assertEqual("REVIEW_CHANGESET_STALE", stale.body["error"]["code"])
        self.assertEqual({}, stale.body["error"].get("details", {}))
        stale_public = json.dumps(stale.body, ensure_ascii=False).lower()
        for forbidden in ("wsv", "sha", "hash", "path", "source", "exception", str(self.root).lower()):
            self.assertNotIn(forbidden, stale_public)
        self.assertIsNotNone(self.store.get_changeset(changeset["id"])["stale_at"])

    def test_rejects_task_that_is_not_succeeded(self):
        changeset = self._candidate()
        self._rejects(changeset, "TASK_TRANSITION_INVALID")

    def test_rejects_changeset_from_another_task(self):
        other_task, other_run = self._new_task_and_run()
        changeset = self._candidate(task_id=other_task["id"], run_id=other_run["id"])
        self._mark_succeeded()
        self._rejects(changeset, "TASK_NOT_FOUND", task_id=self.task["id"])

    def test_rejects_changeset_that_is_not_current(self):
        old = self._candidate(path="old.ps1")
        self._candidate(path="new.ps1")
        self._mark_succeeded()
        self._rejects(old, "REVIEW_CHANGESET_STALE")

    def test_rejects_already_stale_changeset(self):
        changeset = self._candidate()
        self.store.mark_changeset_stale(changeset["id"], "sha256:stale")
        self._mark_succeeded()
        self._rejects(changeset, "REVIEW_CHANGESET_STALE")

    def test_rechecks_workspace_and_marks_changeset_stale_on_drift(self):
        changeset = self._candidate()
        self._mark_succeeded()
        (self.root / "late.txt").write_text("drift\n", encoding="utf-8")

        with self.assertRaises(TaskingError) as caught:
            self.service.propose(**self._request(changeset))

        self.assertEqual("REVIEW_CHANGESET_STALE", caught.exception.code)
        self.assertEqual({}, caught.exception.details)
        self._assert_no_tool_state()
        self.assertIsNotNone(self.store.get_changeset(changeset["id"])["stale_at"])

    def test_rejects_bad_artifact_keys_and_indexes(self):
        changeset = self._candidate()
        self._mark_succeeded()
        for key in ("tracked", "untracked--1", "untracked-01", "untracked-1", "untracked-999999",
                    "untracked-" + "9" * 5000):
            with self.subTest(key=key):
                self._rejects(changeset, "TASK_NOT_FOUND", artifact_key=key)

    def test_rejects_non_powershell_sensitive_binary_or_bodyless_candidates(self):
        cases = (
            ("tool.py", "text", True, b"print('x')", "TASK_ARTIFACT_NOT_TEXT"),
            ("secret-tool.ps1", "sensitive", False, b"Write-Output x", "TASK_ARTIFACT_NOT_TEXT"),
            ("secret-tool.ps1", "text", True, b"Write-Output x", "TASK_ARTIFACT_NOT_TEXT"),
            ("tool.ps1", "binary", False, b"\x00\x01", "TASK_ARTIFACT_NOT_TEXT"),
            ("tool.ps1", "text", True, b"Write-Output\x00hidden", "TASK_ARTIFACT_NOT_TEXT"),
            ("tool.ps1", "text", False, b"Write-Output x", "TASK_NOT_FOUND"),
        )
        for path, policy, has_artifact, data, code in cases:
            with self.subTest(path=path, policy=policy, has_artifact=has_artifact):
                changeset = self._candidate(path=path, policy=policy, include_artifact=has_artifact, data=data)
                self._mark_succeeded()
                self._rejects(changeset, code)

    def test_rejects_artifact_tampering(self):
        changeset = self._candidate()
        self._mark_succeeded()
        raw_ref = changeset["manifest"]["artifacts"]["untracked"][0]["content_artifact"]
        (self.artifacts.base / raw_ref["relative_path"]).write_bytes(b"tampered")
        self._rejects(changeset, "TASK_ARTIFACT_HASH_MISMATCH")

    def test_rejects_rebuilt_file_sha_mismatch(self):
        changeset = self._candidate(file_sha="0" * 64)
        self._mark_succeeded()
        self._rejects(changeset, "TASK_ARTIFACT_HASH_MISMATCH")

    def test_user_tool_validation_rejects_name_params_and_invisible_code(self):
        cases = (
            (b"Write-Output ok", {"name": "Bad Name"}),
            (b"Write-Output ok", {"params": [{"name": "Bad", "description": "bad"}]}),
            ("Write-Output ok\u200b".encode("utf-8"), {}),
            (b"\xef\xbb\xbfWrite-Output ok", {}),
        )
        for data, overrides in cases:
            with self.subTest(overrides=overrides, data=data):
                changeset = self._candidate(data=data)
                self._mark_succeeded()
                self._rejects(changeset, "TASK_BAD_REQUEST", **overrides)

    def test_invalid_utf8_is_rejected_before_user_tools(self):
        changeset = self._candidate(data=b"Write-Output \xff")
        self._mark_succeeded()
        self._rejects(changeset, "TASK_BAD_REQUEST")

    def test_api_creates_an_explicit_pending_proposal_without_leaking_source_or_paths(self):
        changeset = self._candidate(data=b"param([string]$path)\nWrite-Output $path")
        self._mark_succeeded()
        api = TaskAPI(self.store, workspace_root=self.root, artifact_store=self.artifacts)

        result = api.dispatch(
            "POST",
            f"/api/v2/tasks/{self.task['id']}/tool-proposals",
            {key: value for key, value in self._request(changeset).items() if key != "task_id"},
        )

        self.assertEqual(201, result.status)
        self.assertEqual("pending", result.body["proposal"]["status"])
        public = json.dumps(result.body, ensure_ascii=False)
        self.assertNotIn("Write-Output", public)
        self.assertNotIn(str(self.artifacts.base), public)
        self.assertNotIn("sha256", public.lower())
        self.assertNotIn("path", result.body["proposal"])
        self.assertFalse((self.user_tools_base / "active").exists())
        self.assertFalse((self.user_tools_base / "manifest.json").exists())

    def test_api_maps_rejections_to_stable_public_errors_without_internal_details(self):
        changeset = self._candidate(data=b"Write-Output \xff")
        self._mark_succeeded()
        api = TaskAPI(self.store, workspace_root=self.root, artifact_store=self.artifacts)

        result = api.dispatch(
            "POST",
            f"/api/v2/tasks/{self.task['id']}/tool-proposals",
            {key: value for key, value in self._request(changeset).items() if key != "task_id"},
        )

        self.assertEqual(400, result.status)
        self.assertEqual("TASK_BAD_REQUEST", result.body["error"]["code"])
        public = json.dumps(result.body, ensure_ascii=False)
        self.assertNotIn("Write-Output", public)
        self.assertNotIn(str(self.artifacts.base), public)
        self.assertNotIn("UnicodeDecodeError", public)
        self._assert_no_tool_state()

    def test_api_workspace_drift_error_contains_no_workspace_or_internal_evidence(self):
        changeset = self._candidate()
        self._mark_succeeded()
        (self.root / "late.txt").write_text("drift\n", encoding="utf-8")
        api = TaskAPI(self.store, workspace_root=self.root, artifact_store=self.artifacts)

        result = api.dispatch(
            "POST",
            f"/api/v2/tasks/{self.task['id']}/tool-proposals",
            {key: value for key, value in self._request(changeset).items() if key != "task_id"},
        )

        self.assertEqual(409, result.status)
        self.assertEqual("REVIEW_CHANGESET_STALE", result.body["error"]["code"])
        public = json.dumps({key: value for key, value in result.body["error"].items() if key != "code"},
                            ensure_ascii=False).lower()
        for forbidden in ("wsv", "sha", "hash", "path", "source", "exception", str(self.root).lower()):
            self.assertNotIn(forbidden, public)
        self._assert_no_tool_state()

    def test_api_artifact_hash_error_contains_no_artifact_or_internal_evidence(self):
        changeset = self._candidate(data=b"Write-Output safe")
        self._mark_succeeded()
        raw_ref = changeset["manifest"]["artifacts"]["untracked"][0]["content_artifact"]
        (self.artifacts.base / raw_ref["relative_path"]).write_bytes(b"tampered secret source")
        api = TaskAPI(self.store, workspace_root=self.root, artifact_store=self.artifacts)

        result = api.dispatch(
            "POST",
            f"/api/v2/tasks/{self.task['id']}/tool-proposals",
            {key: value for key, value in self._request(changeset).items() if key != "task_id"},
        )

        self.assertEqual(400, result.status)
        self.assertEqual("TASK_ARTIFACT_HASH_MISMATCH", result.body["error"]["code"])
        public = json.dumps({key: value for key, value in result.body["error"].items() if key != "code"},
                            ensure_ascii=False).lower()
        for forbidden in ("wsv", "sha", "hash", "path", "source", "exception", "tampered",
                          str(self.root).lower(), str(self.artifacts.base).lower()):
            self.assertNotIn(forbidden, public)
        self._assert_no_tool_state()

    def test_ui_session_routes_proposals_to_canonical_state_review_queue_without_hot_load(self):
        product_root = Path(self.temp.name) / "product"
        state_dir = product_root / ".state"
        state_dir.mkdir(parents=True)
        registry = mock.Mock()
        registry.default_id.return_value = None
        ctx = {"todos": [], "memory_file": product_root / "memory.json", "session_id": "proposal-prod"}
        before_user_tools = dict(tools._USER_TOOLS)
        with mock.patch.object(config, "ROOT", product_root), \
             mock.patch.object(config, "tasking_mode", create=True, return_value="on"):
            session = ui_server.UISession(
                ctx,
                "proposal-prod",
                [],
                state_dir / "log.jsonl",
                state_dir,
                model_fn=lambda *_args, **_kwargs: {"role": "assistant", "content": "ok"},
                model_registry=registry,
                model_client=mock.Mock(),
            )
            api = session.task_api
            self.assertIsNotNone(api)
            self.assertEqual(state_dir / "tasking" / "tasks.db", api.store.db_path)
            project = api.store.create_project("production layout", self.root)
            task = api.store.create_task(CreateTask(project["id"], "save", "save script", ("done",)))
            with api.store.transaction() as conn:
                conn.execute("UPDATE tasks SET status='Ready' WHERE id=?", (task["id"],))
            running, run = api.store.start_run(StartRun(task["id"], task["version"], "agent"))
            data = b"Write-Output canonical"
            ref = api.artifact_store.put(
                task["id"], "changes/production.patch", self._patch("production.ps1", data), "text/x-diff"
            )
            manifest = {
                "files": [],
                "artifacts": {"tracked": None, "staged": None, "untracked": [{
                    "path": "production.ps1", "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(), "content_policy": "text",
                    "content_artifact": asdict(ref),
                }]},
            }
            version = WorkspaceVersionService().current(self.root)
            changeset = api.store.insert_changeset(
                task["id"], run["id"], version,
                "sha256:" + hashlib.sha256(repr(manifest).encode()).hexdigest(), manifest,
            )
            with api.store.transaction() as conn:
                conn.execute("UPDATE runs SET status='Completed' WHERE id=?", (run["id"],))
                conn.execute("UPDATE tasks SET status='Succeeded', active_run_id=NULL WHERE id=?", (task["id"],))

            result = api.dispatch("POST", f"/api/v2/tasks/{task['id']}/tool-proposals", {
                "changeset_id": changeset["id"], "artifact_key": "untracked-0",
                "name": "production_tool", "description": "production review queue", "params": [],
            })

            self.assertEqual(201, result.status)
            self.assertEqual(["production_tool"], [item["name"] for item in user_tools.list_pending()])
            self.assertEqual(before_user_tools, tools._USER_TOOLS)
            self.assertFalse((state_dir / "tasking" / "user_tools").exists())
            self.assertTrue((state_dir / "user_tools" / "pending" / "production_tool.json").is_file())


if __name__ == "__main__":
    unittest.main()
