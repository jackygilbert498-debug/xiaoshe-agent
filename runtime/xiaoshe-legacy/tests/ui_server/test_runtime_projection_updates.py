"""Runtime projection delivery through the live UI Session boundary."""
from __future__ import annotations

import tempfile
import unittest
import uuid
import subprocess
import time
import threading
import builtins
import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from harness import config, ui_bus, ui_server, ui_state
from harness.runtime_events import RuntimeEvent, RuntimeEventSinkError, to_public_dict
from harness.runtime_factory import RuntimeSessionFactory
from harness.runtime_session import RuntimeIdentity, RuntimeOutcome, RuntimePolicySnapshot, RuntimeSession
from harness.task_model import CreateTask, EnqueueTask, ReviewPlan
from harness.task_queue import TaskQueue
from harness.run_lease import RunLeaseService
from harness.verification_model import normalize_profile, profile_checksum
from harness.verification_trust import VerificationTrustStore


def _event(*, runtime_id: str, run_id: str, sequence: int,
           event_type: str, payload: dict[str, object]) -> RuntimeEvent:
    return RuntimeEvent(
        schema_version=1,
        event_id=str(uuid.uuid4()),
        event_type=event_type,
        occurred_at=f"2026-08-16T00:00:{sequence:02d}.000Z",
        runtime_id=runtime_id,
        task_id="tsk_ui_projection",
        run_id=run_id,
        source="worker",
        seq=sequence,
        payload=payload,
    )


def _runtime_session() -> RuntimeSession:
    return RuntimeSession(
        identity=RuntimeIdentity(
            "runtime-new", "worker", project_id="project-ui", task_id="tsk_ui_projection", run_id="run-new",
        ),
        policy=RuntimePolicySnapshot(
            model_id="model-ui", plan_revision_id="plan-ui", workspace_id="workspace-ui",
            permission_mode="collaborate", sandbox_enabled=False, network_mode="off",
            heartbeat_enabled=False, unattended=True, budget={"tool_calls": 1},
            capability_digest="sha256:" + "1" * 64,
        ),
        runner=lambda _value: RuntimeOutcome("success"),
    )


class RuntimeProjectionUpdateTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        root = Path(self._temp.name)
        self.state_dir = root / ".state"
        self.state_dir.mkdir()
        self.ctx = {
            "todos": [], "memory_file": root / "memory.json", "_interactive": True,
            "_persistent_approved": set(), "_vision_pending": [], "_notes": [],
            "_denied_calls": 0, "session_id": "projection-ui",
        }
        ui_bus.init(self.ctx, "projection-ui", self.state_dir, snapshot_fn=ui_state.collect_dirty)
        ui_bus.bind_ctx(self.ctx)
        self.addCleanup(ui_bus.close_all_pending, "test-teardown")
        self.addCleanup(ui_bus.shutdown)
        tasking = mock.patch.object(config, "tasking_mode", return_value="on")
        tasking.start()
        self.addCleanup(tasking.stop)
        self.session = ui_server.UISession(
            self.ctx, "projection-ui", [], self.state_dir / "session.jsonl", self.state_dir,
            model_fn=lambda *_args, **_kwargs: {"role": "assistant", "content": "ok"},
        )

    def _history_line(self, event: RuntimeEvent) -> bytes:
        return (json.dumps(to_public_dict(event), sort_keys=True) + "\n").encode("utf-8")

    def _write_history(self, *records: bytes):
        sink = self.session.runtime_event_sink._sink
        sink.path.parent.mkdir(parents=True, exist_ok=True)
        sink.path.write_bytes(b"".join(records))
        return sink

    def _assert_history_corruption_fails_closed(self, code: str, *records: bytes) -> None:
        sink = self._write_history(*records)
        with self.assertRaises(RuntimeEventSinkError) as raised:
            sink.read_strict()
        self.assertEqual("RUNTIME_EVENT_HISTORY_UNREADABLE", raised.exception.code)
        self.assertIn(code, [item.code for item in sink.diagnostics])

        subscriber = ui_bus.subscribe()
        self.addCleanup(ui_bus.unsubscribe, subscriber)
        trigger = _event(
            runtime_id=f"runtime-{code}", run_id=f"run-{code}", sequence=9,
            event_type="runtime.finished", payload={"status": "success"},
        )
        self.session._on_runtime_event_committed(trigger)
        envelope = subscriber.get(timeout=1)
        self.assertEqual("runtime.projection.error", envelope["type"])
        self.assertEqual("projection_unavailable", envelope["payload"].get("code"))
        self.assertEqual("projection_unavailable", self.session.runtime_projection_view()["error"]["code"])

    def _queue_projection_task(self, directory_name: str):
        root = Path(self._temp.name) / directory_name
        root.mkdir()
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        (root / "a.py").write_text("x=1\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(root), "add", "a.py"], check=True)
        subprocess.run(["git", "-C", str(root), "-c", "user.name=test", "-c", "user.email=test@example.invalid",
                        "commit", "-qm", "base"], check=True)
        api = self.session.task_api
        project = api.store.create_project("projection-e2e", root)
        task = api.engine.create_task(CreateTask(project["id"], "projection", "prove projection", ("proof",)))
        plan = api.engine.propose_plan(task["id"], {
            "objective": "prove projection", "assumptions": [],
            "steps": [{"id": "work", "title": "work", "intent": "work", "files": ["a.py"],
                       "validation": ["proof"], "risk": "low", "depends_on": []}],
            "acceptance_mapping": {"proof": ["work"]}, "estimated_budget": {},
        }, "agent", task["version"])
        api.engine.review_plan(ReviewPlan(task["id"], plan["revision"], "approve", "ok",
                                          api.store.get_task(task["id"])["version"], "user"))
        ready = api.store.get_task(task["id"])
        reserved = api.store.reserve_workspace(task["id"], project["id"], "isolated", {"kind": "test"})
        api.store.activate_workspace(reserved["id"], root, "test:projection")
        TaskQueue(api.store).enqueue(EnqueueTask(
            ready["id"], "manual", "request:projection", 0, datetime.now(UTC),
            "p1", ready["version"],
        ))
        return root, api, project, task

    def _production_worker_factory(self):
        """Provide clean model resolution while delegating the real worker runner unchanged."""
        production_runner = self.session._run_background_task

        class Registry:
            def default_id(self) -> str:
                return "test:worker"

            def resolve(self, model_id: str):
                return SimpleNamespace(model=SimpleNamespace(id=model_id))

        class Factory:
            def create(self, identity, *, task=None, run=None, ctx=None, activation=None):
                factory = RuntimeSessionFactory(
                    model_registry=Registry(),
                    runner=lambda _value: RuntimeOutcome("success", value=production_runner(ctx)),
                )
                return factory.create(identity, task=task, run=run, ctx=ctx, activation=activation)

        return Factory()

    def test_committed_events_rebuild_and_push_one_latest_consistent_run(self) -> None:
        """A live commit updates slots without a reconnect or old-run mixing."""
        old_started = _event(
            runtime_id="runtime-old", run_id="run-old", sequence=1,
            event_type="runtime.started", payload={"mode": "on"},
        )
        old_verified = _event(
            runtime_id="runtime-old", run_id="run-old", sequence=2,
            event_type="verification.finished",
            payload={"verification_id": "verification-old", "status": "passed", "check_count": 1,
                     "failure_count": 0},
        )
        old_finished = _event(
            runtime_id="runtime-old", run_id="run-old", sequence=3,
            event_type="runtime.finished", payload={"status": "success"},
        )
        retried = _event(
            runtime_id="runtime-new", run_id="run-new", sequence=1,
            event_type="runtime.started", payload={"mode": "on"},
        )

        with mock.patch.object(ui_bus, "emit") as emit:
            for event in (old_started, old_verified, old_finished, retried):
                self.session.runtime_event_sink.append(event)

        view = self.session.runtime_projection_view()
        self.assertEqual("tsk_ui_projection", view["task_id"])
        self.assertEqual(["runtime-new"], [item["runtime_id"] for item in view["RuntimeSummaryProjection"]])
        self.assertTrue(view["TaskTimelineProjection"])
        self.assertEqual({"runtime-new"}, {
            item["runtime_id"] for item in view["TaskTimelineProjection"]
        })
        projection_pushes = [
            call for call in emit.call_args_list if call.args and call.args[0] == "runtime.projection"
        ]
        self.assertEqual(4, len(projection_pushes))
        self.assertEqual(view, projection_pushes[-1].args[1])

    def test_post_commit_transition_bridge_mirrors_into_the_live_projection_sink(self) -> None:
        """The registered Task transition observer reaches the same live push path."""
        before = {"id": "tsk_ui_projection", "status": "Running", "version": 2, "active_run_id": "run-new"}
        after = {"id": "tsk_ui_projection", "status": "Review", "version": 3, "active_run_id": None}
        runtime = _runtime_session()

        with mock.patch.object(config, "runtime_events_mode", return_value="on"), \
             mock.patch.object(self.session, "_runtime_projection_session", return_value=runtime), \
             mock.patch.object(ui_bus, "emit") as emit:
            self.session._mirror_committed_task_transition(before, after)
            self.assertTrue(self.session.runtime_event_mirror.drain(timeout=2))

        view = self.session.runtime_projection_view()
        self.assertEqual(["runtime-new"], [item["runtime_id"] for item in view["RuntimeSummaryProjection"]])
        self.assertTrue(any(call.args and call.args[0] == "runtime.projection" for call in emit.call_args_list))

    def test_rebuild_failure_envelope_advances_generation_and_identifies_the_unavailable_run(self) -> None:
        """A failed replay must prevent a stale completion from remaining authoritative in the fixed slots."""
        subscriber = ui_bus.subscribe()
        self.addCleanup(ui_bus.unsubscribe, subscriber)
        event = _event(
            runtime_id="runtime-error", run_id="run-error", sequence=9,
            event_type="runtime.finished", payload={"status": "success"},
        )
        with mock.patch.object(self.session.projection_registry, "rebuild", return_value=mock.Mock(ok=False)):
            self.session._on_runtime_event_committed(event)
        envelope = subscriber.get(timeout=1)

        self.assertEqual("runtime.projection.error", envelope["type"])
        self.assertIsInstance(envelope["payload"].get("generation"), int)
        self.assertEqual("tsk_ui_projection", envelope["payload"].get("task_id"))
        self.assertEqual("runtime-error", envelope["payload"].get("runtime_id"))
        self.assertEqual("run-error", envelope["payload"].get("run_id"))

    def test_event_log_read_failure_fails_closed_instead_of_publishing_an_empty_projection(self) -> None:
        """A lock or IO read failure must invalidate the fixed slots, not look like an empty stream."""
        subscriber = ui_bus.subscribe()
        self.addCleanup(ui_bus.unsubscribe, subscriber)
        event = _event(
            runtime_id="runtime-read-failed", run_id="run-read-failed", sequence=10,
            event_type="runtime.finished", payload={"status": "success"},
        )
        sink = self.session.runtime_event_sink._sink

        with mock.patch.object(sink, "_read_locked", side_effect=OSError("simulated read failure")):
            self.session._on_runtime_event_committed(event)

        envelope = subscriber.get(timeout=1)
        self.assertEqual("runtime.projection.error", envelope["type"])
        self.assertEqual("projection_unavailable", envelope["payload"].get("code"))
        self.assertEqual("runtime-read-failed", envelope["payload"].get("runtime_id"))
        self.assertEqual("projection_unavailable", self.session.runtime_projection_view()["error"]["code"])

    def test_strict_history_rejects_complete_corrupt_json_and_fails_closed_in_the_ui(self) -> None:
        """Skipping a complete corrupt JSON record could manufacture a safe-looking empty projection."""
        first = _event(
            runtime_id="runtime-invalid-json", run_id="run-invalid-json", sequence=1,
            event_type="runtime.started", payload={"mode": "on"},
        )
        self._assert_history_corruption_fails_closed("invalid_json", self._history_line(first), b"{not-json}\n")

    def test_strict_history_rejects_invalid_event_and_fails_closed_in_the_ui(self) -> None:
        """Skipping a JSON value that is not a RuntimeEvent could hide a missing fact from the slots."""
        first = _event(
            runtime_id="runtime-invalid-event", run_id="run-invalid-event", sequence=1,
            event_type="runtime.started", payload={"mode": "on"},
        )
        self._assert_history_corruption_fails_closed("invalid_event", self._history_line(first), b"[]\n")

    def test_strict_history_rejects_partial_tail_and_fails_closed_in_the_ui(self) -> None:
        """A truncated tail may contain completion evidence, so it cannot be replayed as a complete log."""
        first = _event(
            runtime_id="runtime-partial-tail", run_id="run-partial-tail", sequence=1,
            event_type="runtime.started", payload={"mode": "on"},
        )
        self._assert_history_corruption_fails_closed("partial_tail", self._history_line(first), b'{"event_id":')

    def test_strict_history_rejects_sequence_conflict_and_fails_closed_in_the_ui(self) -> None:
        """Dropping an out-of-order immutable fact could falsely preserve a completed projection."""
        first = _event(
            runtime_id="runtime-sequence-conflict", run_id="run-sequence-conflict", sequence=1,
            event_type="runtime.started", payload={"mode": "on"},
        )
        conflicting = _event(
            runtime_id="runtime-sequence-conflict", run_id="run-sequence-conflict", sequence=1,
            event_type="runtime.finished", payload={"status": "success"},
        )
        self._assert_history_corruption_fails_closed(
            "sequence_conflict", self._history_line(first), self._history_line(conflicting),
        )

    def test_strict_history_accepts_one_exact_duplicate_event_id_without_failing_closed(self) -> None:
        """An identical durable retry is one fact, whereas a differing duplicate ID remains unreadable."""
        event = _event(
            runtime_id="runtime-exact-duplicate", run_id="run-exact-duplicate", sequence=1,
            event_type="runtime.started", payload={"mode": "on"},
        )
        sink = self._write_history(self._history_line(event), self._history_line(event))

        self.assertEqual((event,), sink.read_strict())
        self.assertEqual((), sink.diagnostics)

        subscriber = ui_bus.subscribe()
        self.addCleanup(ui_bus.unsubscribe, subscriber)
        self.session._on_runtime_event_committed(event)
        envelope = subscriber.get(timeout=1)
        self.assertEqual("runtime.projection", envelope["type"])
        self.assertNotIn("error", self.session.runtime_projection_view())

    def test_strict_history_rejects_a_differing_duplicate_event_id_and_fails_closed_in_the_ui(self) -> None:
        """A reused ID with a changed immutable envelope is not the safe duplicate-retry exception."""
        first = _event(
            runtime_id="runtime-duplicate-conflict", run_id="run-duplicate-conflict", sequence=1,
            event_type="runtime.started", payload={"mode": "on"},
        )
        conflicting = to_public_dict(first)
        conflicting.update({
            "occurred_at": "2026-08-16T00:00:02.000Z", "seq": 2,
            "event_type": "runtime.finished", "payload": {"status": "success"},
        })
        conflicting_line = (json.dumps(conflicting, sort_keys=True) + "\n").encode("utf-8")
        self._assert_history_corruption_fails_closed(
            "duplicate_event_id", self._history_line(first), conflicting_line,
        )

    def test_replacing_a_projection_session_closes_the_old_transition_observer(self) -> None:
        """Replacing one task/run observer must release the previous TaskEngine subscription."""
        first = _runtime_session()
        replacement = RuntimeSession(identity=first.identity, policy=first.policy,
                                     runner=lambda _value: RuntimeOutcome("success"))
        store = self.session.task_api.store
        baseline = len(store._transition_observer_tokens)

        self.session._register_runtime_projection_session(first)
        first_engine = self.session._projection_runtime_engines[("tsk_ui_projection", "run-new")]
        self.session._register_runtime_projection_session(replacement)

        self.assertIsNone(first_engine._transition_observer_token)
        self.assertEqual(baseline + 1, len(store._transition_observer_tokens))
        self.session.stop_task_worker()
        self.assertEqual(baseline, len(store._transition_observer_tokens))

    def test_concurrent_projection_recovery_reuses_one_observer_and_stop_releases_it(self) -> None:
        """Concurrent recovery of one durable task/run must create exactly one transition observer."""
        first = _runtime_session()
        second = RuntimeSession(identity=first.identity, policy=first.policy,
                                runner=lambda _value: RuntimeOutcome("success"))
        store = self.session.task_api.store
        baseline = len(store._transition_observer_tokens)
        calls, call_lock = [], threading.Lock()
        start = threading.Barrier(2)
        results = []

        def recover(*_args):
            with call_lock:
                calls.append(None)
                runtime = first if len(calls) == 1 else second
            time.sleep(0.05)
            return runtime

        def worker() -> None:
            start.wait(timeout=1)
            results.append(self.session._registered_runtime_projection_session("tsk_ui_projection", "run-new"))

        with mock.patch.object(self.session, "_runtime_projection_session", side_effect=recover):
            threads = [threading.Thread(target=worker) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=2)

        self.assertEqual(1, len(calls))
        self.assertEqual(2, len(results))
        self.assertIs(results[0], results[1])
        self.assertEqual(baseline + 1, len(store._transition_observer_tokens))
        self.session.stop_task_worker()
        self.assertEqual(baseline, len(store._transition_observer_tokens))

    def test_restarted_session_snapshot_uses_a_fresh_projection_server_epoch(self) -> None:
        """A reconnect can distinguish a new server generation from stale WS frames."""
        before = self.session.snapshot_payload()["runtime_projections"]
        restarted = ui_server.UISession(
            self.ctx, "projection-ui", [], self.state_dir / "session.jsonl", self.state_dir,
            model_fn=lambda *_args, **_kwargs: {"role": "assistant", "content": "ok"},
        )
        self.addCleanup(restarted.stop_task_worker)
        after = restarted.snapshot_payload()["runtime_projections"]

        self.assertIsInstance(before["server_epoch"], str)
        self.assertTrue(before["server_epoch"])
        self.assertIsInstance(after["server_epoch"], str)
        self.assertNotEqual(before["server_epoch"], after["server_epoch"])

    def test_review_restart_verification_and_completion_recover_the_same_durable_run_projection(self) -> None:
        """A restarted UI lazily recovers the reviewed run before verification and completion mirror it."""
        root, api, project, task = self._queue_projection_task("project-restart")
        self.addCleanup(self.session.stop_task_worker)
        self.session.runtime_factory = self._production_worker_factory()
        model_calls = []
        self.session.model_fn = lambda messages, tools=None: (model_calls.append(messages) or {
            "role": "assistant", "content": "background production runner completed",
        })
        with mock.patch.object(config, "runtime_session_mode", return_value="on"), \
             mock.patch.object(config, "runtime_events_mode", return_value="on"):
            self.session.start_task_worker()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and api.store.get_task(task["id"])["status"] != "Review":
                time.sleep(0.02)
            self.assertEqual("Review", api.store.get_task(task["id"])["status"])
            self.assertTrue(model_calls)
            run_id = api.store.current_changeset(task["id"])["run_id"]
            self.session.stop_task_worker()

            restarted = ui_server.UISession(
                self.ctx, "projection-ui", [], self.state_dir / "session.jsonl", self.state_dir,
                model_fn=lambda *_args, **_kwargs: {"role": "assistant", "content": "ok"},
            )
            self.addCleanup(restarted.stop_task_worker)
            api = restarted.task_api
            self.assertEqual({}, restarted._projection_runtime_sessions)
            subscriber = ui_bus.subscribe()
            self.addCleanup(ui_bus.unsubscribe, subscriber)
            changeset = api.store.current_changeset(task["id"])
            verifying, _, _ = api.engine.apply_review_decision(
                task_id=task["id"], changeset_id=changeset["id"], request_id="review-projection-restart",
                decision="approve", feedback="ok", diff_hash=changeset["diff_hash"],
                workspace_version=changeset["workspace_version"],
                expected_version=api.store.get_task(task["id"])["version"], actor="user",
            )
            profile = normalize_profile({"name": "projection", "checks": [{
                "id": "unit", "name": "unit", "argv": ["python", "-c", "print(1)"], "cwd": ".",
                "timeout_seconds": 30, "env_allowlist": ["PATH"], "network": "deny", "required": True,
            }]}, root)
            VerificationTrustStore(api.store).approve(
                project["id"], profile,
                {"a.py": __import__("hashlib").sha256((root / "a.py").read_bytes()).hexdigest()}, "user",
            )
            verified = api.dispatch("POST", f"/api/v2/tasks/{task['id']}/verifications", {
                "profile_checksum": profile_checksum(profile), "actor": "user", "expected_version": verifying["version"],
            })
            self.assertEqual(202, verified.status)
            completed = api.dispatch("POST", f"/api/v2/tasks/{task['id']}/complete", {
                "actor": "user", "expected_version": api.store.get_task(task["id"])["version"],
                "proof_id": verified.body["proof"]["id"],
            })
            self.assertEqual(200, completed.status)
            self.assertTrue(restarted.runtime_event_mirror.drain(timeout=3))
            view = restarted.runtime_projection_view()

        self.assertEqual("Succeeded", completed.body["task"]["status"])
        self.assertIn((task["id"], run_id), restarted._projection_runtime_sessions)
        self.assertEqual(1, len(view["RuntimeSummaryProjection"]))
        summary = view["RuntimeSummaryProjection"][0]
        self.assertEqual("success", summary["status"])
        self.assertEqual("succeeded", summary["task_state"])
        self.assertTrue(any(item["event_type"] == "verification.finished"
                            for item in view["TaskTimelineProjection"]))
        self.assertEqual({summary["runtime_id"]}, {
            item["runtime_id"] for item in view["TaskTimelineProjection"]
        })
        self.assertEqual({run_id}, {item["run_id"] for item in view["TaskTimelineProjection"]})

    def test_worker_taskapi_verification_and_completion_push_one_verified_run_without_direct_sink_append(self) -> None:
        """The live worker, verification route, and completion route must drive one WS projection identity."""
        root = Path(self._temp.name) / "project"
        root.mkdir()
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        (root / "a.py").write_text("x=1\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(root), "add", "a.py"], check=True)
        subprocess.run(["git", "-C", str(root), "-c", "user.name=test", "-c", "user.email=test@example.invalid",
                        "commit", "-qm", "base"], check=True)
        api = self.session.task_api
        project = api.store.create_project("projection-e2e", root)
        task = api.engine.create_task(CreateTask(project["id"], "projection", "prove projection", ("proof",)))
        plan = api.engine.propose_plan(task["id"], {
            "objective": "prove projection", "assumptions": [],
            "steps": [{"id": "work", "title": "work", "intent": "work", "files": ["a.py"],
                       "validation": ["proof"], "risk": "low", "depends_on": []}],
            "acceptance_mapping": {"proof": ["work"]}, "estimated_budget": {},
        }, "agent", task["version"])
        api.engine.review_plan(ReviewPlan(task["id"], plan["revision"], "approve", "ok",
                                          api.store.get_task(task["id"])["version"], "user"))
        ready = api.store.get_task(task["id"])
        reserved = api.store.reserve_workspace(task["id"], project["id"], "isolated", {"kind": "test"})
        api.store.activate_workspace(reserved["id"], root, "test:projection")
        TaskQueue(api.store).enqueue(EnqueueTask(ready["id"], "manual", "request:projection", 0,
                                                 __import__("datetime").datetime.now(__import__("datetime").UTC),
                                                 "p1", ready["version"]))
        subscriber = ui_bus.subscribe()
        self.addCleanup(ui_bus.unsubscribe, subscriber)
        self.session.runtime_factory = self._production_worker_factory()
        model_result = root / "production-runner-result.txt"
        def production_model(_messages, tools=None):
            model_result.write_text("ran", encoding="utf-8")
            return {
                "role": "assistant", "content": "background production runner completed",
            }
        self.session.model_fn = production_model
        original_import = builtins.__import__

        def import_without_untracked_project_memory(name, globals=None, locals=None, fromlist=(), level=0):
            if (name == "project_memory_retrieval" and level == 1
                    and isinstance(globals, dict) and globals.get("__package__") == "harness"):
                raise ModuleNotFoundError("untracked project memory extension absent", name="harness.project_memory_retrieval")
            return original_import(name, globals, locals, fromlist, level)

        with mock.patch.object(config, "runtime_session_mode", return_value="on"), \
             mock.patch.object(config, "runtime_events_mode", return_value="on"), \
             mock.patch("builtins.__import__", side_effect=import_without_untracked_project_memory):
            self.session.start_task_worker()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and api.store.get_task(task["id"])["status"] != "Review":
                time.sleep(0.02)
            self.assertEqual("Review", api.store.get_task(task["id"])["status"])
            self.assertEqual("ran", model_result.read_text(encoding="utf-8"))
            changeset = api.store.current_changeset(task["id"])
            verifying, _, _ = api.engine.apply_review_decision(
                task_id=task["id"], changeset_id=changeset["id"], request_id="review-projection",
                decision="approve", feedback="ok", diff_hash=changeset["diff_hash"],
                workspace_version=changeset["workspace_version"],
                expected_version=api.store.get_task(task["id"])["version"], actor="user")
            profile = normalize_profile({"name": "projection", "checks": [{
                "id": "unit", "name": "unit", "argv": ["python", "-c", "print(1)"], "cwd": ".",
                "timeout_seconds": 30, "env_allowlist": ["PATH"], "network": "deny", "required": True,
            }]}, root)
            VerificationTrustStore(api.store).approve(project["id"], profile,
                                                       {"a.py": __import__("hashlib").sha256((root / "a.py").read_bytes()).hexdigest()},
                                                       "user")
            verified = api.dispatch("POST", f"/api/v2/tasks/{task['id']}/verifications", {
                "profile_checksum": profile_checksum(profile), "actor": "user", "expected_version": verifying["version"],
            })
            self.assertEqual(202, verified.status)
            completed = api.dispatch("POST", f"/api/v2/tasks/{task['id']}/complete", {
                "actor": "user", "expected_version": api.store.get_task(task["id"])["version"],
                "proof_id": verified.body["proof"]["id"],
            })
            self.assertEqual(200, completed.status)
            self.assertTrue(self.session.runtime_event_mirror.drain(timeout=3))
            view = self.session.runtime_projection_view()
            envelopes = []
            while not subscriber.empty():
                envelopes.append(subscriber.get_nowait())
            self.session.stop_task_worker()

        self.assertEqual("Succeeded", completed.body["task"]["status"])
        self.assertEqual(1, len(view["RuntimeSummaryProjection"]))
        summary = view["RuntimeSummaryProjection"][0]
        self.assertEqual("success", summary["status"])
        self.assertEqual("succeeded", summary["task_state"])
        self.assertEqual({"runtime.started", "runtime.finished", "verification.finished"}, {
            item["event_type"] for item in view["TaskTimelineProjection"]
            if item["event_type"] in {"runtime.started", "runtime.finished", "verification.finished"}
        })
        self.assertEqual({summary["runtime_id"]}, {
            item["runtime_id"] for item in view["TaskTimelineProjection"]
        })
        self.assertEqual({summary["run_id"]}, {
            item["run_id"] for item in view["TaskTimelineProjection"]
        })
        pushes = [item for item in envelopes if item["type"] == "runtime.projection"]
        self.assertTrue(pushes)
        self.assertEqual(view, pushes[-1]["payload"])


if __name__ == "__main__":
    unittest.main()
