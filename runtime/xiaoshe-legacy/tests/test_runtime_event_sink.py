"""Durability and recovery tests for the append-only RuntimeEvent JSONL sink."""
from __future__ import annotations

import errno
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from harness import _io, config
from harness.runtime_events import JsonlRuntimeEventSink, RuntimeEvent, RuntimeEventSinkError


_LOCK_HOLDER = Path(__file__).with_name("_lock_holder.py")


def _event(runtime_id: str, seq: int, *, event_id: str | None = None) -> RuntimeEvent:
    return RuntimeEvent(
        schema_version=1,
        event_id=event_id or str(uuid.uuid4()),
        event_type="runtime.started",
        occurred_at="2026-08-16T00:00:00.000Z",
        runtime_id=runtime_id,
        task_id="task-1",
        run_id="run-1",
        source="cli",
        seq=seq,
        payload={"mode": "shadow"},
    )


def _hold_lock(target: Path, seconds: float) -> subprocess.Popen:
    process = subprocess.Popen(
        [sys.executable, str(_LOCK_HOLDER), str(target), str(seconds)],
        cwd=str(Path(__file__).resolve().parents[1]),
        stdout=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    assert process.stdout is not None
    if process.stdout.readline().strip() != "LOCKED":
        process.kill()
        process.wait()
        raise AssertionError("lock-holder did not acquire the event-log lock")
    process.stdout.close()
    return process


_PROCESS_APPEND = """\
import sys
from harness.runtime_events import JsonlRuntimeEventSink, RuntimeEvent, RuntimeEventSinkError

event = RuntimeEvent(
    schema_version=1, event_id=sys.argv[2], event_type="runtime.started",
    occurred_at="2026-08-16T00:00:00.000Z", runtime_id=sys.argv[3],
    task_id="task-1", run_id="run-1", source="cli", seq=int(sys.argv[4]),
    payload={"mode": "shadow"},
)
try:
    JsonlRuntimeEventSink(sys.argv[1]).append(event)
except RuntimeEventSinkError as error:
    print(error.code)
    raise SystemExit(2)
print("APPENDED")
"""


def _spawn_event_append(path: Path, event: RuntimeEvent) -> subprocess.Popen:
    return subprocess.Popen(
        [sys.executable, "-X", "utf8", "-c", _PROCESS_APPEND,
         str(path), event.event_id, event.runtime_id, str(event.seq)],
        cwd=str(Path(__file__).resolve().parents[1]),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )


class JsonlRuntimeEventSinkTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.path = Path(self.temp_dir.name) / ".state" / "runtime" / "events.jsonl"
        self.sink = JsonlRuntimeEventSink(self.path)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_append_durably_persists_a_valid_event_and_reads_it_back(self):
        """Removing the durable append or public encoding must fail this contract."""
        event = _event("runtime-one", 1)

        self.sink.append(event)

        self.assertEqual((event,), self.sink.read())
        records = [json.loads(line) for line in self.path.read_text("utf-8").splitlines()]
        self.assertEqual([event.event_id], [record["event_id"] for record in records])

    def test_default_path_is_the_runtime_state_event_log(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(config, "ROOT", Path(temp)):
            sink = JsonlRuntimeEventSink()
            sink.append(_event("runtime-default", 1))
            self.assertTrue((Path(temp) / ".state" / "runtime" / "events.jsonl").exists())

    def test_read_filters_by_runtime_and_exclusive_sequence_cursor(self):
        first = _event("runtime-one", 1)
        second = _event("runtime-one", 2)
        other = _event("runtime-two", 1)
        for event in (first, second, other):
            self.sink.append(event)

        self.assertEqual((second,), self.sink.read(runtime_id="runtime-one", after_seq=1))
        self.assertEqual((second,), self.sink.read(after_seq=1))

    def test_duplicate_event_id_is_explicitly_rejected_before_a_second_record(self):
        """Dropping duplicate-id validation would create two immutable facts for one event."""
        event = _event("runtime-one", 1)
        self.sink.append(event)

        duplicate_id = _event("runtime-one", 2, event_id=event.event_id)
        with self.assertRaises(RuntimeEventSinkError) as raised:
            self.sink.append(duplicate_id)

        self.assertEqual("RUNTIME_EVENT_DUPLICATE_ID", raised.exception.code)
        self.assertEqual((event,), self.sink.read())

    def test_sequence_must_strictly_increase_for_one_runtime(self):
        """Changing the sequence comparison to allow equality or regressions must fail."""
        first = _event("runtime-one", 2)
        self.sink.append(first)

        with self.assertRaises(RuntimeEventSinkError) as raised:
            self.sink.append(_event("runtime-one", 2))

        self.assertEqual("RUNTIME_EVENT_SEQUENCE_CONFLICT", raised.exception.code)
        self.assertEqual((first,), self.sink.read())

    def test_concurrent_threads_do_not_lose_independent_runtime_records(self):
        """Removing the shared file lock can lose a concurrent append."""
        events = tuple(_event(f"thread-runtime-{index}", 1) for index in range(24))
        barrier = threading.Barrier(len(events))

        def append(event: RuntimeEvent) -> None:
            barrier.wait()
            self.sink.append(event)

        with ThreadPoolExecutor(max_workers=len(events)) as pool:
            list(pool.map(append, events))

        self.assertEqual({event.event_id for event in events}, {event.event_id for event in self.sink.read()})

    def test_concurrent_processes_do_not_lose_independent_runtime_records(self):
        """Removing the sidecar lock can corrupt or lose a cross-process append."""
        events = tuple(_event(f"process-runtime-{index}", 1) for index in range(6))
        code = (
            "import sys; from harness.runtime_events import JsonlRuntimeEventSink, RuntimeEvent; "
            "event = RuntimeEvent(schema_version=1, event_id=sys.argv[2], event_type='runtime.started', "
            "occurred_at='2026-08-16T00:00:00.000Z', runtime_id=sys.argv[3], task_id='task-1', "
            "run_id='run-1', source='cli', seq=1, payload={'mode':'shadow'}); "
            "JsonlRuntimeEventSink(sys.argv[1]).append(event)"
        )
        processes = [
            subprocess.Popen(
                [sys.executable, "-X", "utf8", "-c", code, str(self.path), event.event_id, event.runtime_id],
                cwd=str(Path(__file__).resolve().parents[1]),
            )
            for event in events
        ]
        for process in processes:
            self.assertEqual(0, process.wait())

        self.assertEqual({event.event_id for event in events}, {event.event_id for event in self.sink.read()})

    def test_same_runtime_thread_sequence_race_commits_only_one_fact(self):
        """Allowing equal sequence values through the locked check would fail here."""
        events = (_event("thread-race", 1), _event("thread-race", 1))
        barrier = threading.Barrier(2)

        def append(event: RuntimeEvent) -> str:
            barrier.wait()
            try:
                self.sink.append(event)
            except RuntimeEventSinkError as error:
                return error.code
            return "APPENDED"

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = tuple(pool.map(append, events))

        self.assertCountEqual(("APPENDED", "RUNTIME_EVENT_SEQUENCE_CONFLICT"), outcomes)
        self.assertEqual(1, len(self.sink.read(runtime_id="thread-race")))

    def test_same_runtime_process_sequence_race_commits_only_one_fact(self):
        """A process-local sequence check would allow both of these records."""
        events = (_event("process-race", 1), _event("process-race", 1))
        processes = [_spawn_event_append(self.path, event) for event in events]
        results = [process.communicate() for process in processes]

        self.assertCountEqual((0, 2), [process.returncode for process in processes])
        self.assertIn("APPENDED", results[0][0] + results[1][0])
        self.assertIn("RUNTIME_EVENT_SEQUENCE_CONFLICT", results[0][0] + results[1][0])
        self.assertEqual(1, len(self.sink.read(runtime_id="process-race")))

    def test_duplicate_event_id_process_race_commits_only_one_fact(self):
        """A lock-free ID check could persist two distinct facts with one event ID."""
        event_id = str(uuid.uuid4())
        events = (
            _event("process-duplicate", 1, event_id=event_id),
            _event("process-duplicate", 1, event_id=event_id),
        )
        processes = [_spawn_event_append(self.path, event) for event in events]
        results = [process.communicate() for process in processes]

        self.assertCountEqual((0, 2), [process.returncode for process in processes])
        self.assertIn("APPENDED", results[0][0] + results[1][0])
        self.assertIn("RUNTIME_EVENT_DUPLICATE_ID", results[0][0] + results[1][0])
        self.assertEqual((event_id,), tuple(event.event_id for event in self.sink.read()))

    def test_partial_tail_reports_a_structured_diagnostic_without_losing_prior_events(self):
        """Treating a partial tail as a total read failure would erase audit history."""
        event = _event("runtime-one", 1)
        self.sink.append(event)
        with self.path.open("ab") as stream:
            stream.write(b'{"event_id":')

        self.assertEqual((event,), self.sink.read())
        self.assertEqual(["partial_tail"], [item.code for item in self.sink.diagnostics])
        self.assertEqual(2, self.sink.diagnostics[0].line)

    def test_complete_bad_json_reports_a_structured_diagnostic_without_losing_prior_events(self):
        event = _event("runtime-one", 1)
        self.sink.append(event)
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write("{not-json}\n")

        self.assertEqual((event,), self.sink.read())
        self.assertEqual(["invalid_json"], [item.code for item in self.sink.diagnostics])

    def test_disk_full_is_an_explicit_audit_failure(self):
        """Swallowing an ENOSPC error would falsely allow audit-required success."""
        with mock.patch.object(_io, "atomic_append_text", side_effect=OSError(errno.ENOSPC, "disk full")):
            with self.assertRaises(RuntimeEventSinkError) as raised:
                self.sink.append(_event("runtime-one", 1))

        self.assertEqual("RUNTIME_EVENT_PERSIST_FAILED", raised.exception.code)
        self.assertEqual((), self.sink.read())

    def test_read_only_destination_is_an_explicit_audit_failure(self):
        with mock.patch.object(_io, "atomic_append_text", side_effect=PermissionError("read-only")):
            with self.assertRaises(RuntimeEventSinkError) as raised:
                self.sink.append(_event("runtime-one", 1))

        self.assertEqual("RUNTIME_EVENT_PERSIST_FAILED", raised.exception.code)
        self.assertEqual((), self.sink.read())

    def test_unreadable_retained_segment_blocks_duplicate_sequence_append(self):
        """Skipping an unreadable segment makes duplicate detection unsound."""
        sink = JsonlRuntimeEventSink(self.path, max_bytes=350)
        retained = _event("history-runtime", 1)
        sink.append(retained)
        sink.append(_event("other-runtime", 1))  # moves retained fact to .1
        segment = self.path.with_name("events.jsonl.1")
        before_active = self.path.read_bytes()
        before_segment = segment.read_bytes()
        original_read_bytes = Path.read_bytes

        def deny_retained_read(path: Path) -> bytes:
            if path == segment:
                raise PermissionError("retained segment unreadable")
            return original_read_bytes(path)

        with mock.patch.object(Path, "read_bytes", new=deny_retained_read):
            with self.assertRaises(RuntimeEventSinkError) as raised:
                sink.append(_event("history-runtime", 1))

        self.assertEqual("RUNTIME_EVENT_HISTORY_UNREADABLE", raised.exception.code)
        self.assertEqual(before_active, self.path.read_bytes())
        self.assertEqual(before_segment, segment.read_bytes())

    def test_record_larger_than_rotation_limit_is_rejected_before_any_write(self):
        """Writing a record larger than its configured segment limit breaks the rotation contract."""
        sink = JsonlRuntimeEventSink(self.path, max_bytes=32)

        with self.assertRaises(RuntimeEventSinkError) as raised:
            sink.append(_event("oversized-runtime", 1))

        self.assertEqual("RUNTIME_EVENT_RECORD_TOO_LARGE", raised.exception.code)
        self.assertFalse(self.path.exists())
        self.assertFalse(Path(str(self.path) + ".lock").exists())

    def test_first_record_syncs_its_parent_directory(self):
        """Omitting parent fsync after creating the log loses the new directory entry on POSIX crash."""
        with mock.patch.object(_io, "fsync_parent_directory", create=True) as sync_parent:
            self.sink.append(_event("runtime-one", 1))

        sync_parent.assert_called_with(self.path)

    def test_new_state_directories_sync_each_created_ancestor_before_the_record(self):
        """Creating ``.state/runtime`` without syncing its links loses a first event after a crash."""
        state_dir = self.path.parent.parent
        runtime_dir = self.path.parent
        original_sync = _io.fsync_parent_directory

        with mock.patch.object(_io, "fsync_parent_directory", wraps=original_sync) as sync_parent:
            self.sink.append(_event("runtime-one", 1))

        sync_parent.assert_has_calls((
            mock.call(state_dir),
            mock.call(runtime_dir),
            mock.call(self.path),
        ))

    def test_later_distinct_append_reestablishes_a_failed_parent_barrier(self):
        """Skipping the parent barrier for an existing file leaves a failed first append unreconciled."""
        self.path.parent.mkdir(parents=True)
        first = _event("runtime-one", 1)
        second = _event("runtime-one", 2)
        original_sync = _io.fsync_parent_directory
        event_barriers = 0

        def fail_first_event_barrier(path: Path) -> None:
            nonlocal event_barriers
            if Path(path) == self.path:
                event_barriers += 1
                if event_barriers == 1:
                    raise OSError("first parent barrier failed")
            original_sync(path)

        with mock.patch.object(_io, "fsync_parent_directory", side_effect=fail_first_event_barrier):
            with self.assertRaises(RuntimeEventSinkError) as raised:
                self.sink.append(first)
            self.assertEqual("RUNTIME_EVENT_PERSIST_FAILED", raised.exception.code)
            self.sink.append(second)

        self.assertGreaterEqual(event_barriers, 2)
        self.assertEqual((first, second), self.sink.read())

    def test_same_event_retry_reconciles_durability_without_a_duplicate_record(self):
        """Treating a failed first append as a permanent duplicate blocks audit recovery."""
        self.path.parent.mkdir(parents=True)
        event = _event("runtime-one", 1)
        original_sync = _io.fsync_parent_directory
        event_barriers = 0

        def fail_first_event_barrier(path: Path) -> None:
            nonlocal event_barriers
            if Path(path) == self.path:
                event_barriers += 1
                if event_barriers == 1:
                    raise OSError("first parent barrier failed")
            original_sync(path)

        with mock.patch.object(_io, "fsync_parent_directory", side_effect=fail_first_event_barrier):
            with self.assertRaises(RuntimeEventSinkError) as raised:
                self.sink.append(event)
            self.assertEqual("RUNTIME_EVENT_PERSIST_FAILED", raised.exception.code)
            self.sink.append(event)

        self.assertEqual(2, event_barriers)
        self.assertEqual((event,), self.sink.read())
        self.assertEqual(1, len(self.path.read_text("utf-8").splitlines()))

    def test_fresh_sink_explicitly_reconciles_an_already_written_failed_append(self):
        """A restart must be able to sync a fact whose first parent barrier failed."""
        self.path.parent.mkdir(parents=True)
        event = _event("runtime-one", 1)
        original_sync = _io.fsync_parent_directory
        event_barriers = 0

        def fail_first_event_barrier(path: Path) -> None:
            nonlocal event_barriers
            if Path(path) == self.path:
                event_barriers += 1
                if event_barriers == 1:
                    raise OSError("first parent barrier failed")
            original_sync(path)

        with mock.patch.object(_io, "fsync_parent_directory", side_effect=fail_first_event_barrier):
            with self.assertRaises(RuntimeEventSinkError) as raised:
                self.sink.append(event)
            self.assertEqual("RUNTIME_EVENT_PERSIST_FAILED", raised.exception.code)
            recovered = JsonlRuntimeEventSink(self.path)
            recovered.reconcile(event)

        self.assertEqual(2, event_barriers)
        self.assertEqual((event,), recovered.read())
        with self.assertRaises(RuntimeEventSinkError) as duplicate:
            recovered.append(event)
        self.assertEqual("RUNTIME_EVENT_DUPLICATE_ID", duplicate.exception.code)

    def test_pending_event_is_reconciled_before_a_later_append_can_rotate_it(self):
        """Rotating an event whose file fsync failed must block the next event until it is durable."""
        self.path.parent.mkdir(parents=True)
        sink = JsonlRuntimeEventSink(self.path, max_bytes=350)
        first = _event("runtime-one", 1)
        second = _event("runtime-one", 2)
        original_append = _io.atomic_append_text
        original_reconcile = _io.fsync_text_file_and_parent
        original_replace = Path.replace
        append_calls = 0

        def write_first_record_then_fail(path: Path, text: str) -> None:
            nonlocal append_calls
            append_calls += 1
            if append_calls != 1:
                original_append(path, text)
                return
            with open(path, "ab") as stream:
                stream.write(text.encode("utf-8"))
                stream.flush()
            raise OSError("file fsync failed after the complete first write")

        with mock.patch.object(_io, "atomic_append_text", side_effect=write_first_record_then_fail):
            with self.assertRaises(RuntimeEventSinkError) as raised:
                sink.append(first)
            self.assertEqual("RUNTIME_EVENT_PERSIST_FAILED", raised.exception.code)
            self.assertEqual((first,), sink.read())

            with mock.patch.object(_io, "fsync_text_file_and_parent",
                                   side_effect=OSError("first record remains non-durable")):
                with self.assertRaises(RuntimeEventSinkError) as blocked:
                    sink.append(second)

            self.assertEqual("RUNTIME_EVENT_PERSIST_FAILED", blocked.exception.code)
            self.assertEqual((first,), sink.read())
            self.assertIn(first.event_id, sink._pending_durability_retries)
            self.assertFalse(self.path.with_name("events.jsonl.1").exists())

            order: list[tuple[str, Path]] = []

            def record_reconcile(path: Path) -> None:
                order.append(("sync", Path(path)))
                original_reconcile(path)

            def record_replace(path: Path, target: Path) -> Path:
                order.append(("replace", Path(path)))
                return original_replace(path, target)

            with mock.patch.object(_io, "fsync_text_file_and_parent", side_effect=record_reconcile), \
                 mock.patch.object(Path, "replace", new=record_replace):
                sink.append(second)

        self.assertLess(order.index(("sync", self.path)), order.index(("replace", self.path)))
        self.assertNotIn(first.event_id, sink._pending_durability_retries)
        self.assertEqual((first, second), sink.read())

    def test_rotation_sync_failure_is_explicit_and_keeps_prior_fact(self):
        """Reporting rotation success before the directory entry is synced is not durable."""
        sink = JsonlRuntimeEventSink(self.path, max_bytes=350)
        first = _event("runtime-one", 1)
        sink.append(first)

        with mock.patch.object(_io, "fsync_parent_directory", create=True,
                               side_effect=OSError("directory fsync failed")):
            with self.assertRaises(RuntimeEventSinkError) as raised:
                sink.append(_event("runtime-one", 2))

        self.assertEqual("RUNTIME_EVENT_PERSIST_FAILED", raised.exception.code)
        self.assertEqual((first,), sink.read())

    @unittest.skipIf(os.name == "nt", "directory fsync is not a Windows primitive")
    def test_posix_first_creation_parent_fsync_failure_is_explicit(self):
        """Ignoring a real POSIX directory-fsync failure would falsely report durable append success."""
        with mock.patch.object(_io.os, "fsync", side_effect=(None, OSError("directory fsync failed"))):
            with self.assertRaises(RuntimeEventSinkError) as raised:
                self.sink.append(_event("runtime-one", 1))

        self.assertEqual("RUNTIME_EVENT_PERSIST_FAILED", raised.exception.code)

    def test_rotation_rename_failure_is_explicit_and_preserves_the_existing_segment(self):
        sink = JsonlRuntimeEventSink(self.path, max_bytes=350)
        first = _event("runtime-one", 1)
        sink.append(first)

        with mock.patch.object(Path, "replace", side_effect=OSError("rename failed")):
            with self.assertRaises(RuntimeEventSinkError) as raised:
                sink.append(_event("runtime-one", 2))

        self.assertEqual("RUNTIME_EVENT_PERSIST_FAILED", raised.exception.code)
        self.assertEqual((first,), sink.read())

    def test_windows_compatible_file_lock_timeout_is_explicit_and_writes_nothing(self):
        """Bypassing harness._io.file_lock must fail when a peer owns the sidecar lock."""
        holder = _hold_lock(self.path, 1.0)
        try:
            self.sink.lock_timeout = 0.05
            with self.assertRaises(RuntimeEventSinkError) as raised:
                self.sink.append(_event("runtime-one", 1))
            self.assertEqual("RUNTIME_EVENT_LOCK_TIMEOUT", raised.exception.code)
            self.assertFalse(self.path.exists())
        finally:
            holder.wait()

    def test_rotation_preserves_every_prior_event_in_separate_segments(self):
        """Deleting old rotation segments would silently truncate immutable facts."""
        sink = JsonlRuntimeEventSink(self.path, max_bytes=350)
        events = tuple(_event("runtime-one", index) for index in range(1, 6))
        for event in events:
            sink.append(event)

        rotated = sorted(self.path.parent.glob("events.jsonl.*"))
        self.assertTrue(rotated)
        self.assertEqual({event.event_id for event in events}, {event.event_id for event in sink.read()})
        self.assertTrue(all(path.stat().st_size <= 350 for path in [self.path, *rotated]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
