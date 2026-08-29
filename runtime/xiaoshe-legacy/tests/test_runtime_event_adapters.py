"""Fixed-fixture contracts for legacy RuntimeEvent shadow adapters."""
from __future__ import annotations

import json
import multiprocessing
import os
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

from harness import config, effects
from harness.runtime_events import JsonlRuntimeEventSink, RuntimeEventSinkError, validate_event
from harness.runtime_session import RuntimeIdentity, RuntimeOutcome, RuntimePolicySnapshot, RuntimeSession
from harness.task_engine import TaskEngine
from harness.task_model import (AnswerQuestion, AskQuestion, CreateTask, FinishRun,
                                ReviewPlan, RunStatus, StartRun, TaskStatus)
from harness.task_store import TaskStore
from harness.verification_model import mirror_verification_result
from harness.runtime_event_adapters import (
    RuntimeEventMirror,
    effect_event,
    task_transition_event,
    verification_event,
)


_FIXTURES = Path(__file__).with_name("fixtures") / "runtime_events" / "legacy_v1.json"


class _BarrierJsonlSink(JsonlRuntimeEventSink):
    """Hold competing writers just before their inherited locked allocation."""

    def __init__(self, path: Path, barrier: Path) -> None:
        super().__init__(path)
        self.barrier = barrier

    def _wait_for_peer(self) -> None:
        self.barrier.mkdir(parents=True, exist_ok=True)
        (self.barrier / f"{os.getpid()}.ready").touch()
        deadline = time.monotonic() + 10
        while len(tuple(self.barrier.glob("*.ready"))) < 2:
            if time.monotonic() >= deadline:
                raise RuntimeError("test writer barrier timed out")
            time.sleep(0.01)

    def append(self, event):
        self._wait_for_peer()
        return super().append(event)

    def append_allocated(self, runtime_id, event_id, build):
        self._wait_for_peer()
        return super().append_allocated(runtime_id, event_id, build)


def _concurrent_effect_writer(path: str, barrier: str, effect_id: str, result_queue) -> None:
    """Spawn target for the fixed multi-process allocation regression."""
    os.environ["XIAOSHE_RUNTIME_EVENTS"] = "on"
    session = _session(session_id="runtime-task3-fixed")
    record = dict(_fixture()["reversible_effect"])
    record["id"] = effect_id
    mirror = RuntimeEventMirror(
        sink=_BarrierJsonlSink(Path(path), Path(barrier)),
        diagnostics_path=Path(path).with_name(f"{effect_id}.diagnostics.jsonl"),
    )
    result_queue.put(mirror.mirror_effect(record, session) is not None)


def _fixture() -> dict[str, object]:
    return json.loads(_FIXTURES.read_text(encoding="utf-8"))


def _session(*, task_id: str = "tsk_alpha", run_id: str | None = "run_alpha",
             session_id: str | None = None) -> RuntimeSession:
    return RuntimeSession(
        identity=RuntimeIdentity(
            session_id=session_id or f"runtime-task3-{uuid.uuid4().hex}",
            entrypoint="worker",
            project_id="project-task3",
            task_id=task_id,
            run_id=run_id,
        ),
        policy=RuntimePolicySnapshot(
            model_id="model-task3",
            plan_revision_id="plan-task3",
            workspace_id="workspace-task3",
            permission_mode="collaborate",
            sandbox_enabled=True,
            network_mode="off",
            heartbeat_enabled=False,
            unattended=False,
            budget={"tool_calls": 2},
            capability_digest="sha256:" + "3" * 64,
        ),
        runner=lambda _input: RuntimeOutcome("success"),
    )


