"""Plan02 batch acceptance through the real Task v2 state machine.

Every case owns a temporary Git repository, TaskStore, artifact store, and
canonical user-tools directory.  No production ``.state`` or provider config
is read or written.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

from harness import tools, user_tools
from harness.artifact_store import ArtifactRef, ArtifactStore
from harness.task_api import HTTPResult, TaskAPI
from harness.task_engine import TaskEngine
from harness.task_model import FinishRun, RunStatus
from harness.task_store import TaskStore


@dataclass
class CompletedTask:
    temp: tempfile.TemporaryDirectory
    root: Path
    state_dir: Path
    user_tools_base: Path
    store: TaskStore
    engine: TaskEngine
    api: TaskAPI
    project: dict
    task: dict
    run: dict
    changeset: dict
    trace: list[tuple[str, int, str]]


class Plan02BatchAcceptanceTests(unittest.TestCase):
    maxDiff = None

    @staticmethod
    def _expect(result: HTTPResult, status: int) -> HTTPResult:
        if result.status != status:
            raise AssertionError(f"expected HTTP {status}, got {result.status}: {result.body}")
        return result

    @staticmethod
    def _task_status(result: HTTPResult) -> str:
        return str(result.body["task"]["status"])

    def _completed_task(self, candidate_name: str) -> CompletedTask:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        base = Path(temp.name)
        root = base / "真实 Git 工作区 空格"
        state_dir = base / "product" / ".state"
        root.mkdir(parents=True)
        (root / ".xiaoshe").mkdir()
        subprocess.run(["git", "init", "-q", str(root)], check=True)

        verification_profile = {
            "name": "Plan02 completed-script acceptance",
            "risk_scope": "low",
            "checks": [{
                "id": "script-present",
                "name": "脚本存在且为 UTF-8",
                "argv": [
                    sys.executable,
                    "-B",
                    "-c",
                    "from pathlib import Path; "
                    f"p=Path({candidate_name!r}); "
                    "raise SystemExit(0 if p.read_text(encoding='utf-8') else 1)",
                ],
                "cwd": ".",
                "timeout_seconds": 30,
                "env_allowlist": ["PATH"],
                "network": "deny",
                "required": True,
            }],
        }
        (root / ".xiaoshe" / "verification.json").write_text(
            json.dumps(verification_profile, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        (root / "README.md").write_text("Plan02 acceptance baseline\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(root), "add", "."], check=True)
        subprocess.run(
            [
                "git", "-C", str(root), "-c", "user.name=Plan02 Acceptance",
                "-c", "user.email=plan02@example.invalid", "commit", "-qm", "baseline",
            ],
            check=True,
        )

        store = TaskStore(state_dir / "tasking" / "tasks.db")
        engine = TaskEngine(store)
        artifacts = ArtifactStore(state_dir / "review-artifacts")
        user_tools_base = state_dir / "user_tools"
        api = TaskAPI(
            store,
            engine,
            workspace_root=root,
            artifact_store=artifacts,
            user_tools_base=user_tools_base,
        )
        trace: list[tuple[str, int, str]] = []

        created_project = self._expect(api.dispatch("POST", "/api/v2/projects", {
            "name": "Plan02 batch acceptance",
            "root": str(root),
        }), 201)
        project = created_project.body["project"]
        trace.append(("project.create", created_project.status, "Created"))

        created_task = self._expect(api.dispatch("POST", "/api/v2/tasks", {
            "project_id": project["id"],
            "title": "完成后保存脚本工具",
            "goal": "生成并验证一个可审查脚本",
            "acceptance": ["脚本可读"],
        }), 201)
        task = created_task.body["task"]
        trace.append(("task.create", created_task.status, task["status"]))

        plan_body = {
            "objective": "生成并验证脚本",
            "assumptions": ["只写临时工作区"],
            "steps": [{
                "id": "implement",
                "title": "生成脚本",
                "intent": "在临时 Git 工作区新增脚本",
                "files": [candidate_name],
                "validation": ["运行受信验证配置"],
                "risk": "low",
                "depends_on": [],
            }],
            "acceptance_mapping": {"脚本可读": ["implement"]},
            "estimated_budget": {"minutes": 5, "actions": 4},
        }
        proposed = self._expect(api.dispatch("POST", f"/api/v2/tasks/{task['id']}/plans", {
            "body": plan_body,
            "actor": "acceptance-agent",
            "expected_version": task["version"],
        }), 201)
        task = proposed.body["task"]
        trace.append(("plan.propose", proposed.status, task["status"]))

        approved = self._expect(api.dispatch(
            "POST",
            f"/api/v2/tasks/{task['id']}/plans/{proposed.body['plan']['revision']}/review",
            {
                "decision": "approve",
                "feedback": "验收批准",
                "actor": "acceptance-user",
                "expected_version": task["version"],
            },
        ), 200)
        task = approved.body["task"]
        trace.append(("plan.approve", approved.status, task["status"]))

        started = self._expect(api.dispatch("POST", f"/api/v2/tasks/{task['id']}/runs", {
            "actor": "acceptance-agent",
            "expected_version": task["version"],
        }), 201)
        task, run = started.body["task"], started.body["run"]
        trace.append(("run.start", started.status, task["status"]))

        candidate = root / candidate_name
        candidate.parent.mkdir(parents=True, exist_ok=True)
        candidate.write_text("Write-Output 'Plan02 完成工具'\n", encoding="utf-8")

        # This is the same domain entry used by TaskWorker when a real run
        # completes.  It captures Git bytes before transitioning to Review.
        task, run = engine.finish_run(FinishRun(
            run["id"], task["version"], "acceptance-worker", RunStatus.COMPLETED,
        ))
        trace.append(("run.finish", 200, task["status"]))
        changeset = store.current_changeset(task["id"])
        self.assertIsNotNone(changeset)

        captured = api.dispatch("POST", f"/api/v2/tasks/{task['id']}/changesets", {
            "run_id": run["id"],
        })
        self.assertIn(captured.status, {200, 201})
        self.assertEqual(changeset["id"], captured.body["changeset"]["id"])
        changeset = captured.body["changeset"]
        trace.append(("changeset.capture", captured.status, task["status"]))

        reviewed = self._expect(api.dispatch("POST", f"/api/v2/tasks/{task['id']}/reviews", {
            "changeset_id": changeset["id"],
            "diff_hash": changeset["diff_hash"],
            "workspace_version": changeset["workspace_version"],
            "decision": "approve",
            "feedback": "冻结产物与任务目标一致",
            "request_id": f"review-{task['id']}",
            "actor": "acceptance-user",
            "expected_version": task["version"],
        }), 200)
        task = reviewed.body["task"]
        trace.append(("review.approve", reviewed.status, task["status"]))

        profiles = self._expect(api.dispatch(
            "GET", f"/api/v2/projects/{project['id']}/verification-profiles",
        ), 200)
        profile = next(
            item for item in profiles.body["candidates"]
            if item["name"] == "小蛇验证配置" and item["profile"] is not None
        )
        trace.append(("verification.discover", profiles.status, task["status"]))
        trusted = self._expect(api.dispatch(
            "POST",
            f"/api/v2/projects/{project['id']}/verification-profiles/{profile['checksum']}/approve",
            {"actor": "acceptance-user"},
        ), 200)
        trace.append(("verification.trust", trusted.status, task["status"]))

        verified = self._expect(api.dispatch("POST", f"/api/v2/tasks/{task['id']}/verifications", {
            "profile_checksum": profile["checksum"],
            "actor": "acceptance-user",
            "expected_version": task["version"],
        }), 202)
        self.assertEqual("passed", verified.body["verification"]["status"])
        self.assertTrue(verified.body["decision"]["allowed"])
        self.assertIsNotNone(verified.body["proof"])
        task = verified.body["task"]
        trace.append(("verification.run", verified.status, task["status"]))

        completed = self._expect(api.dispatch("POST", f"/api/v2/tasks/{task['id']}/complete", {
            "proof_id": verified.body["proof"]["id"],
            "actor": "acceptance-user",
            "expected_version": task["version"],
        }), 200)
        task = completed.body["task"]
        trace.append(("task.complete", completed.status, task["status"]))
        self.assertEqual("Succeeded", task["status"])

        return CompletedTask(
            temp, root, state_dir, user_tools_base, store, engine, api,
            project, task, run, changeset, trace,
        )

    @staticmethod
    def _proposal_body(context: CompletedTask, name: str) -> dict:
        return {
            "changeset_id": context.changeset["id"],
            "artifact_key": "untracked-0",
            "name": name,
            "description": "Plan02 batch acceptance proposal",
            "params": [],
        }

    def _assert_no_tool_state(self, context: CompletedTask) -> None:
        self.assertEqual([], user_tools.list_pending(context.user_tools_base))
        self.assertEqual([], user_tools.list_active(context.user_tools_base))
        self.assertFalse((context.user_tools_base / "active").exists())
        self.assertFalse((context.user_tools_base / "manifest.json").exists())

    def test_real_completion_chain_creates_canonical_pending_only(self):
        before_loaded = dict(tools._USER_TOOLS)
        context = self._completed_task("tools/报告工具.ps1")
        self.assertEqual([
            ("project.create", 201, "Created"),
            ("task.create", 201, "Draft"),
            ("plan.propose", 201, "AwaitingPlanApproval"),
            ("plan.approve", 200, "Ready"),
            ("run.start", 201, "Running"),
            ("run.finish", 200, "Review"),
            ("changeset.capture", 200, "Review"),
            ("review.approve", 200, "Verifying"),
            ("verification.discover", 200, "Verifying"),
            ("verification.trust", 200, "Verifying"),
            ("verification.run", 202, "Verifying"),
            ("task.complete", 200, "Succeeded"),
        ], context.trace)

        candidates = self._expect(context.api.dispatch(
            "GET", f"/api/v2/tasks/{context.task['id']}/tool-proposals",
        ), 200)
        self.assertEqual([{
            "artifact_key": "untracked-0", "display_name": "报告工具.ps1",
        }], candidates.body["candidates"])

        proposed = self._expect(context.api.dispatch(
            "POST",
            f"/api/v2/tasks/{context.task['id']}/tool-proposals",
            self._proposal_body(context, "plan02_report_tool"),
        ), 201)
        self.assertEqual("pending", proposed.body["proposal"]["status"])
        self.assertEqual(["plan02_report_tool"], [
            item["name"] for item in user_tools.list_pending(context.user_tools_base)
        ])
        self.assertFalse((context.state_dir / "tasking" / "user_tools").exists())
        self.assertEqual([], user_tools.list_active(context.user_tools_base))
        self.assertFalse((context.user_tools_base / "manifest.json").exists())
        self.assertEqual(before_loaded, tools._USER_TOOLS)

    def test_completed_python_file_has_no_candidate_and_post_fails_closed(self):
        context = self._completed_task("tools/not-a-tool.py")
        candidates = self._expect(context.api.dispatch(
            "GET", f"/api/v2/tasks/{context.task['id']}/tool-proposals",
        ), 200)
        self.assertEqual([], candidates.body["candidates"])
        rejected = context.api.dispatch(
            "POST",
            f"/api/v2/tasks/{context.task['id']}/tool-proposals",
            self._proposal_body(context, "plan02_python_rejected"),
        )
        self.assertEqual(400, rejected.status)
        self.assertEqual("TASK_ARTIFACT_NOT_TEXT", rejected.body["error"]["code"])
        self._assert_no_tool_state(context)

    def test_tampered_frozen_artifact_has_no_candidate_and_post_fails_closed(self):
        context = self._completed_task("tools/tamper-target.ps1")
        raw_ref = context.changeset["manifest"]["artifacts"]["untracked"][0]["content_artifact"]
        ref = ArtifactRef(**raw_ref)
        artifact_path = context.api.artifact_store.base / ref.relative_path
        artifact_path.write_bytes(b"tampered acceptance bytes")

        candidates = self._expect(context.api.dispatch(
            "GET", f"/api/v2/tasks/{context.task['id']}/tool-proposals",
        ), 200)
        self.assertEqual([], candidates.body["candidates"])
        rejected = context.api.dispatch(
            "POST",
            f"/api/v2/tasks/{context.task['id']}/tool-proposals",
            self._proposal_body(context, "plan02_tamper_rejected"),
        )
        self.assertEqual(400, rejected.status)
        self.assertEqual("TASK_ARTIFACT_HASH_MISMATCH", rejected.body["error"]["code"])
        self._assert_no_tool_state(context)

    def test_post_completion_workspace_drift_marks_stale_and_leaks_no_internal_evidence(self):
        context = self._completed_task("tools/drift-target.ps1")
        (context.root / "late-drift.txt").write_text("drift\n", encoding="utf-8")

        candidates = context.api.dispatch(
            "GET", f"/api/v2/tasks/{context.task['id']}/tool-proposals",
        )
        self.assertEqual(409, candidates.status)
        self.assertEqual("REVIEW_CHANGESET_STALE", candidates.body["error"]["code"])
        self.assertIsNotNone(context.store.get_changeset(context.changeset["id"])["stale_at"])
        public = json.dumps(candidates.body, ensure_ascii=False).lower()
        for forbidden in (
            "wsv", "sha", "hash", "path", "source", "exception",
            str(context.root).lower(), str(context.api.artifact_store.base).lower(),
        ):
            self.assertNotIn(forbidden, public)

        rejected = context.api.dispatch(
            "POST",
            f"/api/v2/tasks/{context.task['id']}/tool-proposals",
            self._proposal_body(context, "plan02_drift_rejected"),
        )
        self.assertEqual(409, rejected.status)
        self.assertEqual("REVIEW_CHANGESET_STALE", rejected.body["error"]["code"])
        rejected_public = json.dumps(rejected.body, ensure_ascii=False).lower()
        for forbidden in (
            "wsv", "sha", "hash", "path", "source", "exception",
            str(context.root).lower(), str(context.api.artifact_store.base).lower(),
        ):
            self.assertNotIn(forbidden, rejected_public)
        self._assert_no_tool_state(context)


if __name__ == "__main__":
    unittest.main()
