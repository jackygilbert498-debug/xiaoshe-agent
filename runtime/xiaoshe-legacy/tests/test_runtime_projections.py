"""Contract tests for disposable, atomically rebuilt RuntimeEvent projections."""
from __future__ import annotations

import tempfile
import sqlite3
import threading
import unittest
import uuid
from pathlib import Path
from unittest import mock

from harness.runtime_events import RuntimeEvent
from harness.task_model import CreateTask
from harness.task_store import TaskStore
from harness.runtime_projections import (
    ProjectionRegistry,
    RuntimeSummaryProjection,
    TaskTimelineProjection,
)


def _event(*, sequence: int, event_type: str = "task.state_changed",
           event_id: str | None = None, state: str = "running",
           task_id: str = "tsk_projection_test") -> RuntimeEvent:
    payloads = {
        "runtime.started": {"mode": "shadow"},
        "task.state_changed": {
            "previous_state": "ready",
            "state": state,
            "reason_code": "legacy_task_transition",
        },
        "runtime.finished": {"status": "success"},
    }
    return RuntimeEvent(
        schema_version=1,
        event_id=event_id or str(uuid.uuid4()),
        event_type=event_type,
        occurred_at=f"2026-08-16T00:00:0{sequence}.000Z",
        runtime_id="runtime-projection-test",
        task_id=task_id,
        run_id="run_projection_test",
        source="worker",
        seq=sequence,
        payload=payloads[event_type],
    )


class _BrokenProjection:
    name = "test.broken"
    schema_version = 1

    def reset(self) -> None:
        pass

    def apply(self, _event: RuntimeEvent) -> None:
        raise RuntimeError("boom")


class _SilentTimelineProjection(TaskTimelineProjection):
    """A broken reducer that accepts facts but accidentally emits no rows."""

    def apply(self, _event: RuntimeEvent) -> None:
        pass


class _SilentSummaryProjection(RuntimeSummaryProjection):
    """A broken reducer that loses every runtime summary without raising."""

    def apply(self, _event: RuntimeEvent) -> None:
        pass


class _SpoofedTimelineProjection:
    """Protocol-shaped attacker that must not claim a reserved materialization name."""

    name = TaskTimelineProjection.name
    schema_version = 1

    def reset(self) -> None:
        pass

    def apply(self, _event: RuntimeEvent) -> None:
        pass


class _SpoofedSummaryProjection:
    """Protocol-shaped attacker that must not claim a reserved materialization name."""

    name = RuntimeSummaryProjection.name
    schema_version = 1

    def reset(self) -> None:
        pass

    def apply(self, _event: RuntimeEvent) -> None:
        pass


class RuntimeProjectionContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = TaskStore(Path(self.temp.name) / "tasks.db")

    def _registry(self, *, timeline_version: int = 1,
                  include_summary: bool = True) -> ProjectionRegistry:
        registry = ProjectionRegistry(self.store)
        registry.register(TaskTimelineProjection(schema_version=timeline_version))
        if include_summary:
            registry.register(RuntimeSummaryProjection())
        return registry

    def test_identical_duplicate_event_is_reported_once_without_duplicate_timeline_row(self):
        """Removing duplicate suppression would show one immutable fact twice."""
        event = _event(sequence=1)

        report = self._registry().rebuild((event, event))

        self.assertTrue(report.ok)
        self.assertEqual(1, report.applied_events)
        self.assertEqual(1, report.duplicate_events)
        self.assertEqual((event.event_id,), report.duplicate_event_ids)
        self.assertEqual((event.event_id,), tuple(row["event_id"] for row in self._registry().timeline()))

    def test_out_of_order_stream_keeps_the_last_good_projection_snapshot(self):
        """Changing strict per-runtime ordering to sorting would hide corrupt history."""
        registry = self._registry()
        first = _event(sequence=1)
        second = _event(sequence=2, event_type="runtime.finished")
        self.assertTrue(registry.rebuild((first, second)).ok)

        # A late distinct sequence-1 fact is an ordering regression.  Starting
        # with sequence 2 would instead be a gap, which the next test covers.
        report = registry.rebuild((first, second, _event(sequence=1)))

        self.assertFalse(report.ok)
        self.assertEqual("EVENT_OUT_OF_ORDER", report.diagnostics[0].code)
        self.assertEqual((first.event_id, second.event_id),
                         tuple(row["event_id"] for row in registry.timeline()))

    def test_gap_in_a_runtime_sequence_rejects_the_rebuild_without_switching_tables(self):
        """Allowing missing sequence numbers would make a projection look complete when it is not."""
        registry = self._registry()
        stable = _event(sequence=1)
        self.assertTrue(registry.rebuild((stable,)).ok)

        report = registry.rebuild((_event(sequence=1), _event(sequence=3)))

        self.assertFalse(report.ok)
        self.assertEqual("EVENT_SEQUENCE_GAP", report.diagnostics[0].code)
        self.assertEqual((stable.event_id,), tuple(row["event_id"] for row in registry.timeline()))

    def test_bad_projection_returns_a_structured_failure_and_does_not_publish_partial_tables(self):
        """Publishing after one reducer fails would leave an unrebuildable mixed read model."""
        registry = self._registry()
        stable = _event(sequence=1)
        self.assertTrue(registry.rebuild((stable,)).ok)
        registry.register(_BrokenProjection())

        report = registry.rebuild((_event(sequence=1),))

        self.assertFalse(report.ok)
        self.assertEqual("PROJECTION_APPLY_FAILED", report.diagnostics[0].code)
        self.assertEqual("test.broken", report.diagnostics[0].projection_name)
        self.assertEqual((stable.event_id,), tuple(row["event_id"] for row in registry.timeline()))

    def test_schema_upgrade_is_reported_and_replaces_the_projection_cursor_version(self):
        """Ignoring a reducer version change would reuse incompatible derived state."""
        first = self._registry(timeline_version=1)
        self.assertTrue(first.rebuild((_event(sequence=1),)).ok)

        upgraded = self._registry(timeline_version=2)
        report = upgraded.rebuild((_event(sequence=1),))

        self.assertTrue(report.ok)
        self.assertEqual((("task.timeline", 1, 2),), report.schema_upgrades)
        self.assertEqual(2, next(cursor.schema_version for cursor in report.cursors
                                 if cursor.projection_name == "task.timeline"))
        self.assertEqual("TASK_MISSING_FROM_LEGACY",
                         upgraded.compare_task_store().mismatches[0].code)

    def test_zero_event_rebuild_publishes_empty_state_with_versioned_cursors(self):
        """Skipping empty histories would leave stale rows visible after source retention."""
        registry = self._registry()

        report = registry.rebuild(())

        self.assertTrue(report.ok)
        self.assertEqual(0, report.applied_events)
        self.assertEqual((), registry.timeline())
        self.assertEqual((), registry.summaries())
        self.assertEqual({"task.timeline", "runtime.summary"},
                         {cursor.projection_name for cursor in report.cursors})
        self.assertTrue(all(cursor.last_event_id is None and cursor.last_seq == 0
                            for cursor in report.cursors))

    def test_removed_projection_is_purged_when_the_remaining_registry_rebuilds(self):
        """Leaving a removed projection's rows live would make deleted code keep serving state."""
        events = (_event(sequence=1), _event(sequence=2, event_type="runtime.finished"))
        self.assertTrue(self._registry().rebuild(events).ok)

        registry = self._registry(include_summary=False)
        report = registry.rebuild(events)

        self.assertTrue(report.ok)
        self.assertEqual(("runtime.summary",), report.removed_projections)
        self.assertEqual((), registry.summaries())
        self.assertEqual({"task.timeline"}, {cursor.projection_name for cursor in report.cursors})

    def test_legacy_task_store_mismatch_is_exposed_in_the_rebuild_report_without_mutation(self):
        """Treating a shadow mismatch as a write would let a projection overwrite Task facts."""
        project_root = Path(self.temp.name) / "project"
        project_root.mkdir()
        project = self.store.create_project("Projection", project_root)
        task = self.store.create_task(CreateTask(project["id"], "title", "goal", ()))
        event = _event(sequence=1, state="running", task_id=task["id"])

        report = self._registry().rebuild((event,))

        self.assertTrue(report.ok)
        self.assertFalse(report.legacy_comparison.matches)
        self.assertEqual("TASK_STATUS_MISMATCH", report.legacy_comparison.mismatches[0].code)
        self.assertEqual("Draft", self.store.get_task(task["id"])["status"])

    def test_reserved_projection_names_reject_protocol_spoofs_before_rebuild(self):
        """A lookalike reducer must not suppress a built-in table materialization."""
        for spoof in (_SpoofedTimelineProjection(), _SpoofedSummaryProjection()):
            registry = ProjectionRegistry(self.store)

            with self.subTest(name=spoof.name):
                with self.assertRaises(TypeError):
                    registry.register(spoof)

    def test_distinct_instances_cannot_share_a_reserved_projection_name(self):
        """A second same-name instance cannot replace a registered reducer before replay."""
        for constructor in (TaskTimelineProjection, RuntimeSummaryProjection):
            registry = ProjectionRegistry(self.store)
            first = constructor()
            registry.register(first)

            with self.subTest(name=first.name):
                with self.assertRaises(ValueError):
                    registry.register(constructor())

    def test_silent_timeline_omission_fails_before_atomic_switch_and_retains_live_rows(self):
        """A reducer that silently drops a task event must not publish a partial timeline."""
        stable = _event(sequence=1)
        initial = self._registry()
        self.assertTrue(initial.rebuild((stable,)).ok)
        registry = ProjectionRegistry(self.store)
        registry.register(_SilentTimelineProjection())
        registry.register(RuntimeSummaryProjection())

        report = registry.rebuild((_event(sequence=1),))

        self.assertFalse(report.ok)
        self.assertEqual("PROJECTION_SNAPSHOT_INVALID", report.diagnostics[0].code)
        self.assertEqual((stable.event_id,), tuple(row["event_id"] for row in registry.timeline()))

    def test_silent_summary_omission_fails_before_atomic_switch_and_retains_live_rows(self):
        """A silent summary reducer cannot publish a cursor with no matching runtime row."""
        stable = _event(sequence=1)
        initial = self._registry()
        self.assertTrue(initial.rebuild((stable,)).ok)
        registry = ProjectionRegistry(self.store)
        registry.register(TaskTimelineProjection())
        registry.register(_SilentSummaryProjection())

        report = registry.rebuild((_event(sequence=1),))

        self.assertFalse(report.ok)
        self.assertEqual("PROJECTION_SNAPSHOT_INVALID", report.diagnostics[0].code)
        self.assertEqual((stable.event_id,), tuple(row["event_id"] for row in registry.timeline()))

    def test_legacy_comparison_database_failure_is_reported_without_replacing_live_projection(self):
        """A locked/corrupt TaskStore read must not escape or publish a new snapshot."""
        registry = self._registry()
        stable = _event(sequence=1)
        self.assertTrue(registry.rebuild((stable,)).ok)

        with mock.patch.object(self.store, "get_task", side_effect=sqlite3.OperationalError("locked")):
            report = registry.rebuild((_event(sequence=1),))

        self.assertFalse(report.ok)
        self.assertEqual("PROJECTION_COMPARISON_FAILED", report.diagnostics[0].code)
        self.assertEqual((stable.event_id,), tuple(row["event_id"] for row in registry.timeline()))

    def test_projection_metadata_read_failure_is_structured_and_does_not_escape(self):
        """A broken derived-state read must preserve the prior snapshot and return a report."""
        registry = self._registry()
        stable = _event(sequence=1)
        self.assertTrue(registry.rebuild((stable,)).ok)

        with mock.patch.object(self.store, "derived_state_connection", side_effect=sqlite3.DatabaseError("corrupt")):
            report = registry.rebuild((_event(sequence=1),))

        self.assertFalse(report.ok)
        self.assertEqual("PROJECTION_READ_FAILED", report.diagnostics[0].code)
        self.assertEqual((stable.event_id,), tuple(row["event_id"] for row in registry.timeline()))

    def test_missing_physical_projection_table_is_recreated_by_a_complete_rebuild(self):
        """Deleting one disposable table must be recoverable from immutable events alone."""
        registry = self._registry()
        events = (_event(sequence=1), _event(sequence=2, event_type="runtime.finished"))
        self.assertTrue(registry.rebuild(events).ok)
        with self.store.derived_state_connection() as conn:
            conn.execute("DROP TABLE runtime_task_timeline")

        report = registry.rebuild(events)

        self.assertTrue(report.ok)
        self.assertEqual(tuple(event.event_id for event in events),
                         tuple(row["event_id"] for row in registry.timeline()))

    def test_leftover_temporary_table_from_interrupted_rebuild_is_replaced_safely(self):
        """A crash leaving a malformed __next table must not block the next complete rebuild."""
        registry = self._registry()
        with self.store.derived_state_connection() as conn:
            conn.execute("CREATE TABLE runtime_task_timeline__next (incomplete TEXT)")

        report = registry.rebuild((_event(sequence=1),))

        self.assertTrue(report.ok)
        with self.store.derived_state_connection() as conn:
            leftovers = conn.execute(
                "SELECT name FROM sqlite_master WHERE name LIKE 'runtime%__next'"
            ).fetchall()
        self.assertEqual([], leftovers)

    def test_publish_phase_failure_rolls_back_and_keeps_active_snapshot(self):
        """An exception after materialization cannot expose partially switched projection tables."""
        registry = self._registry()
        stable = _event(sequence=1)
        self.assertTrue(registry.rebuild((stable,)).ok)
        original = registry._write_summaries

        def fail_after_summary(conn, *, suffix: str) -> None:
            original(conn, suffix=suffix)
            raise sqlite3.OperationalError("injected publish failure")

        with mock.patch.object(registry, "_write_summaries", side_effect=fail_after_summary):
            report = registry.rebuild((_event(sequence=1),))

        self.assertFalse(report.ok)
        self.assertEqual("PROJECTION_PUBLISH_FAILED", report.diagnostics[0].code)
        self.assertEqual((stable.event_id,), tuple(row["event_id"] for row in registry.timeline()))

    def test_reader_observes_only_complete_old_or_new_snapshot_during_publish(self):
        """A reader during the commit window must never observe an empty or mixed set of tables."""
        registry = self._registry()
        old_event = _event(sequence=1)
        self.assertTrue(registry.rebuild((old_event,)).ok)
        new_event = _event(sequence=1)
        entered = threading.Event()
        release = threading.Event()
        original = registry._validate_snapshot
        result: list[object] = []

        def pause_after_validation(conn, events, cursors, *, suffix: str) -> None:
            original(conn, events, cursors, suffix=suffix)
            entered.set()
            self.assertTrue(release.wait(5))

        with mock.patch.object(registry, "_validate_snapshot", side_effect=pause_after_validation):
            worker = threading.Thread(target=lambda: result.append(registry.rebuild((new_event,))))
            worker.start()
            self.assertTrue(entered.wait(5))
            during = tuple(row["event_id"] for row in self._registry().timeline())
            release.set()
            worker.join(5)

        self.assertFalse(worker.is_alive())
        self.assertTrue(result[0].ok)
        after = tuple(row["event_id"] for row in self._registry().timeline())
        self.assertEqual((old_event.event_id,), during)
        self.assertEqual((new_event.event_id,), after)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