class RuntimeEventAdapterContractTests(unittest.TestCase):
    def test_task_transition_fixture_maps_without_mutating_legacy_records(self):
        """Removing legacy status normalization would make this fixed transition invalid."""
        fixture = _fixture()["task_transition"]
        before = dict(fixture["before"])
        after = dict(fixture["after"])

        event = task_transition_event(before, after, _session(), 1)

        self.assertEqual("task.state_changed", event.event_type)
        self.assertEqual("tsk_alpha", event.task_id)
        self.assertEqual("run_alpha", event.run_id)
        self.assertEqual({
            "previous_state": "ready",
            "state": "running",
            "reason_code": "legacy_task_transition",
        }, dict(event.payload))
        self.assertEqual((), validate_event(event.__dict__))
        self.assertEqual(fixture["before"], before)
        self.assertEqual(fixture["after"], after)

    def test_effect_fixtures_keep_reversible_and_irreversible_semantics_distinct(self):
        """Same successful outcome must retain the reversibility decision in the event."""
        fixture = _fixture()
        reversible = dict(fixture["reversible_effect"])
        irreversible = dict(fixture["irreversible_success_effect"])

        success = effect_event(reversible, _session(), 1)
        irreversible_success = effect_event(irreversible, _session(), 2)

        self.assertEqual(("action.finished", {
            "action_id": "eff_reversible", "status": "success", "irreversible": False,
        }),
                         (success.event_type, dict(success.payload)))
        self.assertEqual(("action.finished", {
            "action_id": "eff_irreversible_success", "status": "success", "irreversible": True,
        }), (irreversible_success.event_type, dict(irreversible_success.payload)))
        self.assertEqual(success.payload["status"], irreversible_success.payload["status"])
        self.assertNotEqual(success.payload["irreversible"], irreversible_success.payload["irreversible"])
        self.assertFalse(reversible["irreversible"])
        self.assertTrue(irreversible["irreversible"])

    def test_explicit_unknown_effect_outcome_maps_to_non_final_runtime_event(self):
        record = dict(_fixture()["reversible_effect"])
        record.update({"ok": None, "outcome_state": "outcome_unknown"})

        event = effect_event(record, _session(), 1)

        self.assertEqual(("action.outcome_unknown", {
            "action_id": "eff_reversible", "reason_code": "effect_outcome_unknown",
            "reconciliation_required": True,
        }), (event.event_type, dict(event.payload)))
        self.assertEqual((), validate_event(event.__dict__))

    def test_legacy_ok_or_error_without_outcome_state_cannot_be_finalized(self):
        for source in ("reversible_effect", "irreversible_effect"):
            with self.subTest(source=source):
                record = dict(_fixture()[source])
                record.pop("outcome_state", None)
                with self.assertRaisesRegex(ValueError, "trustworthy outcome"):
                    effect_event(record, _session(), 1)

    def test_failed_verification_fixture_reports_check_and_failure_counts(self):
        """Dropping non-passing checks would falsely make a failed verification look clean."""
        result = dict(_fixture()["failed_verification"])

        event = verification_event(result, _session(), 1)

        self.assertEqual("verification.finished", event.event_type)
        self.assertEqual({
            "verification_id": "vrf_failed", "status": "failed", "check_count": 2, "failure_count": 1,
        }, dict(event.payload))
        self.assertEqual(_fixture()["failed_verification"], result)

    def test_missing_legacy_fields_cross_task_records_and_old_records_are_rejected(self):
        """Accepting partial or cross-task records would attach audit facts to the wrong Task."""
        fixture = _fixture()
        before = dict(fixture["task_transition"]["before"])
        after = dict(fixture["task_transition"]["after"])
        after.pop("status")
        with self.assertRaisesRegex(ValueError, "legacy task"):
            task_transition_event(before, after, _session(), 1)

        cross_task = dict(fixture["reversible_effect"])
        cross_task["task_id"] = "tsk_other"
        with self.assertRaisesRegex(ValueError, "task"):
            effect_event(cross_task, _session(), 1)

        with self.assertRaisesRegex(ValueError, "legacy effect"):
            effect_event(dict(fixture["legacy_effect"]), _session(), 1)

        missing_status = dict(fixture["failed_verification"])
        missing_status.pop("status")
        with self.assertRaisesRegex(ValueError, "legacy verification"):
            verification_event(missing_status, _session(), 1)

    def test_task_run_binding_and_missing_versions_are_rejected_before_identity_allocation(self):
        """A task fact cannot borrow an unbound run or collapse two versionless writes."""
        fixture = _fixture()["task_transition"]
        with self.assertRaisesRegex(ValueError, "run"):
            effect_event(_fixture()["reversible_effect"], _session(run_id=None), 1)

        before = dict(fixture["before"])
        after = dict(fixture["after"])
        before.pop("version")
        after.pop("version")
        with self.assertRaisesRegex(ValueError, "version"):
            task_transition_event(before, after, _session(), 1)

    def test_task_active_run_and_run_alias_must_bind_to_the_session_run(self):
        """A transition cannot project an active Run that its RuntimeSession does not own."""
        fixture = _fixture()["task_transition"]
        active_mismatch = dict(fixture["after"])
        active_mismatch["active_run_id"] = "run_other"
        with self.assertRaisesRegex(ValueError, "run"):
            task_transition_event(fixture["before"], active_mismatch, _session(), 1)

        alias_mismatch = dict(fixture["after"])
        alias_mismatch["run_id"] = "run_other"
        with self.assertRaisesRegex(ValueError, "run"):
            task_transition_event(fixture["before"], alias_mismatch, _session(), 1)

    def test_verification_rejects_unknown_check_status_and_inconsistent_aggregate(self):
        """A terminal summary must agree with the fixed check-status vocabulary."""
        bogus = dict(_fixture()["failed_verification"])
        bogus["checks"] = [{"id": "unit", "status": "invented"}]
        with self.assertRaisesRegex(ValueError, "invalid check"):
            verification_event(bogus, _session(), 1)

        inconsistent = dict(_fixture()["failed_verification"])
        inconsistent["checks"] = [{"id": "unit", "status": "passed"}]
        with self.assertRaisesRegex(ValueError, "inconsistent"):
            verification_event(inconsistent, _session(), 1)

        passed_with_failure = dict(_fixture()["failed_verification"])
        passed_with_failure["status"] = "passed"
        with self.assertRaisesRegex(ValueError, "inconsistent"):
            verification_event(passed_with_failure, _session(), 1)


class RuntimeEventMirrorTests(unittest.TestCase):
    def test_off_preserves_legacy_path_without_generating_or_persisting_an_event(self):
        """Treating off like shadow would change the legacy feature-off contract."""
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(config, "runtime_events_mode", return_value="off"):
            sink = JsonlRuntimeEventSink(Path(directory) / "events.jsonl")
            mirror = RuntimeEventMirror(sink=sink, diagnostics_path=Path(directory) / "diagnostics.jsonl")
            event = mirror.mirror_effect(dict(_fixture()["reversible_effect"]), _session())

        self.assertIsNone(event)
        self.assertFalse(sink.path.exists())
        self.assertEqual((), mirror.diagnostics)

    def test_shadow_validates_without_persistence_and_writes_only_safe_local_diagnostics(self):
        """Persisting in shadow or echoing a legacy secret into diagnostics breaks isolation."""
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(config, "runtime_events_mode", return_value="shadow"):
            root = Path(directory)
            sink = JsonlRuntimeEventSink(root / "events.jsonl")
            diagnostics = root / "diagnostics.jsonl"
            mirror = RuntimeEventMirror(sink=sink, diagnostics_path=diagnostics)
            event = mirror.mirror_effect(dict(_fixture()["reversible_effect"]), _session())
            malformed = dict(_fixture()["legacy_effect"])
            malformed["Authorization"] = "Bearer legacy-secret"
            rejected = mirror.mirror_effect(malformed, _session())

            payload = diagnostics.read_text(encoding="utf-8")
        self.assertEqual("action.finished", event.event_type)
        self.assertIsNone(rejected)
        self.assertFalse(sink.path.exists())
        self.assertEqual("runtime_event_adapter_failed", mirror.diagnostics[-1].code)
        self.assertNotIn("legacy-secret", payload)
        self.assertNotIn("Authorization", payload)

    def test_on_persists_once_and_allocates_monotonic_sequences_across_a_restart(self):
        """Reusing a legacy fact must not duplicate it, while a new fact must advance its sequence."""
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(config, "runtime_events_mode", return_value="on"):
            path = Path(directory) / "events.jsonl"
            session = _session()
            first = dict(_fixture()["reversible_effect"])
            second = dict(_fixture()["irreversible_effect"])
            first_mirror = RuntimeEventMirror(sink=JsonlRuntimeEventSink(path), diagnostics_path=Path(directory) / "diag.jsonl")
            initial = first_mirror.mirror_effect(first, session)
            retried = first_mirror.mirror_effect(first, session)
            restarted = RuntimeEventMirror(sink=JsonlRuntimeEventSink(path), diagnostics_path=Path(directory) / "diag.jsonl")
            next_event = restarted.mirror_effect(second, session)
            persisted = JsonlRuntimeEventSink(path).read(runtime_id=session.identity.session_id)

        self.assertEqual(initial.event_id, retried.event_id)
        self.assertEqual([1, 2], [event.seq for event in persisted])
        self.assertEqual(next_event.event_id, persisted[-1].event_id)

    def test_failed_prewrite_and_shadow_cutover_do_not_poison_durable_sequence_allocation(self):
        """A built-but-unwritten event must not consume the next on-disk sequence."""
        class FailsBeforeWrite(JsonlRuntimeEventSink):
            def __init__(self, path):
                super().__init__(path)
                self.fail_once = True

            def append_allocated(self, runtime_id, event_id, build):
                if self.fail_once:
                    self.fail_once = False
                    build(1)
                    raise RuntimeEventSinkError("RUNTIME_EVENT_PERSIST_FAILED")
                return super().append_allocated(runtime_id, event_id, build)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            session = _session(session_id="runtime-task3-durable-sequence")
            record = dict(_fixture()["reversible_effect"])
            failing = RuntimeEventMirror(
                sink=FailsBeforeWrite(root / "failed.jsonl"), diagnostics_path=root / "failed.diagnostics.jsonl")
            with mock.patch.object(config, "runtime_events_mode", return_value="on"):
                self.assertIsNone(failing.mirror_effect(record, session))
                retried = failing.mirror_effect(record, session)

            shadow = RuntimeEventMirror(sink=JsonlRuntimeEventSink(root / "cutover.jsonl"))
            with mock.patch.object(config, "runtime_events_mode", return_value="shadow"):
                self.assertIsNotNone(shadow.mirror_effect(record, session))
            with mock.patch.object(config, "runtime_events_mode", return_value="on"):
                persisted = shadow.mirror_effect(record, session)

        self.assertEqual(1, retried.seq)
        self.assertEqual(1, persisted.seq)

    def test_on_allocates_distinct_concurrent_process_facts_inside_one_sink_critical_section(self):
        """Two processes released together must retain both distinct facts, not lose seq two."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "events.jsonl"
            barrier = root / "barrier"
            context = multiprocessing.get_context("spawn")
            results = context.Queue()
            first = context.Process(target=_concurrent_effect_writer,
                                    args=(str(path), str(barrier), "eff_process_one", results))
            second = context.Process(target=_concurrent_effect_writer,
                                     args=(str(path), str(barrier), "eff_process_two", results))
            first.start()
            second.start()
            first.join(20)
            second.join(20)
            self.assertEqual(0, first.exitcode)
            self.assertEqual(0, second.exitcode)
            self.assertEqual([True, True], sorted((results.get(timeout=2), results.get(timeout=2))))
            persisted = JsonlRuntimeEventSink(path).read(runtime_id="runtime-task3-fixed")

        self.assertEqual(["eff_process_one", "eff_process_two"],
                         sorted(event.payload["action_id"] for event in persisted))
        self.assertEqual([1, 2], [event.seq for event in persisted])

    def test_on_sink_failure_records_a_diagnostic_without_changing_legacy_effect_result(self):
        """Letting audit persistence failure alter record_effect would hide the tool's real outcome."""
        class FailingSink:
            def append(self, _event):
                raise RuntimeEventSinkError("RUNTIME_EVENT_PERSIST_FAILED")

            def read(self, **_kwargs):
                return ()

        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(config, "runtime_events_mode", return_value="on"):
            ledger = Path(directory) / "effects.jsonl"
            mirror = RuntimeEventMirror(sink=FailingSink(), diagnostics_path=Path(directory) / "diagnostics.jsonl")
            legacy_result = effects.record_effect(
                "write_file", {"path": "safe.txt"}, {"task_id": "tsk_alpha"}, path=ledger,
                runtime_session=_session(), runtime_event_mirror=mirror,
            )
            self.assertTrue(mirror.drain(timeout=2))
            self.assertTrue(mirror.close(timeout=2))
            legacy_records = effects.load(ledger)
        self.assertTrue(legacy_result)
        self.assertEqual("safe.txt", legacy_records[0]["target"])
        self.assertEqual("runtime_event_persist_failed", mirror.diagnostics[-1].code)

    def test_legacy_effect_return_is_not_blocked_by_a_slow_event_sink(self):
        """The bounded dispatcher must keep the legacy ledger return off sink latency."""
        class BlockingSink:
            def __init__(self) -> None:
                self.entered = threading.Event()
                self.release = threading.Event()

            def append_allocated(self, _runtime_id, _event_id, build):
                self.entered.set()
                self.release.wait(5)
                return build(1)

        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(config, "runtime_events_mode", return_value="on"):
            root = Path(directory)
            sink = BlockingSink()
            mirror = RuntimeEventMirror(sink=sink, diagnostics_path=root / "diagnostics.jsonl")
            started = time.monotonic()
            legacy_result = effects.record_effect(
                "write_file", {"path": "safe.txt"}, {"task_id": "tsk_alpha", "run_id": "run_alpha"},
                path=root / "effects.jsonl", runtime_session=_session(), runtime_event_mirror=mirror,
            )
            elapsed = time.monotonic() - started
            self.assertTrue(sink.entered.wait(2))
            self.assertTrue(legacy_result)
            self.assertLess(elapsed, 0.25)
            sink.release.set()
            self.assertTrue(mirror.drain(timeout=2))
            mirror.close(timeout=2)

    def test_task_engine_and_verification_bridge_keep_legacy_returns_and_do_not_own_ui_state(self):
        """Replacing the Task result or verification result with a projection would break their public contracts."""
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(config, "runtime_events_mode", return_value="on"):
            root = Path(directory)
            store = TaskStore(root / "tasks.db")
            project = store.create_project("task3", root / "project")
            legacy_engine = TaskEngine(store)
            task = legacy_engine.create_task(CreateTask(project["id"], "task", "goal", ("accept",)))
            session = _session(task_id=task["id"], run_id=None)
            sink = JsonlRuntimeEventSink(root / "events.jsonl")
            mirror = RuntimeEventMirror(sink=sink, diagnostics_path=root / "diagnostics.jsonl")
            engine = TaskEngine(store, runtime_session=session, runtime_event_mirror=mirror)

            transitioned = engine.transition(task["id"], TaskStatus.READY, task["version"], "user")
            verification = mirror_verification_result(dict(_fixture()["failed_verification"]), _session(), mirror)

            task_events = store.list_events(task["id"])
            self.assertTrue(mirror.drain(timeout=2))
            persisted = sink.read()
        self.assertEqual(TaskStatus.READY.value, transitioned["status"])
        self.assertEqual(["task.created", "task.transitioned"], [event["type"] for event in task_events])
        self.assertIsNone(verification)
        self.assertEqual(["task.state_changed", "verification.finished"], [event.event_type for event in persisted])

    def test_finish_run_clearing_active_run_rejects_a_genuine_wrong_runtime_session(self):
        """A post-clear snapshot must retain the finished Run for session binding."""
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(config, "runtime_events_mode", return_value="on"):
            root = Path(directory)
            store = TaskStore(root / "tasks.db")
            project = store.create_project("task3", root / "project")
            legacy = TaskEngine(store)
            task = legacy.create_task(CreateTask(project["id"], "task", "goal", ("accept",)))
            ready = legacy.transition(task["id"], TaskStatus.READY, task["version"], "user")
            running, run = legacy.start_run(StartRun(ready["id"], ready["version"], "user"))
            mirror = RuntimeEventMirror(
                sink=JsonlRuntimeEventSink(root / "events.jsonl"),
                diagnostics_path=root / "diagnostics.jsonl",
            )
            observer = TaskEngine(
                store,
                runtime_session=_session(task_id=task["id"], run_id="run_wrong"),
                runtime_event_mirror=mirror,
            )
            reviewed, _ended = observer.finish_run(
                FinishRun(run["id"], running["version"], "agent", RunStatus.COMPLETED))
            self.assertTrue(mirror.drain(timeout=2))
            persisted = mirror.sink.read()
            observer.close()
            self.assertTrue(mirror.close(timeout=2))

        self.assertEqual(TaskStatus.REVIEW.value, reviewed["status"])
        self.assertEqual((), persisted)
        self.assertEqual("runtime_event_adapter_failed", mirror.diagnostics[-1].code)

    def test_cancel_clearing_active_run_rejects_a_genuine_wrong_runtime_session(self):
        """Cancel has no Run on task.transitioned, so its prior fact must be retained."""
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(config, "runtime_events_mode", return_value="on"):
            root = Path(directory)
            store = TaskStore(root / "tasks.db")
            project = store.create_project("task3", root / "project")
            legacy = TaskEngine(store)
            task = legacy.create_task(CreateTask(project["id"], "task", "goal", ("accept",)))
            ready = legacy.transition(task["id"], TaskStatus.READY, task["version"], "user")
            running, run = legacy.start_run(StartRun(ready["id"], ready["version"], "user"))
            mirror = RuntimeEventMirror(
                sink=JsonlRuntimeEventSink(root / "events.jsonl"),
                diagnostics_path=root / "diagnostics.jsonl",
            )
            observer = TaskEngine(
                store,
                runtime_session=_session(task_id=task["id"], run_id="run_wrong"),
                runtime_event_mirror=mirror,
            )
            cancelled, ended = observer.cancel_task(running["id"], running["version"], "user")
            self.assertTrue(mirror.drain(timeout=2))
            persisted = mirror.sink.read()
            observer.close()
            self.assertTrue(mirror.close(timeout=2))

        self.assertEqual(TaskStatus.CANCELLED.value, cancelled["status"])
        self.assertEqual(run["id"], ended["id"])
        self.assertEqual((), persisted)
        self.assertEqual("runtime_event_adapter_failed", mirror.diagnostics[-1].code)

    def test_finish_run_observer_preserves_the_cleared_run_and_enqueues_once(self):
        """The exact durable transition carries before.run truth, not a session guess."""
        class RecordingMirror:
            def __init__(self) -> None:
                self.transitions = []

            def enqueue_task_transition(self, before, after, session):
                self.transitions.append((before, after, session))
                return True

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = TaskStore(root / "tasks.db")
            project = store.create_project("task3", root / "project")
            legacy = TaskEngine(store)
            task = legacy.create_task(CreateTask(project["id"], "task", "goal", ("accept",)))
            ready = legacy.transition(task["id"], TaskStatus.READY, task["version"], "user")
            running, run = legacy.start_run(StartRun(ready["id"], ready["version"], "user"))
            recorder = RecordingMirror()
            session = _session(task_id=task["id"], run_id=run["id"])
            observer = TaskEngine(store, runtime_session=session, runtime_event_mirror=recorder)
            reviewed, _ended = observer.finish_run(
                FinishRun(run["id"], running["version"], "agent", RunStatus.COMPLETED))
            observer.close()

        self.assertEqual(TaskStatus.REVIEW.value, reviewed["status"])
        self.assertEqual(1, len(recorder.transitions))
        before, after, emitted_session = recorder.transitions[0]
        self.assertEqual(run["id"], before["active_run_id"])
        self.assertIsNone(after["active_run_id"])
        self.assertIs(emitted_session, session)

    def test_store_commit_observer_captures_generic_start_and_finish_transitions_once(self):
        """TaskEngine routes through the durable event boundary, not one public method."""
        class RecordingMirror:
            def __init__(self) -> None:
                self.transitions = []

            def enqueue_task_transition(self, before, after, session):
                self.transitions.append((before["status"], after["status"], session))
                return True

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = TaskStore(root / "tasks.db")
            project = store.create_project("task3", root / "project")
            task = TaskEngine(store).create_task(CreateTask(project["id"], "task", "goal", ("accept",)))
            recorder = RecordingMirror()
            engine = TaskEngine(store, runtime_session=_session(task_id=task["id"], run_id=None),
                                runtime_event_mirror=recorder)
            ready = engine.transition(task["id"], TaskStatus.READY, task["version"], "user")
            running, run = engine.start_run(StartRun(ready["id"], ready["version"], "user"))
            reviewed, _ended = engine.finish_run(
                FinishRun(run["id"], running["version"], "agent", RunStatus.COMPLETED))

        self.assertEqual("Review", reviewed["status"])
        self.assertEqual([
            ("Draft", "Ready"), ("Ready", "Running"), ("Running", "Review"),
        ], [(before, after) for before, after, _session_value in recorder.transitions])

    def test_archive_task_notifies_once_after_its_status_and_version_commit(self):
        """Archive is a durable status transition even though its legacy event type differs."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = TaskStore(root / "tasks.db")
            project = store.create_project("task3", root / "project")
            task = store.create_task(CreateTask(project["id"], "archive", "goal", ("accept",)))
            observed = []
            store.add_transition_observer(lambda before, after: observed.append((before, after)))
            archived = store.archive_task(task["id"], task["version"])

        self.assertEqual("Archived", archived["status"])
        self.assertEqual(1, archived["version"])
        self.assertEqual([(task["id"], "Draft", "Archived", 0, 1)], [
            (before["id"], before["status"], after["status"], before["version"], after["version"])
            for before, after in observed
        ])

    def test_runtime_observers_are_session_scoped_deduped_and_removable(self):
        """Two engines cannot double-enqueue, observe another Task, or survive close()."""
        class RecordingMirror:
            def __init__(self) -> None:
                self.transitions = []

            def enqueue_task_transition(self, before, after, session):
                self.transitions.append((before["id"], after["status"], session.identity.session_id))
                return True

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = TaskStore(root / "tasks.db")
            project = store.create_project("task3", root / "project")
            first_task = TaskEngine(store).create_task(CreateTask(project["id"], "one", "goal", ("accept",)))
            other_task = TaskEngine(store).create_task(CreateTask(project["id"], "two", "goal", ("accept",)))
            mirror = RecordingMirror()
            session = _session(task_id=first_task["id"], run_id=None)
            first = TaskEngine(store, runtime_session=session, runtime_event_mirror=mirror)
            second = TaskEngine(store, runtime_session=session, runtime_event_mirror=mirror)

            ready = first.transition(first_task["id"], TaskStatus.READY, first_task["version"], "user")
            TaskEngine(store).transition(other_task["id"], TaskStatus.READY, other_task["version"], "user")
            first.close()
            second.transition(ready["id"], TaskStatus.CANCELLED, ready["version"], "user")
            second.close()

            third_task = TaskEngine(store).create_task(CreateTask(project["id"], "three", "goal", ("accept",)))
            TaskEngine(store, runtime_session=object(), runtime_event_mirror=mirror).transition(
                third_task["id"], TaskStatus.READY, third_task["version"], "user")

        self.assertEqual([
            (first_task["id"], "Ready", session.identity.session_id),
            (first_task["id"], "Cancelled", session.identity.session_id),
        ], mirror.transitions)

    def test_store_observer_covers_plan_question_and_cancel_transition_paths(self):
        """Every TaskEngine path emits after its own durable task.transitioned append."""
        plan = {
            "objective": "goal", "assumptions": [],
            "steps": [{"id": "work", "title": "work", "intent": "work", "files": ["README.md"],
                       "validation": ["accept"], "risk": "low", "depends_on": []}],
            "acceptance_mapping": {"accept": ["work"]}, "estimated_budget": {},
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = TaskStore(root / "tasks.db")
            project = store.create_project("task3", root / "project")
            observed = []
            store.add_transition_observer(
                lambda before, after: observed.append((before["status"], after["status"]))
            )
            engine = TaskEngine(store)
            task = engine.create_task(CreateTask(project["id"], "task", "goal", ("accept",)))
            proposed = engine.propose_plan(task["id"], plan, "agent", task["version"])
            awaiting = store.get_task(task["id"])
            engine.review_plan(ReviewPlan(task["id"], proposed["revision"], "approve", "ok",
                                          awaiting["version"], "user"))
            ready = store.get_task(task["id"])
            running, run = engine.start_run(StartRun(ready["id"], ready["version"], "user"))
            waiting, question = engine.ask_question(AskQuestion(
                run["id"], "continue?", ("yes", "no"), False, "legacy_question"))
            resumed, _answered = engine.answer_question(AnswerQuestion(
                waiting["id"], question["id"], "yes", waiting["version"]))
            reviewed, _ended = engine.finish_run(
                FinishRun(run["id"], resumed["version"], "agent", RunStatus.COMPLETED))
            cancelled = engine.create_task(CreateTask(project["id"], "cancel", "goal", ("accept",)))
            engine.cancel_task(cancelled["id"], cancelled["version"], "user")

        self.assertEqual("Review", reviewed["status"])
        self.assertEqual([
            ("Draft", "AwaitingPlanApproval"), ("AwaitingPlanApproval", "Ready"),
            ("Ready", "Running"), ("Running", "WaitingUser"),
            ("WaitingUser", "Running"), ("Running", "Review"), ("Draft", "Cancelled"),
        ], observed)


if __name__ == "__main__":
    unittest.main(verbosity=2)
